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

### 5. Failure and idempotency

If a resumed/retried execution fails, the new attempt is recorded `failed`, active work is
suspended, and the Workflow is suspended. The previous attempt remains terminal. A later
authorized retry creates another distinct attempt.

Repeating a resume/retry after the Task is completed, or after a Workflow is completed,
returns a 200 idempotent result with `resumed: false` or `retried: false`; it does not create
another attempt. Repeating while an attempt is active returns a conflict.

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
- startup with interrupted work performs reconciliation only and starts no sandbox;
- cancellation of a resumed attempt still reaches the provider and cannot be overwritten by
  a late result.

Where Docker/bubblewrap/Seatbelt are unavailable, the test-only sandbox/process doubles from
ADR-0021 are used and labelled as non-isolating. Real-provider integration remains unproven.
