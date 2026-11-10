# ADR-0021 — Task Execution Cancellation, Concurrency, and Restart Reconciliation

## Status

**Accepted** (2026-11-10). This ADR extends the execution lifecycle implemented under
ADR-0015 and ADR-0019. It does not change ADR-0013 authorization semantics, ADR-0014
Founder Intelligence persistence, or ADR-0016's host/UI boundary.

## Context

ADR-0019 established fixed `local.exec`, fail-closed sandbox providers, bounded/hashed
evidence, and an independently executed verifier. ADR-0015 established the hash-chained
operational journal and recovery-to-suspended for dispatch runs. Three lifecycle gaps
remained:

- there was no way to cancel a Task once dispatched;
- Task execution had no configured concurrency bound; and
- startup recovery understood dispatch runs but not the per-Task sandbox execution, so a
  crash could leave a Task's execution unaccounted for even when its run was interrupted.

Marking a record as cancelled is not cancellation. A Task may only be called cancelled when
the host has attempted to terminate the actual sandboxed work, verification is not started
when cancellation is observed before it begins, and a late executor result cannot later
re-mark the Task complete.

## Decision

### 1. One durable execution ledger per Task

The host journals an `execution` record before invoking the executor. It is separate from
the dispatch `run` record: a run describes one Workflow dispatch and its lease; an execution
describes one Task's sandboxed work. Its states are:

`running → completed | failed | cancelled | interrupted`

Terminal records are immutable and are never rewritten. Each transition appends a new
revision. Evidence is a bounded list of host-generated single-line strings (at most eight,
each at most 300 characters); executor output and exception messages are represented by
SHA-256 digests, never copied into the journal. `reason_code` is a bounded classification,
not prose.

`completed` here means the executor's sandbox invocation completed successfully. It does not
mean the Task passed independent verification. The kernel still owns Task completion and
runs the verifier afterward.

### 2. Authorized cancellation

`cancel` is an exact `AccessAction`, evaluated by the same `AuthorizationService` and
resource-attached default-deny policy as intake, dispatch, execute, and reads. There is no
owner, role, or host bypass. The route is:

`POST /v1/tasks/:taskId/cancel` with optional `{ "reason": "..." }`

Authorization happens before revealing whether the Task exists. A caller without a matching
`cancel` allow receives 403; no ledger record is written. The route accepts a queued
(`created`) Task or an actively executing Task:

- A queued Task receives a terminal cancelled execution record but remains in the canonical
  `created` lifecycle state. A later dispatch is rejected by the kernel's cancellation
  preflight, so it can never execute.
- An active Task is transitioned to `suspended`, the nearest canonical lifecycle state.
  **No `cancelled` lifecycle state was added.** The execution ledger, not the canonical
  lifecycle enum, is the authority for cancellation.
- A terminal Task returns 409; an already-cancelled execution returns 200 idempotently.

The cancellation record is committed before the abort. This ordering is deliberate: the
executor wrapper checks the ledger after the sandbox returns, so a late success cannot
overwrite a cancellation.

### 3. Real process termination

`AbortSignal` is threaded from `LocalCommandExecutor` through the `SandboxProvider`
interface into `runCapturedProcess`. Aborting the active Task's controller sends `SIGKILL`
to the child. Provider-specific behavior:

- Docker receives a unique `--name` and an explicit `docker kill <name>` on abort; killing
  only the Docker CLI would leave the container running.
- Bubblewrap uses `--die-with-parent` and the same child abort.
- Seatbelt receives the child abort.
- The test-only process provider is labelled `test-only-process`; it uses the production
  process helper but provides **no isolation**. It exists only to prove the child is killed.

If the provider cannot establish a boundary, dispatch still fails closed. Aborting a test
double is not evidence of container isolation.

### 4. Verification and late results

The kernel checks the ledger cancellation view:

1. during dispatch preflight, before any lifecycle write;
2. before execution;
3. after execution, before verification;
4. after verification, before evidence and completion; and
5. immediately before evidence/lifecycle writes.

If cancellation is observed before verification starts, the verifier is not called. If it
arrives while verification is already running, the verifier may finish, but the execution
cannot be marked complete and the Task remains suspended. A cancellation that wins the
terminal ledger transition cannot be undone by a later executor result.

### 5. Bounded concurrency without silent fan-out

Host configuration adds `execution.max_concurrent_tasks`: an integer from 1 to 32, default
1. It is validated at startup; unknown fields, zero, negative, fractional, out-of-range, and
non-numeric values are rejected.

The chosen policy is **non-blocking deterministic rejection**. A Task beyond the cap is
rejected with `ExecutionCapacityError` before the kernel's first lifecycle write and is
returned as HTTP 429 `execution_capacity_exceeded`. It is not queued and it does not run.
The Workflow remains `created` and can be retried after capacity is available (with a new
idempotency key if the rejected attempt's key was journaled). Tests prove the rejected
Workflow and Task stay `created`, no sandbox call occurs, and a later retry succeeds.

There remains a small race between the preflight capacity check and the executor's slot
acquisition; the executor wrapper enforces the same cap and raises the same typed error. The
observable behavior is stable: no more than the configured number run at once.

### 6. Restart reconciliation

On startup, before serving:

- dispatch runs left `running` by a previous process become `interrupted`;
- execution records left `running` become `interrupted` with `reason_code:
  host_restarted` and bounded recovery evidence; and
- affected Workflows and active/monitored Tasks become `suspended` under the fixed host
  recovery actor.

Recovery never re-executes work and never invents completion. It writes one terminal record
per interrupted execution. A second fresh start sees terminal records and makes no further
transition, so side effects are not duplicated. Reconciliation is a host-internal startup
operation, not a caller-reachable route; cancellation remains the only caller-triggered
execution-state change and uses the shared evaluator.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Add `cancelled` to the canonical lifecycle enum | ADR-0003 defines the shared lifecycle; cancellation is execution state, not a new entity lifecycle. Use `suspended` for active Tasks and the ledger for the terminal outcome. |
| Mark the run cancelled without killing the process | Fake cancellation; the sandbox would continue consuming resources and could mutate the workspace. |
| Let a late result call `complete()` | Violates "a cancelled execution can never be re-marked complete"; terminal ledger transitions are append-only. |
| Queue beyond the cap | Deterministic rejection keeps Workflows retryable and avoids an unbounded host-side queue; the cap is a resource bound, not a scheduler. |
| Treat startup recovery as authorization | Authorization is caller-scoped. Recovery is host-internal and uses a fixed system actor; giving it a caller identity would fabricate one. |
| Test cancellation only with a stub | The suite also exercises the production process helper against a real child and asserts its PID dies. The stub remains explicitly non-isolating. |

## Consequences

- Cancelling a Task is terminal for that execution. A retry requires a new Task/Workflow;
  there is no resume or automatic retry. This is deliberate until a resume operation has its
  own ADR and evidence model.
- A queued Task remains `created` after cancellation; readers must consult the execution
  ledger to see that it will not execute. The API has no dedicated Task-cancel state.
- The default cap is 1. Operators must explicitly raise it; no host silently fans out.
- Docker container termination is implemented with a named-container kill but is **not**
  integration-tested here because the Docker daemon is unavailable. Bubblewrap and Seatbelt
  are likewise unverified on this host. The real child-process SIGKILL test uses the
  production process helper and a test-only provider, not a production isolation boundary.
- The execution ledger is not compacted separately; it shares the ADR-0015 journal and its
  64 MiB fail-closed limit.
- A crash after executor success but before verification leaves an `interrupted` run,
  a `completed` execution, and a suspended Task/Workflow. The work is not re-run and is not
  claimed as verified.

## Tests / evidence

`apps/host/tests/http-host.test.ts` (21 tests) pins:

- cancellation of an executing Task returns 202, aborts the sandbox stub, records a terminal
  cancelled execution, leaves the Task/Workflow suspended, records the run as cancelled, and
  makes exactly one sandbox call (the verifier is skipped);
- a second cancel is idempotent, the reason is hashed rather than stored, and the shared
  audit chain contains the `cancel` allow;
- a queued Task can be cancelled and its later dispatch is rejected without any sandbox call;
- an intake-only policy denies cancel with 403 and writes no ledger record;
- the concurrent dispatch limit returns 429, starts no second sandbox call, leaves both
  Workflow and Task `created`, and a retry succeeds after the first execution finishes; and
- a journal-level crash with a running run and execution, followed by a fresh host against
  the same journal, yields one `interrupted` execution, suspended work, and a no-op on a
  third start.

`apps/host/tests/execution.test.ts` pins that cancelling the local executor SIGKILLs a real
child process, using a provider explicitly labelled `test-only-process`.

`apps/host/tests/managed-execution.test.ts` pins that a late executor result throws
`TaskCancelledError` and cannot overwrite a terminal cancelled ledger record, and that the
cap rejects before recording a second execution.

`apps/host/tests/config.test.ts` rejects nonsensical `max_concurrent_tasks` values.

All these host tests are local; no real Docker, bubblewrap, or Seatbelt invocation was
exercised, and no GitHub Actions run has been observed for the commit.
