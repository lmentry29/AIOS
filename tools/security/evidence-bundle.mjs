#!/usr/bin/env node
/**
 * Offline evidence-bundle export and verification.
 *
 * `verify` reads only the bundle and an operator-supplied trust root. It does not open the
 * host store, use the network, or consult any mutable process state.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTrustRoot,
  generateSigningKey,
  keyIdForPublicKey,
  loadTrustRoot,
} from '../../apps/host/dist/execution/artifact-signing.js';
import {
  EvidenceBundleError,
  exportEvidenceBundle,
  loadEvidenceBundle,
  verifyEvidenceBundle,
  writeEvidenceBundle,
} from '../../apps/host/dist/execution/evidence-bundle.js';
import { DurableOperationalStore } from '../../apps/host/dist/persistence/operational-store.js';

const EXIT_CODES = {
  INVALID_JSON: 2,
  MALFORMED_BUNDLE: 2,
  UNSUPPORTED_VERSION: 8,
  SIGNATURE: 3,
  BUNDLE_DIGEST: 5,
  CHAIN: 4,
  TASK_BINDING: 6,
  EXECUTION_CHAIN: 7,
  UNKNOWN_KEY: 9,
  KEY_REVOKED: 9,
  KEY_NOT_YET_VALID: 9,
  KEY_EXPIRED: 9,
  REPLAY: 10,
};

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
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

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === 'keygen') {
    const key = generateSigningKey();
    output({
      key_id: key.key_id,
      public_key_pem: key.public_key_pem,
      private_key_pem: key.private_key_pem,
      warning: 'Store the private key out-of-band with owner-only permissions; commit only the public key.',
    });
    return;
  }
  if (command === 'trust-root') {
    const keyPath = resolve(flag('public-key'));
    const publicKeyPem = readFileSync(keyPath, 'utf8');
    output(createTrustRoot({
      key_id: keyIdForPublicKey(publicKeyPem),
      public_key_pem: publicKeyPem,
      not_before: flag('not-before'),
      not_after: flag('not-after'),
      purpose: 'artifact',
    }));
    return;
  }
  if (command === 'export') {
    const storeDirectory = resolve(flag('store'));
    const keyPath = resolve(flag('key'));
    const outPath = resolve(flag('out'));
    const keyId = flag('key-id', false) ?? keyIdForPublicKey(
      createPublicKey(createPrivateKey(readFileSync(keyPath, 'utf8')))
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    );
    const store = new DurableOperationalStore({ directory: storeDirectory });
    try {
      const bundle = exportEvidenceBundle({
        store,
        private_key_pem: readFileSync(keyPath, 'utf8'),
        key_id: keyId,
      });
      writeEvidenceBundle(outPath, bundle);
      output({ ok: true, command: 'export', out: outPath, bundle_id: bundle.header.bundle_id, bundle_sha256: bundle.bundle_sha256, head_hash: bundle.header.source.head_hash });
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'verify') {
    const bundlePath = resolve(flag('bundle'));
    const trustRootPath = resolve(flag('trust-root'));
    const expectedHead = flag('expect-head', false);
    try {
      const verified = verifyEvidenceBundle({
        bundle: loadEvidenceBundle(bundlePath),
        trust_root: loadTrustRoot(trustRootPath, 'artifact'),
        ...(expectedHead === undefined ? {} : { expected_head_hash: expectedHead }),
      });
      output({ ok: true, command: 'verify', bundle: bundlePath, ...verified });
    } catch (error) {
      if (error instanceof EvidenceBundleError) {
        output({ ok: false, command: 'verify', code: error.code, reason: error.message });
        process.exit(EXIT_CODES[error.code] ?? 2);
      }
      output({ ok: false, command: 'verify', code: 'TRUST_ROOT', reason: error instanceof Error ? error.message : 'unknown error' });
      process.exit(9);
    }
    return;
  }
  fail('usage: evidence-bundle.mjs <export|verify|keygen|trust-root> [flags]');
}

try {
  main();
} catch (error) {
  output({ ok: false, code: error instanceof EvidenceBundleError ? error.code : 'ERROR', reason: error instanceof Error ? error.message : 'unknown error' });
  process.exit(error instanceof EvidenceBundleError ? (EXIT_CODES[error.code] ?? 2) : 2);
}
