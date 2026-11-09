import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalEntity } from '@aios/core';
import { LearningService } from '@aios/learning';
import { ObjectStore } from '@aios/objects';
import { FounderInputError, FounderInterface } from '../src/index.js';

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
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human',
    relationships: [],
    ...overrides,
  });
}

describe('FounderInterface', () => {
  it('searches canonical entities and learning records without mutating them', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const stored = objects.create(entity());
    const learning = new LearningService();
    await learning.recordObservation('Security policy', 'Authorization needs review');
    const founder = new FounderInterface(objects, learning);

    const response = await founder.query('security policy');
    expect(response.matching_entities.map((item) => item.entity_id)).toContain(stored.entity_id);
    expect(response.matching_memories).toHaveLength(1);
    expect(response.answer).toContain('Security policy');
  });

  it('rejects empty queries', async () => {
    const founder = new FounderInterface(new ObjectStore(CanonicalEntity), new LearningService());
    await expect(founder.query('   ')).rejects.toBeInstanceOf(FounderInputError);
    await expect(founder.query(null as never)).rejects.toBeInstanceOf(FounderInputError);
  });

  it('records decisions as retrievable ADR Artifacts', async () => {
    const founder = new FounderInterface(new ObjectStore(CanonicalEntity), new LearningService());
    const id = await founder.recordDecision({
      title: 'Authorization boundary',
      decision: 'Deny by default',
      rationale: 'Untrusted callers must not gain authority implicitly.',
      decided_by: 'human:founder',
      evidence: ['security-review-1'],
    });

    expect(founder.getDecision(id)?.artifact_kind).toBe('adr');
    expect(founder.getDecision(id)?.name).toBe('Authorization boundary');
    expect(founder.listDecisions().map((item) => item.entity_id)).toContain(id);
  });

  it('rejects incomplete decisions instead of persisting empty artifacts', async () => {
    const founder = new FounderInterface(new ObjectStore(CanonicalEntity), new LearningService());
    await expect(founder.recordDecision(null as never)).rejects.toBeInstanceOf(FounderInputError);
    await expect(founder.recordDecision({
      title: 'Authorization boundary',
      decision: 'Deny by default',
      rationale: 'Because',
      decided_by: 'not-an-actor',
    })).rejects.toBeInstanceOf(FounderInputError);
  });

  it('surfaces entities with explicit access policies for human review', async () => {
    const objects = new ObjectStore(CanonicalEntity);
    const governed = objects.create(entity({ access_policy: randomUUID() }));
    objects.create(entity());
    const founder = new FounderInterface(objects, new LearningService());

    expect((await founder.reviewQueue()).map((item) => item.entity_id)).toEqual([governed.entity_id]);
  });
});
