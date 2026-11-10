import type { KnowledgeStage } from './knowledge-stage.js';

/**
 * Thrown when a permanent Memory promotion is attempted without a recorded approval from
 * an authorized human principal, or when the approval is rejected, expired, consumed, or
 * bound to a different record/stage/content.
 *
 * Ephemeral observations and draft-stage promotions (candidate, validated) do not require
 * approval and never throw this. `published` and `institutional_standard` are permanent.
 */
export class MemoryApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryApprovalError';
  }
}

/** Thrown when an operation references a knowledge id not held by this service. */
export class KnowledgeNotFoundError extends Error {
  constructor(id: string) {
    super(`No knowledge record found with id "${id}".`);
    this.name = 'KnowledgeNotFoundError';
  }
}

/**
 * Thrown when promote() would move a record backward along the Knowledge Evolution
 * axis, or leave it where it is.
 *
 * The method is named promote(), and Memory Engine Ch.23's chain
 * (Observation → Candidate → Validated → Published → Institutional Standard) is a
 * progression of epistemic confidence. Demotion is not a defined operation anywhere
 * in the corpus, so it is refused rather than silently invented.
 *
 * Skipping *forward* (e.g. observation → published) IS permitted: the corpus states
 * the ordering but nowhere requires each stage be visited, and inventing an adjacency
 * constraint it doesn't state would be over-constraining on no authority.
 */
export class InvalidStagePromotionError extends Error {
  constructor(id: string, from: KnowledgeStage, to: KnowledgeStage) {
    super(
      `Cannot promote knowledge "${id}" from "${from}" to "${to}" — promotion only moves forward along the Knowledge Evolution axis (Memory Engine Ch.23).`
    );
    this.name = 'InvalidStagePromotionError';
  }
}

/**
 * Thrown when promote() targets a record already archived.
 *
 * 'historical_archive' is terminal — per §2.7, archiveKnowledge is the last stage of
 * the axis, and there is no un-archive operation in the corpus.
 */
export class ArchivedKnowledgeError extends Error {
  constructor(id: string) {
    super(
      `Knowledge "${id}" is in 'historical_archive', which is terminal — it cannot be promoted.`
    );
    this.name = 'ArchivedKnowledgeError';
  }
}
