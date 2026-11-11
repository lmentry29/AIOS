import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createTrustRoot,
  generateSigningKey,
  signArtifact,
  verifyArtifactSignature,
  type ArtifactKind,
  type SignatureSubject,
  type TrustRoot,
} from '../src/execution/artifact-signing.js';

const temporaryDirectories: string[] = [];
const now = Date.now();

afterEach(() => {
  // Test-owned temporary state only.
  temporaryDirectories.length = 0;
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'aios-signing-test-'));
  temporaryDirectories.push(path);
  return path;
}

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function writeSignedArtifact(options: {
  kind: ArtifactKind;
  artifact: unknown;
  subject: SignatureSubject;
  trustRoot: TrustRoot;
  privateKey?: string;
  keyId?: string;
  signedAt?: string;
  signedSubject?: SignatureSubject;
  window?: { not_before: string; not_after: string };
}): {
  artifactPath: string;
  signaturePath: string;
  trustRootPath: string;
  artifactDigest: string;
  signatureKeyId: string;
} {
  const key = options.privateKey === undefined || options.keyId === undefined
    ? generateSigningKey()
    : { private_key_pem: options.privateKey, key_id: options.keyId };
  const root = options.trustRoot;
  const rootPath = join(directory(), 'trust-root.json');
  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
  const artifactPath = join(directory(), options.kind === 'gvisor-runtime-pin' ? 'pin.json' : 'manifest.json');
  writeFileSync(artifactPath, `${JSON.stringify(options.artifact, null, 2)}\n`);
  const statement = signArtifact({
    artifact_kind: options.kind,
    artifact_path: artifactPath,
    key_id: key.key_id,
    private_key_pem: key.private_key_pem,
    subject: options.signedSubject ?? options.subject,
    signed_at: options.signedAt ?? iso(-60_000),
    ...(options.window === undefined ? {} : { trust_root: root }),
  });
  const signaturePath = `${artifactPath}.sig.json`;
  writeFileSync(signaturePath, `${JSON.stringify(statement, null, 2)}\n`);
  return {
    artifactPath,
    signaturePath,
    trustRootPath: rootPath,
    artifactDigest: statement.artifact_sha256,
    signatureKeyId: key.key_id,
  };
}

const runtimePin = {
  schema_version: 1,
  provider: 'gvisor',
  release: 'test-release',
  architecture: 'x86_64',
  artifact: { url: 'https://example.invalid/gvisor.tar.bz2', sha512: 'a'.repeat(128) },
  runsc: { version: 'release-test', sha256: 'b'.repeat(64) },
};
const runtimeSubject: SignatureSubject = {
  release: 'test-release',
  runsc_version: 'release-test',
  runsc_sha256: 'b'.repeat(64),
  artifact_sha512: 'a'.repeat(128),
};

function trustedRoot(key: ReturnType<typeof generateSigningKey>, overrides: Partial<TrustRoot['keys'][number]> = {}): TrustRoot {
  return createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: iso(-60 * 60 * 1000),
    not_after: iso(60 * 60 * 1000),
    ...overrides,
  });
}

describe('artifact signing', () => {
  it('verifies a correctly signed runtime pin and reports the signed digest and key', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    const verified = verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    });
    expect(verified).toMatchObject({
      key_id: fixture.signatureKeyId,
      artifact_sha256: fixture.artifactDigest,
      subject: runtimeSubject,
    });
    expect(verified.source.repository).toBe(process.env.GITHUB_REPOSITORY ?? null);
  });

  it('verifies a correctly signed rootfs manifest', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const subject = { rootfs_sha256: 'c'.repeat(64), entries: 123 };
    const fixture = writeSignedArtifact({
      kind: 'gvisor-rootfs-manifest',
      artifact: { schema_version: 2, rootfs_sha256: subject.rootfs_sha256, entries: subject.entries },
      subject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    expect(verifyArtifactSignature({
      artifact_kind: 'gvisor-rootfs-manifest',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: subject,
    }).subject).toEqual(subject);
  });

  it('rejects an artifact modified after signing', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    writeFileSync(fixture.artifactPath, `${JSON.stringify({ ...runtimePin, release: 'tampered' })}\n`);
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/not over this artifact/);
  });

  it('rejects a signature moved from another valid artifact', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const first = writeSignedArtifact({
      kind: 'gvisor-rootfs-manifest',
      artifact: { rootfs_sha256: 'd'.repeat(64), entries: 1 },
      subject: { rootfs_sha256: 'd'.repeat(64), entries: 1 },
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    const secondArtifact = join(directory(), 'second.json');
    const secondDigest = 'e'.repeat(64);
    writeFileSync(secondArtifact, `${JSON.stringify({ rootfs_sha256: secondDigest, entries: 2 })}\n`);
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-rootfs-manifest',
      artifact_path: secondArtifact,
      signature_path: first.signaturePath,
      trust_root_path: first.trustRootPath,
      expected_subject: { rootfs_sha256: secondDigest, entries: 2 },
    })).toThrow(/not over this artifact/);
  });

  it('rejects a missing signature statement', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: join(directory(), 'missing.sig.json'),
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/signature statement does not exist/);
  });

  it('rejects malformed signature statements', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    writeFileSync(fixture.signaturePath, '{not-json');
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/not valid JSON/);
  });

  it('rejects a signature from a key that is not in the trust root', () => {
    const signer = generateSigningKey();
    const other = generateSigningKey();
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: trustedRoot(other),
    });
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/not present in the trust root/);
    expect(signer.key_id).not.toBe(other.key_id);
  });

  it('rejects a signature whose key has been revoked', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: trustedRoot(key, { status: 'revoked' }),
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/revoked/);
  });

  it('rejects a signature whose key has expired', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: trustedRoot(key, {
        not_before: iso(-2 * 60 * 60 * 1000),
        not_after: iso(-30 * 60 * 1000),
      }),
      privateKey: key.private_key_pem,
      keyId: key.key_id,
      signedAt: iso(-45 * 60 * 1000),
    });
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/expired/);
  });

  it('rejects a signature whose subject does not match the artifact fields', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      signedSubject: { ...runtimeSubject, runsc_sha256: 'f'.repeat(64) },
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/subject "runsc_sha256" does not match/);
  });

  it('rejects a tampered signature value', () => {
    const key = generateSigningKey();
    const root = trustedRoot(key);
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: root,
      privateKey: key.private_key_pem,
      keyId: key.key_id,
    });
    const statement = JSON.parse(readFileSync(fixture.signaturePath, 'utf8')) as { signature: string };
    const corrupted = Buffer.from(statement.signature, 'base64');
    corrupted[0] ^= 0xff;
    writeFileSync(fixture.signaturePath, `${JSON.stringify({ ...statement, signature: corrupted.toString('base64') })}\n`);
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    })).toThrow(/not valid for key/);
  });

  it('accepts an overlapping rotated key and rejects an empty trust root', () => {
    const oldKey = generateSigningKey();
    const newKey = generateSigningKey();
    const fixture = writeSignedArtifact({
      kind: 'gvisor-runtime-pin',
      artifact: runtimePin,
      subject: runtimeSubject,
      trustRoot: trustedRoot(oldKey),
      privateKey: oldKey.private_key_pem,
      keyId: oldKey.key_id,
    });
    const rotated = trustedRoot(oldKey);
    rotated.keys.push(...trustedRoot(newKey, { not_before: iso(-30 * 60 * 1000) }).keys);
    writeFileSync(fixture.trustRootPath, `${JSON.stringify(rotated, null, 2)}\n`);
    expect(verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: fixture.trustRootPath,
      expected_subject: runtimeSubject,
    }).key_id).toBe(oldKey.key_id);

    const empty = join(directory(), 'empty-trust-root.json');
    writeFileSync(empty, `${JSON.stringify({ schema_version: 1, keys: [] })}\n`);
    expect(() => verifyArtifactSignature({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: fixture.artifactPath,
      signature_path: fixture.signaturePath,
      trust_root_path: empty,
      expected_subject: runtimeSubject,
    })).toThrow(/contains no keys/);
  });

  it('canonicalizes nested objects deterministically', () => {
    expect(canonicalJson({ b: 2, a: { d: [1, { z: true, y: null }], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":2}');
  });
});
