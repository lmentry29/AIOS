import { describe, expect, it } from 'vitest';
// Imported through the package entry point, NOT ../src/schema/index.js, on purpose.
// divergence-log.md bug 1: src/index.ts silently failed to re-export ./schema, and the
// package still built and typechecked clean because nothing here exercised its public
// entry point. It only surfaced when @aios/objects imported cross-package and got
// undefined. These imports are the regression guard for that.
import {
  CanonicalEntity,
  LifecycleState,
  MemoryObjectEntity,
  TaskEntity,
  WorkHierarchyParent,
} from '../src/index.js';

function baseFields(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: crypto.randomUUID(),
    entity_type: 'canonical_object' as const,
    name: 'test entity',
    lifecycle_state: 'created' as const,
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    owner_id: 'human:founder',
    owner_type: 'human' as const,
    ...overrides,
  };
}

describe('@aios/core public entry point', () => {
  it('re-exports the Zod schema values (guards divergence-log bug 1)', () => {
    // A barrel that fails to re-export yields `undefined` here while still typechecking.
    expect(CanonicalEntity).toBeDefined();
    expect(typeof CanonicalEntity.safeParse).toBe('function');
    expect(typeof TaskEntity.safeParse).toBe('function');
  });
});

describe('CanonicalEntity (COM §3)', () => {
  it('accepts a well-formed entity', () => {
    expect(CanonicalEntity.safeParse(baseFields()).success).toBe(true);
  });

  it('defaults organizational_containers and relationships to empty arrays', () => {
    const parsed = CanonicalEntity.parse(baseFields());
    expect(parsed.organizational_containers).toEqual([]);
    expect(parsed.relationships).toEqual([]);
  });

  it('rejects a non-UUID entity_id (§9 — identity is never a human-readable name)', () => {
    expect(CanonicalEntity.safeParse(baseFields({ entity_id: 'task-1' })).success).toBe(false);
  });

  it('rejects a non-positive version (§11 — version bumps monotonically from 1)', () => {
    expect(CanonicalEntity.safeParse(baseFields({ version: 0 })).success).toBe(false);
  });

  it('rejects epoch timestamps — §10 requires ISO 8601', () => {
    expect(CanonicalEntity.safeParse(baseFields({ created_at: 1752300000 })).success).toBe(false);
  });

  describe('actor identity (§9)', () => {
    it.each([
      ['a UUID', crypto.randomUUID()],
      ['a human:<founder_id> ref', 'human:founder'],
    ])('accepts %s as created_by', (_label, actor) => {
      expect(CanonicalEntity.safeParse(baseFields({ created_by: actor })).success).toBe(true);
    });

    it('rejects a bare name as created_by', () => {
      expect(CanonicalEntity.safeParse(baseFields({ created_by: 'alice' })).success).toBe(false);
    });
  });
});

describe('TaskEntity (COM §4.2)', () => {
  const task = (overrides: Record<string, unknown> = {}) =>
    baseFields({
      entity_type: 'task',
      work_hierarchy_parent: { entity_id: crypto.randomUUID(), level: 'objective' },
      ...overrides,
    });

  it('accepts a Task parented to an objective', () => {
    expect(TaskEntity.safeParse(task()).success).toBe(true);
  });

  it('requires work_hierarchy_parent — a Task always sits under an Objective (ADR-0004)', () => {
    const { work_hierarchy_parent: _omitted, ...withoutParent } = task();
    expect(TaskEntity.safeParse(withoutParent).success).toBe(false);
  });

  it('rejects a Task parented to a mission — the chain is Mission → Objective → Task', () => {
    const parent = { entity_id: crypto.randomUUID(), level: 'mission' };
    expect(TaskEntity.safeParse(task({ work_hierarchy_parent: parent })).success).toBe(false);
  });

  it('never conflates work_hierarchy_parent with organizational_containers (AGENTS.md rule 4)', () => {
    const parsed = TaskEntity.parse(
      task({
        organizational_containers: [
          { entity_id: crypto.randomUUID(), container_type: 'project' },
        ],
      }),
    );
    // The two reference groups stay structurally distinct: one singular hierarchy
    // position, one array of containers. Merging them was the defect ADR-0004
    // Amendment A corrected in four places.
    expect(parsed.work_hierarchy_parent.level).toBe('objective');
    expect(parsed.organizational_containers).toHaveLength(1);
    expect(parsed.organizational_containers[0]?.container_type).toBe('project');
  });
});

describe('MemoryObjectEntity (COM §5.1)', () => {
  const memory = (overrides: Record<string, unknown> = {}) =>
    baseFields({
      entity_type: 'canonical_object',
      entity_subtype: 'memory_object',
      memory_type: 'decision',
      confidence: 0.9,
      importance: 'high',
      ...overrides,
    });

  it('accepts a well-formed Memory Object', () => {
    expect(MemoryObjectEntity.safeParse(memory()).success).toBe(true);
  });

  it('pins entity_subtype to the literal memory_object', () => {
    expect(MemoryObjectEntity.safeParse(memory({ entity_subtype: 'artifact' })).success).toBe(
      false,
    );
  });

  it('constrains confidence to 0..1', () => {
    expect(MemoryObjectEntity.safeParse(memory({ confidence: 1.5 })).success).toBe(false);
  });
});

describe('shared enums', () => {
  it('exposes the ADR-0003 lifecycle states', () => {
    expect(LifecycleState.options).toEqual([
      'created',
      'validated',
      'active',
      'monitored',
      'suspended',
      'completed',
      'archived',
    ]);
  });

  it('exposes exactly the three Work Hierarchy levels (ADR-0004)', () => {
    expect(WorkHierarchyParent.shape.level.options).toEqual(['mission', 'objective', 'task']);
  });
});
