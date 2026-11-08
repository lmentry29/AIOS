import { describe, expect, it } from 'vitest';
import { TaskEntity } from '@aios/core';
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
    work_hierarchy_parent: { entity_id: crypto.randomUUID(), level: 'objective' as const },
    actions: [],
    ...overrides,
  };
}

describe('TaskStore and TaskEntity lifecycle contract', () => {
  it('creates and retrieves a Task, preserving all Task-specific fields', () => {
    const store = new TaskStore();
    const created = store.createTask(baseTask() as never);
    expect(store.getTask(created.entity_id)?.work_hierarchy_parent.level).toBe('objective');
    expect(store.getTask(created.entity_id)?.actions).toEqual([]);
  });

  it('persists assigned_agent through updateTask()', () => {
    const store = new TaskStore();
    const created = store.createTask(baseTask() as never);
    const agentId = crypto.randomUUID();
    const updated = store.updateTask(created.entity_id, { assigned_agent: agentId });
    expect(updated.assigned_agent).toBe(agentId);
  });

  it('transitions canonical Task lifecycle without inventing a Task substate', () => {
    const store = new TaskStore();
    const created = store.createTask(baseTask() as never);
    const agentId = crypto.randomUUID();
    store.updateTask(created.entity_id, { assigned_agent: agentId });
    const transitioned = store.transitionTaskLifecycle(created.entity_id, 'active', agentId);
    expect(transitioned.lifecycle_state).toBe('active');
    expect(transitioned.lifecycle_history).toHaveLength(1);
    expect(transitioned.lifecycle_history[0]?.substate).toBeUndefined();
    expect(transitioned.assigned_agent).toBe(agentId);
  });

  it('rejects a top-level Task lifecycle_substate', () => {
    expect(() => TaskEntity.parse(baseTask({ lifecycle_substate: 'executing' }))).toThrow();
  });

  it('rejects a Task lifecycle_history entry with a substate', () => {
    const now = new Date().toISOString();
    expect(() => TaskEntity.parse(baseTask({
      lifecycle_history: [{ state: 'active', substate: 'executing', entered_at: now, actor: 'human:founder' }],
    }))).toThrow();
  });
});
