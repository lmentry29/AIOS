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
 * MISSION AND OBJECTIVE ARE NOT IMPLEMENTED HERE. See
 * docs/process/divergence-log.md for the full explanation. In short:
 * the ratified Canonical Object Model (COM §2) states Mission and
 * Objective are not entities in this model — reference fields only.
 * The raw corpus (AIOS Specification Project, Part VI Ch.4, "Objective
 * Model") specifies a full field-level Objective schema that was never
 * reconciled into the ratified COM. This is a genuine, unresolved
 * architectural conflict between two documents that both claim
 * authority, discovered during this implementation step. Per the
 * project's standing rule to stop and flag such conflicts rather than
 * route around them silently, no MissionEntity or ObjectiveEntity
 * schema is invented here. work_hierarchy_parent.entity_id for level
 * 'mission' or 'objective' remains a valid, typed UUID reference with
 * no backing store or schema — the gap made concrete rather than hidden.
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
