# ADR-0040 — Durable Plan Progress, Crash Reconciliation, and Permanent Dispatch-Key Binding

## Status

**Accepted** (2026-11-14). This ADR extends ADR-0015's operational journal and ADR-0021/0022's
execution lifecycle with durable plan-step progress and restart reconciliation. It does not
add a second ledger, a second sandbox, an automatic executor, or a new completion path. It
amends ADR-0021's assumption that a crash after executor success leaves only a `completed`
execution to inspect, and ADR-0022's recovery consequence by adding a non-verifiable
"uncommitted" tombstone. ADR-0039's fixed-plan scope is unchanged.

## Context

ADR-0039 added bounded `local_plan` execution, but the durable execution record only changed
state before and after the whole plan. If the host crashed after step 1, the journal could
not prove which step had completed. The workspace manager tracked directories only in memory,
so a later boot had no inventory of artifacts left by a killed plan. The process helper kills
its whole process group on cancellation and timeout, but a `SIGKILL` of the host leaves no
live abort handler.

The existing startup reconciliation marked every `running` execution `interrupted` and
suspended its work. That is correct for an in-flight attempt, but it had two gaps:

- it did not distinguish a step that was actually observed complete from one that was merely
  started;
- a completed executor attempt whose verifier/terminal commit did not finish remained
  `completed` in the ledger and could later be presented to the verifier as work that had
  been completed in a committed Task.

Finally, dispatch idempotency keys were only replayed for `completed` runs. Reusing the same
key after an interrupted or failed run created a second run for the same request, which
violates the intent of an idempotency key.

## Decision

### 1. Plan steps are records in the existing execution journal

`ExecutionLedger.beginStep()` appends an `execution_step` record before the provider is
invoked. `completeStep()` appends the host's observed result only after the command returns
successfully; `failStep()` records a stable failure classification without copying output or
exception prose. A plan cannot skip a step, start out of order, start after an incomplete
predecessor, change its step count, or complete a step twice.

The existing operational journal is the only ledger. Step, process and recovery records are
replayed through validated restore methods and are included in ADR-0025 snapshots. A
compacted journal therefore preserves the exact step history, not just the parent attempt.

### 2. Startup reconciliation never upgrades progress

Before marking an attempt interrupted, startup:

1. reaps recorded process groups whose PID identity still matches;
2. inventories orphaned per-Task workspaces, hashing a bounded manifest of their entries and
   artifact bytes before the manifest is journaled; removal follows only after that append;
3. marks every `started` step `interrupted` with `reason_code:host_restarted`; completed steps
   remain completed and immutable;
4. transitions the attempt to `interrupted` with explicit `interruption_reason:host_restarted`
   evidence and the completed/total step counts.

A second reconciliation pass over the same durable state writes nothing. Recovery never
starts a step, calls an executor, verifies a result, or promotes a step to completed.

### 3. Completed-but-uncommitted attempts get a recovery tombstone

An execution record's `completed` state means the executor returned successfully; it does not
mean the Task reached a terminal committed state. At startup, the latest `completed` attempt
for a Task that is not `completed` or `archived` receives one `execution_recovery` record:

- `outcome: "interrupted"`;
- `reason_code: "host_restarted_before_terminal_commit"`;
- bounded evidence naming the observed Task lifecycle and step counts.

The immutable `completed` attempt is not rewritten. The tombstone makes it non-verifiable:
`LocalCommandVerifier` rejects it before running a command, and the attempt-history API
exposes the recovery reason. A deliberate, authorized `retry` appends a new linked attempt;
`resume` remains reserved for a running attempt reconciled to `interrupted`. No automatic
retry or completion occurs.

### 4. Process groups and workspaces are recovered, not guessed

The provider interface accepts an optional `onProcessGroup` callback. The executor persists
the detached leader PID and, on Linux, a `boot_id:starttime` identity immediately after spawn.
Startup sends `SIGKILL` to the recorded group only when the current `/proc/<pid>/stat`
identity still matches; a reused PID, a missing identity, or a gone group is recorded and is
never signalled. Providers that cannot expose a process group leave the callback unset and
retain their existing abort cleanup; this ADR does not claim container-specific reaping for
Docker or gVisor.

Before deletion, the workspace manager hashes relative paths, metadata, and bounded file
bytes into one manifest digest. The digest, entry count, byte count, Task ID and a
pending-removal flag are journaled in a `recovery_summary` record **before** any rmSync.
Only after that append succeeds are the inventoried directories removed, and a second
summary records the actual removal outcome. A journal failure therefore leaves the
directories in place. Unrelated entries in the workspace root are never touched; symlinks
are not followed; an inventory beyond the entry bound fails closed rather than deleting
unreviewed state.

### 5. Dispatch keys are permanently bound to their first run

For one Workflow, an idempotency key is bound to the first dispatch run it creates:

- a `completed` run with the same key is replayed without executing anything;
- a `running`, `failed`, `interrupted`, or `cancelled` run with the same key is an explicit
  conflict, never a second run;
- a new dispatch uses a new key; a redrive uses the authorized Task/Workflow resume/retry
  path and appends to the execution attempt chain.

This closes duplicate dispatch runs and duplicate verified results for a repeated request. It
does not make the HTTP dispatch itself a transaction; the existing lease and kernel idempotency
rules still apply.

### 6. Journal integrity remains fail-closed

ADR-0015 already verifies every record's sequence and SHA-256 chain on open. This ADR keeps
that rule and adds step/process/recovery records to the verified chain. A complete but torn or
tampered record fails closed. An **unterminated final line** is still an uncommitted write and
is discarded on open; it is not a committed record, and the recovery path never treats its
partial payload as evidence.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep one `running` record per plan and infer progress from workspace files | File names are not durable step authority; a crash could leave an ambiguous or attacker-influenced workspace with no ordered observation. |
| Add a second plan-progress ledger | Duplicates ADR-0015/0021 state and breaks cancellation, compaction and replay invariants. |
| Rewrite the completed attempt to `interrupted` | Violates the append-only terminal-record rule and destroys the distinction between executor success and Task commit. |
| Auto-resume a plan from the last completed step | Startup execution is exactly what ADR-0021/0022 forbid; workspace reuse after a crash also needs a separate product decision. |
| Reuse an idempotency key after failure to "retry" the dispatch | Hides the first outcome and can create two runs for one request; redrive already has explicit authorization. |
| Kill a recorded PID without an identity check | PID reuse could kill an unrelated host process. Fail-closed inspection is safer than a guessed cleanup. |
| Delete all workspace directories on startup | The workspace root may contain operator files; only host-generated task directories are touched and only after a manifest is captured. |

## Consequences

- A plan now has durable, ordered progress evidence; a crash cannot make an unobserved step
  look completed.
- Recovery is deterministic and idempotent: running attempts become `interrupted`, completed
  but uncommitted attempts get a tombstone, affected Tasks/Workflows are suspended, and no
  work is re-executed automatically.
- Operators can inspect the interruption reason in attempt history and health counters.
- Workspace artifacts are deleted after their manifest is recorded; the manifest is evidence
  of what existed, not a recoverable copy of the files. A future feature that resumes from a
  partial workspace needs a separate ADR and an authorization/verification design.
- Process-group reaping is only as strong as the provider's process model and the Linux
  `/proc` identity. Docker/gVisor container cleanup after a hard host crash remains a
  provider-specific residual; their normal abort paths are unchanged.
- Journal volume grows by two records per plan step plus process/recovery records. Compaction
  carries them, and the existing 64 MiB fail-closed limit still applies.
- A completed executor attempt that never reached Task commit is now explicitly non-verifiable.
  This is stricter than ADR-0022's prior consequence and prevents later acceptance of an
  uncommitted result.

## Tests / evidence

- `apps/host/tests/plan-recovery.test.ts` SIGKILLs a real separate harness process at four
  boundaries: after step 1 commits and before step 2 starts, mid-step with a live child,
  after executor completion and before verification, and after verifier acceptance and before
  terminal evidence/Task commit. Each test reopens a fresh store/kernel composition from the
  same directory and asserts no step replay, no double execution, non-successful recovery,
  intact hash-chain evidence, process-group death, workspace manifest/removal, idempotent
  second reconciliation, and a linked retry/resume attempt.
- The same file tamperers a committed `execution_step` record after a crash and requires the
  reopened store to reject the hash chain.
- `apps/host/tests/persistence.test.ts` covers a permanent idempotency-key conflict, the
  second-pass no-write reconciliation, and a complete-but-torn record failing closed.
- `apps/host/tests/http-host.test.ts` covers a completed-but-uncommitted attempt recovered on
  restart, suspended Task/Workflow state, and the recovery reason in attempt history.
- `apps/host/tests/evidence-binding.test.ts` proves an uncommitted tombstoned attempt is
  rejected before a verification command runs.
- Existing host, integration, conformance, schema and security checks remain the regression
  gate; no existing assertion was weakened.
