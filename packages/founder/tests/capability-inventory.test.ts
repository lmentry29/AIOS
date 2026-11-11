import { describe, expect, it } from 'vitest';
import {
  ACCESS_ACTIONS,
  CAPABILITY_INVENTORY,
  HUMAN_ONLY_ACTIONS,
  capabilityFor,
  isAccessAction,
  isHumanOnlyAction,
} from '../src/security/capability-inventory.js';

describe('closed capability inventory', () => {
  it('declares every runtime action exactly once with exact-resource scope', () => {
    expect(ACCESS_ACTIONS).toEqual([
      'intake',
      'dispatch',
      'execute',
      'coordinate',
      'cancel',
      'resume',
      'retry',
      'read_status',
      'read_evidence',
      'administer_policy',
      'revoke_policy',
      'administer_sessions',
    ]);
    expect(new Set(ACCESS_ACTIONS).size).toBe(ACCESS_ACTIONS.length);
    for (const action of ACCESS_ACTIONS) {
      expect(CAPABILITY_INVENTORY[action].resource_scope).toBe('exact_resource');
      expect(CAPABILITY_INVENTORY[action].summary.length).toBeGreaterThan(0);
    }
    expect([...HUMAN_ONLY_ACTIONS]).toEqual([
      'administer_policy',
      'revoke_policy',
      'administer_sessions',
    ]);
  });

  it('fails closed for unknown, wildcard, inherited and malformed capabilities', () => {
    for (const value of [
      undefined,
      null,
      0,
      '',
      '*',
      'execute:*',
      'toString',
      '__proto__',
      'constructor',
      'read_evidence ',
    ]) {
      expect(capabilityFor(value)).toBeUndefined();
      expect(isAccessAction(value)).toBe(false);
      expect(isHumanOnlyAction(value)).toBe(false);
    }
  });

  it('never promotes a non-admin action into the human-only set', () => {
    for (const action of ACCESS_ACTIONS) {
      expect(isHumanOnlyAction(action)).toBe(CAPABILITY_INVENTORY[action].human_only);
    }
  });
});
