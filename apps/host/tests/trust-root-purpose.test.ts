import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTrustRoot,
  generateSigningKey,
  loadTrustRoot,
  signArtifact,
  verifyArtifactSignature,
} from '../src/execution/artifact-signing.js';
import { PolicyProvenanceAuthority } from '../src/policy-provenance.js';

function fixture(purpose: 'artifact' | 'policy' | 'verifier') {
  const directory = mkdtempSync(join(tmpdir(), 'aios-trust-purpose-'));
  const key = generateSigningKey();
  const now = Date.now();
  const root = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: new Date(now - 60_000).toISOString(),
    not_after: new Date(now + 60 * 60 * 1000).toISOString(),
    purpose,
  });
  const rootPath = join(directory, 'trust-root.json');
  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  return { directory, key, root, rootPath };
}

describe('purpose-bound trust roots (ADR-0035)', () => {
  it('writes v2 keys with exactly one purpose and rejects an artifact signature signed by a policy key', () => {
    const { directory, key, rootPath } = fixture('policy');
    const artifactPath = join(directory, 'artifact.json');
    const signaturePath = join(directory, 'artifact.sig.json');
    writeFileSync(artifactPath, '{"release":"test"}\n');
    const statement = signArtifact({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: artifactPath,
      key_id: key.key_id,
      private_key_pem: key.private_key_pem,
      subject: { release: 'test' },
    });
    writeFileSync(signaturePath, `${JSON.stringify(statement)}\n`);

    const loaded = loadTrustRoot(rootPath);
    expect(loaded.schema_version).toBe(2);
    expect(loaded.keys[0]?.purpose).toBe('policy');
    expect(() =>
      verifyArtifactSignature({
        artifact_kind: 'gvisor-runtime-pin',
        artifact_path: artifactPath,
        signature_path: signaturePath,
        trust_root_path: rootPath,
        expected_subject: { release: 'test' },
      }),
    ).toThrow(/artifact-purpose/);
  });

  it('rejects a policy authority composed with an artifact-purpose key', () => {
    const { directory, key, rootPath } = fixture('artifact');
    const privateKeyPath = join(directory, 'policy.pem');
    writeFileSync(privateKeyPath, key.private_key_pem, { mode: 0o600 });
    expect(() =>
      PolicyProvenanceAuthority.fromFiles({
        trust_root_file: rootPath,
        private_key_file: privateKeyPath,
        key_id: key.key_id,
      }),
    ).toThrow(/policy-purpose/);
  });

  it('migrates a legacy v1 root only with an explicit purpose', () => {
    const { directory, key, root } = fixture('policy');
    const legacyPath = join(directory, 'legacy-root.json');
    const {
      key_id,
      algorithm,
      public_key_pem,
      status,
      not_before,
      not_after,
    } = root.keys[0] as (typeof root.keys)[number];
    const legacyKey = {
      key_id,
      algorithm,
      public_key_pem,
      status,
      not_before,
      not_after,
    };
    writeFileSync(
      legacyPath,
      `${JSON.stringify({ schema_version: 1, keys: [legacyKey] }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const loaded = loadTrustRoot(legacyPath, 'policy');
    expect(loaded.schema_version).toBe(2);
    expect(loaded.keys[0]?.purpose).toBe('policy');
    expect(loaded.keys[0]?.key_id).toBe(key.key_id);
  });

  it('rejects a v2 key with no purpose', () => {
    const { directory, root } = fixture('artifact');
    const invalidPath = join(directory, 'invalid-root.json');
    const {
      key_id,
      algorithm,
      public_key_pem,
      status,
      not_before,
      not_after,
    } = root.keys[0] as (typeof root.keys)[number];
    const invalidKey = {
      key_id,
      algorithm,
      public_key_pem,
      status,
      not_before,
      not_after,
    };
    writeFileSync(
      invalidPath,
      `${JSON.stringify({ schema_version: 2, keys: [invalidKey] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(() => loadTrustRoot(invalidPath, 'artifact')).toThrow(/purpose/);
  });
});
