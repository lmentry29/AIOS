#!/usr/bin/env node
/**
 * Sign and verify the gVisor runtime pin and rootfs manifest.
 *
 * The private key is never read from the repository and never printed. CI generates a
 * run-scoped key in $RUNNER_TEMP; a production operator provisions a long-lived key and
 * commits only its public half in tools/security/trust-root.json.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createTrustRoot,
  generateSigningKey,
  keyIdForPublicKey,
  loadTrustRoot,
  signArtifact,
  sourceFromEnvironment,
  verifyArtifactSignature,
} from '../../apps/host/dist/execution/artifact-signing.js';

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function flag(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    if (required) fail(`--${name} is required`);
    return undefined;
  }
  return value;
}

function kind() {
  const value = flag('kind');
  const mapping = { 'runtime-pin': 'gvisor-runtime-pin', 'rootfs-manifest': 'gvisor-rootfs-manifest' };
  if (mapping[value] === undefined) fail('--kind must be runtime-pin or rootfs-manifest');
  return mapping[value];
}

function regularFile(path, label) {
  const resolved = resolve(path);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) fail(`${label} must be a regular file: ${resolved}`);
  return resolved;
}

/** The subject is derived from the artifact bytes, so verification rejects a different artifact. */
function subjectFor(artifactKind, artifactPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    fail(`the ${artifactKind} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (artifactKind === 'gvisor-runtime-pin') {
    const pin = parsed;
    if (typeof pin.release !== 'string' || typeof pin.runsc?.version !== 'string'
      || typeof pin.runsc?.sha256 !== 'string' || typeof pin.artifact?.sha512 !== 'string') {
      fail('the runtime pin is missing release, runsc.version, runsc.sha256 or artifact.sha512');
    }
    return {
      release: pin.release,
      runsc_version: pin.runsc.version,
      runsc_sha256: pin.runsc.sha256,
      artifact_sha512: pin.artifact.sha512,
    };
  }
  if (typeof parsed.rootfs_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.rootfs_sha256)
    || !Number.isSafeInteger(parsed.entries)) {
    fail('the rootfs manifest is missing rootfs_sha256 or entries');
  }
  return { rootfs_sha256: parsed.rootfs_sha256, entries: parsed.entries };
}

function printEvidence(command, verified, artifactPath) {
  process.stdout.write(`${JSON.stringify({
    command,
    artifact: resolve(artifactPath),
    artifact_sha256: verified.artifact_sha256,
    key_id: verified.key_id,
    signed_at: verified.signed_at,
    subject: verified.subject,
    source: verified.source,
  }, null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === 'generate-key') {
    const privatePath = resolve(flag('private'));
    const trustRootPath = resolve(flag('trust-root'));
    const key = generateSigningKey();
    const now = Date.now();
    const trustRoot = createTrustRoot({
      key_id: key.key_id,
      public_key_pem: key.public_key_pem,
      not_before: new Date(now - 60 * 60 * 1000).toISOString(),
      not_after: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeFileSync(privatePath, key.private_key_pem, { mode: 0o600, flag: 'wx' });
    writeFileSync(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ key_id: key.key_id, private_key: privatePath, trust_root: trustRootPath })}\n`);
    return;
  }
  if (command === 'sign') {
    const artifactKind = kind();
    const artifactPath = regularFile(flag('artifact'), 'artifact');
    const keyPath = regularFile(flag('key'), 'private key');
    const trustRootPath = regularFile(flag('trust-root'), 'trust root');
    const out = resolve(flag('out'));
    const trustRoot = loadTrustRoot(trustRootPath);
    const publicKey = generatePublicKey(keyPath);
    const statement = signArtifact({
      artifact_kind: artifactKind,
      artifact_path: artifactPath,
      key_id: publicKey.key_id,
      private_key_pem: readFileSync(keyPath, 'utf8'),
      trust_root: trustRoot,
      subject: subjectFor(artifactKind, artifactPath),
      source: sourceFromEnvironment(),
      ...(flag('signed-at', false) === undefined ? {} : { signed_at: flag('signed-at', false) }),
    });
    writeFileSync(out, `${JSON.stringify(statement, null, 2)}\n`, { mode: 0o444 });
    const verified = verifyArtifactSignature({
      artifact_kind: artifactKind,
      artifact_path: artifactPath,
      signature_path: out,
      trust_root_path: trustRootPath,
      expected_subject: subjectFor(artifactKind, artifactPath),
    });
    printEvidence('sign', verified, artifactPath);
    return;
  }
  if (command === 'verify') {
    const artifactKind = kind();
    const artifactPath = regularFile(flag('artifact'), 'artifact');
    const expectedKeyId = flag('expect-key-id', false);
    const verified = verifyArtifactSignature({
      artifact_kind: artifactKind,
      artifact_path: artifactPath,
      signature_path: regularFile(flag('signature'), 'signature'),
      trust_root_path: regularFile(flag('trust-root'), 'trust root'),
      expected_subject: subjectFor(artifactKind, artifactPath),
      ...(expectedKeyId === undefined ? {} : { expected_key_id: expectedKeyId }),
    });
    printEvidence('verify', verified, artifactPath);
    return;
  }
  if (command === 'verify-all') {
    const trustRootPath = regularFile(flag('trust-root'), 'trust root');
    const expectedKeyId = flag('expect-key-id', false);
    for (const [artifactKind, artifactFlag, signatureFlag] of [
      ['gvisor-runtime-pin', 'pin', 'pin-signature'],
      ['gvisor-rootfs-manifest', 'manifest', 'manifest-signature'],
    ]) {
      const artifactPath = regularFile(flag(artifactFlag), artifactFlag);
      const verified = verifyArtifactSignature({
        artifact_kind: artifactKind,
        artifact_path: artifactPath,
        signature_path: regularFile(flag(signatureFlag), signatureFlag),
        trust_root_path: trustRootPath,
        expected_subject: subjectFor(artifactKind, artifactPath),
        ...(expectedKeyId === undefined ? {} : { expected_key_id: expectedKeyId }),
      });
      printEvidence('verify-all', verified, artifactPath);
    }
    return;
  }
  fail('usage: sign-artifacts.mjs generate-key|sign|verify|verify-all ...');
}

// Derive the key id from the private key's public half without printing the private key.
function generatePublicKey(privateKeyPath) {
  const publicKey = createPublicKey(createPrivateKey(readFileSync(privateKeyPath, 'utf8')));
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { public_key_pem: pem, key_id: keyIdForPublicKey(pem) };
}

main();
