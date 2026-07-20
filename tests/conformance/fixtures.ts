import { randomUUID } from 'node:crypto';
import type {
  AgentEntity,
  CanonicalEntity,
  MemoryObjectEntity,
  ObjectiveEntity,
  ProjectEntity,
  TaskEntity,
} from '@aios/core';

/**
 * Entity fixtures for the conformance suite. Deliberately duplicated from
 * tests/integration/fixtures.ts rather than imported across a vitest project
 * boundary — each vitest project in vitest.workspace.ts owns its own fixtures,
 * matching the established pattern.
 *
 * Every field is spelled out rather than defaulted, for the same reason the
 * integration suite spells them out: a fixture that quietly relies on a Zod
 * `.default()` would hide whether a field actually survived a conformance
 * assertion, which is exactly the class of failure this suite exists to catch.
 */

export const FOUNDER = 'human:founder';

function base(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    name: 'conformance fixture',
    lifecycle_state: 'created' as const,
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: 'human' as const,
    relationships: [],
    ...overrides,
  };
}

/** A Task, parented to an Objective per ADR-0004's Mission → Objective → Task chain. */
export function makeTask(overrides: Record<string, unknown> = {}): TaskEntity {
  return base({
    entity_type: 'task',
    name: 'conformance task',
    work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    actions: [],
    ...overrides,
  }) as unknown as TaskEntity;
}

/** An Agent. Never has a work_hierarchy_parent — it acts on Tasks (COM §4.1). */
export function makeAgent(overrides: Record<string, unknown> = {}): AgentEntity {
  return base({
    entity_type: 'agent',
    name: 'conformance agent',
    current_role: 'agent',
    governing_layer: 'organizational_departments',
    assigned_tasks: [],
    capabilities: [],
    ...overrides,
  }) as unknown as AgentEntity;
}

export function makeMemoryObject(overrides: Record<string, unknown> = {}): MemoryObjectEntity {
  return base({
    entity_type: 'canonical_object',
    entity_subtype: 'memory_object',
    name: 'conformance memory',
    memory_type: 'decision',
    confidence: 0.8,
    importance: 'high',
    evidence: [],
    source_references: [],
    ...overrides,
  }) as unknown as MemoryObjectEntity;
}

/**
 * An Objective — a Canonical Object subtype (`entity_subtype: 'objective'`), per
 * ADR-0010 / COM §5.3. All eight definition fields are populated.
 */
export function makeObjective(overrides: Record<string, unknown> = {}): ObjectiveEntity {
  return base({
    entity_type: 'canonical_object',
    entity_subtype: 'objective',
    name: 'reduce p95 build time',
    purpose: 'CI feedback is too slow to be useful',
    desired_outcome: 'p95 build under 3 minutes',
    constraints: ['no new CI vendors'],
    success_criteria: ['p95 < 180s over a 7-day window'],
    priority: 'high',
    risk_profile: 'medium',
    known_unknowns: ['whether the cache is the bottleneck'],
    acceptance_criteria: ['founder signs off on the measured result'],
    ...overrides,
  }) as unknown as ObjectiveEntity;
}

/**
 * A Project — a Canonical Object subtype (`entity_subtype: 'project'`), per ADR-0011
 * and COM §5.4. An Organizational Container, NOT a Work Hierarchy level: it never
 * carries `work_hierarchy_parent`.
 */
export function makeProject(overrides: Record<string, unknown> = {}): ProjectEntity {
  return base({
    entity_type: 'canonical_object',
    entity_subtype: 'project',
    name: 'AIOS',
    purpose: 'make the architecture executable',
    // Prose, not references (ADR-0011 §5).
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
    ...overrides,
  }) as unknown as ProjectEntity;
}

export function makeCanonicalObject(overrides: Record<string, unknown> = {}): CanonicalEntity {
  return base({
    entity_type: 'canonical_object',
    ...overrides,
  }) as unknown as CanonicalEntity;
}
