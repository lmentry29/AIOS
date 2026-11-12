import { z } from "zod";
import { CanonicalEntity, MAX_COLLECTION_ITEMS } from "./base.js";

// §4.1 Agent — extends base. work_hierarchy_parent omitted: an Agent is
// not itself a Work Hierarchy member, it acts on Tasks.

export const AgentRole = z.enum(["agent", "worker"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentGoverningLayer = z.enum([
  "organizational_departments",
  "runtime_coordination_kernel",
]);
export type AgentGoverningLayer = z.infer<typeof AgentGoverningLayer>;

export const AgentSubstate = z.enum(["planning", "reasoning", "executing", "monitoring"]);
export type AgentSubstate = z.infer<typeof AgentSubstate>;

const AgentEntityShape = CanonicalEntity.extend({
  entity_type: z.literal("agent"),
  current_role: AgentRole,
  governing_layer: AgentGoverningLayer,
  assigned_tasks: z.array(z.string().uuid()).max(MAX_COLLECTION_ITEMS).default([]),
  // Open vocabulary pending a future Capability Model (§6 item 3)
  capabilities: z.array(z.string()).max(MAX_COLLECTION_ITEMS).default([]),
});
export const AgentEntity = AgentEntityShape.refine(
  (a: z.infer<typeof AgentEntityShape>) => a.work_hierarchy_parent === undefined,
  { message: "Agent instances do not occupy a Work Hierarchy position" },
)
  .refine((a: z.infer<typeof AgentEntityShape>) => a.owner_id.startsWith("human:"), {
    message:
      "An Agent instance's owner_id MUST resolve to a human (COM §7) — an Agent cannot own another Agent",
  })
  .refine(
    (a: z.infer<typeof AgentEntityShape>) =>
      a.lifecycle_substate === undefined
        ? true
        : a.lifecycle_state === "active" && AgentSubstate.safeParse(a.lifecycle_substate).success,
    {
      message:
        "Agent lifecycle_substate must be planning, reasoning, executing, or monitoring while lifecycle_state is active (ADR-0002, COM §4.1)",
      path: ["lifecycle_substate"],
    },
  )
  .refine(
    (a: z.infer<typeof AgentEntityShape>) =>
      a.lifecycle_history.every((entry) =>
        entry.substate === undefined
          ? true
          : entry.state === "active" && AgentSubstate.safeParse(entry.substate).success,
      ),
    {
      message:
        "Agent lifecycle history substates must be one of planning, reasoning, executing, or monitoring and belong to active state (ADR-0002, COM §4.1)",
      path: ["lifecycle_history"],
    },
  );
export type AgentEntity = z.infer<typeof AgentEntity>;
