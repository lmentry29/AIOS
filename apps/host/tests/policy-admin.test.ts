import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePolicyRegistry } from '@aios/founder';
import { HostConfigError } from '../src/errors.js';
import {
  provisionPolicies,
  readPolicyProvisioningDocument,
  readPolicyRevocationDocument,
  revokePolicies,
} from '../src/policy-admin.js';
import {
  DECISION_COLLECTION_ID,
  FOUNDER,
  GMAIL_RESOURCE_ID,
  NOTION_RESOURCE_ID,
  VAULT_RESOURCE_ID,
} from './fixtures.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function setup(): { directory: string; configPath: string; policyPath: string; resourceId: string } {
  const directory = mkdtempSync(join(tmpdir(), 'aios-host-admin-'));
  const configPath = join(directory, 'host.json');
  const policyPath = join(directory, 'policy-state.json');
  const resourceId = randomUUID();
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    bind: { host: '127.0.0.1', port: 4780 },
    policy_file: policyPath,
    operational_store: { directory: join(directory, 'operational') },
    decision_collection_id: DECISION_COLLECTION_ID,
    resources: { vault: VAULT_RESOURCE_ID, gmail: GMAIL_RESOURCE_ID, notion: NOTION_RESOURCE_ID },
    bootstrap_principal_id: FOUNDER,
    sessions: [{
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: 'b'.repeat(64),
    }],
  }), { mode: 0o600 });
  return { directory, configPath, policyPath, resourceId };
}

function provisioningDocument(resourceId: string): Record<string, unknown> {
  return {
    policy: {
      policy_id: randomUUID(),
      version: 1,
      rules: [{
        effect: 'allow',
        subject_ids: [FOUNDER],
        actions: ['intake', 'read_status'],
        resource_ids: [resourceId],
      }],
    },
    attach_to: [resourceId],
  };
}

function writeDocument(directory: string, document: unknown, mode = 0o600): string {
  // A fresh name each time: writeFileSync does not re-apply `mode` to an existing file,
  // so reusing one path would silently keep the first document's permissions.
  const path = join(directory, `policy-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(document), { mode });
  return path;
}

function revocationDocument(policyId: string, resourceId: string): Record<string, unknown> {
  return { policy_id: policyId, targets: [resourceId] };
}

describe('offline policy provisioning', () => {
  it('publishes one immutable policy, attaches it, and leaves a verifiable audit chain', async () => {
    const { directory, configPath, policyPath, resourceId } = setup();
    const document = provisioningDocument(resourceId);
    const provisioningPath = writeDocument(directory, document);

    const result = await provisionPolicies({ configPath, provisioningPath });
    expect(result.attached).toEqual([resourceId]);
    expect(result.policy_id).toMatch(UUID);

    const registry = new FilePolicyRegistry({ filePath: policyPath });
    try {
      expect(await registry.resolve(resourceId)).toBe(result.policy_id);
      expect(registry.listPolicyAudit().map((event) => event.operation)).toEqual(['publish', 'attach']);
      expect(registry.listPolicyAudit().every((event) => event.actor_id === FOUNDER)).toBe(true);
      expect(registry.listAuthorizationAudit()).toEqual([]);
    } finally {
      registry.close();
    }
  });

  it('refuses to publish the same policy identifier twice', async () => {
    const { directory, configPath, resourceId } = setup();
    const document = provisioningDocument(resourceId);
    const provisioningPath = writeDocument(directory, document);
    await provisionPolicies({ configPath, provisioningPath });
    await expect(provisionPolicies({ configPath, provisioningPath }))
      .rejects.toThrow(/immutable/);
  });

  it('retires an attached policy through the offline bootstrap path', async () => {
    const { directory, configPath, policyPath, resourceId } = setup();
    const provisioning = provisioningDocument(resourceId);
    await provisionPolicies({
      configPath,
      provisioningPath: writeDocument(directory, provisioning),
    });
    const policyId = (provisioning.policy as { policy_id: string }).policy_id;
    const result = await revokePolicies({
      configPath,
      revocationPath: writeDocument(directory, revocationDocument(policyId, resourceId)),
    });
    expect(result).toEqual({ policy_id: policyId, retired: true, targets: [resourceId] });

    const registry = new FilePolicyRegistry({ filePath: policyPath });
    try {
      expect(await registry.resolve(resourceId)).toBeUndefined();
      expect(registry.listPolicyAudit().map((event) => event.operation))
        .toEqual(['publish', 'attach', 'revoke']);
      expect(await registry.get(policyId)).toBeDefined();
    } finally {
      registry.close();
    }
  });

  it('requires an owner-only revocation document with valid fields', () => {
    const { directory, resourceId } = setup();
    const document = revocationDocument(randomUUID(), resourceId);
    expect(() => readPolicyRevocationDocument(writeDocument(directory, document, 0o644)))
      .toThrow(/owner-only/);
    expect(() => readPolicyRevocationDocument(writeDocument(directory, {
      ...document,
      policy_id: 'not-a-uuid',
    }))).toThrow(/policy_id/);
    expect(() => readPolicyRevocationDocument(writeDocument(directory, {
      ...document,
      targets: [resourceId, resourceId],
    }))).toThrow(/repeat/);
    expect(() => readPolicyRevocationDocument(writeDocument(directory, {
      ...document,
      extra: true,
    }))).toThrow(/unsupported field/);
  });

  it('requires an owner-only provisioning document and valid fields', () => {
    const { directory, resourceId } = setup();
    expect(() => readPolicyProvisioningDocument(writeDocument(directory, provisioningDocument(resourceId), 0o644)))
      .toThrow(/owner-only/);
    expect(() => readPolicyProvisioningDocument(writeDocument(directory, {
      policy: provisioningDocument(resourceId).policy,
      attach_to: [],
    }))).toThrow(/at least one/);
    expect(() => readPolicyProvisioningDocument(writeDocument(directory, {
      policy: provisioningDocument(resourceId).policy,
      attach_to: ['not-a-uuid'],
    }))).toThrow(HostConfigError);
    expect(() => readPolicyProvisioningDocument(writeDocument(directory, {
      policy: provisioningDocument(resourceId).policy,
      attach_to: [resourceId],
      extra: true,
    }))).toThrow(/unsupported field/);
    expect(() => readPolicyProvisioningDocument('relative/policy.json')).toThrow(/absolute/);
  });
});
