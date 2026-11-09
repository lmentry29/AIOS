import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TaskEntity, WorkflowEntity } from '@aios/core';
import { TaskStore } from '@aios/work-hierarchy';
import {
  OrchestrationError,
  OrchestrationKernel,
  type AgentExecutionPort,
  type AuthorizationPort,
} from '../src/index.js';

const FOUNDER = 'human:founder';

function task(overrides: Record<string, unknown> = {}): TaskEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'task',
    name: 'verify release',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: 'human',
    relationships: [],
    work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    actions: [],
    ...overrides,
  } as TaskEntity;
}

function workflow(taskIds: string[], overrides: Record<string, unknown> = {}): WorkflowEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'workflow',
    name: 'release workflow',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: 'human',
    relationships: [],
    steps: taskIds,
    governing_loop: 'system_execution_loop',
    ...overrides,
  } as WorkflowEntity;
}

function harness(options: {
  allow?: boolean;
  verified?: boolean;
  throwOnExecute?: boolean;
} = {}) {
  const tasks = new TaskStore();
  const calls: string[] = [];
  let allowed = options.allow ?? true;
  const authorization: AuthorizationPort = {
    authorize: async (request) => {
      calls.push(`auth:${request.actor_id}:${request.action}:${request.resource_id}`);
      return allowed;
    },
  };
  const execution: AgentExecutionPort = {
    validateAgent: async () => true,
    executeTask: async (_agentId, currentTask) => {
      if (options.throwOnExecute) throw new Error('executor unavailable');
      return {
          summary: 'Acceptance criteria checked',
        evidence: ['build:passed'],
        completed_actions: currentTask.actions,
      };
    },
    coordinate: async (_agents, currentTask) => ({
      summary: 'Coordinated acceptance criteria checked',
      evidence: ['review:passed'],
      completed_actions: currentTask.actions,
    }),
  };
  const kernel = new OrchestrationKernel(tasks, {
    authorization,
    execution,
    verification: {
      verify: async () => ({
        accepted: options.verified ?? true,
        reason: options.verified === false ? 'test verifier rejection' : 'test verifier accepted',
        evidence: options.verified === false ? [] : ['verifier:acceptance-criteria-checked'],
      }),
    },
    resolveAgent: async () => randomUUID(),
  });
  return { tasks, kernel, calls, setAllowed: (value: boolean) => { allowed = value; } };
}

describe('OrchestrationKernel', () => {
  it('requires authorization for intake and persists a Task only after approval', async () => {
    const denied = harness({ allow: false });
    const candidate = task();
    await expect(denied.kernel.intake({ kind: 'task', task: candidate }, FOUNDER))
      .rejects.toBeInstanceOf(OrchestrationError);
    expect(denied.tasks.getTask(candidate.entity_id)).toBeUndefined();

    const allowed = harness();
    const accepted = await allowed.kernel.intake({ kind: 'task', task: candidate }, FOUNDER);
    expect(accepted.entity_id).toBe(candidate.entity_id);
  });

  it('executes ordered Workflow steps and records verifiable evidence before completion', async () => {
    const { tasks, kernel } = harness();
    const first = tasks.createTask(task());
    const second = tasks.createTask(task());
    const wf = workflow([first.entity_id, second.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: wf }, FOUNDER);

    const handle = await kernel.dispatch(wf, FOUNDER);

    expect(handle.workflow_id).toBe(wf.entity_id);
    expect((await kernel.getWorkflow(wf.entity_id, FOUNDER)).lifecycle_state).toBe('completed');
    for (const id of [first.entity_id, second.entity_id]) {
      const completed = tasks.getTask(id);
      expect(completed?.lifecycle_state).toBe('completed');
      expect(completed?.audit_trail_ref).toBeTruthy();
      const evidence = await kernel.getExecutionEvidence(completed?.audit_trail_ref ?? '', id, FOUNDER);
      expect(evidence?.artifact_kind).toBe('test_report');
      expect(evidence?.lifecycle_state).toBe('completed');
    }
  });

  it('fails closed when dispatch is denied and leaves Workflow and Tasks unchanged', async () => {
    const { tasks, kernel, setAllowed } = harness();
    const current = tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: wf }, FOUNDER);
    setAllowed(false);

    await expect(kernel.dispatch(wf, FOUNDER)).rejects.toBeInstanceOf(OrchestrationError);
    expect(tasks.getTask(current.entity_id)?.version).toBe(current.version);
  });

  it('does not dispatch a Workflow that bypassed authorized intake', async () => {
    const { kernel } = harness();
    const unaccepted = workflow([randomUUID()]);
    await expect(kernel.dispatch(unaccepted, FOUNDER)).rejects.toThrow(/authorized intake/);
  });

  it('records execution evidence for coordinated work', async () => {
    const { tasks, kernel } = harness();
    const current = tasks.createTask(task());
    await kernel.coordinate([randomUUID(), randomUUID()], current, FOUNDER);

    const completed = tasks.getTask(current.entity_id);
    expect(completed?.lifecycle_state).toBe('completed');
    expect(completed?.audit_trail_ref).toBeTruthy();
    expect((await kernel.getExecutionEvidence(completed?.audit_trail_ref ?? '', FOUNDER)).artifact_kind).toBe('test_report');
  });


  it('denies execution evidence reads after authorization is revoked', async () => {
    const { tasks, kernel, setAllowed } = harness();
    const current = tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: wf }, FOUNDER);
    await kernel.dispatch(wf, FOUNDER);
    const evidenceId = tasks.getTask(current.entity_id)?.audit_trail_ref;
    if (!evidenceId) throw new Error('Execution evidence was not linked to Task.');
    setAllowed(false);

    await expect(kernel.getExecutionEvidence(evidenceId, FOUNDER)).rejects.toThrow(/read denied/);
  });

  it('suspends active work instead of falsely completing it after executor failure', async () => {
    const { tasks, kernel } = harness({ throwOnExecute: true });
    const current = tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: wf }, FOUNDER);

    await expect(kernel.dispatch(wf, FOUNDER)).rejects.toThrow('executor unavailable');
    expect(tasks.getTask(current.entity_id)?.lifecycle_state).toBe('suspended');
    expect((await kernel.getWorkflow(wf.entity_id, FOUNDER)).lifecycle_state).toBe('suspended');
  });

  it('rejects an executor result without verification evidence', async () => {
    const { tasks, kernel } = harness({ verified: false });
    const current = tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: wf }, FOUNDER);

    await expect(kernel.dispatch(wf, FOUNDER)).rejects.toThrow(/independent verification rejected/);
    expect(tasks.getTask(current.entity_id)?.lifecycle_state).toBe('suspended');
  });

  it('rejects empty or duplicate workflow steps before any execution', async () => {
    const { tasks, kernel } = harness();
    const current = tasks.createTask(task());
    const empty = workflow([]);
    const duplicate = workflow([current.entity_id, current.entity_id]);
    await kernel.intake({ kind: 'workflow', workflow: empty }, FOUNDER);
    await kernel.intake({ kind: 'workflow', workflow: duplicate }, FOUNDER);

    await expect(kernel.dispatch(empty, FOUNDER)).rejects.toThrow(/no steps/);
    await expect(kernel.dispatch(duplicate, FOUNDER)).rejects.toThrow(/duplicate Task IDs/);
    expect(tasks.getTask(current.entity_id)?.lifecycle_state).toBe('created');
  });

  it('does not expose Workflow status to an unauthorized caller', async () => {
    const { kernel, setAllowed } = harness();
    const storedWorkflow = workflow([randomUUID()]);
    await kernel.intake({ kind: 'workflow', workflow: storedWorkflow }, FOUNDER);
    setAllowed(false);
    await expect(kernel.status({ workflow_id: storedWorkflow.entity_id }, FOUNDER))
      .rejects.toBeInstanceOf(OrchestrationError);
  });
});
