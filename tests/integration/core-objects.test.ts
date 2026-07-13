import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalEntity, MemoryObjectEntity, TaskEntity } from '@aios/core';
import {
  EntityIdConflictError,
  ImmutableEntityError,
  ObjectStore,
} from '@aios/objects';
import { FOUNDER, makeCanonicalObject, makeMemoryObject, makeTask } from './fixtures.js';

/**
 * BOUNDARY: @aios/core → @aios/objects
 *
 * The contract across this edge is that ObjectStore validates every write against a
 * Zod schema *imported from core*, and that core's schemas survive the package
 * boundary as runtime values rather than types that vanish.
 *
 * Both bugs the vertical slice actually found live on this edge
 * (docs/process/divergence-log.md), and neither was catchable by either package's
 * own unit tests — which is the entire argument for this suite existing.
 */

describe('core → objects: schemas cross the boundary as runtime values', () => {
  it('imports core’s schemas as usable Zod values, not undefined (divergence-log bug 1)', () => {
    // core/src/index.ts once failed to re-export ./schema. It built and typechecked
    // clean the whole time, because nothing inside core exercised its own public
    // entry point. It only surfaced HERE — on the first cross-package import, where
    // @aios/objects got undefined where it expected a schema. This is that assertion,
    // made permanent at the boundary that found it.
    expect(typeof CanonicalEntity.parse).toBe('function');
    expect(typeof TaskEntity.parse).toBe('function');
    expect(typeof MemoryObjectEntity.parse).toBe('function');
  });

  it('rejects, at the store, an entity that violates core’s schema', () => {
    const store = new ObjectStore();
    // Identity is a UUID, never a human-readable name (COM §9). The store does not
    // implement that rule — core's schema does, and the store enforces it by parsing.
    expect(() => store.create(makeCanonicalObject({ entity_id: 'task-1' }))).toThrow();
  });
});

describe('core → objects: schema parameterization (COM §10)', () => {
  it('silently strips type-specific fields when constructed with only the base schema', () => {
    // Documented evidence, not a bug being asserted as correct: Zod strips unknown
    // keys by default, so a base-schema store accepts a Task-specific field and
    // discards it. This is exactly why ObjectStore takes a schema parameter, and
    // why TaskStore passes TaskEntity. Pinned so a regression would be loud.
    const baseStore = new ObjectStore();
    const created = baseStore.create(
      makeCanonicalObject({ entity_type: 'task', assigned_agent: randomUUID() }),
    );

    expect((created as Record<string, unknown>).assigned_agent).toBeUndefined();
  });

  it('preserves type-specific fields when constructed with core’s TaskEntity schema', () => {
    const taskStore = new ObjectStore(TaskEntity);
    const agentId = randomUUID();
    const created = taskStore.create(makeTask({ assigned_agent: agentId }));

    expect(created.assigned_agent).toBe(agentId);
    expect(created.work_hierarchy_parent.level).toBe('objective');
  });
});

describe('core → objects: COM invariants enforced at the store', () => {
  it('never reuses an entity_id, even after archival (COM §9)', () => {
    const store = new ObjectStore();
    const entity = makeCanonicalObject();
    store.create(entity);
    store.transitionLifecycle(entity.entity_id, 'archived', FOUNDER);

    expect(() => store.create(entity)).toThrow(EntityIdConflictError);
  });

  it('bumps version and modified_at together on every write (COM §11)', async () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());

    // Guarantee an observable clock tick — ISO-8601 has millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.update(created.entity_id, { name: 'renamed' });

    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });

  it('appends to lifecycle_history rather than writing it in place (COM §11, AGENTS.md rule 5)', () => {
    const store = new ObjectStore(TaskEntity);
    const created = store.create(makeTask());
    expect(created.lifecycle_history).toHaveLength(0);

    store.transitionLifecycle(created.entity_id, 'validated', FOUNDER);
    const active = store.transitionLifecycle(created.entity_id, 'active', FOUNDER, 'executing');

    expect(active.lifecycle_history.map((h) => h.state)).toEqual(['validated', 'active']);
    expect(active.lifecycle_history[1]?.substate).toBe('executing');
    expect(active.lifecycle_history[1]?.actor).toBe(FOUNDER);
  });

  it('enforces Memory Object immutability after completion (COM §5.1)', () => {
    // A write-time rule that Zod's static shape validation cannot express — it lives
    // in the persistence layer precisely because it can't live in the schema. That
    // makes it a boundary behavior by construction.
    const store = new ObjectStore(MemoryObjectEntity);
    const memory = store.create(makeMemoryObject());
    store.transitionLifecycle(memory.entity_id, 'completed', FOUNDER);

    expect(() => store.update(memory.entity_id, { name: 'edited after publication' })).toThrow(
      ImmutableEntityError,
    );
  });

  it('does not apply that immutability rule to non-Memory-Object entities', () => {
    // The rule is subtype-specific (§5.1). A completed Task is still mutable — if
    // this ever stops being true, the check has leaked across subtypes.
    const store = new ObjectStore(TaskEntity);
    const task = store.create(makeTask());
    store.transitionLifecycle(task.entity_id, 'completed', FOUNDER);

    expect(() => store.update(task.entity_id, { name: 'renamed' })).not.toThrow();
  });
});
