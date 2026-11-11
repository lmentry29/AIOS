import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { lstatSync } from 'node:fs';
import {
  isPolicyProvenance,
  policyContent,
  type AccessPolicy,
  type AuthorizationDecisionAudit,
  type PolicyProvenance,
  type PolicyProvenancePort,
  type PolicyProvenanceVerification,
} from '@aios/founder';
import {
  canonicalJson,
  keyIdForPublicKey,
  loadTrustRoot,
  type TrustRoot,
  type TrustedKey,
} from './execution/artifact-signing.js';
import { readBoundedRegularFile } from './security/file-integrity.js';

/**
 * Local detached provenance for policy bundles and authorization decisions.
 *
 * This is the same trust-root design as verifier-decision provenance (ADR-0033), not a new
 * authority system. A host that can read the private key can sign anything; this makes
 * persisted policy content and decisions tamper-evident and attributable to a pinned key,
 * but it is not remote attestation and does not survive a compromised host.
 */
export const POLICY_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const POLICY_PROVENANCE_SUBJECT_POLICY = 'policy_bundle' as const;
export const POLICY_PROVENANCE_SUBJECT_DECISION = 'authorization_decision' as const;

const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export class PolicyProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyProvenanceError';
  }
}

type FailureReason =
  | 'missing'
  | 'malformed'
  | 'schema_unsupported'
  | 'subject_mismatch'
  | 'bundle_id_mismatch'
  | 'key_unknown'
  | 'key_revoked'
  | 'key_not_yet_valid'
  | 'key_expired'
  | 'payload_mismatch'
  | 'signature_invalid'
  | 'verification_error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyFromTrustRoot(trustRoot: TrustRoot, keyId: string): TrustedKey {
  if (!SHA256_HEX.test(keyId)) {
    throw new PolicyProvenanceError('The policy signing key id is malformed.');
  }
  const key = trustRoot.keys.find((entry) => entry.key_id === keyId);
  if (key === undefined) {
    throw new PolicyProvenanceError('The policy signing key is not present in the trust root.');
  }
  return key;
}

function assertWindow(key: TrustedKey, at: Date, label: string): void {
  if (key.status !== 'trusted') {
    throw new PolicyProvenanceError(`The policy signing key ${key.key_id} is revoked.`);
  }
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new PolicyProvenanceError('The policy signing clock is invalid.');
  if (time < Date.parse(key.not_before)) {
    throw new PolicyProvenanceError(`The policy signing key ${key.key_id} is not yet valid for ${label}.`);
  }
  if (time > Date.parse(key.not_after)) {
    throw new PolicyProvenanceError(`The policy signing key ${key.key_id} is expired for ${label}.`);
  }
}

function failure(reason: FailureReason): PolicyProvenanceVerification {
  return { valid: false, reason };
}

function policyPayload(policy: AccessPolicy, provenance: {
  key_id: string;
  signed_at: string;
}): Record<string, unknown> {
  return {
    schema_version: POLICY_PROVENANCE_SCHEMA_VERSION,
    subject: POLICY_PROVENANCE_SUBJECT_POLICY,
    subject_id: policy.policy_id,
    key_id: provenance.key_id,
    signed_at: provenance.signed_at,
    policy: policyContent(policy),
  };
}

function decisionPayload(record: AuthorizationDecisionAudit, provenance: {
  key_id: string;
  signed_at: string;
}): Record<string, unknown> {
  return {
    schema_version: POLICY_PROVENANCE_SCHEMA_VERSION,
    subject: POLICY_PROVENANCE_SUBJECT_DECISION,
    subject_id: record.request_id,
    key_id: provenance.key_id,
    signed_at: provenance.signed_at,
    decision: {
      request_id: record.request_id,
      actor_id: record.actor_id,
      action: record.action,
      resource_id: record.resource_id,
      policy_id: record.policy_id,
      policy_version: record.policy_version,
      decision: record.decision,
      reason: record.reason,
      matched_rule_index: record.matched_rule_index ?? null,
      matched_rule_effect: record.matched_rule_effect ?? null,
      timestamp: record.timestamp,
    },
  };
}

function verifyPayload(
  trustRoot: TrustRoot,
  provenance: PolicyProvenance,
  payload: Record<string, unknown>,
  now: Date,
): PolicyProvenanceVerification {
  let key: TrustedKey;
  try {
    key = keyFromTrustRoot(trustRoot, provenance.key_id);
  } catch {
    return failure('key_unknown');
  }
  if (key.status !== 'trusted') return failure('key_revoked');
  const signedAt = Date.parse(provenance.signed_at);
  if (!Number.isFinite(signedAt)) return failure('malformed');
  if (signedAt > now.getTime() + MAX_FUTURE_SKEW_MS) return failure('malformed');
  if (signedAt < Date.parse(key.not_before)) return failure('key_not_yet_valid');
  if (signedAt > Date.parse(key.not_after)) return failure('key_expired');
  const serialized = canonicalJson(payload);
  if (sha256(serialized) !== provenance.payload_sha256) return failure('payload_mismatch');
  let valid = false;
  try {
    valid = cryptoVerify(
      null,
      Buffer.from(serialized, 'utf8'),
      createPublicKey(key.public_key_pem),
      Buffer.from(provenance.signature, 'base64'),
    );
  } catch {
    return failure('signature_invalid');
  }
  return valid ? { valid: true } : failure('signature_invalid');
}

export interface PolicyProvenanceAuthorityOptions {
  private_key_file: string;
  trust_root_file: string;
  key_id: string;
  now?: () => Date;
}

/**
 * Loads the owner-only private key and the pinned trust root, proving they correspond
 * before the host starts accepting policy content.
 */
export class PolicyProvenanceAuthority implements PolicyProvenancePort {
  private constructor(
    private readonly privateKey: KeyObject | undefined,
    private readonly trustRoot: TrustRoot,
    readonly keyId: string,
    private readonly now: () => Date,
  ) {}

  /** Verification-only authority used by audit readers and adversarial tests. */
  static verificationOnly(options: {
    trust_root_file: string;
    now?: () => Date;
  }): PolicyProvenanceAuthority {
    return new PolicyProvenanceAuthority(
      undefined,
      loadTrustRoot(options.trust_root_file),
      '',
      options.now ?? (() => new Date()),
    );
  }

  static fromFiles(options: PolicyProvenanceAuthorityOptions): PolicyProvenanceAuthority {
    const trustRoot = loadTrustRoot(options.trust_root_file);
    const bytes = readBoundedRegularFile(
      options.private_key_file,
      'policy signing private key',
      MAX_PRIVATE_KEY_BYTES,
    );
    try {
      const stats = lstatSync(options.private_key_file);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
        throw new PolicyProvenanceError('The policy private key must be a regular, unlinked file.');
      }
      if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
        throw new PolicyProvenanceError('The policy private key must be owner-only (chmod 600).');
      }
    } catch (error) {
      if (error instanceof PolicyProvenanceError) throw error;
      throw new PolicyProvenanceError('The policy private key metadata could not be read.');
    }

    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(bytes.toString('utf8'));
    } catch {
      throw new PolicyProvenanceError('The policy private key is not valid.');
    }
    let publicKeyPem: string;
    try {
      publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    } catch {
      throw new PolicyProvenanceError('The policy private key has no usable public key.');
    }
    if (keyIdForPublicKey(publicKeyPem) !== options.key_id) {
      throw new PolicyProvenanceError('The policy signing key id does not match the private key.');
    }
    const key = keyFromTrustRoot(trustRoot, options.key_id);
    if (key.public_key_pem !== publicKeyPem) {
      throw new PolicyProvenanceError('The policy signing key does not match the trust-root key material.');
    }
    const now = options.now ?? (() => new Date());
    assertWindow(key, now(), 'signing');
    return new PolicyProvenanceAuthority(privateKey, trustRoot, options.key_id, now);
  }

  async signPolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    if (this.privateKey === undefined) throw new PolicyProvenanceError('No policy signing key is loaded.');
    const content = policyContent(policy);
    const signedAt = this.now();
    if (!Number.isFinite(signedAt.getTime())) {
      throw new PolicyProvenanceError('The policy signing clock is invalid.');
    }
    const key = keyFromTrustRoot(this.trustRoot, this.keyId);
    assertWindow(key, signedAt, 'signing');
    const unsigned = { ...content, provenance: undefined } as AccessPolicy;
    const payload = policyPayload(unsigned, {
      key_id: this.keyId,
      signed_at: signedAt.toISOString(),
    });
    const serialized = canonicalJson(payload);
    const provenance: PolicyProvenance = {
      schema_version: POLICY_PROVENANCE_SCHEMA_VERSION,
      subject: POLICY_PROVENANCE_SUBJECT_POLICY,
      subject_id: policy.policy_id,
      key_id: this.keyId,
      signed_at: signedAt.toISOString(),
      payload_sha256: sha256(serialized),
      signature: cryptoSign(null, Buffer.from(serialized, 'utf8'), this.privateKey)
        .toString('base64'),
    };
    return { ...content, provenance };
  }

  async verifyPolicy(policy: AccessPolicy): Promise<PolicyProvenanceVerification> {
    try {
      const provenance = policy.provenance;
      if (provenance === undefined) return failure('missing');
      if (!isRecord(provenance)) return failure('malformed');
      if (provenance.schema_version !== POLICY_PROVENANCE_SCHEMA_VERSION) {
        return failure('schema_unsupported');
      }
      if (!isPolicyProvenance(provenance)) return failure('malformed');
      if (provenance.subject !== POLICY_PROVENANCE_SUBJECT_POLICY) return failure('subject_mismatch');
      if (provenance.subject_id !== policy.policy_id) return failure('bundle_id_mismatch');
      return verifyPayload(
        this.trustRoot,
        provenance,
        policyPayload(policy, provenance),
        this.now(),
      );
    } catch {
      return failure('verification_error');
    }
  }

  async signDecision(record: AuthorizationDecisionAudit): Promise<AuthorizationDecisionAudit> {
    if (this.privateKey === undefined) throw new PolicyProvenanceError('No policy signing key is loaded.');
    const { provenance: _existing, ...content } = record;
    const signedAt = this.now();
    if (!Number.isFinite(signedAt.getTime())) {
      throw new PolicyProvenanceError('The policy signing clock is invalid.');
    }
    const key = keyFromTrustRoot(this.trustRoot, this.keyId);
    assertWindow(key, signedAt, 'signing');
    const payload = decisionPayload(content, {
      key_id: this.keyId,
      signed_at: signedAt.toISOString(),
    });
    const serialized = canonicalJson(payload);
    return {
      ...content,
      provenance: {
        schema_version: POLICY_PROVENANCE_SCHEMA_VERSION,
        subject: POLICY_PROVENANCE_SUBJECT_DECISION,
        subject_id: record.request_id,
        key_id: this.keyId,
        signed_at: signedAt.toISOString(),
        payload_sha256: sha256(serialized),
        signature: cryptoSign(null, Buffer.from(serialized, 'utf8'), this.privateKey)
          .toString('base64'),
      },
    };
  }

  async verifyDecision(record: AuthorizationDecisionAudit): Promise<PolicyProvenanceVerification> {
    try {
      const provenance = record.provenance;
      if (provenance === undefined) return failure('missing');
      if (!isRecord(provenance)) return failure('malformed');
      if (provenance.schema_version !== POLICY_PROVENANCE_SCHEMA_VERSION) {
        return failure('schema_unsupported');
      }
      if (!isPolicyProvenance(provenance)) return failure('malformed');
      if (provenance.subject !== POLICY_PROVENANCE_SUBJECT_DECISION) return failure('subject_mismatch');
      if (provenance.subject_id !== record.request_id) return failure('malformed');
      const { provenance: _existing, ...content } = record;
      return verifyPayload(
        this.trustRoot,
        provenance,
        decisionPayload(content, provenance),
        this.now(),
      );
    } catch {
      return failure('verification_error');
    }
  }
}
