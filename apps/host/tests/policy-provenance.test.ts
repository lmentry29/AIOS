import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationService,
  InMemoryAuthorizationAuditStore,
  PolicyProvenanceDeniedError,
  StaticAccessPolicyStore,
  type AccessPolicy,
  type AuthorizationDecisionAudit,
} from '@aios/founder';
import {
  createTrustRootFromKeys,
  generateSigningKey,
  type TrustRoot,
} from '../src/execution/artifact-signing.js';
import { PolicyProvenanceAuthority } from '../src/policy-provenance.js';
import { createPolicyAuthority } from './policy-provenance-fixture.js';

function policy(): AccessPolicy {
  return {
    policy_id: randomUUID(),
    version: 1,
    rules: [{
      effect: 'allow',
      subject_ids: ['human:founder'],
      actions: ['execute'],
      resource_ids: [randomUUID()],
    }],
  };
}

function decision(): AuthorizationDecisionAudit {
  return {
    request_id: randomUUID(),
    actor_id: 'human:founder',
    action: 'execute',
    resource_id: randomUUID(),
    policy_id: randomUUID(),
    policy_version: 1,
    decision: 'allow',
    reason: 'matching_allow',
    matched_rule_index: 0,
    matched_rule_effect: 'allow',
    timestamp: new Date().toISOString(),
  };
}

function requireProvenance(value: AccessPolicy) {
  const provenance = value.provenance;
  if (!provenance) throw new Error('Test policy has no provenance fixture.');
  return provenance;
}

function requireResource(value: AccessPolicy): string {
  const resource = value.rules[0]?.resource_ids[0];
  if (!resource) throw new Error('Test policy has no resource fixture.');
  return resource;
}

function firstRecord(audit: InMemoryAuthorizationAuditStore): AuthorizationDecisionAudit {
  const record = audit.list()[0];
  if (!record) throw new Error('Expected one authorization audit record.');
  return record;
}

function rewriteRoot(path: string, change: (root: TrustRoot) => TrustRoot): void {
  const root = JSON.parse(readFileSync(path, 'utf8')) as TrustRoot;
  writeFileSync(path, `${JSON.stringify(change(root), null, 2)}\n`, { mode: 0o600 });
}

describe('policy bundle provenance', () => {
  it('verifies a signed bundle and keeps the content digest independent of provenance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-policy-provenance-'));
    const fixture = createPolicyAuthority(directory);
    const unsigned = policy();
    const signed = await fixture.authority.signPolicy(unsigned);
    expect(signed.provenance?.subject).toBe('policy_bundle');
    expect(signed.provenance?.subject_id).toBe(unsigned.policy_id);
    expect(await fixture.authority.verifyPolicy(signed)).toEqual({ valid: true });
    expect((await fixture.authority.verifyPolicy(unsigned)).reason).toBe('missing');
  });

  it('fails a payload mutation after signing for the payload-mismatch reason', async () => {
    const fixture = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-mutation-')));
    const signed = await fixture.authority.signPolicy(policy());
    const tampered: AccessPolicy = {
      ...signed,
      rules: signed.rules.map((rule) => ({ ...rule, effect: 'deny' as const })),
    };
    expect((await fixture.authority.verifyPolicy(tampered)).reason).toBe('payload_mismatch');
  });

  it('rejects signature reuse across bundle ids', async () => {
    const fixture = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-reuse-')));
    const signed = await fixture.authority.signPolicy(policy());
    const moved: AccessPolicy = { ...signed, policy_id: randomUUID() };
    expect((await fixture.authority.verifyPolicy(moved)).reason).toBe('bundle_id_mismatch');
  });

  it('rejects schema-version confusion rather than reinterpreting the payload', async () => {
    const fixture = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-schema-')));
    const signed = await fixture.authority.signPolicy(policy());
    const provenance = { ...requireProvenance(signed), schema_version: 2 };
    expect((await fixture.authority.verifyPolicy({ ...signed, provenance })).reason)
      .toBe('schema_unsupported');
  });

  it('rejects key-id substitution and a valid signature from a different trust root', async () => {
    const fixture = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-key-')));
    const signed = await fixture.authority.signPolicy(policy());
    expect((await fixture.authority.verifyPolicy({
      ...signed,
      provenance: { ...requireProvenance(signed), key_id: '0'.repeat(64) },
    })).reason).toBe('key_unknown');

    const other = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-other-root-')));
    expect((await other.authority.verifyPolicy(signed)).reason).toBe('key_unknown');
    expect((await fixture.authority.verifyPolicy({
      ...signed,
      provenance: { ...requireProvenance(signed), signature: 'not-base64' },
    })).reason).toBe('malformed');
  });

  it('rejects revoked and expired signing keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-policy-lifecycle-'));
    const fixture = createPolicyAuthority(directory);
    const signed = await fixture.authority.signPolicy(policy());

    rewriteRoot(fixture.config.trust_root_file, (root) => ({
      ...root,
      keys: root.keys.map((key) => ({ ...key, status: 'revoked' })),
    }));
    const revoked = PolicyProvenanceAuthority.verificationOnly({
      trust_root_file: fixture.config.trust_root_file,
    });
    expect((await revoked.verifyPolicy(signed)).reason).toBe('key_revoked');

    rewriteRoot(fixture.config.trust_root_file, (root) => ({
      ...root,
      keys: root.keys.map((key) => ({
        ...key,
        status: 'trusted',
        not_after: new Date(Date.now() - 60_000).toISOString(),
      })),
    }));
    const expired = PolicyProvenanceAuthority.verificationOnly({
      trust_root_file: fixture.config.trust_root_file,
    });
    expect((await expired.verifyPolicy(signed)).reason).toBe('key_expired');
  });

  it('keeps old-key decisions verifiable after a replacement key is added', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-policy-rotation-'));
    const first = createPolicyAuthority(directory);
    const firstDecision = await first.authority.signDecision(decision());

    const next = generateSigningKey();
    const nextKeyPath = join(directory, 'next-policy-key.pem');
    writeFileSync(nextKeyPath, next.private_key_pem, { mode: 0o600 });
    const root = JSON.parse(readFileSync(first.config.trust_root_file, 'utf8')) as TrustRoot;
    const combined = createTrustRootFromKeys([
      ...root.keys.map(({ key_id, public_key_pem, not_before, not_after, status }) => ({
        key_id, public_key_pem, not_before, not_after, status,
      })),
      {
        key_id: next.key_id,
        public_key_pem: next.public_key_pem,
        not_before: new Date(Date.now() - 60_000).toISOString(),
        not_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    ]);
    writeFileSync(first.config.trust_root_file, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600 });
    const rotated = PolicyProvenanceAuthority.fromFiles({
      trust_root_file: first.config.trust_root_file,
      private_key_file: nextKeyPath,
      key_id: next.key_id,
    });

    expect(await rotated.verifyDecision(firstDecision)).toEqual({ valid: true });
    const nextPolicy = await rotated.signPolicy(policy());
    expect(await rotated.verifyPolicy(nextPolicy)).toEqual({ valid: true });
  });
});

describe('signed authorization decisions', () => {
  it('signs an allow decision and exposes the verified provenance in the audit record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-policy-decision-'));
    const fixture = createPolicyAuthority(directory);
    const signedPolicy = await fixture.authority.signPolicy(policy());
    const audit = new InMemoryAuthorizationAuditStore();
    const service = new AuthorizationService(
      new StaticAccessPolicyStore([signedPolicy]),
      async () => signedPolicy.policy_id,
      audit,
      fixture.authority,
    );
    const request = {
      actor_id: 'human:founder',
      action: 'execute' as const,
      resource_id: requireResource(signedPolicy),
    };
    expect((await service.authorizeDecision(request)).allowed).toBe(true);
    const record = firstRecord(audit);
    expect(record.provenance?.subject).toBe('authorization_decision');
    expect(await fixture.authority.verifyDecision(record)).toEqual({ valid: true });
    expect((await fixture.authority.verifyDecision({
      ...record,
      reason: 'explicit_deny',
    })).reason).toBe('payload_mismatch');
  });

  it('refuses unsigned and mutated policy content before rule evaluation', async () => {
    const fixture = createPolicyAuthority(mkdtempSync(join(tmpdir(), 'aios-policy-enforce-')));
    const unsigned = policy();
    const audit = new InMemoryAuthorizationAuditStore();
    const service = new AuthorizationService(
      new StaticAccessPolicyStore([unsigned]),
      async () => unsigned.policy_id,
      audit,
      fixture.authority,
    );
    await expect(service.authorizeDecision({
      actor_id: 'human:founder',
      action: 'execute',
      resource_id: requireResource(unsigned),
    })).rejects.toMatchObject({
      name: 'PolicyProvenanceDeniedError',
      reasonCode: 'policy_provenance_missing',
    });

    const signed = await fixture.authority.signPolicy(policy());
    const tampered: AccessPolicy = {
      ...signed,
      rules: signed.rules.map((rule) => ({ ...rule, effect: 'deny' as const })),
    };
    const tamperedService = new AuthorizationService(
      new StaticAccessPolicyStore([tampered]),
      async () => tampered.policy_id,
      new InMemoryAuthorizationAuditStore(),
      fixture.authority,
    );
    await expect(tamperedService.authorizeDecision({
      actor_id: 'human:founder',
      action: 'execute',
      resource_id: requireResource(tampered),
    })).rejects.toBeInstanceOf(PolicyProvenanceDeniedError);
  });
});
