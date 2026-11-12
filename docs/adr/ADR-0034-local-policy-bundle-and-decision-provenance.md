# ADR-0034 — Local Policy Bundle and Decision Provenance

## Status

**Accepted** (2026-11-11). This ADR extends the local trust-root model of ADR-0033 to
runtime policy administration (ADR-0023/ADR-0024) and the authorization decisions governed
by ADR-0013. It does not replace those ADRs and does not claim remote attestation.

## Context

ADR-0023/ADR-0024 made policy publication and retirement authenticated, exact-granted,
atomic, and audited. The registry already stores a canonical SHA-256 of policy content and
a hash-chained lifecycle audit. Those controls detect accidental edits to the audit chain,
but they do not establish who authored a policy: a process that can rewrite the registry can
replace policy content and recompute its digest. The same gap existed for verifier decisions
before ADR-0033.

The repository already has an external Ed25519 trust root, strict trust-root parsing,
overlapping rotation/revocation tooling, canonical JSON, and owner-only key loading. The
kernel also has exactly one shared authorization boundary, so a policy check can be placed
on the decision path without adding a second evaluator, service, credential, or network
dependency.

## Decision

1. **Required local provenance configuration.** `apps/host` requires a top-level
   `policy_provenance` object with `trust_root_file`, `signing_key_file`, and `key_id`.
   Missing or partial configuration fails startup. The trust root is the same strict
   Ed25519 document used by artifact/verifier provenance. The private key must be a regular,
   unlinked, owner-only file and is kept only in process memory.
2. **The bundle signature covers the whole policy content.** The signed payload is canonical
   JSON containing `schema_version: 1`, `subject: "policy_bundle"`, `subject_id` equal to the
   policy id, `key_id`, `signed_at`, and the policy content (`policy_id`, `version`, and
   `rules`). The detached envelope adds `payload_sha256` and an Ed25519 signature over those
   exact canonical bytes. `provenance` is excluded from the policy content digest, so signing
   does not change the existing lifecycle audit digest and old audit chains still verify.
   The policy id appears in both `subject_id` and the content, so a signature cannot be
   moved to a different bundle id.
3. **The decision signature covers the decision record.** The signed payload contains the
   decision's `request_id`, actor, action, resource, policy id/version, allow/deny outcome,
   stable reason, matched rule index/effect, and timestamp, plus the same schema, subject
   (`authorization_decision`), subject id (`request_id`), key id, and signing time. The
   persisted record is immutable apart from the detached envelope. `request_id` binds the
   signature to the exact guarded operation and cannot be reused for another decision.
4. **No policy content decides until its signature verifies.** The shared
   `AuthorizationService` verifies bundle provenance before rule matching. A missing,
   malformed, unsupported-schema, wrong-subject, wrong-bundle-id, unknown-key, revoked-key,
   not-yet-valid, expired, payload-mismatched, or signature-invalid bundle denies. No rule
   matching runs for that policy. The denial is still signed and appended to the mandatory
   audit, then surfaced as `PolicyProvenanceDeniedError`; the host maps it to a 409
   `orchestration_rejected` response with the specific `policy_provenance_*` reason. This is
   the same fail-closed response class used by verifier provenance.
5. **Every host decision is signed before it is persisted.** The evaluator signs the complete
   allow/deny record with the configured key before appending it. If signing fails, no
   unsigned decision is accepted; the caller receives a deny. The authorization-audit read
   route verifies each record's signature and fails closed with
   `audit_provenance_invalid` if any record does not verify.
6. **Rotation and revocation are explicit, and history stays verifiable.** A key remains
   usable while its trust-root entry is `trusted` and the signing time is inside its
   validity window. Rotation writes a new trust root containing the old and new public keys;
   old decisions continue to verify because verification uses the signed key id and the
   signed time, and a replaced key does not retroactively invalidate the audit trail. A
   revoked key is rejected for new and existing verification. An unknown key id is never
   silently accepted. Operator ceremony: stop the host, generate the new key with the
   existing `trust-root.mjs` tooling, write an overlapping trust root, update the host
   `policy_provenance` fields, restart, and publish under the new key before removing the old
   key. Removing a key is not required for old-record verification and breaks it if done;
   retain old public keys for the audit retention period.
7. **Schema and subject are explicit.** The schema version and subject discriminator are
   inside the signed payload, not inferred from the enclosing file or route. A consumer may
   not reinterpret a policy signature as a decision signature or accept a future schema
   under current rules; unsupported versions fail closed. The host uses only the v1 parser.

## Non-goals and threat model

- This does not protect a host whose process or private key is compromised. Such a host can
  sign arbitrary policy and decisions. Remote attestation, HSM/KMS custody, production trust
  root provisioning, external audit custody, and trusted timestamps remain operator/service
  blockers.
- It does not prevent a publisher with the signing key from issuing a malicious but valid
  policy, or an authorized administrator from making a bad policy. Authorization and policy
  review remain separate governance controls.
- It does not make the durable registry rollback-proof or provide a monotonic external
  checkpoint. A full-file rollback to an older valid signed state is not detected by this
  ADR; evidence-bundle replay checks and external checkpoints are separate.
- It does not authenticate the trust root's author, encrypt policy content, or add a new
  network/credential dependency.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reuse the lifecycle `artifact_sha256` as the signature | A content digest is not an identity; a writer can recompute it. |
| Sign only the policy digest | The digest would still need an authenticated link to the bundle id and schema, and decision records were unsigned. |
| Verify at publication but trust the in-memory/queue copy | A compromised store or post-publication write could still reach the kernel. Verification belongs immediately before evaluation. |
| Require a remote signing/attestation service now | No provider, identity, custody, or availability decision exists; it would introduce an external dependency and block local operation. |
| Add a second policy evaluator for provenance | The repository deliberately has one shared boundary; a second path would create divergent enforcement. |

## Consequences

- Host deployments must provision `policy_provenance`, or startup fails. Existing unsigned
  policy files are rejected at decision time and must be re-published through the signed
  path. The registry itself remains readable for migration inspection, but its content cannot
  authorize work without a valid signature.
- Signed decisions add a fixed envelope to the durable audit. The audit parser accepts
  optional provenance so pre-provenance records remain readable for migration, but the host
  route verifies every record and refuses an audit containing an unsigned record. Operators
  must re-sign or archive legacy records before exposing the route as authoritative.
- Key material remains local. Compromise recovery is an operator incident, not an automatic
  protocol; the ADR records the rotation ceremony instead of pretending a remote ceremony
  exists.
- No new dependency, service, network call, or credential is introduced.

## Tests / evidence

- `apps/host/tests/policy-provenance.test.ts` covers signed bundle/decision verification,
  payload mutation, signature reuse across bundle ids, schema confusion, key-id substitution,
  a valid signature from a different trust root, revoked/expired keys, overlapping rotation
  with old-decision verification, unsigned policy rejection, and tampered evidence.
- `apps/host/tests/http-host.test.ts` covers the kernel intake boundary: an unsigned policy
  injected directly into the durable registry is rejected as `orchestration_rejected` before
  a Task is created, and the signed host routes continue to work across restart.
- `apps/host/tests/config.test.ts` covers the required configuration shape and key-id
  validation.
- Exact suite counts and the full uncached gate are recorded in
  `docs/process/project-state.md` and `docs/security/validation-ledger.md`.
