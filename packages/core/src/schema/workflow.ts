import { z } from 'zod';
import { CanonicalEntity } from './base.js';

// §4.3 Workflow — extends base. Sequencing/orchestration wrapper over
// Tasks; not an Organizational Container (it sequences, doesn't hold/schedule).

export const WorkflowEntity = CanonicalEntity.extend({
  entity_type: z.literal('workflow'),
  steps: z.array(z.string().uuid()), // ordered Task entity_ids
  trigger: z.string().optional(), // left open pending a future Event Model (§6 item 2)
  governing_loop: z.literal('system_execution_loop'),
});
export type WorkflowEntity = z.infer<typeof WorkflowEntity>;
