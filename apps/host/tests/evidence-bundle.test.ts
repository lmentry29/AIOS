import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArtifactEntity as ArtifactSchema } from '@aios/core';
import { createTrustRoot, generateSigningKey } from '../src/execution/artifact-signing.js';
import {
  canonicalEvidenceJson,
  EvidenceBundleError,
  exportEvidenceBundle,
  parseEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '../src/execution/evidence-bundle.js';
import { DurableOperationalStore } from '../src/persistence/operational-store.js';
import { AGENT_ID, makeTask } from './fixtures.js';

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `aios-${prefix}-`));
}

function setup() {
  const key = generateSigningKey();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: '2020-01-01T00:00:00.000Z',
    not_after: '2035-01-01T00:00:00.000Z',
  });
  const store = new DurableOperationalStore({ directory: directory('bundle') });
  const task = makeTask({ name: 'evidence bundle Task' });
  store.tasks.createTask(task);
  store.tasks.transitionLifecycle(task.entity_id, 'validated', AGENT_ID);
  store.tasks.transitionLifecycle(task.entity_id, 'active', AGENT_ID);
  const execution = store.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
  store.executions.complete(execution.execution_id, ['exit_code:0']);
  const now = new Date().toISOString();
  const artifact = store.artifacts.create(ArtifactSchema.parse({
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'artifact',
    artifact_kind: 'test_report',
    name: 'Execution evidence',
    description: JSON.stringify({
      task_id: task.entity_id,
      agent_ids: [AGENT_ID],
      summary: 'verified',
      evidence: ['executor:agent'],
      verifier_id: 'verifier:test',
      verifier_accepted: true,
      verifier_reason: 'the independent verifier accepted the result',
      verifier_evidence: ['verified:true'],
      recorded_at: now,
    }),
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: AGENT_ID,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: AGENT_ID,
    owner_type: 'agent',
    relationships: [],
  }));
  store.artifacts.transitionLifecycle(artifact.entity_id, 'validated', AGENT_ID);
  store.artifacts.transitionLifecycle(artifact.entity_id, 'active', AGENT_ID);
  store.artifacts.transitionLifecycle(artifact.entity_id, 'completed', AGENT_ID);
  store.tasks.updateTask(task.entity_id, { audit_trail_ref: artifact.entity_id });
  store.tasks.transitionLifecycle(task.entity_id, 'completed', AGENT_ID);
  const bundle = exportEvidenceBundle({
    store,
    private_key_pem: key.private_key_pem,
    key_id: key.key_id,
    exported_at: '2026-01-01T00:00:00.000Z',
    bundle_id: randomUUID(),
  });
  return { key, trustRoot, store, task, artifact, bundle };
}

/** Recomputes the public digest and signs a deliberately tampered payload. */
function reSign(payload: EvidenceBundle, privateKeyPem: string): EvidenceBundle {
  const { bundle_sha256: _digest, signature: _signature, ...body } = payload;
  const serialized = canonicalEvidenceJson(body);
  const signature = cryptoSign(
    null,
    Buffer.from(`aios-evidence-bundle/signature/v1\n${serialized}`, 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { ...body, bundle_sha256: createHash('sha256').update(serialized).digest('hex'), signature };
}

function entryAt(bundle: EvidenceBundle, index: number) {
  const entry = bundle.entries[index];
  if (entry === undefined) throw new Error(`missing evidence bundle entry ${index}`);
  return entry;
}

function artifactAt(bundle: EvidenceBundle, index: number) {
  const artifact = bundle.artifacts[index];
  if (artifact === undefined) throw new Error(`missing evidence artifact ${index}`);
  return artifact;
}

function currentHead(store: DurableOperationalStore): string {
  const record = store.journal.read().at(-1);
  if (record === undefined) throw new Error('journal has no head');
  return record.hash;
}

function failureCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceBundleError);
    return (error as EvidenceBundleError).code;
  }
  throw new Error('expected the evidence bundle verification to fail');
}

describe('offline evidence bundles', () => {
  it('accepts an untampered bundle and round-trips through portable JSON', () => {
    const { bundle, trustRoot } = setup();
    const verified = verifyEvidenceBundle({ bundle, trust_root: trustRoot, now: new Date('2026-02-01T00:00:00.000Z') });
    expect(verified).toMatchObject({
      bundle_id: bundle.header.bundle_id,
      head_hash: bundle.entries.at(-1)?.hash,
      key_id: bundle.header.signing_key.key_id,
      task_count: 1,
      artifact_count: 1,
      execution_count: 1,
    });
    expect(() => parseEvidenceBundle(JSON.stringify(bundle))).not.toThrow();
    expect(verifyEvidenceBundle({ bundle: JSON.stringify(bundle), trust_root: trustRoot }).head_hash).toBe(verified.head_hash);
  });

  it('rejects an edited entry for a broken journal chain', () => {
    const { bundle, trustRoot, key } = setup();
    const tampered = structuredClone(bundle);
    entryAt(tampered, 0).kind = 'tampered';
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('CHAIN');
  });

  it('rejects a deleted middle entry for a chain gap', () => {
    const { bundle, trustRoot, key } = setup();
    const tampered = structuredClone(bundle);
    tampered.entries.splice(1, 1);
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('CHAIN');
  });

  it('rejects reordered entries for a sequence or predecessor break', () => {
    const { bundle, trustRoot, key } = setup();
    const tampered = structuredClone(bundle);
    const first = entryAt(tampered, 0);
    tampered.entries[0] = entryAt(tampered, 1);
    tampered.entries[1] = first;
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('CHAIN');
  });

  it('rejects a truncated tail for a source head mismatch', () => {
    const { bundle, trustRoot, key } = setup();
    const tampered = structuredClone(bundle);
    tampered.entries.pop();
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('CHAIN');
  });

  it('rejects a bundle spliced from a different Task', () => {
    const { bundle, trustRoot, key } = setup();
    const other = setup();
    const tampered = structuredClone(bundle);
    tampered.entries = structuredClone(other.bundle.entries);
    tampered.header.source = structuredClone(other.bundle.header.source);
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('TASK_BINDING');
  });

  it('rejects a forged signature', () => {
    const { bundle, trustRoot } = setup();
    const tampered = structuredClone(bundle);
    tampered.signature = Buffer.alloc(64, 7).toString('base64');
    expect(failureCode(() => verifyEvidenceBundle({ bundle: tampered, trust_root: trustRoot }))).toBe('SIGNATURE');
  });

  it('rejects post-signature content edits for a digest mismatch', () => {
    const { bundle, trustRoot } = setup();
    const tampered = structuredClone(bundle);
    entryAt(tampered, 0).payload = { altered: true };
    expect(failureCode(() => verifyEvidenceBundle({ bundle: tampered, trust_root: trustRoot }))).toBe('BUNDLE_DIGEST');
  });

  it('rejects duplicate keys', () => {
    const { bundle, trustRoot } = setup();
    const duplicate = JSON.stringify(bundle).replace('{"header":', '{"header":{"duplicate":1}, "header":');
    expect(failureCode(() => verifyEvidenceBundle({ bundle: duplicate, trust_root: trustRoot }))).toBe('INVALID_JSON');
  });

  it('rejects an unknown schema version', () => {
    const { bundle, trustRoot, key } = setup();
    const tampered = structuredClone(bundle);
    (tampered.header as unknown as { version: number }).version = 2;
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(tampered, key.private_key_pem), trust_root: trustRoot }))).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects absent, revoked and expired keys', () => {
    const { bundle, trustRoot } = setup();
    const absent = generateSigningKey();
    const absentRoot = createTrustRoot({
      key_id: absent.key_id,
      public_key_pem: absent.public_key_pem,
      not_before: '2020-01-01T00:00:00.000Z',
      not_after: '2035-01-01T00:00:00.000Z',
    });
    expect(failureCode(() => verifyEvidenceBundle({ bundle, trust_root: absentRoot }))).toBe('UNKNOWN_KEY');

    const revokedRoot = { ...trustRoot, keys: trustRoot.keys.map((key) => ({ ...key, status: 'revoked' as const })) };
    expect(failureCode(() => verifyEvidenceBundle({ bundle, trust_root: revokedRoot }))).toBe('KEY_REVOKED');

    const expiredRoot = {
      ...trustRoot,
      keys: trustRoot.keys.map((key) => ({ ...key, not_before: '2019-01-01T00:00:00.000Z', not_after: '2020-01-01T00:00:00.000Z' })),
    };
    expect(failureCode(() => verifyEvidenceBundle({ bundle, trust_root: expiredRoot }))).toBe('KEY_EXPIRED');
  });

  it('rejects a replayed stale bundle under a rotated key and a trusted checkpoint', () => {
    const { bundle, store, key } = setup();
    const rotated = generateSigningKey();
    const rotatedRoot = createTrustRoot({
      key_id: rotated.key_id,
      public_key_pem: rotated.public_key_pem,
      not_before: '2020-01-01T00:00:00.000Z',
      not_after: '2035-01-01T00:00:00.000Z',
    });
    store.journal.append('test_marker', { advanced: true });
    const advancedHead = currentHead(store);
    const tampered = structuredClone(bundle);
    tampered.header.signing_key = { key_id: rotated.key_id, algorithm: 'ed25519', public_key_pem: rotated.public_key_pem };
    const replayed = reSign(tampered, rotated.private_key_pem);
    // The rotated key is trusted, but the bundle is not anchored to the current head.
    expect(failureCode(() => verifyEvidenceBundle({
      bundle: replayed,
      trust_root: rotatedRoot,
      expected_head_hash: advancedHead,
    }))).toBe('REPLAY');
    // The same historical bundle remains independently verifiable without a checkpoint.
    expect(verifyEvidenceBundle({ bundle: replayed, trust_root: rotatedRoot }).head_hash).not.toBe(advancedHead);
    expect(key.key_id).not.toBe(rotated.key_id);
  });

  it('rejects a forged accepted decision and a missing execution', () => {
    const { bundle, trustRoot, key } = setup();
    const forged = structuredClone(bundle);
    artifactAt(forged, 0).verifier_accepted = false;
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(forged, key.private_key_pem), trust_root: trustRoot }))).toBe('TASK_BINDING');

    const noExecution = structuredClone(bundle);
    noExecution.executions = [];
    expect(failureCode(() => verifyEvidenceBundle({ bundle: reSign(noExecution, key.private_key_pem), trust_root: trustRoot }))).toBe('EXECUTION_CHAIN');
  });

  it('keeps a historical bundle valid after the live ledger is mutated, and rejects it with the new checkpoint', () => {
    const { bundle, trustRoot, store } = setup();
    store.journal.append('test_marker', { mutated: true });
    expect(verifyEvidenceBundle({ bundle, trust_root: trustRoot }).head_hash).toBe(bundle.header.source.head_hash);
    expect(failureCode(() => verifyEvidenceBundle({
      bundle,
      trust_root: trustRoot,
      expected_head_hash: currentHead(store),
    }))).toBe('REPLAY');
  });

  it('accepts a bundle in a separate process and rejects a tampered one with the documented exit code', () => {
    const { bundle, trustRoot } = setup();
    const directory = mkdtempSync(join(tmpdir(), 'aios-bundle-cli-'));
    const bundlePath = join(directory, 'bundle.json');
    const tamperedPath = join(directory, 'bundle-tampered.json');
    const trustRootPath = join(directory, 'trust-root.json');
    writeFileSync(bundlePath, JSON.stringify(bundle), { mode: 0o600 });
    writeFileSync(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
    const tampered = structuredClone(bundle);
    entryAt(tampered, 0).payload = { altered: true };
    writeFileSync(tamperedPath, JSON.stringify(tampered), { mode: 0o600 });
    const tool = fileURLToPath(new URL('../../../tools/security/evidence-bundle.mjs', import.meta.url));
    const accepted = spawnSync(process.execPath, [tool, 'verify', '--bundle', bundlePath, '--trust-root', trustRootPath, '--expect-head', bundle.header.source.head_hash], { encoding: 'utf8' });
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, command: 'verify', head_hash: bundle.header.source.head_hash });
    const rejected = spawnSync(process.execPath, [tool, 'verify', '--bundle', tamperedPath, '--trust-root', trustRootPath], { encoding: 'utf8' });
    expect(rejected.status).toBe(5);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, code: 'BUNDLE_DIGEST' });
  });
});
