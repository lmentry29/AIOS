import type { TaskEntity as TaskEntityType, LifecycleState } from '@aios/core';
import { TaskEntity } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';

/**
 * TaskStore is the Task-specific ObjectStore adapter. It deliberately exposes
 * no substate parameter: COM §4.2 defines no Task substate vocabulary.
 * Agent Execution Loop substates belong exclusively to Agent entities (§4.1).
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
  ): TaskEntityType {
    return this.store.transitionLifecycle(taskId, newState, actor);
  }
}
