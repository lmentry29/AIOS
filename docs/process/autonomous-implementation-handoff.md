# Autonomous Implementation Handoff

Single source of truth for cross-session continuation. Do not create competing progress
documents; update this one.

Last updated: 2026-11-10 (Freebuff Cloud session, attempt-chain hardening slice).

## Repository state

- Repository: `lmentry29/AIOS` (public)
- Branch: `community/open-source-foundation`
- Pull request: https://github.com/lmentry29/AIOS/pull/1 (open, draft, **not merged**)
- Verified code head: `a816fe3` (`fix(host): harden multi-generation resume and duplicate redrives`)
- This handoff is the docs commit that follows that code head; read `git log --oneline -4`
  for the exact tip. Push only `community/open-source-foundation`; do not push `main` and do
  not merge PR #1.
- Prior commits in this session:
  - `a816fe3` — multi-generation attempt chains, no-write reconciliation, duplicate redrive suppression
  - `ce876cf` — authorized resume/retry over append-only attempts
  - `eea8b2c` — verified Task execution lifecycle record
  - `21ccdb0` — authorized Task/Workflow list routes
  - `cb16610` — Docker isolation argv test
  - `2d68052` — workspace permissions and one-Action evidence fix
  - `70f07b4` — fixed local execution, sandbox providers, independent verifier
  - `b5dc5d9` — durable hash-chained operational journal
  - `a7d930a` — durable-persistence evidence and handoff

## Environment notes

- Node `26.13.0`, pnpm `11.11.0`, Linux `6.1.102`.
- **pnpm may be missing after a VM restart.** Install locally if needed:
  `npm i -g --prefix "$HOME/.local" pnpm@11.11.0` (binary at `~/.local/bin/pnpm`), then
  `pnpm install --frozen-lockfile`.
- **Turborepo root quirk:** Turbo resolves `/workspace` and cannot create `/workspace/.turbo`
  in this worktree, so use `pnpm -r run <task>` locally. GitHub Actions is unaffected.
- Docker CLI is present but the daemon is not reachable to this user; `bwrap`, `podman`, and
  `sandbox-exec` are absent. Therefore the Docker/bubblewrap/Seatbelt providers cannot be
  integration-tested here. They fail closed when their probe fails.
- GitHub Actions passed `ci`, `conformance`, and `schema-check` at `c4a26cd`. Checks for
  `a816fe3` and the docs tip are observed after the push; this handoff does not assert them.

## Completed — Task execution lifecycle (`d414cbe`)

The host now treats Task execution as a durable lifecycle rather than a fire-and-forget
call inside a dispatch.

### Durable execution ledger

- `apps/host/src/persistence/execution-ledger.ts` adds a per-Task `execution` journal record,
  separate from the dispatch `run` record. States are `running`, `completed`, `failed`,
  `cancelled`, and `interrupted`; terminal records are immutable.
- A record is appended before the sandbox starts. Success, failure, cancellation, and restart
  interruption each append exactly one terminal revision.
- Evidence is bounded to eight single-line strings of at most 300 characters. Result/evidence
  content is represented by SHA-256 digests; raw stdout/stderr and exception messages are not
  copied into the journal.
- `DurableOperationalStore` restores execution records on replay and rejects non-monotonic or
  post-terminal transitions.

### Authorized cancellation

- `cancel` is now an exact `AccessAction` in `@aios/founder` and the orchestration request
  union. The existing default-deny evaluator, resource attachment, deny-overrides, and
  append-only authorization audit are unchanged.
- `POST /v1/tasks/:id/cancel` authorizes before revealing Task existence. A matching allow is
  required; an intake-only policy receives 403 and no ledger record is written.
- The route accepts an optional bounded `reason`; only its SHA-256 digest is evidence. A
  repeated cancellation returns 200 idempotently. A terminal Task/execution returns 409.
- A queued (`created`) Task gets a terminal cancelled execution record but remains canonical
  `created`; a later dispatch is rejected by the kernel preflight. An active Task is moved to
  canonical `suspended`. **No `cancelled` lifecycle state was added**; ADR-0021 keeps
  cancellation in the execution ledger.
- The cancellation record is committed before aborting the executor. The managed executor
  wrapper rechecks the ledger after the sandbox returns, so a late success cannot overwrite
  cancellation.

### Real process termination

- `AbortSignal` is threaded through `SandboxRunSpec`, every provider, and
  `runCapturedProcess`. Aborting sends `SIGKILL` to the child.
- Docker runs with a unique `--name` and issues an explicit `docker kill` on abort; killing
  only the CLI would leave the container running.
- Bubblewrap already uses `--die-with-parent` and now receives the child abort; Seatbelt also
  receives it.
- `LocalCommandExecutor` owns one `AbortController` per active Task and exposes
  `cancelTask(taskId)`.
- The test-only process provider is explicitly labelled `test-only-process`: it uses the
  production process helper and proves a real child PID dies, but provides no isolation and
  is never selected by the host CLI.

### Verifier and completion ordering

- The kernel checks the execution ledger before dispatch lifecycle writes, before execution,
  immediately after execution, after verification, and before evidence/completion writes.
- If cancellation is observed before verification starts, the verifier is not called.
- If cancellation arrives while verification is already running, verification may finish, but
  the kernel cannot mark the Task complete and leaves it suspended.
- The managed executor wrapper also refuses to complete its record when the terminal state is
  no longer `running`.

### Bounded concurrency

- `execution.max_concurrent_tasks` is a strict host-config field: integer 1–32, default 1.
  Unknown fields, zero/negative/fractional/out-of-range/non-numeric values fail startup.
- The chosen policy is **non-blocking deterministic rejection**. A dispatch beyond the cap
  raises `ExecutionCapacityError` before the kernel's first lifecycle write and maps to HTTP
  429 `execution_capacity_exceeded`. The Workflow and Task remain `created` and can be
  retried when capacity is available.
- The managed executor enforces the same cap as a second line of defense; no more than the
  configured number execute concurrently.

### Restart reconciliation

- `DurableRunCoordinator` now also supports the terminal `cancelled` run state.
- At startup, before serving:
  - running dispatch runs become `interrupted`;
  - running Task executions become `interrupted` with `host_restarted`;
  - affected `active`/`monitored` Workflows and Tasks become `suspended` under the fixed host
    recovery actor.
- Recovery does not re-execute work, does not mark work completed, and does not append a
  second terminal execution record. A second fresh start is a no-op.
- The execution record is the authority for cancellation/recovery; canonical lifecycle stays
  within ADR-0003's existing state graph.

## Completed — deliberate resume and retry (`ce876cf`)

ADR-0022 resolves the previous "no resume" limitation without weakening terminal
cancellation or startup recovery.

### Append-only attempts

- `ExecutionRecord` now carries `attempt`, `attempt_kind` (`initial`/`resume`/`retry`), and
  `previous_execution_id`. `ExecutionLedger` keeps an ordered attempt chain per Task;
  `getForTask()` observes the latest attempt and `listForTask()` exposes immutable history.
- `start()` creates only attempt 1. `resume()` accepts only an `interrupted` predecessor;
  `retry()` accepts `failed`, `cancelled`, or unverified `completed` and rejects a running or
  interrupted predecessor. A cancelled record is never reopened or rewritten.
- Journal replay validates contiguous attempt numbers and matching predecessors. A
  pre-ADR-0022 single record replays as attempt 1/`initial`; ambiguous chains fail closed.

### Authorized routes

- `resume` and `retry` are new exact `AccessAction` values in `@aios/founder` and the
  orchestration authorization union. There is no owner/role/wildcard shortcut and no
  "resume implies retry".
- `POST /v1/workflows/:id/resume`, `POST /v1/tasks/:id/resume`, and
  `POST /v1/tasks/:id/retry` authorize before resource lookup, matching cancel. The kernel
  re-evaluates the same action on the authenticated actor.
- Workflow resume requires `resume` on the Workflow and on every interrupted Task it
  re-drives, plus `execute` for each Agent. Completed Tasks are skipped, interrupted Tasks get
  a new attempt, and remaining `created` Tasks execute. A `failed`, `cancelled`, or
  unverified-completed sibling blocks the resume with 409 until the Task is explicitly
  retried; a Workflow resume never silently retries a Task.
- Task-level resume/retry executes only that Task and leaves its Workflow lifecycle
  unchanged (normally `suspended`).

### Capacity, cancellation, and idempotency

- Resumed/retried work goes through the same `ManagedExecutionPort` and
  `execution.max_concurrent_tasks` gate; a full cap returns 429 before lifecycle or attempt
  writes and starts no sandbox.
- Cancellation still reaches the provider on a resumed attempt. The route commits the
  cancellation before aborting; the managed wrapper rechecks the new attempt's identity and
  state, so a late result cannot complete it.
- Repeating resume/retry after completion returns 200 with `resumed:false`/`retried:false`
  and creates no new attempt. Repeated work while active returns 409.
- Startup reconciliation is unchanged: it marks running attempts `interrupted` and suspends
  work, and never calls resume/retry. A second start remains a no-op.

## Completed — attempt-chain hardening (`a816fe3`)

The ADR-0022 slice handled one resume. This slice makes the chain safe across repeated
crashes and duplicate requests.

### Multi-generation chains

- Attempt numbers are not capped at two. `listForTask()` returns every generation; a chain
  can be `1 initial interrupted → 2 resume interrupted → 3 resume completed`.
- Every successor records its immediate predecessor, not attempt 1. Earlier terminal records
  are never rewritten when later generations append.
- Journal replay now refuses a successor whose predecessor is still `running`, refuses
  `resume` after anything but `interrupted`, and refuses `retry` after anything but `failed`,
  `cancelled`, or `completed`. Contiguity and predecessor identity were already checked.
- A test drives a three-generation chain through two real persisted restarts: generation 2 is
  created through the same durable ledger `resume` operation, interrupted by reconciliation,
  then generation 3 completes through `POST /v1/workflows/:id/resume`.

### Reconciliation and duplicate suppression

- Reconciliation only transitions `running` records. An already-interrupted latest attempt
  is left untouched; a second pass over the same journal appends no bytes.
- The kernel holds an in-process claim for the Workflow and every Task it will touch. Claims
  are checked and acquired atomically before the first lifecycle or attempt write and released
  in `finally`. A duplicate concurrent resume/retry that overlaps a claimed resource returns
  typed 409 `execution_conflict` without waiting and without a second sandbox start.
- The durable ledger independently refuses a `resume`/`retry` unless the latest attempt is
  terminal in the required state, so a direct concurrent call cannot fork the chain either.
- ADR-0022 now states the contract explicitly: non-blocking 409 while a redrive is in flight;
  200 idempotent no-op after completion.

### Failure and capacity across generations

- Cancelling generation 2 leaves generations 1 and 2 immutable; an explicit retry appends
  generation 3 and completes the Task. The Workflow stays suspended until explicitly resumed.
- The concurrency cap is tested on a generation-2 interrupted attempt: with the cap full, the
  later resume returns 429 before any lifecycle or attempt write; after release, generation 3
  completes.

## Verification actually executed at `a816fe3`

Local at commit time; CI is observed after the push, not asserted here.

```sh
pnpm -r run build
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
pnpm --filter @aios/core run generate:schemas
git diff --exit-code schemas/generated
```

All six commands exited 0. Exact test results:

| Suite | Result |
|---|---|
| `@aios/host` | **75 passed** (7 files) |
| `@aios/core` | **46 passed** (4 files) |
| `tests/conformance` | **107 passed** (6 files) |
| `tests/integration` | **43 passed** (6 files) |
| `@aios/objects` | 32 passed |
| `@aios/founder` | 50 passed |
| `@aios/orchestration` | 26 passed |
| `@aios/tools` | 9 passed |
| `@aios/work-hierarchy` | 24 passed |
| `@aios/containers` | 21 passed |
| `@aios/learning` | 15 passed |
| `@aios/agents` | 6 passed |
| **Total** | **454 passed** |

Schema regeneration produced no diff.

### What each new test pins

- `http-host.test.ts` — executing cancellation returns 202, aborts the sandbox stub, records a
  terminal cancelled execution and run, skips the verifier (exactly one sandbox call), moves
  active work to suspended, hashes the reason, and records the `cancel` allow in the shared
  audit chain.
- `http-host.test.ts` — queued cancellation returns 202 and a later dispatch is rejected with
  no sandbox call; intake-only policy denies cancel with 403 and no ledger record.
- `http-host.test.ts` — cap 1 rejects a second dispatch with 429 before lifecycle writes,
  leaves its Workflow/Task `created`, starts no second sandbox call, and retries successfully.
- `http-host.test.ts` — a journaled running run + execution followed by a fresh host start
  yields one `interrupted` execution and suspended work; a third start makes no change.
- `execution.test.ts` — cancelling the local executor SIGKILLs a real child process and
  rejects with `TaskCancelledError`, using the labelled `test-only-process` provider.
- `managed-execution.test.ts` — a late executor result cannot overwrite a cancelled terminal
  record; the cap rejects before creating a second execution.
- `config.test.ts` — rejects 0, 33, fractional, and string `max_concurrent_tasks` values.
- `http-host.test.ts` — crash-interrupted Workflow resume appends attempt 2 and leaves
  attempt 1 `interrupted`; a repeated resume is a 200 no-op with no third attempt.
- `http-host.test.ts` — a cancelled attempt rejects `resume` with 409 while an authorized
  `retry` appends attempt 2 and preserves the cancelled record; repeated retry is a 200 no-op.
- `http-host.test.ts` — a failed attempt blocks Workflow resume until the Task is explicitly
  retried; the later Workflow resume skips the completed Task and starts no sandbox.
- `http-host.test.ts` — `resume` (Workflow and Task), `retry`, and the retried Agent's
  `execute` each return 403 before lookup with no attempt or lifecycle write.
- `http-host.test.ts` — cap 1 rejects a later-generation (attempt 2) Workflow resume with
  429 before any attempt or lifecycle write, then succeeds after the competing execution
  releases capacity.
- `http-host.test.ts` — cancelling a resumed attempt aborts the sandbox and leaves attempts 1
  (`interrupted`) and 2 (`cancelled`) immutable; an explicit retry appends attempt 3 and
  completes the Task, and a later Workflow resume skips it.
- `http-host.test.ts` — a persisted three-generation chain survives two restarts with
  monotonic attempts, correct kinds, immediate-predecessor links, and unchanged earlier
  records, ending in a completed attempt 3.
- `http-host.test.ts` — concurrent duplicate Workflow resume, Task resume, and Task retry
  each return one 409 `execution_conflict`, one appended attempt, and one sandbox start;
  sequential repeats after completion are 200 no-ops.
- `persistence.test.ts` — attempt chains survive restart, terminal records stay immutable,
  `resume` only accepts `interrupted`, `retry` follows `failed`/`cancelled`, and a
  non-contiguous replay fails closed. A resumed attempt is interrupted once by reconciliation;
  a second pass creates no attempt and appends no journal bytes.

### Security tests / evidence labels

- **Locally tested:** sandbox argv/no-shell, env filtering, hashed evidence, non-zero,
  timeout, unavailable provider, cwd escape, verifier independence, unexpected verifier
  exit, executor-result digest binding, host 503/422 behavior, composed HTTP dispatch,
  authorized/denied cancellation, resume/retry authorization and lifecycle, real child
  SIGKILL, cap rejection, and journal-level crash reconciliation.
- **Resume/retry evidence label:** every resume/retry HTTP proof composes the real
  `LocalCommandExecutor`/`LocalCommandVerifier` around the labelled `stub-container` sandbox.
  It proves authorization-before-lookup, multi-generation attempt identity, no-write
  reconciliation, duplicate suppression, cap ordering, cancellation/abort handling, and
  verifier invocation. It is not container-isolation or real-provider evidence. A real-runtime
  proof would additionally cover per-generation container creation/teardown, killing the
  generation-2 container on cancel, workspace reuse across generations, image availability,
  and the same PID/memory/network limits on every generation.
- **Not integration tested here:** any real Docker, bubblewrap, or Seatbelt invocation. The
  Docker daemon/tools are unavailable in this workspace. The process test proves the shared
  child-process helper kills a direct child; it is not isolation evidence.
- **Not live-provider verified:** Obsidian++, Gmail, Notion, GitHub, or any model provider.
- **Not security tested:** independent penetration test, hostile-kernel escape, container
  escape, or verifier-key compromise. Bubblewrap has no cgroup accounting or seccomp profile
  and is labelled kernel-namespace/trusted-local only.
- **Not signed:** verifier decisions have no Ed25519/TUF provenance. The trust anchor is a
  host-configured distinct principal plus a separately executed command.

## Remaining engineering blockers, in priority order

1. **Real sandbox verification.** Run Docker and bubblewrap on hosts with those runtimes,
   including cancellation/container-kill behavior, mount permissions, network denial,
   PID/memory limits, and hostile command probes. Seatbelt needs macOS testing.
2. **Verifier provenance.** Add key generation/distribution/rotation and kernel-side
   signature verification, or explicitly retain the current host-configured trust model.
3. **Execution re-drive quality.** Resume/retry are implemented and authorized per ADR-0022,
   with multi-generation and duplicate suppression, but there is still no automatic retry,
   backoff loop, scheduler, or capacity queue. Multi-generation resume/retry has not been
   exercised against real Docker/bubblewrap/Seatbelt providers.
4. **Mission model.** ADR-0017 is blocked on a sourced field model; do not invent a sixth
   entity or merge Mission into Organizational Containers.
5. **Secret broker.** Provider credentials must be brokered to authorized adapters only;
   never in prompts, logs, entities, or agent-visible state.
6. **Capability mediation (ADR-0012 Proposed).** Capability/provider contracts, discovery,
   health, selection, versioning, adapter lifecycle, audit. Requesters must not choose
   arbitrary providers.
7. **Founder Intelligence quality.** Per-note vault authorization (currently
   collection-level), retrieval/context assembly, contradiction detection, human-reviewed
   Memory writes. Never bulk-migrate vault notes.
8. **Gmail/Notion/Obsidian++.** OAuth/token lifecycle, secure storage, scopes, health,
   pagination, rate limits, retries, idempotency, integration tests.
9. **Founder experience.** No UI; the HTTP API is the only surface and it intentionally
   rejects every `Origin`.
10. **Operations.** Metrics/tracing/alerting, journal compaction and migrations, automated
    backup/restore drill, threat model, incident response, deployment docs, SLOs.

## Architectural decisions made this session

- Fixed `local.exec` is the only execution capability; provider/image/verifier selection is
  host-owned (ADR-0019).
- A missing isolation provider is a supported 503 state, never a signal to use bare `spawn`.
- One command may complete at most one declared Action.
- Evidence is bounded and hashed; untrusted output is not copied into the journal.
- Cancellation is an exact authorized action, not an owner/role bypass (ADR-0021).
- Cancellation is terminal in the execution ledger; the canonical lifecycle has no
  `cancelled` state, and an active Task moves to `suspended`.
- Concurrency beyond the cap is rejected, not queued; default 1, maximum 32.
- Restart recovery marks interrupted work and suspends it; it never re-executes or completes.
- Resume and retry are distinct exact actions over append-only attempts; a cancelled attempt
  is never reopened, and a Workflow resume never silently retries a failed sibling (ADR-0022).
- A resumed/retried attempt re-enters the same concurrency cap, and startup still never
  re-drives work; a lease expiry remains an interrupted attempt requiring explicit authority.
- Attempt chains are not capped at two; every generation links to its immediate predecessor,
  repeated reconciliation is a no-op, and concurrent duplicate redrives return 409 without
  appending a second attempt or starting a second sandbox.
- Mission and infrastructure remain proposed because the field-level models are unsourced.
- `@aios/*` packages remain private; no npm publication (ADR-0020).
- Operational state is the journal; Founder Intelligence remains in Obsidian (ADR-0014).

## Next concrete work

1. Observe CI on `a816fe3` and the docs tip; push only
   `upstream community/open-source-foundation`.
2. Test Docker and bubblewrap cancellation on machines where they are available, including
   the explicit container-kill path.
3. Add verifier key provenance and a secret broker before claiming production execution
   security.
4. Exercise multi-generation resume/retry against real sandbox providers, including repeated
   crashes, cancelling generation 2, and workspace reuse across generations.
5. Source and review ADR-0017's Mission fields before adding any Mission API/schema.
