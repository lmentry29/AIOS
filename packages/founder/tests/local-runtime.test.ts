import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PolicyAdministrationService,
  createLocalEvidenceRuntime,
} from '../src/index.js';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aios-local-runtime-'));
  return {
    directory,
    policyFilePath: join(directory, 'state', 'policies.json'),
    vaultResourceId: randomUUID(),
    gmailResourceId: randomUUID(),
    notionResourceId: randomUUID(),
  };
}

describe('createLocalEvidenceRuntime', () => {
  it('composes default-deny authorization without silently attaching resource policies', async () => {
    const h = setup();
    const runtime = createLocalEvidenceRuntime({
      policyFilePath: h.policyFilePath,
      vaultResourceId: h.vaultResourceId,
      gmailResourceId: h.gmailResourceId,
      notionResourceId: h.notionResourceId,
      obsidianPassword: 'local-secret-value-that-is-longer-than-32-bytes',
      fetch: async () => new Response('{}'),
    });
    try {
      expect(await runtime.authorization.authorize({
        actor_id: 'human:founder',
        action: 'read_evidence',
        resource_id: h.vaultResourceId,
      })).toBe(false);
      expect(runtime.policies.listAuthorizationAudit()).toHaveLength(1);

      const admin = new PolicyAdministrationService('human:founder', runtime.policies, runtime.policies);
      const policy = {
        policy_id: randomUUID(),
        version: 1,
        rules: [{
          effect: 'allow' as const,
          subject_ids: ['human:founder'],
          actions: ['read_evidence' as const],
          resource_ids: [h.vaultResourceId],
        }],
      };
      await admin.publish(policy, 'human:founder');
      await admin.attach(h.vaultResourceId, policy.policy_id, 'human:founder');

      expect(await runtime.authorization.authorize({
        actor_id: 'human:founder',
        action: 'read_evidence',
        resource_id: h.vaultResourceId,
      })).toBe(true);
      expect(await runtime.authorization.authorize({
        actor_id: 'human:founder',
        action: 'read_evidence',
        resource_id: h.gmailResourceId,
      })).toBe(false);
      expect(await runtime.policies.resolve(h.gmailResourceId)).toBeUndefined();
    } finally {
      runtime.close();
      expect(existsSync(`${h.policyFilePath}.lock`)).toBe(false);
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('rejects resource aliasing before opening the durable policy file', () => {
    const h = setup();
    expect(() => createLocalEvidenceRuntime({
      policyFilePath: h.policyFilePath,
      vaultResourceId: h.vaultResourceId,
      gmailResourceId: h.vaultResourceId,
      notionResourceId: h.notionResourceId,
      obsidianPassword: 'local-secret-value-that-is-longer-than-32-bytes',
    })).toThrow(/three distinct resource UUIDs/);
    expect(existsSync(join(h.directory, 'state'))).toBe(false);
    rmSync(h.directory, { recursive: true, force: true });
  });

  it('releases the policy lock when a local source configuration is invalid', () => {
    const h = setup();
    expect(() => createLocalEvidenceRuntime({
      policyFilePath: h.policyFilePath,
      vaultResourceId: h.vaultResourceId,
      gmailResourceId: h.gmailResourceId,
      notionResourceId: h.notionResourceId,
      obsidianBaseUrl: 'http://example.com:4444',
      obsidianPassword: 'local-secret-value-that-is-longer-than-32-bytes',
    })).toThrow(/loopback URL/);
    expect(existsSync(`${h.policyFilePath}.lock`)).toBe(false);
    rmSync(h.directory, { recursive: true, force: true });
  });
});