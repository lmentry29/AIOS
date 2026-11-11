# Signed source-to-build provenance

Status: implemented and verified in CI (2026-11-11). This is a project-specific attestation,
not a claim of SLSA, in-toto or Sigstore conformance.

## Purpose and scope

The evidence bundle proves what the durable journal recorded inside a host. The build
attestation complements it: it binds the exact Git commit and repository, the CI workflow
identity and run, and the SHA-256 plus size of the files actually produced by that run. A
party outside the runner can verify the attestation offline against an external trust root and
the real artifact files.

The attestation is an integrity statement signed by an Ed25519 key. In CI the key is
run-scoped, so the attestation proves integrity within that run and continuity of the exact
fields; it does **not** establish a public OIDC identity or a transparency-log timestamp. No
SLSA build level, in-toto conformance or Sigstore conformance is claimed.

## Format

```
{
  format: "aios-build-provenance",
  version: 1,
  attestation_id: "<opaque id>",
  created_at: "<ISO-8601 UTC>",
  source: {
    repository: "owner/name",
    commit: "<full 40-char Git commit>",
    ref, event, workflow_ref, run_id, run_attempt
  },
  builder: {
    id: "github-actions:<workflow_ref>",
    provider: "github-actions",
    runner_os, runner_arch
  },
  artifacts: [{ name, sha256, size }],
  signing_key: { key_id, algorithm: "ed25519", public_key_pem },
  attestation_sha256: "<canonical payload digest>",
  signature: "<canonical 64-byte base64 Ed25519 signature>"
}
```

Artifacts are sorted by name, must be unique and non-empty, and have their bytes read from
regular files (symlinks rejected) with a bounded size. The digest covers the canonical payload;
the signature domain is `aios-build-provenance/signature/v1\n`. Parsing uses the same strict
JSON reader as signed evidence (duplicate keys, prototype keys, depth, trailing content and
non-finite numbers rejected), and key ids are the SHA-256 of the DER SPKI public key.

## Verification contract

`tools/security/build-provenance.mjs verify` reads only the attestation, an external trust
root and the artifact paths supplied on the command line. It never opens the host store, starts
a sandbox or uses the network.

```
node tools/security/build-provenance.mjs verify \
  --attestation build-provenance.json \
  --trust-root aios-trust-root.json \
  --expect-repository "$GITHUB_REPOSITORY" \
  --expect-commit "$GITHUB_SHA" \
  --expect-builder-id "github-actions:$GITHUB_WORKFLOW_REF" \
  --expect-workflow-ref "$GITHUB_WORKFLOW_REF" \
  --expect-run-id "$GITHUB_RUN_ID" \
  --expect-run-attempt "$GITHUB_RUN_ATTEMPT" \
  --artifact "pin=tools/security/gvisor-runtime.pin.json" \
  --artifact "manifest=$RUNNER_TEMP/gvisor-rootfs.manifest.json"
```

When `--artifact` is supplied, every attested artifact must be present with the exact digest
and size and no extra artifact may be supplied. Verification does not infer an artifact set
from a directory or from the environment.

| Exit | Code | Meaning |
| --- | --- | --- |
| 2 | `INVALID_JSON` | Invalid strict JSON or duplicate/dangerous key |
| 2 | `MALFORMED_ATTESTATION` | Wrong shape/type/bounds, symlink or non-regular artifact |
| 8 | `UNSUPPORTED_VERSION` | Unknown attestation schema version |
| 3 | `SIGNATURE` | Invalid or non-canonical Ed25519 signature |
| 5 | `ATTESTATION_DIGEST` | Canonical payload digest mismatch |
| 9 | `UNKNOWN_KEY` | Key absent from trust root or key material mismatch |
| 9 | `KEY_REVOKED`, `KEY_NOT_YET_VALID`, `KEY_EXPIRED` | Key lifecycle denial |
| 9 | `TRUST_ROOT` | Missing/invalid trust root |
| 11 | `WRONG_REPOSITORY` | Source repository mismatch |
| 12 | `WRONG_COMMIT` | Source commit mismatch |
| 13 | `WRONG_BUILDER` | Builder identity mismatch |
| 14 | `WRONG_WORKFLOW` | CI workflow-ref mismatch |
| 10 | `REPLAY` | Run id, run attempt or attestation-id checkpoint mismatch |
| 16 | `ARTIFACT_DIGEST` | Real artifact bytes/size differ from the attestation |
| 17 | `ARTIFACT_MISSING` | Attested artifact not supplied |
| 18 | `ARTIFACT_EXTRA` | Supplied artifact is not attested |

All failures are denials. Absent, revoked or expired key material never falls back to the
public key embedded in the attestation.

## CI production and checking

The Security workflow reuses the run-scoped key and trust root already created for the gVisor
runtime pin/rootfs manifest signatures. It generates an attestation covering the pin, the
reproducible rootfs manifest and both detached signatures, then immediately verifies it with
the expected repository, commit, workflow ref, builder id, run id and attempt plus the real
files. Any change to a generated artifact, a different commit or a stale run fails the job
before the gVisor drill. No network identity service, Fulcio/Rekor call or external action is
enabled.

The attestation is not committed; it lives in `$RUNNER_TEMP` for the job. A downstream operator
who retains it can verify it offline later with the same CLI and trust root.

## Key lifecycle, reuse and differences from standards

- **Reused:** `parseStrictJson`, the canonical JSON function, Ed25519 key-id derivation,
  trust-root parsing and lifecycle semantics from the signed-evidence implementation. No new
  dependency is introduced.
- **Rotation:** add the new public key with an overlapping validity window, generate new
  attestations with the new private key, and retain old public keys while old attestations need
  verification. **Revocation:** status `revoked` in the trust root. **Absence/expiry:** deny.
- **Sigstore/cosign:** keyless Fulcio/Rekor requires network identity and transparency services;
  this offline pipeline cannot depend on them and has no OIDC provisioning. Rejected as the
  primary mechanism, not because the standards are unsuitable.
- **in-toto/SLSA:** the payload/signature separation and domain separation are informed by
  in-toto-style attestations, but this is a project-specific envelope. There is no builder
  identity verification beyond the asserted GitHub environment, no SLSA provenance level and no
  in-toto conformance claim.
- **Honest residual gaps:** external audit custody/trusted timestamps, production key custody,
  OIDC-backed builder identity, transparency logging, reproducibility of every artifact, and
  macOS/rootless-Docker measurement. CI uses Linux only for this feature.
