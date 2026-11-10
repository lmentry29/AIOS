import { randomUUID } from 'node:crypto';
import type { ArtifactEntity as ArtifactEntityType, CanonicalEntity } from '@aios/core';
import { ArtifactEntity } from '@aios/core';
import type { KnowledgeRecord, KnowledgeStage } from '@aios/learning';
import { ObjectStore } from '@aios/objects';
import type { AccessAction } from './authorization.js';
import type { FounderEvidenceReadPort, VaultEvidenceRecord, VaultEvidenceWarning } from './obsidian-evidence.js';
import type { FounderConnectorEvidenceReadPort, GmailEvidenceRecord, NotionApplicationEvidenceRecord } from './local-connectors.js';

export interface CanonicalEntityReadPort {
  list(): CanonicalEntity[];
}

export interface FounderArtifactRepositoryPort {
  create(artifact: ArtifactEntityType): ArtifactEntityType;
  get(entityId: string): ArtifactEntityType | undefined;
  list(filter?: { entityType?: CanonicalEntity['entity_type'] }): ArtifactEntityType[];
}

export interface FounderKnowledgeReadPort {
  listByStage(stage: KnowledgeStage): KnowledgeRecord[];
}

export interface FounderAuthorizationRequest {
  actor_id: string;
  action: AccessAction;
  resource_id: string;
}

/** Must be backed by the same trusted authorization boundary used by orchestration. */
export interface FounderAuthorizationPort {
  authorize(request: FounderAuthorizationRequest): Promise<boolean>;
}

export interface FounderInterfaceOptions {
  /** UUID of the protected Founder decision collection used for decision writes and reads. */
  decisionCollectionId: string;
}

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
  matching_memories: KnowledgeRecord[];
}

export interface FounderEvidenceResponse {
  question: string;
  matching_evidence: VaultEvidenceRecord[];
  warnings: VaultEvidenceWarning[];
  total_files: number;
  last_updated: string;
  vault_resource_id: string;
}

function isActorReference(value: unknown): value is string {
  return typeof value === 'string'
    && (/^human:[^\s:*]+$/.test(value)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function isHumanPrincipal(value: string): boolean {
  return typeof value === 'string' && /^human:[^\s:*]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

export class FounderAuthorizationError extends Error {
  constructor(action: AccessAction, resourceId: string) {
    super(`Founder operation "${action}" denied for resource "${resourceId}".`);
    this.name = 'FounderAuthorizationError';
  }
}

/**
 * Founder Interface: authorization-gated synthesis over canonical records, learning
 * records, and read-only Obsidian vault evidence, plus protected Artifact-backed decision
 * capture. Actor IDs must be supplied by a trusted host identity subsystem; this package
 * does not authenticate callers. Vault evidence is read-only and never promoted to
 * permanent Memory by a query.
 *
 * Resource reads are filtered through the authorization port before any result is
 * returned. Decision operations are scoped to a configured, policy-protected collection.
 * No permissive authorization default exists.
 */
export class FounderInterface {
  private readonly artifacts: FounderArtifactRepositoryPort;

  constructor(
    private readonly objects: CanonicalEntityReadPort,
    private readonly learning: FounderKnowledgeReadPort,
    private readonly authorization: FounderAuthorizationPort,
    private readonly options: FounderInterfaceOptions,
    artifactStore?: FounderArtifactRepositoryPort,
    private readonly evidence?: FounderEvidenceReadPort,
    private readonly connectors?: FounderConnectorEvidenceReadPort,
  ) {
    if (!options || typeof options.decisionCollectionId !== 'string' || !isUuid(options.decisionCollectionId)) {
      throw new FounderInputError('Founder decision collection requires a valid protected resource UUID.');
    }
    this.artifacts = artifactStore ?? new ObjectStore<ArtifactEntityType>(ArtifactEntity);
  }

  async query(question: string, actorId: string): Promise<FounderResponse> {
    if (typeof question !== 'string' || question.length > 2000) throw new FounderInputError('Founder query must be a string of at most 2,000 characters.');
    if (!isActorReference(actorId)) throw new FounderInputError('Founder query requires a valid authenticated actor identifier.');
    const terms = question.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new FounderInputError('Founder query must not be empty.');
    if (terms.length > 40) throw new FounderInputError('Founder query must contain no more than 40 terms.');

    const entities = this.objects.list();
    const authorizedEntities = await Promise.all(entities.map(async (entity) => ({
      entity,
      allowed: await this.isAllowed(actorId, 'read_evidence', entity.entity_id),
    })));
    const matchingEntities = authorizedEntities
      .filter(({ entity, allowed }) => allowed && terms.every((term) =>
        searchableText([entity.name, entity.description ?? '']).includes(term),
      ))
      .map(({ entity }) => entity);

    const memories = this.learning
      .listByStage('observation')
      .concat(
        this.learning.listByStage('candidate'),
        this.learning.listByStage('validated'),
        this.learning.listByStage('published'),
        this.learning.listByStage('institutional_standard'),
        this.learning.listByStage('historical_archive'),
      );
    const authorizedMemories = await Promise.all(memories.map(async (record) => ({
      record,
      allowed: await this.isAllowed(actorId, 'read_evidence', record.id),
    })));
    const matchingMemories = authorizedMemories
      .filter(({ record, allowed }) => allowed && terms.every((term) =>
        `${record.subject} ${searchableText(record.content)}`.toLocaleLowerCase().includes(term),
      ))
      .map(({ record }) => ({ ...record }));

    const answer = [
      matchingEntities.length ? `Matching entities: ${matchingEntities.map((item) => item.name).join(', ')}.` : 'No matching accessible canonical entities.',
      matchingMemories.length ? `Matching memories: ${matchingMemories.map((item) => item.subject).join(', ')}.` : 'No matching accessible memories.',
    ].join(' ');

    return { question, answer, matching_entities: matchingEntities, matching_memories: matchingMemories };
  }


  /**
   * Read-only lexical search over an authorized Obsidian vault snapshot.
   * The evidence port must authorize the vault collection before fetching note bodies.
   * Results are evidence only; this method never promotes or writes permanent Memory.
   */
  async queryEvidence(question: string, actorId: string): Promise<FounderEvidenceResponse> {
    if (typeof question !== 'string' || question.length > 2000) throw new FounderInputError('Founder evidence query must be a string of at most 2,000 characters.');
    if (!isActorReference(actorId)) throw new FounderInputError('Founder evidence query requires a valid authenticated actor identifier.');
    const terms = question.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new FounderInputError('Founder evidence query must not be empty.');
    if (terms.length > 40) throw new FounderInputError('Founder evidence query must contain no more than 40 terms.');
    if (!this.evidence) throw new FounderInputError('Obsidian vault evidence reader is not configured.');

    const inventory = await this.evidence.list(actorId);
    const matchingEvidence = inventory.files.filter((record) => terms.every((term) =>
      searchableText([record.path, record.name, record.folder ?? '', record.frontmatter, record.content]).includes(term),
    ));
    return {
      question,
      matching_evidence: matchingEvidence,
      warnings: inventory.warnings,
      total_files: inventory.total_files,
      last_updated: inventory.last_updated,
      vault_resource_id: inventory.vault_resource_id,
    };
  }

  /** Read Gmail message metadata/snippets through the separately authorized local connector. */
  async searchGmail(query: string, actorId: string): Promise<GmailEvidenceRecord[]> {
    if (!isActorReference(actorId)) throw new FounderInputError('Gmail search requires a valid authenticated actor identifier.');
    if (!this.connectors) throw new FounderInputError('Local Gmail connector is not configured.');
    return this.connectors.searchGmail(query, actorId);
  }

  /** Read the configured Notion job-application database through its separate resource grant. */
  async listNotionApplications(actorId: string): Promise<NotionApplicationEvidenceRecord[]> {
    if (!isActorReference(actorId)) throw new FounderInputError('Notion reads require a valid authenticated actor identifier.');
    if (!this.connectors) throw new FounderInputError('Local Notion connector is not configured.');
    return this.connectors.listNotionApplications(actorId);
  }

  async recordDecision(decision: FounderDecisionRecord, actorId: string): Promise<string> {
    if (!decision || typeof decision !== 'object') throw new FounderInputError('Decision payload is required.');
    if (typeof decision.title !== 'string' || typeof decision.decision !== 'string' || typeof decision.rationale !== 'string') {
      throw new FounderInputError('Decision title, decision, and rationale must be strings.');
    }
    if (decision.title.length > 200 || decision.decision.length > 20000 || decision.rationale.length > 20000) {
      throw new FounderInputError('Decision title is limited to 200 characters; decision and rationale are limited to 20,000 characters each.');
    }
    if (!isHumanPrincipal(actorId)) throw new FounderInputError('Founder decisions can only be recorded by an authenticated human principal.');
    if (typeof decision.decided_by !== 'string' || decision.decided_by !== actorId) {
      throw new FounderInputError('Decision author must match the authenticated actor.');
    }
    const title = decision.title.trim();
    const body = decision.decision.trim();
    const rationale = decision.rationale.trim();
    if (!title || !body || !rationale) {
      throw new FounderInputError('Decision title, decision, and rationale are required.');
    }
    if (decision.evidence !== undefined && (!Array.isArray(decision.evidence)
      || decision.evidence.length > 50
      || decision.evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 1000))) {
      throw new FounderInputError('Evidence must contain at most 50 non-empty string references of at most 1,000 characters each.');
    }
    if (!(await this.isAllowed(actorId, 'intake', this.options.decisionCollectionId))) {
      throw new FounderAuthorizationError('intake', this.options.decisionCollectionId);
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
        decided_by: actorId,
        evidence: decision.evidence ?? [],
        decision_collection_id: this.options.decisionCollectionId,
      }),
      lifecycle_state: 'created',
      lifecycle_history: [],
      created_at: now,
      created_by: actorId,
      modified_at: now,
      version: 1,
      organizational_containers: [],
      owner_id: actorId,
      owner_type: 'human',
      relationships: [],
    });
    return this.artifacts.create(artifact).entity_id;
  }

  async reviewQueue(actorId: string): Promise<CanonicalEntity[]> {
    if (!isHumanPrincipal(actorId)) throw new FounderInputError('Founder review queue requires an authenticated human principal.');
    const governed = this.objects.list().filter((entity) => entity.access_policy !== undefined);
    const authorized = await Promise.all(governed.map(async (entity) => ({
      entity,
      allowed: await this.isAllowed(actorId, 'read_status', entity.entity_id),
    })));
    return authorized.filter(({ allowed }) => allowed).map(({ entity }) => entity);
  }

  async getDecision(decisionId: string, actorId: string): Promise<ArtifactEntityType | undefined> {
    if (!isActorReference(actorId) || !isUuid(decisionId)) throw new FounderInputError('Decision reads require valid decision and authenticated actor identifiers.');
    if (!(await this.isAllowed(actorId, 'read_evidence', this.options.decisionCollectionId))) return undefined;
    const artifact = this.artifacts.get(decisionId);
    return artifact && this.belongsToDecisionCollection(artifact) ? artifact : undefined;
  }

  async listDecisions(actorId: string): Promise<ArtifactEntityType[]> {
    if (!isActorReference(actorId)) throw new FounderInputError('Decision reads require a valid authenticated actor identifier.');
    if (!(await this.isAllowed(actorId, 'read_evidence', this.options.decisionCollectionId))) return [];
    return this.artifacts.list({ entityType: 'canonical_object' })
      .filter((artifact) => this.belongsToDecisionCollection(artifact));
  }

  private belongsToDecisionCollection(artifact: ArtifactEntityType): boolean {
    if (artifact.entity_subtype !== 'artifact' || artifact.artifact_kind !== 'adr') return false;
    try {
      const metadata = JSON.parse(artifact.description ?? '{}') as { decision_collection_id?: unknown };
      return metadata.decision_collection_id === this.options.decisionCollectionId;
    } catch {
      return false;
    }
  }

  private async isAllowed(actorId: string, action: AccessAction, resourceId: string): Promise<boolean> {
    try {
      return await this.authorization.authorize({ actor_id: actorId, action, resource_id: resourceId });
    } catch {
      return false;
    }
  }
}
export * from './authorization.js';
export * from './obsidian-evidence.js';
export * from './local-connectors.js';
