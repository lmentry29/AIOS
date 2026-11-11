import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isPolicyProvenance, type AuthorizationAuditStore, type AuthorizationDecisionAudit } from '@aios/founder';
import {
  AUDIT_HEAD_SCHEMA_VERSION,
  type AuditHeadBody,
  type AuditHeadProvenance,
  type AuditHeadSigner,
} from '../policy-provenance.js';
import { fsyncDirectory } from './fsync-directory.js';
import { AppendOnlyJournal, JournalError, type JournalRecord } from './journal.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ZERO_HASH = '0'.repeat(64);
const AUDIT_HEAD_FILE = 'authorization-audit.head.json';
const AUDIT_HEAD_VERSION = 1;
const AUDIT_HEAD_FIELDS = new Set([
  'version',
  'schema_version',
  'sequence',
  'record_count',
  'head_hash',
  'provenance',
]);
const AUDIT_FIELDS = new Set([
  'request_id',
  'actor_id',
  'action',
  'resource_id',
  'policy_id',
  'policy_version',
  'decision',
  'reason',
  'matched_rule_index',
  'matched_rule_effect',
  'timestamp',
  'provenance',
]);
const ACTIONS = new Set([
  'intake',
  'dispatch',
  'execute',
  'coordinate',
  'cancel',
  'resume',
  'retry',
  'read_status',
  'read_evidence',
  'administer_policy',
  'revoke_policy',
  'administer_sessions',
]);
const REASONS = new Set([
  'matching_allow',
  'explicit_deny',
  'no_matching_allow',
  'resource_policy_missing_or_invalid',
  'policy_missing_or_invalid',
  'invalid_request',
  'policy_resolution_or_evaluation_error',
]);
const DEFAULT_DENY_REASONS = new Set([
  'no_matching_allow',
  'resource_policy_missing_or_invalid',
  'policy_missing_or_invalid',
  'invalid_request',
  'policy_resolution_or_evaluation_error',
]);

interface StoredAuditHead extends AuditHeadBody {
  version: typeof AUDIT_HEAD_VERSION;
  provenance?: AuditHeadProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && /^human:[^\s:*]+$/.test(value);
}

function isHeadBody(value: Record<string, unknown>): value is AuditHeadBody & Record<string, unknown> {
  return value.schema_version === AUDIT_HEAD_SCHEMA_VERSION
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0
    && Number.isSafeInteger(value.record_count) && (value.record_count as number) >= 0
    && value.sequence === value.record_count
    && typeof value.head_hash === 'string' && SHA256_HEX.test(value.head_hash);
}

/**
 * Strict parser for a decision record.
 *
 * Unknown fields are rejected so a caller cannot smuggle a token or raw credential into the
 * audit journal, and reason is a fixed code rather than free-form error text. This is also
 * the reopen-time integrity check: a record that was edited outside the chain fails here or
 * at the journal's SHA-256 hash verification.
 */
function parseAuditRecord(value: unknown): AuthorizationDecisionAudit {
  if (!isRecord(value) || Object.keys(value).some((key) => !AUDIT_FIELDS.has(key))) {
    throw new JournalError('Authorization audit record contains an unsupported field.');
  }
  const matchedRuleIndex = value.matched_rule_index;
  const matchedRuleEffect = value.matched_rule_effect;
  const isProvenanceReason = typeof value.reason === 'string'
    && value.reason.startsWith('policy_provenance_');
  if (!isUuid(value.request_id)
    || !(value.actor_id === null || isHumanPrincipal(value.actor_id) || isUuid(value.actor_id))
    || !(value.action === null || (typeof value.action === 'string' && ACTIONS.has(value.action)))
    || !(value.resource_id === null || isUuid(value.resource_id))
    || !(value.policy_id === null || isUuid(value.policy_id))
    || !(value.policy_version === null
      || (Number.isSafeInteger(value.policy_version) && (value.policy_version as number) >= 1))
    || (value.decision !== 'allow' && value.decision !== 'deny')
    || typeof value.reason !== 'string' || !(REASONS.has(value.reason) || isProvenanceReason)
    || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || !(matchedRuleIndex === undefined || matchedRuleIndex === null
      || (Number.isSafeInteger(matchedRuleIndex) && (matchedRuleIndex as number) >= 0))
    || !(matchedRuleEffect === undefined || matchedRuleEffect === null
      || matchedRuleEffect === 'allow' || matchedRuleEffect === 'deny')
    || (value.provenance !== undefined
      && (!isPolicyProvenance(value.provenance)
        || value.provenance.subject !== 'authorization_decision'
        || value.provenance.subject_id !== value.request_id))) {
    throw new JournalError('Authorization audit record is invalid.');
  }

  const hasRuleIndex = typeof matchedRuleIndex === 'number';
  const hasRuleEffect = matchedRuleEffect === 'allow' || matchedRuleEffect === 'deny';
  if (hasRuleIndex !== hasRuleEffect) {
    throw new JournalError('Authorization audit record has an incomplete grant reference.');
  }
  if (hasRuleEffect && (value.policy_id === null || value.policy_version === null)) {
    throw new JournalError('Authorization audit record references a grant without its policy.');
  }
  if (value.decision === 'allow') {
    if (value.reason !== 'matching_allow' || matchedRuleEffect !== 'allow') {
      throw new JournalError('Authorization audit allow must record its matching grant.');
    }
  } else if (value.reason === 'explicit_deny') {
    if (matchedRuleEffect !== 'deny') {
      throw new JournalError('Authorization audit explicit deny must record its matching deny rule.');
    }
  } else if (DEFAULT_DENY_REASONS.has(value.reason) || isProvenanceReason) {
    if (hasRuleEffect) {
      throw new JournalError('Authorization audit default deny cannot reference a matching grant.');
    }
  } else {
    throw new JournalError('Authorization audit reason is inconsistent with the decision.');
  }

  return {
    request_id: value.request_id,
    actor_id: value.actor_id,
    action: value.action as AuthorizationDecisionAudit['action'],
    resource_id: value.resource_id,
    policy_id: value.policy_id,
    policy_version: value.policy_version as number | null,
    decision: value.decision,
    reason: value.reason,
    matched_rule_index: typeof matchedRuleIndex === 'number' ? matchedRuleIndex : null,
    matched_rule_effect: matchedRuleEffect === 'allow' || matchedRuleEffect === 'deny'
      ? matchedRuleEffect
      : null,
    timestamp: value.timestamp,
    ...(value.provenance === undefined ? {} : { provenance: value.provenance }),
  };
}

export interface DurableAuthorizationAuditStoreOptions {
  directory: string;
  maxBytes?: number;
  /**
   * Signs the detached high-water mark. The host supplies the pinned policy provenance
   * authority; tests without a host key exercise the same boundary with an unsigned anchor.
   */
  headSigner?: AuditHeadSigner;
}

/**
 * Durable authorization decision audit, separate from the policy/audit state file and from
 * the operational journal.
 *
 * It uses the same `AppendOnlyJournal` contract as Task/Workflow state: one JSON record per
 * line, fsync before append returns, a SHA-256 hash chain, single-process lock, torn-tail
 * truncation on open, and fail-closed corruption detection. Policy lifecycle events remain
 * in `FilePolicyRegistry` because they are committed atomically with policy state.
 *
 * A separate, signed high-water mark records the accepted sequence, record count, and head
 * hash. The chain alone cannot distinguish a shorter valid prefix from the intended history:
 * truncating the tail leaves every remaining record internally valid. The anchor makes that
 * removal, rollback to an older prefix, and a recomputed insertion/reordering visible on
 * open, on every append, and on every read. The anchor is local durable state; an attacker
 * who can rewrite both the journal and the anchor to an older signed pair is outside this
 * boundary and is recorded as external-custody residual risk.
 *
 * A failed append throws; `AuthorizationService` catches it and returns deny. A decision is
 * therefore never observed unless its audit record and head anchor were durably accepted.
 */
export class DurableAuthorizationAuditStore implements AuthorizationAuditStore {
  readonly journal: AppendOnlyJournal;
  private readonly headPath: string;
  private readonly headSigner: AuditHeadSigner | undefined;
  private readonly records: AuthorizationDecisionAudit[] = [];

  constructor(options: DurableAuthorizationAuditStoreOptions) {
    if (!isRecord(options as unknown)
      || typeof options.directory !== 'string' || options.directory.length === 0) {
      throw new Error('Durable authorization audit storage requires a directory.');
    }
    this.journal = new AppendOnlyJournal({
      filePath: join(options.directory.replace(/\/+$/, ''), 'authorization-audit.jsonl'),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    this.headPath = join(options.directory.replace(/\/+$/, ''), AUDIT_HEAD_FILE);
    this.headSigner = options.headSigner;
    try {
      for (const entry of this.journal.read()) {
        if (entry.kind !== 'authorization_decision') {
          throw new JournalError('Authorization audit journal contains an unknown record kind.');
        }
        this.records.push(parseAuditRecord(entry.payload));
      }
      this.ensureHead();
    } catch (error) {
      this.journal.close();
      throw error;
    }
  }

  /** True when an interrupted final append was discarded during journal recovery. */
  get recoveredTornTail(): boolean {
    return this.journal.recoveredTornTail;
  }

  async append(record: AuthorizationDecisionAudit): Promise<void> {
    const parsed = parseAuditRecord(record);
    this.assertCurrentHead();
    const entry = this.journal.append('authorization_decision', parsed);
    this.writeHead({
      schema_version: AUDIT_HEAD_SCHEMA_VERSION,
      sequence: entry.sequence,
      record_count: entry.sequence,
      head_hash: entry.hash,
    });
    this.records.push(parsed);
  }

  list(): AuthorizationDecisionAudit[] {
    this.assertCurrentHead();
    return this.records.map((record) => structuredClone(record));
  }

  close(): void {
    this.journal.close();
  }

  private ensureHead(): void {
    const head = this.readHead();
    if (head === undefined) {
      if (this.records.length > 0) {
        throw new JournalError(
          'Authorization audit head is missing; refusing to trust an unanchored audit journal.',
        );
      }
      this.writeHead({
        schema_version: AUDIT_HEAD_SCHEMA_VERSION,
        sequence: 0,
        record_count: 0,
        head_hash: ZERO_HASH,
      });
      return;
    }
    this.assertHeadMatches(this.journal.read(), head);
  }

  private assertCurrentHead(): void {
    const head = this.readHead();
    if (head === undefined) {
      throw new JournalError('Authorization audit head is missing; refusing to trust the audit journal.');
    }
    const onDisk = this.journal.verifyOnDisk();
    this.assertHeadMatches(onDisk, head);
  }

  private assertHeadMatches(
    records: readonly JournalRecord[],
    head: StoredAuditHead,
  ): void {
    const expectedHash = records[records.length - 1]?.hash ?? ZERO_HASH;
    if (head.record_count !== records.length || head.sequence !== records.length) {
      throw new JournalError(
        'Authorization audit head record count does not match the durable audit journal.',
      );
    }
    if (head.head_hash !== expectedHash) {
      throw new JournalError(
        'Authorization audit head hash does not match the durable audit journal.',
      );
    }
  }

  private readHead(): StoredAuditHead | undefined {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(this.headPath);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return undefined;
      throw new JournalError('Authorization audit head could not be read.');
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new JournalError('Authorization audit head must be a regular, unlinked file.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.headPath, 'utf8'));
    } catch {
      throw new JournalError('Authorization audit head is unreadable.');
    }
    if (!isRecord(parsed)
      || parsed.version !== AUDIT_HEAD_VERSION
      || Object.keys(parsed).some((key) => !AUDIT_HEAD_FIELDS.has(key))
      || !isHeadBody(parsed)) {
      throw new JournalError('Authorization audit head is malformed.');
    }
    const body: AuditHeadBody = {
      schema_version: AUDIT_HEAD_SCHEMA_VERSION,
      sequence: parsed.sequence as number,
      record_count: parsed.record_count as number,
      head_hash: parsed.head_hash as string,
    };
    const provenance = parsed.provenance;
    if (this.headSigner === undefined) {
      if (provenance !== undefined) {
        throw new JournalError('Authorization audit head has provenance but no verifier is configured.');
      }
    } else {
      if (provenance === undefined) {
        throw new JournalError('Authorization audit head signature is missing.');
      }
      const verified = this.headSigner.verifyAuditHead(provenance);
      if (!verified.valid) {
        throw new JournalError(
          `Authorization audit head provenance is invalid: ${verified.reason ?? 'invalid'}.`,
        );
      }
      if (!isRecord(provenance)
        || provenance.sequence !== body.sequence
        || provenance.record_count !== body.record_count
        || provenance.head_hash !== body.head_hash) {
        throw new JournalError('Authorization audit head provenance does not match the stored head.');
      }
    }
    return {
      version: AUDIT_HEAD_VERSION,
      ...body,
      ...(provenance === undefined ? {} : { provenance: provenance as unknown as AuditHeadProvenance }),
    };
  }

  private writeHead(body: AuditHeadBody): void {
    if (this.headSigner === undefined) {
      this.writeHeadFile(JSON.stringify({ version: AUDIT_HEAD_VERSION, ...body }));
      return;
    }
    const provenance = this.headSigner.signAuditHead(body);
    this.writeHeadFile(JSON.stringify({ version: AUDIT_HEAD_VERSION, ...body, provenance }));
  }

  private writeHeadFile(serialized: string): void {
    try {
      const existing = lstatSync(this.headPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
        throw new JournalError('Authorization audit head must be a regular, unlinked file.');
      }
    } catch (error) {
      if (!(isRecord(error) && error.code === 'ENOENT') && !(error instanceof JournalError)) {
        throw new JournalError('Authorization audit head metadata could not be verified.');
      }
      if (error instanceof JournalError) throw error;
    }
    const temporary = `${this.headPath}.tmp-${process.pid}-${randomUUID()}`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${serialized}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.headPath);
    fsyncDirectory(dirname(this.headPath));
  }
}
