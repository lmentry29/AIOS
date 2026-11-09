import { randomUUID } from 'node:crypto';
import type { ArtifactEntity, LifecycleState, TaskEntity, WorkflowEntity } from '@aios/core';
import { ArtifactEntity as ArtifactSchema, WorkflowEntity as WorkflowSchema } from '@aios/core';
import { ObjectStore } from '@aios/objects';
import type { TaskStore } from '@aios/work-hierarchy';

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

export interface VerifiedExecution {
  result: TaskExecutionResult;
  decision: TaskVerificationDecision;
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
  verify(request: TaskVerificationRequest): Promise<TaskVerificationDecision>;
}

export interface AuthorizationRequest {
  actor_id: string;
  action: 'intake' | 'dispatch' | 'execute' | 'coordinate' | 'read_status' | 'read_evidence';
  resource_id: string;
}

export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): Promise<boolean>;
}

export interface AgentExecutionPort {
  validateAgent(agentId: string): Promise<boolean>;
  executeTask(agentId: string, task: TaskEntity): Promise<TaskExecutionResult>;
  coordinate(agents: string[], task: TaskEntity): Promise<TaskExecutionResult>;
}

export interface OrchestrationOptions {
  authorization: AuthorizationPort;
  execution: AgentExecutionPort;
  verification: TaskVerificationPort;
  resolveAgent(task: TaskEntity): Promise<string>;
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
  private readonly workflows: ObjectStore<WorkflowEntity>;
  private readonly evidence: ObjectStore<ArtifactEntity>;

  constructor(
    private readonly tasks: TaskStore,
    private readonly options: OrchestrationOptions,
    workflowStore?: ObjectStore<WorkflowEntity>,
    evidenceStore?: ObjectStore<ArtifactEntity>,
  ) {
    this.workflows = workflowStore ?? new ObjectStore<WorkflowEntity>(WorkflowSchema);
    this.evidence = evidenceStore ?? new ObjectStore<ArtifactEntity>(ArtifactSchema);
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

        const result = await this.options.execution.executeTask(item.agentId, task);
        const verified = await this.verifyResult(result, task, [item.agentId]);
        const evidenceId = this.persistExecutionEvidence(task, [item.agentId], verified.result, verified.decision);
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
      const result = await this.options.execution.coordinate(uniqueAgents, active);
      const verified = await this.verifyResult(result, active, uniqueAgents);
      const evidenceId = this.persistExecutionEvidence(active, uniqueAgents, verified.result, verified.decision);
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

  private persistExecutionEvidence(
    task: TaskEntity,
    agentIds: string[],
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
    return { result: snapshot, decision: verification };
  }
}
