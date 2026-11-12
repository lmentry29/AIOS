# Operator provisioning and capability gates

This document lists only the resources the repository owner or host operator must supply.
It is not a request to paste secret values into chat, an issue, a commit, or a configuration
file. Provision each resource in the operator's secret store or infrastructure account, then
configure the path or identity that the host should use.

## Already implemented without operator infrastructure

- Canonical infrastructure records and the host-owned local encrypted secret broker
  (ADR-0018 amendment). The broker requires an owner-only 32-byte key file and writes an
  encrypted ciphertext store outside the operational journal.
- Durable dependency-DAG scheduling records with cycle/ordering validation, fair claims across
  Missions, per-graph and host-wide parallelism bounds, human approval quorum, explicit
  restart recovery, and opt-in automatic resume (ADR-0037 amendment).

The local broker is **not** an HSM/KMS and is not production key custody. It exists so the
host code path, fail-closed behavior, redaction tests, and restart behavior are real while the
production custody decision remains owner-gated.

## Operator-only resources

| Requirement | Supplies | Why it cannot be fabricated locally |
|---|---|---|
| CL-007 | HSM/KMS account, dual-control key ceremony, recovery shares, rotation and compromise runbook | Production policy/verifier key custody; a local file broker is not equivalent. |
| CL-006 / CL-021 | Separate operator-owned audit host, immutable/WORM checkpoint destination, independent audit consumer, RFC 3161 authority | Local high-water marks cannot prove external custody or timestamping. |
| CL-008 | Sigstore/Fulcio/Rekor release identity and a SLSA/in-toto publication run | Transparency-log identity and a real release run require an external release environment. |
| CL-009 | Read-only Gmail and Notion credentials and an Obsidian vault path | Live accounts and vault access are operator-owned; adapters are fixture-tested only. |
| CL-010 / CL-018 | macOS 26 Apple silicon runner or host | Seatbelt and Apple Containerization evidence requires that platform. |
| CL-015 | Artifact-purpose signing key in operator custody | The archive/verifier exists, but a signed release must use an operator-held key. |
| CL-020 | Linux host with cgroup v2 delegation and Landlock | Aggregate limits and filesystem confinement require the real kernel capabilities. |

Until each resource exists, the corresponding ledger row remains explicitly gated. Missing
broker configuration makes credential routes return HTTP 503; it does not fall back to a
plaintext store or a fake provider.

## Local broker configuration

The optional `secret_broker` configuration object has exactly two absolute paths:

```json
{
  "secret_broker": {
    "store_file": "/absolute/operator/path/secrets.enc.json",
    "key_file": "/absolute/operator/path/broker.key"
  }
}
```

- `key_file` must be a regular, unlinked, owner-only (`0600`) file containing exactly 32 raw
  bytes or 64 hex characters.
- `store_file` is created with mode `0600` in an owner-only directory and contains only
  AES-256-GCM ciphertext and nonces.
- The key file must not be inside the repository, a release archive, or the operational
  journal directory.
- Omitting `secret_broker` is valid: infrastructure records without credentials still work,
  but secret creation and rotation fail closed.

The infrastructure routes are documented in ADR-0018. The DAG scheduler remains a host
library composed into the durable store; it does not expose an auto-execution route and does
not bypass the Orchestration Kernel's `execute` authorization or independent verification.
