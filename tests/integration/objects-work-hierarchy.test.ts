import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EntityIdConflictError } from '@aios/objects';
import { TaskStore } from '@aios/work-hierarchy';
import { FOUNDER, makeTask } from './fixtures.js';

/**
 * BOUNDARY: @aios/objects → @aios/work-hierarchy
 *
 * TaskStore is a thin wrapper that constructs ObjectStore<TaskEntity>. The contract
 * across this edge is that it INHERITS ObjectStore's COM guarantees rather than
 * reimplementing them — and that parameterizing with the full Task schema is what
 * stops Task-specific fields being silently stripped (COM §10).
 *
 * Testing that from inside @aios/work-hierarchy proves nothing: it would just be
 * re-testing ObjectStore through a different import path. What matters is that the
 * guarantees actually arrive intact, which is only observable here.
 *
 * Per runtime-interfaces.md §5, this edge is also where the Task/Object storage
 * question resolved: Option A won in practice — Task persists THROUGH the Object
 * Store, parameterized by the Task schema, rather than getting the separate backing
 * store Option B assumed. These tests pin that resolution.
 */

describe('objects → work-hierarchy: Task-specific fields survive persistence (COM §10)', () => {
  it('round-trips work_hierarchy_parent, assigned_agent, and actions', () => {
    const store = new TaskStore();
    const agentId = randomUUID();
    const objectiveId = randomUUID();

    const created = store.createTask(
      makeTask({
        assigned_agent: agentId,
        work_hierarchy_parent: { entity_id: objectiveId, level: 'objective' },
      }),
    );

    const fetched = store.getTask(created.entity_id);
    // A base-schema store would have discarded assigned_agent here. That it survives
    // is the whole reason ObjectStore takes a schema parameter.
    expect(fetched?.assigned_agent).toBe(agentId);
    expect(fetched?.work_hierarchy_parent).toEqual({
      entity_id: objectiveId,
      level: 'objective',
    });
    expect(fetched?.actions).toEqual([]);
  });

  it('keeps Task-specific fields through an update (not just on create)', () => {
    const store = new TaskStore();
    const agentId = randomUUID();
    const created = store.createTask(makeTask({ assigned_agent: agentId }));

    const updated = store.updateTask(created.entity_id, { name: 'renamed' });

    expect(updated.name).toBe('renamed');
    expect(updated.assigned_agent).toBe(agentId);
    expect(updated.work_hierarchy_parent.level).toBe('objective');
  });

  it('never merges work_hierarchy_parent into organizational_containers (AGENTS.md rule 4)', () => {
    // The single most-corrected defect in the entire architecture reconciliation —
    // four separate fix locations. If a write ever lets these two touch, that is a
    // defect, not a style preference. This is the cross-package guard.
    const store = new TaskStore();
    const objectiveId = randomUUID();
    const projectId = randomUUID();

    const created = store.createTask(
      makeTask({
        work_hierarchy_parent: { entity_id: objectiveId, level: 'objective' },
        organizational_containers: [{ entity_id: projectId, container_type: 'project' }],
      }),
    );

    const updated = store.updateTask(created.entity_id, { name: 'still separate' });

    // One singular hierarchy position; one array of containers. Different ids,
    // different shapes, neither leaking into the other.
    expect(updated.work_hierarchy_parent).toEqual({
      entity_id: objectiveId,
      level: 'objective',
    });
    expect(updated.organizational_containers).toEqual([
      { entity_id: projectId, container_type: 'project' },
    ]);
    expect(updated.work_hierarchy_parent.entity_id).not.toBe(
      updated.organizational_containers[0]?.entity_id,
    );
  });
});

describe('objects → work-hierarchy: ObjectStore’s COM guarantees arrive intact', () => {
  it('inherits identity rules — entity_id is not reusable after archival (COM §9)', () => {
    const store = new TaskStore();
    const task = makeTask();
    store.createTask(task);
    store.transitionTaskLifecycle(task.entity_id, 'archived', FOUNDER);

    // TaskStore does not implement this rule. It gets it from ObjectStore, and this
    // asserts the inheritance rather than the rule.
    expect(() => store.createTask(task)).toThrow(EntityIdConflictError);
  });

  it('inherits atomic version/modified_at bumps (COM §11)', async () => {
    const store = new TaskStore();
    const created = store.createTask(makeTask());

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.updateTask(created.entity_id, { name: 'bumped' });

    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });

  it('inherits append-only lifecycle_history (COM §11, AGENTS.md rule 5)', () => {
    const store = new TaskStore();
    const created = store.createTask(makeTask());

    store.transitionTaskLifecycle(created.entity_id, 'validated', FOUNDER);
    store.transitionTaskLifecycle(created.entity_id, 'active', FOUNDER, 'executing');
    const completed = store.transitionTaskLifecycle(created.entity_id, 'completed', FOUNDER);

    expect(completed.lifecycle_state).toBe('completed');
    expect(completed.lifecycle_history.map((h) => h.state)).toEqual([
      'validated',
      'active',
      'completed',
    ]);
  });

  it('validates against the Task schema, so a Task cannot be parented to a mission', () => {
    // ADR-0004's chain is Mission → Objective → Task: a Task's parent is always an
    // Objective. TaskStore gets this from core's schema via ObjectStore's parse.
    const store = new TaskStore();
    const bad = makeTask({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'mission' },
    });

    expect(() => store.createTask(bad)).toThrow();
  });

  it('lists only tasks', () => {
    const store = new TaskStore();
    store.createTask(makeTask({ name: 'a' }));
    store.createTask(makeTask({ name: 'b' }));

    const listed = store.listTasks();
    expect(listed).toHaveLength(2);
    expect(listed.every((t) => t.entity_type === 'task')).toBe(true);
  });
});
