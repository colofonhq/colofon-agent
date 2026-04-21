# colofon-agent

GitHub Action that wraps a Sigstore/SLSA build-provenance attestation into a Colofon proof bundle on every release.

## What it does

Wraps an existing Sigstore/SLSA build-provenance attestation into a Colofon proof bundle. The bundle is a ZK proof that:

- A Fulcio identity on the consumer's approved-builders list signed the release.
- The binary digest in the bundle matches the `subject.digest.sha256` of the signed attestation.
- The builder identity is a member of the approved-builder Merkle set.

Anyone can verify the bundle client-side at **[colofon-verifier.vercel.app/verify](https://colofon-verifier.vercel.app/verify)** without seeing the internal build log or the full attestation payload.

## Usage

```yaml
- uses: actions/attest-build-provenance@v1
  id: attest
  with:
    subject-path: dist/my-artefact.tar.gz

# Production workflows should pin `@main` to a commit SHA for
# reproducibility (this example is deliberately short for readability).
- uses: colofonhq/colofon-agent@main
  id: colofon
  with:
    attestation-bundle: ${{ steps.attest.outputs.bundle-path }}
    approved-builders-file: .colofon/builders.txt
    sdk-token: ${{ secrets.COLOFON_AGENT_TOKEN }}
```

See [`examples/release-with-colofon.yml`](examples/release-with-colofon.yml) for a full release workflow and [`examples/builders.txt`](examples/builders.txt) for the approved-builders file format.

### Inputs

| Input | Required | Default | Notes |
|-------|----------|---------|-------|
| `attestation-bundle` | ✓ | — | Path to the Sigstore DSSE bundle produced by `actions/attest-build-provenance` or `gh attestation download`. |
| `approved-builders-file` | ✓ | — | Newline-delimited file of approved Fulcio SAN URIs. First line must be the signer identity for this release. |
| `output-path` | | `colofon-bundle.json` | Where to write the proof bundle. |
| `sdk-ref` | | `main` | Git ref of `colofon-sdk` to pin against. |
| `circuits-ref` | | `main` | Git ref of `colofon-circuits` to pin against. |
| `sdk-token` | ✓ | — | Personal access token with read access to `colofon-sdk` and `colofon-circuits`. Will become optional once `@colofon/sdk` ships on npm and the compiled ACIR is distributed as an action asset. |

### Outputs

| Output | Description |
|--------|-------------|
| `bundle-path` | Path of the generated Colofon proof bundle. |

## Status

v0. Works end-to-end — see [`colofon-examples`](https://github.com/colofonhq/colofon-examples) for a full release workflow that uses this action.

v1 roadmap:

- Publish `@colofon/sdk` to npm so consumers don't need a cross-repo PAT.
- Ship the compiled ACIR bytecode as an action asset so consumers don't need to compile.

## v1.5+

- GitLab CI pipeline component
- Jenkins plugin
