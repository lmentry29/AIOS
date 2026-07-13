import type {
  CanonicalEntity,
  LifecycleState,
  Relationship,
  RelationshipDirection,
} from '@aios/core';
import { CanonicalEntity as CanonicalEntitySchema, OBJECTIVE_DEFINITION_FIELDS } from '@aios/core';
import {
  EntityIdConflictError,
  EntityNotFoundError,
  ImmutableEntityError,
  ImmutableObjectiveFieldError,
} from './errors.js';

/**
 * Minimal structural type for "something with a Zod-compatible .parse()".
 * Deliberately narrower than z.ZodType<T>: that type's Input parameter
 * defaults to equal T (Output) when only one type argument is given,
 * which incorrectly demands a schema's input type equal its output type
 * exactly. Any schema with a .default() field (e.g. TaskEntity inherits
 * organizational_containers: z.array(...).default([]) from
 * CanonicalEntity) has an input type where that field is optional and
 * an output type where it's required — so z.ZodType<T> rejects exactly
 * the schemas this store needs to accept. ObjectStore only ever calls
 * .parse() on the schema, so this narrower structural type is both
 * correct and sufficient.
 */
interface ParsingSchema<T> {
  parse(data: unknown): T;
}

export type EntityPatch<T extends CanonicalEntity = CanonicalEntity> = Partial<
  Omit<
    T,
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
 * In-memory Canonical Entity store, generic over T and parameterized by
 * the Zod schema used to validate every write. Defaults to the base
 * CanonicalEntity schema for backward compatibility.
 *
 * This generalization is the resolution of COM §10's open question for
 * Task: a store constructed with only the base schema silently drops
 * type-specific fields on write (Zod strips unrecognized keys by
 * default — see @aios/objects' own test suite for the documented
 * evidence). Constructing an ObjectStore with a specific entity schema
 * (e.g. TaskEntity) fixes that at the root, while still reusing this
 * class's identity rules (COM §9: entity_id never reused), atomic
 * writes (COM §11: version/modified_at bumped together), append-only
 * history (COM §3.2/§8), and Memory Object immutability (COM §5.1)
 * rather than duplicating any of that logic per-package.
 */
export class ObjectStore<T extends CanonicalEntity = CanonicalEntity> {
  private readonly records = new Map<string, T>();
  private readonly schema: ParsingSchema<T>;

  constructor(schema: ParsingSchema<T> = CanonicalEntitySchema as unknown as ParsingSchema<T>) {
    this.schema = schema;
  }

  create(entity: T): T {
    const parsed = this.schema.parse(entity);
    if (this.records.has(parsed.entity_id)) {
      throw new EntityIdConflictError(parsed.entity_id);
    }
    this.records.set(parsed.entity_id, parsed);
    return parsed;
  }

  get(entityId: string): T | undefined {
    return this.records.get(entityId);
  }

  list(filter?: { entityType?: CanonicalEntity['entity_type'] }): T[] {
    const all = Array.from(this.records.values());
    if (!filter?.entityType) return all;
    return all.filter((e) => e.entity_type === filter.entityType);
  }

  update(entityId: string, patch: EntityPatch<T>): T {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);
    this.assertObjectiveDefinitionUnchanged(current, patch);

    const updated = this.schema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return updated;
  }

  transitionLifecycle(
    entityId: string,
    newState: LifecycleState,
    actor: string,
    substate?: string
  ): T {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);

    const updated = this.schema.parse({
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

  addRelationship(entityId: string, relationship: Relationship): T {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);

    const updated = this.schema.parse({
      ...current,
      relationships: [...current.relationships, relationship],
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return updated;
  }

  linkRelationship(
    sourceId: string,
    targetId: string,
    targetEntityType: CanonicalEntity['entity_type'],
    relationshipType: string,
    direction: RelationshipDirection = 'outbound'
  ): { source: T; target: T } {
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

  private assertMutable(entity: T): void {
    if (entity.entity_subtype === 'memory_object' && entity.lifecycle_state === 'completed') {
      throw new ImmutableEntityError(entity.entity_id);
    }
  }

  /**
   * Enforces Objective definition immutability (COM §5.3, ADR-0010) — the second
   * write-time rule this store carries, alongside Memory Object immutability above.
   * Both live here for the same reason: they constrain *transitions*, not shape, so
   * Zod cannot express either.
   *
   * Only called from update(). transitionLifecycle() and addRelationship() are
   * deliberately exempt: an Objective's status advancing, and its 'depends_on' edges
   * being recorded, are not changes to its definition — and both those paths write
   * append-only fields (§11). This is what lets Ch.4's "Objectives remain immutable"
   * and its "Current Status" field both be true simultaneously.
   *
   * Compares values rather than mere key-presence, so re-submitting a definition field
   * with an identical value is a no-op rather than a spurious failure.
   */
  private assertObjectiveDefinitionUnchanged(current: T, patch: EntityPatch<T>): void {
    if (current.entity_subtype !== 'objective') return;

    const record = current as unknown as Record<string, unknown>;
    const patched = patch as unknown as Record<string, unknown>;

    const changed = OBJECTIVE_DEFINITION_FIELDS.filter(
      (field) =>
        field in patched && JSON.stringify(patched[field]) !== JSON.stringify(record[field])
    );

    if (changed.length > 0) {
      throw new ImmutableObjectiveFieldError(current.entity_id, changed);
    }
  }
}
