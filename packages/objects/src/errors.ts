/**
 * Thrown when create() is called with an entity_id that already exists in
 * the store — including archived entities. Per COM §9, entity_id is never
 * reused or reassigned, even after archival, so existence alone (regardless
 * of lifecycle_state) is grounds for rejection.
 */
export class EntityIdConflictError extends Error {
  constructor(entityId: string) {
    super(`entity_id "${entityId}" already exists in the store and cannot be reused (COM §9).`);
    this.name = 'EntityIdConflictError';
  }
}

/** Thrown when an operation references an entity_id not present in the store. */
export class EntityNotFoundError extends Error {
  constructor(entityId: string) {
    super(`No entity found with entity_id "${entityId}".`);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * Thrown when a mutation is attempted against a Memory Object whose
 * lifecycle_state is 'completed'. Per COM §5.1, Memory Objects are
 * immutable after publication — evolution requires a new entity_id with
 * an incremented version and a 'supersedes' relationship, not an in-place
 * update. This is a write-time rule; it cannot be enforced by Zod's static
 * shape validation, hence enforcement lives here in the persistence layer.
 */
export class ImmutableEntityError extends Error {
  constructor(entityId: string) {
    super(
      `entity_id "${entityId}" is a completed Memory Object and is immutable (COM §5.1). Create a new entity_id with an incremented version and a "supersedes" relationship instead.`
    );
    this.name = 'ImmutableEntityError';
  }
}
