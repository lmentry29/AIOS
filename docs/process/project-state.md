# AIOS — Live Project State

Last verified: 2026-11-10 in the Freebuff cloud worktree. This snapshot distinguishes local
evidence from observed CI. Code head `4422229` (authorized runtime policy retirement) sits on
the branch above the previously verified merge head `8c950e6`, which merged `upstream/main`
at `767f30e` and passed the `ci` (run `42887224979`), `conformance` (run `42887225101`), and
`schema-check` (run `42887224921`) workflows with PR #1 mergeable/clean. Docs commit
`aa86a4e` sits above the code head, and `aa86a4e` passed `ci` (run `42892775891`),
`conformance` (run `42892776172`), and `schema-check` (run `42892775877`). Docs-only
record commit `c1dfa71` follows and passed the same three workflows; the security-hardening
commits are newer still and are recorded in `docs/security/validation-ledger.md`.

## Repository and active change

- Repository: https://github.com/lmentry29/AIOS
- Visibility: public; default branch: `main`
- Active implementation branch: `community/open-source-foundation`
- Active pull request: [#1 — Prepare AIOS for responsible community adoption](https://github.com/lmentry29/AIOS/pull/1)
- PR status: open, draft, **not merged**. Do not merge while implementation and audit work remain.
- Verified code head: `4422229` (`feat(host): retire attached policy versions at runtime`)
- Docs commit for this pass: `aa86a4e` (`docs(adr): record authorized runtime policy retirement`).
- Merge head with `upstream/main` (`767f30e`): `8c950e6`; CI was green there and PR #1 was
  mergeable/clean.
- `4422229` and docs commit `aa86a4e` sit above that merge head. Both workflow sets
  succeeded on `aa86a4e`; see Validation evidence for run ids.
- Do not push `main`. The implementation branch may be pushed to
  `upstream community/open-source-foundation`.

## Security hardening (2026-11-10)

- Operational journal recovery: offline checkpoint compaction (`compact-journal`) and
  integrity-checked, idempotent restore (`restore-journal`) are implemented under ADR-0025.
  Execution attempts and verifier result digests survive compaction. Archives are
  digest-verified but unsigned and unencrypted; retention is an operator duty.
- The real Linux boundary was executed, not simulated: bubblewrap 0.9.0 on kernel 6.1.102
  passed 9/9 adversarial cases covering host-file reads, workspace symlink escape, network
  interfaces, environment clearing, PID-namespace privacy, writes outside the workspace,
  effective capabilities, and background-workload cleanup. Docker, Seatbelt, gVisor, and
  Apple Containerization remain unverified or unavailable and are labelled as such in
  `docs/security/sandbox-matrix.md`.
- Timeout and cancellation now kill the provider's whole process group (with a direct-child
  fallback), covered by real parent/grandchild tests.
- Living security documentation lives in `docs/security/`: threat model, provider matrix,
  findings ledger, and validation ledger. The CI `Security` workflow runs the live sandbox
  suite with `bubblewrap` installed, plus a tracked-file secret scan and a production
  dependency audit, under `contents: read`.
- Independent verification is bound to the durable attempt: the verifier requires a
  completed attempt, the recorded executor principal, and a matching result digest, and
  records the execution ID and attempt in its decision evidence. Forged, unattempted, and
  wrong-principal results are rejected before the verification command runs.

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
| `@aios/founder` | Authorization-gated reads, human-only decision capture/review, default-deny policy with exact grant binding including human-only `administer_policy`/`revoke_policy`, atomic runtime replacement and retirement with per-resource fallback history, read-only vault/Gmail/Notion evidence adapters; live integrations unverified |
| `@aios/orchestration` | Authorized ordered dispatch, verifier identity/permission checks with verifier-attributed evidence binding, evidence artifacts, status/evidence reads, cancellation preflight/checks, authorized resume/retry orchestration, and read-only Task/Workflow attempt-chain inspection with all-or-nothing step authorization; execution is injected |
| `apps/host` | Loopback-only trusted host: owner-only config, bearer sessions, one policy evaluator, durable v2 policy registry/audit, exact-granted human-only runtime policy publication and retirement, durable journal, idempotent leased dispatch, fixed sandboxed `local.exec`, independent verifier, per-Task execution ledger with append-only attempts, authorized cancellation and resume/retry, all-or-nothing read-only attempt-history routes, verifier-bound evidence reads, approval-gated durable learning journal, durable allow/deny authorization audit with request correlation, strict concurrency cap, and recovery-to-suspended |

Not production-ready. There is no UI, no general capability/provider runtime, no secret
broker, no signed verifier provenance, no detached policy signature, no automatic
retry/backoff loop, and no live external-provider verification.

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
- ADR-0023 — **Accepted (2026-11-10)**: runtime policy administration. A human principal
  with an exact `administer_policy` grant on every target may publish and attach a new
  immutable policy through `POST /v1/policies`. The registry validates the artifact, version,
  and rule scope and commits the policy plus all attachments atomically. Every attempt is in
  the durable authorization decision journal; audit failure blocks mutation. A malformed,
  stale, or out-of-scope artifact leaves the prior policy effective. The offline
  `publish-policy` CLI remains the bootstrap path. There is no detached policy signature yet;
  authorized runtime retirement is added by ADR-0024.
- ADR-0024 — **Accepted (2026-11-10)**: authorized runtime policy retirement. `revoke_policy`
  is an exact, human-only action distinct from `administer_policy`. The human-only
  `POST /v1/policies/:policyId/revoke` requires the complete set of resources whose policy
  history references the version and an exact grant on every one of them. Retirement removes
  the version from every history, reattaches the newest remaining version, or leaves the
  resource with no policy and a fail-closed deny; the version is marked permanently retired
  and cannot be reattached. Registry state moves to v2 and a v1 file migrates without
  inventing a fallback. The offline `revoke-policy` CLI mirrors the route. There is still no
  detached policy signature, key rotation, external audit custody, or multi-host
  administration.
- ADR-0012 — **Proposed**: capability mediation remains the intended general model, but the
  first slice intentionally uses only fixed `local.exec`; provider selection is not exposed.

## Validation evidence

Local checks at code head `4422229` (Node 26.13.0, pnpm 11.11.0):

- `pnpm -r run build` — pass.
- `pnpm -r run typecheck` — pass.
- `pnpm -r run lint` — pass.
- `pnpm -r run test` — pass, **513 tests total**.
- Host: **106 tests** in 9 files, including 51 loopback HTTP tests, cancellation with a
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
  missing, a durable learning journal whose approved permanent Memory promotion and consumed
  approval survive close-and-reopen while unapproved and rejected approvals write no
  permanent entry, a durable authorization-audit journal whose allow/deny records survive
  restart in order with request correlation, and authorized runtime retirement that falls back
  to a retained version and then denies when none remains.
- Authorization audit: **6 store tests** plus host restart/grant cases, including five
  runtime policy-publication and four retirement cases. Allow and deny records include request id, principal,
  action, resource, policy/version, fixed reason, and the decisive rule; reopen preserves
  order and integrity, tamper and torn-tail handling are covered, and a failed append denies
  without recording a phantom decision.
- Learning: **28 tests**, including 13 approval tests. `memory-approval.test.ts` proves
  default denial, rejected/expired/pending approvals write nothing, human-only decisions,
  exact content/transition binding, one-time consumption, and unchanged draft promotions.
  `apps/host/tests/learning-store.test.ts` proves an approved promotion and its consumed
  approval survive close-and-reopen, and a rejected approval leaves no permanent entry.
- Core: **46**; conformance: **107**; integration: **43**; objects: 32; founder: 61;
  orchestration: 30; tools: 9; work-hierarchy: 24; containers: 21; learning: 28; agents: 6.
- `pnpm --filter @aios/core run generate:schemas` — pass; `git diff --exit-code
  schemas/generated` — clean.
- GitHub Actions on `aa86a4e`: `ci` (run `42892775891`), `conformance` (run
  `42892776172`), and `schema-check` (run `42892775877`) all succeeded; PR #1 reported
  `mergeable: true`, `mergeable_state: unstable` while those runs were in flight. The
  docs-only CI-record commit after `aa86a4e` has its own runs; do not infer their result
  from this line.

The command and test results above are local, not CI. The real Docker, bubblewrap, and
Seatbelt providers could not be integration-tested here: `docker info` cannot reach a daemon, and `bwrap`,
`podman`, and `sandbox-exec` are absent. The cancellation, multi-generation resume/retry, and
crash tests use clearly labelled test-only process/sandbox doubles where a real isolation
provider is unavailable; they do not claim container isolation.

## Production blockers — not optional

1. **Execution isolation proof.** Docker/bubblewrap/Seatbelt implementations need testing on
   hosts where they actually run, including cancellation/container-kill behavior, mount
   permissions, network denial, PID/memory limits, and hostile commands. Bubblewrap has a
   generated seccomp deny-list and live denial drill (ADR-0027), but no cgroup accounting, no
   active Landlock, and remains trusted-local only; Docker/Seatbelt/gVisor are unverified.
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
5. **Identity/policy lifecycle.** Bearer sessions, a durable policy registry, exact-granted
   runtime publication and retirement, and a durable hash-chained decision audit exist, but
   there is no user-facing login, detached policy signature, policy recovery/key-rotation
   procedure, or independent external audit custody. Registry state is v2 and has no
   downgrade path. The offline `publish-policy` and `revoke-policy` CLIs remain the bootstrap
   paths.
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

1. Exercise runtime policy publication and retirement in a production-like deployment with a
   real non-bootstrap operator, independent audit consumer, and restart/recovery drill; local
   tests are not operational deployment proof.
2. Test Docker/bubblewrap/Seatbelt on capable hosts and record the actual results, including
   cancellation and the explicit Docker container kill.
3. Add verifier key provenance or explicitly retain and document the host-trust model.
4. Exercise multi-generation resume/retry against real sandbox providers, including repeated
   crashes, cancelling generation 2, and workspace reuse across generations.
5. Source/review the Mission field model before adding any Mission API/schema.
6. Build a secret broker before any provider credential is introduced.
7. Keep PR #1 draft; do not merge or push `main`.
8. Define detached policy signatures and a key-recovery/rotation procedure before treating
   runtime policy administration as production security. Revocation itself is implemented;
   what is missing is protection against a rewritten policy file and key compromise.

## Source-of-truth rules

- This file is a status snapshot, not architectural authority.
- `docs/architecture/` and accepted ADRs govern normative behavior.
- `docs/process/divergence-log.md` records unresolved differences.
- Update this file only from fresh repository and test/CI evidence; never copy an old status
  forward without re-verification.
