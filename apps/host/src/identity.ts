import { createHash, timingSafeEqual } from 'node:crypto';
import type { HostSessionEntry } from './config.js';

/**
 * The only identity the host trusts. It is produced by verifying a bearer token against
 * configuration, never by reading an actor string from a request body or query parameter.
 */
export interface AuthenticatedSession {
  session_id: string;
  principal_id: string;
  label: string;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/;
const HUMAN_PRINCIPAL = /^human:[^\s:*]+$/;

export function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && HUMAN_PRINCIPAL.test(value);
}

/**
 * Verifies opaque bearer tokens against pre-provisioned SHA-256 digests.
 *
 * Properties the host relies on:
 * - A plaintext token never appears in configuration, audit records, responses, or logs.
 * - Every entry is compared with `timingSafeEqual`; the loop does not exit early on a match,
 *   so timing does not reveal which session (if any) matched.
 * - A malformed, missing, expanded, or expired credential is indistinguishable from a wrong
 *   one: callers get the same unauthenticated result.
 */
export class TrustedIdentityService {
  private readonly entries: readonly HostSessionEntry[];

  constructor(entries: readonly HostSessionEntry[]) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('Trusted identity requires at least one configured session.');
    }
    this.entries = entries.map((entry) => Object.freeze({ ...entry }));
  }

  authenticate(authorizationHeader: string | undefined, now: number = Date.now()): AuthenticatedSession | undefined {
    if (typeof authorizationHeader !== 'string') return undefined;
    if (authorizationHeader.length > 519) return undefined;
    const match = BEARER.exec(authorizationHeader);
    const token = match?.[1];
    if (!token) return undefined;

    const presented = createHash('sha256').update(token, 'utf8').digest();
    let matched: HostSessionEntry | undefined;
    for (const entry of this.entries) {
      const candidate = Buffer.from(entry.token_sha256, 'hex');
      if (candidate.length !== presented.length) continue;
      if (timingSafeEqual(candidate, presented) && matched === undefined) matched = entry;
    }
    if (matched === undefined) return undefined;
    if (matched.expires_at !== undefined && Date.parse(matched.expires_at) <= now) return undefined;

    return Object.freeze({
      session_id: matched.session_id,
      principal_id: matched.principal_id,
      label: matched.label ?? '',
    });
  }
}
