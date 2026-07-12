import { z } from 'zod';
import { CanonicalObjectEntity } from './canonical-object.js';

// §5.1 Memory Object — most fully-specified Canonical Object subtype.
// Per §12's field-unification rule: fields semantically identical to a
// base-schema field (Memory Identifier→entity_id, Title→name, etc.) are
// NOT redeclared here. Only genuinely new fields appear below.

export const MemoryType = z.enum([
  'semantic',
  'episodic',
  'procedural',
  'decision',
  'project',
  'founder',
  'research',
  'operational',
  'reference',
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const Importance = z.enum(['low', 'medium', 'high', 'critical']);
export type Importance = z.infer<typeof Importance>;

export const MemoryObjectEntity = CanonicalObjectEntity.extend({
  entity_subtype: z.literal('memory_object'),
  memory_type: MemoryType,
  confidence: z.number().min(0).max(1),
  importance: Importance,
  evidence: z.array(z.string().uuid()).default([]),
  source_references: z.array(z.string()).default([]),
  // Immutability note (§5.1, verbatim): once lifecycle_state reaches
  // 'completed', no further 'active' mutation is permitted on this
  // entity_id. Evolution creates a NEW entity_id with incremented
  // version and a 'supersedes' relationship entry pointing back to the
  // prior version. This constraint is NOT enforceable by Zod's static
  // shape validation alone — it's a write-time rule the persistence
  // layer (§11) must enforce, e.g. in @aios/objects. Flagging here
  // rather than silently omitting it.
});
export type MemoryObjectEntity = z.infer<typeof MemoryObjectEntity>;
