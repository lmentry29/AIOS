#!/usr/bin/env node
/**
 * Generate and verify signed source-to-build provenance.
 *
 * Verification reads only the attestation, an external trust root and the operator-supplied
 * artifact files. It does not open the host store, use the network or trust the environment.
 */
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keyIdForPublicKey, loadTrustRoot } from '../../apps/host/dist/execution/artifact-signing.js';
import {
  BuildAttestationError,
  createBuildAttestation,
  loadBuildAttestation,
  verifyBuildAttestation,
} from '../../apps/host/dist/execution/build-provenance.js';

const EXIT = {
  INVALID_JSON: 2,
  MALFORMED_ATTESTATION: 2,
  UNSUPPORTED_VERSION: 8,
  SIGNATURE: 3,
  ATTESTATION_DIGEST: 5,
  UNKNOWN_KEY: 9,
  KEY_REVOKED: 9,
  KEY_NOT_YET_VALID: 9,
  KEY_EXPIRED: 9,
  TRUST_ROOT: 9,
  WRONG_KEY: 19,
  WRONG_REPOSITORY: 11,
  WRONG_COMMIT: 12,
  WRONG_BUILDER: 13,
  WRONG_WORKFLOW: 14,
  WRONG_RUN: 15,
  ARTIFACT_DIGEST: 16,
  ARTIFACT_MISSING: 17,
  ARTIFACT_EXTRA: 18,
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

function flags(name) {
  const values = [];
  process.argv.forEach((argument, index) => {
    if (argument === `--${name}`) {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`);
      values.push(value);
    }
  });
  return values;
}

function artifactArguments() {
  return flags('artifact').map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) fail('--artifact must be name=path');
    return { name: value.slice(0, separator), path: resolve(value.slice(separator + 1)) };
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) fail(`${name} is required in the environment`);
  return value;
}

function requiredFlag(name) {
  const value = flag(name, false);
  if (value === undefined) fail(`--${name} is required in local mode`);
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(value), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    // link(2) is no-replace: a pre-existing attestation is never overwritten.
    linkSync(temporary, path);
    try {
      unlinkSync(temporary);
    } catch {
      // The complete target exists; leave only an invocation-owned temporary file.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of the invocation-owned temporary file only.
    }
    throw error;
  }
}

function expected() {
  return {
    ...(flag('expect-key-id', false) === undefined ? {} : { key_id: flag('expect-key-id', false) }),
    ...(flag('expect-repository', false) === undefined ? {} : { repository: flag('expect-repository', false) }),
    ...(flag('expect-commit', false) === undefined ? {} : { commit: flag('expect-commit', false) }),
    ...(flag('expect-builder-id', false) === undefined ? {} : { builder_id: flag('expect-builder-id', false) }),
    ...(flag('expect-workflow-ref', false) === undefined ? {} : { workflow_ref: flag('expect-workflow-ref', false) }),
    ...(flag('expect-run-id', false) === undefined ? {} : { run_id: flag('expect-run-id', false) }),
    ...(flag('expect-run-attempt', false) === undefined ? {} : { run_attempt: flag('expect-run-attempt', false) }),
    ...(flag('expect-attestation-id', false) === undefined ? {} : { attestation_id: flag('expect-attestation-id', false) }),
  };
}

function main() {
  const command = process.argv[2];
  if (command === 'generate') {
    const keyPath = resolve(flag('key'));
    const outPath = resolve(flag('out'));
    const artifacts = artifactArguments();
    const local = process.argv.includes('--local');
    if (artifacts.length === 0) fail('at least one --artifact name=path is required');
    const workflowRef = local
      ? flag('workflow-ref', false) ?? 'local:build-provenance'
      : requiredEnvironment('GITHUB_WORKFLOW_REF');
    const privateKeyPem = readFileSync(keyPath, 'utf8');
    const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
    const attestation = createBuildAttestation({
      private_key_pem: privateKeyPem,
      key_id: keyIdForPublicKey(publicKeyPem),
      source: local
        ? {
            repository: requiredFlag('repository'),
            commit: requiredFlag('commit'),
            ref: flag('ref', false) ?? 'refs/heads/local',
            event: flag('event', false) ?? 'local',
            workflow_ref: workflowRef,
            run_id: flag('run-id', false) ?? '0',
            run_attempt: flag('run-attempt', false) ?? '1',
          }
        : {
            repository: requiredEnvironment('GITHUB_REPOSITORY'),
            commit: flag('commit', false) ?? requiredEnvironment('GITHUB_SHA'),
            ref: requiredEnvironment('GITHUB_REF'),
            event: requiredEnvironment('GITHUB_EVENT_NAME'),
            workflow_ref: workflowRef,
            run_id: requiredEnvironment('GITHUB_RUN_ID'),
            run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
          },
      builder: {
        id: flag('builder-id', false) ?? (local ? 'local:build-provenance' : `github-actions:${workflowRef}`),
        provider: local ? 'local' : 'github-actions',
        runner_os: flag('runner-os', false) ?? process.env.RUNNER_OS ?? process.platform,
        runner_arch: flag('runner-arch', false) ?? process.env.RUNNER_ARCH ?? process.arch,
      },
      artifacts,
      ...(flag('created-at', false) === undefined ? {} : { created_at: flag('created-at', false) }),
      ...(flag('attestation-id', false) === undefined ? {} : { attestation_id: flag('attestation-id', false) }),
    });
    writeJsonAtomic(outPath, attestation);
    output({ ok: true, command: 'generate', out: outPath, attestation_id: attestation.attestation_id, attestation_sha256: attestation.attestation_sha256, commit: attestation.source.commit, workflow_ref: attestation.source.workflow_ref, artifacts: attestation.artifacts });
    return;
  }
  if (command === 'verify') {
    const attestationPath = resolve(flag('attestation'));
    const trustRootPath = resolve(flag('trust-root'));
    try {
      const verified = verifyBuildAttestation({
        attestation: loadBuildAttestation(attestationPath),
        trust_root: loadTrustRoot(trustRootPath, 'artifact'),
        ...(flags('artifact').length === 0 ? {} : { actual_artifacts: artifactArguments() }),
        expected: expected(),
      });
      output({ ok: true, command: 'verify', attestation: attestationPath, ...verified });
    } catch (error) {
      if (error instanceof BuildAttestationError) {
        output({ ok: false, command: 'verify', code: error.code, reason: error.message });
        process.exit(EXIT[error.code] ?? 2);
      }
      output({ ok: false, command: 'verify', code: 'TRUST_ROOT', reason: error instanceof Error ? error.message : 'unknown error' });
      process.exit(9);
    }
    return;
  }
  fail('usage: build-provenance.mjs <generate|verify> [flags] (generate --local requires --repository and --commit)');
}

try {
  main();
} catch (error) {
  output({ ok: false, code: error instanceof BuildAttestationError ? error.code : 'ERROR', reason: error instanceof Error ? error.message : 'unknown error' });
  process.exit(error instanceof BuildAttestationError ? (EXIT[error.code] ?? 2) : 2);
}
