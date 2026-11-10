import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AccessPolicy,
  AccessPolicyStore,
  AuthorizationAuditStore,
  AuthorizationDecisionAudit,
  PolicyAdministrationPort,
  PolicyLifecycleAuditEvent,
} from './authorization.js';
import {
  MAX_POLICY_REVOCATION_TARGETS,
  PolicyRevocationError,
  StaticAccessPolicyStore,
  policyArtifactSha256,
} from './authorization.js';

const ZERO_HASH = '0'.repeat(64);
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 500_000;

type AuditKind = 'policy_lifecycle' | 'authorization_decision';

interface AuditEnvelope {
  sequence: number;
  kind: AuditKind;
  payload: PolicyLifecycleAuditEvent | AuthorizationDecisionAudit;
  previous_hash: string;
  hash: string;
}

interface FilePolicyState {
  schema_version: 2;
  policies: Record<string, AccessPolicy>;
  resource_policies: Record<string, string>;
  /** Ordered effective/fallback versions per resource, oldest to current. */
  resource_policy_history: Record<string, string[]>;
  /** Immutable versions that must never decide again, even if still present in history. */
  retired_policies: string[];
  audit_events: AuditEnvelope[];
}

export interface FilePolicyRegistryOptions {
  /** Absolute path to a dedicated owner-only JSON state file. */
  filePath: string;
}

export class FilePolicyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilePolicyRegistryError';
  }
}

export type PolicyPublicationErrorCode =
  | 'invalid_policy'
  | 'invalid_targets'
  | 'policy_exists'
  | 'version_conflict';

/** A rejected runtime publication with a stable, wire-safe reason code. */
export class PolicyPublicationError extends FilePolicyRegistryError {
  constructor(readonly code: PolicyPublicationErrorCode, message: string) {
    super(message);
    this.name = 'PolicyPublicationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && /^human:[^\s:*]+$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function eventHash(event: Omit<AuditEnvelope, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function initialState(): FilePolicyState {
  return {
    schema_version: 2,
    policies: {},
    resource_policies: {},
    resource_policy_history: {},
    retired_policies: [],
    audit_events: [],
  };
}

function appendEvent(state: FilePolicyState, kind: AuditKind, payload: PolicyLifecycleAuditEvent | AuthorizationDecisionAudit): void {
  if (state.audit_events.length >= MAX_AUDIT_EVENTS) {
    throw new FilePolicyRegistryError('Authorization audit reached the configured event limit.');
  }
  const previous = state.audit_events.at(-1)?.hash ?? ZERO_HASH;
  const unsigned = {
    sequence: state.audit_events.length + 1,
    kind,
    payload: clone(payload),
    previous_hash: previous,
  };
  state.audit_events.push({ ...unsigned, hash: eventHash(unsigned) });
}

function validateDecisionRecord(value: AuthorizationDecisionAudit): void {
  if (!isRecord(value) || !isUuid(value.request_id)
    || !(value.actor_id === null || isHumanPrincipal(value.actor_id) || isUuid(value.actor_id))
    || !(value.action === null || ['intake', 'dispatch', 'execute', 'coordinate', 'cancel', 'resume', 'retry', 'read_status', 'read_evidence', 'administer_policy', 'revoke_policy'].includes(value.action))
    || !(value.resource_id === null || isUuid(value.resource_id))
    || !(value.policy_id === null || isUuid(value.policy_id))
    || !(value.policy_version === null || (Number.isSafeInteger(value.policy_version) && value.policy_version >= 1))
    || (value.decision !== 'allow' && value.decision !== 'deny')
    || typeof value.reason !== 'string' || value.reason.length > 256
    || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new FilePolicyRegistryError('Authorization audit record is invalid.');
  }
}

function validateState(value: unknown): FilePolicyState {
  if (!isRecord(value) || (value.schema_version !== 1 && value.schema_version !== 2)
    || !isRecord(value.policies) || !isRecord(value.resource_policies)
    || !Array.isArray(value.audit_events) || value.audit_events.length > MAX_AUDIT_EVENTS) {
    throw new FilePolicyRegistryError('Policy state file has an unsupported or malformed structure.');
  }

  const policies: Record<string, AccessPolicy> = {};
  for (const [policyId, policy] of Object.entries(value.policies)) {
    if (!isUuid(policyId) || !isRecord(policy) || policy.policy_id !== policyId) {
      throw new FilePolicyRegistryError('Policy state contains a mismatched policy identifier.');
    }
    try {
      new StaticAccessPolicyStore([policy as unknown as AccessPolicy]);
    } catch {
      throw new FilePolicyRegistryError(`Policy ${policyId} failed schema validation.`);
    }
    policies[policyId] = clone(policy as unknown as AccessPolicy);
  }

  const resourcePolicyHistory: Record<string, string[]> = {};
  const retiredPolicies: string[] = [];
  if (value.schema_version === 1) {
    // v1 stored only the effective attachment. It is migrated in memory to a one-entry
    // stack; the next commit writes v2. No historical fallback can be invented from v1.
    for (const [resourceId, policyId] of Object.entries(value.resource_policies)) {
      if (!isUuid(resourceId) || typeof policyId !== 'string' || !policies[policyId]) {
        throw new FilePolicyRegistryError('Policy state contains an invalid resource attachment.');
      }
      resourcePolicyHistory[resourceId] = [policyId];
    }
  } else {
    if (!isRecord(value.resource_policy_history) || !Array.isArray(value.retired_policies)) {
      throw new FilePolicyRegistryError('Policy state is missing its retirement history.');
    }
    for (const policyId of value.retired_policies) {
      if (!isUuid(policyId) || !policies[policyId] || retiredPolicies.includes(policyId)) {
        throw new FilePolicyRegistryError('Policy state contains an invalid retired policy.');
      }
      retiredPolicies.push(policyId);
    }
    const retired = new Set(retiredPolicies);
    for (const [resourceId, history] of Object.entries(value.resource_policy_history)) {
      if (!isUuid(resourceId) || !Array.isArray(history) || history.length === 0) {
        throw new FilePolicyRegistryError('Policy state contains an invalid resource history.');
      }
      const seen = new Set<string>();
      const validatedHistory: string[] = [];
      for (const policyId of history) {
        if (typeof policyId !== 'string' || !isUuid(policyId) || !policies[policyId]
          || retired.has(policyId) || seen.has(policyId)) {
          throw new FilePolicyRegistryError('Policy state contains an invalid policy history entry.');
        }
        seen.add(policyId);
        validatedHistory.push(policyId);
      }
      resourcePolicyHistory[resourceId] = validatedHistory;
    }
  }

  const resourcePolicies: Record<string, string> = {};
  for (const [resourceId, policyId] of Object.entries(value.resource_policies)) {
    if (!isUuid(resourceId) || typeof policyId !== 'string' || !policies[policyId]) {
      throw new FilePolicyRegistryError('Policy state contains an invalid resource attachment.');
    }
    const history = resourcePolicyHistory[resourceId];
    if (!history || history.at(-1) !== policyId) {
      throw new FilePolicyRegistryError('Policy state current attachment does not match its history.');
    }
    resourcePolicies[resourceId] = policyId;
  }
  for (const resourceId of Object.keys(resourcePolicyHistory)) {
    if (resourcePolicies[resourceId] === undefined) {
      throw new FilePolicyRegistryError('Policy state history has no effective attachment.');
    }
  }

  const auditEvents = value.audit_events as AuditEnvelope[];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < auditEvents.length; index += 1) {
    const event = auditEvents[index];
    if (!isRecord(event) || event.sequence !== index + 1
      || (event.kind !== 'policy_lifecycle' && event.kind !== 'authorization_decision')
      || event.previous_hash !== previousHash || typeof event.hash !== 'string' || !/^[a-f0-9]{64}$/.test(event.hash)
      || !isRecord(event.payload)) {
      throw new FilePolicyRegistryError('Policy audit chain is malformed or out of sequence.');
    }
    if (event.kind === 'authorization_decision') {
      validateDecisionRecord(event.payload as unknown as AuthorizationDecisionAudit);
    } else {
      const payload = event.payload as unknown as PolicyLifecycleAuditEvent;
      if (!isUuid(payload.event_id) || !isHumanPrincipal(payload.actor_id)
        || !isUuid(payload.policy_id) || !Number.isSafeInteger(payload.policy_version) || payload.policy_version < 1
        || !['publish', 'attach', 'revoke'].includes(payload.operation)
        || !(payload.resource_id === undefined || isUuid(payload.resource_id))
        || !(payload.previous_policy_id === undefined || isUuid(payload.previous_policy_id))
        || !Number.isFinite(Date.parse(payload.timestamp))) {
        throw new FilePolicyRegistryError('Policy lifecycle audit event is invalid.');
      }
      const policy = policies[payload.policy_id];
      if (!policy) throw new FilePolicyRegistryError('Policy lifecycle event references a missing policy.');
      if (payload.artifact_sha256 !== undefined
        && (typeof payload.artifact_sha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(payload.artifact_sha256)
          || policyArtifactSha256(policy) !== payload.artifact_sha256)) {
        throw new FilePolicyRegistryError('Policy artifact digest does not match the recorded policy.');
      }
    }
    const { hash, ...unsigned } = event;
    if (eventHash(unsigned) !== hash) throw new FilePolicyRegistryError('Policy audit hash chain verification failed.');
    previousHash = hash;
  }

  return {
    schema_version: 2,
    policies,
    resource_policies: resourcePolicies,
    resource_policy_history: resourcePolicyHistory,
    retired_policies: retiredPolicies,
    audit_events: clone(auditEvents),
  };
}

/**
 * Durable, single-process policy registry and append-only authorization audit sink.
 * Each mutation writes a complete validated snapshot through fsync + atomic rename.
 * Audit events form a SHA-256 hash chain; any out-of-band edit is detected on startup.
 */
export class FilePolicyRegistry implements AccessPolicyStore, PolicyAdministrationPort, AuthorizationAuditStore {
  private state: FilePolicyState;
  private readonly filePath: string;
  private readonly lockPath: string;
  private lockDescriptor: number | undefined;
  private ownsLock = false;
  private closed = false;

  constructor(options: FilePolicyRegistryOptions) {
    if (!options || typeof options.filePath !== 'string' || !isAbsolute(options.filePath)) {
      throw new FilePolicyRegistryError('Policy state path must be an absolute file path.');
    }
    const requestedPath = resolve(options.filePath);
    mkdirSync(dirname(requestedPath), { recursive: true, mode: 0o700 });
    const canonicalDirectory = realpathSync(dirname(requestedPath));
    if (!lstatSync(canonicalDirectory).isDirectory()) {
      throw new FilePolicyRegistryError('Policy state parent must be a dedicated directory.');
    }
    chmodSync(canonicalDirectory, 0o700);
    this.filePath = join(canonicalDirectory, basename(requestedPath));
    this.lockPath = `${this.filePath}.lock`;
    try {
      this.acquireLock();
      this.state = this.loadState();
    } catch (error) {
      this.releaseLock();
      if (error instanceof FilePolicyRegistryError) throw error;
      throw new FilePolicyRegistryError('Could not acquire or load the local policy registry.');
    }
  }

  async get(policyId: string): Promise<AccessPolicy | undefined> {
    this.assertOpen();
    const policy = this.state.policies[policyId];
    return policy ? clone(policy) : undefined;
  }

  async resolve(resourceId: string): Promise<string | undefined> {
    this.assertOpen();
    return this.state.resource_policies[resourceId];
  }

  async publish(policy: AccessPolicy, actorId: string): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId)) throw new FilePolicyRegistryError('Policy publication requires an authenticated human administrator.');
    let snapshot: AccessPolicy;
    try {
      new StaticAccessPolicyStore([policy]);
      snapshot = clone(policy);
    } catch {
      throw new FilePolicyRegistryError('Policy failed validation.');
    }
    if (this.state.policies[snapshot.policy_id]) {
      throw new FilePolicyRegistryError('Published policies are immutable; publish a new policy ID.');
    }
    const next = clone(this.state);
    next.policies[snapshot.policy_id] = snapshot;
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'publish', actor_id: actorId,
      policy_id: snapshot.policy_id, policy_version: snapshot.version,
      artifact_sha256: policyArtifactSha256(snapshot), timestamp: new Date().toISOString(),
    });
    this.commit(next);
  }

  /**
   * Publishes an immutable replacement and attaches it to every target in one atomic commit.
   *
   * This is the runtime-administration primitive: validation, scope checks, version checks,
   * policy lifecycle events, and all attachment changes are written as one validated state
   * snapshot. A rejected publication therefore leaves both the effective attachment and the
   * on-disk state untouched. Versions must increase for an existing attachment, so a stale
   * or replayed policy cannot silently replace a newer one.
   */
  async publishAndAttach(
    policy: AccessPolicy,
    resourceIds: readonly string[],
    actorId: string,
  ): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId)) {
      throw new FilePolicyRegistryError('Policy publication requires an authenticated human administrator.');
    }
    if (!Array.isArray(resourceIds) || resourceIds.length === 0 || resourceIds.length > 64
      || resourceIds.some((id) => !isUuid(id)) || new Set(resourceIds).size !== resourceIds.length) {
      throw new PolicyPublicationError('invalid_targets', 'Policy publication requires 1-64 distinct resource UUIDs.');
    }

    let snapshot: AccessPolicy;
    try {
      new StaticAccessPolicyStore([policy]);
      snapshot = clone(policy);
    } catch {
      throw new PolicyPublicationError('invalid_policy', 'Policy failed validation.');
    }
    if (this.state.policies[snapshot.policy_id]) {
      throw new PolicyPublicationError('policy_exists', 'Published policies are immutable; publish a new policy ID.');
    }

    const targets = new Set(resourceIds);
    const referenced = new Set<string>();
    for (const rule of snapshot.rules) {
      for (const resourceId of rule.resource_ids) {
        referenced.add(resourceId);
        if (!targets.has(resourceId)) {
          throw new PolicyPublicationError(
            'invalid_policy',
            'Policy rules may reference only the resources in this publication.',
          );
        }
      }
    }
    for (const resourceId of targets) {
      if (!referenced.has(resourceId)) {
        throw new PolicyPublicationError(
          'invalid_policy',
          'Every attachment target must be referenced by at least one policy rule.',
        );
      }
    }

    const next = clone(this.state);
    const previousPolicies = new Map<string, string | undefined>();
    for (const resourceId of resourceIds) {
      const previousPolicyId = next.resource_policies[resourceId];
      previousPolicies.set(resourceId, previousPolicyId);
      if (previousPolicyId !== undefined) {
        const previous = next.policies[previousPolicyId];
        if (!previous) throw new FilePolicyRegistryError('Attached policy is missing from the registry.');
        if (snapshot.version <= previous.version) {
          throw new PolicyPublicationError(
            'version_conflict',
            'Replacement policy version must exceed the effective version for every target.',
          );
        }
      }
    }

    next.policies[snapshot.policy_id] = snapshot;
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'publish', actor_id: actorId,
      policy_id: snapshot.policy_id, policy_version: snapshot.version,
      artifact_sha256: policyArtifactSha256(snapshot), timestamp: new Date().toISOString(),
    });
    for (const resourceId of resourceIds) {
      const previousPolicyId = previousPolicies.get(resourceId);
      next.resource_policies[resourceId] = snapshot.policy_id;
      next.resource_policy_history[resourceId] = [
        ...(next.resource_policy_history[resourceId] ?? []),
        snapshot.policy_id,
      ];
      appendEvent(next, 'policy_lifecycle', {
        event_id: randomUUID(), operation: 'attach', actor_id: actorId,
        policy_id: snapshot.policy_id, policy_version: snapshot.version,
        artifact_sha256: policyArtifactSha256(snapshot), resource_id: resourceId,
        ...(previousPolicyId === undefined ? {} : { previous_policy_id: previousPolicyId }),
        timestamp: new Date().toISOString(),
      });
    }
    this.commit(next);
  }

  async attach(resourceId: string, policyId: string, actorId: string): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId) || !isUuid(resourceId) || !isUuid(policyId)) {
      throw new FilePolicyRegistryError('Policy attachment requires a human administrator and valid UUIDs.');
    }
    const policy = this.state.policies[policyId];
    if (!policy) throw new FilePolicyRegistryError('Cannot attach an unpublished policy.');
    if (this.state.retired_policies.includes(policyId)) {
      throw new FilePolicyRegistryError('A retired policy cannot be attached.');
    }
    const next = clone(this.state);
    const previousPolicyId = next.resource_policies[resourceId];
    const history = next.resource_policy_history[resourceId] ?? [];
    next.resource_policy_history[resourceId] = [...history.filter((id) => id !== policyId), policyId];
    next.resource_policies[resourceId] = policyId;
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'attach', actor_id: actorId,
      policy_id: policyId, policy_version: policy.version,
      artifact_sha256: policyArtifactSha256(policy), resource_id: resourceId,
      ...(previousPolicyId ? { previous_policy_id: previousPolicyId } : {}),
      timestamp: new Date().toISOString(),
    });
    this.commit(next);
  }

  async revoke(resourceId: string, actorId: string): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId) || !isUuid(resourceId)) {
      throw new FilePolicyRegistryError('Policy revocation requires a human administrator and valid resource UUID.');
    }
    const next = clone(this.state);
    const policyId = next.resource_policies[resourceId];
    if (!policyId) throw new FilePolicyRegistryError('Resource has no attached policy to revoke.');
    const policy = next.policies[policyId];
    if (!policy) throw new FilePolicyRegistryError('Attached policy is missing from the registry.');
    delete next.resource_policies[resourceId];
    delete next.resource_policy_history[resourceId];
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'revoke', actor_id: actorId,
      policy_id: policyId, policy_version: policy.version,
      artifact_sha256: policyArtifactSha256(policy), resource_id: resourceId,
      timestamp: new Date().toISOString(),
    });
    this.commit(next);
  }

  /**
   * Permanently retires one immutable policy version and removes it from every resource
   * history. Each affected resource falls back to the newest remaining version, or to no
   * attachment (deny) when none remains. The complete target set is required so the caller
   * cannot retire a version that also governs a resource it did not name.
   */
  async retirePolicy(policyId: string, resourceIds: readonly string[], actorId: string): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId)) {
      throw new FilePolicyRegistryError('Policy retirement requires an authenticated human administrator.');
    }
    if (!isUuid(policyId)) {
      throw new PolicyRevocationError('invalid_policy_id', 'Policy retirement requires a valid policy UUID.');
    }
    if (!Array.isArray(resourceIds) || resourceIds.length > MAX_POLICY_REVOCATION_TARGETS
      || resourceIds.some((id) => !isUuid(id)) || new Set(resourceIds).size !== resourceIds.length) {
      throw new PolicyRevocationError(
        'invalid_targets',
        `Policy retirement requires 0-${MAX_POLICY_REVOCATION_TARGETS} distinct resource UUIDs.`,
      );
    }

    const policy = this.state.policies[policyId];
    if (!policy) throw new PolicyRevocationError('policy_not_found', 'Policy version was not found.');
    if (this.state.retired_policies.includes(policyId)) {
      throw new PolicyRevocationError('policy_already_revoked', 'Policy version has already been retired.');
    }

    const affected = Object.entries(this.state.resource_policy_history)
      .filter(([, history]) => history.includes(policyId))
      .map(([resourceId]) => resourceId)
      .sort();
    if (affected.length === 0) {
      throw new PolicyRevocationError('policy_not_attached', 'Policy version is not attached to any resource.');
    }
    const supplied = new Set(resourceIds);
    if (affected.length !== resourceIds.length || affected.some((resourceId) => !supplied.has(resourceId))) {
      throw new PolicyRevocationError(
        'target_scope_mismatch',
        'The target set must exactly match every resource that references this policy version.',
      );
    }

    const next = clone(this.state);
    for (const resourceId of affected) {
      const history = next.resource_policy_history[resourceId] ?? [];
      const remaining = history.filter((id) => id !== policyId);
      if (remaining.length === 0) {
        delete next.resource_policy_history[resourceId];
        delete next.resource_policies[resourceId];
      } else {
        next.resource_policy_history[resourceId] = remaining;
        next.resource_policies[resourceId] = remaining.at(-1) as string;
      }
      appendEvent(next, 'policy_lifecycle', {
        event_id: randomUUID(), operation: 'revoke', actor_id: actorId,
        policy_id: policyId, policy_version: policy.version,
        artifact_sha256: policyArtifactSha256(policy), resource_id: resourceId,
        timestamp: new Date().toISOString(),
      });
    }
    next.retired_policies.push(policyId);
    this.commit(next);
  }

  async append(record: AuthorizationDecisionAudit): Promise<void> {
    this.assertOpen();
    validateDecisionRecord(record);
    const next = clone(this.state);
    appendEvent(next, 'authorization_decision', record);
    this.commit(next);
  }

  listPolicyAudit(): PolicyLifecycleAuditEvent[] {
    this.assertOpen();
    return this.state.audit_events
      .filter((event) => event.kind === 'policy_lifecycle')
      .map((event) => clone(event.payload as PolicyLifecycleAuditEvent));
  }

  listAuthorizationAudit(): AuthorizationDecisionAudit[] {
    this.assertOpen();
    return this.state.audit_events
      .filter((event) => event.kind === 'authorization_decision')
      .map((event) => clone(event.payload as AuthorizationDecisionAudit));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseLock();
  }

  private acquireLock(): void {
    let descriptor: number;
    try {
      descriptor = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      let existing: unknown;
      try {
        existing = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      } catch {
        throw new FilePolicyRegistryError('An unreadable policy lock exists; verify no AIOS process is active before removing it.');
      }
      if (!isRecord(existing) || !Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
        throw new FilePolicyRegistryError('An invalid policy lock exists; refusing to remove it.');
      }
      let processIsAlive = true;
      try {
        process.kill(existing.pid as number, 0);
      } catch (processError) {
        processIsAlive = !isRecord(processError) || processError.code !== 'ESRCH';
      }
      if (processIsAlive) throw new FilePolicyRegistryError('The local policy registry is already open in another process.');
      unlinkSync(this.lockPath);
      descriptor = openSync(this.lockPath, 'wx', 0o600);
    }
    this.lockDescriptor = descriptor;
    this.ownsLock = true;
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
    fsyncSync(descriptor);
  }

  private loadState(): FilePolicyState {
    if (!existsSync(this.filePath)) return initialState();
    const stat = lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES) {
      throw new FilePolicyRegistryError('Policy state must be a regular, non-linked file below the size limit.');
    }
    chmodSync(this.filePath, 0o600);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new FilePolicyRegistryError('Policy state file is unreadable or invalid JSON.');
    }
    return validateState(parsed);
  }

  private commit(next: FilePolicyState): void {
    const validated = validateState(next);
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new FilePolicyRegistryError('Policy state exceeds the configured file-size limit.');
    }
    const temporaryPath = join(dirname(this.filePath), `.policy-state.${randomBytes(12).toString('hex')}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
      const directoryDescriptor = openSync(dirname(this.filePath), 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      this.state = validated;
    } catch {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporaryPath); } catch { /* Best-effort cleanup. */ }
      this.closed = true;
      this.releaseLock();
      throw new FilePolicyRegistryError('Could not durably commit the policy state and audit event; registry closed fail-safe.');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new FilePolicyRegistryError('Policy registry is closed.');
  }

  private releaseLock(): void {
    if (this.lockDescriptor !== undefined) {
      try { closeSync(this.lockDescriptor); } catch { /* Best-effort close. */ }
      this.lockDescriptor = undefined;
    }
    if (this.ownsLock) {
      try { unlinkSync(this.lockPath); } catch { /* Best-effort lock cleanup. */ }
      this.ownsLock = false;
    }
  }
}