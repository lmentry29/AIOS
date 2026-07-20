import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ObjectiveStore, TaskStore } from '@aios/work-hierarchy';
import { FOUNDER, makeObjective, makeTask } from './fixtures.js';

/**
 * CONFORMANCE SUBJECT: @aios/work-hierarchy
 *
 * Declared scope (AIOS-CONFORMANCE §7.7): TaskStore and ObjectiveStore, the Work
 * Hierarchy's Task and Objective levels per ADR-0004 (canonical chain
 * Mission → Objective → Task → Action) and ADR-0010 (COM §5.3).
 *
 * Scope note: TaskStore and ObjectiveStore are thin wrappers over
 * ObjectStore<T> (@aios/objects). Requirements they satisfy purely by inheriting
 * ObjectStore's behavior (identity §9, atomic writes §11, append-only history §11)
 * are Conformance Subject @aios/objects's requirements and are tested there, and at
 * the boundary in tests/integration/objects-work-hierarchy.test.ts. This file covers
 * only the normative behavior this package's own code is responsible for.
 */

describe('Requirement Category: Architectural — a Task’s parent is always an Objective, never via the store (ADR-0004, COM §4.2)', () => {
  // "work_hierarchy_parent REQUIRED at level 'objective'... a Task's parent must be an
  // Objective, never a Mission or another Task directly." (COM §4.2) The schema-level
  // rejection is tested in tests/conformance/core.test.ts; this proves the store's
  // create() path actually surfaces that rejection rather than swallowing it.
  it('TaskStore.createTask rejects a Task parented at level "mission"', () => {
    const store = new TaskStore();
    const bad = makeTask({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'mission' } });
    expect(() => store.createTask(bad)).toThrow();
  });
});

describe('Requirement Category: Semantic — Objective’s Current Status advances independently of its definition (COM §5.3)', () => {
  // "Objectives remain immutable. Only their associated planning artifacts evolve" AND
  // "Current Status" (Part VI Ch.4, via COM §5.3). ObjectiveStore must expose both
  // halves as live, working operations against the same record.
  it('transitionObjectiveLifecycle advances lifecycle_state while every definition field stays byte-identical', () => {
    const store = new ObjectiveStore();
    const objective = store.createObjective(makeObjective());

    const advanced = store.transitionObjectiveLifecycle(objective.entity_id, 'validated', FOUNDER);

    expect(advanced.lifecycle_state).toBe('validated');
    expect(advanced.purpose).toBe(objective.purpose);
    expect(advanced.desired_outcome).toBe(objective.desired_outcome);
    expect(advanced.constraints).toEqual(objective.constraints);
    expect(advanced.success_criteria).toEqual(objective.success_criteria);
    expect(advanced.priority).toBe(objective.priority);
    expect(advanced.risk_profile).toBe(objective.risk_profile);
    expect(advanced.known_unknowns).toEqual(objective.known_unknowns);
    expect(advanced.acceptance_criteria).toEqual(objective.acceptance_criteria);
  });
});

describe('Requirement Category: Semantic — Dependencies unify into relationships[], not a parallel field (COM §5.3 field-unification table, §8)', () => {
  // "Dependencies -> relationships[] entries with relationship_type: depends_on (§8)."
  // (COM §5.3) ObjectiveStore.addDependency is the only write path for this; it must
  // produce exactly that shape, not an ad hoc `dependencies` array.
  it('addDependency records a relationships[] entry with relationship_type "depends_on"', () => {
    const store = new ObjectiveStore();
    const upstream = store.createObjective(makeObjective({ name: 'upstream' }));
    const downstream = store.createObjective(makeObjective({ name: 'downstream' }));

    const updated = store.addDependency(downstream.entity_id, upstream.entity_id);

    expect(updated.relationships).toHaveLength(1);
    expect(updated.relationships[0]).toMatchObject({
      target_entity_id: upstream.entity_id,
      relationship_type: 'depends_on',
      direction: 'outbound',
    });
    // No parallel `dependencies` field exists on the schema at all.
    expect((updated as unknown as Record<string, unknown>).dependencies).toBeUndefined();
  });
});

describe('Requirement Category: Architectural — work_hierarchy_parent and organizational_containers never alias (AGENTS.md rule 4, COM §3.4)', () => {
  // "The two reference groups below are never merged into one field — that was the
  // exact defect ADR-0004 Amendment A corrected in four places." (COM §3.4)
  it('TaskStore round-trips both fields independently through an update', () => {
    const store = new TaskStore();
    const objectiveId = randomUUID();
    const projectId = randomUUID();

    const created = store.createTask(
      makeTask({
        work_hierarchy_parent: { entity_id: objectiveId, level: 'objective' },
        organizational_containers: [{ entity_id: projectId, container_type: 'project' }],
      }),
    );

    const updated = store.updateTask(created.entity_id, { name: 'still separate' });

    expect(updated.work_hierarchy_parent).toEqual({ entity_id: objectiveId, level: 'objective' });
    expect(updated.organizational_containers).toEqual([
      { entity_id: projectId, container_type: 'project' },
    ]);
  });
});

describe('Requirement Category: Behavioral — ObjectiveStore.listObjectives filters by subtype, not merely by entity_type (COM §5.3 vs §5.1/§5.2)', () => {
  // Objective, Memory Object, and Artifact all share entity_type 'canonical_object'
  // (COM §4.5's open entity_subtype list). A store that filtered on entity_type alone
  // would return sibling subtypes it has no schema for.
  it('returns only entity_subtype "objective" records', () => {
    const store = new ObjectiveStore();
    store.createObjective(makeObjective({ name: 'a' }));
    store.createObjective(makeObjective({ name: 'b' }));

    const listed = store.listObjectives();
    expect(listed).toHaveLength(2);
    expect(listed.every((o) => o.entity_subtype === 'objective')).toBe(true);
  });
});
