import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_IMMUTABLE_FIELDS,
  ProjectEntity,
  ProjectPhase,
  ProjectStatus,
} from '../src/index.js';

const FOUNDER = 'human:founder';

function makeProject(overrides: Record<string, unknown> = {}) {
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
      core_principles: ['no unilateral resolution of architectural conflicts'],
      target_users: ['the founder'],
      architectural_philosophy: 'doc-first, then validate against code',
      quality_expectations: ['typecheck and lint clean before every commit'],
      long_term_objectives: ['full autonomy'],
      non_goals: ['a general-purpose agent framework'],
      governance_constraints: ['ADR-gated architecture changes'],
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
  };
}

describe('ProjectEntity (COM §5.4, ADR-0011)', () => {
  it('accepts a well-formed Project', () => {
    expect(ProjectEntity.safeParse(makeProject()).success).toBe(true);
  });

  it('is a Canonical Object subtype, not a sixth entity type', () => {
    const parsed = ProjectEntity.parse(makeProject());
    expect(parsed.entity_type).toBe('canonical_object');
    expect(parsed.entity_subtype).toBe('project');
  });

  it('embeds project_dna as a value object with no identity of its own', () => {
    const parsed = ProjectEntity.parse(makeProject());
    expect(parsed.project_dna.mission).toBe('an AI-native engineering organization');
    expect(parsed.project_dna.non_goals).toEqual(['a general-purpose agent framework']);
    // A value object has no entity_id — if it ever grows one, it has become an entity.
    expect((parsed.project_dna as Record<string, unknown>).entity_id).toBeUndefined();
  });

  it('names project_dna as the only immutable field', () => {
    expect(PROJECT_IMMUTABLE_FIELDS).toEqual(['project_dna']);
  });
});

describe('ProjectEntity — Project is a container, NOT a Work Hierarchy level', () => {
  it('rejects a Project carrying work_hierarchy_parent (AGENTS.md rule 4)', () => {
    // Merging the Work Hierarchy with Organizational Containers is the defect ADR-0004
    // Amendment A corrected in four separate places. A Project holds work; it is not a
    // rung of Mission → Objective → Task → Action.
    const bad = makeProject({
      work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    });
    expect(ProjectEntity.safeParse(bad).success).toBe(false);
  });

  it('treats mission and vision as prose strings, not references', () => {
    const parsed = ProjectEntity.parse(makeProject());
    // If either were a reference, these would be UUIDs. They are statements.
    expect(parsed.mission).toBe('an AI-native engineering organization');
    expect(parsed.vision).toBe('software that plans and builds itself');
  });
});

describe('ProjectEntity — three orthogonal status axes (COM §5.4)', () => {
  it('exposes Ch.7’s nine operational states', () => {
    expect(ProjectStatus.options).toEqual([
      'initializing',
      'planning',
      'active_development',
      'maintenance',
      'paused',
      'blocked',
      'migrating',
      'archived',
      'retired',
    ]);
  });

  it('exposes Ch.6’s eleven developmental stages', () => {
    expect(ProjectPhase.options).toEqual([
      'concept',
      'research',
      'architecture',
      'planning',
      'implementation',
      'validation',
      'deployment',
      'operation',
      'evolution',
      'retirement',
      'archive',
    ]);
  });

  it('keeps the three axes as separate vocabularies — they are NOT the same enum', () => {
    // If any two axes were ever aliased to a shared type, these sets would converge.
    // lifecycle_state's vocabulary is ADR-0003's; neither of the others matches it.
    expect(ProjectStatus.options).not.toEqual(ProjectPhase.options);
    expect(ProjectStatus.options).not.toContain('created');
    expect(ProjectPhase.options).not.toContain('created');
  });

  it('accepts every project_status value independently of phase and lifecycle', () => {
    for (const status of ProjectStatus.options) {
      const result = ProjectEntity.safeParse(makeProject({ project_status: status }));
      expect(result.success, `project_status '${status}' should be valid`).toBe(true);
    }
  });

  it('accepts every project_phase value independently of status and lifecycle', () => {
    for (const phase of ProjectPhase.options) {
      const result = ProjectEntity.safeParse(makeProject({ project_phase: phase }));
      expect(result.success, `project_phase '${phase}' should be valid`).toBe(true);
    }
  });

  it('rejects a project_status value borrowed from the lifecycle vocabulary', () => {
    // 'created' is a lifecycle_state, not a project_status. Cross-axis leakage must not
    // validate.
    expect(ProjectEntity.safeParse(makeProject({ project_status: 'created' })).success).toBe(
      false,
    );
  });

  it('rejects a project_phase value borrowed from the project_status vocabulary', () => {
    // 'paused' is an operational status, not a developmental phase.
    expect(ProjectEntity.safeParse(makeProject({ project_phase: 'paused' })).success).toBe(false);
  });
});

describe('ProjectEntity — project_status_history (Ch.7 auditability)', () => {
  it('defaults to an empty array', () => {
    const parsed = ProjectEntity.parse(makeProject());
    expect(parsed.project_status_history).toEqual([]);
  });

  it('accepts entries of { status, entered_at, actor }', () => {
    const parsed = ProjectEntity.parse(
      makeProject({
        project_status_history: [
          { status: 'initializing', entered_at: new Date().toISOString(), actor: FOUNDER },
          { status: 'active_development', entered_at: new Date().toISOString(), actor: FOUNDER },
        ],
      }),
    );
    expect(parsed.project_status_history.map((h) => h.status)).toEqual([
      'initializing',
      'active_development',
    ]);
  });

  it('rejects a history entry whose actor is a bare name (COM §9)', () => {
    const bad = makeProject({
      project_status_history: [
        { status: 'planning', entered_at: new Date().toISOString(), actor: 'alice' },
      ],
    });
    expect(ProjectEntity.safeParse(bad).success).toBe(false);
  });

  it('rejects an epoch timestamp in history (COM §10 requires ISO 8601)', () => {
    const bad = makeProject({
      project_status_history: [{ status: 'planning', entered_at: 1752300000, actor: FOUNDER }],
    });
    expect(ProjectEntity.safeParse(bad).success).toBe(false);
  });

  it('has no project_phase_history — Ch.6 states no auditability requirement', () => {
    const parsed = ProjectEntity.parse(makeProject());
    // Deliberately absent (ADR-0011, Consequence 6). Inventing one would be unsourced.
    expect((parsed as Record<string, unknown>).project_phase_history).toBeUndefined();
  });
});
