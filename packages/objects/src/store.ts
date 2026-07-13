import type {
  CanonicalEntity,
  LifecycleState,
  Relationship,
  RelationshipDirection,
} from '@aios/core';
import { CanonicalEntity as CanonicalEntitySchema } from '@aios/core';
import { EntityIdConflictError, EntityNotFoundError, ImmutableEntityError } from './errors.js';

/**
 * Fields a caller may patch via update(). Deliberately excludes
 * lifecycle_history and relationships (COM §3.2, §8, §11: both are
 * append-only — they grow only through transitionLifecycle() and
 * addRelationship(), never via direct overwrite), and excludes
 * entity_id, entity_type, created_at, created_by (immutable provenance,
 * COM §3.1/§3.3), version and modified_at (bumped automatically, not
 * caller-supplied, per COM §11's atomic-write rule).
 */
export type EntityPatch = Partial<
  Omit<
    CanonicalEntity,
    | 'entity_id'
    | 'entity_type'
    | 'created_at'
    | 'created_by'
    | 'version'
    | 'modified_at'
    | 'lifecycle_history'
    | 'relationships'
  >
>;

/**
 * In-memory Canonical Entity store.
 *
 * Generic over the full CanonicalEntity base type rather than narrowed to
 * canonical_object — this is deliberate. COM §10 leaves open whether
 * Task/Mission/Objective persist via @aios/objects or a dedicated
 * @aios/work-hierarchy store, and that question is meant to be resolved
 * by implementation evidence, not decided in advance. This store's job
 * right now is to be a plain, general-purpose Canonical Entity persistence
 * mechanism and let the vertical slice's next step (inserting a
 * Task-shaped entity) generate that evidence.
 */
export class ObjectStore {
  private readonly records = new Map<string, CanonicalEntity>();

  /**
   * Persist a new entity. Rejects if entity_id already exists in the
   * store under any lifecycle_state, including archived — per COM §9,
   * entity_id is never reused or reassigned. Validates the full entity
   * against the CanonicalEntity base schema before storing; callers
   * passing a type-specific extension (AgentEntity, TaskEntity, etc.)
   * satisfy this by construction since those schemas extend the base.
   */
  create(entity: CanonicalEntity): CanonicalEntity {
    const parsed = CanonicalEntitySchema.parse(entity);

    if (this.records.has(parsed.entity_id)) {
      throw new EntityIdConflictError(parsed.entity_id);
    }

    this.records.set(parsed.entity_id, parsed);
    return parsed;
  }

  /** Retrieve an entity by entity_id, or undefined if none exists. */
  get(entityId: string): CanonicalEntity | undefined {
    return this.records.get(entityId);
  }

  /** List all entities currently in the store, optionally filtered by entity_type. */
  list(filter?: { entityType?: CanonicalEntity['entity_type'] }): CanonicalEntity[] {
    const all = Array.from(this.records.values());
    if (!filter?.entityType) return all;
    return all.filter((e) => e.entity_type === filter.entityType);
  }

  /**
   * Apply a patch to an existing entity. Every write updates modified_at
   * and increments version atomically alongside the field change (COM
   * §3.3, §11) — there is no code path that changes data without also
   * bumping provenance. Enforces Memory Object immutability (COM §5.1):
   * a memory_object entity_subtype whose current lifecycle_state is
   * 'completed' rejects all further mutation.
   */
  update(entityId: string, patch: EntityPatch): CanonicalEntity {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);

    const updated: CanonicalEntity = CanonicalEntitySchema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return updated;
  }

  /**
   * Transition an entity's lifecycle_state, appending a new entry to
   * lifecycle_history (append-only, COM §3.2) rather than replacing it.
   * Also bumps version/modified_at atomically with the transition (§11).
   */
  transitionLifecycle(
    entityId: string,
    newState: LifecycleState,
    actor: string,
    substate?: string
  ): CanonicalEntity {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);

    const updated: CanonicalEntity = CanonicalEntitySchema.parse({
      ...current,
      lifecycle_state: newState,
      lifecycle_substate: substate,
      lifecycle_history: [
        ...current.lifecycle_history,
        {
          state: newState,
          substate,
          entered_at: new Date().toISOString(),
          actor,
        },
      ],
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return updated;
  }

  /**
   * Append a relationship entry (append-only, COM §8/§11 — every
   * relationship is stored once, never duplicated across both entities).
   * Bumps version/modified_at atomically.
   */
  addRelationship(entityId: string, relationship: Relationship): CanonicalEntity {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);

    const updated: CanonicalEntity = CanonicalEntitySchema.parse({
      ...current,
      relationships: [...current.relationships, relationship],
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return updated;
  }

  /**
   * Convenience for constructing the inbound/outbound pair implied by a
   * relationship between two entities — the target's side is stored on
   * the target itself as a separate Relationship entry with direction
   * flipped, consistent with COM §8's "stored once, interpreted
   * bidirectionally via direction" model (which describes the field
   * shape, not automatic dual-writing — this helper makes the
   * dual-write explicit and opt-in rather than implicit).
   */
  linkRelationship(
    sourceId: string,
    targetId: string,
    targetEntityType: CanonicalEntity['entity_type'],
    relationshipType: string,
    direction: RelationshipDirection = 'outbound'
  ): { source: CanonicalEntity; target: CanonicalEntity } {
    const target = this.records.get(targetId);
    if (!target) {
      throw new EntityNotFoundError(targetId);
    }

    const source = this.addRelationship(sourceId, {
      target_entity_id: targetId,
      target_entity_type: targetEntityType,
      relationship_type: relationshipType,
      direction,
    });

    const updatedTarget = this.addRelationship(targetId, {
      target_entity_id: sourceId,
      target_entity_type: source.entity_type,
      relationship_type: relationshipType,
      direction: direction === 'outbound' ? 'inbound' : 'outbound',
    });

    return { source, target: updatedTarget };
  }

  private assertMutable(entity: CanonicalEntity): void {
    if (entity.entity_subtype === 'memory_object' && entity.lifecycle_state === 'completed') {
      throw new ImmutableEntityError(entity.entity_id);
    }
  }
}
