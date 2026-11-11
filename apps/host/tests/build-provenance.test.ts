import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTrustRoot, createTrustRootFromKeys, generateSigningKey } from '../src/execution/artifact-signing.js';
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

  it('rejects the wrong pinned key id and a previous attestation version', () => {
    const { attestation, trustRoot, expected, key } = fixture();
    expect(verifyBuildAttestation({
      attestation,
      trust_root: trustRoot,
      expected: { ...expected, key_id: attestation.signing_key.key_id },
    }).key_id).toBe(attestation.signing_key.key_id);
    const other = generateSigningKey();
    expect(failureCode(() => verifyBuildAttestation({
      attestation,
      trust_root: trustRoot,
      expected: { ...expected, key_id: other.key_id },
    }))).toBe('WRONG_KEY');

    const previous = structuredClone(attestation);
    (previous as unknown as { version: number }).version = 0;
    expect(failureCode(() => verifyBuildAttestation({
      attestation: reSign(previous, key.private_key_pem),
      trust_root: trustRoot,
    }))).toBe('UNSUPPORTED_VERSION');
  });

  it('accepts overlapping rotation, then rejects the retired key after its window', () => {
    const oldKey = generateSigningKey();
    const newKey = generateSigningKey();
    const { attestation, artifacts } = fixture();
    const root = createTrustRootFromKeys([
      {
        key_id: oldKey.key_id,
        public_key_pem: oldKey.public_key_pem,
        not_before: '2020-01-01T00:00:00.000Z',
        not_after: '2026-06-01T00:00:00.000Z',
      },
      {
        key_id: newKey.key_id,
        public_key_pem: newKey.public_key_pem,
        not_before: '2025-01-01T00:00:00.000Z',
        not_after: '2035-01-01T00:00:00.000Z',
      },
    ]);
    const oldAttestation = createBuildAttestation({
      private_key_pem: oldKey.private_key_pem,
      key_id: oldKey.key_id,
      source: attestation.source,
      builder: attestation.builder,
      artifacts,
      created_at: '2026-01-01T00:00:00.000Z',
      attestation_id: 'rotation-old',
    });
    const newAttestation = createBuildAttestation({
      private_key_pem: newKey.private_key_pem,
      key_id: newKey.key_id,
      source: attestation.source,
      builder: attestation.builder,
      artifacts,
      created_at: '2026-07-01T00:00:00.000Z',
      attestation_id: 'rotation-new',
    });
    expect(verifyBuildAttestation({
      attestation: oldAttestation,
      trust_root: root,
      now: new Date('2026-02-01T00:00:00.000Z'),
    }).key_id).toBe(oldKey.key_id);
    expect(failureCode(() => verifyBuildAttestation({
      attestation: oldAttestation,
      trust_root: root,
      now: new Date('2026-07-01T00:00:00.000Z'),
    }))).toBe('KEY_EXPIRED');
    expect(verifyBuildAttestation({
      attestation: newAttestation,
      trust_root: root,
      now: new Date('2026-07-01T00:00:00.000Z'),
    }).key_id).toBe(newKey.key_id);
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

  it('seeded byte mutations never authorize a different build', () => {
    const { attestation, trustRoot, artifacts } = fixture();
    const original = JSON.stringify(attestation);
    let rejected = 0;
    let accepted = 0;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const position = Math.floor((iteration * 2246822519) % original.length);
      const mutated = iteration % 3 === 0
        ? `${original.slice(0, position)}${String.fromCharCode(32 + (iteration % 95))}${original.slice(position + 1)}`
        : iteration % 3 === 1
          ? `${original.slice(0, position)}${original.slice(position + 2)}`
          : `${original.slice(0, position)}${original.slice(position, position + 2)}${original.slice(position)}`;
      try {
        const verified = verifyBuildAttestation({ attestation: mutated, trust_root: trustRoot, actual_artifacts: artifacts });
        accepted += 1;
        expect(verified.source.commit).toBe(COMMIT);
        expect(verified.artifacts).toEqual(attestation.artifacts);
      } catch (error) {
        expect(error).toBeInstanceOf(BuildAttestationError);
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(150);
    expect(accepted + rejected).toBe(200);
  });

  it('rejects symlinked attestation and trust-root inputs', () => {
    const { attestation, trustRoot, artifacts, root } = fixture();
    const attestationPath = join(root, 'real-attestation.json');
    const trustRootPath = join(root, 'real-trust-root.json');
    writeFileSync(attestationPath, JSON.stringify(attestation), { mode: 0o600 });
    writeFileSync(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
    const attestationLink = join(root, 'attestation-link.json');
    const trustRootLink = join(root, 'trust-root-link.json');
    symlinkSync(attestationPath, attestationLink);
    symlinkSync(trustRootPath, trustRootLink);
    const tool = fileURLToPath(new URL('../../../tools/security/build-provenance.mjs', import.meta.url));
    const artifactArgs = artifacts.flatMap((artifact) => ['--artifact', `${artifact.name}=${artifact.path}`]);
    for (const [label, attestationArgument, trustRootArgument] of [
      ['attestation', attestationLink, trustRootPath],
      ['trust root', attestationPath, trustRootLink],
    ] as const) {
      const rejected = spawnSync(process.execPath, [
        tool, 'verify', '--attestation', attestationArgument, '--trust-root', trustRootArgument, ...artifactArgs,
      ], { encoding: 'utf8' });
      expect(rejected.status, label).not.toBe(0);
      expect(JSON.parse(rejected.stdout), label).toMatchObject({ ok: false });
    }
  });

  it('generates and verifies the same local provenance statement offline', () => {
    const { key, trustRoot, artifacts, root } = fixture();
    const keyPath = join(root, 'local-key.pem');
    const trustRootPath = join(root, 'local-trust-root.json');
    const outPath = join(root, 'local-attestation.json');
    writeFileSync(keyPath, key.private_key_pem, { mode: 0o600 });
    writeFileSync(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
    const tool = fileURLToPath(new URL('../../../tools/security/build-provenance.mjs', import.meta.url));
    const artifactArgs = artifacts.flatMap((artifact) => ['--artifact', `${artifact.name}=${artifact.path}`]);
    const generateArgs = [
      'generate', '--local', '--key', keyPath, '--out', outPath,
      '--repository', REPOSITORY, '--commit', COMMIT, '--builder-id', 'local:test-builder',
      '--workflow-ref', 'local:test-workflow', '--ref', 'refs/heads/local', '--run-id', '0',
      '--run-attempt', '1', '--created-at', '2026-01-01T00:00:00.000Z',
      '--attestation-id', 'local-fixture', ...artifactArgs,
    ];
    const generated = spawnSync(process.execPath, [tool, ...generateArgs], { encoding: 'utf8' });
    expect(generated.status).toBe(0);
    const generatedEvidence = JSON.parse(generated.stdout) as { attestation_sha256: string; commit: string };
    expect(generatedEvidence.commit).toBe(COMMIT);
    const persisted = JSON.parse(readFileSync(outPath, 'utf8')) as {
      attestation_id: string;
      builder: { id: string; provider: string };
      source: { commit: string };
    };
    expect(persisted).toMatchObject({
      attestation_id: 'local-fixture',
      builder: { id: 'local:test-builder', provider: 'local' },
      source: { commit: COMMIT },
    });
    const verified = spawnSync(process.execPath, [
      tool, 'verify', '--attestation', outPath, '--trust-root', trustRootPath,
      '--expect-key-id', key.key_id, '--expect-repository', REPOSITORY,
      '--expect-commit', COMMIT, '--expect-builder-id', 'local:test-builder',
      '--expect-workflow-ref', 'local:test-workflow', '--expect-run-id', '0',
      '--expect-run-attempt', '1', ...artifactArgs,
    ], { encoding: 'utf8' });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true, key_id: key.key_id, source: { commit: COMMIT }, builder: { id: 'local:test-builder' },
    });

    const sentinel = JSON.stringify({ sentinel: true });
    writeFileSync(outPath, sentinel);
    const overwrite = spawnSync(process.execPath, [tool, ...generateArgs], { encoding: 'utf8' });
    expect(overwrite.status).not.toBe(0);
    expect(readFileSync(outPath, 'utf8')).toBe(sentinel);
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

