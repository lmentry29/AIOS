import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HostSessionEntry } from '../config.js';
import { MAX_SESSION_LIFETIME_MS } from '../config.js';
import { JournalError, type AppendOnlyJournal } from './journal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/;
const HUMAN_PRINCIPAL = /^human:[^\s:*]+$/;
const MAX_RETIRED_TOKENS = 4_096;

export interface SessionScope {
  task_id?: string;
  run_id?: string;
  evidence_sha256?: string;
}

export interface SessionBinding {
  task_id?: string;
  run_id?: string;
  evidence_sha256?: string;
}

export interface SessionRecord {
  session_id: string;
  principal_id: string;
  token_sha256: string;
  label: string;
  issued_at: string;
  expires_at: string;
  generation: number;
  status: 'active' | 'revoked';
  scope?: SessionScope;
  revoked_at?: string;
  revocation_reason?: string;
}

export interface RetiredSessionToken {
  token_sha256: string;
  session_id: string;
  reason: 'rotated' | 'revoked';
  retired_at: string;
}

export interface SessionSnapshot {
  sessions: SessionRecord[];
  retired_tokens: RetiredSessionToken[];
}

export interface AuthenticatedSession {
  session_id: string;
  principal_id: string;
  label: string;
  generation: number;
  expires_at: string;
  scope?: SessionScope;
}

export type SessionDenialReason =
  | 'missing_credential'
  | 'malformed_credential'
  | 'unknown_token'
  | 'expired_token'
  | 'rotated_token'
  | 'revoked_token'
  | 'scope_binding_required'
  | 'task_scope_mismatch'
  | 'run_scope_mismatch'
  | 'evidence_scope_mismatch';

export type AuthenticationResult =
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; reason: SessionDenialReason };

export class SessionDeniedError extends Error {
  constructor(readonly reason: SessionDenialReason) {
    super('Session authentication or scope binding denied.');
    this.name = 'SessionDeniedError';
  }
}

export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConflictError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super('Session was not found.');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionScopeError';
  }
}

export interface AuthenticateOptions {
  /**
   * Self-service session routes may use a scoped token without a resource binding. No
   * other route may: a scope that cannot be checked must never silently become broad.
   */
  allowUnboundScope?: boolean;
}

export interface RotationPlan {
  previous_token_sha256: string;
  retired_at: string;
  record: SessionRecord;
  token: string;
}

export interface RotationResult {
  token: string;
  session_id: string;
  generation: number;
  expires_at: string;
  scope?: SessionScope;
}

export interface RevocationResult {
  session_id: string;
  generation: number;
  revoked_at: string;
}

export interface AdminRevocationResult extends RevocationResult {
  already_revoked: boolean;
}

/** Operator-visible session metadata; deliberately excludes the token digest. */
export interface PublicSessionRecord {
  session_id: string;
  principal_id: string;
  label: string;
  issued_at: string;
  expires_at: string;
  generation: number;
  status: 'active' | 'revoked';
  scope?: SessionScope;
  revoked_at?: string;
  revocation_reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isTokenDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new SessionScopeError(`${label} contains unsupported field "${key}".`);
  }
}

function copyScope(scope: SessionScope | undefined): SessionScope | undefined {
  if (scope === undefined) return undefined;
  return Object.freeze({
    ...(scope.task_id === undefined ? {} : { task_id: scope.task_id }),
    ...(scope.run_id === undefined ? {} : { run_id: scope.run_id }),
    ...(scope.evidence_sha256 === undefined ? {} : { evidence_sha256: scope.evidence_sha256 }),
  });
}

/** Parses an operator-supplied token scope. Empty and unknown scopes are rejected. */
export function parseSessionScope(value: unknown): SessionScope {
  if (!isRecord(value)) throw new SessionScopeError('Field "scope" must be an object.');
  assertKnownKeys(value, ['task_id', 'run_id', 'evidence_sha256'], 'scope');
  const scope: SessionScope = {};
  if (value.task_id !== undefined) {
    if (!isUuid(value.task_id)) throw new SessionScopeError('scope.task_id must be a UUID.');
    scope.task_id = value.task_id;
  }
  if (value.run_id !== undefined) {
    if (!isUuid(value.run_id)) throw new SessionScopeError('scope.run_id must be a UUID.');
    scope.run_id = value.run_id;
  }
  if (value.evidence_sha256 !== undefined) {
    if (!isTokenDigest(value.evidence_sha256)) {
      throw new SessionScopeError('scope.evidence_sha256 must be a lowercase hex SHA-256 digest.');
    }
    scope.evidence_sha256 = value.evidence_sha256;
  }
  if (scope.task_id === undefined && scope.run_id === undefined) {
    throw new SessionScopeError('scope must bind at least a task_id or run_id.');
  }
  if (scope.evidence_sha256 !== undefined && scope.task_id === undefined) {
    throw new SessionScopeError('An evidence scope must also bind a task_id.');
  }
  return Object.freeze(scope);
}

function parseSessionScopeFromRecord(value: unknown): SessionScope | undefined {
  if (value === undefined) return undefined;
  return parseSessionScope(value);
}

function isNarrowerOrEqual(next: SessionScope | undefined, current: SessionScope | undefined): boolean {
  if (current === undefined) return true;
  if (next === undefined) return false;
  if (current.task_id !== undefined && next.task_id !== current.task_id) return false;
  if (current.run_id !== undefined && next.run_id !== current.run_id) return false;
  if (current.evidence_sha256 !== undefined && next.evidence_sha256 !== current.evidence_sha256) return false;
  return true;
}

function matchesScope(scope: SessionScope | undefined, binding: SessionBinding | undefined): SessionDenialReason | undefined {
  if (scope === undefined) return undefined;
  if (binding === undefined) return 'scope_binding_required';
  if (scope.task_id !== undefined && binding.task_id !== scope.task_id) return 'task_scope_mismatch';
  if (scope.run_id !== undefined && binding.run_id !== scope.run_id) return 'run_scope_mismatch';
  if (scope.evidence_sha256 !== undefined && binding.evidence_sha256 !== scope.evidence_sha256) {
    return 'evidence_scope_mismatch';
  }
  return undefined;
}

function sessionIdentity(record: SessionRecord): AuthenticatedSession {
  return Object.freeze({
    session_id: record.session_id,
    principal_id: record.principal_id,
    label: record.label,
    generation: record.generation,
    expires_at: record.expires_at,
    ...(record.scope === undefined ? {} : { scope: copyScope(record.scope) }),
  });
}

function publicSessionRecord(record: SessionRecord): PublicSessionRecord {
  return {
    session_id: record.session_id,
    principal_id: record.principal_id,
    label: record.label,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    generation: record.generation,
    status: record.status,
    ...(record.scope === undefined ? {} : { scope: copyScope(record.scope) }),
    ...(record.revoked_at === undefined ? {} : { revoked_at: record.revoked_at }),
    ...(record.revocation_reason === undefined ? {} : { revocation_reason: record.revocation_reason }),
  };
}

function parseSessionRecord(value: unknown): SessionRecord {
  if (!isRecord(value)) throw new JournalError('Session state contains a non-object record.');
  assertKnownKeys(
    value,
    ['session_id', 'principal_id', 'token_sha256', 'label', 'issued_at', 'expires_at', 'generation', 'status', 'scope', 'revoked_at', 'revocation_reason'],
    'session record',
  );
  if (!isUuid(value.session_id)
    || typeof value.principal_id !== 'string'
    || !(HUMAN_PRINCIPAL.test(value.principal_id) || isUuid(value.principal_id))
    || !isTokenDigest(value.token_sha256)
    || typeof value.label !== 'string' || value.label.length > 120
    || !isIsoTimestamp(value.issued_at)
    || !isIsoTimestamp(value.expires_at)
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || (value.status !== 'active' && value.status !== 'revoked')
    || !(value.revoked_at === undefined || isIsoTimestamp(value.revoked_at))
    || !(value.revocation_reason === undefined
      || (typeof value.revocation_reason === 'string'
        && value.revocation_reason.length > 0 && value.revocation_reason.length <= 120))) {
    throw new JournalError('Session state contains an invalid session record.');
  }
  const issuedAt = Date.parse(value.issued_at);
  const expiresAt = Date.parse(value.expires_at);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SESSION_LIFETIME_MS) {
    throw new JournalError('Session state contains an out-of-bounds session lifetime.');
  }
  if (value.status === 'active' && (value.revoked_at !== undefined || value.revocation_reason !== undefined)) {
    throw new JournalError('Session state contains an active session with revocation fields.');
  }
  if (value.status === 'revoked' && (value.revoked_at === undefined || value.revocation_reason === undefined)) {
    throw new JournalError('Session state contains a revoked session without revocation evidence.');
  }
  return {
    session_id: value.session_id,
    principal_id: value.principal_id,
    token_sha256: value.token_sha256,
    label: value.label,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    generation: value.generation as number,
    status: value.status,
    ...(value.scope === undefined ? {} : { scope: parseSessionScopeFromRecord(value.scope) }),
    ...(value.revoked_at === undefined ? {} : { revoked_at: value.revoked_at }),
    ...(value.revocation_reason === undefined ? {} : { revocation_reason: value.revocation_reason }),
  };
}

function parseRetiredToken(value: unknown): RetiredSessionToken {
  if (!isRecord(value)
    || !isTokenDigest(value.token_sha256)
    || !isUuid(value.session_id)
    || (value.reason !== 'rotated' && value.reason !== 'revoked')
    || !isIsoTimestamp(value.retired_at)) {
    throw new JournalError('Session state contains an invalid retired token.');
  }
  return {
    token_sha256: value.token_sha256,
    session_id: value.session_id,
    reason: value.reason,
    retired_at: value.retired_at,
  };
}

function parseRotationPayload(value: unknown): {
  previous_token_sha256: string;
  retired_at: string;
  session: SessionRecord;
} {
  if (!isRecord(value)) throw new JournalError('Session rotation record is malformed.');
  assertKnownKeys(value, ['previous_token_sha256', 'retired_at', 'session'], 'session rotation');
  if (!isTokenDigest(value.previous_token_sha256)
    || !isIsoTimestamp(value.retired_at)) {
    throw new JournalError('Session rotation record is malformed.');
  }
  return {
    previous_token_sha256: value.previous_token_sha256,
    retired_at: value.retired_at,
    session: parseSessionRecord(value.session),
  };
}

function parseRevocationPayload(value: unknown): {
  revoked_at: string;
  session: SessionRecord;
} {
  if (!isRecord(value)) throw new JournalError('Session revocation record is malformed.');
  assertKnownKeys(value, ['revoked_at', 'session'], 'session revocation');
  if (!isIsoTimestamp(value.revoked_at)) throw new JournalError('Session revocation record is malformed.');
  return {
    revoked_at: value.revoked_at,
    session: parseSessionRecord(value.session),
  };
}

/**
 * In-memory authority for session generations, scopes, expiries, and retired tokens.
 *
 * Rotation and revocation are planned before the durable store appends the corresponding
 * journal record, so a failed append cannot leave the in-memory authority ahead of disk.
 * A token is retired by its digest and can never become active again.
 */
export class SessionState {
  private readonly records = new Map<string, SessionRecord>();
  private readonly retiredTokens = new Map<string, RetiredSessionToken>();

  constructor(entries: readonly HostSessionEntry[], now: number = Date.now()) {
    if (!Array.isArray(entries)) throw new Error('Session state requires a session list.');
    for (const entry of entries) {
      const expiresAt = Date.parse(entry.expires_at);
      if (!Number.isFinite(expiresAt)) throw new Error('Configured session expiry is not an ISO timestamp.');
      if (expiresAt > now + MAX_SESSION_LIFETIME_MS) {
        throw new Error('Configured session expiry exceeds the maximum bounded lifetime.');
      }
      const issuedAt = new Date(expiresAt - MAX_SESSION_LIFETIME_MS).toISOString();
      const record: SessionRecord = {
        session_id: entry.session_id,
        principal_id: entry.principal_id,
        token_sha256: entry.token_sha256,
        label: entry.label ?? '',
        issued_at: issuedAt,
        expires_at: entry.expires_at,
        generation: 1,
        status: 'active',
      };
      if (this.records.has(record.session_id)) throw new Error('Configured session identifiers must be unique.');
      this.records.set(record.session_id, record);
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /** Lists sessions for an operator without exposing token digests. */
  listPublic(): PublicSessionRecord[] {
    return this.list().map(publicSessionRecord);
  }

  retired(): RetiredSessionToken[] {
    return [...this.retiredTokens.values()].map((token) => structuredClone(token));
  }

  snapshot(): SessionSnapshot {
    return { sessions: this.list(), retired_tokens: this.retired() };
  }

  authenticate(
    authorizationHeader: string | undefined,
    now: number = Date.now(),
    binding?: SessionBinding,
    options: AuthenticateOptions = {},
  ): AuthenticationResult {
    if (typeof authorizationHeader !== 'string') return { ok: false, reason: 'missing_credential' };
    if (authorizationHeader.length > 519) return { ok: false, reason: 'malformed_credential' };
    const match = BEARER.exec(authorizationHeader);
    const token = match?.[1];
    if (!token) return { ok: false, reason: 'malformed_credential' };

    const presented = createHash('sha256').update(token, 'utf8').digest();
    let matched: SessionRecord | undefined;
    for (const record of this.records.values()) {
      const candidate = Buffer.from(record.token_sha256, 'hex');
      if (candidate.length !== presented.length) continue;
      if (timingSafeEqual(candidate, presented) && matched === undefined) matched = record;
    }
    if (matched === undefined) {
      for (const retired of this.retiredTokens.values()) {
        const candidate = Buffer.from(retired.token_sha256, 'hex');
        if (candidate.length !== presented.length) continue;
        if (timingSafeEqual(candidate, presented)) {
          return {
            ok: false,
            reason: retired.reason === 'rotated' ? 'rotated_token' : 'revoked_token',
          };
        }
      }
      return { ok: false, reason: 'unknown_token' };
    }
    if (matched.status === 'revoked') return { ok: false, reason: 'revoked_token' };
    if (Date.parse(matched.expires_at) <= now) return { ok: false, reason: 'expired_token' };
    const scopeDenial = options.allowUnboundScope
      ? undefined
      : matchesScope(matched.scope, binding);
    if (scopeDenial !== undefined) return { ok: false, reason: scopeDenial };
    return { ok: true, session: sessionIdentity(matched) };
  }

  assertBinding(session: AuthenticatedSession, binding: SessionBinding): void {
    const denial = matchesScope(session.scope, binding);
    if (denial !== undefined) throw new SessionDeniedError(denial);
  }

  planRotation(
    authorizationHeader: string | undefined,
    requestedScope: SessionScope | undefined,
    now: number = Date.now(),
  ): RotationPlan {
    const authenticated = this.authenticate(authorizationHeader, now, undefined, { allowUnboundScope: true });
    if (!authenticated.ok) throw new SessionDeniedError(authenticated.reason);
    const current = this.records.get(authenticated.session.session_id);
    if (current === undefined || current.status !== 'active') {
      throw new SessionDeniedError('revoked_token');
    }
    return this.planRotationFor(current, requestedScope, now);
  }

  /** Operator-initiated rotation by immutable session id, after exact authorization. */
  planRotationById(sessionId: string, now: number = Date.now()): RotationPlan {
    const current = this.records.get(sessionId);
    if (current === undefined) throw new SessionNotFoundError(sessionId);
    if (current.status !== 'active') {
      throw new SessionConflictError('Session is already revoked.');
    }
    if (Date.parse(current.expires_at) <= now) {
      throw new SessionConflictError('Session is expired and cannot be rotated; provision a new session instead.');
    }
    return this.planRotationFor(current, undefined, now);
  }

  private planRotationFor(
    current: SessionRecord,
    requestedScope: SessionScope | undefined,
    now: number,
  ): RotationPlan {
    if (this.retiredTokens.size >= MAX_RETIRED_TOKENS) {
      throw new SessionConflictError('The retired-token limit was reached; restart from a newly provisioned session.');
    }
    const scope = requestedScope === undefined ? current.scope : parseSessionScope(requestedScope);
    if (!isNarrowerOrEqual(scope, current.scope)) {
      throw new SessionConflictError('Session rotation cannot broaden the existing token scope.');
    }
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = {
      session_id: current.session_id,
      principal_id: current.principal_id,
      token_sha256: createHash('sha256').update(token, 'utf8').digest('hex'),
      label: current.label,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + MAX_SESSION_LIFETIME_MS).toISOString(),
      generation: current.generation + 1,
      status: 'active',
      ...(scope === undefined ? {} : { scope: copyScope(scope) }),
    };
    return {
      previous_token_sha256: current.token_sha256,
      retired_at: new Date(now).toISOString(),
      record,
      token,
    };
  }

  rotate(
    authorizationHeader: string | undefined,
    requestedScope: SessionScope | undefined,
    now: number = Date.now(),
  ): RotationResult {
    const plan = this.planRotation(authorizationHeader, requestedScope, now);
    this.applyRotation(plan);
    return rotationResult(plan);
  }

  rotateById(sessionId: string, now: number = Date.now()): RotationResult {
    const plan = this.planRotationById(sessionId, now);
    this.applyRotation(plan);
    return rotationResult(plan);
  }

  applyRotation(plan: RotationPlan): void {
    const current = this.records.get(plan.record.session_id);
    if (current === undefined || current.status !== 'active') {
      throw new JournalError('Session rotation does not match an active session.');
    }
    if (current.token_sha256 !== plan.previous_token_sha256
      || plan.record.generation !== current.generation + 1
      || plan.record.principal_id !== current.principal_id
      || plan.record.label !== current.label
      || plan.record.issued_at !== plan.retired_at) {
      throw new JournalError('Session rotation does not continue the current generation or identity.');
    }
    if (this.retiredTokens.has(plan.record.token_sha256)
      || [...this.records.values()].some((record) => record.token_sha256 === plan.record.token_sha256)) {
      throw new JournalError('Session rotation reuses an existing token digest.');
    }
    const retired: RetiredSessionToken = {
      token_sha256: plan.previous_token_sha256,
      session_id: plan.record.session_id,
      reason: 'rotated',
      retired_at: plan.retired_at,
    };
    if (this.retiredTokens.has(retired.token_sha256)) {
      throw new JournalError('Session rotation retires an already-retired token.');
    }
    this.records.set(plan.record.session_id, plan.record);
    this.retiredTokens.set(retired.token_sha256, retired);
  }

  planRevocation(
    authorizationHeader: string | undefined,
    now: number = Date.now(),
  ): { retired: RetiredSessionToken; record: SessionRecord; revoked_at: string } {
    const authenticated = this.authenticate(authorizationHeader, now, undefined, { allowUnboundScope: true });
    if (!authenticated.ok) throw new SessionDeniedError(authenticated.reason);
    const current = this.records.get(authenticated.session.session_id);
    if (current === undefined || current.status !== 'active') {
      throw new SessionDeniedError('revoked_token');
    }
    return this.planRevocationFor(current, now);
  }

  /** Operator-initiated revocation by immutable session id; repeated calls are idempotent. */
  planRevocationById(sessionId: string, now: number = Date.now()): ReturnType<SessionState['planRevocation']> & { already_revoked: boolean } {
    const current = this.records.get(sessionId);
    if (current === undefined) throw new SessionNotFoundError(sessionId);
    if (current.status === 'revoked') {
      return {
        record: current,
        revoked_at: current.revoked_at ?? new Date(now).toISOString(),
        retired: {
          token_sha256: current.token_sha256,
          session_id: current.session_id,
          reason: 'revoked',
          retired_at: current.revoked_at ?? new Date(now).toISOString(),
        },
        already_revoked: true,
      };
    }
    return { ...this.planRevocationFor(current, now), already_revoked: false };
  }

  private planRevocationFor(
    current: SessionRecord,
    now: number,
  ): { retired: RetiredSessionToken; record: SessionRecord; revoked_at: string } {
    if (this.retiredTokens.size >= MAX_RETIRED_TOKENS) {
      throw new SessionConflictError('The retired-token limit was reached; restart from a newly provisioned session.');
    }
    const revokedAt = new Date(now).toISOString();
    const record: SessionRecord = {
      ...current,
      status: 'revoked',
      revoked_at: revokedAt,
      revocation_reason: 'self_revoked',
    };
    return {
      record,
      revoked_at: revokedAt,
      retired: {
        token_sha256: current.token_sha256,
        session_id: current.session_id,
        reason: 'revoked',
        retired_at: revokedAt,
      },
    };
  }

  revoke(authorizationHeader: string | undefined, now: number = Date.now()): RevocationResult {
    const plan = this.planRevocation(authorizationHeader, now);
    this.applyRevocation(plan);
    return revocationResult(plan);
  }

  revokeById(sessionId: string, now: number = Date.now()): AdminRevocationResult {
    const plan = this.planRevocationById(sessionId, now);
    if (plan.already_revoked) return { ...revocationResult(plan), already_revoked: true };
    this.applyRevocation(plan);
    return { ...revocationResult(plan), already_revoked: false };
  }

  applyRevocation(plan: ReturnType<SessionState['planRevocation']>): void {
    const current = this.records.get(plan.record.session_id);
    if (current === undefined || current.status !== 'active'
      || current.token_sha256 !== plan.retired.token_sha256
      || current.generation !== plan.record.generation
      || plan.record.principal_id !== current.principal_id
      || plan.record.label !== current.label
      || plan.record.revoked_at !== plan.revoked_at) {
      throw new JournalError('Session revocation does not match the active session identity.');
    }
    if (this.retiredTokens.has(plan.retired.token_sha256)) {
      throw new JournalError('Session revocation retires an already-retired token.');
    }
    this.records.set(plan.record.session_id, plan.record);
    this.retiredTokens.set(plan.retired.token_sha256, plan.retired);
  }

  restoreRotation(value: unknown): void {
    const payload = parseRotationPayload(value);
    if (payload.session.status !== 'active') {
      throw new JournalError('Session rotation record does not contain an active session.');
    }
    this.applyRotation({
      previous_token_sha256: payload.previous_token_sha256,
      retired_at: payload.retired_at,
      record: payload.session,
      token: '',
    });
  }

  restoreRevocation(value: unknown): void {
    const payload = parseRevocationPayload(value);
    if (payload.session.status !== 'revoked' || payload.session.revoked_at !== payload.revoked_at) {
      throw new JournalError('Session revocation record is inconsistent with its session.');
    }
    this.applyRevocation({
      record: payload.session,
      revoked_at: payload.revoked_at,
      retired: {
        token_sha256: payload.session.token_sha256,
        session_id: payload.session.session_id,
        reason: 'revoked',
        retired_at: payload.revoked_at,
      },
    });
  }

  restoreSnapshot(value: unknown): void {
    if (!isRecord(value)
      || !Array.isArray(value.sessions)
      || !Array.isArray(value.retired_tokens)) {
      throw new JournalError('Session snapshot is malformed.');
    }
    const sessions = value.sessions.map(parseSessionRecord);
    const retired = value.retired_tokens.map(parseRetiredToken);
    // A snapshot may update only sessions that still exist in configuration. It may not
    // reintroduce a session removed from config, and configured sessions added after the
    // snapshot retain their generation-1 seed.
    const records = new Map(this.records);
    const retiredMap = new Map(this.retiredTokens);
    for (const record of sessions) {
      if (!records.has(record.session_id)) {
        throw new JournalError('Session snapshot contains a session that configuration no longer provisions.');
      }
      records.set(record.session_id, record);
    }
    for (const token of retired) {
      if (!records.has(token.session_id)) {
        throw new JournalError('Session snapshot retires a token for an unconfigured session.');
      }
      retiredMap.set(token.token_sha256, token);
    }
    const activeDigests = new Set<string>();
    for (const record of records.values()) {
      if (activeDigests.has(record.token_sha256)) {
        throw new JournalError('Session snapshot contains a duplicate active token digest.');
      }
      activeDigests.add(record.token_sha256);
      if (retiredMap.has(record.token_sha256)) {
        throw new JournalError('Session snapshot reactivates a retired token.');
      }
      if (record.status === 'revoked' && !retiredMap.has(record.token_sha256)) {
        throw new JournalError('Session snapshot contains a revoked session without its retired token.');
      }
    }
    for (const token of retiredMap.values()) {
      if (!records.has(token.session_id)) {
        throw new JournalError('Session state retires a token for an unconfigured session.');
      }
    }
    this.records.clear();
    this.retiredTokens.clear();
    for (const [id, record] of records) this.records.set(id, record);
    for (const [digest, token] of retiredMap) this.retiredTokens.set(digest, token);
  }
}

/**
 * Durable session authority over the operational journal.
 *
 * Journal append happens before the in-memory transition. Rotation/revocation therefore
 * either commits to disk and memory, or leaves both unchanged; it never acknowledges a
 * lifecycle change that will disappear on restart.
 */
function rotationResult(plan: RotationPlan): RotationResult {
  return {
    token: plan.token,
    session_id: plan.record.session_id,
    generation: plan.record.generation,
    expires_at: plan.record.expires_at,
    ...(plan.record.scope === undefined ? {} : { scope: copyScope(plan.record.scope) }),
  };
}

function revocationResult(plan: { record: SessionRecord; revoked_at: string }): RevocationResult {
  return {
    session_id: plan.record.session_id,
    generation: plan.record.generation,
    revoked_at: plan.revoked_at,
  };
}

export class DurableSessionStore {
  readonly state: SessionState;

  constructor(
    private readonly journal: AppendOnlyJournal,
    entries: readonly HostSessionEntry[] = [],
    now: number = Date.now(),
  ) {
    this.state = new SessionState(entries, now);
  }

  list(): SessionRecord[] {
    return this.state.list();
  }

  listPublic(): PublicSessionRecord[] {
    return this.state.listPublic();
  }

  authenticate(
    authorizationHeader: string | undefined,
    now: number = Date.now(),
    binding?: SessionBinding,
    options: AuthenticateOptions = {},
  ): AuthenticationResult {
    return this.state.authenticate(authorizationHeader, now, binding, options);
  }

  assertBinding(session: AuthenticatedSession, binding: SessionBinding): void {
    this.state.assertBinding(session, binding);
  }

  rotate(
    authorizationHeader: string | undefined,
    requestedScope: SessionScope | undefined,
    now: number = Date.now(),
  ): RotationResult {
    const plan = this.state.planRotation(authorizationHeader, requestedScope, now);
    this.commitRotation(plan);
    return rotationResult(plan);
  }

  rotateById(sessionId: string, now: number = Date.now()): RotationResult {
    const plan = this.state.planRotationById(sessionId, now);
    this.commitRotation(plan);
    return rotationResult(plan);
  }

  private commitRotation(plan: RotationPlan): void {
    this.journal.append('session_rotated', {
      previous_token_sha256: plan.previous_token_sha256,
      retired_at: plan.retired_at,
      session: plan.record,
    });
    this.state.applyRotation(plan);
  }

  revoke(authorizationHeader: string | undefined, now: number = Date.now()): RevocationResult {
    const plan = this.state.planRevocation(authorizationHeader, now);
    this.commitRevocation(plan);
    return revocationResult(plan);
  }

  revokeById(sessionId: string, now: number = Date.now()): AdminRevocationResult {
    const plan = this.state.planRevocationById(sessionId, now);
    if (plan.already_revoked) return { ...revocationResult(plan), already_revoked: true };
    this.commitRevocation(plan);
    return { ...revocationResult(plan), already_revoked: false };
  }

  private commitRevocation(plan: {
    retired: RetiredSessionToken;
    record: SessionRecord;
    revoked_at: string;
  }): void {
    this.journal.append('session_revoked', {
      revoked_at: plan.revoked_at,
      session: plan.record,
    });
    this.state.applyRevocation(plan);
  }

  restoreRotation(value: unknown): void {
    this.state.restoreRotation(value);
  }

  restoreRevocation(value: unknown): void {
    this.state.restoreRevocation(value);
  }

  restoreSnapshot(value: unknown): void {
    this.state.restoreSnapshot(value);
  }
}
