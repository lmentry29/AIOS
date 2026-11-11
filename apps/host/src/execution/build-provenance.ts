import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { resolve } from 'node:path';
import { assertNotSensitivePath, SensitivePathError } from '@aios/founder';
import { FileIntegrityError, readBoundedRegularFile } from '../security/file-integrity.js';
import {
  type TrustRoot,
  keyIdForPublicKey,
  parseStrictJson,
} from './artifact-signing.js';
import { canonicalEvidenceJson } from './evidence-bundle.js';

export const BUILD_ATTESTATION_FORMAT = 'aios-build-provenance' as const;
export const BUILD_ATTESTATION_VERSION = 1 as const;
const MAX_ATTESTATION_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 128;
const MAX_STRING = 2048;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._:-]{1,200}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SIGNATURE_PREFIX = 'aios-build-provenance/signature/v1\n';
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

export type BuildAttestationFailure =
  | 'INVALID_JSON'
  | 'MALFORMED_ATTESTATION'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_KEY'
  | 'KEY_REVOKED'
  | 'KEY_NOT_YET_VALID'
  | 'KEY_EXPIRED'
  | 'WRONG_KEY'
  | 'SIGNATURE'
  | 'ATTESTATION_DIGEST'
  | 'WRONG_REPOSITORY'
  | 'WRONG_COMMIT'
  | 'WRONG_BUILDER'
  | 'WRONG_WORKFLOW'
  | 'WRONG_RUN'
  | 'ARTIFACT_DIGEST'
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_EXTRA'
  | 'REPLAY';

export class BuildAttestationError extends Error {
  constructor(
    readonly code: BuildAttestationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BuildAttestationError';
  }
}

export interface BuildSource {
  repository: string;
  commit: string;
  ref: string;
  event: string;
  workflow_ref: string;
  run_id: string;
  run_attempt: string;
}

export type BuilderProvider = 'github-actions' | 'local';

export interface BuilderIdentity {
  id: string;
  provider: BuilderProvider;
  runner_os: string;
  runner_arch: string;
}

export interface BuildArtifact {
  name: string;
  sha256: string;
  size: number;
}

export interface BuildAttestationKey {
  key_id: string;
  algorithm: 'ed25519';
  public_key_pem: string;
}

export interface BuildAttestationPayload {
  format: typeof BUILD_ATTESTATION_FORMAT;
  version: typeof BUILD_ATTESTATION_VERSION;
  attestation_id: string;
  created_at: string;
  source: BuildSource;
  builder: BuilderIdentity;
  artifacts: BuildArtifact[];
  signing_key: BuildAttestationKey;
}

export interface BuildAttestation extends BuildAttestationPayload {
  attestation_sha256: string;
  signature: string;
}

export interface VerifiedBuildAttestation {
  attestation_id: string;
  attestation_sha256: string;
  key_id: string;
  created_at: string;
  source: BuildSource;
  builder: BuilderIdentity;
  artifacts: BuildArtifact[];
}

export interface ActualBuildArtifact {
  name: string;
  path: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: BuildAttestationFailure, message: string): never {
  throw new BuildAttestationError(code, message);
}

function requireString(value: unknown, label: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('MALFORMED_ATTESTATION', `${label} must be a non-empty bounded string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label, 64);
  if (!ISO.test(text) || Number.isNaN(Date.parse(text))) {
    fail('MALFORMED_ATTESTATION', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('MALFORMED_ATTESTATION', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail('MALFORMED_ATTESTATION', `${label} contains an unknown field "${key}".`);
  }
}

function validateSource(value: unknown): BuildSource {
  if (!isRecord(value)) fail('MALFORMED_ATTESTATION', 'The attestation source must be an object.');
  onlyFields(value, ['repository', 'commit', 'ref', 'event', 'workflow_ref', 'run_id', 'run_attempt'], 'source');
  const repository = requireString(value.repository, 'source.repository', 200);
  if (!REPOSITORY.test(repository)) fail('MALFORMED_ATTESTATION', 'source.repository must be owner/name.');
  const commit = requireString(value.commit, 'source.commit', 40);
  if (!GIT_COMMIT.test(commit)) fail('MALFORMED_ATTESTATION', 'source.commit must be a full 40-character Git commit.');
  const runId = requireString(value.run_id, 'source.run_id', 32);
  const runAttempt = requireString(value.run_attempt, 'source.run_attempt', 16);
  if (!/^[0-9]+$/.test(runId) || !/^[0-9]+$/.test(runAttempt)) {
    fail('MALFORMED_ATTESTATION', 'source run id and attempt must be decimal strings.');
  }
  return {
    repository,
    commit,
    ref: requireString(value.ref, 'source.ref', 512),
    event: requireString(value.event, 'source.event', 120),
    workflow_ref: requireString(value.workflow_ref, 'source.workflow_ref', 512),
    run_id: runId,
    run_attempt: runAttempt,
  };
}

function validateBuilder(value: unknown): BuilderIdentity {
  if (!isRecord(value)) fail('MALFORMED_ATTESTATION', 'The attestation builder must be an object.');
  onlyFields(value, ['id', 'provider', 'runner_os', 'runner_arch'], 'builder');
  if (value.provider !== 'github-actions' && value.provider !== 'local') {
    fail('MALFORMED_ATTESTATION', 'builder.provider must be github-actions or local.');
  }
  return {
    id: requireString(value.id, 'builder.id', 512),
    provider: value.provider,
    runner_os: requireString(value.runner_os, 'builder.runner_os', 64),
    runner_arch: requireString(value.runner_arch, 'builder.runner_arch', 64),
  };
}

function validateArtifacts(value: unknown): BuildArtifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACTS) {
    fail('MALFORMED_ATTESTATION', `The attestation must contain between 1 and ${MAX_ARTIFACTS} artifacts.`);
  }
  const names = new Set<string>();
  const artifacts = value.map((entry, index): BuildArtifact => {
    if (!isRecord(entry)) fail('MALFORMED_ATTESTATION', `artifacts[${index}] must be an object.`);
    onlyFields(entry, ['name', 'sha256', 'size'], `artifacts[${index}]`);
    const name = requireString(entry.name, `artifacts[${index}].name`, 200);
    if (!ARTIFACT_NAME.test(name)) fail('MALFORMED_ATTESTATION', `artifacts[${index}].name is invalid.`);
    if (names.has(name)) fail('MALFORMED_ATTESTATION', `The attestation contains duplicate artifact ${name}.`);
    names.add(name);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      fail('MALFORMED_ATTESTATION', `artifacts[${index}].size is invalid.`);
    }
    return { name, sha256: requireHash(entry.sha256, `artifacts[${index}].sha256`), size: entry.size as number };
  });
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

/** Reads a bounded regular artifact, rejecting symlinks and protected locations. */
export function measureBuildArtifact(name: string, path: string): BuildArtifact {
  if (typeof name !== 'string' || !ARTIFACT_NAME.test(name)) {
    fail('MALFORMED_ATTESTATION', 'Artifact names must be bounded [A-Za-z0-9._:-] identifiers.');
  }
  if (typeof path !== 'string' || path.length === 0) fail('MALFORMED_ATTESTATION', 'Artifact path is required.');
  const resolved = resolve(path);
  try {
    assertNotSensitivePath(name, 'Build artifact name');
    assertNotSensitivePath(resolved, 'Build artifact path');
  } catch (error) {
    if (error instanceof SensitivePathError) {
      fail('MALFORMED_ATTESTATION', `Artifact ${name} points at a protected credential location.`);
    }
    throw error;
  }
  let contents: Buffer;
  try {
    contents = readBoundedRegularFile(resolved, `Artifact ${name}`, MAX_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof FileIntegrityError) {
      if (error.code === 'missing') fail('ARTIFACT_MISSING', `Artifact ${name} does not exist: ${resolved}.`);
      fail('MALFORMED_ATTESTATION', `Artifact ${name} must be a bounded regular file, not a symlink.`);
    }
    throw error;
  }
  return { name, sha256: sha256(contents), size: contents.byteLength };
}

function validateAttestationKey(value: unknown): BuildAttestationKey {
  if (!isRecord(value)) fail('MALFORMED_ATTESTATION', 'The attestation has no signing key.');
  onlyFields(value, ['key_id', 'algorithm', 'public_key_pem'], 'signing_key');
  const keyId = requireString(value.key_id, 'signing_key.key_id', 64);
  if (!SHA256.test(keyId) || value.algorithm !== 'ed25519') {
    fail('MALFORMED_ATTESTATION', 'The attestation signing key is malformed.');
  }
  const publicKeyPem = requireString(value.public_key_pem, 'signing_key.public_key_pem', 4096);
  let derived: string;
  try {
    derived = keyIdForPublicKey(publicKeyPem);
  } catch {
    fail('MALFORMED_ATTESTATION', 'The attestation signing key is not a valid Ed25519 key.');
  }
  if (derived !== keyId) fail('MALFORMED_ATTESTATION', 'The attestation key id does not match its public key.');
  return { key_id: keyId, algorithm: 'ed25519', public_key_pem: publicKeyPem };
}

export function parseBuildAttestation(text: string): BuildAttestation {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ATTESTATION_BYTES) {
    fail('MALFORMED_ATTESTATION', 'The build attestation is not a bounded UTF-8 string.');
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, 'build attestation');
  } catch (error) {
    fail('INVALID_JSON', error instanceof Error ? error.message : 'The build attestation is not strict JSON.');
  }
  if (!isRecord(parsed)) fail('MALFORMED_ATTESTATION', 'The build attestation must be a JSON object.');
  onlyFields(parsed, [
    'format', 'version', 'attestation_id', 'created_at', 'source', 'builder', 'artifacts',
    'signing_key', 'attestation_sha256', 'signature',
  ], 'build attestation');
  if (parsed.format !== BUILD_ATTESTATION_FORMAT) {
    fail('MALFORMED_ATTESTATION', 'The build attestation has an unknown format.');
  }
  if (parsed.version !== BUILD_ATTESTATION_VERSION) {
    fail('UNSUPPORTED_VERSION', `Unsupported build attestation version: ${String(parsed.version)}.`);
  }
  const artifacts = validateArtifacts(parsed.artifacts);
  return {
    format: BUILD_ATTESTATION_FORMAT,
    version: BUILD_ATTESTATION_VERSION,
    attestation_id: requireString(parsed.attestation_id, 'attestation_id', 200),
    created_at: requireTimestamp(parsed.created_at, 'created_at'),
    source: validateSource(parsed.source),
    builder: validateBuilder(parsed.builder),
    artifacts,
    signing_key: validateAttestationKey(parsed.signing_key),
    attestation_sha256: requireHash(parsed.attestation_sha256, 'attestation_sha256'),
    signature: requireString(parsed.signature, 'signature', 88),
  };
}

function validatePortable(value: unknown, depth: number): void {
  if (depth > 64) fail('MALFORMED_ATTESTATION', 'The attestation exceeds the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 1024 * 1024) {
      fail('MALFORMED_ATTESTATION', 'The attestation contains an oversized string.');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('MALFORMED_ATTESTATION', 'The attestation contains a non-finite number.');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validatePortable(item, depth + 1);
    return;
  }
  if (!isRecord(value)) fail('MALFORMED_ATTESTATION', 'The attestation contains a non-plain value.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('MALFORMED_ATTESTATION', 'The attestation contains a non-plain value.');
  }
  for (const [key, nested] of Object.entries(value)) {
    if (DANGEROUS.has(key)) fail('MALFORMED_ATTESTATION', `The attestation contains the forbidden key "${key}".`);
    validatePortable(nested, depth + 1);
  }
}

/** Produces a signed provenance statement over real artifact bytes. */
export function createBuildAttestation(options: {
  private_key_pem: string;
  key_id: string;
  source: BuildSource;
  builder: BuilderIdentity;
  artifacts: ActualBuildArtifact[];
  created_at?: string;
  attestation_id?: string;
}): BuildAttestation {
  const source = validateSource(options.source);
  const builder = validateBuilder(options.builder);
  if (!Array.isArray(options.artifacts) || options.artifacts.length === 0 || options.artifacts.length > MAX_ARTIFACTS) {
    fail('MALFORMED_ATTESTATION', 'At least one artifact is required.');
  }
  const names = new Set<string>();
  for (const artifact of options.artifacts) {
    if (names.has(artifact.name)) fail('MALFORMED_ATTESTATION', `Duplicate artifact name ${artifact.name}.`);
    names.add(artifact.name);
  }
  const privateKey = createPrivateKey(options.private_key_pem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = keyIdForPublicKey(publicKeyPem);
  if (keyId !== options.key_id) fail('UNKNOWN_KEY', 'The signing key id does not match the private key.');
  const payload: BuildAttestationPayload = {
    format: BUILD_ATTESTATION_FORMAT,
    version: BUILD_ATTESTATION_VERSION,
    attestation_id: options.attestation_id ?? randomUUID(),
    created_at: requireTimestamp(options.created_at ?? new Date().toISOString(), 'created_at'),
    source,
    builder,
    artifacts: options.artifacts.map((artifact) => measureBuildArtifact(artifact.name, artifact.path))
      .sort((left, right) => left.name.localeCompare(right.name)),
    signing_key: { key_id: keyId, algorithm: 'ed25519', public_key_pem: publicKeyPem },
  };
  const serialized = canonicalEvidenceJson(payload);
  const signature = cryptoSign(null, Buffer.from(`${SIGNATURE_PREFIX}${serialized}`, 'utf8'), privateKey).toString('base64');
  return { ...payload, attestation_sha256: sha256(serialized), signature };
}

/** Offline fail-closed verification against an external trust root and optional real artifacts. */
export function verifyBuildAttestation(options: {
  attestation: BuildAttestation | string;
  trust_root: TrustRoot;
  now?: Date;
  actual_artifacts?: ActualBuildArtifact[];
  expected?: {
    repository?: string;
    commit?: string;
    /** Pin the signer to one trust-root key instead of accepting any valid trusted key. */
    key_id?: string;
    builder_id?: string;
    workflow_ref?: string;
    run_id?: string;
    run_attempt?: string;
    attestation_id?: string;
  };
}): VerifiedBuildAttestation {
  const attestation = parseBuildAttestation(
    typeof options.attestation === 'string' ? options.attestation : JSON.stringify(options.attestation),
  );
  validatePortable(attestation, 0);
  if (options.trust_root.schema_version !== 1) fail('MALFORMED_ATTESTATION', 'The trust root schema is unsupported.');
  const key = options.trust_root.keys.find((entry) => entry.key_id === attestation.signing_key.key_id);
  if (key === undefined) fail('UNKNOWN_KEY', 'The attestation signing key is absent from the trust root.');
  if (key.status !== 'trusted') fail('KEY_REVOKED', 'The attestation signing key is revoked.');
  if (key.public_key_pem !== attestation.signing_key.public_key_pem) {
    fail('UNKNOWN_KEY', 'The attestation signing key does not match the trust root key material.');
  }
  const now = (options.now ?? new Date()).getTime();
  if (now < Date.parse(key.not_before) || Date.parse(attestation.created_at) < Date.parse(key.not_before)) {
    fail('KEY_NOT_YET_VALID', 'The attestation signing key is not yet valid.');
  }
  if (now > Date.parse(key.not_after) || Date.parse(attestation.created_at) > Date.parse(key.not_after)) {
    fail('KEY_EXPIRED', 'The attestation signing key is outside its validity window.');
  }
  const { attestation_sha256, signature, ...payload } = attestation;
  const serialized = canonicalEvidenceJson(payload);
  if (sha256(serialized) !== attestation_sha256) {
    fail('ATTESTATION_DIGEST', 'The attestation digest does not match its signed content.');
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    fail('SIGNATURE', 'The attestation signature is malformed.');
  }
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) {
    fail('SIGNATURE', 'The attestation signature is not canonical Ed25519.');
  }
  let valid = false;
  try {
    valid = cryptoVerify(
      null,
      Buffer.from(`${SIGNATURE_PREFIX}${serialized}`, 'utf8'),
      createPublicKey(key.public_key_pem),
      signatureBytes,
    );
  } catch {
    fail('SIGNATURE', 'The attestation signature could not be verified.');
  }
  if (!valid) fail('SIGNATURE', 'The attestation signature is invalid.');

  const expected = options.expected ?? {};
  if (expected.key_id !== undefined && expected.key_id !== attestation.signing_key.key_id) {
    fail('WRONG_KEY', 'The attestation signing key does not match the pinned key id.');
  }
  if (expected.repository !== undefined && expected.repository !== attestation.source.repository) {
    fail('WRONG_REPOSITORY', 'The attestation repository does not match the expected repository.');
  }
  if (expected.commit !== undefined && expected.commit !== attestation.source.commit) {
    fail('WRONG_COMMIT', 'The attestation commit does not match the expected commit.');
  }
  if (expected.builder_id !== undefined && expected.builder_id !== attestation.builder.id) {
    fail('WRONG_BUILDER', 'The attestation builder does not match the expected builder identity.');
  }
  if (expected.workflow_ref !== undefined && expected.workflow_ref !== attestation.source.workflow_ref) {
    fail('WRONG_WORKFLOW', 'The attestation workflow does not match the expected CI workflow identity.');
  }
  if (expected.run_id !== undefined && expected.run_id !== attestation.source.run_id) {
    fail('REPLAY', 'The attestation was produced by a different CI run; it is stale or replayed.');
  }
  if (expected.run_attempt !== undefined && expected.run_attempt !== attestation.source.run_attempt) {
    fail('REPLAY', 'The attestation was produced by a different CI attempt; it is stale or replayed.');
  }
  if (expected.attestation_id !== undefined && expected.attestation_id !== attestation.attestation_id) {
    fail('REPLAY', 'The attestation id does not match the expected checkpoint; it is stale or replayed.');
  }

  if (options.actual_artifacts !== undefined) {
    const actual = new Map(options.actual_artifacts.map((artifact) => [artifact.name, artifact.path]));
    for (const artifact of attestation.artifacts) {
      if (!actual.has(artifact.name)) fail('ARTIFACT_MISSING', `Artifact ${artifact.name} is missing from the supplied set.`);
      const measured = measureBuildArtifact(artifact.name, actual.get(artifact.name) as string);
      if (measured.sha256 !== artifact.sha256 || measured.size !== artifact.size) {
        fail('ARTIFACT_DIGEST', `Artifact ${artifact.name} does not match its attested digest or size.`);
      }
    }
    for (const name of actual.keys()) {
      if (!attestation.artifacts.some((artifact) => artifact.name === name)) {
        fail('ARTIFACT_EXTRA', `Artifact ${name} is not covered by the attestation.`);
      }
    }
  }

  return {
    attestation_id: attestation.attestation_id,
    attestation_sha256,
    key_id: attestation.signing_key.key_id,
    created_at: attestation.created_at,
    source: attestation.source,
    builder: attestation.builder,
    artifacts: attestation.artifacts,
  };
}

export function loadBuildAttestation(path: string): BuildAttestation {
  return parseBuildAttestation(
    readBoundedRegularFile(path, 'build attestation', MAX_ATTESTATION_BYTES).toString('utf8'),
  );
}
