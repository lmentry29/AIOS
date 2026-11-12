import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MissionEntity, ObjectiveEntity } from '../src/index.js';

const FOUNDER = 'human:founder';

function baseMission(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'mission',
    name: 'Founder intelligence',
    purpose: 'Make durable, inspectable decisions about the work that matters.',
    lifecycle_state: 'created',
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

describe('MissionEntity (ADR-0017)', () => {
  it('accepts a Mission as a Canonical Object subtype', () => {
    const parsed = MissionEntity.parse(baseMission());
    expect(parsed.entity_type).toBe('canonical_object');
    expect(parsed.entity_subtype).toBe('mission');
    expect(parsed.purpose).toBe('Make durable, inspectable decisions about the work that matters.');
  });

  it('rejects a Mission carrying a Work Hierarchy parent — Mission is the root', () => {
    const objectiveId = randomUUID();
    expect(
      MissionEntity.safeParse(
        baseMission({ work_hierarchy_parent: { entity_id: objectiveId, level: 'objective' } }),
      ).success,
    ).toBe(false);
  });

  it('does not become a sixth entity type or an Organizational Container', () => {
    const parsed = MissionEntity.parse(baseMission());
    expect(parsed.entity_type).not.toBe('mission');
    expect(parsed.entity_subtype).toBe('mission');
    expect(Object.hasOwn(parsed, 'container_type')).toBe(false);
  });

  it('allows an Objective to point at a Mission as its Work Hierarchy parent', () => {
    const missionId = randomUUID();
    const now = new Date().toISOString();
    const objective = {
      entity_id: randomUUID(),
      entity_type: 'canonical_object',
      entity_subtype: 'objective',
      name: 'Resolve the mission',
      purpose: 'p',
      desired_outcome: 'o',
      constraints: [],
      success_criteria: ['s'],
      priority: 'high',
      risk_profile: 'low',
      known_unknowns: [],
      acceptance_criteria: ['a'],
      work_hierarchy_parent: { entity_id: missionId, level: 'mission' },
      lifecycle_state: 'created',
      lifecycle_history: [],
      created_at: now,
      created_by: FOUNDER,
      modified_at: now,
      version: 1,
      organizational_containers: [],
      owner_id: FOUNDER,
      owner_type: 'human',
      relationships: [],
    };
    expect(ObjectiveEntity.safeParse(objective).success).toBe(true);
  });

  it('requires a non-empty purpose', () => {
    expect(MissionEntity.safeParse(baseMission({ purpose: '' })).success).toBe(false);
  });

  it('rejects a Project as its Work Hierarchy parent', () => {
    expect(
      MissionEntity.safeParse(
        baseMission({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'mission' } }),
      ).success,
    ).toBe(false);
  });
});
