# Trust-root lifecycle and provisioning

Status: implemented and locally verified (2026-11-11). The checked-in
`tools/security/trust-root.json` remains an empty, fail-closed placeholder until an operator
provisions public keys. No private key or production secret is committed.

## Why this exists

The gVisor runtime pin and rootfs manifest, signed build provenance and portable evidence
bundles all consume the same trust root through `loadTrustRoot` in
`apps/host/src/execution/artifact-signing.ts`. Before this change the verifier understood
multiple keys, overlapping validity windows, revocation and expiry, but there was no
operator-usable way to provision or rotate the document it consumes. The lifecycle CLI closes
that operational gap without changing the trust-root schema or adding a second verifier.

## Key model

- Each key is Ed25519. `key_id` is the SHA-256 of the DER SPKI public key, so a key cannot be
  relabelled.
- A trust root contains 1–64 distinct keys. Each key has `status: "trusted" | "revoked"` and an
  ISO-8601 UTC `not_before`/`not_after` window.
- The verifier requires a signature/attestation to be created inside its key's window and
  rejects the key once `not_after` has passed. A revoked key is rejected even for evidence
  created while it was trusted.
- Public keys only are written to the trust root. Private keys are written only to an
  operator-supplied runtime path with mode `0600`.

## Provision a development/test root

```sh
KEY_DIR="$(mktemp -d)"
chmod 700 "$KEY_DIR"

node tools/security/trust-root.mjs keygen \
  --private "$KEY_DIR/dev-key.pem" \
  --public "$KEY_DIR/dev-key.pub.pem"

node tools/security/trust-root.mjs init \
  --trust-root "$KEY_DIR/trust-root.json" \
  --public-key "$KEY_DIR/dev-key.pub.pem" \
  --not-before 2026-01-01T00:00:00.000Z \
  --not-after 2027-01-01T00:00:00.000Z
```

`init` refuses to replace a non-empty root. `--replace-empty` is accepted only when the
existing document is a schema-1 root with an empty `keys` array, so the committed placeholder
can be provisioned without deleting or overwriting an active root. Writes are atomic and use a
no-replace operation for creation.

For production, generate the private key in the operator's KMS/HSM or an offline signer, keep
it out of the repository and CI logs, and commit only the resulting public trust root after
review. The repository does not contain, and this environment does not provision, a
production private key.

## Rotate, revoke and inspect

```sh
# Add a new key while retaining the old key and its validity window.
node tools/security/trust-root.mjs rotate \
  --trust-root "$KEY_DIR/trust-root.json" \
  --public-key "$KEY_DIR/new-key.pub.pem" \
  --not-before 2026-06-01T00:00:00.000Z \
  --not-after 2027-06-01T00:00:00.000Z

node tools/security/trust-root.mjs revoke \
  --trust-root "$KEY_DIR/trust-root.json" \
  --key-id "$OLD_KEY_ID"

node tools/security/trust-root.mjs list --trust-root "$KEY_DIR/trust-root.json"
node tools/security/trust-root.mjs validate --trust-root "$KEY_DIR/trust-root.json"
```

Rotation is overlapping: `rotate` adds a key and never silently shortens or deletes an existing
key. The old key remains accepted until its own `not_after`; re-sign artifacts and attestations
before that deadline. Revocation is immediate and persists in the trust root; it is a reviewed
repository change. Expiry is enforced by both the artifact verifier and the build-provenance
verifier.

## Source-to-build provenance

The existing `tools/security/build-provenance.mjs` producer now supports two modes over the
same statement and verifier:

- **CI:** reads `GITHUB_REPOSITORY`, `GITHUB_SHA`/`--commit`, `GITHUB_REF`, `GITHUB_EVENT_NAME`,
  `GITHUB_WORKFLOW_REF`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`; the builder identity is
  `github-actions:<workflow_ref>`. The Security workflow pins the key id and checks the real
  artifact bytes.
- **Local/offline:** `generate --local` requires an explicit repository and full 40-character
  commit and accepts the declared ref, event, workflow ref, run identity, builder id, runner
  identity, creation time and attestation id. It uses the same Ed25519 statement, strict
  canonical serialization and artifact measurement as CI.

```sh
node tools/security/build-provenance.mjs generate --local \
  --key "$KEY_DIR/dev-key.pem" \
  --repository acme/aios \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --builder-id local:offline \
  --workflow-ref local:offline \
  --created-at 2026-11-11T00:00:00.000Z \
  --attestation-id local-2026-11-11 \
  --artifact "pin=tools/security/gvisor-runtime.pin.json" \
  --out "$KEY_DIR/build-provenance.json"

node tools/security/build-provenance.mjs verify \
  --attestation "$KEY_DIR/build-provenance.json" \
  --trust-root "$KEY_DIR/trust-root.json" \
  --expect-key-id "$KEY_ID" \
  --expect-repository acme/aios \
  --expect-commit 0123456789abcdef0123456789abcdef01234567 \
  --expect-builder-id local:offline \
  --expect-workflow-ref local:offline \
  --artifact "pin=tools/security/gvisor-runtime.pin.json"
```

Generation is atomic and no-replace: an existing attestation path is refused and left
unchanged. Verification rejects a mismatched key id (`WRONG_KEY`, exit 19), repository,
commit, builder, workflow, run/attempt, artifact digest/size, signature, schema version and
key lifecycle. Local attestations are offline integrity statements, not OIDC or CI identity
claims.

## What is verified

| Control | Failure behavior |
| --- | --- |
| Unknown key id | `UNKNOWN_KEY` / signing error |
| Revoked key | `KEY_REVOKED` / signing error |
| Not-yet-valid or expired key | `KEY_NOT_YET_VALID` / `KEY_EXPIRED` / signing error |
| Rotated-out old key | accepted inside its window, rejected after `not_after` |
| Previous statement/attestation version | rejected rather than parsed with weaker rules |
| Wrong pinned key id | `WRONG_KEY` for provenance; pinned-key error for artifacts |
| Wrong commit, repository, builder, workflow or run | distinct fail-closed code |
| Wrong artifact digest or size | `ARTIFACT_DIGEST` |
| Symlinked provenance or trust-root file | non-zero CLI failure; no fallback input |
| Existing output path | generation failure; existing bytes unchanged |
| Empty committed trust root | verification fails closed |

## Evaluation of reusable standards and components

- **Sigstore/cosign:** not adopted as the primary path. Keyless verification depends on
  Fulcio/Rekor and network identity, while this system must verify offline and has no
  provisioned OIDC workload identity. No Sigstore or cosign dependency was added.
- **SLSA/in-toto:** the payload/signature separation and canonical signed statement are
  informed by the same general model, but this is a project-specific Ed25519 envelope. No SLSA
  level or in-toto conformance is claimed.
- **Reused:** Node's built-in `crypto` Ed25519, the existing strict JSON reader, canonical JSON,
  trust-root schema, file-integrity no-follow reader and existing CLIs. No new package,
  Python/Rust runtime or OpenJarvis signing/runtime implementation was imported.

## Test evidence

Named tests cover the lifecycle and rejection paths:

- `apps/host/tests/trust-root-lifecycle.test.ts` — key generation modes, `init`, overlapping
  `rotate`, old-key acceptance during overlap, `revoke`, post-revocation denial, continued
  acceptance of the new key and refusal to overwrite a non-empty root.
- `apps/host/tests/artifact-signing.test.ts` — expected key pin, overlapping rotation then
  expiry, unknown/revoked/expired keys, tampered signature, subject and artifact mismatch, and
  empty root.
- `apps/host/tests/build-provenance.test.ts` — wrong pinned key, previous attestation version,
  rotated-key expiry, wrong commit/repository/builder/workflow, artifact digest/missing/extra,
  symlinked attestation and trust-root inputs, local generate/verify and no-replace output.
- `apps/host/tests/artifact-signing-adversarial.test.ts` — duplicate/prototype keys, malformed
  statements, 250 statement and 150 trust-root seeded mutations.

Results at this head:

- Focused lifecycle/signing/provenance run: **30/30** passed across 3 files.
- Founder: **95/95** passed across 10 files.
- Host: **261 passed, 17 skipped** across 29 files. The 17 skips are the live
  gVisor/Docker/rootfs probes requiring host capabilities; they are not counted as passes.
- Uncached workspace gate: **46/46 tasks successful, 0 cached**, exit 0.
- `format:check` remains at the pre-existing **155 findings across 189 tracked files**; no new
  file was added to that baseline.

## Remaining limits

- The repository trust root is still empty; gVisor remains fail-closed until an operator
  provisions public keys. The lifecycle is operable, but production key custody and the
  provisioning decision are operator actions, not repository code.
- CI uses a run-scoped ephemeral key. It is not a production key, OIDC workload identity,
  Fulcio certificate, Rekor transparency entry or external timestamp.
- Source fields are self-asserted by the signing key holder. The verifier pins an expected
  repository, commit, builder and key id, but it does not independently observe GitHub's
  workload identity.
- Base-image and Debian-snapshot inputs are not independently signed beyond the signed rootfs
  manifest and build attestation.
- macOS and rootless-Docker behavior remains unmeasured; no platform result is extrapolated.
