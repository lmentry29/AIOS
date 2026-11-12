# ADR-0035 — Purpose-Bound Trust Root, Production Key Custody, and External Audit Witness

## Status

**Accepted** (2026-11-12). This ADR records the repository owner's completion decisions for
CL-005, CL-006, CL-007, CL-008 and CL-021. The v2 trust-root schema and purpose checks are
implemented; HSM/KMS custody, the external witness, and Sigstore/SLSA publication require
operator infrastructure and are not claimed as live until those resources exist.

## Context

The local trust root was a version-1 Ed25519 key set with no purpose field. Host composition
rejected the same key id as both policy signer and verifier, but one root could still authorize
artifact, policy, verifier, and audit subjects interchangeably. The local signed audit head
detects truncation, reordering, and rollback while the current head remains; it cannot detect a
coordinated rewrite of both the journal and the signed head. Production key custody and remote
provenance were explicitly absent.

The owner selected the completion model below rather than retaining those as open-ended
architecture questions.

## Decision

### 1. Each trust-root key has exactly one purpose

The trust root is version 2. Every key carries exactly one of:

- `artifact` — gVisor pins, rootfs manifests, build statements, evidence bundles;
- `policy` — policy bundles, authorization decisions, audit-head checkpoints;
- `verifier` — independent verifier decisions;
- `audit` — reserved for an external witness consumer, never for a normal signing key.

A root may contain multiple keys with different purposes. A consumer must select a key by id
and reject it when its purpose is not the consumer's required purpose. Cross-purpose use is a
verification failure, not a policy preference.

Version-1 roots remain readable only by supplying the purpose expected by the caller. The
loader assigns that single purpose to every legacy key. New roots are written as version 2.
There is no implicit "any purpose" key.

### 2. Production signing uses operator-owned HSM/KMS custody

The repository continues to use Ed25519 detached signatures so offline verification remains
possible. Production policy and verifier keys must be generated and used inside an operator-held
HSM/KMS with:

- dual control for creation, activation, rotation, and recovery;
- tested recovery shares stored outside the repository and outside the host;
- a documented rotation overlap window and revocation procedure;
- a compromise-response runbook that identifies affected policy, verifier, artifact, and audit
  subjects;
- no private key material in the repository, environment of a Task, journal, evidence bundle,
  logs, or generated schema.

The host composer must accept a custody adapter that exposes only `sign(key_id, payload)` and
`public_key(key_id)`; it must never expose raw private key bytes. Missing custody is a startup
failure when signed policy/verifier operation is configured, not a fallback to a local key.

### 3. Audit custody uses an external immutable witness

A separate operator-owned host writes signed checkpoints to an immutable/WORM store and an
independent audit consumer reads them. Each checkpoint carries:

- the local audit sequence and record count;
- the signed local audit head;
- an RFC 3161 timestamp token over the checkpoint;
- the trust-root key id and purpose of the checkpoint signer;
- the destination identity and a bounded retention reference.

The independent consumer verifies the checkpoint signature, timestamp, chain position, and
previous checkpoint before acknowledging it. The host refuses to treat a local append as
externally witnessed until the consumer's acknowledgement is durable. A missing destination,
consumer, or timestamp authority fails closed for production audit claims.

The existing local high-water mark remains the offline detection layer. The external witness is
the authority for detecting a coordinated whole-store rewrite.

### 4. Build provenance uses Sigstore and SLSA; runtime attestation is not claimed

Build artifacts are published with Sigstore keyless signing through Fulcio and Rekor and with
SLSA v1/in-toto provenance. Verification is against the public transparency log and the exact
repository/workflow identity. The repository does not claim TPM/TEE runtime attestation; runtime
trust remains the measured sandbox boundary described by ADR-0019, ADR-0031, and ADR-0032.

Local Ed25519 provenance remains available for offline evidence bundles and drills. It does not
substitute for public build provenance or external audit custody.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep host-composition separation only | A policy key still verifies an artifact or verifier decision outside that one host check. |
| Separate root file per purpose | Strong isolation, but four operator ceremonies and no benefit over a single v2 root with explicit key purposes. |
| Keep local keys for production | No dual control, no recovery custody, and no defensible compromise response. |
| Rely on the local signed high-water mark | Cannot detect a coordinated rewrite of both journal and signed head. |
| Claim TPM/TEE attestation without hardware | Fabricates a trust property the repository cannot measure. |

## Consequences

- `loadTrustRoot` accepts v1 only with an explicit expected purpose and always returns v2.
- Artifact, policy, verifier, and evidence verification reject a key whose purpose differs.
- Production HSM/KMS and WORM/RFC3161 resources remain operator-supplied; absence is reported
  as a live-resource blocker, not silently replaced by local files.
- Public Sigstore/SLSA publication is a release-workflow responsibility and cannot be claimed
  until a real release run has verified it.
- The reserved `audit` purpose is for the external witness consumer; it does not grant local
  policy or verifier authority.

## Tests required

- A policy-purpose key cannot verify an artifact, build attestation, or evidence bundle.
- A verifier-purpose key cannot sign or verify a policy or authorization decision.
- An artifact-purpose key cannot authorize policy or verifier decisions.
- A version-1 root loads only with an explicit purpose; a v2 key with a missing or unknown
  purpose is rejected.
- A root with mixed key purposes verifies each subject only with the matching key.
- HSM/KMS absence fails startup when signed production operation is configured.
- A missing WORM destination, independent consumer, or RFC3161 token fails the production audit
  drill; the local drill still passes without claiming external custody.
