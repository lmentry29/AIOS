# ADR-0022 — Deliberate Resume and Retry of Interrupted or Failed Work

## Status

**Accepted** (2026-11-10). This ADR amends ADR-0021's consequence that a retry requires a
new Task/Workflow. It does not change ADR-0013's default-deny evaluator, ADR-0015's
append-only journal, ADR-0019's fixed local execution/verifier contract, or ADR-0021's
process termination and concurrency rules.

## Context

ADR-0021 made crash recovery stop work safely: running executions become `interrupted`,
affected Workflows/Tasks become `suspended`, and startup never re-executes them. It also
made cancellation and failure terminal for an *execution* and recorded one execution per
Task. Operators could only recover by creating a new Task or Workflow.

That is safe but operationally incomplete. A founder whose host crashed mid-Task, whose
sandbox failed, or who deliberately cancelled an active Task needs a reviewed, authorized
way to drive the same work again. Automatically re-running on startup would defeat the
recovery guarantee; silently treating a cancelled record as running would destroy the audit
history. The re-drive must therefore be explicit, authorized, and append-only.

## Decision

### 1. Resume units and canonical lifecycle

The resume units are **both Workflow and Task**:

- a suspended Workflow resumes as a unit, in its declared step order;
- a suspended Task can be resumed (`interrupted`) or retried (`failed`, `cancelled`, or an
  unverified `completed` execution) on its own.

No lifecycle state is added. The existing graph is used:

- Workflow: `suspended → active → completed` (or `suspended` again on failure);
- Task: `suspended → active → completed` (or `suspended` again on failure).

A Workflow that is already `completed` makes a repeated resume an idempotent no-op. A
Task that is already `completed` makes a repeated resume/retry an idempotent no-op. An
`active`/`monitored` Workflow or Task is a conflict, not a second execution.

### 2. Attempts are append-only; terminal records never change

Every execution attempt has its own `execution_id`. The ledger adds:

- `attempt` — monotonically increasing per Task, starting at 1;
- `attempt_kind` — `initial`, `resume`, or `retry`;
- `previous_execution_id` — required for `resume`/`retry`, absent for `initial`.

The previous terminal record remains immutable and is never rewritten, cleared, or reused.
The latest attempt is the one the Task's execution control observes. `resume` is valid only
when the latest attempt is `interrupted`; `retry` is valid only when it is `failed`,
`cancelled`, or `completed` without verified Task completion. A running attempt cannot be
resumed or retried. A cancelled record can never be resumed; a retry creates a distinct
attempt, so the cancellation remains visible forever.

Attempt numbers are not bounded at two. A `resume` attempt can itself be interrupted by a
later crash and resumed again; every successor links to its immediate predecessor, never
directly to the initial attempt, and `listForTask()` returns the whole chain oldest-first.
Journal replay rejects a successor appended while its predecessor is still `running`, rejects
`resume` after anything but `interrupted`, and rejects `retry` after anything but `failed`,
`cancelled`, or `completed`; an ambiguous chain fails closed rather than being guessed at.

### 3. Authorization

Two new exact `AccessAction` values are added: `resume` and `retry`.

- `POST /v1/workflows/:id/resume` requires `resume` on the Workflow, and `resume` on every
  interrupted Task it will re-drive, plus `execute` for each assigned Agent.
- `POST /v1/tasks/:id/resume` requires `resume` on the Task and `execute` for its Agent.
- `POST /v1/tasks/:id/retry` requires `retry` on the Task and `execute` for its Agent.

Authorization happens before resource lookup or any mutation, matching the cancel path. The
kernel re-evaluates the same exact actions with the authenticated actor; no owner, role,
wildcard, or “resume implies retry” shortcut exists. A resume is not a retry of a cancel.

Workflow resume is deliberately conservative about blocked siblings:

- completed Tasks are skipped;
- interrupted Tasks are resumed with new attempts;
- `created` remaining Tasks are executed normally;
- a Task whose latest attempt is `failed`, `cancelled`, or unverified `completed` blocks the
  whole Workflow resume with a typed conflict. The caller must explicitly retry that Task and
  then resume the Workflow. A Workflow resume never silently retries a Task.

Task-level resume/retry executes only that Task and leaves its Workflow lifecycle unchanged
(normally `suspended`). A later Workflow resume skips the completed Task and continues the
remaining steps.

### 4. Capacity and restart behavior

Resumed work goes through the same `ManagedExecutionPort`, the same
`execution.max_concurrent_tasks` gate (1–32, default 1), and the same typed
`ExecutionCapacityError`/HTTP 429 before lifecycle writes. There is no queue and no bypass.

Startup reconciliation remains exactly ADR-0021: it marks records interrupted and suspends
work. It never calls resume/retry, never starts a sandbox, and remains a no-op once records
are terminal. A second start cannot re-drive anything without an authorized request.

Reconciliation is also idempotent over a multi-generation chain. If the latest attempt is
already `interrupted` by an earlier resume, startup transitions nothing and creates no new
attempt; a second reconciliation pass over the same durable state writes nothing. Only a
`running` attempt is transitioned, so recovery never manufactures or re-drives an attempt.

### 5. Failure and idempotency

If a resumed/retried execution fails, the new attempt is recorded `failed`, active work is
suspended, and the Workflow is suspended. The previous attempt remains terminal. A later
authorized retry creates another distinct attempt.

Repeating a resume/retry after the Task is completed, or after a Workflow is completed,
returns a 200 idempotent result with `resumed: false` or `retried: false`; it does not create
another attempt.

A duplicate resume/retry that arrives while another redrive of the same Workflow or Task is
still in flight returns a typed **409 `execution_conflict`**
(`ExecutionAttemptConflictError`) without waiting. It never appends a second attempt and never
starts a second sandbox. The contract is deliberately non-blocking: waiting would turn a
duplicate HTTP request into a queue, hide the conflict from the caller, and risk a request
timeout whose outcome the caller cannot distinguish from a lost write. Once the first redrive
finishes, a new request is either the 200 idempotent no-op above (completed) or a new
authorized operation (failed or interrupted again), not a duplicate.

The guarantee has two independent layers. The kernel holds an in-process claim for the
Workflow and every Task it will touch, checked and acquired atomically before the first
lifecycle or attempt write; a second request that overlaps any claimed resource is rejected.
The durable ledger independently refuses `resume`/`retry` unless the latest attempt is
terminal in the required state, so even a direct concurrent call cannot append a successor
from a `running` predecessor. The host is single-process by ADR-0015; cross-process redrives
are not supported.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Reopen an interrupted/cancelled record in place | Destroys the audit history and makes the terminal-state rule meaningless. A new attempt is the only append-only representation. |
| Automatically resume on startup | Reintroduces the crash-loop and “startup executes work” failure ADR-0021 exists to prevent. |
| Let Workflow resume silently retry failed/cancelled Tasks | Bypasses the distinct Task `retry` grant and obscures the difference between a crash and a deliberate retry. |
| Add a `resumed` or `retrying` lifecycle state | Not in ADR-0003; execution attempts already carry the distinction. `suspended → active` is sufficient. |
| Queue resumed work when the cap is full | Same unbounded fan-out concern as ADR-0021; reject with 429 and let the caller retry. |
| Require a brand-new Task entity for every retry | Safer in isolation but operationally unusable for a long-running Workflow; append-only attempts preserve the same audit guarantee without duplicating the Task. |

## Consequences

- A Task can now have an ordered history of multiple attempts. Readers that need the current
  state use the latest attempt; audit readers can see every terminal predecessor.
- A chain may contain more than two attempts. Each attempt's predecessor is the immediately
  preceding attempt, and all earlier records remain immutable as later generations append.
- Concurrent duplicate redrives fail closed with a typed 409; they do not queue and do not
  produce a parallel attempt or sandbox. Retrying after the first redrive has failed is a
  new, separately authorized operation, not a duplicate of the first request.
- Cancellation is terminal **for that attempt**, not an irreversible erasure of the Task. A
  distinct, `retry`-authorized attempt is the only way to run the same Task again after a
  cancellation; `resume` never reopens it.
- Workflow recovery after a failure may require two explicit operations: retry the blocked
  Task, then resume the Workflow. This is intentional and testable.
- The API does not infer resume from a lease expiry. A lease reclaim remains an interrupted
  run requiring the same explicit authority.
- A crash after executor success but before verification leaves the execution `completed`
  while the Task is `suspended`. Retry is permitted for that state because the result was
  never verified; the old completed execution remains in history.
- There is still no automatic retry, backoff, scheduler, or queue.
- A journal written before ADR-0022 replays its single execution record as attempt 1 /
  `initial`. A non-contiguous or ambiguous multi-record attempt chain fails closed on replay
  rather than being guessed at.

## Tests / evidence

The implementation must prove, over loopback HTTP and the real local executor/verifier
composition where possible:

- crash-interrupted Workflow resume creates a second execution attempt, preserves the
  `interrupted` first attempt, and completes the Workflow;
- a cancelled execution rejects `resume` with a typed conflict, while an explicitly
  authorized `retry` creates a distinct second attempt and preserves the cancelled first
  record;
- retrying a failed execution creates a distinct retry attempt and can then complete the
  Workflow;
- `resume`, `retry`, and `execute` denials each fail before lookup/mutation and leave state
  unchanged;
- a full concurrency cap rejects resume with 429 before lifecycle writes, with no new
  execution attempt; after capacity is released, the same resume succeeds;
- repeated resume/retry after completion is idempotent and creates no third attempt;
- a three-generation `interrupted → resume → interrupted → resume → completed` chain survives
  real persisted restarts with monotonic attempt numbers, correct `attempt_kind` values,
  immediate-predecessor links, and byte-for-byte immutable earlier records;
- restart reconciliation over an already-interrupted resumed attempt marks nothing, creates
  no attempt, and a second pass over the same durable state writes no journal bytes;
- concurrent duplicate Workflow resume, Task resume, and Task retry each return one typed
  409 and produce exactly one appended attempt and one sandbox start;
- the concurrency cap rejects a later-generation resume with 429 before any lifecycle or
  attempt write;
- startup with interrupted work performs reconciliation only and starts no sandbox;
- cancellation of a resumed attempt still reaches the provider and cannot be overwritten by
  a late result; both earlier attempts stay immutable and an explicit retry appends a third
  attempt.

In the verification environment, `docker info` cannot reach a daemon, and `bwrap`, `podman`,
and `sandbox-exec` are absent. Multi-generation resume and retry are therefore proven against
the labelled `stub-container` double composed with the real
`LocalCommandExecutor`/`LocalCommandVerifier`, not against container isolation. A real-runtime
proof still needs to cover container creation and teardown for each generation, cancellation
killing the second-generation container, workspace reuse across attempts, and the same
resource limits on every generation. No real provider or container runtime was exercised.
