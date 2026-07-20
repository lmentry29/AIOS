import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@aios/containers';
import { FOUNDER, makeProject } from './fixtures.js';

/**
 * CONFORMANCE SUBJECT: @aios/containers
 *
 * Declared scope (AIOS-CONFORMANCE §7.6/§7.7): ProjectStore only. Per
 * packages/containers/src/index.ts's own header, the other eight Organizational
 * Container types (program, release, milestone, epic, feature, roadmap, vision,
 * workspace) have no field-level specification in the certified corpus and therefore
 * have no schema, no store, and no declared conformance claim here (ADR-0011). This
 * suite does not assert requirements for those eight — asserting their absence of
 * support IS the conformance-relevant fact (AIOS-CONFORMANCE §7.6, Declared
 * Capabilities: "Capabilities not explicitly declared SHALL NOT be considered during
 * conformance evaluation").
 */

describe('Requirement Category: Semantic — the three status axes never alias, end to end through the store (COM §5.4, ADR-0011 Consequence 4)', () => {
  // "No axis may be derived from, defaulted from, aliased to, or validated against
  // another." (COM §5.4) The REQUIRED SHELVED_PROJECT fixture (ADR-0011 Consequence 4)
  // is the canonical proof case: every value differs and none is inferable from the
  // others. Persisted and read back through ProjectStore, not just parsed once.
  it('SHELVED_PROJECT persists and round-trips with all three axis values intact', () => {
    const store = new ProjectStore();
    const created = store.createProject(
      makeProject({ project_status: 'archived', lifecycle_state: 'active', project_phase: 'operation' }),
    );

    const fetched = store.getProject(created.entity_id);
    expect(fetched?.project_status).toBe('archived');
    expect(fetched?.lifecycle_state).toBe('active');
    expect(fetched?.project_phase).toBe('operation');
  });

  it('setProjectStatus writes only project_status — lifecycle_state and project_phase are untouched', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject({ project_status: 'active_development', project_phase: 'operation', lifecycle_state: 'active' }));

    const shelved = store.setProjectStatus(created.entity_id, 'archived', FOUNDER);

    expect(shelved.project_status).toBe('archived');
    expect(shelved.lifecycle_state).toBe('active');
    expect(shelved.project_phase).toBe('operation');
  });
});

describe('Requirement Category: Behavioral — project_phase transitions are not monotonic (COM §5.4 Ch.6, ADR-0011 Consequence 5)', () => {
  // "NOT MONOTONIC. Ch.6: 'Projects may revisit earlier stages.' A backward transition
  // is legal and must not be rejected." (COM §5.4) Unlike Objective's forward-only
  // promotion (ADR-0010), no ordering constraint applies to project_phase.
  it('permits a backward phase transition from "operation" to "implementation"', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject({ project_phase: 'operation' }));

    const reverted = store.setProjectPhase(created.entity_id, 'implementation');

    expect(reverted.project_phase).toBe('implementation');
  });
});

describe('Requirement Category: Documentation/Governance — auditability is asymmetric across the two operational axes (Ch.7 vs Ch.6, ADR-0011 Consequence 6)', () => {
  // Ch.7: "State transitions are explicit and auditable" -> project_status_history,
  // append-only (COM §5.4). Ch.6 states no equivalent requirement for project_phase,
  // and COM §5.4 states this explicitly: "There is deliberately no
  // project_phase_history." A conformant implementation must provide the first and
  // must NOT invent the second.
  it('appends to project_status_history on every setProjectStatus call', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    store.setProjectStatus(created.entity_id, 'blocked', FOUNDER);
    const paused = store.setProjectStatus(created.entity_id, 'paused', FOUNDER);

    expect(paused.project_status_history.map((h) => h.status)).toEqual(['blocked', 'paused']);
    expect(paused.project_status_history.every((h) => h.actor === FOUNDER)).toBe(true);
  });

  it('exposes no project_phase_history field on the persisted record', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());
    store.setProjectPhase(created.entity_id, 'evolution');

    const fetched = store.getProject(created.entity_id) as unknown as Record<string, unknown>;
    expect(fetched.project_phase_history).toBeUndefined();
  });
});

describe('Requirement Category: Architectural — Project is a container, not a Work Hierarchy level (COM §2d, §5.4)', () => {
  // "A Project must not carry work_hierarchy_parent (§3.4); it is not a rung of
  // Mission → Objective → Task → Action." (COM §2d) Schema-level rejection is proven
  // in core.test.ts; this proves the store's create() path surfaces it.
  it('ProjectStore.createProject rejects a Project carrying work_hierarchy_parent', () => {
    const store = new ProjectStore();
    const bad = makeProject({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' } });
    expect(() => store.createProject(bad)).toThrow();
  });
});

describe('Requirement Category: Architectural — declared scope is Project only; the other eight container types are not claimed (ADR-0011 Consequence 2, AIOS-CONFORMANCE §7.6)', () => {
  // "Callers cannot assume a container id is resolvable — they must branch on
  // container_type." (ADR-0011, Consequence 2) @aios/containers exposes no lookup
  // capability for any container_type other than 'project'. Per AIOS-CONFORMANCE §7.6,
  // an undeclared capability is correctly absent, not a gap to paper over.
  it('exposes no exported store, symbol, or lookup for any container type other than project', async () => {
    const containers = await import('@aios/containers');
    const exportNames = Object.keys(containers);
    expect(exportNames).toContain('ProjectStore');
    for (const type of ['Program', 'Release', 'Milestone', 'Epic', 'Feature', 'Roadmap', 'Vision', 'Workspace']) {
      expect(exportNames.some((n) => n.includes(type))).toBe(false);
    }
  });
});

describe('Requirement Category: Behavioral — deleteProject is a soft delete along the record axis only (COM §9, §11, ADR-0011 Consequence 4)', () => {
  // "There is no hard-delete in this architecture... this is the soft-delete:
  // transition to the terminal 'archived' lifecycle_state." (ProjectStore's own
  // documented contract, consistent with COM §9's "entity_id is never
  // reused/reassigned" and §11's "one canonical record per entity_id.") It writes only
  // the RECORD lifecycle axis — project_status and project_phase, being different
  // axes (ADR-0011 Consequence 4), must not move as a side effect.
  it('transitions lifecycle_state to archived via the append-only lifecycle_history mechanism', () => {
    const store = new ProjectStore();
    const created = store.createProject(makeProject());

    const deleted = store.deleteProject(created.entity_id, FOUNDER);

    expect(deleted.lifecycle_state).toBe('archived');
    expect(deleted.lifecycle_history.map((h) => h.state)).toEqual(['archived']);
  });

  it('does not alter project_status or project_phase as a side effect of deletion', () => {
    const store = new ProjectStore();
    const created = store.createProject(
      makeProject({ project_status: 'active_development', project_phase: 'implementation' }),
    );

    const deleted = store.deleteProject(created.entity_id, FOUNDER);

    expect(deleted.project_status).toBe('active_development');
    expect(deleted.project_phase).toBe('implementation');
  });
});
