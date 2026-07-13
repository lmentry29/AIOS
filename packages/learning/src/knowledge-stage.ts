/**
 * The Knowledge Evolution axis — Memory Engine Ch.23, verified during corpus
 * reconciliation (docs/process/reconciliation-changelog.md, Session 8) as
 * "legitimately different axes from ADR-0003" and documented rather than folded
 * into the Unified Lifecycle Model.
 *
 * THIS IS NOT A LIFECYCLE STATE. It is an *epistemic* status — how well-established
 * a piece of knowledge is — and it is orthogonal to CanonicalEntity.lifecycle_state,
 * which tracks runtime state. runtime-interfaces.md §2.7 says so explicitly
 * ("distinct axis from CanonicalEntity.lifecycle_state"). A Memory Object can be
 * lifecycle 'active' while epistemically still an 'observation', and promoting it to
 * 'validated' changes nothing about its lifecycle. Conflating the two would
 * reintroduce exactly the multi-lifecycle drift ADR-0003 was written to end.
 */
export const KNOWLEDGE_STAGES = [
  'observation',
  'candidate',
  'validated',
  'published',
  'institutional_standard',
  'historical_archive',
] as const;

export type KnowledgeStage = (typeof KNOWLEDGE_STAGES)[number];

/** The stages promote() may target. 'observation' is the entry stage, set by
 *  recordObservation; 'historical_archive' is terminal and reached via
 *  archiveKnowledge — neither is a promotion target. Mirrors §2.7's signature. */
export type PromotableStage = Exclude<KnowledgeStage, 'observation' | 'historical_archive'>;

export const stageRank = (stage: KnowledgeStage): number => KNOWLEDGE_STAGES.indexOf(stage);
