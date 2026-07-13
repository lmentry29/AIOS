import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ObjectiveEntity } from '@aios/core';
import { ImmutableObjectiveFieldError } from '@aios/objects';
import { ObjectiveStore } from '../src/objective-store.js';

const FOUNDER = 'human:founder';

function makeObjective(overrides: Record<string, unknown> = {}): ObjectiveEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'objective',
    name: 'reduce p95 build time',
    purpose: 'CI feedback is too slow to be useful',
    desired_outcome: 'p95 build under 3 minutes',
    constraints: ['no new CI vendors'],
    success_criteria: ['p95 < 180s over a 7-day window'],
    priority: 'high',
    risk_profile: 'medium',
    known_unknowns: ['whether the cache is the bottleneck'],
    acceptance_criteria: ['founder signs off on the measured result'],
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
  } as unknown as ObjectiveEntity;
}

describe('ObjectiveStore — schema (COM §5.3, ADR-0010)', () => {
  it('creates and retrieves an Objective, preserving all eight definition fields', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());
    const fetched = store.getObjective(created.entity_id);

    expect(fetched?.purpose).toBe('CI feedback is too slow to be useful');
    expect(fetched?.desired_outcome).toBe('p95 build under 3 minutes');
    expect(fetched?.constraints).toEqual(['no new CI vendors']);
    expect(fetched?.success_criteria).toEqual(['p95 < 180s over a 7-day window']);
    expect(fetched?.priority).toBe('high');
    expect(fetched?.risk_profile).toBe('medium');
    expect(fetched?.known_unknowns).toEqual(['whether the cache is the bottleneck']);
    expect(fetched?.acceptance_criteria).toEqual(['founder signs off on the measured result']);
  });

  it('is a Canonical Object subtype, not a sixth entity type (ADR-0007 boundary intact)', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());

    expect(created.entity_type).toBe('canonical_object');
    expect(created.entity_subtype).toBe('objective');
  });

  it('rejects an Objective with no success_criteria — one with none is not gradeable', () => {
    const store = new ObjectiveStore();
    expect(() => store.createObjective(makeObjective({ success_criteria: [] }))).toThrow();
  });

  it('rejects an Objective with no acceptance_criteria', () => {
    const store = new ObjectiveStore();
    expect(() => store.createObjective(makeObjective({ acceptance_criteria: [] }))).toThrow();
  });

  it('rejects an unknown priority', () => {
    const store = new ObjectiveStore();
    expect(() => store.createObjective(makeObjective({ priority: 'urgent' }))).toThrow();
  });

  it('lists objectives without picking up other Canonical Object subtypes', () => {
    const store = new ObjectiveStore();
    store.createObjective(makeObjective({ name: 'a' }));
    store.createObjective(makeObjective({ name: 'b' }));

    const listed = store.listObjectives();
    expect(listed).toHaveLength(2);
    expect(listed.every((o) => o.entity_subtype === 'objective')).toBe(true);
  });
});

describe('ObjectiveStore — definition immutability (Part VI Ch.4, write-time rule)', () => {
  it.each([
    ['purpose', 'a different purpose'],
    ['desired_outcome', 'something else'],
    ['success_criteria', ['moved the goalposts']],
    ['priority', 'low'],
    ['risk_profile', 'critical'],
    ['constraints', ['relaxed']],
    ['known_unknowns', []],
    ['acceptance_criteria', ['weaker bar']],
  ])('refuses to change %s after creation', (field, value) => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());

    expect(() =>
      store.updateObjective(created.entity_id, { [field]: value } as never),
    ).toThrow(ImmutableObjectiveFieldError);
  });

  it('is stricter than Memory Object immutability — it bites at "created", not only at "completed"', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());
    expect(created.lifecycle_state).toBe('created');

    // Memory Objects (§5.1) are only immutable once completed. Objectives are immutable
    // from creation: "Objectives remain immutable. Only their associated planning
    // artifacts evolve."
    expect(() =>
      store.updateObjective(created.entity_id, { purpose: 'rewritten' } as never),
    ).toThrow(ImmutableObjectiveFieldError);
  });

  it('permits a no-op write of an identical definition value', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());

    // Value-compared, not key-presence-compared — resubmitting the same value is not
    // a mutation and should not be a spurious failure.
    expect(() =>
      store.updateObjective(created.entity_id, {
        purpose: 'CI feedback is too slow to be useful',
      } as never),
    ).not.toThrow();
  });

  it('permits non-definition writes — name is not a definition field', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());

    const updated = store.updateObjective(created.entity_id, { name: 'retitled' });
    expect(updated.name).toBe('retitled');
    expect(updated.purpose).toBe('CI feedback is too slow to be useful');
  });
});

describe('ObjectiveStore — Current Status and Dependencies (COM §5.3 unification)', () => {
  it('advances Current Status via lifecycle_state without touching the definition', () => {
    const store = new ObjectiveStore();
    const created = store.createObjective(makeObjective());

    store.transitionObjectiveLifecycle(created.entity_id, 'validated', FOUNDER);
    const active = store.transitionObjectiveLifecycle(created.entity_id, 'active', FOUNDER);

    // This is what makes Ch.4's "Objectives remain immutable" and its "Current Status"
    // field both true at once: status advances, definition never changes.
    expect(active.lifecycle_state).toBe('active');
    expect(active.lifecycle_history.map((h) => h.state)).toEqual(['validated', 'active']);
    expect(active.purpose).toBe('CI feedback is too slow to be useful');
  });

  it('records Dependencies as depends_on relationships, not a parallel array (§8)', () => {
    const store = new ObjectiveStore();
    const a = store.createObjective(makeObjective({ name: 'a' }));
    const b = store.createObjective(makeObjective({ name: 'b' }));

    const withDep = store.addDependency(a.entity_id, b.entity_id);

    expect(withDep.relationships).toEqual([
      {
        target_entity_id: b.entity_id,
        target_entity_type: 'canonical_object',
        relationship_type: 'depends_on',
        direction: 'outbound',
      },
    ]);
    // A `dependencies` array would express the same edge twice — the re-fragmentation
    // COM §12 exists to prevent.
    expect((withDep as Record<string, unknown>).dependencies).toBeUndefined();
  });
});
