# Signed gVisor provenance artifacts

## What is signed

Two detached Ed25519 statements are verified before either artifact is used:

| Artifact | Kind | Signed subject |
| --- | --- | --- |
| `tools/security/gvisor-runtime.pin.json` | `gvisor-runtime-pin` | release, runsc version, runsc SHA-256, archive SHA-512 |
| rootfs manifest (`gvisor-rootfs.manifest.json`) | `gvisor-rootfs-manifest` | `rootfs_sha256`, `entries` |

The statement covers the artifact's exact SHA-256 bytes, the artifact kind, the signer
`key_id`, `signed_at`, the normalized subject and CI source metadata, serialized as
deterministic (recursively key-sorted) JSON and signed with Ed25519 (RFC 8032) via Node's
`crypto`. Verification recomputes all of it; nothing is trusted from a key shipped next to
the artifact.

## Trust root and key lifecycle

`tools/security/trust-root.json` is the checked-in trust anchor. This repository ships it
with an **empty key list**, which makes verification fail closed until an operator
provisions a key. The private key must never be committed; keep it in an offline signer or
a CI secret and commit only the public half.

```sh
# Provision (private key stays out of the repository)
node tools/security/sign-artifacts.mjs generate-key \
  --private /secure/aios-signing-key.pem --trust-root /secure/trust-root.json
# Sign both artifact kinds
node tools/security/sign-artifacts.mjs sign --kind runtime-pin \
  --artifact tools/security/gvisor-runtime.pin.json \
  --key /secure/aios-signing-key.pem --trust-root /secure/trust-root.json \
  --out tools/security/gvisor-runtime.pin.sig.json
node tools/security/sign-artifacts.mjs sign --kind rootfs-manifest \
  --artifact "$AIOS_GVISOR_ROOTFS_MANIFEST" \
  --key /secure/aios-signing-key.pem --trust-root /secure/trust-root.json \
  --out "$AIOS_GVISOR_ROOTFS_MANIFEST.sig.json"
```

- **Rotation:** overlapping validity windows are supported. Add the new key as `trusted`
  before its `not_before`, sign new artifacts with it, keep the old key until every artifact
  signed by it has been re-signed or retired, then remove it. A signature names exactly one
  key id; verification never falls back to another key.
- **Revocation:** `"status": "revoked"` applies to all future verifications, including
  signatures created while the key was valid. Revocation is a repository change, so it is
  reviewable in history.
- **Expiry:** a signature must have been created inside its key's window and is rejected
  once `not_after` has passed; re-sign before expiry.
- **No implicit keys:** public keys embedded in or next to artifacts are never loaded.
  `AIOS_TRUST_ROOT` must name the repository-controlled root.

## Verification is bound to execution

`GvisorSandbox.verifyProvenance` verifies the runtime pin signature first. For the rootfs it
reads the signed manifest, verifies its signature and requires the manifest's
`rootfs_sha256`/`entries` to equal the digest measured from the configured rootfs. That
same measured digest is passed to `materializeVerifiedRootfs`, which copies the tree and
requires the copy to measure identically before `runsc` starts. A signature over a different
artifact therefore cannot authorize execution, and the measured runtime binary is compared
to the signed pin before and after materialization.

Evidence records `pin_signature_key_id`, `pin_signature_sha256`,
`manifest_sha256` and `manifest_signature_key_id`.

## Rejection cases (deterministic tests)

`apps/host/tests/artifact-signing.test.ts` verifies the happy path for both kinds and
rejects: modified artifact, signature moved from another valid artifact, missing statement,
malformed statement, key absent from the trust root, revoked key, expired key, subject
mismatch, corrupted signature bytes and an empty trust root. It also accepts an overlapping
rotated key. `apps/host/tests/gvisor.test.ts` proves the provider fails closed without a
trust root, with a missing pin/signature, and with a pin whose signed subject does not match
the measured runtime.

## Evaluation and honest limits

Sigstore/cosign keyless signing was evaluated first. It was **not adopted as the primary
path**: verification depends on Fulcio/Rekor availability and network access, which breaks
air-gapped operation, and no OIDC identity or signing secret is provisioned in this
environment. The offline Ed25519 chain works for both local and CI use, at the cost of
weaker identity binding.

- **Proven what is proven:** the offline trust chain, rotation/revocation rules, exact-byte
  and subject binding, and fail-closed consumption are implemented and exercised locally and
  in the Security workflow with a run-scoped key.
- **Not proven:** a production trust root and long-lived key are not provisioned; no keyless
  Fulcio certificate, Rekor transparency entry, hardware-backed key or SLSA provenance exists,
  so this is **not** a Sigstore or SLSA conformance claim. The `source` fields are
  self-asserted by whoever holds the signing key; they are metadata, not a CI identity
  attestation. The Security workflow log shows the run-scoped key id and digest, not a
  trusted workload identity.
