# ADR-0033 — Local Verifier Decision Signing

## Status

**Accepted** (2026-11-11). This ADR narrows a residual of ADR-0019; it does not replace its
host-trust model and does not claim remote attestation.

## Context

ADR-0019 requires a verifier principal distinct from every executor and an independently
executed verification command. The kernel persists the verifier identity and evidence, and
evidence reads fail closed when the configured verifier changes. That is principal
attribution, not cryptographic provenance: a durable artifact could be edited after the
fact, and a compromised host process could still manufacture a decision.

The repository already has an external Ed25519 trust root, strict trust-root parsing, key
rotation/revocation tooling, and signed artifact/build/evidence-bundle paths. Those
mechanisms are reusable without adding a runtime dependency or changing the fixed
`local.exec` grant.

## Decision

1. **Optional local detached signing.** An execution configuration may supply
   `verifier_signing_key_file`, `verifier_trust_root_file`, and `verifier_key_id` together.
   A partial configuration fails startup. The private key must be a regular, unlinked,
   owner-only file; it is read once and kept only in process memory.
2. **The verifier signs its decision, not the executor's result.** The signed body contains
   the schema version, Task id, optional execution id/attempt, the attempt-bound result
   digest when one exists, verifier id, accepted flag, reason, and the complete verifier
   evidence array. The signature is Ed25519 over canonical JSON, with a payload digest and
   the trust-root key id in a detached envelope.
3. **The kernel verifies before it commits.** When the configured verifier exposes
   provenance verification, `verifyResult` reconstructs the evidence record and rejects a
   missing, malformed, wrong-key, revoked, or tampered decision before any Artifact or Task
   lifecycle write. The same check runs when execution evidence is read back.
4. **Unsigned execution remains possible only when signing is not configured.** Existing
   deployments are not silently treated as signed. Configuring signing makes absent
   provenance fail closed for new decisions and for evidence reads.
5. **Scope and threat model.** This makes persisted decisions tamper-evident and pins the
   signer to a trust-root key. It does **not** protect against a compromised host process
   that can read the private key, does not provide remote attestation, does not establish
   production key custody, and does not replace external audit custody or a trusted
   timestamp. Those remain separate blockers.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Sign inside the kernel with a host key | Moves the verifier decision into the orchestrator and destroys the independent-principal boundary. |
| Require a remote signing service now | No provider, identity, availability, or custody decision exists; it would invent a new architecture. |
| Treat the existing evidence-bundle signature as a verifier decision | It authenticates a snapshot of the journal, not the verifier's per-decision command outcome, and is produced at export time. |
| Leave unsigned and document the gap only | The trust root and strict parsers already exist; a bounded local signature closes accidental post-hoc edits without claiming more than it provides. |

## Consequences

- Operators now have a strict all-or-none signing configuration. A bad key id, revoked key,
  expired key, non-owner-only private key, or mismatched trust root fails startup rather
  than silently disabling signing.
- Persisted evidence gains `verifier_provenance`. Old unsigned records remain readable only
  while the host has no signing configuration; otherwise they fail closed and require
  re-verification.
- The host still trusts its own process and key material. Production root provisioning,
  HSM/KMS custody, remote attestation, cross-process audit custody, and key-compromise
  recovery remain open.
- The source of truth for the crypto primitives remains `artifact-signing.ts`; this ADR does
  not duplicate or weaken its strict JSON, key-id, revocation, or validity-window rules.

## Tests / evidence

- `apps/host/tests/verifier-decision.test.ts` covers exact decision signing, tampered reason
  and payload digest, revoked/unknown keys, non-owner-only private keys, real verifier
  provenance, and persisted-record tamper rejection.
- `apps/host/tests/http-host.test.ts` covers the kernel write path, durable persistence,
  authenticated evidence read, and a post-signing mutation that returns
  `orchestration_rejected`.
- `apps/host/tests/config.test.ts` covers all-or-none configuration and key-id validation.
- The focused host suite and the repository-wide uncached gate are recorded in
  `docs/process/project-state.md` and `docs/security/executor-verifier-evidence.md`.
