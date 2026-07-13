import { randomUUID } from 'node:crypto';
import type { Importance, MemoryObjectEntity as MemoryObjectEntityType, MemoryType } from '@aios/core';
import { MemoryObjectEntity } from '@aios/core';
import { ObjectStore } from '@aios/objects';
import { ArchivedKnowledgeError, InvalidStagePromotionError, KnowledgeNotFoundError } from './errors.js';
import { type KnowledgeStage, type PromotableStage, stageRank } from './knowledge-stage.js';

export interface ObservationOptions {
  memory_type?: MemoryType;
  importance?: Importance;
  confidence?: number;
  owner_id?: string;
  owner_type?: 'agent' | 'human';
}

/** What this service tracks per record, alongside the Memory Object in the Object Store. */
export interface KnowledgeRecord {
  /** entity_id of the backing Memory Object in the Object Store. */
  id: string;
  stage: KnowledgeStage;
  subject: string;
  content: unknown;
}

/**
 * LearningService — the Knowledge Evolution lifecycle, per
 * docs/engineering/runtime-interfaces.md §2.7.
 *
 * Each observation is persisted as a real Memory Object (COM §5.1) through
 * @aios/objects, so it gets the ratified identity, versioning, and immutability
 * machinery for free rather than a parallel store. Dependency matches
 * runtime-interfaces §3/§4 exactly: learning → core, objects.
 *
 * TWO THINGS LIVE HERE RATHER THAN ON THE MEMORY OBJECT, DELIBERATELY. Both are
 * deviations from a literal reading of §2.7, flagged per the playbook's Definition
 * of Done:
 *
 * 1. **The knowledge stage.** §2.7 states it is a "distinct axis from
 *    CanonicalEntity.lifecycle_state", and reconciliation-changelog.md Session 8
 *    verified these domain lifecycles as "legitimately different axes from ADR-0003"
 *    that were documented rather than merged into the base model. Adding a
 *    knowledge_stage field to core's Memory Object schema would do exactly the
 *    merging the corpus declined to do — and would require amending the ratified COM
 *    §5.1. So the axis stays in the package that owns it.
 *
 * 2. **The observation content.** §2.7's recordObservation takes
 *    `content: unknown`, but COM §5.1's Memory Object has NO content or body field —
 *    its payload fields are exhausted by name, description, memory_type, confidence,
 *    importance, evidence, and source_references. There is nowhere in the ratified
 *    schema to put an arbitrary content payload. Rather than serialize it into
 *    `description` (lossy, and a string field is not a content field) or add a field
 *    to core (a COM change, requiring an ADR-gated review), the content is held here
 *    against the Memory Object's entity_id. This is a genuine gap between the Tier 3
 *    contract and the Tier 1/2 schema; it is logged in
 *    docs/process/divergence-log.md rather than papered over.
 *
 * The Memory Object remains the canonical, persisted entity. This service holds the
 * two things the ratified model has no field for, keyed by that entity's id.
 */
export class LearningService {
  private readonly memories: ObjectStore<MemoryObjectEntityType>;
  private readonly knowledge = new Map<string, KnowledgeRecord>();

  constructor(store?: ObjectStore<MemoryObjectEntityType>) {
    this.memories = store ?? new ObjectStore<MemoryObjectEntityType>(MemoryObjectEntity);
  }

  /**
   * Records a new observation — the entry point of the Knowledge Evolution axis.
   * Creates a Memory Object and returns its entity_id, which is the id every other
   * method on this service takes.
   */
  async recordObservation(
    subject: string,
    content: unknown,
    options: ObservationOptions = {}
  ): Promise<string> {
    const now = new Date().toISOString();
    const owner_id = options.owner_id ?? 'human:founder';

    const memory = this.memories.create(
      MemoryObjectEntity.parse({
        entity_id: randomUUID(),
        entity_type: 'canonical_object',
        entity_subtype: 'memory_object',
        name: subject,
        // 'episodic' — an observation is a record of something that happened
        // (Part VIII Ch.6's Memory Domains). Overridable; not a claim that every
        // observation is episodic.
        memory_type: options.memory_type ?? 'episodic',
        // A raw observation is by definition the least-established stage of the
        // axis, so it starts at low confidence unless the caller knows better.
        confidence: options.confidence ?? 0.5,
        importance: options.importance ?? 'medium',
        evidence: [],
        source_references: [],
        lifecycle_state: 'created',
        lifecycle_history: [],
        created_at: now,
        created_by: owner_id,
        modified_at: now,
        version: 1,
        organizational_containers: [],
        owner_id,
        owner_type: options.owner_type ?? 'human',
        relationships: [],
      })
    );

    this.knowledge.set(memory.entity_id, {
      id: memory.entity_id,
      stage: 'observation',
      subject,
      content,
    });

    return memory.entity_id;
  }

  /**
   * Advances a record along the Knowledge Evolution axis. Forward-only: demotion is
   * not an operation the corpus defines, and this method is named promote().
   *
   * Deliberately does NOT touch lifecycle_state — that is the orthogonal axis, and
   * writing it here is the conflation §2.7 warns against.
   */
  async promote(observationId: string, toStage: PromotableStage): Promise<void> {
    const record = this.require(observationId);

    if (record.stage === 'historical_archive') {
      throw new ArchivedKnowledgeError(observationId);
    }

    if (stageRank(toStage) <= stageRank(record.stage)) {
      throw new InvalidStagePromotionError(observationId, record.stage, toStage);
    }

    this.knowledge.set(observationId, { ...record, stage: toStage });
  }

  /** Moves a record to 'historical_archive', the terminal stage of the axis (§2.7). */
  async archiveKnowledge(id: string): Promise<void> {
    const record = this.require(id);
    this.knowledge.set(id, { ...record, stage: 'historical_archive' });
  }

  getKnowledge(id: string): KnowledgeRecord | undefined {
    return this.knowledge.get(id);
  }

  /** The backing Memory Object (COM §5.1) for a knowledge record. */
  getMemoryObject(id: string): MemoryObjectEntityType | undefined {
    return this.memories.get(id);
  }

  listByStage(stage: KnowledgeStage): KnowledgeRecord[] {
    return Array.from(this.knowledge.values()).filter((r) => r.stage === stage);
  }

  private require(id: string): KnowledgeRecord {
    const record = this.knowledge.get(id);
    if (!record) {
      throw new KnowledgeNotFoundError(id);
    }
    return record;
  }
}
