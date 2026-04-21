# colofon-agent

CI plugin for Colofon — drops into a vendor's release pipeline, generates the proof bundle on every release.

**Private repo. Early-stage. See [`colofon-docs`](https://github.com/colofonhq/colofon-docs) for the project plan.**

## What it does

Wraps an existing Sigstore/SLSA build-provenance attestation into a Colofon proof bundle. The bundle is a ZK proof that:

- A Fulcio identity on the consumer's approved-builders list signed the release.
- The binary digest in the bundle matches the `subject.digest.sha256` of the signed attestation.
- The builder identity is a member of the approved-builder Merkle set.

Anyone can verify the bundle client-side via [`colofon-verifier`](https://github.com/colofonhq/colofon-verifier) without seeing the internal build log or the full attestation payload.

## Usage

```yaml
- uses: actions/attest-build-provenance@v1
  id: attest
  with:
    subject-path: dist/my-artefact.tar.gz

- uses: colofonhq/colofon-agent@v0
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
| `sdk-token` | ✓ | — | Token with read access to `colofon-sdk` and `colofon-circuits`. Drops to optional once both are public / SDK is on npm. |

### Outputs

| Output | Description |
|--------|-------------|
| `bundle-path` | Path of the generated Colofon proof bundle. |

## Status

v0 — works end-to-end against the private `colofon-sdk` / `colofon-circuits` checkouts via `sdk-token`. Upgrading to v1 requires:

- Publish `@colofon/sdk` to npm so consumers don't need a cross-repo PAT.
- Make `colofon-circuits` public OR ship the compiled ACIR bytecode as an action asset.

## v1.5+

- GitLab CI pipeline component
- Jenkins plugin
