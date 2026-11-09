import { randomUUID } from 'node:crypto';
import type { ArtifactEntity as ArtifactEntityType, CanonicalEntity } from '@aios/core';
import { ArtifactEntity } from '@aios/core';
import type { LearningService } from '@aios/learning';
import { ObjectStore } from '@aios/objects';

export interface FounderDecisionRecord {
  title: string;
  decision: string;
  rationale: string;
  decided_by: string;
  /** Optional reference to supporting evidence; kept as text to avoid inventing a new entity contract. */
  evidence?: string[];
}

export interface FounderResponse {
  question: string;
  answer: string;
  matching_entities: CanonicalEntity[];
  matching_memories: ReturnType<LearningService['getKnowledge']>[];
}

function isActorReference(value: string): boolean {
  return /^human:[^\s:*]+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value.toLocaleLowerCase();
  try { return (JSON.stringify(value) ?? '').toLocaleLowerCase(); }
  catch { return ''; }
}

export class FounderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FounderInputError';
  }
}

/**
 * Founder Interface: read-oriented synthesis over canonical records and LearningService,
 * plus durable decision capture as an Artifact. Access-policy-bearing entities are
 * surfaced for human review; this class does not grant or infer permissions.
 */
export class FounderInterface {
  private readonly artifacts: ObjectStore<ArtifactEntityType>;

  constructor(
    private readonly objects: ObjectStore<CanonicalEntity>,
    private readonly learning: LearningService,
    artifactStore?: ObjectStore<ArtifactEntityType>,
  ) {
    this.artifacts = artifactStore ?? new ObjectStore<ArtifactEntityType>(ArtifactEntity);
  }

  async query(question: string): Promise<FounderResponse> {
    const terms = question.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new FounderInputError('Founder query must not be empty.');

    const matchingEntities = this.objects.list().filter((entity) => {
      const haystack = searchableText([entity.name, entity.description ?? '']);
      return terms.every((term) => haystack.includes(term));
    });
    const matchingMemories = this.learning
      .listByStage('observation')
      .concat(
        this.learning.listByStage('candidate'),
        this.learning.listByStage('validated'),
        this.learning.listByStage('published'),
        this.learning.listByStage('institutional_standard'),
        this.learning.listByStage('historical_archive'),
      )
      .filter((record) =>
        terms.every((term) => `${record.subject} ${searchableText(record.content)}`.toLocaleLowerCase().includes(term)),
      )
      .map((record) => ({ ...record }));

    const answer = [
      matchingEntities.length ? `Matching entities: ${matchingEntities.map((item) => item.name).join(', ')}.` : 'No matching canonical entities.',
      matchingMemories.length ? `Matching memories: ${matchingMemories.map((item) => item.subject).join(', ')}.` : 'No matching memories.',
    ].join(' ');

    return { question, answer, matching_entities: matchingEntities, matching_memories: matchingMemories };
  }

  async recordDecision(decision: FounderDecisionRecord): Promise<string> {
    const title = decision.title.trim();
    const body = decision.decision.trim();
    const rationale = decision.rationale.trim();
    if (!title || !body || !rationale) {
      throw new FounderInputError('Decision title, decision, and rationale are required.');
    }
    if (!isActorReference(decision.decided_by)) {
      throw new FounderInputError('Decision author must be a valid human reference or Agent UUID.');
    }
    if (decision.evidence?.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new FounderInputError('Evidence references must be non-empty strings.');
    }

    const now = new Date().toISOString();
    const artifact = ArtifactEntity.parse({
      entity_id: randomUUID(),
      entity_type: 'canonical_object',
      entity_subtype: 'artifact',
      artifact_kind: 'adr',
      name: title,
      description: JSON.stringify({
        decision: body,
        rationale,
        decided_by: decision.decided_by,
        evidence: decision.evidence ?? [],
      }),
      lifecycle_state: 'created',
      lifecycle_history: [],
      created_at: now,
      created_by: decision.decided_by,
      modified_at: now,
      version: 1,
      organizational_containers: [],
      owner_id: decision.decided_by,
      owner_type: decision.decided_by.startsWith('human:') ? 'human' : 'agent',
      relationships: [],
    });
    return this.artifacts.create(artifact).entity_id;
  }

  async reviewQueue(): Promise<CanonicalEntity[]> {
    return this.objects.list().filter((entity) => entity.access_policy !== undefined);
  }

  getDecision(decisionId: string): ArtifactEntityType | undefined {
    return this.artifacts.get(decisionId);
  }

  listDecisions(): ArtifactEntityType[] {
    return this.artifacts.list({ entityType: 'canonical_object' })
      .filter((artifact) => artifact.entity_subtype === 'artifact' && artifact.artifact_kind === 'adr');
  }
}
export * from './authorization.js';
