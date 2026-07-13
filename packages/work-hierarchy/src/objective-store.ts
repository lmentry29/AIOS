import type { LifecycleState, ObjectiveEntity as ObjectiveEntityType, Relationship } from '@aios/core';
import { ObjectiveEntity } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';

/**
 * ObjectiveStore — the Work Hierarchy's Objective level, per ADR-0010 (Accepted
 * 2026-07-13) and COM §5.3.
 *
 * An Objective is a Canonical Object subtype (`entity_subtype: 'objective'`), not a
 * sixth entity type. It therefore needs NO new persistence machinery: this is
 * `ObjectStore<ObjectiveEntity>`, exactly as TaskStore is `ObjectStore<TaskEntity>`.
 * ADR-0010 §6 places it here, alongside TaskStore, because Objective is a Work
 * Hierarchy level.
 *
 * This is what closes the dangling reference the vertical slice stopped on:
 * `TaskEntity.work_hierarchy_parent.entity_id` at level 'objective' now dereferences
 * to a real, persisted record (docs/process/divergence-log.md, conflict #1 — CLOSED).
 *
 * MISSION IS STILL NOT AN ENTITY, deliberately (ADR-0010 §3). The corpus specifies no
 * field-level model for Mission, and inventing one would be the unilateral resolution
 * the project's standing rule forbids. An Objective's own `work_hierarchy_parent` at
 * level 'mission' remains a typed UUID with no backing record — a knowingly-retained
 * gap, not an oversight.
 *
 * Definition immutability (Part VI Ch.4: "Objectives remain immutable. Only their
 * associated planning artifacts evolve.") is enforced write-time in @aios/objects, not
 * here — see ImmutableObjectiveFieldError. It is reused, not reimplemented.
 */
export class ObjectiveStore {
  private readonly store: ObjectStore<ObjectiveEntityType>;

  constructor() {
    this.store = new ObjectStore<ObjectiveEntityType>(ObjectiveEntity);
  }

  createObjective(objective: ObjectiveEntityType): ObjectiveEntityType {
    return this.store.create(objective);
  }

  getObjective(objectiveId: string): ObjectiveEntityType | undefined {
    return this.store.get(objectiveId);
  }

  listObjectives(): ObjectiveEntityType[] {
    // Objectives are Canonical Objects; filter to the subtype, since Canonical Object
    // is a shared entity_type across memory_object / artifact / objective.
    return this.store
      .list({ entityType: 'canonical_object' })
      .filter((o) => o.entity_subtype === 'objective');
  }

  /**
   * Updates non-definition fields only. Any attempt to change one of the eight
   * definition fields throws ImmutableObjectiveFieldError from the persistence layer.
   */
  updateObjective(
    objectiveId: string,
    patch: EntityPatch<ObjectiveEntityType>
  ): ObjectiveEntityType {
    return this.store.update(objectiveId, patch);
  }

  /** Advances Current Status (COM §5.3 maps it to lifecycle_state). Not a definition mutation. */
  transitionObjectiveLifecycle(
    objectiveId: string,
    newState: LifecycleState,
    actor: string,
    substate?: string
  ): ObjectiveEntityType {
    return this.store.transitionLifecycle(objectiveId, newState, actor, substate);
  }

  /**
   * Records an Objective dependency. Per COM §5.3's field-unification table, Ch.4's
   * "Dependencies" field unifies into the base relationship model as `depends_on`
   * edges (§8) — a parallel `dependencies` array would express the same edge twice.
   */
  addDependency(objectiveId: string, dependsOnObjectiveId: string): ObjectiveEntityType {
    const relationship: Relationship = {
      target_entity_id: dependsOnObjectiveId,
      target_entity_type: 'canonical_object',
      relationship_type: 'depends_on',
      direction: 'outbound',
    };
    return this.store.addRelationship(objectiveId, relationship);
  }
}
