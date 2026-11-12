import { randomUUID } from "node:crypto";
import type {
  ArtifactEntity,
  CanonicalEntity,
  LifecycleState,
  TaskEntity,
  WorkflowEntity,
} from "@aios/core";
import type { HostSessionEntry } from "../config.js";
import {
  ArtifactEntity as ArtifactSchema,
  TaskEntity as TaskSchema,
  WorkflowEntity as WorkflowSchema,
} from "@aios/core";
import { ObjectStore, type EntityPatch } from "@aios/objects";
import type { TaskRepositoryPort } from "@aios/orchestration";
import { ExecutionLedger } from "./execution-ledger.js";
import { AppendOnlyJournal, JournalError } from "./journal.js";
import { DurableSessionStore, type SessionSnapshot } from "./session-store.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 60 * 60 * 1000;

export class DispatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchConflictError";
  }
}

export type RunState = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunRecord {
  run_id: string;
  workflow_id: string;
  actor_id: string;
  idempotency_key: string;
  state: RunState;
  lease_owner: string;
  lease_expires_at: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  failure_reason?: string;
  revision: number;
}

export interface StartRunRequest {
  workflow_id: string;
  actor_id: string;
  idempotency_key: string;
  lease_ms?: number;
}

export interface StartedRun {
  run: RunRecord;
  /** True when an already-completed run for this key is being replayed. */
  replayed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunState(value: unknown): value is RunState {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateRun(value: unknown): RunRecord {
  if (
    !isRecord(value) ||
    typeof value.run_id !== "string" ||
    value.run_id.length === 0 ||
    typeof value.workflow_id !== "string" ||
    value.workflow_id.length === 0 ||
    typeof value.actor_id !== "string" ||
    value.actor_id.length === 0 ||
    typeof value.idempotency_key !== "string" ||
    !IDEMPOTENCY_KEY.test(value.idempotency_key) ||
    !isRunState(value.state) ||
    typeof value.lease_owner !== "string" ||
    value.lease_owner.length === 0 ||
    !isIsoTimestamp(value.lease_expires_at) ||
    !isIsoTimestamp(value.started_at) ||
    !isIsoTimestamp(value.updated_at) ||
    !(value.finished_at === undefined || isIsoTimestamp(value.finished_at)) ||
    !(value.failure_reason === undefined || typeof value.failure_reason === "string") ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new JournalError("Operational journal contains an invalid run record.");
  }
  return value as unknown as RunRecord;
}

/** Durable collection over the canonical entity model. */
export class DurableCollection<T extends CanonicalEntity> {
  private readonly store: ObjectStore<T>;
  private readonly schema: { parse(data: unknown): T };

  constructor(
    private readonly journal: AppendOnlyJournal,
    private readonly collection: "tasks" | "workflows" | "artifacts",
    schema: { parse(data: unknown): T },
  ) {
    this.schema = schema;
    this.store = new ObjectStore<T>(schema);
  }

  create(entity: T): T {
    const created = this.store.create(entity);
    this.persist(created);
    return created;
  }

  get(entityId: string): T | undefined {
    return this.store.get(entityId);
  }

  list(filter?: { entityType?: CanonicalEntity["entity_type"] }): T[] {
    return this.store.list(filter);
  }

  update(entityId: string, patch: EntityPatch<T>): T {
    const updated = this.store.update(entityId, patch);
    this.persist(updated);
    return updated;
  }

  transitionLifecycle(entityId: string, state: LifecycleState, actor: string): T {
    const updated = this.store.transitionLifecycle(entityId, state, actor);
    this.persist(updated);
    return updated;
  }

  /** Journal replay only. Validated and monotonic; never called from request paths. */
  restore(entity: unknown): void {
    let parsed: T;
    try {
      parsed = this.schema.parse(entity);
    } catch {
      throw new JournalError(
        "Operational journal contains an entity that fails its canonical schema.",
      );
    }
    try {
      this.store.restore(parsed);
    } catch {
      throw new JournalError(
        "Operational journal contains a replayed entity that violates store invariants.",
      );
    }
  }

  private persist(entity: T): void {
    this.journal.append("entity", { collection: this.collection, entity });
  }
}

/** TaskRepositoryPort adapter over the durable collection. */
export class DurableTaskRepository
  extends DurableCollection<TaskEntity>
  implements TaskRepositoryPort
{
  constructor(journal: AppendOnlyJournal) {
    super(journal, "tasks", TaskSchema);
  }

  createTask(task: TaskEntity): TaskEntity {
    return this.create(task);
  }

  getTask(taskId: string): TaskEntity | undefined {
    return this.get(taskId);
  }

  listTasks(): TaskEntity[] {
    return this.list({ entityType: "task" });
  }

  updateTask(taskId: string, patch: EntityPatch<TaskEntity>): TaskEntity {
    return this.update(taskId, patch);
  }

  transitionTaskLifecycle(taskId: string, state: LifecycleState, actor: string): TaskEntity {
    return this.transitionLifecycle(taskId, state, actor);
  }
}

/**
 * Durable dispatch runs: caller-supplied idempotency keys plus time-bounded leases.
 *
 * - One active (running) run per Workflow. A second concurrent dispatch is rejected rather
 *   than racing the kernel.
 * - The same idempotency key for the same Workflow replays a completed run instead of
 *   executing twice.
 * - A running lease held by another live owner is a conflict; an expired lease or a lease
 *   from a previous host boot is reclaimable.
 * - Every state change is journaled. `recover()` runs at startup and marks runs left by a
 *   previous boot as interrupted; they are never silently completed.
 */
export class DurableRunCoordinator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private readonly leaseMs: number;

  constructor(
    private readonly journal: AppendOnlyJournal,
    leaseMs: number = DEFAULT_LEASE_MS,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
      throw new Error("Dispatch lease duration is outside the supported range.");
    }
    this.leaseMs = leaseMs;
  }

  start(request: StartRunRequest, now: Date = new Date()): StartedRun {
    if (
      !isRecord(request as unknown) ||
      typeof request.workflow_id !== "string" ||
      request.workflow_id.length === 0 ||
      typeof request.actor_id !== "string" ||
      request.actor_id.length === 0 ||
      typeof request.idempotency_key !== "string" ||
      !IDEMPOTENCY_KEY.test(request.idempotency_key)
    ) {
      throw new DispatchConflictError(
        "Dispatch requires a Workflow, an actor, and a valid Idempotency-Key.",
      );
    }
    const leaseMs = request.lease_ms ?? this.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
      throw new DispatchConflictError("Dispatch lease duration is outside the supported range.");
    }
    const nowIso = now.toISOString();

    for (const run of this.runs.values()) {
      if (run.workflow_id !== request.workflow_id) continue;
      if (run.idempotency_key === request.idempotency_key && run.state === "completed") {
        return { run: structuredClone(run), replayed: true };
      }
      if (
        run.state === "running" &&
        run.lease_owner !== this.owner &&
        Date.parse(run.lease_expires_at) > now.getTime()
      ) {
        throw new DispatchConflictError("This Workflow already has an active dispatch lease.");
      }
      if (
        run.state === "running" &&
        run.idempotency_key !== request.idempotency_key &&
        Date.parse(run.lease_expires_at) > now.getTime()
      ) {
        throw new DispatchConflictError(
          "This Workflow is already being dispatched under a different idempotency key.",
        );
      }
    }

    for (const run of this.runs.values()) {
      if (run.workflow_id !== request.workflow_id || run.state !== "running") continue;
      if (run.lease_owner === this.owner || Date.parse(run.lease_expires_at) <= now.getTime()) {
        this.transition(run, "interrupted", now, "lease_reclaimed");
      }
    }

    const record: RunRecord = {
      run_id: randomUUID(),
      workflow_id: request.workflow_id,
      actor_id: request.actor_id,
      idempotency_key: request.idempotency_key,
      state: "running",
      lease_owner: this.owner,
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      started_at: nowIso,
      updated_at: nowIso,
      revision: 1,
    };
    this.persist(record);
    return { run: structuredClone(record), replayed: false };
  }

  complete(runId: string, now: Date = new Date()): RunRecord {
    return this.transition(this.requireRunning(runId), "completed", now);
  }

  fail(runId: string, reason: string, now: Date = new Date()): RunRecord {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 200) {
      throw new Error("Run failure reason must be a bounded non-empty string.");
    }
    return this.transition(this.requireRunning(runId), "failed", now, reason);
  }

  /**
   * Terminates an active dispatch as cancelled. Only a currently running run may be
   * cancelled; recovery may have already made it interrupted.
   */
  cancel(runId: string, reason = "cancelled_by_request", now: Date = new Date()): RunRecord {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 200) {
      throw new Error("Run cancellation reason must be a bounded non-empty string.");
    }
    return this.transition(this.requireRunning(runId), "cancelled", now, reason);
  }

  renew(runId: string, leaseMs: number = this.leaseMs, now: Date = new Date()): RunRecord {
    const run = this.requireRunning(runId);
    if (run.lease_owner !== this.owner) {
      throw new DispatchConflictError("Only the lease owner may renew a dispatch lease.");
    }
    const updated: RunRecord = {
      ...run,
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      updated_at: now.toISOString(),
      revision: run.revision + 1,
    };
    this.persist(updated);
    return structuredClone(updated);
  }

  /** Renews a lease on an interval; the returned function stops the timer. */
  heartbeat(
    runId: string,
    intervalMs: number = Math.max(1_000, Math.floor(this.leaseMs / 3)),
  ): () => void {
    const timer = setInterval(() => {
      try {
        this.renew(runId);
      } catch {
        // A failed renewal is surfaced by completion; never crash the process from a timer.
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Marks runs left behind by a previous host boot (or an expired lease) as interrupted.
   * Returns the affected Workflow IDs so the host can suspend their lifecycle state instead
   * of pretending the work completed.
   */
  recover(now: Date = new Date()): string[] {
    const affected = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.state !== "running") continue;
      if (run.lease_owner === this.owner) continue;
      this.transition(run, "interrupted", now, "host_restarted");
      affected.add(run.workflow_id);
    }
    return [...affected];
  }

  get(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  list(): RunRecord[] {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  listForWorkflow(workflowId: string): RunRecord[] {
    return this.list().filter((run) => run.workflow_id === workflowId);
  }

  /** Journal replay only. */
  restore(value: unknown): void {
    const run = validateRun(value);
    const current = this.runs.get(run.run_id);
    if (current && run.revision <= current.revision) {
      throw new JournalError("Operational journal contains a non-monotonic run record.");
    }
    if (current && current.state !== "running") {
      throw new JournalError(
        "Operational journal contains a transition out of a terminal run state.",
      );
    }
    this.runs.set(run.run_id, run);
  }

  private requireRunning(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new DispatchConflictError("Dispatch run was not found.");
    if (run.state !== "running")
      throw new DispatchConflictError("Dispatch run is no longer running.");
    return run;
  }

  private transition(
    run: RunRecord,
    state: RunState,
    now: Date,
    failureReason?: string,
  ): RunRecord {
    const updated: RunRecord = {
      ...run,
      state,
      updated_at: now.toISOString(),
      ...(state === "completed" ||
      state === "failed" ||
      state === "cancelled" ||
      state === "interrupted"
        ? { finished_at: now.toISOString() }
        : {}),
      ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
      revision: run.revision + 1,
    };
    this.persist(updated);
    return structuredClone(updated);
  }

  private persist(run: RunRecord): void {
    this.journal.append("run", run);
    this.runs.set(run.run_id, run);
  }
}

export interface DurableStoreOptions {
  directory: string;
  leaseMs?: number;
  maxJournalBytes?: number;
  /** Provisioned sessions used as generation 1; durable rotations/revocations override them. */
  sessions?: readonly HostSessionEntry[];
}

/** Snapshot record written by compaction; replayed through the same validated restores. */
export interface OperationalSnapshot {
  tasks: unknown[];
  workflows: unknown[];
  artifacts: unknown[];
  runs: unknown[];
  executions: unknown[];
  /** Added after F-013; old snapshots remain readable and leave configured sessions intact. */
  session_state?: SessionSnapshot;
}

/**
 * Durable operational state for Tasks, Workflows, Artifacts, dispatch runs, and Task
 * execution lifecycle records.
 *
 * Deliberately separate from Founder Intelligence persistence: ADR-0014 makes the Obsidian
 * vault that substrate. Nothing here reads or writes vault notes.
 *
 * Single-process by construction (the journal holds a lock). Crash recovery replays
 * hash-chain-verified records; interrupted runs and executions are marked and their
 * Workflows suspended by the host, never completed.
 */
export class DurableOperationalStore {
  readonly journal: AppendOnlyJournal;
  readonly tasks: DurableTaskRepository;
  readonly workflows: DurableCollection<WorkflowEntity>;
  readonly artifacts: DurableCollection<ArtifactEntity>;
  readonly runs: DurableRunCoordinator;
  /** Per-Task sandbox execution lifecycle, used for cancellation and crash reconciliation. */
  readonly executions: ExecutionLedger;
  /** Durable session generations, revocation, expiry, and scope authority. */
  readonly sessions: DurableSessionStore;

  constructor(options: DurableStoreOptions) {
    if (
      !isRecord(options as unknown) ||
      typeof options.directory !== "string" ||
      options.directory.length === 0
    ) {
      throw new Error("Durable operational storage requires a directory.");
    }
    this.journal = new AppendOnlyJournal({
      filePath: `${options.directory.replace(/\/+$/, "")}/operational.jsonl`,
      ...(options.maxJournalBytes === undefined ? {} : { maxBytes: options.maxJournalBytes }),
    });
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.tasks = new DurableTaskRepository(this.journal);
    this.workflows = new DurableCollection<WorkflowEntity>(
      this.journal,
      "workflows",
      WorkflowSchema,
    );
    this.artifacts = new DurableCollection<ArtifactEntity>(
      this.journal,
      "artifacts",
      ArtifactSchema,
    );
    this.runs = new DurableRunCoordinator(this.journal, leaseMs);
    this.executions = new ExecutionLedger(this.journal);
    this.sessions = new DurableSessionStore(this.journal, options.sessions ?? []);

    for (const record of this.journal.read()) {
      if (record.kind === "entity") {
        if (
          !isRecord(record.payload) ||
          (record.payload.collection !== "tasks" &&
            record.payload.collection !== "workflows" &&
            record.payload.collection !== "artifacts")
        ) {
          throw new JournalError("Operational journal contains an unknown entity collection.");
        }
        const collection = record.payload.collection;
        if (collection === "tasks") this.tasks.restore(record.payload.entity);
        else if (collection === "workflows") this.workflows.restore(record.payload.entity);
        else this.artifacts.restore(record.payload.entity);
      } else if (record.kind === "run") {
        this.runs.restore(record.payload);
      } else if (record.kind === "execution") {
        this.executions.restore(record.payload);
      } else if (record.kind === "session_rotated") {
        this.sessions.restoreRotation(record.payload);
      } else if (record.kind === "session_revoked") {
        this.sessions.restoreRevocation(record.payload);
      } else if (record.kind === "journal_snapshot") {
        if (!isRecord(record.payload)) {
          throw new JournalError("Operational journal contains a malformed compaction snapshot.");
        }
        const snapshot = record.payload;
        for (const key of ["tasks", "workflows", "artifacts", "runs", "executions"] as const) {
          if (!Array.isArray(snapshot[key])) {
            throw new JournalError(
              "Operational journal contains a compaction snapshot with a missing collection.",
            );
          }
        }
        for (const entity of snapshot.tasks as unknown[]) this.tasks.restore(entity);
        for (const entity of snapshot.workflows as unknown[]) this.workflows.restore(entity);
        for (const entity of snapshot.artifacts as unknown[]) this.artifacts.restore(entity);
        for (const run of snapshot.runs as unknown[]) this.runs.restore(run);
        for (const execution of snapshot.executions as unknown[])
          this.executions.restore(execution);
        if (snapshot.session_state !== undefined)
          this.sessions.restoreSnapshot(snapshot.session_state);
      } else {
        throw new JournalError(
          `Operational journal contains an unknown record kind "${record.kind}".`,
        );
      }
    }
  }

  /**
   * Exports the full verified journal to `archivePath`, then replaces the live journal
   * with one snapshot record. Every current entity, run, and execution attempt is carried
   * into the snapshot and replayed through the same validated restore methods, so the
   * verifier's durable attempt and result digest survive the rewrite. The archive is
   * written and verified first; if it fails, the live journal is untouched.
   */
  compact(archivePath: string): ReturnType<AppendOnlyJournal["compactWithSnapshot"]> {
    const snapshot: OperationalSnapshot = {
      tasks: this.tasks.list(),
      workflows: this.workflows.list(),
      artifacts: this.artifacts.list(),
      runs: this.runs.list(),
      executions: this.executions.list(),
      session_state: this.sessions.state.snapshot(),
    };
    return this.journal.compactWithSnapshot("journal_snapshot", snapshot, archivePath);
  }

  close(): void {
    this.journal.close();
  }
}
