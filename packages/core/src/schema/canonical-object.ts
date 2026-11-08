import { z } from 'zod';
import { CanonicalEntity, type LifecycleHistoryEntry, type LifecycleState } from './base.js';

// §4.5 Canonical Object — a reusable Zod object shape. Keep this as a ZodObject
// because Memory Object, Artifact, Objective, and Project extend it.
export const CanonicalObjectEntity = CanonicalEntity.extend({
  entity_type: z.literal('canonical_object'),
  // entity_subtype: 'memory_object' | 'artifact' | future subtypes (open, §12)
});

const ObjectSubstate = z.enum(['mutating', 'persisting', 'synchronizing']);

type CanonicalObjectLifecycle = {
  lifecycle_state: LifecycleState;
  lifecycle_substate?: string;
  lifecycle_history: LifecycleHistoryEntry[];
};

/**
 * Apply COM §4.5's lifecycle/substate mapping to a concrete Canonical Object schema.
 * The explicit return type preserves the wrapped schema's input/output types; without
 * it, consumers can lose the inferred lifecycle_history element type.
 */
export function withCanonicalObjectLifecycle<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T, z.output<T>, z.input<T>> {
  const withCurrentState = schema.refine(
    (object: z.output<T> & CanonicalObjectLifecycle) =>
      object.lifecycle_substate === undefined ||
      (object.lifecycle_state === 'active' &&
        ObjectSubstate.safeParse(object.lifecycle_substate).success),
    {
      message:
        'Canonical Object substates must be mutating, persisting, or synchronizing while lifecycle_state is active (COM §4.5)',
      path: ['lifecycle_substate'],
    },
  );

  const withHistory = withCurrentState.refine(
    (object: z.output<T> & CanonicalObjectLifecycle) =>
      object.lifecycle_history.every((entry: LifecycleHistoryEntry) =>
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

  return withHistory as z.ZodEffects<T, z.output<T>, z.input<T>>;
}
