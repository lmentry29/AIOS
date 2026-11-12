import type { LifecycleState, MissionEntity as MissionEntityType } from '@aios/core';
import { MissionEntity } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';

/**
 * MissionStore — the Work Hierarchy's top level, per ADR-0017.
 *
 * Mission is a Canonical Object subtype (`entity_subtype: 'mission'`), not a sixth
 * entity type, so it needs no new persistence machinery. The store validates every write
 * with `MissionEntity`, which rejects a Mission carrying `work_hierarchy_parent`.
 */
export class MissionStore {
  private readonly store: ObjectStore<MissionEntityType>;

  constructor() {
    this.store = new ObjectStore<MissionEntityType>(MissionEntity);
  }

  createMission(mission: MissionEntityType): MissionEntityType {
    return this.store.create(mission);
  }

  getMission(missionId: string): MissionEntityType | undefined {
    return this.store.get(missionId);
  }

  listMissions(): MissionEntityType[] {
    return this.store
      .list({ entityType: 'canonical_object' })
      .filter((mission) => mission.entity_subtype === 'mission');
  }

  updateMission(
    missionId: string,
    patch: EntityPatch<MissionEntityType>,
  ): MissionEntityType {
    return this.store.update(missionId, patch);
  }

  transitionMissionLifecycle(
    missionId: string,
    newState: LifecycleState,
    actor: string,
  ): MissionEntityType {
    return this.store.transitionLifecycle(missionId, newState, actor);
  }
}
