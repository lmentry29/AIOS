import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTrustRoot, generateSigningKey } from '../src/execution/artifact-signing.js';
import {
  BuildAttestationError,
  createBuildAttestation,
  verifyBuildAttestation,
  type BuildAttestation,
  type BuildSource,
  type BuilderIdentity,
} from '../src/execution/build-provenance.js';
import { canonicalEvidenceJson } from '../src/execution/evidence-bundle.js';

const REPOSITORY = 'acme/aios';
const COMMIT = 'a'.repeat(40);
const WORKFLOW = `${REPOSITORY}/.github/workflows/security.yml@refs/heads/main`;
const BUILDER = `github-actions:${WORKFLOW}`;

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'aios-build-provenance-'));
}

function fixture() {
  const key = generateSigningKey();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: '2020-01-01T00:00:00.000Z',
    not_after: '2035-01-01T00:00:00.000Z',
  });
  const root = directory();
  const artifactAPath = join(root, 'artifact-a.json');
  const artifactBPath = join(root, 'artifact-b.json');
  writeFileSync(artifactAPath, '{"artifact":"a"}\n', { mode: 0o600 });
  writeFileSync(artifactBPath, '{"artifact":"b"}\n', { mode: 0o600 });
  const source: BuildSource = {
    repository: REPOSITORY,
    commit: COMMIT,
    ref: 'refs/heads/main',
    event: 'pull_request',
    workflow_ref: WORKFLOW,
    run_id: '1234567890',
    run_attempt: '1',
  };
  const builder: BuilderIdentity = {
    id: BUILDER,
    provider: 'github-actions',
    runner_os: 'Linux',
    runner_arch: 'X64',
  };
  const artifacts = [
    { name: 'artifact-a', path: artifactAPath },
    { name: 'artifact-b', path: artifactBPath },
  ];
  const attestation = createBuildAttestation({
    private_key_pem: key.private_key_pem,
    key_id: key.key_id,
    source,
    builder,
    artifacts,
    created_at: '2026-01-01T00:00:00.000Z',
    attestation_id: 'attestation-fixture',
  });
  const expected = {
    repository: REPOSITORY,
    commit: COMMIT,
    builder_id: BUILDER,
    workflow_ref: WORKFLOW,
    run_id: '1234567890',
    run_attempt: '1',
  };
  return { key, trustRoot, root, artifacts, attestation, expected, artifactAPath, artifactBPath };
}

function reSign(attestation: BuildAttestation, privateKeyPem: string): BuildAttestation {
  const { attestation_sha256: _digest, signature: _signature, ...payload } = attestation;
  const serialized = canonicalEvidenceJson(payload);
  const signature = cryptoSign(
    null,
    Buffer.from(`aios-build-provenance/signature/v1\n${serialized}`, 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { ...payload, attestation_sha256: createHash('sha256').update(serialized).digest('hex'), signature };
}

function artifactAt(attestation: BuildAttestation, index: number) {
  const artifact = attestation.artifacts[index];
  if (artifact === undefined) throw new Error(`missing artifact ${index}`);
  return artifact;
}

function failureCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildAttestationError);
    return (error as BuildAttestationError).code;
  }
  throw new Error('expected the build attestation verification to fail');
}

describe('signed build provenance', () => {
  it('accepts an untampered attestation and the real artifact set', () => {
    const { attestation, trustRoot, artifacts, expected } = fixture();
    const verified = verifyBuildAttestation({
      attestation,
      trust_root: trustRoot,
      actual_artifacts: artifacts,
      expected,
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(verified).toMatchObject({
      attestation_id: 'attestation-fixture',
      key_id: attestation.signing_key.key_id,
      source: { repository: REPOSITORY, commit: COMMIT, workflow_ref: WORKFLOW },
      builder: { id: BUILDER, provider: 'github-actions' },
      artifacts: [{ name: 'artifact-a' }, { name: 'artifact-b' }],
    });
  });

  it('rejects forged signatures, unknown schema and duplicate-key JSON', () => {
    const { attestation, trustRoot, key } = fixture();
    const forged = structuredClone(attestation);
    forged.signature = Buffer.alloc(64, 9).toString('base64');
    expect(failureCode(() => verifyBuildAttestation({ attestation: forged, trust_root: trustRoot }))).toBe('SIGNATURE');

    const versioned = structuredClone(attestation);
    (versioned as unknown as { version: number }).version = 2;
    expect(failureCode(() => verifyBuildAttestation({ attestation: reSign(versioned, key.private_key_pem), trust_root: trustRoot }))).toBe('UNSUPPORTED_VERSION');

    const duplicate = JSON.stringify(attestation).replace('{"format":', '{"format":0,"format":');
    expect(failureCode(() => verifyBuildAttestation({ attestation: duplicate, trust_root: trustRoot }))).toBe('INVALID_JSON');
  });

  it('rejects absent, revoked, not-yet-valid and expired keys', () => {
    const { attestation, trustRoot } = fixture();
    const other = generateSigningKey();
    const absentRoot = createTrustRoot({
      key_id: other.key_id,
      public_key_pem: other.public_key_pem,
      not_before: '2020-01-01T00:00:00.000Z',
      not_after: '2035-01-01T00:00:00.000Z',
    });
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: absentRoot }))).toBe('UNKNOWN_KEY');

    const revoked = { ...trustRoot, keys: trustRoot.keys.map((key) => ({ ...key, status: 'revoked' as const })) };
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: revoked }))).toBe('KEY_REVOKED');

    const future = { ...trustRoot, keys: trustRoot.keys.map((key) => ({ ...key, not_before: '2030-01-01T00:00:00.000Z', not_after: '2035-01-01T00:00:00.000Z' })) };
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: future, now: new Date('2026-02-01T00:00:00.000Z') }))).toBe('KEY_NOT_YET_VALID');

    const expired = { ...trustRoot, keys: trustRoot.keys.map((key) => ({ ...key, not_before: '2019-01-01T00:00:00.000Z', not_after: '2020-01-01T00:00:00.000Z' })) };
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: expired, now: new Date('2026-02-01T00:00:00.000Z') }))).toBe('KEY_EXPIRED');
  });

  it('rejects wrong repository, commit, builder and workflow identities', () => {
    const { attestation, trustRoot, expected } = fixture();
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, repository: 'other/repo' } }))).toBe('WRONG_REPOSITORY');
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, commit: 'b'.repeat(40) } }))).toBe('WRONG_COMMIT');
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, builder_id: 'github-actions:other' } }))).toBe('WRONG_BUILDER');
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, workflow_ref: 'other/workflow@main' } }))).toBe('WRONG_WORKFLOW');
  });

  it('rejects a stale or replayed build checkpoint', () => {
    const { attestation, trustRoot, expected } = fixture();
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, run_id: '9999999999' } }))).toBe('REPLAY');
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, run_attempt: '2' } }))).toBe('REPLAY');
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, expected: { ...expected, attestation_id: 'other' } }))).toBe('REPLAY');
  });

  it('rejects artifact digest mismatch, missing and extra artifacts', () => {
    const { attestation, trustRoot, artifacts, artifactAPath, key } = fixture();
    expect(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, actual_artifacts: artifacts })).not.toThrow();

    const tampered = structuredClone(attestation);
    artifactAt(tampered, 0).sha256 = 'c'.repeat(64);
    expect(failureCode(() => verifyBuildAttestation({ attestation: reSign(tampered, key.private_key_pem), trust_root: trustRoot, actual_artifacts: artifacts }))).toBe('ARTIFACT_DIGEST');

    writeFileSync(artifactAPath, 'altered\n', { mode: 0o600 });
    expect(failureCode(() => verifyBuildAttestation({ attestation, trust_root: trustRoot, actual_artifacts: artifacts }))).toBe('ARTIFACT_DIGEST');

    const missing = fixture();
    expect(failureCode(() => verifyBuildAttestation({
      attestation: missing.attestation,
      trust_root: missing.trustRoot,
      actual_artifacts: missing.artifacts.filter((_artifact, index) => index === 0),
    }))).toBe('ARTIFACT_MISSING');
  });

  it('rejects a spliced build and extra artifacts', () => {
    const { attestation, trustRoot, artifacts, key } = fixture();
    const spliced = structuredClone(attestation);
    spliced.source.commit = 'b'.repeat(40);
    expect(failureCode(() => verifyBuildAttestation({
      attestation: reSign(spliced, key.private_key_pem),
      trust_root: trustRoot,
      expected: { repository: REPOSITORY, commit: COMMIT },
    }))).toBe('WRONG_COMMIT');

    const extraPath = join(directory(), 'artifact-c.json');
    writeFileSync(extraPath, 'extra\n', { mode: 0o600 });
    expect(failureCode(() => verifyBuildAttestation({
      attestation,
      trust_root: trustRoot,
      actual_artifacts: [...artifacts, { name: 'artifact-c', path: extraPath }],
    }))).toBe('ARTIFACT_EXTRA');
  });

  it('accepts in a separate process and rejects a forged attestation', () => {
    const { attestation, trustRoot, artifacts, expected, root } = fixture();
    const attestationPath = join(root, 'attestation.json');
    const trustRootPath = join(root, 'trust-root.json');
    writeFileSync(attestationPath, JSON.stringify(attestation), { mode: 0o600 });
    writeFileSync(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
    const tool = fileURLToPath(new URL('../../../tools/security/build-provenance.mjs', import.meta.url));
    const artifactArgs = artifacts.flatMap((artifact) => ['--artifact', `${artifact.name}=${artifact.path}`]);
    const accepted = spawnSync(process.execPath, [
      tool, 'verify', '--attestation', attestationPath, '--trust-root', trustRootPath,
      '--expect-repository', expected.repository, '--expect-commit', expected.commit,
      '--expect-builder-id', expected.builder_id, '--expect-workflow-ref', expected.workflow_ref,
      '--expect-run-id', expected.run_id, '--expect-run-attempt', expected.run_attempt,
      ...artifactArgs,
    ], { encoding: 'utf8' });
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, command: 'verify', source: { commit: COMMIT } });

    const forged = structuredClone(attestation);
    forged.signature = Buffer.alloc(64, 1).toString('base64');
    const forgedPath = join(root, 'forged.json');
    writeFileSync(forgedPath, JSON.stringify(forged), { mode: 0o600 });
    const rejected = spawnSync(process.execPath, [
      tool, 'verify', '--attestation', forgedPath, '--trust-root', trustRootPath, ...artifactArgs,
    ], { encoding: 'utf8' });
    expect(rejected.status).toBe(3);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, code: 'SIGNATURE' });
  });
});

