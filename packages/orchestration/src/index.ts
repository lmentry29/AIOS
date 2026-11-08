import type { LifecycleState, TaskEntity, WorkflowEntity } from '@aios/core';
import { WorkflowEntity as WorkflowSchema } from '@aios/core';
import { ObjectStore } from '@aios/objects';
import type { TaskStore } from '@aios/work-hierarchy';

export interface WorkflowRunHandle {
  workflow_id: string;
}

export interface WorkIntakeRequest {
  kind: 'task' | 'workflow';
  task?: TaskEntity;
  workflow?: WorkflowEntity;
}

export interface TaskExecutionResult {
  /** Must be true only after the executor has checked the task's acceptance criteria. */
  verified: boolean;
  summary: string;
  evidence: string[];
  /** Required when the Task defines Actions; must report the complete final Action set. */
  completed_actions?: TaskEntity['actions'];
}

export interface AuthorizationRequest {
  actor_id: string;
  action: 'intake' | 'dispatch' | 'execute' | 'coordinate' | 'read_status';
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
  resolveAgent(task: TaskEntity): Promise<string>;
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
 * committed only after the execution adapter returns verified=true with evidence.
 * No permissive default authorization or fake executor is supplied.
 *
 * Persistence is currently the injected in-memory ObjectStore/TaskStore. A durable
 * database adapter, distributed locking, crash recovery, and idempotent outbox are
 * still required before deploying this kernel in production.
 */
export class OrchestrationKernel {
  private readonly workflows: ObjectStore<WorkflowEntity>;

  constructor(
    private readonly tasks: TaskStore,
    private readonly options: OrchestrationOptions,
    workflowStore?: ObjectStore<WorkflowEntity>,
  ) {
    this.workflows = workflowStore ?? new ObjectStore<WorkflowEntity>(WorkflowSchema);
  }

  async intake(request: WorkIntakeRequest, actorId: string): Promise<TaskEntity | WorkflowEntity> {
    if (request.kind === 'task') {
      if (!request.task) throw new OrchestrationError('Task intake requires a Task record.');
      const allowed = await this.options.authorization.authorize({
        actor_id: actorId,
        action: 'intake',
        resource_id: request.task.entity_id,
      });
      if (!allowed) throw new OrchestrationError('Task intake denied by authorization policy.');
      return this.tasks.createTask(request.task);
    }
    if (!request.workflow) throw new OrchestrationError('Workflow intake requires a Workflow record.');
    const allowed = await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'intake',
      resource_id: request.workflow.entity_id,
    });
    if (!allowed) throw new OrchestrationError('Workflow intake denied by authorization policy.');
    return this.workflows.create(request.workflow);
  }

  async dispatch(workflow: WorkflowEntity, actorId: string): Promise<WorkflowRunHandle> {
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'dispatch',
      resource_id: workflow.entity_id,
    }))) {
      throw new OrchestrationError('Workflow dispatch denied by authorization policy.');
    }

    const stored = this.workflows.get(workflow.entity_id) ?? this.workflows.create(workflow);
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

    let currentWorkflow = this.workflows.transitionLifecycle(stored.entity_id, 'validated', 'orchestration');
    currentWorkflow = this.workflows.transitionLifecycle(stored.entity_id, 'active', 'orchestration');

    try {
      for (const item of plan) {
        let task = this.tasks.updateTask(item.task.entity_id, {
          assigned_agent: item.agentId,
          assigned_workflow: stored.entity_id,
        });
        task = this.tasks.transitionTaskLifecycle(task.entity_id, 'validated', 'orchestration');
        task = this.tasks.transitionTaskLifecycle(task.entity_id, 'active', 'orchestration');

        const result = await this.options.execution.executeTask(item.agentId, task);
        this.assertVerifiedResult(result, task, [item.agentId]);
        if (task.actions.length > 0) {
          this.tasks.updateTask(task.entity_id, { actions: result.completed_actions });
        }
        this.tasks.transitionTaskLifecycle(task.entity_id, 'completed', 'orchestration');
      }
      this.workflows.transitionLifecycle(stored.entity_id, 'completed', 'orchestration');
      return { workflow_id: stored.entity_id };
    } catch (error) {
      const activeTask = plan
        .map(({ task }) => this.tasks.getTask(task.entity_id))
        .find((task) => task?.lifecycle_state === 'active');
      if (activeTask) this.tasks.transitionTaskLifecycle(activeTask.entity_id, 'suspended', 'orchestration');
      currentWorkflow = this.workflows.get(stored.entity_id) ?? currentWorkflow;
      if (currentWorkflow.lifecycle_state === 'active') {
        this.workflows.transitionLifecycle(stored.entity_id, 'suspended', 'orchestration');
      }
      throw error;
    }
  }

  async coordinate(agents: string[], task: TaskEntity, actorId: string): Promise<void> {
    const uniqueAgents = [...new Set(agents)];
    if (uniqueAgents.length < 2 || uniqueAgents.length !== agents.length) {
      throw new OrchestrationError('Coordination requires at least two distinct Agent IDs.');
    }
    const current = this.tasks.getTask(task.entity_id);
    if (!current || current.lifecycle_state !== 'created') {
      throw new OrchestrationError('Coordination requires an existing Task in created state.');
    }

    if (!(await this.options.authorization.authorize({ actor_id: actorId, action: 'coordinate', resource_id: current.entity_id }))) {
      throw new OrchestrationError('Coordination request denied by authorization policy.');
    }

    for (const agentId of uniqueAgents) {
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

    this.tasks.transitionTaskLifecycle(current.entity_id, 'validated', 'orchestration');
    const active = this.tasks.transitionTaskLifecycle(current.entity_id, 'active', 'orchestration');
    try {
      const result = await this.options.execution.coordinate(uniqueAgents, active);
      this.assertVerifiedResult(result, active, uniqueAgents);
      if (active.actions.length > 0) {
        this.tasks.updateTask(active.entity_id, { actions: result.completed_actions });
      }
      this.tasks.transitionTaskLifecycle(current.entity_id, 'completed', 'orchestration');
    } catch (error) {
      this.tasks.transitionTaskLifecycle(current.entity_id, 'suspended', 'orchestration');
      throw error;
    }
  }

  async status(handle: WorkflowRunHandle, actorId: string): Promise<LifecycleState> {
    const workflow = this.workflows.get(handle.workflow_id);
    if (!workflow) throw new OrchestrationError(`Workflow "${handle.workflow_id}" was not found.`);
    if (!(await this.options.authorization.authorize({
      actor_id: actorId,
      action: 'read_status',
      resource_id: workflow.entity_id,
    }))) {
      throw new OrchestrationError('Workflow status read denied by authorization policy.');
    }
    return workflow.lifecycle_state;
  }

  private assertVerifiedResult(
    result: TaskExecutionResult,
    task: TaskEntity,
    allowedExecutors: string[],
  ): void {
    if (!result.verified || !result.summary.trim() || result.evidence.length === 0) {
      throw new OrchestrationError(
        `Task "${task.entity_id}" was not completed: executor must return verified=true, a summary, and evidence.`,
      );
    }
    if (task.actions.length === 0) return;
    const completed = result.completed_actions;
    const expectedIds = new Set(task.actions.map((action) => action.action_id));
    if (!completed || completed.length !== task.actions.length) {
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
}
