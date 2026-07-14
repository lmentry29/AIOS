import { describe, expect, it, vi } from 'vitest';
import type { TaskEntity as TaskEntityType } from '@aios/core';
import { ObjectStore } from '../src/store.js';
import { EntityIdConflictError, EntityNotFoundError, ImmutableEntityError } from '../src/errors.js';

function baseFields(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: crypto.randomUUID(),
    name: 'test entity',
    lifecycle_state: 'created' as const,
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human' as const,
    relationships: [],
    ...overrides,
  };
}

describe('ObjectStore — base CanonicalEntity behavior', () => {
  it('creates and retrieves a canonical_object entity', () => {
    const store = new ObjectStore();
    const entity = baseFields({ entity_type: 'canonical_object' });
    const created = store.create(entity as never);
    expect(store.get(created.entity_id)).toEqual(created);
  });

  it('rejects create() with a duplicate entity_id, even after archival', () => {
    const store = new ObjectStore();
    const entity = baseFields({ entity_type: 'canonical_object' });
    const created = store.create(entity as never);

    store.transitionLifecycle(created.entity_id, 'archived', 'human:founder');

    expect(() => store.create(entity as never)).toThrow(EntityIdConflictError);
  });

  it('bumps version and modified_at atomically on update()', () => {
    const store = new ObjectStore();
    const entity = baseFields({ entity_type: 'canonical_object' });
    const created = store.create(entity as never);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(created.modified_at).getTime() + 1000));
    const updated = store.update(created.entity_id, { description: 'now has a description' });
    vi.useRealTimers();

    expect(updated.version).toBe(created.version + 1);
    expect(updated.modified_at).not.toBe(created.modified_at);
    expect(updated.description).toBe('now has a description');
  });

  it('appends (does not replace) lifecycle_history on transitionLifecycle()', () => {
    const store = new ObjectStore();
    const entity = baseFields({ entity_type: 'canonical_object' });
    const created = store.create(entity as never);

    const t1 = store.transitionLifecycle(created.entity_id, 'validated', 'human:founder');
    const t2 = store.transitionLifecycle(created.entity_id, 'active', 'human:founder', 'mutating');

    expect(t1.lifecycle_history).toHaveLength(1);
    expect(t2.lifecycle_history).toHaveLength(2);
    expect(t2.lifecycle_history[0].state).toBe('validated');
    expect(t2.lifecycle_history[1].state).toBe('active');
  });

  it('throws EntityNotFoundError for operations against an unknown entity_id', () => {
    const store = new ObjectStore();
    expect(() => store.update('00000000-0000-4000-8000-000000000000', {})).toThrow(
      EntityNotFoundError
    );
  });

  it('rejects mutation of a completed memory_object (COM §5.1 immutability)', () => {
    const store = new ObjectStore();
    const entity = baseFields({
      entity_type: 'canonical_object',
      entity_subtype: 'memory_object',
      memory_type: 'decision',
      confidence: 0.9,
      importance: 'high',
      evidence: [],
      source_references: [],
    });
    const created = store.create(entity as never);
    store.transitionLifecycle(created.entity_id, 'completed', 'human:founder');

    expect(() => store.update(created.entity_id, { description: 'edit attempt' })).toThrow(
      ImmutableEntityError
    );
  });

  it('appends bidirectional relationship entries via linkRelationship()', () => {
    const store = new ObjectStore();
    const a = store.create(baseFields({ entity_type: 'canonical_object' }) as never);
    const b = store.create(baseFields({ entity_type: 'canonical_object' }) as never);

    const { source, target } = store.linkRelationship(
      a.entity_id,
      b.entity_id,
      'canonical_object',
      'derived_from'
    );

    expect(source.relationships).toHaveLength(1);
    expect(source.relationships[0].direction).toBe('outbound');
    expect(target.relationships).toHaveLength(1);
    expect(target.relationships[0].direction).toBe('inbound');
  });
});

/**
 * Vertical-slice evidence gathering for COM §10's open question: does a
 * Task-shaped entity (which carries a required work_hierarchy_parent
 * field that Agent/Plugin/Workflow don't) fit naturally into a store
 * typed for the generic CanonicalEntity base, or does it feel forced?
 *
 * This is not a placeholder test — it's the concrete build-and-observe
 * step the project knowledge calls for instead of resolving the
 * Task/Object storage boundary by further discussion.
 */
describe('ObjectStore — Task-shaped entity insertion (COM §10 evidence)', () => {
  it('stores and retrieves a Task entity with a required work_hierarchy_parent', () => {
    const store = new ObjectStore();

    const task: TaskEntityType = baseFields({
      entity_type: 'task',
      work_hierarchy_parent: {
        entity_id: crypto.randomUUID(),
        level: 'objective',
      },
      actions: [],
    }) as unknown as TaskEntityType;

    const created = store.create(task);
    const retrieved = store.get(created.entity_id);

    expect(retrieved?.entity_type).toBe('task');
    expect(retrieved?.work_hierarchy_parent?.level).toBe('objective');
  });

  it('demonstrates update() silently drops Task-specific fields not present in the base schema (COM §10 evidence)', () => {
    const store = new ObjectStore();

    const task: TaskEntityType = baseFields({
      entity_type: 'task',
      work_hierarchy_parent: {
        entity_id: crypto.randomUUID(),
        level: 'objective',
      },
      actions: [],
    }) as unknown as TaskEntityType;

    const created = store.create(task);
    const agentId = crypto.randomUUID();

    // update() validates against the BASE CanonicalEntity schema, which
    // does not declare assigned_agent (a Task-specific field, COM §4.2).
    // Zod strips unrecognized keys by default on .parse() — so this call
    // does not throw, but assigned_agent is silently discarded rather
    // than persisted. This is genuine evidence for COM §10, not typing
    // friction: a generic @aios/objects store validated against the base
    // schema cannot actually carry type-specific fields through a
    // mutation, regardless of how the caller casts around the type
    // system. Resolving this needs either (a) ObjectStore<T> generic over
    // the specific entity schema, (b) .passthrough() on the base schema
    // (loses the exact validation strictness Zod exists to provide), or
    // (c) a dedicated @aios/work-hierarchy store parsing against
    // TaskEntity directly.
    const updated = store.update(created.entity_id, {
      assigned_agent: agentId,
    } as never);

    expect((updated as unknown as TaskEntityType).assigned_agent).toBeUndefined();

    const transitioned = store.transitionLifecycle(
      updated.entity_id,
      'active',
      agentId,
      'executing'
    );

    expect(transitioned.lifecycle_state).toBe('active');
    // The data loss persists through subsequent operations too, since
    // transitionLifecycle() also parses against the base schema.
    expect((transitioned as unknown as TaskEntityType).assigned_agent).toBeUndefined();
  });
});
