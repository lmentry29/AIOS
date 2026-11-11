import type { HostSessionEntry } from './config.js';
import {
  SessionState,
  type AuthenticatedSession,
  type AuthenticationResult,
  type AuthenticateOptions,
  type RevocationResult,
  type RotationResult,
  type SessionBinding,
  type SessionRecord,
  type SessionScope,
} from './persistence/session-store.js';

export type {
  AuthenticatedSession,
  AuthenticationResult,
  SessionBinding,
  SessionScope,
} from './persistence/session-store.js';
export {
  SessionConflictError,
  SessionDeniedError,
  SessionScopeError,
  parseSessionScope,
} from './persistence/session-store.js';

interface SessionAuthority {
  authenticate(
    authorizationHeader: string | undefined,
    now?: number,
    binding?: SessionBinding,
    options?: AuthenticateOptions,
  ): AuthenticationResult;
  assertBinding(session: AuthenticatedSession, binding: SessionBinding): void;
  list(): SessionRecord[];
  rotate(
    authorizationHeader: string | undefined,
    scope?: SessionScope,
    now?: number,
  ): RotationResult;
  revoke(authorizationHeader: string | undefined, now?: number): RevocationResult;
}

const HUMAN_PRINCIPAL = /^human:[^\s:*]+$/;

export function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && HUMAN_PRINCIPAL.test(value);
}

/**
 * The only identity the host trusts.
 *
 * Authentication is backed by a bounded-lifetime session generation and an append-only
 * retired-token set. The authority is the session store, not a request field: expiry,
 * rotation, revocation, and task/run/evidence scope are all checked before a route can
 * act. A scoped token with no requested binding is denied rather than treated as broad.
 */
export class TrustedIdentityService {
  private readonly authority: SessionAuthority;

  constructor(authority: SessionAuthority | readonly HostSessionEntry[]) {
    this.authority = Array.isArray(authority)
      ? new SessionState(authority as readonly HostSessionEntry[])
      : authority as SessionAuthority;
    if (this.authority.list().length === 0) {
      throw new Error('Trusted identity requires at least one configured session.');
    }
  }

  authenticate(
    authorizationHeader: string | undefined,
    now: number = Date.now(),
    binding?: SessionBinding,
    options: AuthenticateOptions = {},
  ): AuthenticationResult {
    return this.authority.authenticate(authorizationHeader, now, binding, options);
  }

  assertBinding(session: AuthenticatedSession, binding: SessionBinding): void {
    this.authority.assertBinding(session, binding);
  }

  rotate(
    authorizationHeader: string | undefined,
    scope?: SessionScope,
    now: number = Date.now(),
  ): RotationResult {
    return this.authority.rotate(authorizationHeader, scope, now);
  }

  revoke(authorizationHeader: string | undefined, now: number = Date.now()): RevocationResult {
    return this.authority.revoke(authorizationHeader, now);
  }
}
