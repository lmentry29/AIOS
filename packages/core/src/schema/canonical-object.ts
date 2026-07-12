import { z } from 'zod';
import { CanonicalEntity } from './base.js';

// §4.5 Canonical Object — extends base. Object Lifecycle Loop substates
// (mutating/persisting/synchronizing) go in the base `lifecycle_substate`
// field per the mapping table; no dedicated field needed here.

export const CanonicalObjectEntity = CanonicalEntity.extend({
  entity_type: z.literal('canonical_object'),
  // entity_subtype: 'memory_object' | 'artifact' | future subtypes (open, §12)
});
export type CanonicalObjectEntity = z.infer<typeof CanonicalObjectEntity>;
