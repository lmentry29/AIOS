import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readBoundedRegularFile } from "../security/file-integrity.js";

/**
 * Detached-signature trust chain for gVisor provenance artifacts.
 *
 * Statement version 2 is parsed by a strict JSON reader rather than `JSON.parse`: duplicate
 * keys, prototype-mutating keys, excess nesting, trailing content, non-finite numbers and
 * oversized documents are rejected before any field is trusted. Verification binds the exact
 * artifact bytes, the artifact kind, a normalized subject, the signer key id and a canonical
 * base64 Ed25519 signature. Keys are never read from beside the artifact.
 *
 * Version 1 statements are deliberately rejected rather than accepted with weaker parsing;
 * they were never signed in this repository, so re-signing is the only compatible action.
 */

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

export type ArtifactKind = "gvisor-runtime-pin" | "gvisor-rootfs-manifest" | "application-archive";
export type KeyStatus = "trusted" | "revoked";
/** One key may authorize exactly one subject class (ADR-0035). */
export type KeyPurpose = "artifact" | "policy" | "verifier" | "audit";
const KEY_PURPOSES: readonly KeyPurpose[] = ["artifact", "policy", "verifier", "audit"];

export const STATEMENT_SCHEMA_VERSION = 2 as const;

const MAX_STATEMENT_BYTES = 1024 * 1024;
const MAX_TRUST_ROOT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_TRUSTED_KEYS = 64;
const MAX_SUBJECT_FIELDS = 64;
const MAX_SUBJECT_STRING = 1024;
const MAX_SOURCE_STRING = 2048;
const MAX_PEM_BYTES = 4096;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KEY_ID = /^[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export interface TrustedKey {
  key_id: string;
  algorithm: "ed25519";
  public_key_pem: string;
  purpose: KeyPurpose;
  status: KeyStatus;
  not_before: string;
  not_after: string;
}

export interface TrustRoot {
  schema_version: 2;
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
  schema_version: typeof STATEMENT_SCHEMA_VERSION;
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
  /** SHA-256 of the exact signature-statement bytes that were verified. */
  signature_sha256: string;
  signed_at: string;
  subject: SignatureSubject;
  source: SignatureSource;
}

export interface GeneratedSigningKey {
  private_key_pem: string;
  public_key_pem: string;
  key_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength = MAX_SUBJECT_STRING): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SigningError(`The signature statement field "${field}" must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new SigningError(
      `The signature statement field "${field}" exceeds ${maxLength} characters.`,
    );
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field, 64);
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    throw new SigningError(
      `The signature statement field "${field}" must be an ISO-8601 UTC timestamp.`,
    );
  }
  return text;
}

function requireOnlyFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new SigningError(`The ${context} contains an unknown field "${key}".`);
    }
  }
}

/** Deterministic JSON with recursively sorted object keys; signatures cover exactly these bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new SigningError("Canonical JSON does not accept non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new SigningError(
    "Canonical JSON accepts only null, booleans, finite numbers, strings, arrays and objects.",
  );
}

/**
 * Strict JSON reader for attacker-controlled statements and trust roots.
 *
 * Rejects duplicate object keys, dangerous keys, depth above the bound, trailing content,
 * unterminated strings, non-finite numbers and oversized text before semantic validation.
 */
export function parseStrictJson(text: string, label: string): unknown {
  let index = 0;
  const fail = (message: string): never => {
    throw new SigningError(`The ${label} is not valid strict JSON: ${message}.`);
  };
  const skipWhitespace = (): void => {
    while (
      index < text.length &&
      (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t")
    ) {
      index += 1;
    }
  };
  const parseString = (): string => {
    if (text[index] !== '"') fail("expected a string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index] as string;
      if (character === "\\") {
        if (text[index + 1] === undefined) fail("unterminated escape");
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return fail("invalid string escape");
        }
      }
      if (character.charCodeAt(0) < 0x20) fail("control character in string");
      index += 1;
    }
    return fail("unterminated string");
  };
  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (match === null) return fail("expected a number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return fail("number is not finite");
    return value;
  };
  const parseValue = (depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) fail(`nesting exceeds ${MAX_JSON_DEPTH} levels`);
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[index] === "}") {
        index += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (DANGEROUS_KEYS.has(key)) fail(`key "${key}" is not allowed`);
        if (Object.hasOwn(object, key)) fail(`duplicate key "${key}"`);
        skipWhitespace();
        if (text[index] !== ":") fail('expected ":"');
        index += 1;
        object[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return object;
        }
        fail('expected "," or "}"');
      }
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      const array: unknown[] = [];
      if (text[index] === "]") {
        index += 1;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return array;
        }
        fail('expected "," or "]"');
      }
    }
    if (character === '"') return parseString();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  };
  const parsed = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail("trailing content after the document");
  return parsed;
}

function readCappedFile(path: string, label: string, maxBytes: number): Buffer {
  try {
    return readBoundedRegularFile(path, label, maxBytes);
  } catch (error) {
    throw new SigningError(
      error instanceof Error ? error.message : `The ${label} could not be read.`,
    );
  }
}

function validateSubject(subject: Record<string, unknown>, context: string): SignatureSubject {
  const entries = Object.entries(subject);
  if (entries.length === 0 || entries.length > MAX_SUBJECT_FIELDS) {
    throw new SigningError(
      `The ${context} subject must contain between 1 and ${MAX_SUBJECT_FIELDS} fields.`,
    );
  }
  const validated = Object.create(null) as SignatureSubject;
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > 128 || DANGEROUS_KEYS.has(name)) {
      throw new SigningError(`The ${context} subject field "${name}" is not allowed.`);
    }
    if (typeof value === "string") {
      if (value.length > MAX_SUBJECT_STRING) {
        throw new SigningError(`The ${context} subject field "${name}" is too long.`);
      }
      validated[name] = value;
      continue;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      validated[name] = value;
      continue;
    }
    throw new SigningError(
      `The ${context} subject field "${name}" must be a string or a safe integer.`,
    );
  }
  return validated;
}

/** Key id is the SHA-256 of the DER SPKI encoding, so a public key cannot be relabelled. */
export function keyIdForPublicKey(publicKeyPem: string): string {
  if (publicKeyPem.length > MAX_PEM_BYTES) {
    throw new SigningError(`The public key exceeds the ${MAX_PEM_BYTES}-byte limit.`);
  }
  let der: Buffer;
  try {
    der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer;
  } catch (error) {
    throw new SigningError(
      `The public key is not a valid PEM key: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
  return createHash("sha256").update(der).digest("hex");
}

export function generateSigningKey(): GeneratedSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    private_key_pem: privateKeyPem,
    public_key_pem: publicKeyPem,
    key_id: keyIdForPublicKey(publicKeyPem),
  };
}

export interface TrustRootKeyInput {
  key_id: string;
  public_key_pem: string;
  not_before: string;
  not_after: string;
  purpose?: KeyPurpose;
  status?: KeyStatus;
}

function trustRootKey(key: TrustRootKeyInput, index: number): TrustedKey {
  if (!KEY_ID.test(key.key_id) || key.key_id !== keyIdForPublicKey(key.public_key_pem)) {
    throw new SigningError(`The trusted key ${index} id does not match its public key.`);
  }
  const purpose = key.purpose ?? "artifact";
  if (!KEY_PURPOSES.includes(purpose)) {
    throw new SigningError(`The trusted key ${key.key_id} has an invalid purpose.`);
  }
  const status = key.status ?? "trusted";
  if (status !== "trusted" && status !== "revoked") {
    throw new SigningError(`The trusted key ${key.key_id} has an invalid status.`);
  }
  const notBefore = requireTimestamp(key.not_before, `keys[${index}].not_before`);
  const notAfter = requireTimestamp(key.not_after, `keys[${index}].not_after`);
  if (Date.parse(notBefore) >= Date.parse(notAfter)) {
    throw new SigningError(`The trusted key ${key.key_id} has an empty validity window.`);
  }
  return {
    key_id: key.key_id,
    algorithm: "ed25519",
    public_key_pem: key.public_key_pem,
    purpose,
    status,
    not_before: notBefore,
    not_after: notAfter,
  };
}

/** Build one trust root with an explicitly supplied key set. */
export function createTrustRootFromKeys(keys: readonly TrustRootKeyInput[]): TrustRoot {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_TRUSTED_KEYS) {
    throw new SigningError(`A trust root must contain between 1 and ${MAX_TRUSTED_KEYS} keys.`);
  }
  const seen = new Set<string>();
  const normalized: TrustedKey[] = [];
  for (const [index, key] of keys.entries()) {
    if (seen.has(key.key_id)) {
      throw new SigningError(`The trust root contains duplicate key id ${key.key_id}.`);
    }
    seen.add(key.key_id);
    normalized.push(trustRootKey(key, index));
  }
  return { schema_version: 2, keys: normalized };
}

export function createTrustRoot(key: TrustRootKeyInput): TrustRoot {
  return createTrustRootFromKeys([key]);
}

export function loadTrustRoot(path: string, expectedPurpose: KeyPurpose = "artifact"): TrustRoot {
  const raw = readCappedFile(path, "trust root", MAX_TRUST_ROOT_BYTES);
  const parsed = parseStrictJson(raw.toString("utf8"), "trust root");
  if (!isRecord(parsed) || (parsed.schema_version !== 1 && parsed.schema_version !== 2)) {
    throw new SigningError("The trust root must be a JSON object with schema_version 1 or 2.");
  }
  const schemaVersion = parsed.schema_version;
  requireOnlyFields(parsed, ["schema_version", "keys"], "trust root");
  if (!Array.isArray(parsed.keys)) {
    throw new SigningError("The trust root must contain a keys array.");
  }
  if (parsed.keys.length > MAX_TRUSTED_KEYS) {
    throw new SigningError(`The trust root exceeds the ${MAX_TRUSTED_KEYS}-key limit.`);
  }
  const keys: TrustedKey[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.keys.entries()) {
    if (!isRecord(entry)) throw new SigningError(`The trust root key ${index} must be an object.`);
    requireOnlyFields(
      entry,
      schemaVersion === 1
        ? ["key_id", "algorithm", "public_key_pem", "status", "not_before", "not_after"]
        : ["key_id", "algorithm", "public_key_pem", "purpose", "status", "not_before", "not_after"],
      `trust root key ${index}`,
    );
    const keyId = requireString(entry.key_id, `keys[${index}].key_id`, 64);
    if (!KEY_ID.test(keyId)) {
      throw new SigningError(`The trust root key ${index} has a malformed key id.`);
    }
    if (seen.has(keyId)) {
      throw new SigningError(`The trust root contains duplicate key id ${keyId}.`);
    }
    seen.add(keyId);
    if (entry.algorithm !== "ed25519") {
      throw new SigningError(`The trust root key ${keyId} must use ed25519.`);
    }
    const purpose = schemaVersion === 1 ? expectedPurpose : entry.purpose;
    if (!KEY_PURPOSES.includes(purpose as KeyPurpose)) {
      throw new SigningError(`The trust root key ${keyId} must have one valid purpose.`);
    }
    const publicKeyPem = requireString(
      entry.public_key_pem,
      `keys[${index}].public_key_pem`,
      MAX_PEM_BYTES,
    );
    if (keyIdForPublicKey(publicKeyPem) !== keyId) {
      throw new SigningError(`The trust root key ${keyId} does not match its public key.`);
    }
    const status = entry.status;
    if (status !== "trusted" && status !== "revoked") {
      throw new SigningError(`The trust root key ${keyId} must be trusted or revoked.`);
    }
    const notBefore = requireTimestamp(entry.not_before, `keys[${index}].not_before`);
    const notAfter = requireTimestamp(entry.not_after, `keys[${index}].not_after`);
    if (Date.parse(notBefore) >= Date.parse(notAfter)) {
      throw new SigningError(`The trust root key ${keyId} has an empty validity window.`);
    }
    keys.push({
      key_id: keyId,
      algorithm: "ed25519",
      public_key_pem: publicKeyPem,
      purpose: purpose as KeyPurpose,
      status,
      not_before: notBefore,
      not_after: notAfter,
    });
  }
  if (keys.length === 0) {
    throw new SigningError(
      "The trust root contains no keys; provision a signing key and commit its public key before enabling signed artifacts.",
    );
  }
  return { schema_version: 2, keys };
}

export function sourceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SignatureSource {
  const read = (key: string): string | null => {
    const value = environment[key];
    if (typeof value !== "string" || value.length === 0) return null;
    return value.slice(0, MAX_SOURCE_STRING);
  };
  return {
    repository: read("GITHUB_REPOSITORY"),
    commit: read("GITHUB_SHA"),
    workflow: read("GITHUB_WORKFLOW_REF"),
    run_id: read("GITHUB_RUN_ID"),
  };
}

function statementPayload(statement: Omit<SignedStatement, "signature">): Buffer {
  return Buffer.from(canonicalJson(statement), "utf8");
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
  const artifact = readCappedFile(options.artifact_path, "artifact", MAX_ARTIFACT_BYTES);
  const signedAt = requireTimestamp(options.signed_at ?? new Date().toISOString(), "signed_at");
  const subject = validateSubject(options.subject, "signature");
  if (!KEY_ID.test(options.key_id)) {
    throw new SigningError("The signing key id is malformed.");
  }
  if (options.trust_root !== undefined) {
    const key = options.trust_root.keys.find((entry) => entry.key_id === options.key_id);
    if (key === undefined) {
      throw new SigningError(`The signing key ${options.key_id} is not present in the trust root.`);
    }
    if (key.purpose !== "artifact") {
      throw new SigningError(`The signing key ${options.key_id} is not an artifact-purpose key.`);
    }
    if (key.status !== "trusted") {
      throw new SigningError(`The signing key ${options.key_id} is revoked in the trust root.`);
    }
    if (
      Date.parse(signedAt) < Date.parse(key.not_before) ||
      Date.parse(signedAt) > Date.parse(key.not_after)
    ) {
      throw new SigningError(`The signing key ${options.key_id} is outside its validity window.`);
    }
  }
  const payload: Omit<SignedStatement, "signature"> = {
    schema_version: STATEMENT_SCHEMA_VERSION,
    artifact_kind: options.artifact_kind,
    key_id: options.key_id,
    signed_at: signedAt,
    artifact_sha256: createHash("sha256").update(artifact).digest("hex"),
    subject,
    source: options.source ?? sourceFromEnvironment(),
  };
  let signature: string;
  try {
    signature = cryptoSign(
      null,
      statementPayload(payload),
      createPrivateKey(options.private_key_pem),
    ).toString("base64");
  } catch (error) {
    throw new SigningError(
      `The artifact could not be signed: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
  return { ...payload, signature };
}

function parseSource(value: unknown): SignatureSource {
  if (!isRecord(value))
    throw new SigningError("The signature statement must contain a source object.");
  requireOnlyFields(value, ["repository", "commit", "workflow", "run_id"], "signature source");
  const sourceField = (name: string): string | null => {
    const field = value[name];
    if (field === null) return null;
    if (typeof field !== "string" || field.length > MAX_SOURCE_STRING) {
      throw new SigningError(`The signature source field "${name}" must be a string or null.`);
    }
    return field;
  };
  return {
    repository: sourceField("repository"),
    commit: sourceField("commit"),
    workflow: sourceField("workflow"),
    run_id: sourceField("run_id"),
  };
}

export function parseSignedStatement(text: string): SignedStatement {
  if (Buffer.byteLength(text, "utf8") > MAX_STATEMENT_BYTES) {
    throw new SigningError(
      `The signature statement exceeds the ${MAX_STATEMENT_BYTES}-byte limit.`,
    );
  }
  const parsed = parseStrictJson(text, "signature statement");
  if (!isRecord(parsed)) throw new SigningError("The signature statement must be a JSON object.");
  requireOnlyFields(
    parsed,
    [
      "schema_version",
      "artifact_kind",
      "key_id",
      "signed_at",
      "artifact_sha256",
      "subject",
      "source",
      "signature",
    ],
    "signature statement",
  );
  if (parsed.schema_version === 1) {
    throw new SigningError(
      "The signature statement uses schema_version 1, whose parsing is not accepted; re-sign the artifact with schema_version 2.",
    );
  }
  if (parsed.schema_version !== STATEMENT_SCHEMA_VERSION) {
    throw new SigningError(
      `The signature statement must use schema_version ${STATEMENT_SCHEMA_VERSION}.`,
    );
  }
  if (
    parsed.artifact_kind !== "gvisor-runtime-pin" &&
    parsed.artifact_kind !== "gvisor-rootfs-manifest" &&
    parsed.artifact_kind !== "application-archive"
  ) {
    throw new SigningError("The signature statement has an unknown artifact_kind.");
  }
  const keyId = requireString(parsed.key_id, "key_id", 64);
  if (!KEY_ID.test(keyId))
    throw new SigningError("The signature statement has a malformed key_id.");
  const artifactSha256 = requireString(parsed.artifact_sha256, "artifact_sha256", 64);
  if (!SHA256_HEX.test(artifactSha256)) {
    throw new SigningError("The signature statement has a malformed artifact_sha256.");
  }
  if (!isRecord(parsed.subject))
    throw new SigningError("The signature statement must contain a subject object.");
  const subject = validateSubject(parsed.subject, "signature");
  const signature = requireString(parsed.signature, "signature", 88);
  if (signature.length % 4 !== 0)
    throw new SigningError("The signature statement has a malformed signature.");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) {
    throw new SigningError(
      "The signature statement must contain a canonical 64-byte base64 Ed25519 signature.",
    );
  }
  return {
    schema_version: STATEMENT_SCHEMA_VERSION,
    artifact_kind: parsed.artifact_kind,
    key_id: keyId,
    signed_at: requireTimestamp(parsed.signed_at, "signed_at"),
    artifact_sha256: artifactSha256,
    subject,
    source: parseSource(parsed.source),
    signature,
  };
}

/**
 * Fail-closed verification: strict parse, artifact-kind match, trust root from the repository,
 * exact key id, revocation, validity window, Ed25519 verifier, artifact byte digest and
 * subject equality. No key or trust root is accepted from beside the artifact.
 */
export function verifyArtifactSignature(options: {
  artifact_kind: ArtifactKind;
  artifact_path: string;
  signature_path: string;
  trust_root_path: string;
  expected_subject: SignatureSubject;
  /** Pin the signer to one trust-root key instead of accepting any valid trusted key. */
  expected_key_id?: string;
  now?: Date;
}): VerifiedSignature {
  const artifact = readCappedFile(options.artifact_path, "artifact", MAX_ARTIFACT_BYTES);
  const signatureBytes = readCappedFile(
    options.signature_path,
    "signature statement",
    MAX_STATEMENT_BYTES,
  );
  const statement = parseSignedStatement(signatureBytes.toString("utf8"));
  if (statement.artifact_kind !== options.artifact_kind) {
    throw new SigningError(
      `The signature is for ${statement.artifact_kind}, not ${options.artifact_kind}.`,
    );
  }
  if (options.expected_key_id !== undefined) {
    if (!KEY_ID.test(options.expected_key_id)) {
      throw new SigningError("The expected signing key id is malformed.");
    }
    if (statement.key_id !== options.expected_key_id) {
      throw new SigningError(
        `The signature key ${statement.key_id} does not match the pinned key ${options.expected_key_id}.`,
      );
    }
  }
  const expectedSubject = validateSubject(options.expected_subject, "expected");
  const trustRoot = loadTrustRoot(options.trust_root_path, "artifact");
  const key = trustRoot.keys.find((entry) => entry.key_id === statement.key_id);
  if (key === undefined) {
    throw new SigningError(
      `The signature key ${statement.key_id} is not present in the trust root.`,
    );
  }
  if (key.purpose !== "artifact") {
    throw new SigningError(`The signature key ${statement.key_id} is not an artifact-purpose key.`);
  }
  if (key.status === "revoked") {
    throw new SigningError(`The signature key ${statement.key_id} is revoked in the trust root.`);
  }
  const now = options.now ?? new Date();
  const signedAt = Date.parse(statement.signed_at);
  if (signedAt > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new SigningError("The signature is dated in the future.");
  }
  if (signedAt < Date.parse(key.not_before) || signedAt > Date.parse(key.not_after)) {
    throw new SigningError(
      `The signature was created outside the validity window of key ${statement.key_id}.`,
    );
  }
  if (now.getTime() > Date.parse(key.not_after)) {
    throw new SigningError(
      `The signature key ${statement.key_id} has expired; re-sign the artifact.`,
    );
  }
  const { signature, ...payload } = statement;
  let verified = false;
  try {
    verified = cryptoVerify(
      null,
      statementPayload(payload),
      createPublicKey(key.public_key_pem),
      Buffer.from(signature, "base64"),
    );
  } catch (error) {
    throw new SigningError(
      `The signature could not be verified: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
  if (!verified) {
    throw new SigningError(
      `The signature for ${options.artifact_kind} is not valid for key ${statement.key_id}.`,
    );
  }
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  if (artifactSha256 !== statement.artifact_sha256) {
    throw new SigningError(
      `The signature is not over this artifact (expected ${statement.artifact_sha256}, observed ${artifactSha256}).`,
    );
  }
  for (const [name, expected] of Object.entries(expectedSubject)) {
    if (!Object.hasOwn(statement.subject, name) || statement.subject[name] !== expected) {
      throw new SigningError(
        `The signature subject "${name}" does not match the artifact (expected ${String(expected)}, observed ${String(statement.subject[name])}).`,
      );
    }
  }
  return {
    key_id: statement.key_id,
    artifact_sha256: artifactSha256,
    signature_sha256: createHash("sha256").update(signatureBytes).digest("hex"),
    signed_at: statement.signed_at,
    subject: statement.subject,
    source: statement.source,
  };
}
