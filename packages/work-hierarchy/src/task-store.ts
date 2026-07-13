import type { TaskEntity as TaskEntityType, LifecycleState } from '@aios/core';
import { TaskEntity } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';

/**
 * TaskStore — a thin, type-specific wrapper over @aios/objects'
 * ObjectStore, constructed with the full TaskEntity schema rather than
 * the base CanonicalEntity schema. This is the concrete resolution of
 * COM §10's open question for Task: Task persists through @aios/objects'
 * machinery (identity rules §9, atomic writes / append-only history
 * §11, Memory Object immutability §5.1 — all reused, not
 * reimplemented), through a store instance parameterized with
 * TaskEntity so Task-specific fields (assigned_agent, assigned_workflow,
 * actions, work_hierarchy_parent's required 'objective' level) survive
 * every write instead of being silently stripped, as documented in
 * @aios/objects' own COM §10 evidence test.
 *
 * OBJECTIVE IS NOW IMPLEMENTED — see ./objective-store.js. ADR-0010
 * (Accepted 2026-07-13) resolved the conflict this comment previously
 * flagged: an Objective is a Canonical Object subtype
 * (entity_subtype: 'objective', COM §5.3), so
 * work_hierarchy_parent.entity_id at level 'objective' now dereferences
 * to a real, persisted record rather than dangling.
 *
 * MISSION IS STILL NOT AN ENTITY, deliberately (ADR-0010 §3). The
 * corpus specifies no field-level model for Mission — unlike Objective,
 * which had Part VI Ch.4's field list — so promoting it would mean
 * inventing its fields, which is the unilateral resolution the
 * project's standing rule forbids. work_hierarchy_parent at level
 * 'mission' remains a valid, typed UUID reference with no backing store
 * or schema: a knowingly-retained gap, made concrete rather than hidden.
 */
export class TaskStore {
  private readonly store: ObjectStore<TaskEntityType>;

  constructor() {
    this.store = new ObjectStore<TaskEntityType>(TaskEntity);
  }

  createTask(task: TaskEntityType): TaskEntityType {
    return this.store.create(task);
  }

  getTask(taskId: string): TaskEntityType | undefined {
    return this.store.get(taskId);
  }

  listTasks(): TaskEntityType[] {
    return this.store.list({ entityType: 'task' });
  }

  updateTask(taskId: string, patch: EntityPatch<TaskEntityType>): TaskEntityType {
    return this.store.update(taskId, patch);
  }

  transitionTaskLifecycle(
    taskId: string,
    newState: LifecycleState,
    actor: string,
    substate?: string
  ): TaskEntityType {
    return this.store.transitionLifecycle(taskId, newState, actor, substate);
  }
}
