import { z } from 'zod';
import { CanonicalObjectEntity } from './canonical-object.js';

// §5.3 Objective — Canonical Object subtype, added by ADR-0010 (amending ADR-0007).
// NOT a sixth entity type: it specializes the existing Canonical Object type via the
// open, additive entity_subtype mechanism (§12), exactly as Memory Object and Artifact
// do. Source: AIOS Specification Project Part VI Ch.4 ("Objective Model").
//
// Per §12's field-unification rule, five of Ch.4's thirteen fields are semantically
// identical to base-schema fields and are deliberately NOT redeclared here:
//   Objective ID       -> entity_id      (§3.1)
//   Owner              -> owner_id / owner_type (§7)
//   Creation Timestamp -> created_at     (§3.3)
//   Current Status     -> lifecycle_state (§3.2) — an Objective IS lifecycle-bearing
//   Dependencies       -> relationships[] with relationship_type 'depends_on' (§8)
// Redeclaring any of them is the re-fragmentation §12 exists to prevent.
//
// work_hierarchy_parent is inherited from the base schema and left OPTIONAL rather than
// pinned to level 'mission'. ADR-0010 does not constrain it, and tightening it here
// would be inventing a rule the ratified decision doesn't state.

/**
 * ENUM MEMBERS ARE UNSOURCED. Part VI Ch.4 names "Priority" and "Risk Profile" as
 * Objective fields and ADR-0010 ratifies both as enums, but neither the corpus nor the
 * ADR enumerates their values anywhere. Rather than invent a new vocabulary, both reuse
 * the low/medium/high/critical scale this repo already uses for Memory Object's
 * `importance` (§5.1) — the same shape, so the model gains no new severity axis.
 *
 * Flagged in docs/process/divergence-log.md. If a real priority or risk taxonomy is
 * later sourced, these are the members to revisit; the field types are settled by
 * ADR-0010 and are not.
 */
export const ObjectivePriority = z.enum(['low', 'medium', 'high', 'critical']);
export type ObjectivePriority = z.infer<typeof ObjectivePriority>;

export const ObjectiveRiskProfile = z.enum(['low', 'medium', 'high', 'critical']);
export type ObjectiveRiskProfile = z.infer<typeof ObjectiveRiskProfile>;

/**
 * The eight fields of Ch.4's list that are genuinely new (i.e. survive §12 unification).
 *
 * These are the Objective's DEFINITION, and they are immutable after creation — Ch.4:
 * "Objectives remain immutable. Only their associated planning artifacts evolve."
 * Enforcement is a write-time rule in the persistence layer (@aios/objects), not
 * something Zod's static shape validation can express — the same situation as Memory
 * Object immutability (§5.1), and it reuses that mechanism rather than inventing a
 * second one. See ObjectiveDefinitionFields in @aios/objects.
 */
export const OBJECTIVE_DEFINITION_FIELDS = [
  'purpose',
  'desired_outcome',
  'constraints',
  'success_criteria',
  'priority',
  'risk_profile',
  'known_unknowns',
  'acceptance_criteria',
] as const;

export const ObjectiveEntity = CanonicalObjectEntity.extend({
  entity_subtype: z.literal('objective'),

  purpose: z.string(),
  desired_outcome: z.string(),
  constraints: z.array(z.string()).default([]),
  // Non-empty: an Objective with no success criteria is not gradeable (ADR-0010 §4).
  success_criteria: z.array(z.string()).nonempty(),
  priority: ObjectivePriority,
  risk_profile: ObjectiveRiskProfile,
  known_unknowns: z.array(z.string()).default([]),
  // Retained separately from success_criteria because Ch.4 lists both. The distinction
  // is thin and flagged for possible follow-on cleanup (ADR-0010, Consequences 3);
  // collapsing them would be a substantive change, not a transcription.
  acceptance_criteria: z.array(z.string()).nonempty(),
});
export type ObjectiveEntity = z.infer<typeof ObjectiveEntity>;
