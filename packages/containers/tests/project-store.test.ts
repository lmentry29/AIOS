import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectEntity } from '@aios/core';
import {
  EntityIdConflictError,
  EntityNotFoundError,
  ImmutableProjectFieldError,
} from '@aios/objects';
import { ProjectStore } from '../src/project-store.js';

const FOUNDER = 'human:founder';

function makeProject(overrides: Record<string, unknown> = {}): ProjectEntity {
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
  } as unknown as ProjectEntity;
}

describe('ProjectStore (ADR-0011, COM §5.4)', () => {
  it('creates and retrieves a Project with all Project-specific fields intact', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());
    const fetched = store.getProject(created.entity_id);

    expect(fetched?.entity_subtype).toBe('project');
    expect(fetched?.purpose).toBe('make the architecture executable');
    expect(fetched?.project_dna.non_goals).toEqual(['a general agent framework']);
    expect(fetched?.project_status).toBe('active_development');
    expect(fetched?.project_phase).toBe('implementation');
  });

  it('inherits identity rules — entity_id is not reusable after archival (COM §9)', () => {
    const store = new ProjectStore();
    const project = makeProject();
    store.createProject(project);
    store.transitionProjectLifecycle(project.entity_id, 'archived', FOUNDER);

    expect(() => store.createProject(project)).toThrow(EntityIdConflictError);
  });

  it('rejects a Project carrying work_hierarchy_parent — a container is not a hierarchy level', () => {
    const store = new ProjectStore();
    const bad = makeProject({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    });
    expect(() => store.createProject(bad)).toThrow();
  });

  it('lists only projects, not sibling Canonical Object subtypes', () => {
    const store = new ProjectStore();
    store.createProject(makeProject({ name: 'a' }));
    store.createProject(makeProject({ name: 'b' }));

    const listed = store.listProjects();
    expect(listed).toHaveLength(2);
    expect(listed.every((p) => p.entity_subtype === 'project')).toBe(true);
  });
});

describe('ProjectStore — project_status and its audit trail (Ch.7)', () => {
  it('sets status and appends to project_status_history', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());
    expect(created.project_status_history).toEqual([]);

    store.setProjectStatus(created.entity_id, 'blocked', FOUNDER);
    const updated = store.setProjectStatus(created.entity_id, 'paused', FOUNDER);

    // Ch.7: "State transitions are explicit and auditable."
    expect(updated.project_status).toBe('paused');
    expect(updated.project_status_history.map((h) => h.status)).toEqual(['blocked', 'paused']);
    expect(updated.project_status_history.every((h) => h.actor === FOUNDER)).toBe(true);
  });

  it('appends rather than overwriting history (AGENTS.md rule 5)', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    store.setProjectStatus(created.entity_id, 'blocked', FOUNDER);
    store.setProjectStatus(created.entity_id, 'active_development', FOUNDER);
    const final = store.setProjectStatus(created.entity_id, 'maintenance', FOUNDER);

    expect(final.project_status_history).toHaveLength(3);
  });

  it('never writes lifecycle_state or project_phase when setting status (no aliasing)', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const updated = store.setProjectStatus(created.entity_id, 'archived', FOUNDER);

    // 'archived' on the operational axis must NOT bleed into the other two.
    expect(updated.project_status).toBe('archived');
    expect(updated.lifecycle_state).toBe('active');
    expect(updated.project_phase).toBe('implementation');
  });
});

describe('ProjectStore — project_phase (Ch.6)', () => {
  it('sets phase without touching status or lifecycle', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const updated = store.setProjectPhase(created.entity_id, 'deployment');

    expect(updated.project_phase).toBe('deployment');
    expect(updated.project_status).toBe('active_development');
    expect(updated.lifecycle_state).toBe('active');
  });

  it('permits BACKWARD phase transitions — Ch.6 is not monotonic', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject({ project_phase: 'validation' }));

    // "Projects may revisit earlier stages as new information emerges."
    const updated = store.setProjectPhase(created.entity_id, 'implementation');
    expect(updated.project_phase).toBe('implementation');
  });

  it('keeps no phase history — Ch.6 states no auditability requirement', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());
    const updated = store.setProjectPhase(created.entity_id, 'evolution');

    expect((updated as Record<string, unknown>).project_phase_history).toBeUndefined();
  });
});

describe('ProjectStore — SHELVED_PROJECT round-trips through persistence', () => {
  it('persists project_status archived + lifecycle_state active + project_phase operation', () => {
    // The ADR-0011 Consequence 4 fixture, exercised through the STORE rather than the
    // schema alone — an aliasing bug in the persistence layer would surface here and
    // not in the core schema tests.
    const store = new ProjectStore();
    const created = store.createProject(
      makeProject({
        name: 'SHELVED_PROJECT',
        project_status: 'archived',
        lifecycle_state: 'active',
        project_phase: 'operation',
      }),
    );

    const fetched = store.getProject(created.entity_id);
    expect(fetched?.project_status).toBe('archived');
    expect(fetched?.lifecycle_state).toBe('active');
    expect(fetched?.project_phase).toBe('operation');
  });

  it('reaches SHELVED_PROJECT by transition, not just by construction', () => {
    const store = new ProjectStore();
    const created = store.createProject(
      makeProject({ project_status: 'active_development', project_phase: 'operation' }),
    );

    // Shelve it: operational status only. The record stays live; the phase stays shipped.
    const shelved = store.setProjectStatus(created.entity_id, 'archived', FOUNDER);

    expect(shelved.project_status).toBe('archived');
    expect(shelved.lifecycle_state).toBe('active');
    expect(shelved.project_phase).toBe('operation');
  });
});

describe('ProjectStore — deleteProject (soft delete via lifecycle)', () => {
  it('transitions lifecycle_state to archived and appends to lifecycle_history', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const deleted = store.deleteProject(created.entity_id, FOUNDER);
    expect(deleted.lifecycle_state).toBe('archived');

    // Verify persistence, not just the return value.
    const fetched = store.getProject(created.entity_id);
    expect(fetched?.lifecycle_state).toBe('archived');
    expect(fetched?.lifecycle_history).toHaveLength(1);
    expect(fetched?.lifecycle_history[0]).toMatchObject({
      state: 'archived',
      actor: FOUNDER,
    });
  });

  it('does not free entity_id for reuse — COM §9 identity rules still apply', () => {
    const store = new ProjectStore();
    const project = makeProject();
    store.createProject(project);
    store.deleteProject(project.entity_id, FOUNDER);

    expect(() => store.createProject(project)).toThrow(EntityIdConflictError);
  });

  it('throws EntityNotFoundError when the project does not exist', () => {
    const store = new ProjectStore();

    expect(() => store.deleteProject(randomUUID(), FOUNDER)).toThrow(EntityNotFoundError);
  });

  it('does not touch project_status or project_phase (no aliasing)', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const deleted = store.deleteProject(created.entity_id, FOUNDER);

    expect(deleted.project_status).toBe('active_development');
    expect(deleted.project_phase).toBe('implementation');
  });
});

describe('ProjectStore — Project DNA immutability (COM §5.4)', () => {
  it('refuses to change project_dna', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    expect(() =>
      store.updateProject(created.entity_id, {
        project_dna: { ...created.project_dna, mission: 'rewritten' },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });

  it('still permits status and phase transitions on a project whose DNA is frozen', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    store.setProjectStatus(created.entity_id, 'migrating', FOUNDER);
    const updated = store.setProjectPhase(created.entity_id, 'evolution');

    expect(updated.project_status).toBe('migrating');
    expect(updated.project_phase).toBe('evolution');
    expect(updated.project_dna.mission).toBe('an AI-native engineering organization');
  });
});
