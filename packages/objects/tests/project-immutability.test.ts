import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectEntity as ProjectEntityType } from '@aios/core';
import { ProjectEntity } from '@aios/core';
import { ObjectStore } from '../src/store.js';
import { ImmutableProjectFieldError } from '../src/errors.js';

const FOUNDER = 'human:founder';

function makeProject(overrides: Record<string, unknown> = {}): ProjectEntityType {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'project',
    name: 'AIOS',
    purpose: 'make the architecture executable',
    mission: 'an AI-native engineering organization',
    vision: 'software that plans and builds itself',
    project_dna: {
      mission: 'an AI-native engineering organization',
      core_principles: ['no unilateral resolution'],
      target_users: ['the founder'],
      architectural_philosophy: 'doc-first',
      quality_expectations: ['green before commit'],
      long_term_objectives: ['autonomy'],
      non_goals: ['a general agent framework'],
      governance_constraints: ['ADR-gated'],
    },
    project_status: 'active_development',
    project_phase: 'implementation',
    project_status_history: [],
    lifecycle_state: 'active',
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
  } as unknown as ProjectEntityType;
}

const projectStore = () => new ObjectStore<ProjectEntityType>(ProjectEntity);

describe('Project DNA immutability (COM §5.4, ADR-0011 — write-time rule)', () => {
  it('refuses to change project_dna after creation', () => {
    const store = projectStore();
    const created = store.create(makeProject());

    expect(() =>
      store.update(created.entity_id, {
        project_dna: { ...created.project_dna, mission: 'rewritten constitution' },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });

  it('bites from creation, not only once completed — unlike Memory Object (§5.1)', () => {
    const store = projectStore();
    const created = store.create(makeProject({ lifecycle_state: 'created' }));
    expect(created.lifecycle_state).toBe('created');

    // Memory Objects only lock at 'completed'. Project DNA is constitutional from birth.
    expect(() =>
      store.update(created.entity_id, {
        project_dna: { ...created.project_dna, non_goals: [] },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });

  it('permits a no-op write of an identical DNA value', () => {
    const store = projectStore();
    const created = store.create(makeProject());

    // Value-compared, not key-presence-compared: resubmitting the same DNA is not a
    // mutation and must not be a spurious failure.
    expect(() =>
      store.update(created.entity_id, { project_dna: created.project_dna } as never),
    ).not.toThrow();
  });
});

describe('Project DNA immutability — what stays MUTABLE', () => {
  it('permits project_status transitions — they are not DNA mutations', () => {
    const store = projectStore();
    const created = store.create(makeProject());

    const updated = store.update(created.entity_id, { project_status: 'paused' } as never);
    expect(updated.project_status).toBe('paused');
    expect(updated.project_dna.mission).toBe('an AI-native engineering organization');
  });

  it('permits project_phase transitions, including BACKWARD ones (Ch.6, non-monotonic)', () => {
    const store = projectStore();
    const created = store.create(makeProject({ project_phase: 'validation' }));

    // "Projects may revisit earlier stages as new information emerges." No forward-only
    // rule, unlike Objective promotion.
    const updated = store.update(created.entity_id, { project_phase: 'implementation' } as never);
    expect(updated.project_phase).toBe('implementation');
  });

  it('permits lifecycle_state transitions and appends history (§11)', () => {
    const store = projectStore();
    const created = store.create(makeProject());

    const completed = store.transitionLifecycle(created.entity_id, 'completed', FOUNDER);
    expect(completed.lifecycle_state).toBe('completed');
    expect(completed.lifecycle_history.map((h) => h.state)).toEqual(['completed']);
    expect(completed.project_dna.mission).toBe('an AI-native engineering organization');
  });

  it('still refuses DNA changes after the project is completed', () => {
    const store = projectStore();
    const created = store.create(makeProject());
    store.transitionLifecycle(created.entity_id, 'completed', FOUNDER);

    // The Memory Object rule (§5.1) does not apply here — a completed Project is not
    // wholly frozen — but its DNA still is.
    expect(() =>
      store.update(created.entity_id, {
        project_dna: { ...created.project_dna, mission: 'late edit' },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });

  it('permits non-DNA field writes such as purpose', () => {
    const store = projectStore();
    const created = store.create(makeProject());

    const updated = store.update(created.entity_id, { purpose: 'restated purpose' } as never);
    expect(updated.purpose).toBe('restated purpose');
    expect(updated.version).toBe(created.version + 1);
  });
});
