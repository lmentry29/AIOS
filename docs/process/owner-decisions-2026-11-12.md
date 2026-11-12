# Owner decisions — 2026-11-12

These are the repository owner's answers to the remaining owner-gated completion questions.
They are recorded as decisions, not as implementation evidence. ADR-0035 through ADR-0038 and
the completion ledger carry the detailed status. No secret values are recorded here.

| Ledger row | Owner decision | Published in |
|---|---|---|
| CL-005 | A v2 trust root gives every key exactly one purpose. Legacy v1 roots migrate only with an explicit purpose; cross-purpose signatures fail. | ADR-0035 |
| CL-006 / CL-021 | Use a separate operator-owned host, an immutable/WORM checkpoint store, an independent audit consumer, and RFC 3161 timestamps; drill restart, restore, and whole-store rollback. | ADR-0035 |
| CL-007 | Production policy and verifier keys use HSM/KMS custody with dual control, recovery shares, rotation, and a compromise runbook. | ADR-0035 |
| CL-008 | Build provenance uses Sigstore keyless Fulcio/Rekor and SLSA v1/in-toto. Do not claim runtime attestation. | ADR-0035 |
| CL-009 | Gmail, Notion, and Obsidian are read-only integrations using host-held credentials and fixture-parity live tests. | ADR-0038 |
| CL-010 / CL-018 | Support Linux and macOS 26 Apple silicon. Implement and measure Seatbelt and Apple Containerization; run live suites on the supported matrix. | ADR-0037 |
| CL-011 | Accept Mission as a Canonical Object subtype with `name`, `purpose`, `lifecycle_state`, `owner_id`, and lifecycle history; additive migration. | ADR-0017, ADR-0036 |
| CL-012 | Implement ADR-0018 canonical infrastructure records with a host-owned secret broker, non-secret references, exact policy, and audit. | ADR-0018, ADR-0036 |
| CL-013 / CL-019 | Use a same-origin local UI with secure HttpOnly cookies, CSRF, loopback TLS, WebAuthn/passkey MFA, and rate limiting. | ADR-0037 |
| CL-014 | Add a durable dependency DAG, fair queue, bounded parallelism, approval quorum, and opt-in automatic resume. | ADR-0037 |
| CL-015 | Ship a signed application archive with an offline verifier; no auto-update channel. | ADR-0038 |
| CL-016 | Narrow the public Container contract to the Project subtype; explicitly defer the eight unsourced container types and `ContainerSpec`. | ADR-0036 |
| CL-017 | Perform the repository-wide Biome formatting migration and update affected citations. | Completion ledger |
| CL-020 | Require cgroup v2 delegation and Landlock for bubblewrap, fail closed when unavailable, and retain per-process rlimits. | ADR-0037 |

## Implementation boundary

The decisions do not supply external resources. The following still require an operator:

- an HSM/KMS account and a real dual-control ceremony;
- a separate audit host and immutable/WORM destination with an RFC 3161 authority;
- a macOS 26 Apple silicon runner or host;
- live Gmail/Notion accounts and an Obsidian vault;
- a Sigstore/SLSA-capable release run and public transparency-log verification;
- a cgroup v2/Landlock-capable Linux host for aggregate sandbox evidence.

Those gaps are reported in the completion ledger rather than silently replaced by local fakes.
