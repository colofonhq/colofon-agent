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
  buildProvenanceNoirInputs,
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

/**
 * Generate a Circuit 1 proof by delegating to a remote prover service.
 *
 * Mirrors the shape of `proveBuildProvenance(circuit, witness)` from
 * the SDK — same return contract, so the caller flow is identical.
 * Accepts the same compiled circuit JSON (for bytecode hashing on the
 * bundle side) but doesn't run bb.js locally.
 *
 * Network security notes (§4 of colofon-prover/PLAN.md):
 *  - The witness is posted as-is over TLS. Phase 4 of the prover will
 *    add client-side envelope encryption; until then, TLS-and-trust is
 *    the interim posture.
 *  - The prover never persists the witness. We still avoid logging
 *    the request body on our side for the same reason.
 */
async function proveViaRemoteProver(proverUrl, witness) {
  const inputs = buildProvenanceNoirInputs(witness);
  const endpoint = `${proverUrl.replace(/\/$/, '')}/v1/proofs`;
  console.log(`  delegating proving to ${endpoint}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circuit: 'build_provenance', inputs }),
  });
  if (!response.ok) {
    // Intentionally don't dump the response body into the error — on
    // 4xx it will quote our own inputs back, which could include
    // witness content in attacker-controlled scenarios. Surface
    // status + error code only.
    let code = 'unknown';
    try {
      const maybe = await response.json();
      code = maybe?.error?.code ?? 'unknown';
    } catch {
      /* not JSON, ignore */
    }
    throw new Error(
      `Remote prover ${endpoint} returned HTTP ${response.status} (error code: ${code})`,
    );
  }
  const body = await response.json();
  if (body.status !== 'ready' || typeof body.proof !== 'string' || !Array.isArray(body.public_inputs)) {
    throw new Error(
      `Remote prover returned an unexpected response shape (status=${body.status})`,
    );
  }
  const proof = Buffer.from(body.proof, 'base64');
  if (body.timings?.proving_ms != null) {
    console.log(`  remote proving done in ${body.timings.proving_ms} ms`);
  }
  return { proof: new Uint8Array(proof), publicInputs: body.public_inputs };
}

async function main() {
  const workspace = required('GITHUB_WORKSPACE');
  const circuitsDir = required('COLOFON_CIRCUITS_DIR');
  const attestationPath = resolve(workspace, required('COLOFON_ATTESTATION'));
  const approvedBuildersPath = resolve(workspace, required('COLOFON_APPROVED_BUILDERS'));
  const outputPath = resolve(workspace, required('COLOFON_OUTPUT'));
  // Optional: route proving to a hosted colofon-prover instead of
  // running bb.js locally. Leave unset for the default local path.
  const proverUrl = process.env.COLOFON_PROVER_URL;

  console.log('Colofon agent: generating build-provenance bundle');
  console.log(`  attestation:       ${attestationPath}`);
  console.log(`  approved-builders: ${approvedBuildersPath}`);
  console.log(`  output:            ${outputPath}`);
  console.log(`  proving mode:      ${proverUrl ? 'remote' : 'local'}`);

  const parsed = parseSlsaBundleFile(attestationPath);
  if (!parsed.signerIdentityUri) {
    throw new Error(
      'Attestation Fulcio certificate has no SAN URI; cannot determine builder identity',
    );
  }
  console.log(`  signer identity:   ${parsed.signerIdentityUri}`);

  const approvedBuilders = readApprovedBuilders(approvedBuildersPath);
  if (!approvedBuilders.includes(parsed.signerIdentityUri)) {
    // Surface enough context for a consumer to spot
    // formatting mismatches (trailing slashes, wrong workflow
    // path, `refs/heads/main` vs. `refs/tags/*`, etc.) without
    // forcing them to cross-reference the bundle by hand.
    throw new Error(
      `Signer identity ${parsed.signerIdentityUri} is not in the approved-builders file ${approvedBuildersPath} (${approvedBuilders.length} entries: ${approvedBuilders.map((b) => `"${b}"`).join(', ')}). Refusing to generate a bundle for an unapproved builder.`,
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

  let proof;
  let publicInputs;
  if (proverUrl) {
    ({ proof, publicInputs } = await proveViaRemoteProver(proverUrl, witness));
  } else {
    console.log('  generating UltraHonk proof locally (~30s)...');
    ({ proof, publicInputs } = await proveBuildProvenance(circuit, witness));
  }

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
  // Log the full error (stack if available); losing the stack in CI
  // makes debugging proof-generation failures noticeably harder.
  console.error('Colofon agent failed:', err);
  process.exit(1);
});
