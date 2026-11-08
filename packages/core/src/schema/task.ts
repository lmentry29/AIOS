import { z } from 'zod';
import { CanonicalEntity, WorkHierarchyParent } from './base.js';

// §4.2.1 Action — sub-object, NOT a top-level Canonical Entity.
// No global entity_id requirement (§3.1) applies here by design.
export const ActionStatus = z.enum(['pending', 'executing', 'completed', 'failed']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const Action = z.object({
  action_id: z.string().uuid(), // unique within parent Task only
  status: ActionStatus,
  executed_by: z.string().uuid(), // Agent entity_id
});
export type Action = z.infer<typeof Action>;

// §4.2 Task — extends base. work_hierarchy_parent REQUIRED at level
// 'objective' (a Task's parent is always an Objective, per ADR-0004's
// canonical chain Mission → Objective → Task → Action).
const TaskEntityShape = CanonicalEntity.extend({
  entity_type: z.literal('task'),
  work_hierarchy_parent: WorkHierarchyParent.extend({
    level: z.literal('objective'),
  }),
  actions: z.array(Action).default([]),
  assigned_agent: z.string().uuid().optional(),
  assigned_workflow: z.string().uuid().optional(),
});

export const TaskEntity = TaskEntityShape.refine(
  (task: z.infer<typeof TaskEntityShape>) => task.lifecycle_substate === undefined,
  {
    message:
      'Task has no ratified lifecycle_substate vocabulary; substates are not accepted for Task entities (ADR-0012, COM §4.2)',
    path: ['lifecycle_substate'],
  },
).refine(
  (task: z.infer<typeof TaskEntityShape>) =>
    task.lifecycle_history.every((entry) => entry.substate === undefined),
  {
    message:
      'Task lifecycle history entries cannot contain substates because Task has no ratified substate vocabulary (ADR-0012, COM §4.2)',
    path: ['lifecycle_history'],
  },
);
export type TaskEntity = z.infer<typeof TaskEntity>;
