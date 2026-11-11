import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashFile } from './provenance.js';

/**
 * Detached-signature trust chain for gVisor provenance artifacts.
 *
 * The artifact (runtime pin document or rootfs manifest) is hashed byte-for-byte; a detached
 * Ed25519 statement signs that digest, the artifact kind, the signer key id, the signing time,
 * a normalized subject (the security-relevant fields of the artifact) and the CI source
 * metadata. Consumers must load the trust root from a repository-controlled path and verify
 * the statement before the artifact is parsed or used.
 *
 * Nothing here fetches a key or a trust root at run time, and a public key supplied next to
 * the artifact is never trusted. Sigstore keyless signing was evaluated and is deliberately
 * not used as the primary path: verification would depend on Fulcio/Rekor availability and
 * network access, whereas this offline path works for air-gapped hosts and keeps the trust
 * anchor in the repository. The trade-off is that CI identity is metadata, not a certificate;
 * see docs/security/artifact-signing.md.
 */

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

export type ArtifactKind = 'gvisor-runtime-pin' | 'gvisor-rootfs-manifest';
export type KeyStatus = 'trusted' | 'revoked';

export interface TrustedKey {
  key_id: string;
  algorithm: 'ed25519';
  public_key_pem: string;
  status: KeyStatus;
  not_before: string;
  not_after: string;
}

export interface TrustRoot {
  schema_version: 1;
  keys: TrustedKey[];
}

export interface SignatureSource {
  repository: string | null;
  commit: string | null;
  workflow: string | null;
  run_id: string | null;
}

export type SignatureSubject = Record<string, string | number>;

export interface SignedStatement {
  schema_version: 1;
  artifact_kind: ArtifactKind;
  key_id: string;
  signed_at: string;
  artifact_sha256: string;
  subject: SignatureSubject;
  source: SignatureSource;
  signature: string;
}

export interface VerifiedSignature {
  key_id: string;
  artifact_sha256: string;
  signed_at: string;
  subject: SignatureSubject;
  source: SignatureSource;
}

export interface GeneratedSigningKey {
  private_key_pem: string;
  public_key_pem: string;
  key_id: string;
}

const KEY_ID = /^[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SigningError(`The signature statement field "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    throw new SigningError(`The signature statement field "${field}" must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

/** Deterministic JSON with recursively sorted object keys; signatures cover exactly these bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SigningError('Canonical JSON does not accept non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new SigningError('Canonical JSON accepts only null, booleans, finite numbers, strings, arrays and objects.');
}

function readRegularFile(path: string, label: string): Buffer {
  const resolved = resolve(path);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new SigningError(`The ${label} does not exist: ${resolved}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SigningError(`The ${label} must be a regular file, not a symlink: ${resolved}.`);
  }
  return readFileSync(resolved);
}

/** Key id is the SHA-256 of the DER SPKI encoding, so a public key cannot be relabelled. */
export function keyIdForPublicKey(publicKeyPem: string): string {
  let der: Buffer;
  try {
    der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  } catch (error) {
    throw new SigningError(`The public key is not a valid PEM key: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  return createHash('sha256').update(der).digest('hex');
}

export function generateSigningKey(): GeneratedSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { private_key_pem: privateKeyPem, public_key_pem: publicKeyPem, key_id: keyIdForPublicKey(publicKeyPem) };
}

export function createTrustRoot(key: {
  key_id: string;
  public_key_pem: string;
  not_before: string;
  not_after: string;
  status?: KeyStatus;
}): TrustRoot {
  if (key.key_id !== keyIdForPublicKey(key.public_key_pem)) {
    throw new SigningError('The trusted key id does not match its public key.');
  }
  return {
    schema_version: 1,
    keys: [{
      key_id: key.key_id,
      algorithm: 'ed25519',
      public_key_pem: key.public_key_pem,
      status: key.status ?? 'trusted',
      not_before: requireTimestamp(key.not_before, 'keys.not_before'),
      not_after: requireTimestamp(key.not_after, 'keys.not_after'),
    }],
  };
}

export function loadTrustRoot(path: string): TrustRoot {
  const raw = readRegularFile(path, 'trust root');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new SigningError(`The trust root is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1) {
    throw new SigningError('The trust root must be a JSON object with schema_version 1.');
  }
  if (!Array.isArray(parsed.keys)) {
    throw new SigningError('The trust root must contain a keys array.');
  }
  const keys: TrustedKey[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.keys.entries()) {
    if (!isRecord(entry)) throw new SigningError(`The trust root key ${index} must be an object.`);
    const keyId = requireString(entry.key_id, `keys[${index}].key_id`).toLowerCase();
    if (!KEY_ID.test(keyId)) {
      throw new SigningError(`The trust root key ${index} has a malformed key id.`);
    }
    if (seen.has(keyId)) {
      throw new SigningError(`The trust root contains duplicate key id ${keyId}.`);
    }
    seen.add(keyId);
    if (entry.algorithm !== 'ed25519') {
      throw new SigningError(`The trust root key ${keyId} must use ed25519.`);
    }
    const publicKeyPem = requireString(entry.public_key_pem, `keys[${index}].public_key_pem`);
    if (keyIdForPublicKey(publicKeyPem) !== keyId) {
      throw new SigningError(`The trust root key ${keyId} does not match its public key.`);
    }
    const status = entry.status;
    if (status !== 'trusted' && status !== 'revoked') {
      throw new SigningError(`The trust root key ${keyId} must be trusted or revoked.`);
    }
    const notBefore = requireTimestamp(entry.not_before, `keys[${index}].not_before`);
    const notAfter = requireTimestamp(entry.not_after, `keys[${index}].not_after`);
    if (Date.parse(notBefore) >= Date.parse(notAfter)) {
      throw new SigningError(`The trust root key ${keyId} has an empty validity window.`);
    }
    keys.push({
      key_id: keyId,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      status,
      not_before: notBefore,
      not_after: notAfter,
    });
  }
  if (keys.length === 0) {
    throw new SigningError(
      'The trust root contains no keys; provision a signing key and commit its public key before enabling signed artifacts.',
    );
  }
  return { schema_version: 1, keys };
}

export function sourceFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SignatureSource {
  const read = (key: string): string | null => {
    const value = environment[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    repository: read('GITHUB_REPOSITORY'),
    commit: read('GITHUB_SHA'),
    workflow: read('GITHUB_WORKFLOW_REF'),
    run_id: read('GITHUB_RUN_ID'),
  };
}

function statementPayload(statement: Omit<SignedStatement, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(statement), 'utf8');
}

/** Create a detached signature over the artifact's exact bytes and normalized subject. */
export function signArtifact(options: {
  artifact_kind: ArtifactKind;
  artifact_path: string;
  key_id: string;
  private_key_pem: string;
  subject: SignatureSubject;
  source?: SignatureSource;
  signed_at?: string;
  trust_root?: TrustRoot;
}): SignedStatement {
  const artifact = readRegularFile(options.artifact_path, 'artifact');
  const signedAt = requireTimestamp(options.signed_at ?? new Date().toISOString(), 'signed_at');
  if (options.trust_root !== undefined) {
    const key = options.trust_root.keys.find((entry) => entry.key_id === options.key_id);
    if (key === undefined) {
      throw new SigningError(`The signing key ${options.key_id} is not present in the trust root.`);
    }
    if (key.status !== 'trusted') {
      throw new SigningError(`The signing key ${options.key_id} is revoked in the trust root.`);
    }
    if (Date.parse(signedAt) < Date.parse(key.not_before) || Date.parse(signedAt) > Date.parse(key.not_after)) {
      throw new SigningError(`The signing key ${options.key_id} is outside its validity window.`);
    }
  }
  const payload: Omit<SignedStatement, 'signature'> = {
    schema_version: 1,
    artifact_kind: options.artifact_kind,
    key_id: options.key_id,
    signed_at: signedAt,
    artifact_sha256: createHash('sha256').update(artifact).digest('hex'),
    subject: options.subject,
    source: options.source ?? sourceFromEnvironment(),
  };
  let signature: string;
  try {
    signature = cryptoSign(null, statementPayload(payload), createPrivateKey(options.private_key_pem)).toString('base64');
  } catch (error) {
    throw new SigningError(`The artifact could not be signed: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  return { ...payload, signature };
}

export function parseSignedStatement(text: string): SignedStatement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SigningError(`The signature statement is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  if (!isRecord(parsed) || parsed.schema_version !== 1) {
    throw new SigningError('The signature statement must be a JSON object with schema_version 1.');
  }
  if (parsed.artifact_kind !== 'gvisor-runtime-pin' && parsed.artifact_kind !== 'gvisor-rootfs-manifest') {
    throw new SigningError('The signature statement has an unknown artifact_kind.');
  }
  const keyId = requireString(parsed.key_id, 'key_id').toLowerCase();
  if (!KEY_ID.test(keyId)) throw new SigningError('The signature statement has a malformed key_id.');
  const artifactSha256 = requireString(parsed.artifact_sha256, 'artifact_sha256').toLowerCase();
  if (!SHA256_HEX.test(artifactSha256)) {
    throw new SigningError('The signature statement has a malformed artifact_sha256.');
  }
  const signature = requireString(parsed.signature, 'signature');
  if (!BASE64_SIGNATURE.test(signature)) {
    throw new SigningError('The signature statement has a malformed signature.');
  }
  if (!isRecord(parsed.subject)) throw new SigningError('The signature statement must contain a subject object.');
  const subject: SignatureSubject = {};
  for (const [name, value] of Object.entries(parsed.subject)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new SigningError(`The signature subject field "${name}" must be a string or number.`);
    }
    subject[name] = value;
  }
  if (!isRecord(parsed.source)) throw new SigningError('The signature statement must contain a source object.');
  const sourceRecord = parsed.source;
  const sourceField = (name: string): string | null => {
    const value = sourceRecord[name];
    if (value === null) return null;
    if (typeof value !== 'string') throw new SigningError(`The signature source field "${name}" must be a string or null.`);
    return value;
  };
  return {
    schema_version: 1,
    artifact_kind: parsed.artifact_kind,
    key_id: keyId,
    signed_at: requireTimestamp(parsed.signed_at, 'signed_at'),
    artifact_sha256: artifactSha256,
    subject,
    source: {
      repository: sourceField('repository'),
      commit: sourceField('commit'),
      workflow: sourceField('workflow'),
      run_id: sourceField('run_id'),
    },
    signature,
  };
}

/**
 * Fail-closed verification: trust root from the repository, exact key id, revocation,
 * validity window, Ed25519 verifier, artifact byte digest and subject equality.
 */
export function verifyArtifactSignature(options: {
  artifact_kind: ArtifactKind;
  artifact_path: string;
  signature_path: string;
  trust_root_path: string;
  expected_subject: SignatureSubject;
  now?: Date;
}): VerifiedSignature {
  const artifact = readRegularFile(options.artifact_path, 'artifact');
  const statement = parseSignedStatement(readRegularFile(options.signature_path, 'signature statement').toString('utf8'));
  if (statement.artifact_kind !== options.artifact_kind) {
    throw new SigningError(
      `The signature is for ${statement.artifact_kind}, not ${options.artifact_kind}.`,
    );
  }
  const trustRoot = loadTrustRoot(options.trust_root_path);
  const key = trustRoot.keys.find((entry) => entry.key_id === statement.key_id);
  if (key === undefined) {
    throw new SigningError(`The signature key ${statement.key_id} is not present in the trust root.`);
  }
  if (key.status === 'revoked') {
    throw new SigningError(`The signature key ${statement.key_id} is revoked in the trust root.`);
  }
  const now = options.now ?? new Date();
  const signedAt = Date.parse(statement.signed_at);
  if (signedAt > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new SigningError('The signature is dated in the future.');
  }
  if (signedAt < Date.parse(key.not_before) || signedAt > Date.parse(key.not_after)) {
    throw new SigningError(`The signature was created outside the validity window of key ${statement.key_id}.`);
  }
  if (now.getTime() > Date.parse(key.not_after)) {
    throw new SigningError(`The signature key ${statement.key_id} has expired; re-sign the artifact.`);
  }
  const { signature, ...payload } = statement;
  let verified = false;
  try {
    verified = cryptoVerify(
      null,
      statementPayload(payload),
      createPublicKey(key.public_key_pem),
      Buffer.from(signature, 'base64'),
    );
  } catch (error) {
    throw new SigningError(`The signature could not be verified: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  if (!verified) {
    throw new SigningError(`The signature for ${options.artifact_kind} is not valid for key ${statement.key_id}.`);
  }
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  if (artifactSha256 !== statement.artifact_sha256) {
    throw new SigningError(
      `The signature is not over this artifact (expected ${statement.artifact_sha256}, observed ${artifactSha256}).`,
    );
  }
  for (const [name, expected] of Object.entries(options.expected_subject)) {
    const observed = statement.subject[name];
    if (observed !== expected) {
      throw new SigningError(
        `The signature subject "${name}" does not match the artifact (expected ${String(expected)}, observed ${String(observed)}).`,
      );
    }
  }
  return {
    key_id: statement.key_id,
    artifact_sha256: artifactSha256,
    signed_at: statement.signed_at,
    subject: statement.subject,
    source: statement.source,
  };
}

/** Hash helper exposed so callers can assert the digest they verify is the digest they use. */
export function artifactDigest(path: string): string {
  return hashFile(path, 'sha256');
}
