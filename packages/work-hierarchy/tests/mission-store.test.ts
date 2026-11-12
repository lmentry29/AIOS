import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MissionEntity } from '@aios/core';
import { MissionStore } from '../src/mission-store.js';

const FOUNDER = 'human:founder';

function makeMission(overrides: Record<string, unknown> = {}): MissionEntity {
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
  } as unknown as MissionEntity;
}

describe('MissionStore — Work Hierarchy root (ADR-0017)', () => {
  it('creates and retrieves a Mission with its purpose and owner intact', () => {
    const store = new MissionStore();
    const created = store.createMission(makeMission());
    const fetched = store.getMission(created.entity_id);

    expect(fetched?.purpose).toBe('Make durable, inspectable decisions about the work that matters.');
    expect(fetched?.owner_id).toBe(FOUNDER);
    expect(fetched?.lifecycle_state).toBe('created');
  });

  it('lists only Missions, not every Canonical Object subtype', () => {
    const store = new MissionStore();
    store.createMission(makeMission({ name: 'one' }));
    store.createMission(makeMission({ name: 'two' }));

    const missions = store.listMissions();
    expect(missions).toHaveLength(2);
    expect(missions.every((mission) => mission.entity_subtype === 'mission')).toBe(true);
  });

  it('refuses a Mission with a Work Hierarchy parent at write time', () => {
    const store = new MissionStore();
    expect(() =>
      store.createMission(
        makeMission({ work_hierarchy_parent: { entity_id: randomUUID(), level: 'mission' } }),
      ),
    ).toThrow();
  });

  it('advances lifecycle without losing the Mission field model', () => {
    const store = new MissionStore();
    const created = store.createMission(makeMission());

    store.transitionMissionLifecycle(created.entity_id, 'validated', FOUNDER);
    const active = store.transitionMissionLifecycle(created.entity_id, 'active', FOUNDER);

    expect(active.lifecycle_state).toBe('active');
    expect(active.lifecycle_history.map((entry) => entry.state)).toEqual(['validated', 'active']);
    expect(active.purpose).toBe('Make durable, inspectable decisions about the work that matters.');
  });

  it('permits changing a non-identity field such as name', () => {
    const store = new MissionStore();
    const created = store.createMission(makeMission());
    const updated = store.updateMission(created.entity_id, { name: 'Retitled mission' });

    expect(updated.name).toBe('Retitled mission');
    expect(updated.purpose).toBe(created.purpose);
  });
});
