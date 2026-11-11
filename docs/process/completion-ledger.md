# AIOS Completion Ledger

Status as of 2026-11-11, after the whole-provenance red-team pass on
`security/openjarvis-defensive-integration`. This ledger classifies the outstanding work
instead of relabeling blocked work as complete. Status values are exactly:

- `done` — implemented and covered by a passing check in this repository.
- `blocked-on-operator-hardware` — needs a host or platform this environment does not have.
- `blocked-on-live-credentials` — needs an operator-held secret or live external account.
- `blocked-on-unpublished-architecture-decision` — needs an ADR or field model before code can
  safely invent a contract.
- `pre-existing-baseline` — a known repository-wide baseline or skipped environment check, not
  something this pass silently fixed.

Owners are roles, not implied authority transfers. The repository owner is `@lmentry29`; the
host operator is the person running the trusted host and holding its secrets.

| ID | Item | Status | Owner | Evidence / next action |
|---|---|---|---|---|
| CL-001 | Policy bundles must not decide after their signing key expires. | `done` | Host maintainer | Current-window check in `apps/host/src/policy-provenance.ts`; F-027 test and mutation probe. |
| CL-002 | A signed verifier decision must be bound to the durable execution attempt at verification and read time. | `done` | Orchestration/host maintainer | `verified-execution` expectation fields, kernel durable-attempt lookup, evidence fields; F-028 tests and mutation probe. |
| CL-003 | Policy signing keys must not be admitted on the host verifier path. | `done` (host composition) | Host security maintainer | `assertSeparatePolicyAndVerifierKeys`; F-029 test and mutation probe. Purpose-bound root is CL-005. |
| CL-004 | Whole-chain red-team record and owner-attributed completion ledger. | `done` | Security maintainer | `docs/security/findings-ledger.md` F-027–F-030; this file. |
| CL-005 | Add per-key purpose/role binding to the trust-root schema so one root cannot authorize artifact, policy, verifier and audit subjects interchangeably. | `blocked-on-unpublished-architecture-decision` | Repository owner / security architect | Requires an ADR and a compatible trust-root schema migration. Host composition separation is implemented, but it is not a purpose-bound root. |
| CL-006 | External audit custody, trusted timestamps and a monotonic checkpoint that detects authorization-audit reorder/truncation/rollback. | `blocked-on-unpublished-architecture-decision` | Repository owner / security operator | F-030 and F-009 residual. Local hash chain is not a witness. External checkpoint/audit consumer must be selected and operated. |
| CL-007 | Production policy/verifier signing keys, HSM/KMS custody, recovery ceremony and compromise response. | `blocked-on-live-credentials` | Host operator | ADR-0034 operator ceremony exists; no production key material is present in the repository. Do not paste keys into chat or commit them. |
| CL-008 | Remote attestation, Sigstore/Fulcio/Rekor identity, SLSA/in-toto conformance. | `blocked-on-unpublished-architecture-decision` | Repository owner / security architect | ADR-0019/ADR-0033 explicitly do not claim these. Requires an architecture and external identity decision. |
| CL-009 | Live Gmail, Notion and Obsidian++ credentials, OAuth/token lifecycle and integration tests. | `blocked-on-live-credentials` | Host operator | Adapters are read-only/tested with fixtures; no live account is configured. |
| CL-010 | macOS Seatbelt, Apple Containerization, rootless Docker and a VM-class boundary. | `blocked-on-operator-hardware` | Platform operator | F-005/F-006/ADR-0031/ADR-0032. No macOS 26/Apple silicon or reachable local Docker daemon in this environment; CI measurements are not local proof. |
| CL-011 | Mission canonical-object field model (ADR-0017). | `blocked-on-unpublished-architecture-decision` | Repository owner / architecture owner | ADR-0017 remains Proposed; do not invent a sixth entity or merge Mission into containers. |
| CL-012 | Infrastructure records and secret broker (ADR-0018). | `blocked-on-unpublished-architecture-decision` | Repository owner / architecture owner | ADR-0018 remains Proposed; no infrastructure store or broker exists. |
| CL-013 | UI origin, CSRF and cookie behavior (ADR-0016 amendment). | `blocked-on-unpublished-architecture-decision` | Repository owner / architecture owner | Host rejects every `Origin`; no UI may be added before the ADR. |
| CL-014 | Scheduler, dependencies, parallelism, approval quorum and automatic resume. | `blocked-on-unpublished-architecture-decision` | Orchestration owner | Current cap rejects rather than queues; ADR-0022 covers deliberate resume/retry only. |
| CL-015 | Installer, signed update channel and supported distribution path. | `blocked-on-unpublished-architecture-decision` | Release owner | ADR-0020 keeps packages private and distribution as an application artifact; no release decision yet. |
| CL-016 | `@aios/containers` complete ContainerSpec and non-Project container types. | `blocked-on-unpublished-architecture-decision` | Domain/architecture owner | ADR-0011 narrows but does not close the Container Service gap. |
| CL-017 | Repository-wide formatter baseline (pre-existing `format:check` findings). | `pre-existing-baseline` | Repository maintainer | Not changed by this pass; do not claim formatting is green. |
| CL-018 | Host live suites skipped in this environment (sandbox/quota/seccomp/Seatbelt classes). | `pre-existing-baseline` | CI/platform operator | Host reports 279 passed / 17 skipped; the skipped cases require a live provider/platform and are not counted as passing. |
| CL-019 | Login, MFA, TLS on loopback and rate limiting for host sessions. | `blocked-on-unpublished-architecture-decision` | Repository owner / identity architect | Sessions have expiry/rotation/revocation, but no user login or transport-security ADR. |
| CL-020 | Aggregate cgroup accounting and Landlock for bubblewrap. | `pre-existing-baseline` | Sandbox owner | Documented in F-003/F-007/ADR-0028; no unprivileged hard aggregate quota on this host. |
| CL-021 | Independent external audit consumer and restart/restore drill against production-like state. | `blocked-on-live-credentials` | Host operator | Requires an external audit destination and operator-owned deployment; local tests are not deployment proof. |

A row is not moved to `done` because a test passes in a different row's environment or because
a residual risk was accepted. The red-team record and this table are both updated whenever a
blocked owner supplies the missing infrastructure or decision.
