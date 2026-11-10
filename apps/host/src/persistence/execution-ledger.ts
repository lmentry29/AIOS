import { createHash, randomUUID } from 'node:crypto';
import { type AppendOnlyJournal, JournalError } from './journal.js';

const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 300;
const MAX_REASON_LENGTH = 120;

export type ExecutionState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ExecutionAttemptKind = 'initial' | 'resume' | 'retry';

export interface ExecutionRecord {
  execution_id: string;
  task_id: string;
  workflow_id?: string;
  agent_id: string;
  /** Monotonically increasing per Task, starting at 1. */
  attempt: number;
  attempt_kind: ExecutionAttemptKind;
  /** Set for `resume`/`retry`; absent for the initial attempt. */
  previous_execution_id?: string;
  state: ExecutionState;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  reason_code?: string;
  evidence: string[];
  revision: number;
}

export interface StartExecutionRequest {
  task_id: string;
  workflow_id?: string;
  agent_id: string;
}

export interface RedriveExecutionRequest extends StartExecutionRequest {
  /** The terminal attempt this resume/retry follows. */
  previous_execution_id: string;
}

export interface CancelExecutionRequest {
  task_id: string;
  workflow_id?: string;
  actor_id: string;
  reason_code: string;
  evidence?: string[];
}

export interface CancelledExecution {
  record: ExecutionRecord;
  /** False when the Task already had a terminal cancellation record. */
  changed: boolean;
}

export class ExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isExecutionState(value: unknown): value is ExecutionState {
  return value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'interrupted';
}

function isAttemptKind(value: unknown): value is ExecutionAttemptKind {
  return value === 'initial' || value === 'resume' || value === 'retry';
}

function assertIdentifier(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ExecutionConflictError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function normalizeEvidence(evidence: readonly string[] | undefined): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new ExecutionConflictError(`Execution evidence must contain at most ${MAX_EVIDENCE_ITEMS} items.`);
  }
  return evidence.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_EVIDENCE_LENGTH
      || item.includes('\n') || item.includes('\r')) {
      throw new ExecutionConflictError('Execution evidence must be bounded, non-empty single-line strings.');
    }
    return item;
  });
}

function normalizeReason(reason: string): string {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new ExecutionConflictError('Execution reason code must be a bounded non-empty string.');
  }
  return reason;
}

/**
 * Reads the attempt identity from a journal record.
 *
 * Records written before ADR-0022 have no attempt fields. They were the only execution
 * record for their Task, so the append-only interpretation is attempt 1 / initial. Any
 * later record for the same Task must then chain from it; ambiguous data is rejected by
 * `restore()` rather than guessed.
 */
function attemptIdentity(value: Record<string, unknown>): {
  attempt: number;
  attempt_kind: ExecutionAttemptKind;
  previous_execution_id?: string;
} {
  if (value.attempt === undefined && value.attempt_kind === undefined && value.previous_execution_id === undefined) {
    return { attempt: 1, attempt_kind: 'initial' };
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new JournalError('Operational journal contains an invalid execution attempt number.');
  }
  if (!isAttemptKind(value.attempt_kind)) {
    throw new JournalError('Operational journal contains an invalid execution attempt kind.');
  }
  if (value.previous_execution_id !== undefined
    && (typeof value.previous_execution_id !== 'string' || value.previous_execution_id.length === 0)) {
    throw new JournalError('Operational journal contains an invalid execution predecessor.');
  }
  if (value.attempt_kind === 'initial') {
    if (value.attempt !== 1 || value.previous_execution_id !== undefined) {
      throw new JournalError('Operational journal contains an initial execution attempt with a predecessor.');
    }
  } else if (value.previous_execution_id === undefined) {
    throw new JournalError('Operational journal contains a resumed or retried attempt without a predecessor.');
  }
  return {
    attempt: value.attempt as number,
    attempt_kind: value.attempt_kind,
    ...(value.previous_execution_id === undefined
      ? {}
      : { previous_execution_id: value.previous_execution_id as string }),
  };
}

function validateExecution(value: unknown): ExecutionRecord {
  if (!isRecord(value)
    || typeof value.execution_id !== 'string' || value.execution_id.length === 0
    || typeof value.task_id !== 'string' || value.task_id.length === 0
    || !(value.workflow_id === undefined || (typeof value.workflow_id === 'string' && value.workflow_id.length > 0))
    || typeof value.agent_id !== 'string' || value.agent_id.length === 0
    || !isExecutionState(value.state)
    || !isIsoTimestamp(value.started_at)
    || !isIsoTimestamp(value.updated_at)
    || !(value.finished_at === undefined || isIsoTimestamp(value.finished_at))
    || !(value.reason_code === undefined || (typeof value.reason_code === 'string'
      && value.reason_code.length > 0 && value.reason_code.length <= MAX_REASON_LENGTH))
    || !Array.isArray(value.evidence)
    || value.evidence.length > MAX_EVIDENCE_ITEMS
    || value.evidence.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_EVIDENCE_LENGTH)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new JournalError('Operational journal contains an invalid execution record.');
  }
  return structuredClone({
    ...value,
    ...attemptIdentity(value),
  } as unknown as ExecutionRecord);
}

function terminal(state: ExecutionState): boolean {
  return state !== 'running';
}

/**
 * Durable execution lifecycle for Tasks, independent of the dispatch-run ledger.
 *
 * A dispatch run describes one Workflow dispatch and its lease. An execution record
 * describes one Task's sandboxed work. They are separate because cancellation and crash
 * recovery need to know whether a *Task* was running, not merely whether an HTTP dispatch
 * was in progress.
 *
 * ADR-0022 makes the ledger an append-only *chain of attempts* per Task. A Task keeps one
 * immutable terminal record per attempt; `resume` (interrupted) and `retry` (failed,
 * cancelled, or unverified completed) append a new attempt with its own `execution_id` and
 * a `previous_execution_id`. A cancelled attempt is never reopened or rewritten. Readers
 * observe the latest attempt; audit readers can walk every predecessor.
 *
 * Evidence is bounded and generated by the host; task output and exception messages are
 * never copied into it. `reason_code` is a stable classification, not free-form prose.
 */
export class ExecutionLedger {
  private readonly records = new Map<string, ExecutionRecord>();
  /** Ordered attempt IDs per Task. The last entry is the latest attempt. */
  private readonly byTask = new Map<string, string[]>();

  constructor(private readonly journal: AppendOnlyJournal) {}

  start(request: StartExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const taskId = assertIdentifier(request.task_id, 'Execution Task ID');
    if ((this.byTask.get(taskId)?.length ?? 0) > 0) {
      throw new ExecutionConflictError('This Task already has a durable execution record; use resume or retry.');
    }
    return this.append(request, 'initial', undefined, now);
  }

  /** Appends a new attempt after the latest `interrupted` record. */
  resume(request: RedriveExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const latest = this.requireLatest(request.task_id);
    if (latest.state === 'cancelled') {
      throw new ExecutionConflictError('A cancelled execution cannot be resumed; request an authorized retry instead.');
    }
    if (latest.state !== 'interrupted') {
      throw new ExecutionConflictError(`Only an interrupted execution can be resumed; the latest attempt is "${latest.state}".`);
    }
    if (latest.execution_id !== request.previous_execution_id) {
      throw new ExecutionConflictError('The referenced execution is not the latest attempt for this Task.');
    }
    return this.append(request, 'resume', latest, now);
  }

  /**
   * Appends a new attempt after a terminal failure, cancellation, or unverified completion.
   * The cancelled record remains in the ledger forever; this never reopens it.
   */
  retry(request: RedriveExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const latest = this.requireLatest(request.task_id);
    if (latest.state === 'running') {
      throw new ExecutionConflictError('A running execution cannot be retried.');
    }
    if (latest.state === 'interrupted') {
      throw new ExecutionConflictError('An interrupted execution must be resumed, not retried.');
    }
    if (latest.execution_id !== request.previous_execution_id) {
      throw new ExecutionConflictError('The referenced execution is not the latest attempt for this Task.');
    }
    return this.append(request, 'retry', latest, now);
  }

  complete(executionId: string, evidence: readonly string[], now: Date = new Date()): ExecutionRecord {
    return this.transition(this.requireRunning(executionId), 'completed', now, 'execution_succeeded', evidence);
  }

  fail(executionId: string, reasonCode: string, evidence: readonly string[] = [], now: Date = new Date()): ExecutionRecord {
    return this.transition(this.requireRunning(executionId), 'failed', now, reasonCode, evidence);
  }

  /**
   * Marks the latest attempt cancelled, whether it is running, queued behind the
   * concurrency gate, or cancelled before dispatch. Returns the existing record unchanged
   * when the latest attempt is already cancelled, making an authorized retry idempotent.
   */
  cancel(request: CancelExecutionRequest, now: Date = new Date()): CancelledExecution {
    const taskId = assertIdentifier(request.task_id, 'Execution Task ID');
    const reason = normalizeReason(request.reason_code);
    const evidence = normalizeEvidence(request.evidence);
    const latest = this.getForTask(taskId);
    if (latest !== undefined) {
      if (latest.state === 'cancelled') return { record: latest, changed: false };
      if (terminal(latest.state)) {
        throw new ExecutionConflictError(`Execution is already terminal in state "${latest.state}".`);
      }
      return {
        record: this.transition(latest, 'cancelled', now, reason, evidence),
        changed: true,
      };
    }

    const timestamp = now.toISOString();
    const record: ExecutionRecord = {
      execution_id: randomUUID(),
      task_id: taskId,
      ...(request.workflow_id === undefined
        ? {}
        : { workflow_id: assertIdentifier(request.workflow_id, 'Execution Workflow ID') }),
      agent_id: `host-cancel:${assertIdentifier(request.actor_id, 'Cancellation actor', 160)}`,
      attempt: 1,
      attempt_kind: 'initial',
      state: 'cancelled',
      started_at: timestamp,
      updated_at: timestamp,
      finished_at: timestamp,
      reason_code: reason,
      evidence,
      revision: 1,
    };
    this.persist(record);
    return { record: structuredClone(record), changed: true };
  }

  get(executionId: string): ExecutionRecord | undefined {
    const record = this.records.get(executionId);
    return record ? structuredClone(record) : undefined;
  }

  /** The latest attempt, which is what execution control observes. */
  getForTask(taskId: string): ExecutionRecord | undefined {
    const executionId = this.byTask.get(taskId)?.at(-1);
    return executionId === undefined ? undefined : this.get(executionId);
  }

  /** Every attempt for a Task, oldest first. Terminal predecessors stay readable. */
  listForTask(taskId: string): ExecutionRecord[] {
    return (this.byTask.get(taskId) ?? [])
      .map((executionId) => this.get(executionId))
      .filter((record): record is ExecutionRecord => record !== undefined);
  }

  isCancelled(taskId: string): boolean {
    return this.getForTask(taskId)?.state === 'cancelled';
  }

  list(): ExecutionRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /**
   * Startup reconciliation: a `running` record from a previous process cannot still be
   * executing. It becomes `interrupted`, never `completed`, exactly once. The caller uses
   * the returned Task/Workflow references to suspend their canonical lifecycle state.
   */
  reconcile(now: Date = new Date()): ExecutionRecord[] {
    const interrupted: ExecutionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'running') continue;
      interrupted.push(this.transition(
        record,
        'interrupted',
        now,
        'host_restarted',
        [`recovered_at:${now.toISOString()}`],
      ));
    }
    return interrupted;
  }

  /**
   * Journal replay only. Validates per-attempt monotonicity and a contiguous, correctly
   * linked attempt chain per Task. It never invents completion.
   */
  restore(value: unknown): void {
    const record = validateExecution(value);
    const current = this.records.get(record.execution_id);
    if (current) {
      if (record.revision <= current.revision) {
        throw new JournalError('Operational journal contains a non-monotonic execution record.');
      }
      if (terminal(current.state)) {
        throw new JournalError('Operational journal contains a transition out of a terminal execution state.');
      }
      if (current.task_id !== record.task_id
        || current.attempt !== record.attempt
        || current.attempt_kind !== record.attempt_kind
        || current.previous_execution_id !== record.previous_execution_id) {
        throw new JournalError('Operational journal changed an execution attempt identity.');
      }
      this.records.set(record.execution_id, record);
      return;
    }

    const attempts = this.byTask.get(record.task_id) ?? [];
    const previousId = attempts.at(-1);
    if (record.attempt !== attempts.length + 1) {
      throw new JournalError('Operational journal contains a non-contiguous execution attempt sequence.');
    }
    if (record.attempt_kind === 'initial') {
      if (attempts.length !== 0 || record.previous_execution_id !== undefined) {
        throw new JournalError('Operational journal contains an initial execution attempt with a predecessor.');
      }
    } else if (previousId === undefined || record.previous_execution_id !== previousId) {
      throw new JournalError('Operational journal contains a resumed or retried attempt with a mismatched predecessor.');
    }
    this.records.set(record.execution_id, record);
    this.byTask.set(record.task_id, [...attempts, record.execution_id]);
  }

  private append(
    request: StartExecutionRequest,
    attemptKind: ExecutionAttemptKind,
    previous: ExecutionRecord | undefined,
    now: Date,
  ): ExecutionRecord {
    const taskId = assertIdentifier(request.task_id, 'Execution Task ID');
    const agentId = assertIdentifier(request.agent_id, 'Execution Agent ID');
    const timestamp = now.toISOString();
    const record: ExecutionRecord = {
      execution_id: randomUUID(),
      task_id: taskId,
      ...(request.workflow_id === undefined
        ? {}
        : { workflow_id: assertIdentifier(request.workflow_id, 'Execution Workflow ID') }),
      agent_id: agentId,
      attempt: previous === undefined ? 1 : previous.attempt + 1,
      attempt_kind: attemptKind,
      ...(previous === undefined ? {} : { previous_execution_id: previous.execution_id }),
      state: 'running',
      started_at: timestamp,
      updated_at: timestamp,
      evidence: [],
      revision: 1,
    };
    this.persist(record);
    return structuredClone(record);
  }

  private requireLatest(taskId: string): ExecutionRecord {
    const task = assertIdentifier(taskId, 'Execution Task ID');
    const latest = this.getForTask(task);
    if (!latest) throw new ExecutionConflictError('This Task has no execution attempt to resume or retry.');
    return latest;
  }

  private requireRunning(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) throw new ExecutionConflictError('Execution record was not found.');
    if (record.state !== 'running') throw new ExecutionConflictError('Execution is no longer running.');
    return record;
  }

  private transition(
    record: ExecutionRecord,
    state: ExecutionState,
    now: Date,
    reasonCode: string,
    evidence: readonly string[],
  ): ExecutionRecord {
    const updated: ExecutionRecord = {
      ...record,
      state,
      updated_at: now.toISOString(),
      ...(terminal(state) ? { finished_at: now.toISOString() } : {}),
      reason_code: normalizeReason(reasonCode),
      evidence: [
        ...record.evidence,
        ...normalizeEvidence(evidence),
      ].slice(-MAX_EVIDENCE_ITEMS),
      revision: record.revision + 1,
    };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(record: ExecutionRecord): void {
    this.journal.append('execution', record);
    this.records.set(record.execution_id, record);
    const attempts = this.byTask.get(record.task_id) ?? [];
    if (attempts.at(-1) !== record.execution_id) attempts.push(record.execution_id);
    this.byTask.set(record.task_id, attempts);
  }
}

/** Stable, non-secret digest for a host-generated evidence value. */
export function evidenceDigest(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(serialized ?? 'undefined').digest('hex');
}
