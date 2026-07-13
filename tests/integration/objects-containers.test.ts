import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@aios/containers';
import { EntityIdConflictError, ImmutableProjectFieldError } from '@aios/objects';
import { TaskStore } from '@aios/work-hierarchy';
import { FOUNDER, makeProject, makeTask } from './fixtures.js';

/**
 * BOUNDARY: @aios/objects → @aios/containers
 *
 * ProjectStore is a thin wrapper constructing ObjectStore<ProjectEntity>. The contract
 * across this edge is that it INHERITS ObjectStore's COM guarantees rather than
 * reimplementing them — identity (§9), atomic writes (§11), append-only history (§11),
 * and Project DNA immutability (§5.4) — and that the three orthogonal status axes
 * survive persistence without any of them aliasing another.
 *
 * Testing that from inside @aios/containers proves less: it would re-test ObjectStore
 * through a different import path. What matters is that the guarantees actually arrive
 * intact across the package boundary, which is only observable here.
 *
 * NOTE ON THE DEPENDENCY EDGE ITSELF: runtime-interfaces.md §3/§4 show no
 * objects→containers edge (they say containers depends on core only). That graph
 * predates ADR-0011 — it was drawn when no container type had a schema or a store.
 * COM §5.4 ratifies ObjectStore<ProjectEntity> explicitly. This test suite is the
 * evidence the edge exists and works; the graph is stale, not the code. See
 * docs/process/divergence-log.md.
 */

describe('objects → containers: Project-specific fields survive persistence', () => {
  it('round-trips the DNA value object and both new status axes', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const fetched = store.getProject(created.entity_id);
    // A base-schema store would have stripped every one of these (COM §10).
    expect(fetched?.project_dna.non_goals).toEqual(['a general agent framework']);
    expect(fetched?.project_dna.governance_constraints).toEqual(['ADR-gated']);
    expect(fetched?.project_status).toBe('active_development');
    expect(fetched?.project_phase).toBe('implementation');
    expect(fetched?.mission).toBe('an AI-native engineering organization');
  });

  it('keeps Project-specific fields through an update, not just on create', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const updated = store.updateProject(created.entity_id, { purpose: 'restated' });

    expect(updated.purpose).toBe('restated');
    expect(updated.project_dna.mission).toBe('an AI-native engineering organization');
    expect(updated.project_phase).toBe('implementation');
  });
});

describe('objects → containers: ObjectStore’s COM guarantees arrive intact', () => {
  it('inherits identity rules — entity_id is not reusable after archival (COM §9)', () => {
    const store = new ProjectStore();
    const project = makeProject();
    store.createProject(project);
    store.transitionProjectLifecycle(project.entity_id, 'archived', FOUNDER);

    // ProjectStore does not implement this rule. It gets it from ObjectStore.
    expect(() => store.createProject(project)).toThrow(EntityIdConflictError);
  });

  it('inherits atomic version/modified_at bumps (COM §11)', async () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = store.updateProject(created.entity_id, { purpose: 'bumped' });

    expect(updated.version).toBe(created.version + 1);
    expect(Date.parse(updated.modified_at)).toBeGreaterThan(Date.parse(created.modified_at));
  });

  it('inherits Project DNA immutability from the persistence layer (COM §5.4)', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    // The write-time rule lives in @aios/objects, not here — this asserts it crosses.
    expect(() =>
      store.updateProject(created.entity_id, {
        project_dna: { ...created.project_dna, mission: 'rewritten constitution' },
      } as never),
    ).toThrow(ImmutableProjectFieldError);
  });
});

describe('objects → containers: the three axes stay orthogonal through persistence', () => {
  it('persists SHELVED_PROJECT — archived status, live record, shipped phase', () => {
    // The canonical no-aliasing case (ADR-0011 Consequence 4), exercised across the
    // package boundary. An aliasing bug in @aios/objects — not just in the schema —
    // would surface here.
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

  it('reaches SHELVED_PROJECT by transition through the store', () => {
    const store = new ProjectStore();
    const created = store.createProject(
      makeProject({ project_status: 'active_development', project_phase: 'operation' }),
    );

    const shelved = store.setProjectStatus(created.entity_id, 'archived', FOUNDER);

    // Shelving is an operational act. It must not archive the record, and must not
    // rewind the phase.
    expect(shelved.project_status).toBe('archived');
    expect(shelved.lifecycle_state).toBe('active');
    expect(shelved.project_phase).toBe('operation');
  });

  it('appends project_status_history across the boundary (Ch.7 auditability)', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    store.setProjectStatus(created.entity_id, 'blocked', FOUNDER);
    const paused = store.setProjectStatus(created.entity_id, 'paused', FOUNDER);

    expect(paused.project_status_history.map((h) => h.status)).toEqual(['blocked', 'paused']);
    expect(paused.project_status_history.every((h) => h.actor === FOUNDER)).toBe(true);
  });

  it('keeps lifecycle_history and project_status_history as separate append-only trails', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    store.setProjectStatus(created.entity_id, 'paused', FOUNDER);
    const final = store.transitionProjectLifecycle(created.entity_id, 'completed', FOUNDER);

    // Two axes, two trails. Neither writes into the other.
    expect(final.lifecycle_history.map((h) => h.state)).toEqual(['completed']);
    expect(final.project_status_history.map((h) => h.status)).toEqual(['paused']);
  });
});

describe('objects → containers: a Project is a container, not a Work Hierarchy level', () => {
  it('rejects a Project carrying work_hierarchy_parent (AGENTS.md rule 4)', () => {
    const store = new ProjectStore();
    const bad = makeProject({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    });

    expect(() => store.createProject(bad)).toThrow();
  });

  it('scopes a Task into a Project via organizational_containers, never via the hierarchy', () => {
    // The cross-package shape of AGENTS.md rule 4: a Task sits UNDER an Objective in the
    // Work Hierarchy, and INSIDE a Project as a container. Two different fields, and
    // they must never merge.
    const projects = new ProjectStore();
    const tasks = new TaskStore();

    const project = projects.createProject(makeProject());
    const objectiveId = randomUUID();

    const task = tasks.createTask(
      makeTask({
        work_hierarchy_parent: { entity_id: objectiveId, level: 'objective' },
        organizational_containers: [
          { entity_id: project.entity_id, container_type: 'project' },
        ],
      }),
    );

    // The container reference dereferences — this is what ADR-0011 bought.
    const container = task.organizational_containers[0];
    expect(container?.container_type).toBe('project');
    expect(projects.getProject(container?.entity_id ?? '')?.name).toBe('AIOS');

    // The hierarchy parent is a different id, a different field, and resolves nowhere
    // near the container store.
    expect(task.work_hierarchy_parent.entity_id).toBe(objectiveId);
    expect(task.work_hierarchy_parent.entity_id).not.toBe(container?.entity_id);
    expect(projects.getProject(task.work_hierarchy_parent.entity_id)).toBeUndefined();
  });

  it('leaves the other eight container types dereferencing to nothing (ADR-0011, Consequence 2)', () => {
    // organizational_containers is only PARTIALLY dereferenceable. Callers must branch
    // on container_type. This pins that wart so it is not mistaken for a bug later.
    const projects = new ProjectStore();
    const tasks = new TaskStore();

    const milestoneId = randomUUID();
    const task = tasks.createTask(
      makeTask({
        organizational_containers: [
          { entity_id: milestoneId, container_type: 'milestone' },
        ],
      }),
    );

    const container = task.organizational_containers[0];
    expect(container?.container_type).toBe('milestone');
    // Well-typed, and resolves to nothing. There is no MilestoneStore, by design —
    // the corpus specifies no field-level model for it.
    expect(projects.getProject(container?.entity_id ?? '')).toBeUndefined();
  });
});
