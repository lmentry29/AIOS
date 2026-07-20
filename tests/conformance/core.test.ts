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

describe('Requirement Category: Architectural — name is a required base field (COM §3.1)', () => {
  // "name | string | Yes | Human-readable label. Not guaranteed unique." (COM §3.1)
  it('rejects an instance missing name', () => {
    const instance = makeTask() as unknown as Record<string, unknown>;
    instance.name = undefined;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });
});

describe('Requirement Category: Semantic — timestamps are ISO 8601, not epoch (COM §10, §3.3)', () => {
  // "Timestamps serialize as ISO 8601 UTC strings, not epoch integers." (COM §10)
  // created_at/modified_at are z.string().datetime() — an epoch-format string is a
  // legal `string` but not a legal ISO-8601 datetime, so this exercises the format
  // constraint specifically, not merely "must be a string."
  it('rejects an epoch-format timestamp string as created_at', () => {
    const instance = makeTask({ created_at: '1732000000000' }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });

  it('rejects an epoch-format timestamp string as modified_at', () => {
    const instance = makeTask({ modified_at: '1732000000000' }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });
});

describe('Requirement Category: Architectural — version is a positive integer (COM §3.3, §11)', () => {
  // "version | integer | Yes | Monotonically increasing." (COM §3.3) Base schema pins
  // this to z.number().int().positive() — zero and negative values are illegal.
  it('rejects version 0', () => {
    const instance = makeTask({ version: 0 }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });

  it('rejects a negative version', () => {
    const instance = makeTask({ version: -1 }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });
});

describe('Requirement Category: Architectural — organizational_containers container_type is a closed nine-value enum (COM §3.4)', () => {
  // "organizational_containers | array of reference + container_type enum('project',
  // 'program', 'release', 'milestone', 'epic', 'feature', 'roadmap', 'vision',
  // 'workspace')" (COM §3.4) — a closed set; nothing outside it is legal.
  it('rejects an organizational_containers entry with an unrecognized container_type', () => {
    const instance = makeTask({
      organizational_containers: [{ entity_id: randomUUID(), container_type: 'sprint' }],
    }) as unknown as Record<string, unknown>;
    expect(() => TaskEntity.parse(instance)).toThrow();
  });
});

describe('Requirement Category: Semantic — Objective priority and risk_profile are a closed four-value enum (ADR-0010, COM §5.3)', () => {
  // packages/core/src/schema/objective.ts: "ENUM MEMBERS ARE UNSOURCED... both reuse
  // the low/medium/high/critical scale this repo already uses for Memory Object's
  // importance" — the enum is closed to exactly those four values regardless of
  // provenance.
  it('rejects an unrecognized priority value', () => {
    const bad = makeObjective({ priority: 'urgent' });
    expect(() => ObjectiveEntity.parse(bad)).toThrow();
  });

  it('rejects an unrecognized risk_profile value', () => {
    const bad = makeObjective({ risk_profile: 'extreme' });
    expect(() => ObjectiveEntity.parse(bad)).toThrow();
  });

  it('accepts every value of the sourced four-value scale for both fields', () => {
    for (const level of ['low', 'medium', 'high', 'critical'] as const) {
      expect(() =>
        ObjectiveEntity.parse(makeObjective({ priority: level, risk_profile: level })),
      ).not.toThrow();
    }
  });
});

describe('Requirement Category: Semantic — project_status and project_phase carry their full sourced vocabulary (COM §5.4, ADR-0011)', () => {
  // Ch.7's nine operational states and Ch.6's eleven developmental stages (COM §5.4)
  // — every one of these must validate, and nothing outside either set may.
  const statuses = [
    'initializing', 'planning', 'active_development', 'maintenance',
    'paused', 'blocked', 'migrating', 'archived', 'retired',
  ] as const;
  const phases = [
    'concept', 'research', 'architecture', 'planning', 'implementation',
    'validation', 'deployment', 'operation', 'evolution', 'retirement', 'archive',
  ] as const;

  it('accepts every one of Ch.7’s nine operational states', () => {
    for (const status of statuses) {
      expect(() => ProjectEntity.parse(makeProject({ project_status: status }))).not.toThrow();
    }
  });

  it('accepts every one of Ch.6’s eleven developmental stages', () => {
    for (const phase of phases) {
      expect(() => ProjectEntity.parse(makeProject({ project_phase: phase }))).not.toThrow();
    }
  });

  it('rejects a project_status value outside the sourced nine', () => {
    expect(() => ProjectEntity.parse(makeProject({ project_status: 'onboarding' }))).toThrow();
  });

  it('rejects a project_phase value outside the sourced eleven', () => {
    expect(() => ProjectEntity.parse(makeProject({ project_phase: 'onboarding' }))).toThrow();
  });
});

describe('Requirement Category: Architectural — Action sub-object shape (COM §4.2.1)', () => {
  // "Action (sub-object, not a top-level entity)": action_id (UUID, unique within its
  // parent Task only — excluded from §3.1's global entity_id requirement), status
  // (enum pending/executing/completed/failed), executed_by (Agent entity_id, UUID).
  it('accepts a well-formed Action inside actions[]', () => {
    const task = makeTask({
      actions: [{ action_id: randomUUID(), status: 'executing', executed_by: randomUUID() }],
    });
    expect(() => TaskEntity.parse(task)).not.toThrow();
  });

  it('rejects an Action with a status outside the four-value enum', () => {
    const task = makeTask({
      actions: [{ action_id: randomUUID(), status: 'blocked', executed_by: randomUUID() }],
    });
    expect(() => TaskEntity.parse(task)).toThrow();
  });

  it('rejects an Action whose executed_by is not a UUID', () => {
    const task = makeTask({
      actions: [{ action_id: randomUUID(), status: 'pending', executed_by: 'agent-1' }],
    });
    expect(() => TaskEntity.parse(task)).toThrow();
  });
});
