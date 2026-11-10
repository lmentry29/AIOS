import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isHumanPrincipal, TrustedIdentityService } from '../src/identity.js';
import { AGENT_ID, FOUNDER } from './fixtures.js';

const TOKEN = 'founder-token-0123456789abcdef';
const OTHER_TOKEN = 'other-token-0123456789abcdefgh';

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function service(expiresAt?: string): TrustedIdentityService {
  return new TrustedIdentityService([
    {
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: digest(TOKEN),
      label: 'founder laptop',
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    },
    {
      session_id: randomUUID(),
      principal_id: AGENT_ID,
      token_sha256: digest(OTHER_TOKEN),
    },
  ]);
}

describe('TrustedIdentityService', () => {
  it('binds a valid bearer token to its configured principal', () => {
    const session = service().authenticate(`Bearer ${TOKEN}`);
    expect(session?.principal_id).toBe(FOUNDER);
    expect(session?.label).toBe('founder laptop');
    expect(session?.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the same unauthenticated result for every invalid credential shape', () => {
    const identity = service();
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Basic ${TOKEN}`,
      'Bearer ',
      `Bearer ${TOKEN} extra`,
      `Bearer ${TOKEN} `,
      'Bearer short',
      `Bearer ${'a'.repeat(600)}`,
    ]) {
      expect(identity.authenticate(header)).toBeUndefined();
    }
  });

  it('never authenticates a token whose digest was not provisioned', () => {
    expect(service().authenticate(`Bearer ${'x'.repeat(32)}`)).toBeUndefined();
  });

  it('refuses an expired session even when the digest matches', () => {
    const identity = service('2026-01-01T00:00:00.000Z');
    expect(identity.authenticate(`Bearer ${TOKEN}`, Date.parse('2026-06-01T00:00:00.000Z')))
      .toBeUndefined();
    expect(identity.authenticate(`Bearer ${TOKEN}`, Date.parse('2025-06-01T00:00:00.000Z'))?.principal_id)
      .toBe(FOUNDER);
  });

  it('requires at least one configured session', () => {
    expect(() => new TrustedIdentityService([])).toThrow(/at least one/);
  });

  it('distinguishes human principals from Agent identifiers', () => {
    expect(isHumanPrincipal('human:founder')).toBe(true);
    expect(isHumanPrincipal('human:')).toBe(false);
    expect(isHumanPrincipal('human:founder:extra')).toBe(false);
    expect(isHumanPrincipal(AGENT_ID)).toBe(false);
    expect(isHumanPrincipal(AGENT_ID.toUpperCase())).toBe(false);
  });
});
