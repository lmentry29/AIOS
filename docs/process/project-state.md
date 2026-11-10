# AIOS — Live Project State

Last verified: 2026-11-10 locally in the Freebuff cloud worktree. This snapshot records
local evidence only. The attempt-inspection head `8cd427a` and docs tip `c64ba42` passed the
`ci`, `conformance`, and `schema-check` workflows. The verifier-binding head `05769e1` and the
permanent-Memory approval head `503cefb` are pushed after this snapshot; read their checks
from GitHub.

## Repository and active change

- Repository: https://github.com/lmentry29/AIOS
- Visibility: public; default branch: `main`
- Active implementation branch: `community/open-source-foundation`
- Active pull request: [#1 — Prepare AIOS for responsible community adoption](https://github.com/lmentry29/AIOS/pull/1)
- PR status: open, draft, **not merged**. Do not merge while implementation and audit work remain.
- Verified code head: `503cefb` (`feat(learning): require human approval for permanent Memory writes`)
- The docs commit that updates this file follows the code head. Read `git log --oneline -4`
  for the actual tip.
- Do not push `main`. The implementation branch may be pushed to
  `upstream community/open-source-foundation`.

## Current package and application maturity

Nine workspace packages contain domain implementations at different maturity levels.
`apps/host` is an application/composition root, not a tenth package.

| Component | Current state |
|---|---|
| `@aios/core` | Established Zod schemas and generated JSON Schema, including the fixed `local_command` Task execution/verification specs |
| `@aios/objects` | In-memory object store with lifecycle, relationship, immutability, mutation guards, and recovery-only `restore()` |
| `@aios/work-hierarchy` | Task and Objective stores; Mission remains a typed reference with no backing record |
| `@aios/containers` | Project store only; eight container concepts remain unpromoted by ADR-0011 |
| `@aios/agents` | Agent lifecycle/conformance runner; not a general tool-executing agent runtime |
| `@aios/tools` | Plugin lifecycle management; general adapter invocation remains deferred |
| `@aios/learning` | Knowledge records and evolution stages; permanent stages require a recorded human approval; in-memory default with a durable host journal |
| `@aios/founder` | Authorization-gated reads, human-only decision capture/review, default-deny policy with the exact `cancel`/`resume`/`retry` actions, read-only vault/Gmail/Notion evidence adapters; live integrations unverified |
| `@aios/orchestration` | Authorized ordered dispatch, verifier identity/permission checks with verifier-attributed evidence binding, evidence artifacts, status/evidence reads, cancellation preflight/checks, authorized resume/retry orchestration, and read-only Task/Workflow attempt-chain inspection with all-or-nothing step authorization; execution is injected |
| `apps/host` | Loopback-only trusted host: owner-only config, bearer sessions, one policy evaluator, durable journal, idempotent leased dispatch, fixed sandboxed `local.exec`, independent verifier, per-Task execution ledger with append-only attempts, authorized cancellation and resume/retry, all-or-nothing read-only attempt-history routes, verifier-bound evidence reads, approval-gated durable learning journal, strict concurrency cap, and recovery-to-suspended |

Not production-ready. There is no UI, no general capability/provider runtime, no secret
broker, no signed verifier provenance, no automatic retry/backoff loop, and no live
external-provider verification.

## Architecture decisions

- ADR-0013 — **Accepted (2026-11-08)**: resource-attached, exact-match, default-deny
  authorization; deny overrides allow; no wildcard or owner-implied grants; identity comes
  from the trusted host; policy lifecycle and decisions require durable append-only audit.
- ADR-0014 — **Accepted (2026-08-17)**: the Obsidian vault is the Founder Intelligence
  persistence substrate; no parallel Founder database; read-and-propose by default;
  permanent Memory requires explicit human review/authorization.
- ADR-0015 — **Accepted (2026-11-10)**: hash-chained, fsync'd append-only operational
  journal for Task/Workflow/Artifact/run/execution state, with idempotency, leases, tamper
  detection, and recovery-to-suspended. No compaction or migration framework yet.
- ADR-0016 — **Accepted (2026-11-10)**: `packages/*` are the platform domain; `apps/host`
  is the trusted local application; UI is an untrusted future client. The host rejects every
  `Origin` until a session/CSRF/cookie ADR exists.
- ADR-0017 — **Proposed (2026-11-10)**: Mission as a Canonical Object subtype. Blocked on a
  sourced field-level model; do not invent a sixth entity or merge Mission with containers.
- ADR-0018 — **Proposed (2026-11-10)**: infrastructure records as canonical objects with
  secret references only. No infrastructure store or secret broker exists.
- ADR-0019 — **Accepted (2026-11-10)**: fixed `local.exec`, fail-closed sandbox providers
  (Docker/bubblewrap/Seatbelt), bounded/hashed evidence, and an independently executed
  verifier command. Verification decisions name their verifier, the identity is persisted in
  evidence, and evidence reads fail closed on a missing or mismatched verifier; signing and
  key management remain open.
- ADR-0020 — **Accepted (2026-11-10)**: `@aios/*` remain private; distribution is an
  application artifact under named release profiles. No npm publication.
- ADR-0021 — **Accepted (2026-11-10)**: exact authorized `cancel`; durable per-Task
  execution ledger; process termination via `AbortSignal`/`SIGKILL`; strict
  `execution.max_concurrent_tasks` (1–32, default 1) with deterministic 429 rejection; startup
  reconciliation of interrupted executions without re-execution or duplicate terminal effects.
- ADR-0022 — **Accepted (2026-11-10)**: deliberate `resume` (interrupted) and `retry`
  (failed/cancelled/unverified completed) as new append-only execution attempts. Workflow and
  Task are both resume units; a cancelled record is never reopened. Authorization is exact and
  precedes lookup; resumed work re-enters the same cap and startup never auto-resumes.
  Attempts are not capped at two across repeated crashes; every generation links to its
  immediate predecessor. Repeated reconciliation over an already-interrupted attempt writes
  nothing, and concurrent duplicate resume/retry requests return typed 409 before a second
  attempt or sandbox start. A read-only attempt-history API returns the full chain with
  oldest-first predecessor links under exact `read_status`; it never transitions, appends,
  or executes. Workflow inspection is all-or-nothing: every declared step Task is authorized
  before any history is read, so one missing grant denies the whole request with no partial
  chain.
- ADR-0012 — **Proposed**: capability mediation remains the intended general model, but the
  first slice intentionally uses only fixed `local.exec`; provider selection is not exposed.

## Validation evidence

Local checks at code head `503cefb` (Node 26.13.0, pnpm 11.11.0):

- `pnpm -r run build` — pass.
- `pnpm -r run typecheck` — pass.
- `pnpm -r run lint` — pass.
- `pnpm -r run test` — pass, **482 tests total**.
- Host: **86 tests** in 8 files, including 39 loopback HTTP tests, cancellation with a
  test-only sandbox stub, a real child-process SIGKILL test with a labelled
  `test-only-process` provider, cap enforcement/retry, late-result rejection, journal-level
  crash/restart reconciliation, authorized resume/retry over append-only attempts, a
  three-generation persisted resume chain, duplicate concurrent redrive suppression, a
  no-write second reconciliation over an already-interrupted attempt, read-only
  three-generation attempt inspection that leaves the operational journal byte-identical,
  all-or-nothing Workflow attempt inspection that denies a first- or later-step missing
  `read_status` grant before any ledger history read and leaves both persisted Task ledgers
  unchanged after reopen, verifier-attributed evidence that still reads after reopening
  with the original verifier but is rejected after a verifier swap or when identity is
  missing, and a durable learning journal whose approved permanent Memory promotion and
  consumed approval survive close-and-reopen while unapproved and rejected approvals write
  no permanent entry.
- Learning: **28 tests**, including 13 approval tests. `memory-approval.test.ts` proves
  default denial, rejected/expired/pending approvals write nothing, human-only decisions,
  exact content/transition binding, one-time consumption, and unchanged draft promotions.
  `apps/host/tests/learning-store.test.ts` proves an approved promotion and its consumed
  approval survive close-and-reopen, and a rejected approval leaves no permanent entry.
- Core: **46**; conformance: **107**; integration: **43**; objects: 32; founder: 50;
  orchestration: 30; tools: 9; work-hierarchy: 24; containers: 21; learning: 28; agents: 6.
- `pnpm --filter @aios/core run generate:schemas` — pass; `git diff --exit-code
  schemas/generated` — clean.

These are local results, not CI results. The real Docker, bubblewrap, and Seatbelt providers
could not be integration-tested here: `docker info` cannot reach a daemon, and `bwrap`,
`podman`, and `sandbox-exec` are absent. The cancellation, multi-generation resume/retry, and
crash tests use clearly labelled test-only process/sandbox doubles where a real isolation
provider is unavailable; they do not claim container isolation.

## Production blockers — not optional

1. **Execution isolation proof.** Docker/bubblewrap/Seatbelt implementations need testing on
   hosts where they actually run, including cancellation/container-kill behavior, mount
   permissions, network denial, PID/memory limits, and hostile commands. Bubblewrap has no
   cgroup accounting or seccomp profile and is trusted-local only.
2. **Verifier provenance.** A distinct configured verifier plus an independently executed
   command is implemented, but there is no signed decision, key rotation, or protection from
   a compromised host process.
3. **Execution re-drive quality.** Resume/retry are deliberate, authorized, append-only
   operations (ADR-0022), and the cap still rejects rather than queues. There is no automatic
   retry, backoff loop, scheduler, or capacity queue. Multi-generation resume, duplicate
   suppression, and cancellation across generations are proven only against the labelled
   `stub-container` double, not a real Docker/bubblewrap/Seatbelt provider.
4. **Mission/infrastructure models.** ADR-0017 and ADR-0018 are proposed; no Mission store,
   infrastructure inventory, or secret broker exists.
5. **Identity/policy lifecycle.** Bearer sessions and a durable policy registry exist, but
   there is no user-facing login, policy recovery/rotation procedure, or independent audit
   sink. Policy administration is an offline human CLI.
6. **Founder Intelligence quality.** The vault adapter is read-only and collection-scoped;
   per-note authorization, retrieval/context assembly, contradiction detection, and reviewed
   Founder vault memory writes remain open. Organizational Learning Memory now has
   approval-gated permanent stages, but that does not authorize any vault mutation. Do not
   bulk-migrate or modify the vault.
7. **Live connectors.** Gmail/Notion/Obsidian++ need OAuth/token lifecycle, scopes, health,
   pagination, rate limits, retries, and live integration tests.
8. **UI.** No UI exists. The host rejects all browser origins by design (ADR-0016).
9. **Orchestration depth.** No dependencies, scheduler, parallelism, approval gates, or
   automatic resume of suspended work.
10. **Operations.** No journal compaction/migrations, automated backup/restore drill,
    metrics/tracing/alerting, threat model, incident runbook, or SLOs.
11. **Release.** No installer, signed update channel, or supported npm install path.

## Next work order

1. Observe CI on the permanent-Memory approval head `503cefb` and its docs tip; do not treat
   local results as CI.
2. Test Docker/bubblewrap/Seatbelt on capable hosts and record the actual results, including
   cancellation and the explicit Docker container kill.
3. Add verifier key provenance or explicitly retain and document the host-trust model.
4. Exercise multi-generation resume/retry against real sandbox providers, including repeated
   crashes, cancelling generation 2, and workspace reuse across generations.
5. Source/review the Mission field model before adding any Mission API/schema.
6. Build a secret broker before any provider credential is introduced.
7. Keep PR #1 draft; do not merge or push `main`.

## Source-of-truth rules

- This file is a status snapshot, not architectural authority.
- `docs/architecture/` and accepted ADRs govern normative behavior.
- `docs/process/divergence-log.md` records unresolved differences.
- Update this file only from fresh repository and test/CI evidence; never copy an old status
  forward without re-verification.
