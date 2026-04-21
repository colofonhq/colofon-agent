// Bundle-generation entry point invoked by `action.yml`.
//
// At action run time this file is copied into the colofon-sdk
// checkout root (`colofon-agent-entry.mjs`) so the `./src/...`
// module specifiers below resolve against the SDK's TypeScript
// sources. We need to live inside the SDK checkout for `tsx` to
// pick up its `node_modules` without extra flags.
//
// Inputs arrive via env (GitHub Actions composite actions inject
// inputs as env vars):
//   COLOFON_CIRCUITS_DIR        absolute path to colofon-circuits
//                                (must already have compiled
//                                `colofon_build_provenance`)
//   COLOFON_ATTESTATION         path (relative to workspace) to the
//                                Sigstore DSSE bundle
//   COLOFON_APPROVED_BUILDERS   path (relative to workspace) to the
//                                approved-builders newline-list
//   COLOFON_OUTPUT              path (relative to workspace) for the
//                                generated bundle
//   GITHUB_WORKSPACE            caller's workspace root
//
// Signer-identity enforcement: the script refuses to generate a
// bundle when the attestation's Fulcio SAN URI is not in the
// approved-builders file. This is a belt-and-braces check; the
// circuit would reject the proof anyway (the Merkle membership
// check would fail), but failing early with a clear error is nicer.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildApprovedSetTree } from './src/merkle_set.js';
import {
  buildColofonBundle,
  serialiseColofonBundle,
} from './src/bundle/encode.js';
import { parseSlsaBundleFile } from './src/slsa/parse.js';
import {
  loadCompiledCircuit,
  proveBuildProvenance,
} from './src/slsa/prove.js';
import {
  BUILDER_TREE_HEIGHT,
  buildBuildProvenanceWitness,
  hashSignerIdentity,
} from './src/slsa/witness.js';

function required(envVar) {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
  return value;
}

function readApprovedBuilders(path) {
  const contents = readFileSync(path, 'utf-8');
  const lines = contents
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(
      `Approved-builders file ${path} is empty after stripping blanks/comments`,
    );
  }
  return lines;
}

async function main() {
  const workspace = required('GITHUB_WORKSPACE');
  const circuitsDir = required('COLOFON_CIRCUITS_DIR');
  const attestationPath = resolve(workspace, required('COLOFON_ATTESTATION'));
  const approvedBuildersPath = resolve(workspace, required('COLOFON_APPROVED_BUILDERS'));
  const outputPath = resolve(workspace, required('COLOFON_OUTPUT'));

  console.log('Colofon agent: generating build-provenance bundle');
  console.log(`  attestation:       ${attestationPath}`);
  console.log(`  approved-builders: ${approvedBuildersPath}`);
  console.log(`  output:            ${outputPath}`);

  const parsed = parseSlsaBundleFile(attestationPath);
  if (!parsed.signerIdentityUri) {
    throw new Error(
      'Attestation Fulcio certificate has no SAN URI; cannot determine builder identity',
    );
  }
  console.log(`  signer identity:   ${parsed.signerIdentityUri}`);

  const approvedBuilders = readApprovedBuilders(approvedBuildersPath);
  if (!approvedBuilders.includes(parsed.signerIdentityUri)) {
    throw new Error(
      `Signer identity ${parsed.signerIdentityUri} is not in the approved-builders file (${approvedBuildersPath}). Refusing to generate a bundle for an unapproved builder.`,
    );
  }

  const identityHashes = await Promise.all(approvedBuilders.map(hashSignerIdentity));
  const tree = await buildApprovedSetTree(identityHashes, {
    depth: BUILDER_TREE_HEIGHT,
  });

  const witness = await buildBuildProvenanceWitness(parsed, tree);

  const compiledCircuitPath = resolve(
    circuitsDir,
    'target/colofon_build_provenance.json',
  );
  const circuit = loadCompiledCircuit(compiledCircuitPath);

  console.log('  generating UltraHonk proof (~30s)...');
  const { proof, publicInputs } = await proveBuildProvenance(circuit, witness);

  const bundle = buildColofonBundle(
    circuit,
    proof,
    publicInputs,
    witness,
    parsed.signingCertificateDer,
    {
      builderIdentityUri: parsed.signerIdentityUri,
      approvedBuilderIdentities: approvedBuilders,
    },
  );

  const serialised = serialiseColofonBundle(bundle);
  writeFileSync(outputPath, serialised, 'utf-8');

  console.log(`  wrote ${serialised.length} bytes to ${outputPath}`);
  console.log('Colofon agent: done');
}

main().catch((err) => {
  console.error('Colofon agent failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
