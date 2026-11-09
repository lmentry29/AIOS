import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TaskEntity, WorkflowEntity } from '@aios/core';
import { TaskStore } from '@aios/work-hierarchy';
import {
  OrchestrationError,
  OrchestrationKernel,
  type AgentExecutionPort,
  type AuthorizationPort,
} from '../src/index.js';

function task() {
  const now = new Date().toISOString();
  return TaskEntity.parse({
    entity_id: randomUUID(),
    entity_type: 'task',
    name: 'Write integration test',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human',
    relationships: [],
    work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    actions: [],
  });
}

function workflow(taskIds: string[]) {
  const now = new Date().toISOString();
  return WorkflowEntity.parse({
    entity_id: randomUUID(),
    entity_type: 'workflow',
    name: 'Test workflow',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human',
    relationships: [],
    steps: taskIds,
    governing_loop: 'system_execution_loop',
  });
}

function harness(overrides: {
  allowed?: boolean;
  verified?: boolean;
  evidence?: string[];
  denyAction?: string;
} = {}) {
  const tasks = new TaskStore();
  const agentId = randomUUID();
  const authorization: AuthorizationPort = {
    authorize: vi.fn(async (request) => (overrides.allowed ?? true) && request.action !== overrides.denyAction),
  };
  const execution: AgentExecutionPort = {
    validateAgent: vi.fn(async () => true),
    executeTask: vi.fn(async () => ({
      summary: 'Acceptance criteria checked',
      evidence: overrides.evidence ?? ['test-report-1'],
    })),
    coordinate: vi.fn(async () => ({
      summary: 'Coordination result checked',
      evidence: overrides.evidence ?? ['coordination-report-1'],
    })),
  };
  const kernel = new OrchestrationKernel(tasks, {
    authorization,
    execution,
    verification: {
      verify: async () => ({
        accepted: overrides.verified ?? true,
        reason: overrides.verified === false ? 'test verifier rejection' : 'test verifier accepted',
        evidence: overrides.verified === false ? [] : ['verifier:acceptance-criteria-checked'],
      }),
    },
    resolveAgent: async () => agentId,
  });
  return { tasks, agentId, authorization, execution, kernel };
}

describe('OrchestrationKernel', () => {
  it('dispatches ordered Tasks and completes only after verified execution', async () => {
    const h = harness();
    const first = h.tasks.createTask(task());
    const second = h.tasks.createTask(task());
    const wf = workflow([first.entity_id, second.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    const handle = await h.kernel.dispatch(wf, 'human:founder');

    expect(await h.kernel.status(handle, 'human:founder')).toBe('completed');
    expect((await h.kernel.getWorkflow(handle.workflow_id, 'human:founder')).lifecycle_history.every((entry) => entry.actor === 'human:founder')).toBe(true);
    expect(h.tasks.getTask(first.entity_id)?.lifecycle_state).toBe('completed');
    expect(h.tasks.getTask(second.entity_id)?.lifecycle_state).toBe('completed');
    expect(h.tasks.getTask(first.entity_id)?.lifecycle_history.every((entry) => entry.actor === h.agentId)).toBe(true);
    expect(h.tasks.getTask(first.entity_id)?.assigned_agent).toBe(h.agentId);
    const evidenceId = h.tasks.getTask(first.entity_id)?.audit_trail_ref;
    expect(evidenceId).toBeDefined();
    const evidence = evidenceId ? await h.kernel.getExecutionEvidence(evidenceId, first.entity_id, 'human:founder') : undefined;
    expect(evidence?.artifact_kind).toBe('test_report');
    expect(evidence?.lifecycle_state).toBe('completed');
    expect(evidence?.lifecycle_history).toHaveLength(3);
    expect(evidence?.description).toContain('Acceptance criteria checked');
    expect(h.execution.executeTask).toHaveBeenCalledTimes(2);
  });


  it('rejects empty and duplicate workflow steps before lifecycle changes', async () => {
    const h = harness();
    const empty = workflow([]);
    await h.kernel.intake({ kind: 'workflow', workflow: empty }, 'human:founder');
    await expect(h.kernel.dispatch(empty, 'human:founder')).rejects.toThrow(/no steps/);

    const t = h.tasks.createTask(task());
    const duplicate = workflow([t.entity_id, t.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: duplicate }, 'human:founder');
    await expect(h.kernel.dispatch(duplicate, 'human:founder')).rejects.toThrow(/duplicate Task IDs/);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('created');
  });

  it('does not reassign a Task already owned by an Agent', async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, { assigned_agent: randomUUID() });
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.dispatch(wf, 'human:founder')).rejects.toThrow(/already assigned to an Agent/);
    expect(h.execution.executeTask).not.toHaveBeenCalled();
  });


  it('requires every declared Task Action to be completed by an assigned Agent', async () => {
    const h = harness();
    const actionId = randomUUID();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, {
      actions: [{ action_id: actionId, status: 'pending', executed_by: h.agentId }],
    });
    h.execution.executeTask = vi.fn(async () => ({
      summary: 'Executor claims success',
      evidence: ['execution-evidence'],
      completed_actions: [{ action_id: actionId, status: 'completed', executed_by: h.agentId }],
    }));
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await h.kernel.dispatch(wf, 'human:founder');
    expect(h.tasks.getTask(t.entity_id)?.actions[0]?.status).toBe('completed');
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('completed');
  });

  it('does not complete a Task when an Action result is missing', async () => {
    const h = harness();
    const actionId = randomUUID();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, {
      actions: [{ action_id: actionId, status: 'pending', executed_by: h.agentId }],
    });
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.dispatch(wf, 'human:founder')).rejects.toThrow(/complete Action result set/);
    expect(h.tasks.getTask(t.entity_id)?.actions[0]?.status).toBe('pending');
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('suspended');
  });


  it('denies dispatch before changing Workflow lifecycle when requester lacks permission', async () => {
    const h = harness({ denyAction: 'dispatch' });
    const wf = workflow([randomUUID()]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.dispatch(wf, 'human:founder')).rejects.toThrow(/dispatch denied/);
    expect(await h.kernel.status({ workflow_id: wf.entity_id }, 'human:founder')).toBe('created');
  });

  it('denies Workflow reads when the requesting actor lacks permission', async () => {
    const h = harness({ denyAction: 'read_status' });
    const wf = workflow([]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.status({ workflow_id: wf.entity_id }, 'human:founder')).rejects.toThrow(/read denied/);
  });


  it('rejects forged created_by or owner_id values during intake', async () => {
    const h = harness();
    const wf = workflow([]);
    await expect(h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:attacker'))
      .rejects.toThrow(/provenance and ownership/);
    await expect(h.kernel.status({ workflow_id: wf.entity_id }, 'human:founder'))
      .rejects.toThrow(/not found/);
  });

  it('fails closed when intake authorization is denied', async () => {
    const h = harness({ allowed: false });
    const wf = workflow([]);
    await expect(h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder')).rejects.toThrow(
      /intake denied/,
    );
  });

  it('does not mark a Task completed when execution is unverified', async () => {
    const h = harness({ verified: false });
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.dispatch(wf, 'human:founder')).rejects.toBeInstanceOf(OrchestrationError);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('suspended');
  });

  it('preflights all workflow steps before dispatching any Task', async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id, randomUUID()]);
    await h.kernel.intake({ kind: 'workflow', workflow: wf }, 'human:founder');

    await expect(h.kernel.dispatch(wf, 'human:founder')).rejects.toThrow(/does not exist/);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('created');
    expect(h.execution.executeTask).not.toHaveBeenCalled();
  });

  it('requires at least two distinct Agents for coordination', async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    await expect(h.kernel.coordinate([h.agentId, h.agentId], t, 'human:founder')).rejects.toThrow(
      /at least two distinct/,
    );
  });

  it('suspends a coordinated Task when the result is not verified', async () => {
    const h = harness({ verified: false });
    const t = h.tasks.createTask(task());
    await expect(h.kernel.coordinate([h.agentId, randomUUID()], t, 'human:founder')).rejects.toThrow(
      /not completed/,
    );
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe('suspended');
  });
});
