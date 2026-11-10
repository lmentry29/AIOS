import { join } from 'node:path';
import type { AuthorizationAuditStore, AuthorizationDecisionAudit } from '@aios/founder';
import { AppendOnlyJournal, JournalError } from './journal.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && /^human:[^\s:*]+$/.test(value);
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
  if (!isUuid(value.request_id)
    || !(value.actor_id === null || isHumanPrincipal(value.actor_id) || isUuid(value.actor_id))
    || !(value.action === null || (typeof value.action === 'string' && ACTIONS.has(value.action)))
    || !(value.resource_id === null || isUuid(value.resource_id))
    || !(value.policy_id === null || isUuid(value.policy_id))
    || !(value.policy_version === null
      || (Number.isSafeInteger(value.policy_version) && (value.policy_version as number) >= 1))
    || (value.decision !== 'allow' && value.decision !== 'deny')
    || typeof value.reason !== 'string' || !REASONS.has(value.reason)
    || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || !(matchedRuleIndex === undefined || matchedRuleIndex === null
      || (Number.isSafeInteger(matchedRuleIndex) && (matchedRuleIndex as number) >= 0))
    || !(matchedRuleEffect === undefined || matchedRuleEffect === null
      || matchedRuleEffect === 'allow' || matchedRuleEffect === 'deny')) {
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
  } else if (DEFAULT_DENY_REASONS.has(value.reason)) {
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
  };
}

export interface DurableAuthorizationAuditStoreOptions {
  directory: string;
  maxBytes?: number;
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
 * A failed append throws; `AuthorizationService` catches it and returns deny. A decision is
 * therefore never observed unless its audit record was durably accepted.
 */
export class DurableAuthorizationAuditStore implements AuthorizationAuditStore {
  readonly journal: AppendOnlyJournal;
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
    try {
      for (const entry of this.journal.read()) {
        if (entry.kind !== 'authorization_decision') {
          throw new JournalError('Authorization audit journal contains an unknown record kind.');
        }
        this.records.push(parseAuditRecord(entry.payload));
      }
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
    this.journal.append('authorization_decision', parsed);
    this.records.push(parsed);
  }

  list(): AuthorizationDecisionAudit[] {
    return this.records.map((record) => structuredClone(record));
  }

  close(): void {
    this.journal.close();
  }
}
