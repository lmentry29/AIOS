import { createHash, randomUUID } from "node:crypto";
import { type AppendOnlyJournal, JournalError } from "./journal.js";

const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 300;
const MAX_REASON_LENGTH = 120;
const MAX_PLAN_STEPS = 8;
const SHA256 = /^[a-f0-9]{64}$/;

export type ExecutionState = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ExecutionAttemptKind = "initial" | "resume" | "retry";
export type ExecutionStepState = "started" | "completed" | "failed" | "interrupted";
export type ProcessReapOutcome =
  | "killed"
  | "already_gone"
  | "identity_mismatch"
  | "identity_unavailable"
  | "kill_failed";

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

/**
 * Durable progress for one `local_plan` step, recorded in the same execution journal.
 * A step is `started` before the provider is invoked and becomes terminal only from the
 * host's own observation of the actual command result. Recovery never upgrades a started
 * step to completed.
 */
export interface ExecutionStepRecord {
  execution_id: string;
  task_id: string;
  /** Zero-based, contiguous within one execution attempt. */
  step_index: number;
  /** Total steps in the immutable Task plan. */
  step_count: number;
  action_id?: string;
  state: ExecutionStepState;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  reason_code?: string;
  argv_sha256: string;
  cwd_sha256?: string;
  provider?: string;
  assurance?: string;
  exit_code?: number | null;
  duration_ms?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  output_truncated?: boolean;
  sandbox_evidence_sha256?: string;
  revision: number;
}

/**
 * A sandbox process group recorded immediately after spawn, so a later host boot can
 * terminate a process tree that outlived a SIGKILLed host. PID identity includes the
 * Linux boot/start-time token and is checked before signalling to avoid killing a reused
 * PID. Providers that cannot expose a process group record the attempt as unsupported.
 */
export interface ExecutionProcessRecord {
  execution_id: string;
  task_id: string;
  step_index: number;
  pid: number;
  process_group: number;
  /** `boot_id:starttime` from `/proc`, when the host can prove PID identity. */
  start_token?: string;
  provider: string;
  recorded_at: string;
  reaped_at?: string;
  reap_outcome?: ProcessReapOutcome;
  revision: number;
}

/**
 * Recovery tombstone for an attempt that reached executor completion but never reached a
 * committed Task state. It does not rewrite the immutable completed record; it makes the
 * attempt non-verifiable and forces a new, linked attempt for any further work.
 */
export interface ExecutionRecoveryRecord {
  execution_id: string;
  task_id: string;
  outcome: "interrupted";
  reason_code: string;
  evidence: string[];
  recorded_at: string;
  revision: 1;
}

export interface WorkspaceRecoveryEvidence {
  task_id: string;
  workspace_sha256: string;
  entries: number;
  bytes: number;
  removed: boolean;
  /** True when the content hash cap was reached; metadata is still fully traversed. */
  truncated?: boolean;
}

export interface ProcessReapSummary {
  killed: number;
  alreadyGone: number;
  identityMismatch: number;
  identityUnavailable: number;
  failed: number;
}

export interface ExecutionReconciliation {
  interrupted: ExecutionRecord[];
  interruptedSteps: ExecutionStepRecord[];
  uncommitted: ExecutionRecoveryRecord[];
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

export interface BeginExecutionStepRequest {
  step_index: number;
  step_count: number;
  action_id?: string;
  argv_sha256: string;
}

export interface CompleteExecutionStepRequest {
  cwd_sha256: string;
  provider: string;
  assurance: string;
  exit_code: number | null;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  output_truncated: boolean;
  /** Digest of the provider's filter/limit/boundary proof, not the proof itself. */
  sandbox_evidence_sha256: string;
}

export interface RecordExecutionProcessRequest {
  step_index: number;
  pid: number;
  process_group: number;
  start_token?: string;
  provider: string;
}

export interface ExecutionReconcileOptions {
  now?: Date;
  /** Current canonical Task lifecycle, used to detect an uncommitted completion. */
  taskLifecycle?: (taskId: string) => string | undefined;
  /** Workspace manifests captured before orphan cleanup. */
  workspaceEvidence?: ReadonlyMap<string, WorkspaceRecoveryEvidence>;
}

/** Late-bound reference used to compose an executor before the runtime ledger exists. */
export interface ExecutionLedgerRef {
  current?: ExecutionLedger;
}

export class ExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isExecutionState(value: unknown): value is ExecutionState {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isAttemptKind(value: unknown): value is ExecutionAttemptKind {
  return value === "initial" || value === "resume" || value === "retry";
}

function assertIdentifier(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ExecutionConflictError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function normalizeEvidence(evidence: readonly string[] | undefined): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new ExecutionConflictError(
      `Execution evidence must contain at most ${MAX_EVIDENCE_ITEMS} items.`,
    );
  }
  return evidence.map((item) => {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > MAX_EVIDENCE_LENGTH ||
      item.includes("\n") ||
      item.includes("\r")
    ) {
      throw new ExecutionConflictError(
        "Execution evidence must be bounded, non-empty single-line strings.",
      );
    }
    return item;
  });
}

function normalizeReason(reason: string): string {
  if (typeof reason !== "string" || reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new ExecutionConflictError("Execution reason code must be a bounded non-empty string.");
  }
  return reason;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ExecutionConflictError(`${label} must be a SHA-256 hex digest.`);
  }
  return value;
}

function isStepState(value: unknown): value is ExecutionStepState {
  return (
    value === "started" || value === "completed" || value === "failed" || value === "interrupted"
  );
}

function validateStep(value: unknown): ExecutionStepRecord {
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    value.execution_id.length === 0 ||
    typeof value.task_id !== "string" ||
    value.task_id.length === 0 ||
    !Number.isSafeInteger(value.step_index) ||
    (value.step_index as number) < 0 ||
    (value.step_index as number) >= MAX_PLAN_STEPS ||
    !Number.isSafeInteger(value.step_count) ||
    (value.step_count as number) < 1 ||
    (value.step_count as number) > MAX_PLAN_STEPS ||
    (value.step_index as number) >= (value.step_count as number) ||
    !(
      value.action_id === undefined ||
      (typeof value.action_id === "string" &&
        value.action_id.length > 0 &&
        value.action_id.length <= 200)
    ) ||
    !isStepState(value.state) ||
    !isIsoTimestamp(value.started_at) ||
    !isIsoTimestamp(value.updated_at) ||
    !(value.finished_at === undefined || isIsoTimestamp(value.finished_at)) ||
    !(
      value.reason_code === undefined ||
      (typeof value.reason_code === "string" &&
        value.reason_code.length > 0 &&
        value.reason_code.length <= MAX_REASON_LENGTH)
    ) ||
    typeof value.argv_sha256 !== "string" ||
    !SHA256.test(value.argv_sha256) ||
    !(
      value.cwd_sha256 === undefined ||
      (typeof value.cwd_sha256 === "string" && SHA256.test(value.cwd_sha256))
    ) ||
    !(
      value.provider === undefined ||
      (typeof value.provider === "string" && value.provider.length <= 80)
    ) ||
    !(
      value.assurance === undefined ||
      (typeof value.assurance === "string" && value.assurance.length <= 80)
    ) ||
    !(
      value.exit_code === undefined ||
      value.exit_code === null ||
      Number.isSafeInteger(value.exit_code)
    ) ||
    !(
      value.duration_ms === undefined ||
      (Number.isSafeInteger(value.duration_ms) && (value.duration_ms as number) >= 0)
    ) ||
    !(
      value.stdout_sha256 === undefined ||
      (typeof value.stdout_sha256 === "string" && SHA256.test(value.stdout_sha256))
    ) ||
    !(
      value.stderr_sha256 === undefined ||
      (typeof value.stderr_sha256 === "string" && SHA256.test(value.stderr_sha256))
    ) ||
    !(value.output_truncated === undefined || typeof value.output_truncated === "boolean") ||
    !(
      value.sandbox_evidence_sha256 === undefined ||
      (typeof value.sandbox_evidence_sha256 === "string" &&
        SHA256.test(value.sandbox_evidence_sha256))
    ) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new JournalError("Operational journal contains an invalid execution step record.");
  }
  if (value.state === "started" && value.finished_at !== undefined) {
    throw new JournalError("Operational journal contains a started step with a finish time.");
  }
  if (value.state !== "started" && value.finished_at === undefined) {
    throw new JournalError("Operational journal contains a terminal step without a finish time.");
  }
  if (
    value.state === "completed" &&
    (value.cwd_sha256 === undefined ||
      value.provider === undefined ||
      value.assurance === undefined ||
      value.exit_code !== 0 ||
      value.duration_ms === undefined ||
      value.stdout_sha256 === undefined ||
      value.stderr_sha256 === undefined ||
      typeof value.output_truncated !== "boolean" ||
      value.sandbox_evidence_sha256 === undefined)
  ) {
    throw new JournalError("Operational journal contains an incomplete completed step record.");
  }
  return structuredClone(value as unknown as ExecutionStepRecord);
}

function isReapOutcome(value: unknown): value is ProcessReapOutcome {
  return (
    value === "killed" ||
    value === "already_gone" ||
    value === "identity_mismatch" ||
    value === "identity_unavailable" ||
    value === "kill_failed"
  );
}

function validateProcess(value: unknown): ExecutionProcessRecord {
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    value.execution_id.length === 0 ||
    typeof value.task_id !== "string" ||
    value.task_id.length === 0 ||
    !Number.isSafeInteger(value.step_index) ||
    (value.step_index as number) < 0 ||
    (value.step_index as number) >= MAX_PLAN_STEPS ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    value.process_group !== value.pid ||
    !(
      value.start_token === undefined ||
      (typeof value.start_token === "string" &&
        value.start_token.length > 0 &&
        value.start_token.length <= 200)
    ) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    value.provider.length > 80 ||
    !isIsoTimestamp(value.recorded_at) ||
    !(value.reaped_at === undefined || isIsoTimestamp(value.reaped_at)) ||
    !(value.reap_outcome === undefined || isReapOutcome(value.reap_outcome)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new JournalError("Operational journal contains an invalid execution process record.");
  }
  return structuredClone(value as unknown as ExecutionProcessRecord);
}

function validateRecovery(value: unknown): ExecutionRecoveryRecord {
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    value.execution_id.length === 0 ||
    typeof value.task_id !== "string" ||
    value.task_id.length === 0 ||
    value.outcome !== "interrupted" ||
    typeof value.reason_code !== "string" ||
    value.reason_code.length === 0 ||
    value.reason_code.length > MAX_REASON_LENGTH ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_EVIDENCE_ITEMS ||
    value.evidence.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > MAX_EVIDENCE_LENGTH,
    ) ||
    !isIsoTimestamp(value.recorded_at) ||
    value.revision !== 1
  ) {
    throw new JournalError("Operational journal contains an invalid execution recovery record.");
  }
  return structuredClone(value as unknown as ExecutionRecoveryRecord);
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
  if (
    value.attempt === undefined &&
    value.attempt_kind === undefined &&
    value.previous_execution_id === undefined
  ) {
    return { attempt: 1, attempt_kind: "initial" };
  }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new JournalError("Operational journal contains an invalid execution attempt number.");
  }
  if (!isAttemptKind(value.attempt_kind)) {
    throw new JournalError("Operational journal contains an invalid execution attempt kind.");
  }
  if (
    value.previous_execution_id !== undefined &&
    (typeof value.previous_execution_id !== "string" || value.previous_execution_id.length === 0)
  ) {
    throw new JournalError("Operational journal contains an invalid execution predecessor.");
  }
  if (value.attempt_kind === "initial") {
    if (value.attempt !== 1 || value.previous_execution_id !== undefined) {
      throw new JournalError(
        "Operational journal contains an initial execution attempt with a predecessor.",
      );
    }
  } else if (value.previous_execution_id === undefined) {
    throw new JournalError(
      "Operational journal contains a resumed or retried attempt without a predecessor.",
    );
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
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    value.execution_id.length === 0 ||
    typeof value.task_id !== "string" ||
    value.task_id.length === 0 ||
    !(
      value.workflow_id === undefined ||
      (typeof value.workflow_id === "string" && value.workflow_id.length > 0)
    ) ||
    typeof value.agent_id !== "string" ||
    value.agent_id.length === 0 ||
    !isExecutionState(value.state) ||
    !isIsoTimestamp(value.started_at) ||
    !isIsoTimestamp(value.updated_at) ||
    !(value.finished_at === undefined || isIsoTimestamp(value.finished_at)) ||
    !(
      value.reason_code === undefined ||
      (typeof value.reason_code === "string" &&
        value.reason_code.length > 0 &&
        value.reason_code.length <= MAX_REASON_LENGTH)
    ) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_EVIDENCE_ITEMS ||
    value.evidence.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > MAX_EVIDENCE_LENGTH,
    ) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new JournalError("Operational journal contains an invalid execution record.");
  }
  return structuredClone({
    ...value,
    ...attemptIdentity(value),
  } as unknown as ExecutionRecord);
}

function terminal(state: ExecutionState): boolean {
  return state !== "running";
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
  /** Ordered step records per execution attempt. */
  private readonly steps = new Map<string, ExecutionStepRecord[]>();
  /** Recorded sandbox process groups per execution attempt. */
  private readonly processes = new Map<string, ExecutionProcessRecord[]>();
  /** At most one recovery tombstone per attempt. */
  private readonly recoveries = new Map<string, ExecutionRecoveryRecord>();

  constructor(private readonly journal: AppendOnlyJournal) {}

  start(request: StartExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const taskId = assertIdentifier(request.task_id, "Execution Task ID");
    if ((this.byTask.get(taskId)?.length ?? 0) > 0) {
      throw new ExecutionConflictError(
        "This Task already has a durable execution record; use resume or retry.",
      );
    }
    return this.append(request, "initial", undefined, now);
  }

  /** Appends a new attempt after the latest `interrupted` record. */
  resume(request: RedriveExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const latest = this.requireLatest(request.task_id);
    if (latest.state === "cancelled") {
      throw new ExecutionConflictError(
        "A cancelled execution cannot be resumed; request an authorized retry instead.",
      );
    }
    if (latest.state !== "interrupted") {
      throw new ExecutionConflictError(
        `Only an interrupted execution can be resumed; the latest attempt is "${latest.state}".`,
      );
    }
    if (latest.execution_id !== request.previous_execution_id) {
      throw new ExecutionConflictError(
        "The referenced execution is not the latest attempt for this Task.",
      );
    }
    return this.append(request, "resume", latest, now);
  }

  /**
   * Appends a new attempt after a terminal failure, cancellation, or unverified completion.
   * The cancelled record remains in the ledger forever; this never reopens it.
   */
  retry(request: RedriveExecutionRequest, now: Date = new Date()): ExecutionRecord {
    const latest = this.requireLatest(request.task_id);
    if (latest.state === "running") {
      throw new ExecutionConflictError("A running execution cannot be retried.");
    }
    if (latest.state === "interrupted") {
      throw new ExecutionConflictError("An interrupted execution must be resumed, not retried.");
    }
    if (latest.execution_id !== request.previous_execution_id) {
      throw new ExecutionConflictError(
        "The referenced execution is not the latest attempt for this Task.",
      );
    }
    return this.append(request, "retry", latest, now);
  }

  complete(
    executionId: string,
    evidence: readonly string[],
    now: Date = new Date(),
  ): ExecutionRecord {
    return this.transition(
      this.requireRunning(executionId),
      "completed",
      now,
      "execution_succeeded",
      evidence,
    );
  }

  fail(
    executionId: string,
    reasonCode: string,
    evidence: readonly string[] = [],
    now: Date = new Date(),
  ): ExecutionRecord {
    return this.transition(this.requireRunning(executionId), "failed", now, reasonCode, evidence);
  }

  /**
   * Marks the latest attempt cancelled, whether it is running, queued behind the
   * concurrency gate, or cancelled before dispatch. Returns the existing record unchanged
   * when the latest attempt is already cancelled, making an authorized retry idempotent.
   */
  cancel(request: CancelExecutionRequest, now: Date = new Date()): CancelledExecution {
    const taskId = assertIdentifier(request.task_id, "Execution Task ID");
    const reason = normalizeReason(request.reason_code);
    const evidence = normalizeEvidence(request.evidence);
    const latest = this.getForTask(taskId);
    if (latest !== undefined) {
      if (latest.state === "cancelled") return { record: latest, changed: false };
      if (terminal(latest.state)) {
        throw new ExecutionConflictError(
          `Execution is already terminal in state "${latest.state}".`,
        );
      }
      return {
        record: this.transition(latest, "cancelled", now, reason, evidence),
        changed: true,
      };
    }

    const timestamp = now.toISOString();
    const record: ExecutionRecord = {
      execution_id: randomUUID(),
      task_id: taskId,
      ...(request.workflow_id === undefined
        ? {}
        : { workflow_id: assertIdentifier(request.workflow_id, "Execution Workflow ID") }),
      agent_id: `host-cancel:${assertIdentifier(request.actor_id, "Cancellation actor", 160)}`,
      attempt: 1,
      attempt_kind: "initial",
      state: "cancelled",
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
    return this.getForTask(taskId)?.state === "cancelled";
  }

  list(): ExecutionRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /**
   * Starts one plan step before any provider invocation. A step cannot be skipped,
   * reordered, or started after a predecessor failed or was interrupted.
   */
  beginStep(
    executionId: string,
    request: BeginExecutionStepRequest,
    now: Date = new Date(),
  ): ExecutionStepRecord {
    const execution = this.requireRunning(assertIdentifier(executionId, "Execution ID"));
    if (
      !Number.isSafeInteger(request.step_index) ||
      request.step_index < 0 ||
      !Number.isSafeInteger(request.step_count) ||
      request.step_count < 1 ||
      request.step_count > MAX_PLAN_STEPS ||
      request.step_index >= request.step_count
    ) {
      throw new ExecutionConflictError("Execution step bounds are invalid.");
    }
    if (
      request.action_id !== undefined &&
      (typeof request.action_id !== "string" ||
        request.action_id.length === 0 ||
        request.action_id.length > 200)
    ) {
      throw new ExecutionConflictError("Execution step Action binding is invalid.");
    }
    const steps = this.steps.get(execution.execution_id) ?? [];
    if (request.step_index !== steps.length) {
      throw new ExecutionConflictError(
        "Execution plan steps must start contiguously and in order.",
      );
    }
    const previous = steps.at(-1);
    if (previous !== undefined && previous.state !== "completed") {
      throw new ExecutionConflictError("A plan step cannot start after an incomplete predecessor.");
    }
    if (previous !== undefined && previous.step_count !== request.step_count) {
      throw new ExecutionConflictError("Execution plan step count cannot change.");
    }
    const timestamp = now.toISOString();
    const record: ExecutionStepRecord = {
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      step_index: request.step_index,
      step_count: request.step_count,
      ...(request.action_id === undefined ? {} : { action_id: request.action_id }),
      state: "started",
      started_at: timestamp,
      updated_at: timestamp,
      argv_sha256: requireDigest(request.argv_sha256, "Step argv digest"),
      revision: 1,
    };
    this.persistStep(record);
    return structuredClone(record);
  }

  /** Records the host's actual observation of a successful step. */
  completeStep(
    executionId: string,
    stepIndex: number,
    request: CompleteExecutionStepRequest,
    now: Date = new Date(),
  ): ExecutionStepRecord {
    const execution = this.requireRunning(assertIdentifier(executionId, "Execution ID"));
    const record = this.requireStartedStep(execution.execution_id, stepIndex);
    if (
      request.exit_code !== 0 ||
      typeof request.output_truncated !== "boolean" ||
      !Number.isSafeInteger(request.duration_ms) ||
      request.duration_ms < 0 ||
      typeof request.provider !== "string" ||
      request.provider.length === 0 ||
      request.provider.length > 80 ||
      typeof request.assurance !== "string" ||
      request.assurance.length === 0 ||
      request.assurance.length > 80
    ) {
      throw new ExecutionConflictError(
        "Only a complete, zero-exit observation can complete a step.",
      );
    }
    const updated: ExecutionStepRecord = {
      ...record,
      state: "completed",
      updated_at: now.toISOString(),
      finished_at: now.toISOString(),
      cwd_sha256: requireDigest(request.cwd_sha256, "Step cwd digest"),
      provider: request.provider,
      assurance: request.assurance,
      exit_code: 0,
      duration_ms: request.duration_ms,
      stdout_sha256: requireDigest(request.stdout_sha256, "Step stdout digest"),
      stderr_sha256: requireDigest(request.stderr_sha256, "Step stderr digest"),
      output_truncated: request.output_truncated,
      sandbox_evidence_sha256: requireDigest(
        request.sandbox_evidence_sha256,
        "Step sandbox evidence digest",
      ),
      revision: record.revision + 1,
    };
    this.persistStep(updated);
    return structuredClone(updated);
  }

  /** Records a failed step without copying an exception message or output. */
  failStep(
    executionId: string,
    stepIndex: number,
    reasonCode: string,
    now: Date = new Date(),
  ): ExecutionStepRecord {
    const execution = this.requireRunning(assertIdentifier(executionId, "Execution ID"));
    const record = this.requireStartedStep(execution.execution_id, stepIndex);
    const updated: ExecutionStepRecord = {
      ...record,
      state: "failed",
      updated_at: now.toISOString(),
      finished_at: now.toISOString(),
      reason_code: normalizeReason(reasonCode),
      revision: record.revision + 1,
    };
    this.persistStep(updated);
    return structuredClone(updated);
  }

  getStep(executionId: string, stepIndex: number): ExecutionStepRecord | undefined {
    const record = (this.steps.get(executionId) ?? []).find(
      (candidate) => candidate.step_index === stepIndex,
    );
    return record === undefined ? undefined : structuredClone(record);
  }

  stepsFor(executionId: string): ExecutionStepRecord[] {
    return (this.steps.get(executionId) ?? []).map((record) => structuredClone(record));
  }

  listSteps(): ExecutionStepRecord[] {
    return [...this.steps.values()].flat().map((record) => structuredClone(record));
  }

  /**
   * Records the process group of a provider invocation immediately after spawn. The
   * callback is best-effort: an identity that cannot be captured is still recorded as
   * unavailable, and recovery will not signal a PID it cannot prove.
   */
  recordProcessGroup(
    executionId: string,
    request: RecordExecutionProcessRequest,
    now: Date = new Date(),
  ): ExecutionProcessRecord {
    const execution = this.requireRunning(assertIdentifier(executionId, "Execution ID"));
    if (
      !Number.isSafeInteger(request.pid) ||
      request.pid < 1 ||
      request.process_group !== request.pid ||
      typeof request.provider !== "string" ||
      request.provider.length === 0 ||
      request.provider.length > 80 ||
      (request.start_token !== undefined &&
        (typeof request.start_token !== "string" ||
          request.start_token.length === 0 ||
          request.start_token.length > 200))
    ) {
      throw new ExecutionConflictError("Execution process identity is invalid.");
    }
    const step = this.getStep(execution.execution_id, request.step_index);
    if (step === undefined || step.state !== "started") {
      throw new ExecutionConflictError(
        "An execution process can be recorded only for a started plan step.",
      );
    }
    const existing = (this.processes.get(execution.execution_id) ?? []).find(
      (candidate) => candidate.step_index === request.step_index,
    );
    if (existing !== undefined) {
      if (existing.pid === request.pid) return structuredClone(existing);
      throw new ExecutionConflictError("A plan step already recorded a different process group.");
    }
    const record: ExecutionProcessRecord = {
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      step_index: request.step_index,
      pid: request.pid,
      process_group: request.process_group,
      ...(request.start_token === undefined ? {} : { start_token: request.start_token }),
      provider: request.provider,
      recorded_at: now.toISOString(),
      revision: 1,
    };
    this.persistProcess(record);
    return structuredClone(record);
  }

  processesFor(executionId: string): ExecutionProcessRecord[] {
    return (this.processes.get(executionId) ?? []).map((record) => structuredClone(record));
  }

  listProcesses(): ExecutionProcessRecord[] {
    return [...this.processes.values()].flat().map((record) => structuredClone(record));
  }

  markProcessReaped(
    executionId: string,
    pid: number,
    outcome: ProcessReapOutcome,
    now: Date = new Date(),
  ): ExecutionProcessRecord {
    const record = (this.processes.get(executionId) ?? []).find(
      (candidate) => candidate.pid === pid,
    );
    if (record === undefined) {
      throw new ExecutionConflictError("Execution process record was not found.");
    }
    if (record.reaped_at !== undefined) return structuredClone(record);
    const updated: ExecutionProcessRecord = {
      ...record,
      reaped_at: now.toISOString(),
      reap_outcome: outcome,
      revision: record.revision + 1,
    };
    this.persistProcess(updated);
    return structuredClone(updated);
  }

  /**
   * Recovery tombstone for a completed attempt whose Task never reached a committed
   * terminal lifecycle. It never changes the immutable completed record; the verifier
   * rejects any attempt carrying one and a new linked retry is required.
   */
  markUncommitted(
    executionId: string,
    taskLifecycle: string | undefined,
    now: Date = new Date(),
  ): ExecutionRecoveryRecord {
    const execution = this.records.get(assertIdentifier(executionId, "Execution ID"));
    if (execution === undefined) {
      throw new ExecutionConflictError("Execution record was not found.");
    }
    if (execution.state !== "completed") {
      throw new ExecutionConflictError(
        "Only a completed executor attempt can be marked uncommitted.",
      );
    }
    const existing = this.recoveries.get(execution.execution_id);
    if (existing !== undefined) return structuredClone(existing);
    const steps = this.steps.get(execution.execution_id) ?? [];
    const completedSteps = steps.filter((step) => step.state === "completed").length;
    const record: ExecutionRecoveryRecord = {
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      outcome: "interrupted",
      reason_code: "host_restarted_before_terminal_commit",
      evidence: normalizeEvidence([
        `recovered_at:${now.toISOString()}`,
        "recovery_reason:host_restarted_before_terminal_commit",
        "execution_state:completed",
        `task_lifecycle:${taskLifecycle ?? "missing"}`,
        ...(steps.length === 0
          ? []
          : [
              `plan_steps_completed:${completedSteps}`,
              `plan_steps_total:${steps[0]?.step_count ?? steps.length}`,
            ]),
      ]),
      recorded_at: now.toISOString(),
      revision: 1,
    };
    this.persistRecovery(record);
    return structuredClone(record);
  }

  recoveryFor(executionId: string): ExecutionRecoveryRecord | undefined {
    const record = this.recoveries.get(executionId);
    return record === undefined ? undefined : structuredClone(record);
  }

  listRecoveries(): ExecutionRecoveryRecord[] {
    return [...this.recoveries.values()].map((record) => structuredClone(record));
  }

  /**
   * Startup reconciliation: a `running` record from a previous process cannot still be
   * executing. It becomes `interrupted`, never `completed`, exactly once. Plan steps that
   * were started but not observed complete become `interrupted`; completed steps stay
   * immutable. A latest `completed` executor attempt whose Task never reached a terminal
   * committed state gets a recovery tombstone and is never accepted by the verifier.
   */
  reconcile(options: ExecutionReconcileOptions | Date = {}): ExecutionReconciliation {
    const opts = options instanceof Date ? { now: options } : options;
    const now = opts.now ?? new Date();
    const interrupted: ExecutionRecord[] = [];
    const interruptedSteps: ExecutionStepRecord[] = [];
    const uncommitted: ExecutionRecoveryRecord[] = [];
    const latestIds = new Set(
      [...this.byTask.values()]
        .map((ids) => ids.at(-1))
        .filter((id): id is string => id !== undefined),
    );

    for (const record of [...this.records.values()]) {
      if (record.state !== "running") continue;
      const executionSteps = this.steps.get(record.execution_id) ?? [];
      for (const step of executionSteps) {
        if (step.state !== "started") continue;
        interruptedSteps.push(this.interruptStep(step, now));
      }
      const completedSteps = executionSteps.filter((step) => step.state === "completed").length;
      const workspace = opts.workspaceEvidence?.get(record.task_id);
      interrupted.push(
        this.transition(record, "interrupted", now, "host_restarted", [
          `recovered_at:${now.toISOString()}`,
          "interruption_reason:host_restarted",
          ...(executionSteps.length === 0
            ? []
            : [
                `plan_steps_completed:${completedSteps}`,
                `plan_steps_total:${executionSteps[0]?.step_count ?? executionSteps.length}`,
              ]),
          ...(workspace === undefined
            ? []
            : [`workspace_manifest_sha256:${workspace.workspace_sha256}`]),
        ]),
      );
    }

    if (opts.taskLifecycle !== undefined) {
      for (const record of [...this.records.values()]) {
        if (record.state !== "completed" || !latestIds.has(record.execution_id)) continue;
        if (this.recoveries.has(record.execution_id)) continue;
        const lifecycle = opts.taskLifecycle(record.task_id);
        if (lifecycle === "completed" || lifecycle === "archived") continue;
        uncommitted.push(this.markUncommitted(record.execution_id, lifecycle, now));
      }
    }

    return { interrupted, interruptedSteps, uncommitted };
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
        throw new JournalError("Operational journal contains a non-monotonic execution record.");
      }
      if (terminal(current.state)) {
        throw new JournalError(
          "Operational journal contains a transition out of a terminal execution state.",
        );
      }
      if (
        current.task_id !== record.task_id ||
        current.attempt !== record.attempt ||
        current.attempt_kind !== record.attempt_kind ||
        current.previous_execution_id !== record.previous_execution_id
      ) {
        throw new JournalError("Operational journal changed an execution attempt identity.");
      }
      this.records.set(record.execution_id, record);
      return;
    }

    const attempts = this.byTask.get(record.task_id) ?? [];
    const previousId = attempts.at(-1);
    if (record.attempt !== attempts.length + 1) {
      throw new JournalError(
        "Operational journal contains a non-contiguous execution attempt sequence.",
      );
    }
    if (record.attempt_kind === "initial") {
      if (attempts.length !== 0 || record.previous_execution_id !== undefined) {
        throw new JournalError(
          "Operational journal contains an initial execution attempt with a predecessor.",
        );
      }
    } else {
      if (previousId === undefined || record.previous_execution_id !== previousId) {
        throw new JournalError(
          "Operational journal contains a resumed or retried attempt with a mismatched predecessor.",
        );
      }
      const previous = this.records.get(previousId);
      if (!previous || previous.state === "running") {
        throw new JournalError(
          "Operational journal appended a successor before its predecessor became terminal.",
        );
      }
      if (record.attempt_kind === "resume" && previous.state !== "interrupted") {
        throw new JournalError("Operational journal resumes an attempt that is not interrupted.");
      }
      if (
        record.attempt_kind === "retry" &&
        previous.state !== "failed" &&
        previous.state !== "cancelled" &&
        previous.state !== "completed"
      ) {
        throw new JournalError(
          "Operational journal retries an attempt that is not failed, cancelled, or completed.",
        );
      }
    }
    this.records.set(record.execution_id, record);
    this.byTask.set(record.task_id, [...attempts, record.execution_id]);
  }

  /** Journal replay only. Step records must be contiguous and belong to a known attempt. */
  restoreStep(value: unknown): void {
    const record = validateStep(value);
    const execution = this.records.get(record.execution_id);
    if (execution === undefined || execution.task_id !== record.task_id) {
      throw new JournalError("Operational journal contains a step without its execution attempt.");
    }
    const steps = this.steps.get(record.execution_id) ?? [];
    const current = steps[record.step_index];
    if (current === undefined) {
      if (record.step_index !== steps.length) {
        throw new JournalError("Operational journal contains non-contiguous execution steps.");
      }
      if (steps[0] !== undefined && steps[0].step_count !== record.step_count) {
        throw new JournalError("Operational journal changed an execution plan step count.");
      }
      steps.push(record);
      this.steps.set(record.execution_id, steps);
      return;
    }
    if (record.revision <= current.revision) {
      throw new JournalError("Operational journal contains a non-monotonic execution step record.");
    }
    if (
      current.state !== "started" ||
      current.step_count !== record.step_count ||
      current.action_id !== record.action_id ||
      current.argv_sha256 !== record.argv_sha256
    ) {
      throw new JournalError("Operational journal changed immutable execution step identity.");
    }
    if (record.state === "started") {
      throw new JournalError("Operational journal contains a second started step revision.");
    }
    steps[record.step_index] = record;
  }

  /** Journal replay only. */
  restoreProcess(value: unknown): void {
    const record = validateProcess(value);
    const execution = this.records.get(record.execution_id);
    const step = this.getStep(record.execution_id, record.step_index);
    if (execution === undefined || step === undefined || execution.task_id !== record.task_id) {
      throw new JournalError(
        "Operational journal contains a process record without its execution step.",
      );
    }
    const processes = this.processes.get(record.execution_id) ?? [];
    const index = processes.findIndex((candidate) => candidate.pid === record.pid);
    if (index < 0) {
      if (processes.some((candidate) => candidate.step_index === record.step_index)) {
        throw new JournalError(
          "Operational journal contains two process groups for one execution step.",
        );
      }
      processes.push(record);
      this.processes.set(record.execution_id, processes);
      return;
    }
    const current = processes[index];
    if (current === undefined || record.revision <= current.revision) {
      throw new JournalError("Operational journal contains a non-monotonic process record.");
    }
    if (
      current.process_group !== record.process_group ||
      current.start_token !== record.start_token ||
      current.provider !== record.provider ||
      (current.reaped_at !== undefined &&
        (record.reaped_at !== current.reaped_at || record.reap_outcome !== current.reap_outcome))
    ) {
      throw new JournalError("Operational journal changed an execution process identity.");
    }
    processes[index] = record;
  }

  /** Journal replay only. At most one recovery tombstone exists per attempt. */
  restoreRecovery(value: unknown): void {
    const record = validateRecovery(value);
    const execution = this.records.get(record.execution_id);
    if (
      execution === undefined ||
      execution.task_id !== record.task_id ||
      execution.state !== "completed"
    ) {
      throw new JournalError(
        "Operational journal contains a recovery record without a completed execution attempt.",
      );
    }
    if (this.recoveries.has(record.execution_id)) {
      throw new JournalError("Operational journal contains a duplicate execution recovery record.");
    }
    this.recoveries.set(record.execution_id, record);
  }

  private append(
    request: StartExecutionRequest,
    attemptKind: ExecutionAttemptKind,
    previous: ExecutionRecord | undefined,
    now: Date,
  ): ExecutionRecord {
    const taskId = assertIdentifier(request.task_id, "Execution Task ID");
    const agentId = assertIdentifier(request.agent_id, "Execution Agent ID");
    const timestamp = now.toISOString();
    const record: ExecutionRecord = {
      execution_id: randomUUID(),
      task_id: taskId,
      ...(request.workflow_id === undefined
        ? {}
        : { workflow_id: assertIdentifier(request.workflow_id, "Execution Workflow ID") }),
      agent_id: agentId,
      attempt: previous === undefined ? 1 : previous.attempt + 1,
      attempt_kind: attemptKind,
      ...(previous === undefined ? {} : { previous_execution_id: previous.execution_id }),
      state: "running",
      started_at: timestamp,
      updated_at: timestamp,
      evidence: [],
      revision: 1,
    };
    this.persist(record);
    return structuredClone(record);
  }

  private requireLatest(taskId: string): ExecutionRecord {
    const task = assertIdentifier(taskId, "Execution Task ID");
    const latest = this.getForTask(task);
    if (!latest)
      throw new ExecutionConflictError("This Task has no execution attempt to resume or retry.");
    return latest;
  }

  private requireRunning(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) throw new ExecutionConflictError("Execution record was not found.");
    if (record.state !== "running")
      throw new ExecutionConflictError("Execution is no longer running.");
    return record;
  }

  private requireStartedStep(executionId: string, stepIndex: number): ExecutionStepRecord {
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
      throw new ExecutionConflictError("Execution step index is invalid.");
    }
    const record = this.getStep(executionId, stepIndex);
    if (record === undefined) {
      throw new ExecutionConflictError("Execution step was not started.");
    }
    if (record.state !== "started") {
      throw new ExecutionConflictError("Execution step is already terminal.");
    }
    return record;
  }

  private interruptStep(step: ExecutionStepRecord, now: Date): ExecutionStepRecord {
    const updated: ExecutionStepRecord = {
      ...step,
      state: "interrupted",
      updated_at: now.toISOString(),
      finished_at: now.toISOString(),
      reason_code: "host_restarted",
      revision: step.revision + 1,
    };
    this.persistStep(updated);
    return structuredClone(updated);
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
      evidence: [...record.evidence, ...normalizeEvidence(evidence)].slice(-MAX_EVIDENCE_ITEMS),
      revision: record.revision + 1,
    };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(record: ExecutionRecord): void {
    this.journal.append("execution", record);
    this.records.set(record.execution_id, record);
    const attempts = this.byTask.get(record.task_id) ?? [];
    if (attempts.at(-1) !== record.execution_id) attempts.push(record.execution_id);
    this.byTask.set(record.task_id, attempts);
  }

  private persistStep(record: ExecutionStepRecord): void {
    this.journal.append("execution_step", record);
    const steps = this.steps.get(record.execution_id) ?? [];
    steps[record.step_index] = record;
    this.steps.set(record.execution_id, steps);
  }

  private persistProcess(record: ExecutionProcessRecord): void {
    this.journal.append("execution_process", record);
    const processes = this.processes.get(record.execution_id) ?? [];
    const index = processes.findIndex((candidate) => candidate.pid === record.pid);
    if (index < 0) processes.push(record);
    else processes[index] = record;
    this.processes.set(record.execution_id, processes);
  }

  private persistRecovery(record: ExecutionRecoveryRecord): void {
    this.journal.append("execution_recovery", record);
    this.recoveries.set(record.execution_id, record);
  }
}

/** Stable, non-secret digest for a host-generated evidence value. */
export function evidenceDigest(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256")
    .update(serialized ?? "undefined")
    .digest("hex");
}
