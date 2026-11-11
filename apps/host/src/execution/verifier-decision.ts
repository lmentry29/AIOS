import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { lstatSync } from "node:fs";
import {
  canonicalJson,
  keyIdForPublicKey,
  loadTrustRoot,
  type TrustRoot,
  type TrustedKey,
} from "./artifact-signing.js";
import { readBoundedRegularFile } from "../security/file-integrity.js";

/**
 * Detached provenance for one verifier decision.
 *
 * This is deliberately a local, host-held Ed25519 signature. It makes a persisted decision
 * tamper-evident and pins the signer to a trust-root key, but it does not turn a compromised
 * host into an independent verifier: a host that can read the private key can sign anything.
 * Remote attestation and production key custody remain separate decisions (ADR-0019/0033).
 */

export const VERIFIER_DECISION_SCHEMA_VERSION = 1 as const;

const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const MAX_REASON = 1024;
const MAX_EVIDENCE_ITEMS = 64;
const MAX_EVIDENCE_LINE = 512;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export class VerifierDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierDecisionError";
  }
}

export interface VerifierDecisionBody {
  schema_version: typeof VERIFIER_DECISION_SCHEMA_VERSION;
  task_id: string;
  execution_id: string | null;
  attempt: number | null;
  bound_result_sha256: string | null;
  verifier_id: string;
  accepted: boolean;
  reason: string;
  evidence: string[];
}

export interface VerifierDecisionPayload {
  schema_version: typeof VERIFIER_DECISION_SCHEMA_VERSION;
  key_id: string;
  signed_at: string;
  decision: VerifierDecisionBody;
}

export interface VerifierDecisionProvenance extends VerifierDecisionPayload {
  payload_sha256: string;
  signature: string;
}

export interface VerifierDecisionExpectation {
  task_id: string;
  verifier_id: string;
  accepted: boolean;
  reason: string;
  evidence: string[];
  /**
   * Durable-attempt binding. The kernel supplies these from its execution ledger so an old
   * signed decision cannot be replayed for a later attempt of the same Task. `undefined`
   * means the caller did not supply an expectation; `null` requires a null signed field.
   */
  execution_id?: string | null;
  attempt?: number | null;
  bound_result_sha256?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new VerifierDecisionError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label, 64);
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    throw new VerifierDecisionError(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

function onlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new VerifierDecisionError(`${label} contains an unknown field "${key}".`);
    }
  }
}

function keyFromTrustRoot(trustRoot: TrustRoot, keyId: string): TrustedKey {
  if (!SHA256_HEX.test(keyId))
    throw new VerifierDecisionError("The verifier signing key id is malformed.");
  if (trustRoot.schema_version !== 1)
    throw new VerifierDecisionError("The trust root schema is unsupported.");
  const key = trustRoot.keys.find((entry) => entry.key_id === keyId);
  if (key === undefined) {
    throw new VerifierDecisionError(
      `The verifier signing key ${keyId} is not present in the trust root.`,
    );
  }
  if (key.status !== "trusted") {
    throw new VerifierDecisionError(`The verifier signing key ${keyId} is revoked.`);
  }
  return key;
}

function assertKeyWindow(key: TrustedKey, at: Date, label: string): void {
  const time = at.getTime();
  if (time < Date.parse(key.not_before)) {
    throw new VerifierDecisionError(
      `The verifier signing key ${key.key_id} is not yet valid for ${label}.`,
    );
  }
  if (time > Date.parse(key.not_after)) {
    throw new VerifierDecisionError(
      `The verifier signing key ${key.key_id} is expired for ${label}.`,
    );
  }
}

function validateBody(value: unknown): VerifierDecisionBody {
  if (!isRecord(value)) throw new VerifierDecisionError("The verifier decision must be an object.");
  onlyFields(
    value,
    [
      "schema_version",
      "task_id",
      "execution_id",
      "attempt",
      "bound_result_sha256",
      "verifier_id",
      "accepted",
      "reason",
      "evidence",
    ],
    "verifier decision",
  );
  if (value.schema_version !== VERIFIER_DECISION_SCHEMA_VERSION) {
    throw new VerifierDecisionError("The verifier decision schema version is unsupported.");
  }
  const taskId = requireString(value.task_id, "verifier decision task_id", 200);
  const executionId =
    value.execution_id === null
      ? null
      : requireString(value.execution_id, "verifier decision execution_id", 200);
  const attempt =
    value.attempt === null
      ? null
      : Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0
        ? (value.attempt as number)
        : (() => {
            throw new VerifierDecisionError(
              "verifier decision attempt must be a positive integer or null.",
            );
          })();
  if (executionId === null && attempt !== null) {
    throw new VerifierDecisionError("A verifier decision with an attempt must name its execution.");
  }
  const bound =
    value.bound_result_sha256 === null
      ? null
      : requireString(value.bound_result_sha256, "verifier decision bound_result_sha256", 64);
  if (bound !== null && !SHA256_HEX.test(bound)) {
    throw new VerifierDecisionError(
      "verifier decision bound_result_sha256 must be a SHA-256 digest.",
    );
  }
  const verifierId = requireString(value.verifier_id, "verifier decision verifier_id", 200);
  if (typeof value.accepted !== "boolean") {
    throw new VerifierDecisionError("verifier decision accepted must be a boolean.");
  }
  const reason = requireString(value.reason, "verifier decision reason", MAX_REASON);
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > MAX_EVIDENCE_ITEMS
  ) {
    throw new VerifierDecisionError(
      `verifier decision evidence must contain between 1 and ${MAX_EVIDENCE_ITEMS} entries.`,
    );
  }
  const evidence = value.evidence.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_EVIDENCE_LINE) {
      throw new VerifierDecisionError(
        `verifier decision evidence[${index}] must be a bounded non-empty string.`,
      );
    }
    return entry;
  });
  return {
    schema_version: VERIFIER_DECISION_SCHEMA_VERSION,
    task_id: taskId,
    execution_id: executionId,
    attempt,
    bound_result_sha256: bound,
    verifier_id: verifierId,
    accepted: value.accepted,
    reason,
    evidence,
  };
}

function payloadFor(provenance: {
  schema_version: typeof VERIFIER_DECISION_SCHEMA_VERSION;
  key_id: string;
  signed_at: string;
  decision: unknown;
}): VerifierDecisionPayload {
  return {
    schema_version: VERIFIER_DECISION_SCHEMA_VERSION,
    key_id: provenance.key_id,
    signed_at: provenance.signed_at,
    decision: validateBody(provenance.decision),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePrivateKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (error) {
    throw new VerifierDecisionError(
      `The verifier private key is not valid: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
}

/**
 * Signs decisions with one Ed25519 key and verifies them against a loaded trust root.
 * The private key is held only in memory after startup.
 */
export class VerifierDecisionSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    readonly keyId: string,
    private readonly trustRoot: TrustRoot,
    private readonly now: () => Date,
  ) {}

  static fromPrivateKey(options: {
    private_key_pem: string;
    key_id: string;
    trust_root: TrustRoot;
    now?: () => Date;
  }): VerifierDecisionSigner {
    const privateKey = parsePrivateKey(options.private_key_pem);
    let publicKeyPem: string;
    try {
      publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    } catch {
      throw new VerifierDecisionError("The verifier private key has no usable public key.");
    }
    const derivedId = keyIdForPublicKey(publicKeyPem);
    if (derivedId !== options.key_id) {
      throw new VerifierDecisionError(
        "The verifier signing key id does not match the private key.",
      );
    }
    const key = keyFromTrustRoot(options.trust_root, options.key_id);
    if (key.public_key_pem !== publicKeyPem) {
      throw new VerifierDecisionError(
        "The verifier signing key does not match the trust-root key material.",
      );
    }
    const signer = new VerifierDecisionSigner(
      privateKey,
      options.key_id,
      options.trust_root,
      options.now ?? (() => new Date()),
    );
    assertKeyWindow(key, signer.now(), "signing");
    return signer;
  }

  sign(decision: VerifierDecisionBody): VerifierDecisionProvenance {
    const body = validateBody(decision);
    const signedAt = this.now();
    if (!Number.isFinite(signedAt.getTime()))
      throw new VerifierDecisionError("The verifier signing clock is invalid.");
    const key = keyFromTrustRoot(this.trustRoot, this.keyId);
    assertKeyWindow(key, signedAt, "signing");
    const payload = payloadFor({
      schema_version: VERIFIER_DECISION_SCHEMA_VERSION,
      key_id: this.keyId,
      signed_at: signedAt.toISOString(),
      decision: body,
    });
    const serialized = canonicalJson(payload);
    return {
      ...payload,
      payload_sha256: sha256(serialized),
      signature: cryptoSign(null, Buffer.from(serialized, "utf8"), this.privateKey).toString(
        "base64",
      ),
    };
  }

  verify(provenance: unknown, expected: VerifierDecisionExpectation): void {
    if (!isRecord(provenance))
      throw new VerifierDecisionError("The verifier decision provenance is missing.");
    onlyFields(
      provenance,
      ["schema_version", "key_id", "signed_at", "decision", "payload_sha256", "signature"],
      "verifier decision provenance",
    );
    if (provenance.schema_version !== VERIFIER_DECISION_SCHEMA_VERSION) {
      throw new VerifierDecisionError(
        "The verifier decision provenance schema version is unsupported.",
      );
    }
    const keyId = requireString(provenance.key_id, "verifier decision key_id", 64);
    if (!SHA256_HEX.test(keyId))
      throw new VerifierDecisionError("The verifier decision key id is malformed.");
    const signedAt = requireTimestamp(provenance.signed_at, "verifier decision signed_at");
    const payloadSha256 = requireString(
      provenance.payload_sha256,
      "verifier decision payload_sha256",
      64,
    );
    if (!SHA256_HEX.test(payloadSha256)) {
      throw new VerifierDecisionError("The verifier decision payload digest is malformed.");
    }
    const signature = requireString(provenance.signature, "verifier decision signature", 88);
    const signatureBytes = Buffer.from(signature, "base64");
    if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) {
      throw new VerifierDecisionError(
        "The verifier decision signature must be canonical Ed25519 base64.",
      );
    }
    const payload = payloadFor({
      schema_version: VERIFIER_DECISION_SCHEMA_VERSION,
      key_id: keyId,
      signed_at: signedAt,
      decision: provenance.decision,
    });
    const serialized = canonicalJson(payload);
    if (sha256(serialized) !== payloadSha256) {
      throw new VerifierDecisionError(
        "The verifier decision payload digest does not match its content.",
      );
    }
    const key = keyFromTrustRoot(this.trustRoot, keyId);
    assertKeyWindow(key, new Date(signedAt), "verification");
    const now = this.now();
    if (Date.parse(signedAt) > now.getTime() + MAX_FUTURE_SKEW_MS) {
      throw new VerifierDecisionError("The verifier decision is dated in the future.");
    }
    let valid = false;
    try {
      valid = cryptoVerify(
        null,
        Buffer.from(serialized, "utf8"),
        createPublicKey(key.public_key_pem),
        signatureBytes,
      );
    } catch {
      throw new VerifierDecisionError("The verifier decision signature could not be verified.");
    }
    if (!valid) throw new VerifierDecisionError("The verifier decision signature is invalid.");

    if (payload.decision.task_id !== expected.task_id) {
      throw new VerifierDecisionError("The signed verifier decision belongs to a different Task.");
    }
    if (payload.decision.verifier_id !== expected.verifier_id) {
      throw new VerifierDecisionError(
        "The signed verifier decision has a different verifier identity.",
      );
    }
    if (payload.decision.accepted !== expected.accepted) {
      throw new VerifierDecisionError(
        "The signed verifier decision acceptance does not match the record.",
      );
    }
    if (payload.decision.reason !== expected.reason) {
      throw new VerifierDecisionError(
        "The signed verifier decision reason does not match the record.",
      );
    }
    if (
      payload.decision.evidence.length !== expected.evidence.length ||
      payload.decision.evidence.some((entry, index) => entry !== expected.evidence[index])
    ) {
      throw new VerifierDecisionError(
        "The signed verifier decision evidence does not match the record.",
      );
    }
    if (expected.execution_id !== undefined
      && payload.decision.execution_id !== expected.execution_id) {
      throw new VerifierDecisionError(
        "The signed verifier decision belongs to a different execution attempt.",
      );
    }
    if (expected.attempt !== undefined && payload.decision.attempt !== expected.attempt) {
      throw new VerifierDecisionError(
        "The signed verifier decision has a different attempt number.",
      );
    }
    if (expected.bound_result_sha256 !== undefined
      && payload.decision.bound_result_sha256 !== expected.bound_result_sha256) {
      throw new VerifierDecisionError(
        "The signed verifier decision is bound to a different execution result.",
      );
    }
  }

  /** Verifies the persisted evidence artifact shape without trusting any field beside the signature. */
  verifyRecord(record: Record<string, unknown>): void {
    const provenance = record.verifier_provenance;
    if (!isRecord(provenance))
      throw new VerifierDecisionError("The evidence record has no verifier provenance.");
    const evidence = record.verifier_evidence;
    if (!Array.isArray(evidence) || evidence.some((entry) => typeof entry !== "string")) {
      throw new VerifierDecisionError("The evidence record has malformed verifier evidence.");
    }
    const expected: VerifierDecisionExpectation = {
      task_id: requireString(record.task_id, "evidence task_id", 200),
      verifier_id: requireString(record.verifier_id, "evidence verifier_id", 200),
      accepted: record.verifier_accepted === true,
      reason: requireString(record.verifier_reason, "evidence verifier_reason", MAX_REASON),
      evidence: evidence as string[],
    };
    // The kernel supplies expected_* from the durable ledger at read time. Those fields take
    // precedence over the record's own copy, which an artifact writer could edit even though
    // it cannot mint a new signature.
    const expectedExecutionId = "expected_execution_id" in record
      ? record.expected_execution_id
      : record.execution_id;
    if (expectedExecutionId !== undefined) {
      expected.execution_id = expectedExecutionId === null
        ? null
        : requireString(expectedExecutionId, "evidence expected_execution_id", 200);
    }
    const expectedAttempt = "expected_attempt" in record ? record.expected_attempt : record.attempt;
    if (expectedAttempt !== undefined) {
      if (expectedAttempt === null) {
        expected.attempt = null;
      } else if (Number.isSafeInteger(expectedAttempt) && (expectedAttempt as number) > 0) {
        expected.attempt = expectedAttempt as number;
      } else {
        throw new VerifierDecisionError("The evidence record has a malformed expected attempt.");
      }
    }
    if (expected.execution_id !== undefined && record.execution_id !== undefined
      && record.execution_id !== expected.execution_id) {
      throw new VerifierDecisionError(
        "The evidence record execution id does not match the durable attempt.",
      );
    }
    if (expected.attempt !== undefined && record.attempt !== undefined
      && record.attempt !== expected.attempt) {
      throw new VerifierDecisionError(
        "The evidence record attempt does not match the durable attempt.",
      );
    }
    if ("bound_result_sha256" in record) {
      expected.bound_result_sha256 = record.bound_result_sha256 === null
        ? null
        : requireString(record.bound_result_sha256, "evidence bound_result_sha256", 64);
      if (expected.bound_result_sha256 !== null && !SHA256_HEX.test(expected.bound_result_sha256)) {
        throw new VerifierDecisionError(
          "The evidence record has a malformed bound result digest.",
        );
      }
    }
    this.verify(provenance, expected);
  }
}

export function loadVerifierDecisionSigner(options: {
  private_key_file: string;
  key_id: string;
  trust_root_file: string;
  now?: () => Date;
}): VerifierDecisionSigner {
  const bytes = readBoundedRegularFile(
    options.private_key_file,
    "verifier private key",
    MAX_PRIVATE_KEY_BYTES,
  );
  try {
    const stats = lstatSync(options.private_key_file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new VerifierDecisionError("The verifier private key must be a regular, unlinked file.");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new VerifierDecisionError("The verifier private key must be owner-only (chmod 600).");
    }
  } catch (error) {
    if (error instanceof VerifierDecisionError) throw error;
    throw new VerifierDecisionError("The verifier private key metadata could not be read.");
  }
  return VerifierDecisionSigner.fromPrivateKey({
    private_key_pem: bytes.toString("utf8"),
    key_id: options.key_id,
    trust_root: loadTrustRoot(options.trust_root_file),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
