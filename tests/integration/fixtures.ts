import { randomUUID } from 'node:crypto';
import type {
  AgentEntity,
  CanonicalEntity,
  MemoryObjectEntity,
  ObjectiveEntity,
  TaskEntity,
} from '@aios/core';

/**
 * Entity fixtures for the integration suite.
 *
 * Every field here is deliberately spelled out rather than defaulted: these tests
 * exist to exercise real cross-package writes, and a fixture that quietly relies on
 * a Zod `.default()` would hide whether the field actually survived the boundary —
 * which is the exact failure mode (COM §10 field-stripping) this suite is here to
 * catch.
 */

export const FOUNDER = 'human:founder';

function base(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    name: 'integration fixture',
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
    name: 'ship the integration suite',
    work_hierarchy_parent: { entity_id: randomUUID(), level: 'objective' },
    actions: [],
    ...overrides,
  }) as unknown as TaskEntity;
}

/** An Agent. Never has a work_hierarchy_parent — it acts on Tasks (COM §4.1). */
export function makeAgent(overrides: Record<string, unknown> = {}): AgentEntity {
  return base({
    entity_type: 'agent',
    name: 'integration agent',
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
    name: 'integration memory',
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

export function makeCanonicalObject(overrides: Record<string, unknown> = {}): CanonicalEntity {
  return base({
    entity_type: 'canonical_object',
    ...overrides,
  }) as unknown as CanonicalEntity;
}
