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

/**
 * Execution intent for a Task.
 *
 * This is deliberately a narrow, local-command contract rather than a provider
 * selector. It is the fixed `local.exec` capability from ADR-0019: no model, no
 * plugin discovery, no caller-selected adapter. A host may only execute it through
 * an isolation provider that passes its own availability and trust checks.
 *
 * `argv` is an argument vector, never a shell command string. `cwd` is relative to
 * the run workspace. Environment values are restricted to a host allowlist; they are
 * never a channel for provider credentials.
 */
export const TaskExecutionSpec = z.object({
  kind: z.literal('local_command'),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_output_bytes: z.number().int().min(1024).max(1_048_576).optional(),
  env: z.record(z.string(), z.string().max(256)).optional(),
});
export type TaskExecutionSpec = z.infer<typeof TaskExecutionSpec>;

/**
 * Independent verification intent. The verifier runs this command in its own
 * sandbox; it does not trust the executor's summary or exit code.
 */
export const TaskVerificationSpec = z.object({
  kind: z.literal('local_command'),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  expected_exit_code: z.number().int().min(0).max(255).default(0),
});
export type TaskVerificationSpec = z.infer<typeof TaskVerificationSpec>;

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
  execution: TaskExecutionSpec.optional(),
  verification: TaskVerificationSpec.optional(),
});

export const TaskEntity = TaskEntityShape.refine(
  (task: z.infer<typeof TaskEntityShape>) => task.lifecycle_substate === undefined,
  {
    message:
      'Task has no ratified lifecycle_substate vocabulary; substates are not accepted for Task entities (COM §4.2)',
    path: ['lifecycle_substate'],
  },
).refine(
  (task: z.infer<typeof TaskEntityShape>) =>
    task.lifecycle_history.every((entry) => entry.substate === undefined),
  {
    message:
      'Task lifecycle history entries cannot contain substates because Task has no ratified substate vocabulary (COM §4.2)',
    path: ['lifecycle_history'],
  },
);
export type TaskEntity = z.infer<typeof TaskEntity>;
