import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactEntity, CanonicalEntity } from '@aios/core';
import { LearningService } from '@aios/learning';
import { ObjectStore } from '@aios/objects';
import {
  FounderAuthorizationError,
  FounderInputError,
  FounderInterface,
  type FounderAuthorizationRequest,
} from '../src/index.js';

const FOUNDER = 'human:founder';
const DECISION_COLLECTION_ID = randomUUID();

function entity(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return CanonicalEntity.parse({
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'reference',
    name: 'Security policy',
    description: 'Review authorization boundary',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: 'human',
    relationships: [],
    ...overrides,
  });
}

function founder(
  objects: ObjectStore,
  learning: LearningService,
  authorize: (request: FounderAuthorizationRequest) => Promise<boolean> = async () => true,
) {
  return new FounderInterface(
    objects,
    learning,
    { authorize },
    { decisionCollectionId: DECISION_COLLECTION_ID },
  );
}

describe('FounderInterface', () => {
  it('searches only authorized canonical entities and learning records without mutating them', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const stored = objects.create(entity());
    const learning = new LearningService();
    await learning.recordObservation('Security policy', 'Authorization needs review');
    const api = founder(objects, learning);

    const response = await api.query('security policy', FOUNDER);
    expect(response.matching_entities.map((item) => item.entity_id)).toContain(stored.entity_id);
    expect(response.matching_memories).toHaveLength(1);
    expect(response.answer).toContain('Security policy');
  });

  it('does not return protected entities or memories to an unauthorized actor', async () => {
    const objects = new ObjectStore(CanonicalEntity, { allowAccessPolicyOnCreate: true });
    const protectedEntity = objects.create(entity({ name: 'Confidential acquisition plan', access_policy: randomUUID() }));
    const learning = new LearningService();
    await learning.recordObservation('Confidential acquisition plan', 'Unreleased transaction details');
    const api = founder(objects, learning, async () => false);

    const response = await api.query('confidential acquisition plan', FOUNDER);
    expect(response.matching_entities).toEqual([]);
    expect(response.matching_memories).toEqual([]);
    expect(response.answer).not.toContain(protectedEntity.name);
    expect(await api.reviewQueue(FOUNDER)).toEqual([]);
  });

  it('rejects empty queries and invalid actor identities', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService());
    await expect(api.query('   ', FOUNDER)).rejects.toBeInstanceOf(FounderInputError);
    await expect(api.query(null as never, FOUNDER)).rejects.toBeInstanceOf(FounderInputError);
    await expect(api.query('security policy', '*')).rejects.toBeInstanceOf(FounderInputError);
  });

  it('records decisions only after authorization and retrieves ADR Artifacts through the protected collection', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService());
    const id = await api.recordDecision({
      title: 'Authorization boundary',
      decision: 'Deny by default',
      rationale: 'Untrusted callers must not gain authority implicitly.',
      decided_by: FOUNDER,
      evidence: ['security-review-1'],
    }, FOUNDER);

    expect((await api.getDecision(id, FOUNDER))?.artifact_kind).toBe('adr');
    expect((await api.getDecision(id, FOUNDER))?.name).toBe('Authorization boundary');
    expect((await api.listDecisions(FOUNDER)).map((item) => item.entity_id)).toContain(id);
  });

  it('isolates decision artifacts between protected Founder collections', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const learning = new LearningService();
    const artifactStore = new ObjectStore(ArtifactEntity);
    const firstCollection = randomUUID();
    const secondCollection = randomUUID();
    const first = new FounderInterface(
      objects,
      learning,
      { authorize: async () => true },
      { decisionCollectionId: firstCollection },
      artifactStore,
    );
    const second = new FounderInterface(
      objects,
      learning,
      { authorize: async () => true },
      { decisionCollectionId: secondCollection },
      artifactStore,
    );
    const firstId = await first.recordDecision({
      title: 'First collection decision',
      decision: 'Keep records scoped',
      rationale: 'A collection grant must not expose another collection.',
      decided_by: FOUNDER,
    }, FOUNDER);
    const secondId = await second.recordDecision({
      title: 'Second collection decision',
      decision: 'Keep records isolated',
      rationale: 'Each collection has an independent policy boundary.',
      decided_by: FOUNDER,
    }, FOUNDER);

    expect((await first.listDecisions(FOUNDER)).map((item) => item.entity_id)).toEqual([firstId]);
    expect((await second.listDecisions(FOUNDER)).map((item) => item.entity_id)).toEqual([secondId]);
    expect(await second.getDecision(firstId, FOUNDER)).toBeUndefined();
  });

  it('denies decision capture when collection authorization is missing', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService(), async () => false);
    await expect(api.recordDecision({
      title: 'Unauthorized decision',
      decision: 'Grant access',
      rationale: 'No valid policy exists.',
      decided_by: FOUNDER,
    }, FOUNDER)).rejects.toBeInstanceOf(FounderAuthorizationError);
    expect(await api.listDecisions(FOUNDER)).toEqual([]);
  });

  it('does not allow a caller to attribute a decision to another actor', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService());
    await expect(api.recordDecision({
      title: 'Spoofed decision',
      decision: 'Grant access',
      rationale: 'Caller-supplied identity is not authority.',
      decided_by: 'human:other',
    }, FOUNDER)).rejects.toBeInstanceOf(FounderInputError);
  });

  it('hides existing decision artifacts from actors denied collection evidence access', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const learning = new LearningService();
    const artifactStore = new ObjectStore(ArtifactEntity);
    const writer = new FounderInterface(
      objects,
      learning,
      { authorize: async () => true },
      { decisionCollectionId: DECISION_COLLECTION_ID },
      artifactStore,
    );
    const id = await writer.recordDecision({
      title: 'Protected decision',
      decision: 'Keep access restricted',
      rationale: 'Decision artifacts are protected evidence.',
      decided_by: FOUNDER,
    }, FOUNDER);
    const reader = new FounderInterface(
      objects,
      learning,
      { authorize: async () => false },
      { decisionCollectionId: DECISION_COLLECTION_ID },
      artifactStore,
    );

    expect(await reader.getDecision(id, FOUNDER)).toBeUndefined();
    expect(await reader.listDecisions(FOUNDER)).toEqual([]);
  });

  it('reserves decision capture and human review for human principals', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService());
    const agentId = randomUUID();
    await expect(api.recordDecision({
      title: 'Agent-authored governance',
      decision: 'Grant access',
      rationale: 'Agents cannot self-authorize governance decisions.',
      decided_by: agentId,
    }, agentId)).rejects.toBeInstanceOf(FounderInputError);
    await expect(api.reviewQueue(agentId)).rejects.toBeInstanceOf(FounderInputError);
  });

  it('rejects incomplete decisions instead of persisting empty artifacts', async () => {
    const api = founder(new ObjectStore(CanonicalEntity), new LearningService());
    await expect(api.recordDecision(null as never, FOUNDER)).rejects.toBeInstanceOf(FounderInputError);
    await expect(api.recordDecision({
      title: 'Authorization boundary',
      decision: 'Deny by default',
      rationale: 'Because',
      decided_by: 'not-an-actor',
    }, FOUNDER)).rejects.toBeInstanceOf(FounderInputError);
  });

  it('surfaces only authorized entities with explicit access policies for human review', async () => {
    const objects = new ObjectStore(CanonicalEntity, { allowAccessPolicyOnCreate: true });
    const governed = objects.create(entity({ access_policy: randomUUID() }));
    objects.create(entity());
    const api = founder(objects, new LearningService());

    expect((await api.reviewQueue(FOUNDER)).map((item) => item.entity_id)).toEqual([governed.entity_id]);
  });

  it('fails closed when the authorization adapter throws', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const stored = objects.create(entity());
    const api = founder(objects, new LearningService(), async () => {
      throw new Error('authorization service unavailable');
    });

    const response = await api.query('security policy', FOUNDER);
    expect(response.matching_entities).toEqual([]);
    expect(response.matching_entities.map((item) => item.entity_id)).not.toContain(stored.entity_id);
  });

  it('requires a valid protected decision collection identifier', () => {
    expect(() => new FounderInterface(
      new ObjectStore(CanonicalEntity),
      new LearningService(),
      { authorize: async () => true },
      { decisionCollectionId: 'not-a-uuid' },
    )).toThrow(FounderInputError);
  });
});
