import { z } from 'zod';
import { CanonicalEntity } from './base.js';

// §4.5 Canonical Object — extends base. Object Lifecycle Loop substates
// (mutating/persisting/synchronizing) are active-state specializations. Other
// canonical stages have no substate vocabulary in the COM.
const ObjectSubstate = z.enum(['mutating', 'persisting', 'synchronizing']);

const CanonicalObjectEntityShape = CanonicalEntity.extend({
  entity_type: z.literal('canonical_object'),
  // entity_subtype: 'memory_object' | 'artifact' | future subtypes (open, §12)
});

export const CanonicalObjectEntity = CanonicalObjectEntityShape.refine(
  (object) =>
    object.lifecycle_substate === undefined ||
    (object.lifecycle_state === 'active' &&
      ObjectSubstate.safeParse(object.lifecycle_substate).success),
  {
    message:
      'Canonical Object substates must be mutating, persisting, or synchronizing while lifecycle_state is active (COM §4.5)',
    path: ['lifecycle_substate'],
  },
).refine(
  (object) =>
    object.lifecycle_history.every((entry) =>
      entry.substate === undefined
        ? true
        : entry.state === 'active' && ObjectSubstate.safeParse(entry.substate).success,
    ),
  {
    message:
      'Canonical Object lifecycle history substates must be mutating, persisting, or synchronizing under active state (COM §4.5)',
    path: ['lifecycle_history'],
  },
);
export type CanonicalObjectEntity = z.infer<typeof CanonicalObjectEntity>;
