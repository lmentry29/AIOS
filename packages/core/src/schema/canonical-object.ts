import { z } from 'zod';
import { CanonicalEntity, type LifecycleHistoryEntry } from './base.js';

// §4.5 Canonical Object — a reusable Zod object shape. Keep this as a ZodObject
// because Memory Object, Artifact, Objective, and Project extend it.
export const CanonicalObjectEntity = CanonicalEntity.extend({
  entity_type: z.literal('canonical_object'),
  // entity_subtype: 'memory_object' | 'artifact' | future subtypes (open, §12)
});

const ObjectSubstate = z.enum(['mutating', 'persisting', 'synchronizing']);

/** Apply COM §4.5's lifecycle/substate mapping to concrete Canonical Object schemas. */
export function withCanonicalObjectLifecycle<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (object: z.infer<T> & {
      lifecycle_state: string;
      lifecycle_substate?: string;
      lifecycle_history: LifecycleHistoryEntry[];
    }) =>
      object.lifecycle_substate === undefined ||
      (object.lifecycle_state === 'active' &&
        ObjectSubstate.safeParse(object.lifecycle_substate).success),
    {
      message:
        'Canonical Object substates must be mutating, persisting, or synchronizing while lifecycle_state is active (COM §4.5)',
      path: ['lifecycle_substate'],
    },
  ).refine(
    (object: z.infer<T> & { lifecycle_history: LifecycleHistoryEntry[] }) =>
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
}
