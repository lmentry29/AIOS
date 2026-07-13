import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/task-store.js';

function baseTask(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: crypto.randomUUID(),
    entity_type: 'task' as const,
    name: 'implement vertical slice',
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
    work_hierarchy_parent: {
      entity_id: crypto.randomUUID(),
      level: 'objective' as const,
    },
    actions: [],
    ...overrides,
  };
}

describe('TaskStore', () => {
  it('creates and retrieves a Task, preserving all Task-specific fields', () => {
    const store = new TaskStore();
    const task = baseTask();
    const created = store.createTask(task as never);
    const retrieved = store.getTask(created.entity_id);

    expect(retrieved?.work_hierarchy_parent.level).toBe('objective');
    expect(retrieved?.actions).toEqual([]);
  });

  it('persists assigned_agent through updateTask() — resolves the COM §10 data-loss finding', () => {
    const store = new TaskStore();
    const task = baseTask();
    const created = store.createTask(task as never);
    const agentId = crypto.randomUUID();

    const updated = store.updateTask(created.entity_id, { assigned_agent: agentId });

    // Unlike @aios/objects' generic, base-schema-validated ObjectStore,
    // TaskStore validates against the full TaskEntity schema, so
    // assigned_agent is NOT stripped here.
    expect(updated.assigned_agent).toBe(agentId);
  });

  it('transitions Task lifecycle and appends history, keeping assigned_agent intact', () => {
    const store = new TaskStore();
    const task = baseTask();
    const created = store.createTask(task as never);
    const agentId = crypto.randomUUID();

    store.updateTask(created.entity_id, { assigned_agent: agentId });
    const transitioned = store.transitionTaskLifecycle(
      created.entity_id,
      'active',
      agentId,
      'executing'
    );

    expect(transitioned.lifecycle_state).toBe('active');
    expect(transitioned.lifecycle_history).toHaveLength(1);
    expect(transitioned.assigned_agent).toBe(agentId);
  });
});
