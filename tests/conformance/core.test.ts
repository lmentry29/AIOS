import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentEntity,
  CanonicalEntity,
  ObjectiveEntity,
  PluginEntity,
  ProjectEntity,
  TaskEntity,
  WorkflowEntity,
} from '@aios/core';
import { FOUNDER, makeAgent, makeObjective, makeProject, makeTask } from './fixtures.js';

/**
 * CONFORMANCE SUBJECT: @aios/core
 *
 * Declared scope (AIOS-CONFORMANCE §7.7): the CanonicalEntity base schema (COM §3) and
 * the five entity-type extensions (COM §4) as implemented in packages/core/src/schema/.
 * Conformance Class: AIOS Core Specification + Canonical Object Model, "Foundation"
 * class per Appendix A's example matrix.
 *
 * Every assertion below cites the specific normative sentence it traces to, per
 * AIOS-CONFORMANCE §4.6 (Principle of Complete Traceability) and §6.8 (Compliance
 * Evidence SHALL correspond directly to one or more normative requirements).
 */

describe('Requirement Category: Architectural — every entity type extends the base schema (COM §3 intro, §1 design principle 2)', () => {
  // "Every Agent, Task, Workflow, Plugin, and Canonical Object instance carries these
  // fields. Type-specific schemas (§4–§5) add to this set; none may omit it." (COM §3)
  // "Type-specific fields are additive, not replacements." (COM §1, design principle 2)
  // Proof of extension (not redefinition): each type schema must still reject an
  // otherwise-valid instance missing a base-schema field.
  const cases: Array<[string, { parse: (v: unknown) => unknown }, () => Record<string, unknown>]> = [
    ['AgentEntity', AgentEntity, () => makeAgent() as unknown as Record<string, unknown>],
    ['TaskEntity', TaskEntity, () => makeTask() as unknown as Record<string, unknown>],
    ['ObjectiveEntity', ObjectiveEntity, () => makeObjective() as unknown as Record<string, unknown>],
    ['ProjectEntity', ProjectEntity, () => makeProject() as unknown as Record<string, unknown>],
  ];

  it.each(cases)('%s rejects an instance missing the base schema’s owner_id (§3, §7)', (_name, schema, make) => {
    const instance = make();
    instance.owner_id = undefined;
    expect(() => schema.parse(instance)).toThrow();
  });

  it.each(cases)('%s rejects a non-UUID entity_id (COM §9, §3.1)', (_name, schema, make) => {
    const instance = make();
    instance.entity_id = 'not-a-uuid';
    expect(() => schema.parse(instance)).toThrow();
  });
});

describe('Requirement Category: Semantic — entity_type discriminator pins one literal per type (COM §3.1, §4 table)', () => {
  // "entity_type | enum(...) | Yes | Discriminator. Determines which type-specific
  // schema (§4–§5) applies." (COM §3.1) — an instance carrying the wrong discriminator
  // must be rejected, not silently coerced to the schema being used to parse it.
  it('AgentEntity rejects entity_type "task"', () => {
    expect(() => AgentEntity.parse(makeAgent({ entity_type: 'task' }))).toThrow();
  });

  it('TaskEntity rejects entity_type "agent"', () => {
    expect(() => TaskEntity.parse(makeTask({ entity_type: 'agent' }))).toThrow();
  });

  it('WorkflowEntity requires entity_type "workflow"', () => {
    expect(() =>
      WorkflowEntity.parse({
        entity_id: randomUUID(),
        entity_type: 'task',
        name: 'x',
        lifecycle_state: 'created',
        lifecycle_history: [],
        created_at: new Date().toISOString(),
        created_by: 'human:founder',
        modified_at: new Date().toISOString(),
        version: 1,
        owner_id: 'human:founder',
        owner_type: 'human',
        steps: [],
        governing_loop: 'system_execution_loop',
      }),
    ).toThrow();
  });

  it('PluginEntity requires entity_type "plugin"', () => {
    expect(() =>
      PluginEntity.parse({
        entity_id: randomUUID(),
        entity_type: 'agent',
        name: 'x',
        lifecycle_state: 'created',
        lifecycle_history: [],
        created_at: new Date().toISOString(),
        created_by: 'human:founder',
        modified_at: new Date().toISOString(),
        version: 1,
        owner_id: 'human:founder',
        owner_type: 'human',
        governing_layer: 'tool_abstraction_layer',
        install_status: 'available',
      }),
    ).toThrow();
  });
});

describe('Requirement Category: Semantic — actor identity scheme (COM §9, §3.3)', () => {
  // "Human identity uses the human:<founder_id> convention... No entity is ever
  // identified by name alone." (COM §9) `created_by` and `owner_id` both use the
  // ActorRef type, which must reject an arbitrary bare string.
  it('CanonicalEntity rejects a bare name as created_by', () => {
    const instance = makeTask({ created_by: 'the founder' }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });

  it('CanonicalEntity rejects a bare name as owner_id', () => {
    const instance = makeTask({ owner_id: 'the founder' }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });

  it('CanonicalEntity accepts a UUID or "human:<id>" for both created_by and owner_id', () => {
    const agentId = randomUUID();
    const instance = makeTask({ created_by: agentId, owner_id: FOUNDER });
    expect(() => TaskEntity.parse(instance)).not.toThrow();
  });
});

describe('Requirement Category: Lifecycle — Agent is never a Work Hierarchy member (COM §4.1)', () => {
  // "An Agent or Plugin instance is not itself a Work Hierarchy member and omits this
  // field — it *acts on* Tasks rather than occupying a position in the hierarchy."
  // (COM §3.4) Enforced by AgentEntity's own .refine(), per packages/core/src/schema/agent.ts.
  it('rejects an Agent instance carrying work_hierarchy_parent', () => {
    const bad = makeAgent({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    });
    expect(() => AgentEntity.parse(bad)).toThrow();
  });

  it('accepts an Agent instance without work_hierarchy_parent', () => {
    expect(() => AgentEntity.parse(makeAgent())).not.toThrow();
  });
});

describe('Requirement Category: Lifecycle — Task’s parent is always an Objective (COM §4.2, ADR-0004 chain)', () => {
  // "work_hierarchy_parent is REQUIRED at level 'objective' (a Task's parent must be
  // an Objective, never a Mission or another Task directly — per ADR-0004's canonical
  // chain Mission → Objective → Task → Action)." (COM §4.2)
  it('rejects a Task with no work_hierarchy_parent at all', () => {
    const instance = makeTask() as unknown as Record<string, unknown>;
    instance.work_hierarchy_parent = undefined;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });

  it('rejects a Task parented at level "mission"', () => {
    const bad = makeTask({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'mission' } });
    expect(() => TaskEntity.parse(bad)).toThrow();
  });

  it('rejects a Task parented at level "task"', () => {
    const bad = makeTask({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'task' } });
    expect(() => TaskEntity.parse(bad)).toThrow();
  });
});

describe('Requirement Category: Semantic — Objective is gradeable (COM §5.3, ADR-0010 §4)', () => {
  // "success_criteria | ... | Non-empty: an Objective with no success criteria is not
  // gradeable (ADR-0010 §4)." Same rule stated for acceptance_criteria.
  it('rejects an Objective with empty success_criteria', () => {
    const bad = makeObjective({ success_criteria: [] });
    expect(() => ObjectiveEntity.parse(bad)).toThrow();
  });

  it('rejects an Objective with empty acceptance_criteria', () => {
    const bad = makeObjective({ acceptance_criteria: [] });
    expect(() => ObjectiveEntity.parse(bad)).toThrow();
  });
});

describe('Requirement Category: Architectural — Project’s three status axes are never cross-valid (COM §5.4, ADR-0011 Consequence 4)', () => {
  // "No axis may be derived from, defaulted from, aliased to, or validated against
  // another. No shared enum, no shared union..." (COM §5.4) A value legal on one axis
  // must be rejected when supplied on a different axis, even where the literal string
  // is shared vocabulary (e.g. "archived" / "active").
  it('rejects project_status "active" (that literal belongs to lifecycle_state, not project_status)', () => {
    const bad = makeProject({ project_status: 'active' });
    expect(() => ProjectEntity.parse(bad)).toThrow();
  });

  it('rejects project_phase "active_development" (that literal belongs to project_status, not project_phase)', () => {
    const bad = makeProject({ project_phase: 'active_development' });
    expect(() => ProjectEntity.parse(bad)).toThrow();
  });

  it('accepts the SHELVED_PROJECT combination — every axis independently true at once (ADR-0011 Consequence 4, required fixture)', () => {
    const shelved = makeProject({
      project_status: 'archived',
      lifecycle_state: 'active',
      project_phase: 'operation',
    });
    const parsed = ProjectEntity.parse(shelved);
    expect(parsed.project_status).toBe('archived');
    expect(parsed.lifecycle_state).toBe('active');
    expect(parsed.project_phase).toBe('operation');
  });

  it('rejects a Project carrying work_hierarchy_parent — a container is not a Work Hierarchy level (COM §2d, §5.4)', () => {
    const bad = makeProject({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    });
    expect(() => ProjectEntity.parse(bad)).toThrow();
  });
});

describe('Requirement Category: Architectural — no sixth entity type (ADR-0007 boundary; COM §1 design principle 1, §2c, §2d)', () => {
  // "ADR-0003 names exactly five entity types as lifecycle-bearing... The COM
  // formalizes these five and nothing else at the top level." Objective and Project
  // are Canonical Object SUBTYPES, not new entity_type values — CanonicalEntity's
  // entity_type enum must not contain 'objective' or 'project'.
  it('CanonicalEntity’s entity_type enum contains exactly the five ADR-0003 types', () => {
    const shape = CanonicalEntity.shape.entity_type;
    expect(shape.options).toEqual(['agent', 'task', 'workflow', 'plugin', 'canonical_object']);
  });

  it('an Objective’s entity_type is "canonical_object", with "objective" carried in entity_subtype', () => {
    const objective = ObjectiveEntity.parse(makeObjective());
    expect(objective.entity_type).toBe('canonical_object');
    expect(objective.entity_subtype).toBe('objective');
  });

  it('a Project’s entity_type is "canonical_object", with "project" carried in entity_subtype', () => {
    const project = ProjectEntity.parse(makeProject());
    expect(project.entity_type).toBe('canonical_object');
    expect(project.entity_subtype).toBe('project');
  });
});
