import { z } from "zod";
import { CanonicalEntity, MAX_COLLECTION_ITEMS, WorkHierarchyParent } from "./base.js";

// §4.2.1 Action — sub-object, NOT a top-level Canonical Entity.
// No global entity_id requirement (§3.1) applies here by design.
export const ActionStatus = z.enum(["pending", "executing", "completed", "failed"]);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const Action = z.object({
  action_id: z.string().uuid(), // unique within parent Task only
  status: ActionStatus,
  executed_by: z.string().uuid(), // Agent entity_id
});
export type Action = z.infer<typeof Action>;

// A record is the correct shape for the allowlisted environment, but Zod 4.6.7 has
// no record `.max()`. This custom validator counts with an early exit, so an
// oversized map is rejected before any value is examined. The description is the
// explicit JSON Schema contract consumed by generate-schemas.mjs; keep the two in
// sync or generation fails closed on an unrepresentable custom type.
export const MAX_TASK_ENV_ENTRIES = 64;
const TASK_ENV_DESCRIPTION = "AIOS task environment: at most 64 string entries";

function isBoundedTaskEnvironment(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (++count > MAX_TASK_ENV_ENTRIES) return false;
    const entry = (value as Record<string, unknown>)[key];
    if (key.length > 64 || typeof entry !== "string" || entry.length > 256) return false;
  }
  return true;
}

export const TaskEnvironment = z
  .custom<Record<string, string>>(isBoundedTaskEnvironment, {
    message: TASK_ENV_DESCRIPTION,
  })
  .describe(TASK_ENV_DESCRIPTION);

const CommandArgumentVector = z.array(z.string().min(1).max(4096)).min(1).max(64);

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
export const LocalCommandExecutionSpec = z.object({
  kind: z.literal("local_command"),
  argv: CommandArgumentVector,
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_output_bytes: z.number().int().min(1024).max(1_048_576).optional(),
  env: TaskEnvironment.optional(),
});
export type LocalCommandExecutionSpec = z.infer<typeof LocalCommandExecutionSpec>;

/**
 * One bounded step in a multi-command execution plan (ADR-0039). A step is still the
 * fixed `local.exec` capability, not a new tool selector. When the Task declares
 * Actions, every Action has exactly one step and the step names it by `action_id`.
 * The Agent cannot add, reorder or silently omit steps at dispatch time.
 */
export const TaskExecutionPlanStep = z.object({
  action_id: z.string().uuid().optional(),
  argv: CommandArgumentVector,
  cwd: z.string().max(1024).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_output_bytes: z.number().int().min(1024).max(1_048_576).optional(),
  env: TaskEnvironment.optional(),
});
export type TaskExecutionPlanStep = z.infer<typeof TaskExecutionPlanStep>;

/**
 * A bounded sequence of fixed `local.exec` steps in one per-Task workspace.
 *
 * `timeout_ms` bounds the whole plan, not each step; a step may set a smaller
 * timeout. Plans are capped at eight steps so one dispatch cannot become an
 * unbounded command loop. This is a fixed-plan grant: planning is not delegated to
 * a model or provider, and there is no dynamic tool discovery.
 */
export const TaskExecutionPlan = z.object({
  kind: z.literal("local_plan"),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  steps: z.array(TaskExecutionPlanStep).min(1).max(8),
});
export type TaskExecutionPlan = z.infer<typeof TaskExecutionPlan>;

export const TaskExecutionSpec = z.discriminatedUnion("kind", [
  LocalCommandExecutionSpec,
  TaskExecutionPlan,
]);
export type TaskExecutionSpec = z.infer<typeof TaskExecutionSpec>;

/**
 * Independent verification intent. The verifier runs this command in its own
 * sandbox; it does not trust the executor's summary or exit code.
 */
export const TaskVerificationSpec = z.object({
  kind: z.literal("local_command"),
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
  entity_type: z.literal("task"),
  work_hierarchy_parent: WorkHierarchyParent.extend({
    level: z.literal("objective"),
  }),
  actions: z.array(Action).max(MAX_COLLECTION_ITEMS).default([]),
  assigned_agent: z.string().uuid().optional(),
  assigned_workflow: z.string().uuid().optional(),
  execution: TaskExecutionSpec.optional(),
  verification: TaskVerificationSpec.optional(),
});

/**
 * A plan and a Task's declared Actions must describe the same unit of work. An
 * Action-backed plan therefore has exactly one uniquely named step per Action and no
 * orphan steps. Plans over a Task with no Actions must not name Actions they do not
 * have. This is an intake invariant; the executor re-checks it because persisted or
 * caller-constructed objects may bypass the Zod parser.
 */
function planMatchesActions(task: z.infer<typeof TaskEntityShape>): boolean {
  const execution = task.execution;
  if (execution?.kind !== "local_plan") return true;
  if (task.actions.length === 0) {
    return execution.steps.every((step) => step.action_id === undefined);
  }
  if (execution.steps.length !== task.actions.length) return false;
  const actionIds = new Set(task.actions.map((action) => action.action_id));
  if (actionIds.size !== task.actions.length) return false;
  const stepIds = execution.steps.map((step) => step.action_id);
  if (stepIds.some((id) => id === undefined) || new Set(stepIds).size !== actionIds.size) {
    return false;
  }
  return stepIds.every((id) => id !== undefined && actionIds.has(id));
}

export const TaskEntity = TaskEntityShape.refine(
  (task: z.infer<typeof TaskEntityShape>) => task.lifecycle_substate === undefined,
  {
    message:
      "Task has no ratified lifecycle_substate vocabulary; substates are not accepted for Task entities (COM §4.2)",
    path: ["lifecycle_substate"],
  },
)
  .refine(planMatchesActions, {
    message:
      "A local_plan must contain exactly one uniquely named step per declared Action, and no orphan action_id when the Task has no Actions (ADR-0039)",
    path: ["execution"],
  })
  .refine(
    (task: z.infer<typeof TaskEntityShape>) =>
      task.lifecycle_history.every((entry) => entry.substate === undefined),
    {
      message:
        "Task lifecycle history entries cannot contain substates because Task has no ratified substate vocabulary (COM §4.2)",
      path: ["lifecycle_history"],
    },
  );
export type TaskEntity = z.infer<typeof TaskEntity>;
