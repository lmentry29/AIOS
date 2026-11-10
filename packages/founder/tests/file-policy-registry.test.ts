import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccessPolicy } from '../src/authorization.js';
import { AuthorizationService } from '../src/authorization.js';
import { FilePolicyRegistry, FilePolicyRegistryError } from '../src/file-policy-registry.js';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aios-policy-registry-'));
  const filePath = join(directory, 'state', 'policies.json');
  const resourceId = randomUUID();
  const policy: AccessPolicy = {
    policy_id: randomUUID(),
    version: 1,
    rules: [{
      effect: 'allow',
      subject_ids: ['human:founder'],
      actions: ['read_evidence'],
      resource_ids: [resourceId],
    }],
  };
  return { directory, filePath, resourceId, policy };
}

describe('FilePolicyRegistry', () => {
  it('persists immutable policies, resource attachments, and authorization decisions atomically', async () => {
    const h = setup();
    let registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      await registry.publish(h.policy, 'human:founder');
      await registry.attach(h.resourceId, h.policy.policy_id, 'human:founder');
      const authorization = new AuthorizationService(registry, (resourceId) => registry.resolve(resourceId), registry);

      expect(await authorization.authorize({
        actor_id: 'human:founder',
        action: 'read_evidence',
        resource_id: h.resourceId,
      })).toBe(true);
      expect(await authorization.authorize({
        actor_id: 'human:other',
        action: 'read_evidence',
        resource_id: h.resourceId,
      })).toBe(false);
      expect(registry.listPolicyAudit()).toHaveLength(2);
      expect(registry.listAuthorizationAudit().map((event) => event.decision)).toEqual(['allow', 'deny']);
      expect(statSync(h.filePath).mode & 0o777).toBe(0o600);

      registry.close();
      registry = new FilePolicyRegistry({ filePath: h.filePath });
      expect(await registry.get(h.policy.policy_id)).toEqual(h.policy);
      expect(await registry.resolve(h.resourceId)).toBe(h.policy.policy_id);
      expect(registry.listPolicyAudit()).toHaveLength(2);
      expect(registry.listAuthorizationAudit()).toHaveLength(2);

      await registry.revoke(h.resourceId, 'human:founder');
      expect(await registry.resolve(h.resourceId)).toBeUndefined();
      expect(registry.listPolicyAudit()).toHaveLength(3);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('rejects policy mutation and unauthorized administration', async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      await expect(registry.publish(h.policy, 'human:attacker')).rejects.toThrow(/human administrator/);
      await registry.publish(h.policy, 'human:founder');
      await expect(registry.publish(h.policy, 'human:founder')).rejects.toThrow(/immutable/);
      await expect(registry.attach(randomUUID(), randomUUID(), 'human:founder')).rejects.toThrow(/unpublished policy/);
      await expect(registry.revoke(h.resourceId, 'human:founder')).rejects.toThrow(/no attached policy/);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('verifies the audit hash chain on reopen and rejects out-of-band edits', async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    await registry.publish(h.policy, 'human:founder');
    registry.close();

    const state = JSON.parse(readFileSync(h.filePath, 'utf8')) as {
      audit_events: Array<{ payload: { actor_id?: string } }>;
    };
    const firstEvent = state.audit_events[0];
    if (!firstEvent) throw new Error('Expected a persisted audit event.');
    firstEvent.payload.actor_id = 'human:tampered';
    writeFileSync(h.filePath, JSON.stringify(state), { mode: 0o600 });
    expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(/hash chain verification failed/);
    rmSync(h.directory, { recursive: true, force: true });
  });

  it('does not delete an existing process lock when a second instance fails to open', () => {
    const h = setup();
    const first = new FilePolicyRegistry({ filePath: h.filePath });
    const lockPath = `${h.filePath}.lock`;
    try {
      expect(existsSync(lockPath)).toBe(true);
      expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(FilePolicyRegistryError);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      first.close();
      expect(existsSync(lockPath)).toBe(false);
      rmSync(h.directory, { recursive: true, force: true });
    }
  });


  it('recovers a stale lock only when its recorded process no longer exists', () => {
    const h = setup();
    mkdirSync(join(h.directory, 'state'), { recursive: true });
    const lockPath = `${h.filePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, created_at: new Date().toISOString() }), { mode: 0o600 });
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
      expect(lock.pid).toBe(process.pid);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('rejects non-absolute paths and invalid state files', () => {
    expect(() => new FilePolicyRegistry({ filePath: 'relative/policies.json' })).toThrow(/absolute file path/);
    const h = setup();
    mkdirSync(join(h.directory, 'state'), { recursive: true });
    writeFileSync(h.filePath, '{not-json', { flag: 'w', mode: 0o600 });
    expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(/invalid JSON/);
    rmSync(h.directory, { recursive: true, force: true });
  });
});