import type {
  CanonicalEntity,
  LifecycleState,
  ProjectStatus,
  Relationship,
  RelationshipDirection,
} from '@aios/core';
import {
  CanonicalEntity as CanonicalEntitySchema,
  OBJECTIVE_DEFINITION_FIELDS,
  PROJECT_IMMUTABLE_FIELDS,
} from '@aios/core';
import {
  AccessPolicyMutationError,
  AppendOnlyFieldError,
  EntityIdConflictError,
  EntityNotFoundError,
  ImmutableEntityError,
  InvalidLifecycleTransitionError,
  ImmutableObjectiveFieldError,
  ImmutableProjectFieldError,
  LifecycleTransitionError,
  ProjectStatusTransitionError,
} from './errors.js';

/** Compare JSON-shaped immutable fields without depending on object key insertion order. */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

/** Deep-copy the plain JSON-shaped entity records held by this in-memory store. */
function cloneRecord<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneRecord) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneRecord(nested)]),
    ) as unknown as T;
  }
  return value;
}

/** Fields update() may never touch, regardless of caller typing (COM §11, Project Ch.7). */
const APPEND_ONLY_FIELDS = ['lifecycle_history', 'relationships', 'project_status_history'] as const;
const LIFECYCLE_FIELDS = ['lifecycle_state', 'lifecycle_substate'] as const;

/** Canonical base lifecycle graph from ADR-0003 / state-machines.md §1. */
const ALLOWED_LIFECYCLE_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  created: ['validated'],
  validated: ['active'],
  active: ['monitored', 'suspended', 'completed'],
  monitored: ['active', 'suspended', 'completed'],
  suspended: ['active'],
  completed: ['archived'],
  archived: [],
};

function isLifecycleTransitionAllowed(
  current: CanonicalEntity,
  to: LifecycleState,
  substate?: string,
): boolean {
  // Same-state transitions are reserved for actual active-substate changes.
  return current.lifecycle_state === to
    ? to === 'active' && substate !== current.lifecycle_substate
    : ALLOWED_LIFECYCLE_TRANSITIONS[current.lifecycle_state].includes(to);
}

/**
 * Subtypes whose fields are immutable after creation, and what to throw when a write
 * tries to change one.
 *
 * ONE table, ONE code path (assertImmutableFieldsUnchanged below) — deliberately not a
 * per-subtype method. Objective (COM §5.3) came first; Project (§5.4) is the second and
 * generalized it rather than pasting a near-copy. A third subtype adds a row here and
 * nothing else.
 *
 * Note this is a *different* rule from Memory Object immutability (§5.1, enforced in
 * assertMutable): that one locks the whole entity once lifecycle_state reaches
 * 'completed'. These lock specific fields from creation onward, at every lifecycle
 * state. Both are write-time rules because neither constrains *shape* — Zod cannot
 * express either.
 */
const IMMUTABLE_FIELDS_BY_SUBTYPE: Record<
  string,
  { readonly fields: readonly string[]; readonly error: (id: string, f: string[]) => Error }
> = {
  objective: {
    fields: OBJECTIVE_DEFINITION_FIELDS,
    error: (id, f) => new ImmutableObjectiveFieldError(id, f),
  },
  project: {
    fields: PROJECT_IMMUTABLE_FIELDS,
    error: (id, f) => new ImmutableProjectFieldError(id, f),
  },
};

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
    | 'access_policy'
    | 'entity_type'
    | 'created_at'
    | 'created_by'
    | 'version'
    | 'modified_at'
    | 'lifecycle_state'
    | 'lifecycle_substate'
    | 'project_status'
    | 'lifecycle_history'
    | 'relationships'
    | 'project_status_history'
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
    return this.clone(parsed);
  }

  get(entityId: string): T | undefined {
    const entity = this.records.get(entityId);
    return entity ? this.clone(entity) : undefined;
  }

  list(filter?: { entityType?: CanonicalEntity['entity_type'] }): T[] {
    const all = Array.from(this.records.values(), (entity) => this.clone(entity));
    if (!filter?.entityType) return all;
    return all.filter((e) => e.entity_type === filter.entityType);
  }

  update(entityId: string, patch: EntityPatch<T>): T {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);
    this.assertAccessPolicyUntouched(entityId, patch);
    this.assertLifecycleFieldsUntouched(entityId, patch);
    this.assertProjectStatusUntouched(entityId, patch);
    this.assertAppendOnlyFieldsUntouched(entityId, patch);
    this.assertImmutableFieldsUnchanged(current, patch);

    const updated = this.schema.parse({
      ...current,
      ...patch,
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.records.set(entityId, updated);
    return this.clone(updated);
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
    if (!isLifecycleTransitionAllowed(current, newState, substate)) {
      throw new InvalidLifecycleTransitionError(entityId, current.lifecycle_state, newState);
    }
    const isMemoryObjectArchival =
      current.entity_type === 'canonical_object'
      && current.entity_subtype === 'memory_object'
      && current.lifecycle_state === 'completed'
      && newState === 'archived';
    if (!isMemoryObjectArchival) this.assertMutable(current);

    const now = new Date().toISOString();
    const updated = this.schema.parse({
      ...current,
      lifecycle_state: newState,
      lifecycle_substate: substate,
      lifecycle_history: [
        ...current.lifecycle_history,
        {
          state: newState,
          substate,
          entered_at: now,
          actor,
        },
      ],
      version: current.version + 1,
      modified_at: now,
    });

    this.records.set(entityId, updated);
    return this.clone(updated);
  }

  appendProjectStatus(entityId: string, status: ProjectStatus, actor: string): T {
    const current = this.records.get(entityId);
    if (!current) {
      throw new EntityNotFoundError(entityId);
    }
    this.assertMutable(current);
    if (current.entity_type !== 'canonical_object' || current.entity_subtype !== 'project') {
      throw new Error(`Entity "${entityId}" is not a Project and has no Project status transition contract.`);
    }

    const project = current as T & {
      project_status_history: Array<{
        status: ProjectStatus;
        entered_at: string;
        actor: string;
      }>;
    };
    if (!Array.isArray(project.project_status_history)) {
      throw new Error(`Entity "${entityId}" does not have Project status history.`);
    }

    const now = new Date().toISOString();
    const updated = this.schema.parse({
      ...current,
      project_status: status,
      project_status_history: [
        ...project.project_status_history,
        { status, entered_at: now, actor },
      ],
      version: current.version + 1,
      modified_at: now,
    });

    this.records.set(entityId, updated);
    return this.clone(updated);
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
    return this.clone(updated);
  }

  linkRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    direction: RelationshipDirection = 'outbound'
  ): { source: T; target: T } {
    if (sourceId === targetId) {
      throw new Error('An entity cannot be linked to itself.');
    }

    const source = this.records.get(sourceId);
    if (!source) {
      throw new EntityNotFoundError(sourceId);
    }
    const target = this.records.get(targetId);
    if (!target) {
      throw new EntityNotFoundError(targetId);
    }

    // Preflight both sides and parse both candidates before committing either write.
    // Otherwise an immutable/invalid target could leave a one-sided relationship.
    this.assertMutable(source);
    this.assertMutable(target);

    const now = new Date().toISOString();
    const updatedSource = this.schema.parse({
      ...source,
      relationships: [
        ...source.relationships,
        {
          target_entity_id: targetId,
          target_entity_type: target.entity_type,
          relationship_type: relationshipType,
          direction,
        },
      ],
      version: source.version + 1,
      modified_at: now,
    });

    const updatedTarget = this.schema.parse({
      ...target,
      relationships: [
        ...target.relationships,
        {
          target_entity_id: sourceId,
          target_entity_type: source.entity_type,
          relationship_type: relationshipType,
          direction: direction === 'outbound' ? 'inbound' : 'outbound',
        },
      ],
      version: target.version + 1,
      modified_at: now,
    });

    this.records.set(sourceId, updatedSource);
    this.records.set(targetId, updatedTarget);
    return { source: this.clone(updatedSource), target: this.clone(updatedTarget) };
  }

  /** Return detached snapshots so callers cannot mutate records outside validated writes. */
  private clone(entity: T): T {
    return cloneRecord(entity);
  }

  private assertMutable(entity: T): void {
    if (
      entity.entity_type === 'canonical_object' &&
      entity.entity_subtype === 'memory_object' &&
      entity.lifecycle_state === 'completed'
    ) {
      throw new ImmutableEntityError(entity.entity_id);
    }
  }


  /** Project operational status must be changed with its append-only audit entry. */
  private assertProjectStatusUntouched(entityId: string, patch: EntityPatch<T>): void {
    const patched = patch as unknown as Record<string, unknown>;
    if ('project_status' in patched) {
      throw new ProjectStatusTransitionError(entityId);
    }
  }

  /** Lifecycle fields can only be changed via transitionLifecycle(), never update(). */
  private assertAccessPolicyUntouched(entityId: string, patch: EntityPatch<T>): void {
    if (Object.hasOwn(patch, 'access_policy')) {
      throw new AccessPolicyMutationError(entityId);
    }
  }

  private assertLifecycleFieldsUntouched(entityId: string, patch: EntityPatch<T>): void {
    const patched = patch as unknown as Record<string, unknown>;
    const touched = LIFECYCLE_FIELDS.filter((field) => field in patched);
    if (touched.length > 0) {
      throw new LifecycleTransitionError(entityId, touched);
    }
  }

  /**
   * Runtime backstop for append-only lifecycle_history and relationships (COM §11)
   * plus Project status history (Project Ch.7). EntityPatch<T> omits all protected fields at the TYPE level, which
   * stops a normally-typed caller at compile time — but that protection vanishes for a
   * plain JS caller, a deserialized JSON patch, or any cast that bypasses the type.
   * Key-presence, not value comparison: unlike assertImmutableFieldsUnchanged's no-op
   * allowance for a re-submitted identical value, these fields may never be named in a
   * patch at all — only transitionLifecycle() and addRelationship()/linkRelationship()
   * are sanctioned write paths. Project status changes use appendProjectStatus().
   */
  private assertAppendOnlyFieldsUntouched(entityId: string, patch: EntityPatch<T>): void {
    const patched = patch as unknown as Record<string, unknown>;
    const touched = APPEND_ONLY_FIELDS.filter((field) => field in patched);
    if (touched.length > 0) {
      throw new AppendOnlyFieldError(entityId, touched);
    }
  }

  /**
   * Enforces per-subtype field immutability, driven by IMMUTABLE_FIELDS_BY_SUBTYPE:
   * Objective's definition fields (COM §5.3, ADR-0010) and Project's `project_dna`
   * (COM §5.4, ADR-0011). One code path for both — a third subtype adds a table row,
   * not another method.
   *
   * Only called from update(). transitionLifecycle() and addRelationship() are
   * deliberately EXEMPT, and that exemption is load-bearing:
   *
   *  - An Objective's status advancing, and its 'depends_on' edges being recorded, are
   *    not changes to its definition. This is what lets Part VI Ch.4's "Objectives
   *    remain immutable" and its "Current Status" field both be true at once.
   *  - A Project's lifecycle_state / project_status / project_phase transitions are not
   *    changes to its DNA. Transitions are what a Project is *for* — only project_dna
   *    is constitutional (Part XI Ch.4).
   *
   * Both exempt paths write append-only fields (§11), so nothing is lost.
   *
   * Compares values rather than mere key-presence, so re-submitting an immutable field
   * with an identical value is a no-op rather than a spurious failure.
   */
  private assertImmutableFieldsUnchanged(current: T, patch: EntityPatch<T>): void {
    const rule =
      current.entity_type === 'canonical_object' && current.entity_subtype
        ? IMMUTABLE_FIELDS_BY_SUBTYPE[current.entity_subtype]
        : undefined;
    if (!rule) return;

    const record = current as unknown as Record<string, unknown>;
    const patched = patch as unknown as Record<string, unknown>;

    const changed = rule.fields.filter(
      (field) =>
        field in patched && !valuesEqual(patched[field], record[field])
    );

    if (changed.length > 0) {
      throw rule.error(current.entity_id, changed);
    }
  }
}
