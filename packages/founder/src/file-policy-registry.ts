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
import { StaticAccessPolicyStore } from './authorization.js';

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
  schema_version: 1;
  policies: Record<string, AccessPolicy>;
  resource_policies: Record<string, string>;
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
  return { schema_version: 1, policies: {}, resource_policies: {}, audit_events: [] };
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
    || !(value.action === null || ['intake', 'dispatch', 'execute', 'coordinate', 'read_status', 'read_evidence'].includes(value.action))
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
  if (!isRecord(value) || value.schema_version !== 1
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

  const resourcePolicies: Record<string, string> = {};
  for (const [resourceId, policyId] of Object.entries(value.resource_policies)) {
    if (!isUuid(resourceId) || typeof policyId !== 'string' || !policies[policyId]) {
      throw new FilePolicyRegistryError('Policy state contains an invalid resource attachment.');
    }
    resourcePolicies[resourceId] = policyId;
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
    }
    const { hash, ...unsigned } = event;
    if (eventHash(unsigned) !== hash) throw new FilePolicyRegistryError('Policy audit hash chain verification failed.');
    previousHash = hash;
  }

  return { schema_version: 1, policies, resource_policies: resourcePolicies, audit_events: clone(auditEvents) };
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
      policy_id: snapshot.policy_id, policy_version: snapshot.version, timestamp: new Date().toISOString(),
    });
    this.commit(next);
  }

  async attach(resourceId: string, policyId: string, actorId: string): Promise<void> {
    this.assertOpen();
    if (!isHumanPrincipal(actorId) || !isUuid(resourceId) || !isUuid(policyId)) {
      throw new FilePolicyRegistryError('Policy attachment requires a human administrator and valid UUIDs.');
    }
    const policy = this.state.policies[policyId];
    if (!policy) throw new FilePolicyRegistryError('Cannot attach an unpublished policy.');
    const next = clone(this.state);
    const previousPolicyId = next.resource_policies[resourceId];
    next.resource_policies[resourceId] = policyId;
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'attach', actor_id: actorId,
      policy_id: policyId, policy_version: policy.version, resource_id: resourceId,
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
    appendEvent(next, 'policy_lifecycle', {
      event_id: randomUUID(), operation: 'revoke', actor_id: actorId,
      policy_id: policyId, policy_version: policy.version, resource_id: resourceId,
      timestamp: new Date().toISOString(),
    });
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
    const temporaryPath = join(dirname(this.filePath), `.policy-state.${randomBytes(12).toString('hex')}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(validated), 'utf8');
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
      throw new FilePolicyRegistryError('Could not durably commit the policy state and audit event.');
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