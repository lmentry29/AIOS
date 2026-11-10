# AIOS — Live Project State

Last verified: 2026-11-10 locally in the Freebuff cloud worktree. This snapshot records
local evidence only; no GitHub Actions run has been observed for the current code head.

## Repository and active change

- Repository: https://github.com/lmentry29/AIOS
- Visibility: public; default branch: `main`
- Active implementation branch: `community/open-source-foundation`
- Active pull request: [#1 — Prepare AIOS for responsible community adoption](https://github.com/lmentry29/AIOS/pull/1)
- PR status: open, draft, **not merged**. Do not merge while implementation and audit work remain.
- Verified code head: `ce876cf` (`feat(host): add authorized resume and retry for interrupted work`)
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
| `@aios/learning` | Knowledge records and evolution stages; in-memory |
| `@aios/founder` | Authorization-gated reads, human-only decision capture/review, default-deny policy with the exact `cancel`/`resume`/`retry` actions, read-only vault/Gmail/Notion evidence adapters; live integrations unverified |
| `@aios/orchestration` | Authorized ordered dispatch, verifier identity/permission checks, evidence artifacts, status/evidence reads, cancellation preflight/checks, and authorized resume/retry orchestration; execution is injected |
| `apps/host` | Loopback-only trusted host: owner-only config, bearer sessions, one policy evaluator, durable journal, idempotent leased dispatch, fixed sandboxed `local.exec`, independent verifier, per-Task execution ledger with append-only attempts, authorized cancellation and resume/retry, strict concurrency cap, and recovery-to-suspended |

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
  verifier command.
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
- ADR-0012 — **Proposed**: capability mediation remains the intended general model, but the
  first slice intentionally uses only fixed `local.exec`; provider selection is not exposed.

## Validation evidence

Local checks at code head `ce876cf` (Node 26.13.0, pnpm 11.11.0):

- `pnpm -r run build` — pass.
- `pnpm -r run typecheck` — pass.
- `pnpm -r run lint` — pass.
- `pnpm -r run test` — pass, **450 tests total**.
- Host: **71 tests** in 7 files, including 28 loopback HTTP tests, cancellation with a
  test-only sandbox stub, a real child-process SIGKILL test with a labelled
  `test-only-process` provider, cap enforcement/retry, late-result rejection, journal-level
  crash/restart reconciliation, and authorized resume/retry over append-only attempts.
- Core: **46**; conformance: **107**; integration: **43**; objects: 32; founder: 50;
  orchestration: 26; tools: 9; work-hierarchy: 24; containers: 21; learning: 15; agents: 6.
- `pnpm --filter @aios/core run generate:schemas` — pass; `git diff --exit-code
  schemas/generated` — clean.

These are local results, not CI results. The real Docker, bubblewrap, and Seatbelt providers
could not be integration-tested here: the Docker daemon is inaccessible and the other tools
are absent. The cancellation and crash tests use clearly labelled test-only process/sandbox
doubles where a real isolation provider is unavailable; they do not claim container isolation.

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
   retry, backoff loop, scheduler, or capacity queue; resumed work has not been exercised
   against real Docker/bubblewrap/Seatbelt providers.
4. **Mission/infrastructure models.** ADR-0017 and ADR-0018 are proposed; no Mission store,
   infrastructure inventory, or secret broker exists.
5. **Identity/policy lifecycle.** Bearer sessions and a durable policy registry exist, but
   there is no user-facing login, policy recovery/rotation procedure, or independent audit
   sink. Policy administration is an offline human CLI.
6. **Founder Intelligence quality.** The vault adapter is read-only and collection-scoped;
   per-note authorization, retrieval/context assembly, contradiction detection, and reviewed
   memory writes remain open. Do not bulk-migrate or modify the vault.
7. **Live connectors.** Gmail/Notion/Obsidian++ need OAuth/token lifecycle, scopes, health,
   pagination, rate limits, retries, and live integration tests.
8. **UI.** No UI exists. The host rejects all browser origins by design (ADR-0016).
9. **Orchestration depth.** No dependencies, scheduler, parallelism, approval gates, or
   automatic resume of suspended work.
10. **Operations.** No journal compaction/migrations, automated backup/restore drill,
    metrics/tracing/alerting, threat model, incident runbook, or SLOs.
11. **Release.** No installer, signed update channel, or supported npm install path.

## Next work order

1. Push the branch and observe CI on the exact commit; do not treat local results as CI.
2. Test Docker/bubblewrap/Seatbelt on capable hosts and record the actual results, including
   cancellation and the explicit Docker container kill.
3. Add verifier key provenance or explicitly retain and document the host-trust model.
4. Exercise resume/retry against real sandbox providers, including a crash during a resumed
   attempt and cancellation of a retried attempt.
5. Source/review the Mission field model before adding any Mission API/schema.
6. Build a secret broker before any provider credential is introduced.
7. Keep PR #1 draft; do not merge or push `main`.

## Source-of-truth rules

- This file is a status snapshot, not architectural authority.
- `docs/architecture/` and accepted ADRs govern normative behavior.
- `docs/process/divergence-log.md` records unresolved differences.
- Update this file only from fresh repository and test/CI evidence; never copy an old status
  forward without re-verification.
