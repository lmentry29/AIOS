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

describe('AgentRunner — full Agent Execution Loop against a real Task', () => {
  it('runs an Agent through its complete lifecycle and completes the assigned Task', () => {
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);

    const task = taskStore.createTask(baseTask() as never);
    const agent = runner.createAgent(baseAgent() as never);

    const result = runner.runFullLifecycle(agent.entity_id, task.entity_id);

    expect(result.agent.lifecycle_state).toBe('completed');
    expect(result.task?.lifecycle_state).toBe('completed');
    expect(result.task?.assigned_agent).toBe(agent.entity_id);
    // 6 transitions: validated, active/planning, active/reasoning,
    // active/executing, active/monitoring, completed
    expect(result.agent.lifecycle_history).toHaveLength(6);
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
