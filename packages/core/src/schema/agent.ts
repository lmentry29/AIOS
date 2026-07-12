import { z } from 'zod';
import { CanonicalEntity } from './base.js';

// §4.1 Agent — extends base. work_hierarchy_parent omitted: an Agent is
// not itself a Work Hierarchy member, it acts on Tasks.

export const AgentRole = z.enum(['agent', 'worker']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentGoverningLayer = z.enum([
  'organizational_departments',
  'runtime_coordination_kernel',
]);
export type AgentGoverningLayer = z.infer<typeof AgentGoverningLayer>;

const AgentEntityShape = CanonicalEntity.extend({
  entity_type: z.literal('agent'),
  current_role: AgentRole,
  governing_layer: AgentGoverningLayer,
  assigned_tasks: z.array(z.string().uuid()).default([]),
  // Open vocabulary pending a future Capability Model (§6 item 3)
  capabilities: z.array(z.string()).default([]),
});
export const AgentEntity = AgentEntityShape.refine(
  (a: z.infer<typeof AgentEntityShape>) => a.work_hierarchy_parent === undefined,
  { message: 'Agent instances do not occupy a Work Hierarchy position' }
);
export type AgentEntity = z.infer<typeof AgentEntity>;
