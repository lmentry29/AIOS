import { randomUUID } from 'node:crypto';
import type { ArtifactEntity, LifecycleState, TaskEntity, WorkflowEntity } from '@aios/core';
import { ArtifactEntity as ArtifactSchema, WorkflowEntity as WorkflowSchema } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';


export interface TaskRepositoryPort {
  createTask(task: TaskEntity): TaskEntity;
  getTask(taskId: string): TaskEntity | undefined;
  updateTask(taskId: string, patch: EntityPatch<TaskEntity>): TaskEntity;
  transitionTaskLifecycle(taskId: string, state: LifecycleState, actor: string): TaskEntity;
}

export interface EntityRepositoryPort<T extends { entity_id: string }> {
  create(entity: T): T;
  get(entityId: string): T | undefined;
  transitionLifecycle(entityId: string, state: LifecycleState, actor: string): T;
}

export interface WorkflowRunHandle {
  workflow_id: string;
}

export type WorkIntakeRequest =
  | { kind: 'task'; task: TaskEntity }
  | { kind: 'workflow'; workflow: WorkflowEntity };

export interface TaskExecutionResult {
  summary: string;
  evidence: string[];
  /** Required when the Task defines Actions; must report the complete final Action set. */
  completed_actions?: TaskEntity['actions'];
}

export type ExecutionAttemptKind = 'initial' | 'resume' | 'retry';
export type ObservedExecutionState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A deliberate resume/retry of the latest terminal execution attempt (ADR-0022). */
export interface ExecutionAttemptRequest {
  kind: 'resume' | 'retry';
  previous_execution_id: string;
}

/** Read-only view of the latest durable execution attempt for a Task. */
export interface TaskExecutionObservation {
  execution_id: string;
  task_id: string;
  agent_id: string;
  state: ObservedExecutionState;
  attempt: number;
  attempt_kind: ExecutionAttemptKind;
  previous_execution_id?: string;
}

export interface TaskExecutionStatePort {
  latest(taskId: string): Promise<TaskExecutionObservation | undefined>;
}

export interface TaskAttemptSummary {
  task_id: string;
  execution_id: string;
  attempt: number;
  attempt_kind: ExecutionAttemptKind;
  state: ObservedExecutionState;
}

export interface WorkflowResumeResult {
  workflow_id: string;
  lifecycle_state: LifecycleState;
  resumed: boolean;
  attempts: TaskAttemptSummary[];
}

export interface TaskResumeResult {
  task_id: string;
  lifecycle_state: LifecycleState;
  resumed: boolean;
  execution?: TaskAttemptSummary;
}

export interface TaskRetryResult {
  task_id: string;
  lifecycle_state: LifecycleState;
  retried: boolean;
  execution?: TaskAttemptSummary;
}

type WorkflowResumePlanItem =
  | { mode: 'skip'; task: TaskEntity }
  | { mode: 'execute'; task: TaskEntity; agentId: string }
  | { mode: 'resume'; task: TaskEntity; agentId: string; previousExecutionId: string };

function executionSummary(observation: TaskExecutionObservation): TaskAttemptSummary {
  return {
    task_id: observation.task_id,
    execution_id: observation.execution_id,
    attempt: observation.attempt,
    attempt_kind: observation.attempt_kind,
    state: observation.state,
  };
}

export interface VerifiedExecution {
  result: TaskExecutionResult;
  decision: TaskVerificationDecision;
  verifier_id: string;
}

export interface TaskVerificationRequest {
  task: TaskEntity;
  agent_ids: string[];
  execution_result: TaskExecutionResult;
}

export interface TaskVerificationDecision {
  accepted: boolean;
  evidence: string[];
  reason: string;
}

/** Independent verifier; must not simply trust the executor's self-reported outcome. */
export interface TaskVerificationPort {
  /** Trusted verifier principal configured by the host, never supplied by the executor or requester. */
  readonly verifier_id: string;
  verify(request: TaskVerificationRequest): Promise<TaskVerificationDecision>;
}

export interface AuthorizationRequest {
  actor_id: string;
  action: 'intake' | 'dispatch' | 'execute' | 'coordinate' | 'cancel' | 'resume' | 'retry' | 'read_status' | 'read_evidence';
  resource_id: string;
}

export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): Promise<boolean>;
}

export interface AgentExecutionPort {
  validateAgent(agentId: string): Promise<boolean>;
  /**
   * Executes a Task. `attempt` is present only for a deliberate resume/retry of the
   * latest terminal attempt; the initial dispatch omits it.
   */
  executeTask(
    agentId: string,
    task: TaskEntity,
    attempt?: ExecutionAttemptRequest,
  ): Promise<TaskExecutionResult>;
  coordinate(agents: string[], task: TaskEntity): Promise<TaskExecutionResult>;
  /** Optional preflight check used to reject a dispatch before lifecycle writes. */
  hasCapacity?(): boolean;
}

/** Read-only cancellation view supplied by the host; it carries no authority itself. */
export interface TaskCancellationPort {
  isCancelled(taskId: string): Promise<boolean>;
}

export interface OrchestrationOptions {
  authorization: AuthorizationPort;
  execution: AgentExecutionPort;
  verification: TaskVerificationPort;
  resolveAgent(task: TaskEntity): Promise<string>;
  cancellation?: TaskCancellationPort;
  /** Read-only durable attempt view used to decide resume eligibility. */
  executionState?: TaskExecutionStatePort;
}

function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clonePlain(nested)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function isActorIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && (/^human:[^\s:*]+$/.test(value)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function isEntityIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class OrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

/** The Task was cancelled by an authorized caller; no verifier or completion may follow. */
export class TaskCancelledError extends OrchestrationError {
  constructor(taskId: string) {
    super(`Task "${taskId}" was cancelled before verified completion.`);
    this.name = 'TaskCancelledError';
  }
}

/** Rejected before execution because the configured concurrency cap is full. */
export class ExecutionCapacityError extends OrchestrationError {
  constructor() {
    super('The host execution concurrency limit is full; this dispatch was not started.');
    this.name = 'ExecutionCapacityError';
  }
}

/**
 * The caller is authorized, but the requested resume/retry is invalid for the current
 * lifecycle state or latest attempt. Never an authorization denial.
 */
export class ExecutionAttemptConflictError extends OrchestrationError {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionAttemptConflictError';
  }
}

/**
 * Orchestration Kernel for ordered workflow execution.
 *
 * The kernel deliberately depends on explicit authorization and execution ports.
 * It never treats a lifecycle transition as proof of completed work: completion is
 * committed only after an independent verification adapter accepts the execution result.
 * No permissive default authorization or fake executor is supplied.
 *
 * Persistence is currently the injected in-memory ObjectStore/TaskStore. A durable
 * database adapter, distributed locking, crash recovery, and idempotent outbox are
 * still required before deploying this kernel in production.
 */
export class OrchestrationKernel {
  private readonly workflows: EntityRepositoryPort<WorkflowEntity>;
  private readonly evidence: EntityRepositoryPort<ArtifactEntity>;
  /**
   * In-process claims held only for the duration of one authorized resume/retry. A duplicate
   * request is rejected before any lifecycle or attempt write; the durable ledger independent-
   * ly refuses a successor whose predecessor is not terminal.
   */
  private readonly redrivesInFlight = new Set<string>();

  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly options: OrchestrationOptions,
    workflowStore?: EntityRepositoryPort<WorkflowEntity>,
    evidenceStore?: EntityRepositoryPort<ArtifactEntity>,
  ) {
    this.workflows = workflowStore ?? new ObjectStore<WorkflowEntity>(WorkflowSchema);
    this.evidence = evidenceStore ?? new ObjectStore<ArtifactEntity>(ArtifactSchema);
  }

  private claimRedrives(resourceIds: readonly string[]): void {
    const unique = [...new Set(resourceIds)];
    for (const id of unique) {
      if (this.redrivesInFlight.has(id)) {
        throw new ExecutionAttemptConflictError(
          'A resume or retry is already in progress for this Workflow or Task; no second attempt was appended.',
        );
      }
    }
    for (const id of unique) this.redrivesInFlight.add(id);
  }

  private releaseRedrives(resourceIds: readonly string[]): void {
    for (const id of resourceIds) this.redrivesInFlight.delete(id);
  }

  async intake(request: WorkIntakeRequest, actorId: string): Promise<TaskEntity | WorkflowEntity> {
    if (!isActorIdentifier(actorId)) throw new OrchestrationError('Intake requires a valid authenticated actor identifier.');
    if (!request || typeof request !== 'object' || (request.kind !== 'task' && request.kind !== 'workflow')) {
      throw new OrchestrationError('Work intake request must specify either a Task or Workflow.');
    }
    if (request.kind === 'task') {
      if (!request.task || !isEntityIdentifier(request.task.entity_id)) throw new OrchestrationError('Task intake requires a valid Task entity.');
      if (request.task.created_by !== actorId || request.task.owner_id !== actorId) {
        throw new OrchestrationError('Task intake provenance and ownership must match the authenticated requester.');
      }
      const allowed = await this.options.authorization.authorize({
        actor_id: actorId,
        action: 'intake',
        resource_id: request.task.entity_id,
      });
      if (!allowed) throw new OrchestrationError('Task intake denied by authorization policy.');
      return this.tasks.createTask(request.task);
    }
    if (!request.workflow || !isEntityIdentifier(request.workflow.entity_id)) throw new OrchestrationError('Workflow intake requires a valid Workflow entity.');
    if (request.workflow.created_by !== actorId || request.workflow.owner_id !== actorId) {
      throw new OrchestrationError('Workflow intake provenance and ownership must match the authenticated requester.');
    }
    const allowed = await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'intake',
      resource_id: request.workflow.entity_id,
    });
    if (!allowed) throw new OrchestrationError('Workflow intake denied by authorization policy.');
    return this.workflows.create(request.workflow);
  }

  async dispatch(workflow: WorkflowEntity, actorId: string): Promise<WorkflowRunHandle> {
    if (!workflow || !isEntityIdentifier(workflow.entity_id) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError('Workflow dispatch requires a valid Workflow and actor identifier.');
    }
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'dispatch',
      resource_id: workflow.entity_id,
    }))) {
      throw new OrchestrationError('Workflow dispatch denied by authorization policy.');
    }

    const stored = this.workflows.get(workflow.entity_id);
    if (!stored) throw new OrchestrationError('Workflow must be accepted through authorized intake before dispatch.');
    if (stored.lifecycle_state !== 'created') {
      throw new OrchestrationError(`Workflow "${stored.entity_id}" must be created before dispatch.`);
    }

    // Preflight every Task, Agent, and permission before the first lifecycle write.
    if (stored.steps.length === 0) throw new OrchestrationError('Cannot dispatch a Workflow with no steps.');
    if (new Set(stored.steps).size !== stored.steps.length) {
      throw new OrchestrationError('Workflow steps must not contain duplicate Task IDs.');
    }
    const plan = [];
    for (const taskId of stored.steps) {
      const task = this.tasks.getTask(taskId);
      if (!task) throw new OrchestrationError(`Workflow step Task "${taskId}" does not exist.`);
      if (task.lifecycle_state !== 'created') {
        throw new OrchestrationError(`Task "${taskId}" must be created before workflow dispatch.`);
      }
      if (task.assigned_agent) {
        throw new OrchestrationError(`Task "${taskId}" is already assigned to an Agent.`);
      }
      if (task.assigned_workflow && task.assigned_workflow !== stored.entity_id) {
        throw new OrchestrationError(`Task "${taskId}" is already assigned to another Workflow.`);
      }
      await this.assertNotCancelled(taskId);
      if (this.options.execution.hasCapacity && !this.options.execution.hasCapacity()) {
        throw new ExecutionCapacityError();
      }
      const agentId = await this.options.resolveAgent(task);
      if (!isEntityIdentifier(agentId)) throw new OrchestrationError('Agent resolver returned an invalid Agent identifier.');
      if (!(await this.options.execution.validateAgent(agentId))) {
        throw new OrchestrationError(`Agent "${agentId}" is not available for execution.`);
      }
      if (!(await this.options.authorization.authorize({
        actor_id: agentId,
        action: 'execute',
        resource_id: task.entity_id,
      }))) {
        throw new OrchestrationError(`Execution denied for Agent "${agentId}" on Task "${task.entity_id}".`);
      }
      plan.push({ task, agentId });
    }

    let currentWorkflow = this.workflows.transitionLifecycle(stored.entity_id, 'validated', actorId);
    currentWorkflow = this.workflows.transitionLifecycle(stored.entity_id, 'active', actorId);

    try {
      for (const item of plan) {
        let task = this.tasks.updateTask(item.task.entity_id, {
          assigned_agent: item.agentId,
          assigned_workflow: stored.entity_id,
        });
        task = this.tasks.transitionTaskLifecycle(task.entity_id, 'validated', item.agentId);
        task = this.tasks.transitionTaskLifecycle(task.entity_id, 'active', item.agentId);

        await this.assertNotCancelled(task.entity_id);
        const result = await this.options.execution.executeTask(item.agentId, task);
        // A late result is not completion. Check the durable cancellation view before the
        // verifier runs and again before any evidence or lifecycle write.
        await this.assertNotCancelled(task.entity_id);
        const verified = await this.verifyResult(result, task, [item.agentId]);
        await this.assertNotCancelled(task.entity_id);
        const evidenceId = this.persistExecutionEvidence(task, [item.agentId], verified.verifier_id, verified.result, verified.decision);
        await this.assertNotCancelled(task.entity_id);
        this.tasks.updateTask(task.entity_id, {
          audit_trail_ref: evidenceId,
          ...(task.actions.length > 0 ? { actions: verified.result.completed_actions ?? [] } : {}),
        });
        this.tasks.transitionTaskLifecycle(task.entity_id, 'completed', item.agentId);
      }
      this.workflows.transitionLifecycle(stored.entity_id, 'completed', actorId);
      return { workflow_id: stored.entity_id };
    } catch (error) {
      const activeTask = plan
        .map(({ task }) => this.tasks.getTask(task.entity_id))
        .find((task) => task?.lifecycle_state === 'active');
      if (activeTask) this.tasks.transitionTaskLifecycle(activeTask.entity_id, 'suspended', activeTask.assigned_agent ?? actorId);
      currentWorkflow = this.workflows.get(stored.entity_id) ?? currentWorkflow;
      if (currentWorkflow.lifecycle_state === 'active') {
        this.workflows.transitionLifecycle(stored.entity_id, 'suspended', actorId);
      }
      throw error;
    }
  }

  /**
   * Deliberately resumes a suspended Workflow (ADR-0022).
   *
   * Authorization for `resume` on the Workflow happens before lookup, matching cancel.
   * Completed Tasks are skipped, interrupted Tasks get a new `resume` attempt, and
   * `created` Tasks execute normally. A failed, cancelled, or unverified-completed sibling
   * blocks the whole resume with a typed conflict; it is never silently retried.
   */
  async resumeWorkflow(workflowId: string, actorId: string): Promise<WorkflowResumeResult> {
    if (!isEntityIdentifier(workflowId) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError('Workflow resume requires a valid Workflow and actor identifier.');
    }
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'resume',
      resource_id: workflowId,
    }))) {
      throw new OrchestrationError('Workflow resume denied by authorization policy.');
    }

    const stored = this.workflows.get(workflowId);
    if (!stored) throw new OrchestrationError(`Workflow "${workflowId}" was not found.`);
    if (stored.lifecycle_state === 'completed' || stored.lifecycle_state === 'archived') {
      return {
        workflow_id: stored.entity_id,
        lifecycle_state: stored.lifecycle_state,
        resumed: false,
        attempts: [],
      };
    }
    if (stored.lifecycle_state !== 'suspended') {
      throw new ExecutionAttemptConflictError(
        `Workflow "${stored.entity_id}" is ${stored.lifecycle_state}; only a suspended Workflow can be resumed.`,
      );
    }

    const plan = await this.buildWorkflowResumePlan(stored, actorId);
    const claimed = [
      stored.entity_id,
      ...plan.filter((item) => item.mode !== 'skip').map((item) => item.task.entity_id),
    ];
    this.claimRedrives(claimed);
    try {
      if (plan.some((item) => item.mode !== 'skip')
        && this.options.execution.hasCapacity && !this.options.execution.hasCapacity()) {
        // Same non-blocking, deterministic rejection as dispatch: before any lifecycle write.
        throw new ExecutionCapacityError();
      }

      this.workflows.transitionLifecycle(stored.entity_id, 'active', actorId);
      try {
      const attempts: TaskAttemptSummary[] = [];
      for (const item of plan) {
        if (item.mode === 'skip') continue;
        let task = this.tasks.updateTask(item.task.entity_id, {
          assigned_agent: item.agentId,
          assigned_workflow: stored.entity_id,
        });
        if (item.mode === 'resume') {
          task = this.tasks.transitionTaskLifecycle(task.entity_id, 'active', item.agentId);
        } else {
          task = this.tasks.transitionTaskLifecycle(task.entity_id, 'validated', item.agentId);
          task = this.tasks.transitionTaskLifecycle(task.entity_id, 'active', item.agentId);
        }

        await this.assertNotCancelled(task.entity_id);
        const result = await this.options.execution.executeTask(
          item.agentId,
          task,
          item.mode === 'resume'
            ? { kind: 'resume', previous_execution_id: item.previousExecutionId }
            : undefined,
        );
        await this.assertNotCancelled(task.entity_id);
        const verified = await this.verifyResult(result, task, [item.agentId]);
        await this.assertNotCancelled(task.entity_id);
        const evidenceId = this.persistExecutionEvidence(
          task,
          [item.agentId],
          verified.verifier_id,
          verified.result,
          verified.decision,
        );
        await this.assertNotCancelled(task.entity_id);
        this.tasks.updateTask(task.entity_id, {
          audit_trail_ref: evidenceId,
          ...(task.actions.length > 0 ? { actions: verified.result.completed_actions ?? [] } : {}),
        });
        this.tasks.transitionTaskLifecycle(task.entity_id, 'completed', item.agentId);
        const observation = await this.latestExecution(task.entity_id);
        if (observation) attempts.push(executionSummary(observation));
      }
      const completed = this.workflows.transitionLifecycle(stored.entity_id, 'completed', actorId);
      return {
        workflow_id: completed.entity_id,
        lifecycle_state: completed.lifecycle_state,
        resumed: true,
        attempts,
      };
    } catch (error) {
      const activeTask = plan
        .filter((item) => item.mode !== 'skip')
        .map((item) => this.tasks.getTask(item.task.entity_id))
        .find((task) => task?.lifecycle_state === 'active');
      if (activeTask) {
        this.tasks.transitionTaskLifecycle(
          activeTask.entity_id,
          'suspended',
          activeTask.assigned_agent ?? actorId,
        );
      }
      const current = this.workflows.get(stored.entity_id);
      if (current?.lifecycle_state === 'active') {
        this.workflows.transitionLifecycle(stored.entity_id, 'suspended', actorId);
      }
      throw error;
      }
    } finally {
      this.releaseRedrives(claimed);
    }
  }

  /** Deliberately resumes one suspended Task whose latest attempt is `interrupted`. */
  async resumeTask(taskId: string, actorId: string): Promise<TaskResumeResult> {
    const redriven = await this.redriveTask(taskId, actorId, 'resume');
    return {
      task_id: redriven.task.entity_id,
      lifecycle_state: redriven.task.lifecycle_state,
      resumed: redriven.executed,
      ...(redriven.execution === undefined ? {} : { execution: redriven.execution }),
    };
  }

  /**
   * Deliberately retries one Task after `failed`, `cancelled`, or an unverified `completed`
   * attempt. The terminal record is preserved; a distinct attempt is appended.
   */
  async retryTask(taskId: string, actorId: string): Promise<TaskRetryResult> {
    const redriven = await this.redriveTask(taskId, actorId, 'retry');
    return {
      task_id: redriven.task.entity_id,
      lifecycle_state: redriven.task.lifecycle_state,
      retried: redriven.executed,
      ...(redriven.execution === undefined ? {} : { execution: redriven.execution }),
    };
  }

  private async redriveTask(
    taskId: string,
    actorId: string,
    action: 'resume' | 'retry',
  ): Promise<{ task: TaskEntity; executed: boolean; execution?: TaskAttemptSummary }> {
    if (!isEntityIdentifier(taskId) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError(`Task ${action} requires a valid Task and actor identifier.`);
    }
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action,
      resource_id: taskId,
    }))) {
      throw new OrchestrationError(`Task ${action} denied by authorization policy.`);
    }

    const stored = this.tasks.getTask(taskId);
    if (!stored) throw new OrchestrationError(`Task "${taskId}" was not found.`);
    if (stored.lifecycle_state === 'completed' || stored.lifecycle_state === 'archived') {
      return { task: stored, executed: false };
    }
    if (stored.lifecycle_state === 'active'
      || stored.lifecycle_state === 'monitored'
      || stored.lifecycle_state === 'validated') {
      throw new ExecutionAttemptConflictError(
        `Task "${taskId}" is still ${stored.lifecycle_state}; it cannot be redriven while it is active.`,
      );
    }
    if (action === 'resume' && stored.lifecycle_state !== 'suspended') {
      throw new ExecutionAttemptConflictError(
        `Task "${taskId}" is ${stored.lifecycle_state}; only a suspended Task can be resumed.`,
      );
    }
    if (action === 'retry' && stored.lifecycle_state !== 'suspended' && stored.lifecycle_state !== 'created') {
      throw new ExecutionAttemptConflictError(
        `Task "${taskId}" is ${stored.lifecycle_state} and cannot be retried.`,
      );
    }

    const latest = await this.latestExecution(taskId);
    if (!latest) {
      throw new ExecutionAttemptConflictError(`Task "${taskId}" has no execution attempt to ${action}.`);
    }
    if (action === 'resume') {
      if (latest.state === 'cancelled') {
        throw new ExecutionAttemptConflictError(
          'A cancelled execution cannot be resumed; request an authorized retry instead.',
        );
      }
      if (latest.state !== 'interrupted') {
        throw new ExecutionAttemptConflictError(
          `Only an interrupted execution can be resumed; the latest attempt is "${latest.state}".`,
        );
      }
    } else {
      if (latest.state === 'running') {
        throw new ExecutionAttemptConflictError('A running execution cannot be retried.');
      }
      if (latest.state === 'interrupted') {
        throw new ExecutionAttemptConflictError('An interrupted execution must be resumed, not retried.');
      }
    }

    const claimed = [stored.entity_id];
    this.claimRedrives(claimed);
    try {
      const assigned = stored.assigned_agent;
      const observedAgent = isEntityIdentifier(latest.agent_id) ? latest.agent_id : undefined;
      const agentId = assigned ?? observedAgent ?? await this.options.resolveAgent(stored);
      await this.assertAgentExecutable(agentId, stored);

      // Same cap policy as dispatch: reject before the Task lifecycle changes.
      if (this.options.execution.hasCapacity && !this.options.execution.hasCapacity()) {
        throw new ExecutionCapacityError();
      }

      let task = this.tasks.updateTask(stored.entity_id, { assigned_agent: agentId });
    if (task.lifecycle_state === 'created') {
      task = this.tasks.transitionTaskLifecycle(task.entity_id, 'validated', agentId);
    }
    task = this.tasks.transitionTaskLifecycle(task.entity_id, 'active', agentId);

    try {
      // A retry is expected to follow a cancelled attempt, so the pre-dispatch check must
      // not treat that terminal predecessor as a live cancellation. Once the new attempt
      // exists, every post-execution check observes it normally; a cancellation that
      // arrives during the retry still stops verification and completion.
      if (action === 'resume') await this.assertNotCancelled(task.entity_id);
      const result = await this.options.execution.executeTask(agentId, task, {
        kind: action,
        previous_execution_id: latest.execution_id,
      });
      await this.assertNotCancelled(task.entity_id);
      const verified = await this.verifyResult(result, task, [agentId]);
      await this.assertNotCancelled(task.entity_id);
      const evidenceId = this.persistExecutionEvidence(
        task,
        [agentId],
        verified.verifier_id,
        verified.result,
        verified.decision,
      );
      await this.assertNotCancelled(task.entity_id);
      this.tasks.updateTask(task.entity_id, {
        audit_trail_ref: evidenceId,
        ...(task.actions.length > 0 ? { actions: verified.result.completed_actions ?? [] } : {}),
      });
      const completed = this.tasks.transitionTaskLifecycle(task.entity_id, 'completed', agentId);
      const observation = await this.latestExecution(task.entity_id);
      return {
        task: completed,
        executed: true,
        ...(observation === undefined ? {} : { execution: executionSummary(observation) }),
      };
    } catch (error) {
      const current = this.tasks.getTask(task.entity_id);
      if (current && (current.lifecycle_state === 'active' || current.lifecycle_state === 'monitored')) {
        this.tasks.transitionTaskLifecycle(current.entity_id, 'suspended', agentId);
      }
      throw error;
      }
    } finally {
      this.releaseRedrives(claimed);
    }
  }

  private async buildWorkflowResumePlan(
    stored: WorkflowEntity,
    actorId: string,
  ): Promise<WorkflowResumePlanItem[]> {
    if (stored.steps.length === 0) throw new OrchestrationError('Cannot resume a Workflow with no steps.');
    if (new Set(stored.steps).size !== stored.steps.length) {
      throw new OrchestrationError('Workflow steps must not contain duplicate Task IDs.');
    }

    const plan: WorkflowResumePlanItem[] = [];
    for (const taskId of stored.steps) {
      const task = this.tasks.getTask(taskId);
      if (!task) throw new OrchestrationError(`Workflow step Task "${taskId}" does not exist.`);
      if (task.lifecycle_state === 'completed' || task.lifecycle_state === 'archived') {
        plan.push({ mode: 'skip', task });
        continue;
      }
      if (task.lifecycle_state === 'active'
        || task.lifecycle_state === 'monitored'
        || task.lifecycle_state === 'validated') {
        throw new ExecutionAttemptConflictError(
          `Task "${taskId}" is still ${task.lifecycle_state}; it cannot be resumed twice.`,
        );
      }

      const latest = await this.latestExecution(taskId);
      if (latest) {
        if (latest.state === 'running') {
          throw new ExecutionAttemptConflictError(`Task "${taskId}" has a running execution attempt.`);
        }
        if (latest.state === 'failed' || latest.state === 'cancelled') {
          throw new ExecutionAttemptConflictError(
            `Task "${taskId}" is blocked by a ${latest.state} execution; an authorized Task retry is required before the Workflow can resume.`,
          );
        }
        if (latest.state === 'completed') {
          throw new ExecutionAttemptConflictError(
            `Task "${taskId}" has a completed execution that was never verified; an authorized Task retry is required.`,
          );
        }
        if (task.lifecycle_state !== 'suspended') {
          throw new ExecutionAttemptConflictError(
            `Task "${taskId}" has an interrupted execution but is ${task.lifecycle_state}; only a suspended Task can be resumed.`,
          );
        }
        if (!(await this.options.authorization.authorize({
          actor_id: actorId,
          action: 'resume',
          resource_id: taskId,
        }))) {
          throw new OrchestrationError(`Task resume denied by authorization policy for Task "${taskId}".`);
        }
        await this.assertAgentExecutable(latest.agent_id, task);
        plan.push({
          mode: 'resume',
          task,
          agentId: latest.agent_id,
          previousExecutionId: latest.execution_id,
        });
        continue;
      }

      if (task.lifecycle_state !== 'created') {
        throw new ExecutionAttemptConflictError(
          `Task "${taskId}" is ${task.lifecycle_state} with no execution attempt; it cannot be resumed.`,
        );
      }
      if (task.assigned_agent) {
        throw new OrchestrationError(`Task "${taskId}" is already assigned to an Agent.`);
      }
      if (task.assigned_workflow && task.assigned_workflow !== stored.entity_id) {
        throw new OrchestrationError(`Task "${taskId}" is already assigned to another Workflow.`);
      }
      const agentId = await this.options.resolveAgent(task);
      await this.assertAgentExecutable(agentId, task);
      plan.push({ mode: 'execute', task, agentId });
    }
    return plan;
  }

  private async latestExecution(taskId: string): Promise<TaskExecutionObservation | undefined> {
    return this.options.executionState?.latest(taskId);
  }

  private async assertAgentExecutable(agentId: string, task: TaskEntity): Promise<void> {
    if (!isEntityIdentifier(agentId)) {
      throw new OrchestrationError('Agent resolver returned an invalid Agent identifier.');
    }
    if (!(await this.options.execution.validateAgent(agentId))) {
      throw new OrchestrationError(`Agent "${agentId}" is not available for execution.`);
    }
    if (!(await this.options.authorization.authorize({
      actor_id: agentId,
      action: 'execute',
      resource_id: task.entity_id,
    }))) {
      throw new OrchestrationError(`Execution denied for Agent "${agentId}" on Task "${task.entity_id}".`);
    }
  }

  async coordinate(agents: string[], task: TaskEntity, actorId: string): Promise<void> {
    if (!Array.isArray(agents) || !task || !isEntityIdentifier(task.entity_id) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError('Coordination requires Agent IDs, a valid Task, and a valid actor identifier.');
    }
    const uniqueAgents = [...new Set(agents)];
    if (uniqueAgents.length < 2 || uniqueAgents.length !== agents.length) {
      throw new OrchestrationError('Coordination requires at least two distinct Agent IDs.');
    }
    const current = this.tasks.getTask(task.entity_id);
    if (!current || current.lifecycle_state !== 'created') {
      throw new OrchestrationError('Coordination requires an existing Task in created state.');
    }
    if (current.assigned_agent || current.assigned_workflow) {
      throw new OrchestrationError('Coordination cannot take a Task already assigned to an Agent or Workflow.');
    }

    if (!(await this.options.authorization.authorize({ actor_id: actorId, action: 'coordinate', resource_id: current.entity_id }))) {
      throw new OrchestrationError('Coordination request denied by authorization policy.');
    }

    for (const agentId of uniqueAgents) {
      if (!isEntityIdentifier(agentId)) throw new OrchestrationError('Coordination contains an invalid Agent identifier.');
      if (!(await this.options.execution.validateAgent(agentId))) {
        throw new OrchestrationError(`Agent "${agentId}" is not available for coordination.`);
      }
      if (!(await this.options.authorization.authorize({
        actor_id: agentId,
        action: 'coordinate',
        resource_id: current.entity_id,
      }))) {
        throw new OrchestrationError(`Coordination denied for Agent "${agentId}".`);
      }
    }

    const primaryAgentId = uniqueAgents[0];
    if (!primaryAgentId) throw new OrchestrationError('Coordination requires at least one Agent.');
    this.tasks.updateTask(current.entity_id, { assigned_agent: primaryAgentId });
    this.tasks.transitionTaskLifecycle(current.entity_id, 'validated', actorId);
    const active = this.tasks.transitionTaskLifecycle(current.entity_id, 'active', actorId);
    try {
      await this.assertNotCancelled(active.entity_id);
      const result = await this.options.execution.coordinate(uniqueAgents, active);
      await this.assertNotCancelled(active.entity_id);
      const verified = await this.verifyResult(result, active, uniqueAgents);
      await this.assertNotCancelled(active.entity_id);
      const evidenceId = this.persistExecutionEvidence(active, uniqueAgents, verified.verifier_id, verified.result, verified.decision);
      await this.assertNotCancelled(active.entity_id);
      this.tasks.updateTask(active.entity_id, {
        audit_trail_ref: evidenceId,
        ...(active.actions.length > 0 ? { actions: verified.result.completed_actions ?? [] } : {}),
      });
      this.tasks.transitionTaskLifecycle(current.entity_id, 'completed', actorId);
    } catch (error) {
      this.tasks.transitionTaskLifecycle(current.entity_id, 'suspended', actorId);
      throw error;
    }
  }

  async getWorkflow(workflowId: string, actorId: string): Promise<WorkflowEntity> {
    if (!isEntityIdentifier(workflowId) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError('Workflow reads require valid Workflow and actor identifiers.');
    }
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new OrchestrationError(`Workflow "${workflowId}" was not found.`);
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'read_status',
      resource_id: workflow.entity_id,
    }))) {
      throw new OrchestrationError('Workflow read denied by authorization policy.');
    }
    return workflow;
  }

  async status(handle: WorkflowRunHandle, actorId: string): Promise<LifecycleState> {
    const workflow = await this.getWorkflow(handle.workflow_id, actorId);
    return workflow.lifecycle_state;
  }

  async getExecutionEvidence(evidenceId: string, taskId: string, actorId: string): Promise<ArtifactEntity> {
    if (!isEntityIdentifier(evidenceId) || !isEntityIdentifier(taskId) || !isActorIdentifier(actorId)) {
      throw new OrchestrationError('Execution evidence reads require valid evidence, Task, and actor identifiers.');
    }
    const evidence = this.evidence.get(evidenceId);
    if (!evidence) throw new OrchestrationError(`Execution evidence "${evidenceId}" was not found.`);
    const task = this.tasks.getTask(taskId);
    if (!task) throw new OrchestrationError(`Task "${taskId}" was not found.`);
    let evidenceTaskId: unknown;
    try {
      evidenceTaskId = JSON.parse(evidence.description ?? '{}').task_id;
    } catch {
      throw new OrchestrationError('Execution evidence has an invalid task reference.');
    }
    if (evidenceTaskId !== taskId || task.audit_trail_ref !== evidenceId) {
      throw new OrchestrationError('Execution evidence is not linked to the requested Task.');
    }
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'read_evidence',
      resource_id: task.entity_id,
    }))) {
      throw new OrchestrationError('Execution evidence read denied by authorization policy.');
    }
    return evidence;
  }

  private async assertNotCancelled(taskId: string): Promise<void> {
    if (this.options.cancellation && await this.options.cancellation.isCancelled(taskId)) {
      throw new TaskCancelledError(taskId);
    }
  }

  private persistExecutionEvidence(
    task: TaskEntity,
    agentIds: string[],
    verifierId: string,
    result: TaskExecutionResult,
    verification: TaskVerificationDecision,
  ): string {
    const primaryAgentId = agentIds[0];
    if (!primaryAgentId) throw new OrchestrationError('Execution evidence requires at least one Agent.');
    const now = new Date().toISOString();
    const artifact = this.evidence.create(ArtifactSchema.parse({
      entity_id: randomUUID(),
      entity_type: 'canonical_object',
      entity_subtype: 'artifact',
      artifact_kind: 'test_report',
      name: `Execution evidence: ${task.name}`,
      description: JSON.stringify({
        task_id: task.entity_id,
        agent_ids: agentIds,
        summary: result.summary,
        evidence: result.evidence,
        verifier_id: verifierId,
        verifier_accepted: verification.accepted,
        verifier_reason: verification.reason,
        verifier_evidence: verification.evidence,
        recorded_at: now,
      }),
      lifecycle_state: 'created',
      lifecycle_history: [],
      created_at: now,
      created_by: primaryAgentId,
      modified_at: now,
      version: 1,
      organizational_containers: [],
      owner_id: primaryAgentId,
      owner_type: 'agent',
      relationships: [],
    }));
    this.evidence.transitionLifecycle(artifact.entity_id, 'validated', primaryAgentId);
    this.evidence.transitionLifecycle(artifact.entity_id, 'active', primaryAgentId);
    const completed = this.evidence.transitionLifecycle(artifact.entity_id, 'completed', primaryAgentId);
    return completed.entity_id;
  }

  private async verifyResult(
    result: TaskExecutionResult,
    task: TaskEntity,
    allowedExecutors: string[],
  ): Promise<VerifiedExecution> {
    if (!result || typeof result !== 'object'
      || typeof result.summary !== 'string'
      || !Array.isArray(result.evidence)
      || !result.summary.trim()
      || result.evidence.length === 0
      || result.evidence.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new OrchestrationError(
        `Task "${task.entity_id}" was not completed: executor must return a summary and evidence.`,
      );
    }
    if (result.completed_actions !== undefined && !Array.isArray(result.completed_actions)) {
      throw new OrchestrationError(`Task "${task.entity_id}" received a malformed Action result collection.`);
    }
    const snapshot = deepFreeze(clonePlain({
      summary: result.summary,
      evidence: result.evidence,
      ...(result.completed_actions ? { completed_actions: result.completed_actions } : {}),
    }));
    const verificationTask = deepFreeze(clonePlain(task));

    if (task.actions.length > 0) {
    const completed = snapshot.completed_actions;
    const expectedIds = new Set(task.actions.map((action) => action.action_id));
    if (expectedIds.size !== task.actions.length) {
      throw new OrchestrationError(`Task "${task.entity_id}" contains duplicate Action IDs.`);
    }
    if (!Array.isArray(completed) || completed.length !== task.actions.length) {
      throw new OrchestrationError(`Task "${task.entity_id}" requires a complete Action result set.`);
    }
    const receivedIds = new Set(completed.map((action) => action.action_id));
    if (
      receivedIds.size !== expectedIds.size
      || [...expectedIds].some((id) => !receivedIds.has(id))
      || completed.some((action) => action.status !== 'completed' || !allowedExecutors.includes(action.executed_by))
    ) {
      throw new OrchestrationError(`Task "${task.entity_id}" has incomplete or invalid Action results.`);
      }
    }

    const verifierId = this.options.verification.verifier_id;
    if (!isActorIdentifier(verifierId) || allowedExecutors.includes(verifierId)) {
      throw new OrchestrationError(
        `Task "${task.entity_id}" was not completed: the verifier must have a valid identity distinct from every executor.`,
      );
    }
    if (!(await this.options.authorization.authorize({
      actor_id: verifierId,
      action: 'read_evidence',
      resource_id: task.entity_id,
    }))) {
      throw new OrchestrationError(
        `Task "${task.entity_id}" was not completed: verifier "${verifierId}" is not authorized to read the evidence.`,
      );
    }

    let verification: TaskVerificationDecision;
    try {
      verification = await this.options.verification.verify({
        task: verificationTask,
        agent_ids: [...allowedExecutors],
        execution_result: snapshot,
      });
    } catch {
      throw new OrchestrationError(`Task "${task.entity_id}" verification service failed; work remains unverified.`);
    }
    if (!verification || typeof verification !== 'object'
      || verification.accepted !== true
      || typeof verification.reason !== 'string'
      || !verification.reason.trim()
      || !Array.isArray(verification.evidence)
      || verification.evidence.length === 0
      || verification.evidence.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new OrchestrationError(`Task "${task.entity_id}" was not completed: independent verification rejected or supplied no evidence.`);
    }
    return { result: snapshot, decision: verification, verifier_id: verifierId };
  }
}
