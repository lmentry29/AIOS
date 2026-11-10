import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthorizationDecisionAudit } from '@aios/founder';
import { DurableAuthorizationAuditStore } from '../src/persistence/authorization-audit-store.js';

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'aios-authorization-audit-'));
}

function allow(overrides: Partial<AuthorizationDecisionAudit> = {}): AuthorizationDecisionAudit {
  return {
    request_id: randomUUID(),
    actor_id: 'human:founder',
    action: 'read_evidence',
    resource_id: randomUUID(),
    policy_id: randomUUID(),
    policy_version: 1,
    decision: 'allow',
    reason: 'matching_allow',
    matched_rule_index: 0,
    matched_rule_effect: 'allow',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function deny(overrides: Partial<AuthorizationDecisionAudit> = {}): AuthorizationDecisionAudit {
  return {
    request_id: randomUUID(),
    actor_id: 'human:other',
    action: 'read_evidence',
    resource_id: randomUUID(),
    policy_id: randomUUID(),
    policy_version: 1,
    decision: 'deny',
    reason: 'no_matching_allow',
    matched_rule_index: null,
    matched_rule_effect: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('DurableAuthorizationAuditStore', () => {
  it('records allow and deny decisions in order and preserves them across reopen', async () => {
    const directory = stateDirectory();
    const first = new DurableAuthorizationAuditStore({ directory });
    const allowed = allow();
    const denied = deny();
    await first.append(allowed);
    await first.append(denied);
    expect(first.list().map((record) => record.decision)).toEqual(['allow', 'deny']);
    first.close();

    const second = new DurableAuthorizationAuditStore({ directory });
    expect(second.list()).toEqual([allowed, denied]);
    expect(second.recoveredTornTail).toBe(false);
    second.close();
  });

  it('rejects unknown fields and invalid reason codes without writing a record', async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await expect(store.append({ ...allow(), token: 'secret-token' } as never))
      .rejects.toThrow(/unsupported field/);
    await expect(store.append(allow({ reason: 'raw error with secret-token' })))
      .rejects.toThrow(/invalid/);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('detects an out-of-band edit to a complete record on reopen', async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    store.close();

    const path = join(directory, 'authorization-audit.jsonl');
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('"timestamp":"2');
    writeFileSync(path, contents.replace('"timestamp":"2', '"timestamp":"1'), { mode: 0o600 });
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/hash-chain/);
  });

  it('recovers an interrupted trailing append and keeps complete records', async () => {
    const directory = stateDirectory();
    const first = new DurableAuthorizationAuditStore({ directory });
    await first.append(allow());
    first.close();

    appendFileSync(join(directory, 'authorization-audit.jsonl'), '{"sequence":2');
    const second = new DurableAuthorizationAuditStore({ directory });
    expect(second.recoveredTornTail).toBe(true);
    expect(second.list()).toHaveLength(1);
    await second.append(deny());
    second.close();

    const third = new DurableAuthorizationAuditStore({ directory });
    expect(third.list().map((record) => record.decision)).toEqual(['allow', 'deny']);
    third.close();
  });

  it('fails the append and does not record a phantom decision at the size limit', async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory, maxBytes: 4096 });
    let appended = 0;
    let failed = false;
    for (let index = 0; index < 20; index += 1) {
      try {
        await store.append(allow());
        appended += 1;
      } catch {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(store.list()).toHaveLength(appended);
    store.close();

    const reopened = new DurableAuthorizationAuditStore({ directory, maxBytes: 4096 });
    expect(reopened.list()).toHaveLength(appended);
    reopened.close();
  });

  it('keeps raw credentials out of the serialized journal', async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    store.close();

    const contents = readFileSync(join(directory, 'authorization-audit.jsonl'), 'utf8');
    expect(contents).not.toContain('secret-token');
    expect(contents).not.toContain('Bearer');
    expect(contents).not.toContain('founder-token');
  });
});
