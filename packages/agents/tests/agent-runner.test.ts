import { describe, expect, it } from 'vitest';
import { TaskStore } from '@aios/work-hierarchy';
import { AgentRunner } from '../src/agent-runner.js';

function baseAgent(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: crypto.randomUUID(),
    entity_type: 'agent' as const,
    name: 'test agent',
    lifecycle_state: 'created' as const,
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human' as const,
    relationships: [],
    current_role: 'agent' as const,
    governing_layer: 'runtime_coordination_kernel' as const,
    assigned_tasks: [],
    capabilities: [],
    ...overrides,
  };
}

function baseTask(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: crypto.randomUUID(),
    entity_type: 'task' as const,
    name: 'vertical slice task',
    lifecycle_state: 'created' as const,
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human' as const,
    relationships: [],
    work_hierarchy_parent: { entity_id: crypto.randomUUID(), level: 'objective' as const },
    actions: [],
    ...overrides,
  };
}

describe('AgentRunner — Agent lifecycle harness against a real Task record', () => {
  it('records the Agent lifecycle and Task state transitions without executing Task actions', () => {
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);

    const task = taskStore.createTask(baseTask() as never);
    const agent = runner.createAgent(baseAgent() as never);

    const result = runner.runFullLifecycle(agent.entity_id, task.entity_id);

    expect(result.agent.lifecycle_state).toBe('completed');
    expect(result.task?.lifecycle_state).toBe('completed');
    expect(result.task?.assigned_agent).toBe(agent.entity_id);
    expect(result.agent.assigned_tasks).toContain(task.entity_id);
    // 6 transitions: validated, active/planning, active/reasoning,
    // active/executing, active/monitoring, completed
    expect(result.agent.lifecycle_history).toHaveLength(6);
    expect(result.agent.lifecycle_history.map((entry) => entry.state)).toEqual([
      'validated',
      'active',
      'active',
      'active',
      'active',
      'completed',
    ]);
    expect(result.agent.lifecycle_history.map((entry) => entry.substate)).toEqual([
      undefined,
      'planning',
      'reasoning',
      'executing',
      'monitoring',
      undefined,
    ]);
    expect(result.agent.version).toBe(agent.version + 7);
    expect(result.task?.version).toBe(task.version + 4);
    expect(
      result.agent.lifecycle_history.every((entry) => entry.entered_at <= result.agent.modified_at),
    ).toBe(true);
  });

  it('returns detached Agent snapshots that cannot mutate runner state', () => {
    const runner = new AgentRunner(new TaskStore());
    const agent = runner.createAgent(baseAgent() as never);

    agent.name = 'mutated create result';
    const fetched = runner.getAgent(agent.entity_id);
    if (!fetched) throw new Error('Created Agent was not retrievable.');
    fetched.name = 'mutated get result';

    expect(runner.getAgent(agent.entity_id)?.name).toBe('test agent');
  });

  it('rejects duplicate Agent identities instead of replacing the stored Agent', () => {
    const runner = new AgentRunner(new TaskStore());
    const agent = baseAgent();
    runner.createAgent(agent as never);

    expect(() => runner.createAgent(agent as never)).toThrow(/already exists/);
    expect(runner.getAgent(agent.entity_id)?.version).toBe(agent.version);
  });

  it('preflights the Task before mutating the Agent', () => {
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);
    const agent = runner.createAgent(baseAgent() as never);

    expect(() => runner.runFullLifecycle(agent.entity_id, crypto.randomUUID())).toThrow(
      /No task found/,
    );

    const unchanged = runner.getAgent(agent.entity_id);
    expect(unchanged?.lifecycle_state).toBe('created');
    expect(unchanged?.lifecycle_history).toHaveLength(0);
    expect(unchanged?.version).toBe(agent.version);
  });


  it('does not take a Task already assigned to another Agent', () => {
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);
    const task = taskStore.createTask(baseTask({ assigned_agent: crypto.randomUUID() }) as never);
    const agent = runner.createAgent(baseAgent() as never);

    expect(() => runner.runFullLifecycle(agent.entity_id, task.entity_id)).toThrow(
      /already assigned to Agent/,
    );
    expect(runner.getAgent(agent.entity_id)?.lifecycle_state).toBe('created');
    expect(runner.getAgent(agent.entity_id)?.assigned_tasks).toEqual([]);
    expect(taskStore.getTask(task.entity_id)?.assigned_agent).toBe(task.assigned_agent);
    expect(taskStore.getTask(task.entity_id)?.version).toBe(task.version);
  });

  it('rejects re-running a completed Agent execution loop', () => {
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);
    const task = taskStore.createTask(baseTask() as never);
    const agent = runner.createAgent(baseAgent() as never);
    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    expect(() => runner.runFullLifecycle(agent.entity_id, task.entity_id)).toThrow(
      /must be in created state/,
    );
  });

});
