import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CanonicalEntity } from '@aios/core';
import { MemoryObjectEntity, ObjectiveEntity, ProjectEntity, TaskEntity } from '@aios/core';
import {
  AppendOnlyFieldError,
  EntityIdConflictError,
  ImmutableEntityError,
  ImmutableObjectiveFieldError,
  ImmutableProjectFieldError,
  ObjectStore,
} from '@aios/objects';
import { FOUNDER, makeCanonicalObject, makeMemoryObject, makeObjective, makeProject, makeTask } from './fixtures.js';

/**
 * CONFORMANCE SUBJECT: @aios/objects
 *
 * Declared scope (AIOS-CONFORMANCE §7.7): ObjectStore<T>, the generic Canonical Entity
 * persistence layer implementing COM §9 (identity), §11 (persistence model), and the
 * subtype-specific immutability rules of §5.1 (Memory Object), §5.3 (Objective), and
 * §5.4 (Project).
 */

describe('Requirement Category: Architectural — identity is never reused (COM §9)', () => {
  // "entity_id ... is a UUIDv4 ... and never reused or reassigned, including after
  // archival — an archived entity's ID is permanently retired, not recycled." (COM §9)
  it('rejects create() with an entity_id already present in the store', () => {
    const store = new ObjectStore();
    const entity = makeCanonicalObject();
    store.create(entity);
    expect(() => store.create(entity)).toThrow(EntityIdConflictError);
  });

  it('rejects create() with the same entity_id even after the record is archived', () => {
    const store = new ObjectStore();
    const entity = makeCanonicalObject();
    store.create(entity);
    store.transitionLifecycle(entity.entity_id, 'archived', FOUNDER);
    expect(() => store.create(entity)).toThrow(EntityIdConflictError);
  });
});

describe('Requirement Category: Behavioral — every write bumps version and modified_at atomically (COM §11)', () => {
  // "Every Canonical Entity write MUST update modified_at and increment version (§3.3)
  // atomically with the field change it accompanies — no partial writes that change
  // data without updating provenance." (COM §11) This MUST hold across every mutation
  // entry point ObjectStore exposes, not just update().
  it('update() bumps version and modified_at together', async () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.update(created.entity_id, { name: 'renamed' });
    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });

  it('transitionLifecycle() bumps version and modified_at together', async () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.transitionLifecycle(created.entity_id, 'validated', FOUNDER);
    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });

  it('addRelationship() bumps version and modified_at together', async () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    const target = store.create(makeTask());
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.addRelationship(created.entity_id, {
      target_entity_id: target.entity_id,
      target_entity_type: 'task',
      relationship_type: 'depends_on',
      direction: 'outbound',
    });
    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });
});

describe('Requirement Category: Behavioral — lifecycle_history is append-only (COM §3.2, §11)', () => {
  // "lifecycle_history | array of {state, substate, entered_at, actor} | Yes |
  // Append-only. Every transition is a new array entry, never an overwrite." (COM §3.2)
  it('accumulates one new entry per transition rather than overwriting the array', () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    expect(created.lifecycle_history).toHaveLength(0);

    const validated = store.transitionLifecycle(created.entity_id, 'validated', FOUNDER);
    expect(validated.lifecycle_history).toHaveLength(1);

    const active = store.transitionLifecycle(created.entity_id, 'active', FOUNDER, 'executing');
    expect(active.lifecycle_history).toHaveLength(2);
    // Prior entry must survive unchanged, not be replaced by the new one.
    expect(active.lifecycle_history[0]).toEqual(validated.lifecycle_history[0]);
    expect(active.lifecycle_history[1]?.state).toBe('active');
  });
});

describe('Requirement Category: Semantic — Memory Object immutability after completion (COM §5.1)', () => {
  // "Memory Objects are immutable after publication. Evolution creates new versions."
  // (COM §5.1, verbatim from the source corpus) A write-time rule Zod's static shape
  // validation cannot express — it must live in the persistence layer.
  it('rejects update() against a completed Memory Object', () => {
    const store = new ObjectStore(MemoryObjectEntity);
    const memory = store.create(makeMemoryObject());
    store.transitionLifecycle(memory.entity_id, 'completed', FOUNDER);
    expect(() => store.update(memory.entity_id, { name: 'edited after publication' })).toThrow(
      ImmutableEntityError,
    );
  });

  it('permits update() against a Memory Object that has not reached completed', () => {
    const store = new ObjectStore(MemoryObjectEntity);
    const memory = store.create(makeMemoryObject());
    expect(() => store.update(memory.entity_id, { name: 'still editable' })).not.toThrow();
  });

  it('does not apply Memory Object immutability to a completed entity of a different subtype', () => {
    // The rule is scoped to entity_subtype 'memory_object' (§5.1) — it must not leak
    // onto other Canonical Object subtypes or entity types merely because they, too,
    // reached lifecycle_state 'completed'.
    const store = new ObjectStore(TaskEntity);
    const task = store.create(makeTask());
    store.transitionLifecycle(task.entity_id, 'completed', FOUNDER);
    expect(() => store.update(task.entity_id, { name: 'still mutable' })).not.toThrow();
  });
});

describe('Requirement Category: Semantic — Objective definition immutability (COM §5.3, ADR-0010)', () => {
  // Part VI Ch.4, quoted in COM §5.3: "Objectives remain immutable." The eight
  // definition fields are locked from creation onward, at every lifecycle_state — a
  // strictly stronger rule than Memory Object's "only once completed" (§5.1).
  it('rejects a change to purpose immediately after creation, before any lifecycle transition', () => {
    const store = new ObjectStore(ObjectiveEntity);
    const objective = store.create(makeObjective());
    expect(() => store.update(objective.entity_id, { purpose: 'rewritten' } as never)).toThrow(
      ImmutableObjectiveFieldError,
    );
  });

  it('permits Current Status (lifecycle_state) to advance without touching the definition', () => {
    // Both halves of Ch.4's text hold simultaneously: "remain immutable" AND "Current
    // Status" — because transitionLifecycle is exempt from the definition-field check.
    const store = new ObjectStore(ObjectiveEntity);
    const objective = store.create(makeObjective());
    const completed = store.transitionLifecycle(objective.entity_id, 'completed', FOUNDER);
    expect(completed.lifecycle_state).toBe('completed');
    expect(completed.purpose).toBe(objective.purpose);
  });

  it('permits a non-definition field (name) to be updated', () => {
    const store = new ObjectStore(ObjectiveEntity);
    const objective = store.create(makeObjective());
    const updated = store.update(objective.entity_id, { name: 'renamed objective' } as never);
    expect(updated.name).toBe('renamed objective');
  });
});

describe('Requirement Category: Semantic — Project DNA immutability (COM §5.4, ADR-0011)', () => {
  // Part XI Ch.4, quoted in COM §5.4: Project DNA is the project's "immutable
  // characteristics" and "constitutional document." Only project_dna is locked;
  // everything else, including all three status axes, remains mutable.
  it('rejects a change to project_dna', () => {
    const store = new ObjectStore(ProjectEntity);
    const project = store.create(makeProject());
    expect(() =>
      store.update(project.entity_id, {
        project_dna: { ...project.project_dna, mission: 'rewritten constitution' },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });

  it('permits a no-op write of an identical project_dna value (value comparison, not key presence)', () => {
    const store = new ObjectStore(ProjectEntity);
    const project = store.create(makeProject());
    expect(() =>
      store.update(project.entity_id, { project_dna: { ...project.project_dna } } as never),
    ).not.toThrow();
  });

  it('permits project_status and project_phase transitions on a DNA-frozen Project', () => {
    const store = new ObjectStore(ProjectEntity);
    const project = store.create(makeProject());
    const updated = store.update(project.entity_id, {
      project_status: 'paused',
      project_phase: 'validation',
    } as never);
    expect(updated.project_status).toBe('paused');
    expect(updated.project_phase).toBe('validation');
  });
});

describe('Requirement Category: Interface — schema parameterization preserves type-specific fields (COM §1 design principle 2, §4.2)', () => {
  // "Type-specific fields are additive, not replacements." (COM §1) For that to hold in
  // a generic store, the store must be constructed with the type-specific schema — a
  // store parameterized only with the base CanonicalEntity schema strips them, since
  // Zod discards unrecognized keys on parse by default.
  it('a base-schema store silently drops a Task-specific field on create()', () => {
    const baseStore = new ObjectStore<CanonicalEntity>();
    const created = baseStore.create(
      makeTask() as unknown as CanonicalEntity,
    );
    expect((created as unknown as Record<string, unknown>).assigned_agent).toBeUndefined();
  });

  it('a TaskEntity-parameterized store preserves the same field through create() and update()', () => {
    const taskStore = new ObjectStore(TaskEntity);
    const created = taskStore.create(makeTask({ assigned_agent: '11111111-1111-4111-8111-111111111111' }));
    expect(created.assigned_agent).toBe('11111111-1111-4111-8111-111111111111');

    const updated = taskStore.update(created.entity_id, { name: 'still typed' });
    expect(updated.assigned_agent).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('Requirement Category: Behavioral — linkRelationship() pairs both sides correctly (COM §8)', () => {
  // "Every relationship is stored once and interpreted bidirectionally via direction
  // (outbound/inbound) rather than duplicated on both entities" (COM §8) —
  // linkRelationship must write an outbound entry on the source and the
  // direction-flipped inbound entry on the target, each carrying the OTHER party's
  // real entity_type.
  it('writes an outbound entry on the source and an inbound entry on the target', () => {
    const store = new ObjectStore(TaskEntity);
    const source = store.create(makeTask({ name: 'source' }));
    const target = store.create(makeTask({ name: 'target' }));

    const { source: updatedSource, target: updatedTarget } = store.linkRelationship(
      source.entity_id,
      target.entity_id,
      'task',
      'depends_on',
    );

    expect(updatedSource.relationships).toContainEqual({
      target_entity_id: target.entity_id,
      target_entity_type: 'task',
      relationship_type: 'depends_on',
      direction: 'outbound',
    });
    expect(updatedTarget.relationships).toContainEqual({
      target_entity_id: source.entity_id,
      target_entity_type: 'task',
      relationship_type: 'depends_on',
      direction: 'inbound',
    });
  });

  it('throws EntityNotFoundError-style when the target id does not exist, without touching the source', () => {
    const store = new ObjectStore(TaskEntity);
    const source = store.create(makeTask());
    expect(() => store.linkRelationship(source.entity_id, randomUUID(), 'task', 'depends_on')).toThrow();
    expect(store.get(source.entity_id)?.relationships).toEqual([]);
  });
});

describe('Requirement Category: Behavioral — relationships accumulate rather than replace, through the intended API surface (COM §11)', () => {
  // Same append-only principle as lifecycle_history (§3.2, §11), applied to
  // relationships via the store's own addRelationship()/linkRelationship() — the only
  // way EntityPatch's public type permits touching this field at all (EntityPatch<T>
  // Omits 'relationships', mirroring its 'lifecycle_history' omission, store.ts:76).
  //
  // Scope note: this test covers the intended, typed API surface only. The separate
  // runtime guard against update() overwriting relationships via an untyped/cast patch
  // is covered below, in its own describe block.
  it('accumulates one more entry per addRelationship() call rather than overwriting the array', () => {
    const store = new ObjectStore(TaskEntity);
    const source = store.create(makeTask());
    const targetA = store.create(makeTask({ name: 'a' }));
    const targetB = store.create(makeTask({ name: 'b' }));

    const afterFirst = store.addRelationship(source.entity_id, {
      target_entity_id: targetA.entity_id,
      target_entity_type: 'task',
      relationship_type: 'depends_on',
      direction: 'outbound',
    });
    expect(afterFirst.relationships).toHaveLength(1);

    const afterSecond = store.addRelationship(source.entity_id, {
      target_entity_id: targetB.entity_id,
      target_entity_type: 'task',
      relationship_type: 'blocks',
      direction: 'outbound',
    });
    expect(afterSecond.relationships).toHaveLength(2);
    expect(afterSecond.relationships[0]).toEqual(afterFirst.relationships[0]);
  });
});

describe('Requirement Category: Architectural — update() runtime-rejects any patch touching relationships or lifecycle_history (COM §11)', () => {
  // COM §11: both fields are append-only — "the record is mutable, but its history is
  // not." EntityPatch<T> Omits both at the TYPE level (store.ts), which blocks a
  // normally-typed caller at compile time. This block covers the runtime backstop for
  // callers the compiler can't see: a plain JS caller, a deserialized JSON patch, or
  // any TypeScript caller using a cast to bypass EntityPatch. Previously an
  // undocumented gap (see git history of tests/conformance/known-gaps.test.ts);
  // audited repo-wide for existing dependents before fixing — none found; every real
  // update() call site in the repo patches only ordinary mutable fields.
  it('throws AppendOnlyFieldError when a patch names relationships, even via an untyped cast', () => {
    const store = new ObjectStore(TaskEntity);
    const source = store.create(makeTask());
    const target = store.create(makeTask({ name: 'target' }));
    store.addRelationship(source.entity_id, {
      target_entity_id: target.entity_id,
      target_entity_type: 'task',
      relationship_type: 'depends_on',
      direction: 'outbound',
    });

    const rawPatch: Record<string, unknown> = { relationships: [] };
    expect(() => store.update(source.entity_id, rawPatch as never)).toThrow(AppendOnlyFieldError);
    // The attempted write must not have landed even partially.
    expect(store.get(source.entity_id)?.relationships).toHaveLength(1);
  });

  it('throws AppendOnlyFieldError when a patch names lifecycle_history, even via an untyped cast', () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    store.transitionLifecycle(created.entity_id, 'validated', FOUNDER);

    const rawPatch: Record<string, unknown> = { lifecycle_history: [] };
    expect(() => store.update(created.entity_id, rawPatch as never)).toThrow(AppendOnlyFieldError);
    expect(store.get(created.entity_id)?.lifecycle_history).toHaveLength(1);
  });

  it('still permits an ordinary field update when the patch does not name either append-only field', () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    expect(() => store.update(created.entity_id, { name: 'renamed' })).not.toThrow();
  });
});

describe('Requirement Category: Architectural — access/audit placeholder fields round-trip unchanged (COM §3.5)', () => {
  // "access_policy | reference | No | ... placeholder reference type pending future
  // governance work" and "audit_trail_ref | reference | No" (COM §3.5) — both are
  // optional UUID references with no attached behavior yet, but the base schema must
  // still carry them through persistence untouched.
  it('persists access_policy and audit_trail_ref through create() and update()', () => {
    const store = new ObjectStore(TaskEntity);
    const accessPolicyId = randomUUID();
    const auditTrailId = randomUUID();
    const created = store.create(
      makeTask({ access_policy: accessPolicyId, audit_trail_ref: auditTrailId }),
    );
    expect(created.access_policy).toBe(accessPolicyId);
    expect(created.audit_trail_ref).toBe(auditTrailId);

    const updated = store.update(created.entity_id, { name: 'renamed' });
    expect(updated.access_policy).toBe(accessPolicyId);
    expect(updated.audit_trail_ref).toBe(auditTrailId);
  });
});
