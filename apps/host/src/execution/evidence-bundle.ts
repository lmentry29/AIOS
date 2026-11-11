import { createHash, createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { chmodSync, closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import type { ArtifactEntity, TaskEntity } from '@aios/core';
import type { ExecutionRecord } from '../persistence/execution-ledger.js';
import type { JournalRecord } from '../persistence/journal.js';
import {
  keyIdForPublicKey,
  type TrustRoot,
  loadTrustRoot,
  parseStrictJson,
} from './artifact-signing.js';

export const EVIDENCE_BUNDLE_FORMAT = 'aios-evidence-bundle' as const;
export const EVIDENCE_BUNDLE_VERSION = 1 as const;
const ZERO_HASH = '0'.repeat(64);
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_STRING = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 100_000;
const MAX_RECORDS = 100_000;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const SIGNATURE_PREFIX = 'aios-evidence-bundle/signature/v1\n';
const ENTRY_PREFIX = 'aios-evidence-bundle/entry/v1\n';
const ARTIFACT_PREFIX = 'aios-evidence-bundle/artifact/v1\n';

export type EvidenceBundleFailure =
  | 'INVALID_JSON'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED_BUNDLE'
  | 'UNKNOWN_KEY'
  | 'KEY_REVOKED'
  | 'KEY_NOT_YET_VALID'
  | 'KEY_EXPIRED'
  | 'SIGNATURE'
  | 'BUNDLE_DIGEST'
  | 'CHAIN'
  | 'TASK_BINDING'
  | 'EXECUTION_CHAIN'
  | 'REPLAY';

export class EvidenceBundleError extends Error {
  constructor(
    readonly code: EvidenceBundleFailure,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceBundleError';
  }
}

export interface EvidenceBundleKey {
  key_id: string;
  algorithm: 'ed25519';
  public_key_pem: string;
}

export interface EvidenceBundleEntry {
  sequence: number;
  kind: string;
  payload: unknown;
  previous_hash: string;
  hash: string;
  entry_hash: string;
}

export interface EvidenceBundleTask {
  task_id: string;
  lifecycle_state: string;
  audit_trail_ref?: string;
  entity_sha256: string;
}

export interface EvidenceBundleArtifact {
  artifact_id: string;
  entity_sha256: string;
  task_id?: string;
  verifier_id?: string;
  verifier_accepted?: boolean;
  verifier_reason_sha256?: string;
  verifier_evidence_sha256?: string;
  recorded_at?: string;
}

export interface EvidenceBundleExecution extends ExecutionRecord {
  record_sha256: string;
}

export interface EvidenceBundleHeader {
  format: typeof EVIDENCE_BUNDLE_FORMAT;
  version: typeof EVIDENCE_BUNDLE_VERSION;
  bundle_id: string;
  exported_at: string;
  source: {
    record_count: number;
    head_hash: string;
    entry_head_hash: string;
  };
  signing_key: EvidenceBundleKey;
}

export interface EvidenceBundlePayload {
  header: EvidenceBundleHeader;
  entries: EvidenceBundleEntry[];
  tasks: EvidenceBundleTask[];
  artifacts: EvidenceBundleArtifact[];
  executions: EvidenceBundleExecution[];
}

export interface EvidenceBundle extends EvidenceBundlePayload {
  bundle_sha256: string;
  signature: string;
}

export interface EvidenceBundleSource {
  journal: { read(): readonly JournalRecord[] };
  tasks: { list(): TaskEntity[] };
  artifacts: { list(): ArtifactEntity[] };
  executions: { list(): ExecutionRecord[] };
}

export interface VerifiedEvidenceBundle {
  bundle_id: string;
  bundle_sha256: string;
  head_hash: string;
  entry_head_hash: string;
  key_id: string;
  record_count: number;
  task_count: number;
  artifact_count: number;
  execution_count: number;
  exported_at: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical JSON with the same undefined-omission semantics as the append-only journal. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('MALFORMED_BUNDLE', 'Canonical bundle JSON does not accept non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (!isRecord(value)) fail('MALFORMED_BUNDLE', 'Canonical bundle JSON accepts only JSON values.');
  const entries = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalEvidenceJson(value: unknown): string {
  return canonicalJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: EvidenceBundleFailure, message: string): never {
  throw new EvidenceBundleError(code, message);
}

function requireString(value: unknown, label: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('MALFORMED_BUNDLE', `${label} must be a non-empty bounded string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label, 64);
  if (!ISO.test(text) || Number.isNaN(Date.parse(text))) {
    fail('MALFORMED_BUNDLE', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('MALFORMED_BUNDLE', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail('MALFORMED_BUNDLE', `${label} contains an unknown field "${key}".`);
  }
}

/** Parses untrusted bundle text without invoking application code or merging objects. */
export function parseEvidenceBundle(text: string): EvidenceBundle {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BUNDLE_BYTES) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle is not a bounded UTF-8 string.');
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text, 'evidence bundle');
  } catch (error) {
    fail('INVALID_JSON', error instanceof Error ? error.message : 'The evidence bundle is not valid strict JSON.');
  }
  assertPortable(parsed, 0);
  if (!isRecord(parsed)) fail('MALFORMED_BUNDLE', 'The evidence bundle must be a JSON object.');
  if (parsed.format !== EVIDENCE_BUNDLE_FORMAT && parsed.format !== undefined) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle has an unknown format.');
  }
  const header = parsed.header;
  if (!isRecord(header)) fail('MALFORMED_BUNDLE', 'The evidence bundle has no header.');
  if (header.format !== EVIDENCE_BUNDLE_FORMAT) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle header has an unknown format.');
  }
  if (header.version !== EVIDENCE_BUNDLE_VERSION) {
    fail('UNSUPPORTED_VERSION', `Unsupported evidence bundle version: ${String(header.version)}.`);
  }
  onlyFields(parsed, ['header', 'entries', 'tasks', 'artifacts', 'executions', 'bundle_sha256', 'signature'], 'evidence bundle');
  onlyFields(header, ['format', 'version', 'bundle_id', 'exported_at', 'source', 'signing_key'], 'evidence bundle header');
  const source = header.source;
  if (!isRecord(source)) fail('MALFORMED_BUNDLE', 'The evidence bundle header has no source.');
  onlyFields(source, ['record_count', 'head_hash', 'entry_head_hash'], 'evidence bundle source');
  if (!Number.isSafeInteger(source.record_count) || (source.record_count as number) < 0) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle record count is invalid.');
  }
  const signingKey = header.signing_key;
  if (!isRecord(signingKey)) fail('MALFORMED_BUNDLE', 'The evidence bundle has no signing key.');
  onlyFields(signingKey, ['key_id', 'algorithm', 'public_key_pem'], 'evidence bundle signing key');
  const keyId = requireString(signingKey.key_id, 'header.signing_key.key_id', 64);
  if (!SHA256.test(keyId) || signingKey.algorithm !== 'ed25519') {
    fail('MALFORMED_BUNDLE', 'The evidence bundle signing key is malformed.');
  }
  const publicKeyPem = requireString(signingKey.public_key_pem, 'header.signing_key.public_key_pem', 4096);
  let derivedKeyId: string;
  try {
    derivedKeyId = keyIdForPublicKey(publicKeyPem);
  } catch {
    fail('MALFORMED_BUNDLE', 'The evidence bundle signing key is not a valid Ed25519 public key.');
  }
  if (derivedKeyId !== keyId) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle key id does not match its public key.');
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle entries are missing or exceed the supported count.');
  }
  const entries = parsed.entries.map((value, index): EvidenceBundleEntry => {
    if (!isRecord(value)) fail('MALFORMED_BUNDLE', `The evidence bundle entry ${index} must be an object.`);
    onlyFields(value, ['sequence', 'kind', 'payload', 'previous_hash', 'hash', 'entry_hash'], `evidence bundle entry ${index}`);
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
      fail('MALFORMED_BUNDLE', `The evidence bundle entry ${index} has an invalid sequence.`);
    }
    return {
      sequence: value.sequence as number,
      kind: requireString(value.kind, `entries[${index}].kind`, 120),
      payload: value.payload,
      previous_hash: requireHash(value.previous_hash, `entries[${index}].previous_hash`),
      hash: requireHash(value.hash, `entries[${index}].hash`),
      entry_hash: requireHash(value.entry_hash, `entries[${index}].entry_hash`),
    };
  });
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length > MAX_RECORDS
    || !Array.isArray(parsed.artifacts) || parsed.artifacts.length > MAX_RECORDS
    || !Array.isArray(parsed.executions) || parsed.executions.length > MAX_RECORDS) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle records are missing or exceed the supported count.');
  }
  const tasks = parsed.tasks.map((value, index): EvidenceBundleTask => {
    if (!isRecord(value)) fail('MALFORMED_BUNDLE', `tasks[${index}] must be an object.`);
    onlyFields(value, ['task_id', 'lifecycle_state', 'audit_trail_ref', 'entity_sha256'], `tasks[${index}]`);
    return {
      task_id: requireString(value.task_id, `tasks[${index}].task_id`, 200),
      lifecycle_state: requireString(value.lifecycle_state, `tasks[${index}].lifecycle_state`, 40),
      ...(value.audit_trail_ref === undefined
        ? {}
        : { audit_trail_ref: requireString(value.audit_trail_ref, `tasks[${index}].audit_trail_ref`, 200) }),
      entity_sha256: requireHash(value.entity_sha256, `tasks[${index}].entity_sha256`),
    };
  });
  const artifacts = parsed.artifacts.map((value, index): EvidenceBundleArtifact => {
    if (!isRecord(value)) fail('MALFORMED_BUNDLE', `artifacts[${index}] must be an object.`);
    onlyFields(value, [
      'artifact_id', 'entity_sha256', 'task_id', 'verifier_id', 'verifier_accepted',
      'verifier_reason_sha256', 'verifier_evidence_sha256', 'recorded_at',
    ], `artifacts[${index}]`);
    return {
      artifact_id: requireString(value.artifact_id, `artifacts[${index}].artifact_id`, 200),
      entity_sha256: requireHash(value.entity_sha256, `artifacts[${index}].entity_sha256`),
      ...(value.task_id === undefined ? {} : { task_id: requireString(value.task_id, `artifacts[${index}].task_id`, 200) }),
      ...(value.verifier_id === undefined ? {} : { verifier_id: requireString(value.verifier_id, `artifacts[${index}].verifier_id`, 200) }),
      ...(value.verifier_accepted === undefined ? {} : { verifier_accepted: value.verifier_accepted === true }),
      ...(value.verifier_reason_sha256 === undefined
        ? {}
        : { verifier_reason_sha256: requireHash(value.verifier_reason_sha256, `artifacts[${index}].verifier_reason_sha256`) }),
      ...(value.verifier_evidence_sha256 === undefined
        ? {}
        : { verifier_evidence_sha256: requireHash(value.verifier_evidence_sha256, `artifacts[${index}].verifier_evidence_sha256`) }),
      ...(value.recorded_at === undefined ? {} : { recorded_at: requireTimestamp(value.recorded_at, `artifacts[${index}].recorded_at`) }),
    };
  });
  const executions = parsed.executions.map((value, index): EvidenceBundleExecution => {
    if (!isRecord(value)) fail('MALFORMED_BUNDLE', `executions[${index}] must be an object.`);
    onlyFields(value, [
      'execution_id', 'task_id', 'workflow_id', 'agent_id', 'attempt', 'attempt_kind',
      'previous_execution_id', 'state', 'started_at', 'updated_at', 'finished_at',
      'reason_code', 'evidence', 'revision', 'record_sha256',
    ], `executions[${index}]`);
    if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !Array.isArray(value.evidence) || value.evidence.length > 8
      || value.evidence.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 300)) {
      fail('MALFORMED_BUNDLE', `executions[${index}] has invalid attempt or evidence data.`);
    }
    const state = requireString(value.state, `executions[${index}].state`, 40);
    if (!['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state)) {
      fail('MALFORMED_BUNDLE', `executions[${index}].state is invalid.`);
    }
    const attemptKind = requireString(value.attempt_kind, `executions[${index}].attempt_kind`, 40);
    if (!['initial', 'resume', 'retry'].includes(attemptKind)) {
      fail('MALFORMED_BUNDLE', `executions[${index}].attempt_kind is invalid.`);
    }
    return {
      execution_id: requireString(value.execution_id, `executions[${index}].execution_id`, 200),
      task_id: requireString(value.task_id, `executions[${index}].task_id`, 200),
      ...(value.workflow_id === undefined ? {} : { workflow_id: requireString(value.workflow_id, `executions[${index}].workflow_id`, 200) }),
      agent_id: requireString(value.agent_id, `executions[${index}].agent_id`, 200),
      attempt: value.attempt as number,
      attempt_kind: attemptKind as ExecutionRecord['attempt_kind'],
      ...(value.previous_execution_id === undefined
        ? {}
        : { previous_execution_id: requireString(value.previous_execution_id, `executions[${index}].previous_execution_id`, 200) }),
      state: state as ExecutionRecord['state'],
      started_at: requireTimestamp(value.started_at, `executions[${index}].started_at`),
      updated_at: requireTimestamp(value.updated_at, `executions[${index}].updated_at`),
      ...(value.finished_at === undefined ? {} : { finished_at: requireTimestamp(value.finished_at, `executions[${index}].finished_at`) }),
      ...(value.reason_code === undefined ? {} : { reason_code: requireString(value.reason_code, `executions[${index}].reason_code`, 120) }),
      evidence: value.evidence.map((item, itemIndex) => requireString(item, `executions[${index}].evidence[${itemIndex}]`, 300)),
      revision: value.revision as number,
      record_sha256: requireHash(value.record_sha256, `executions[${index}].record_sha256`),
    };
  });
  return {
    header: {
      format: EVIDENCE_BUNDLE_FORMAT,
      version: EVIDENCE_BUNDLE_VERSION,
      bundle_id: requireString(header.bundle_id, 'header.bundle_id', 200),
      exported_at: requireTimestamp(header.exported_at, 'header.exported_at'),
      source: {
        record_count: source.record_count as number,
        head_hash: requireHash(source.head_hash, 'header.source.head_hash'),
        entry_head_hash: requireHash(source.entry_head_hash, 'header.source.entry_head_hash'),
      },
      signing_key: { key_id: keyId, algorithm: 'ed25519', public_key_pem: publicKeyPem },
    },
    entries,
    tasks,
    artifacts,
    executions,
    bundle_sha256: requireHash(parsed.bundle_sha256, 'bundle_sha256'),
    signature: requireString(parsed.signature, 'signature', 88),
  };
}

function assertPortable(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) fail('MALFORMED_BUNDLE', 'The evidence bundle exceeds the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > MAX_STRING) {
      fail('MALFORMED_BUNDLE', 'The evidence bundle contains an oversized string.');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('MALFORMED_BUNDLE', 'The evidence bundle contains a non-finite number.');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPortable(item, depth + 1);
    return;
  }
  if (!isRecord(value)) fail('MALFORMED_BUNDLE', 'The evidence bundle contains a non-plain JSON value.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('MALFORMED_BUNDLE', 'The evidence bundle contains a non-plain JSON value.');
  }
  for (const [key, nested] of Object.entries(value)) {
    if (DANGEROUS.has(key)) fail('MALFORMED_BUNDLE', `The evidence bundle contains the forbidden key "${key}".`);
    assertPortable(nested, depth + 1);
  }
}

function entryHash(sequence: number, journalHash: string, previousEntryHash: string): string {
  return sha256(`${ENTRY_PREFIX}${sequence}\n${journalHash}\n${previousEntryHash}`);
}

function taskDigest(task: TaskEntity): string {
  return sha256(`aios-evidence-bundle/task/v1\n${canonicalJson(task)}`);
}

function artifactDigest(artifact: ArtifactEntity): string {
  return sha256(`${ARTIFACT_PREFIX}${canonicalJson(artifact)}`);
}

function executionDigest(execution: Omit<ExecutionRecord, 'record_sha256'>): string {
  return sha256(`aios-evidence-bundle/execution/v1\n${canonicalJson(execution)}`);
}

function encodeVerificationEvidence(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string' || item.length > 2048)) {
    return undefined;
  }
  return sha256(canonicalJson(value));
}

function projectArtifact(artifact: ArtifactEntity): EvidenceBundleArtifact {
  let description: Record<string, unknown> | undefined;
  if (typeof artifact.description === 'string') {
    try {
      const parsed: unknown = JSON.parse(artifact.description);
      if (isRecord(parsed)) description = parsed;
    } catch {
      // The entity digest still binds the bytes; no verification fields are claimed.
    }
  }
  const verifierId = description?.verifier_id;
  const verifierAccepted = description?.verifier_accepted;
  const recordedAt = description?.recorded_at;
  return {
    artifact_id: artifact.entity_id,
    entity_sha256: artifactDigest(artifact),
    ...(typeof description?.task_id === 'string' && description.task_id.length <= 200 ? { task_id: description.task_id } : {}),
    ...(typeof verifierId === 'string' && verifierId.length > 0 && verifierId.length <= 200 ? { verifier_id: verifierId } : {}),
    ...(typeof verifierAccepted === 'boolean' ? { verifier_accepted: verifierAccepted } : {}),
    ...(typeof description?.verifier_reason === 'string' ? { verifier_reason_sha256: sha256(description.verifier_reason) } : {}),
    ...(encodeVerificationEvidence(description?.verifier_evidence) === undefined
      ? {}
      : { verifier_evidence_sha256: encodeVerificationEvidence(description?.verifier_evidence) }),
    ...(typeof recordedAt === 'string' && ISO.test(recordedAt) && Number.isFinite(Date.parse(recordedAt))
      ? { recorded_at: recordedAt }
      : {}),
  };
}

/** Exports and signs a portable evidence bundle from one open, already-verified store. */
export function exportEvidenceBundle(options: {
  store: EvidenceBundleSource;
  private_key_pem: string;
  key_id: string;
  exported_at?: string;
  bundle_id?: string;
}): EvidenceBundle {
  const exportedAt = requireTimestamp(options.exported_at ?? new Date().toISOString(), 'exported_at');
  const journal = options.store.journal.read();
  let previousEntryHash = ZERO_HASH;
  const entries = journal.map((record): EvidenceBundleEntry => {
    const entry: EvidenceBundleEntry = {
      sequence: record.sequence,
      kind: record.kind,
      payload: record.payload,
      previous_hash: record.previous_hash,
      hash: record.hash,
      entry_hash: entryHash(record.sequence, record.hash, previousEntryHash),
    };
    previousEntryHash = entry.entry_hash;
    return entry;
  });
  const privateKey = createPrivateKey(options.private_key_pem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = keyIdForPublicKey(publicKeyPem);
  if (keyId !== options.key_id) fail('UNKNOWN_KEY', 'The signing key id does not match the supplied private key.');
  const payload: EvidenceBundlePayload = {
    header: {
      format: EVIDENCE_BUNDLE_FORMAT,
      version: EVIDENCE_BUNDLE_VERSION,
      bundle_id: options.bundle_id ?? randomUUID(),
      exported_at: exportedAt,
      source: {
        record_count: entries.length,
        head_hash: entries.at(-1)?.hash ?? ZERO_HASH,
        entry_head_hash: previousEntryHash,
      },
      signing_key: { key_id: keyId, algorithm: 'ed25519', public_key_pem: publicKeyPem },
    },
    entries,
    tasks: options.store.tasks.list()
      .map((task) => ({
        task_id: task.entity_id,
        lifecycle_state: task.lifecycle_state,
        ...(task.audit_trail_ref === undefined ? {} : { audit_trail_ref: task.audit_trail_ref }),
        entity_sha256: taskDigest(task),
      }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id)),
    artifacts: options.store.artifacts.list()
      .map(projectArtifact)
      .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
    executions: options.store.executions.list()
      .map((execution) => ({ ...execution, record_sha256: executionDigest(execution) }))
      .sort((left, right) => left.execution_id.localeCompare(right.execution_id)),
  };
  validateBundleBindings(payload);
  const serialized = canonicalJson(payload);
  let signature: string;
  try {
    signature = cryptoSign(null, Buffer.from(`${SIGNATURE_PREFIX}${serialized}`, 'utf8'), privateKey).toString('base64');
  } catch {
    fail('SIGNATURE', 'The evidence bundle could not be signed.');
  }
  return { ...payload, bundle_sha256: sha256(serialized), signature };
}

function validateJournalChain(entries: EvidenceBundleEntry[], source: EvidenceBundleHeader['source']): void {
  if (entries.length !== source.record_count) {
    fail('CHAIN', 'The evidence bundle record count does not match its header.');
  }
  let previousHash = ZERO_HASH;
  let previousEntryHash = ZERO_HASH;
  for (const [index, entry] of entries.entries()) {
    if (entry.sequence !== index + 1) fail('CHAIN', 'The evidence bundle sequence has a gap or reordering.');
    if (entry.previous_hash !== previousHash) fail('CHAIN', 'The source journal hash chain is broken.');
    const unsigned = {
      sequence: entry.sequence,
      kind: entry.kind,
      payload: entry.payload,
      previous_hash: entry.previous_hash,
    };
    if (sha256(canonicalJson(unsigned)) !== entry.hash) {
      fail('CHAIN', 'A source journal record does not match its hash.');
    }
    if (entryHash(entry.sequence, entry.hash, previousEntryHash) !== entry.entry_hash) {
      fail('CHAIN', 'The evidence bundle entry chain is broken.');
    }
    previousHash = entry.hash;
    previousEntryHash = entry.entry_hash;
  }
  if (previousHash !== source.head_hash) fail('CHAIN', 'The evidence bundle tail does not match the source head.');
  if (previousEntryHash !== source.entry_head_hash) {
    fail('CHAIN', 'The evidence bundle entry head does not match the source entry head.');
  }
}

interface JournalExecutionBinding {
  task_id: string;
  record_sha256: string;
  revision: number;
}

interface JournalEntityIndex {
  tasks: Set<string>;
  artifacts: Map<string, EvidenceBundleArtifact>;
  executions: Map<string, JournalExecutionBinding>;
}

function journalEntityDigests(entries: EvidenceBundleEntry[]): JournalEntityIndex {
  const tasks = new Set<string>();
  const artifacts = new Map<string, EvidenceBundleArtifact>();
  const executions = new Map<string, JournalExecutionBinding>();
  const addExecution = (entity: unknown): void => {
    if (!isRecord(entity)) return;
    const record = entity as unknown as ExecutionRecord;
    if (typeof record.execution_id !== 'string' || typeof record.task_id !== 'string'
      || !Number.isSafeInteger(record.revision)) return;
    const digest = executionDigest(record);
    const current = executions.get(record.execution_id);
    if (current === undefined || record.revision > current.revision) {
      executions.set(record.execution_id, { task_id: record.task_id, record_sha256: digest, revision: record.revision });
    }
  };
  const addArtifact = (entity: unknown): void => {
    if (!isRecord(entity)) return;
    const projection = projectArtifact(entity as unknown as ArtifactEntity);
    artifacts.set(projection.entity_sha256, projection);
  };
  for (const entry of entries) {
    if (entry.kind === 'entity' && isRecord(entry.payload)) {
      const entity = entry.payload.entity;
      if (entry.payload.collection === 'tasks' && isRecord(entity)) tasks.add(taskDigest(entity as unknown as TaskEntity));
      if (entry.payload.collection === 'artifacts' && isRecord(entity)) addArtifact(entity);
    }
    if (entry.kind === 'execution' && isRecord(entry.payload)) addExecution(entry.payload);
    if (entry.kind === 'journal_snapshot' && isRecord(entry.payload)) {
      const snapshot = entry.payload;
      if (Array.isArray(snapshot.tasks)) {
        for (const entity of snapshot.tasks) if (isRecord(entity)) tasks.add(taskDigest(entity as unknown as TaskEntity));
      }
      if (Array.isArray(snapshot.artifacts)) {
        for (const entity of snapshot.artifacts) addArtifact(entity);
      }
      if (Array.isArray(snapshot.executions)) {
        for (const entity of snapshot.executions) addExecution(entity);
      }
    }
  }
  return { tasks, artifacts, executions };
}

function validateBundleBindings(payload: EvidenceBundlePayload): void {
  const journal = journalEntityDigests(payload.entries);
  const taskIds = new Set<string>();
  const tasks = new Map<string, EvidenceBundleTask>();
  for (const task of payload.tasks) {
    if (taskIds.has(task.task_id)) fail('TASK_BINDING', 'The evidence bundle contains a duplicate Task.');
    taskIds.add(task.task_id);
    tasks.set(task.task_id, task);
  }
  const artifactIds = new Set<string>();
  const artifacts = new Map<string, EvidenceBundleArtifact>();
  for (const artifact of payload.artifacts) {
    if (artifactIds.has(artifact.artifact_id)) fail('TASK_BINDING', 'The evidence bundle contains a duplicate Artifact.');
    artifactIds.add(artifact.artifact_id);
    artifacts.set(artifact.artifact_id, artifact);
    const journalArtifact = journal.artifacts.get(artifact.entity_sha256);
    if (journalArtifact === undefined) {
      fail('TASK_BINDING', `Artifact ${artifact.artifact_id} is not bound to a journal entity record.`);
    }
    if (canonicalJson(journalArtifact) !== canonicalJson(artifact)) {
      fail('TASK_BINDING', 'An evidence Artifact projection does not match its journal entity record.');
    }
    if (artifact.task_id !== undefined && !taskIds.has(artifact.task_id)) {
      fail('TASK_BINDING', 'An evidence Artifact references a Task that is absent from the bundle.');
    }
  }
  for (const task of payload.tasks) {
    if (!journal.tasks.has(task.entity_sha256)) {
      fail('TASK_BINDING', `Task ${task.task_id} is not bound to a journal entity record.`);
    }
    if (task.audit_trail_ref === undefined) {
      if (task.lifecycle_state === 'completed') {
        fail('TASK_BINDING', `Completed Task ${task.task_id} has no verifier evidence Artifact.`);
      }
      continue;
    }
    const artifact = artifacts.get(task.audit_trail_ref);
    if (!artifact) fail('TASK_BINDING', `Task ${task.task_id} references an absent evidence Artifact.`);
    if (artifact.task_id !== task.task_id) fail('TASK_BINDING', 'An evidence Artifact belongs to a different Task.');
    if (artifact.verifier_accepted !== true) fail('TASK_BINDING', 'An evidence Artifact is not an accepted verifier decision.');
    if (artifact.verifier_id === undefined) fail('TASK_BINDING', 'An evidence Artifact has no verifier identity.');
  }
  for (const artifact of payload.artifacts) {
    if (artifact.verifier_accepted === true && artifact.verifier_id === undefined) {
      fail('TASK_BINDING', 'An accepted evidence Artifact has no verifier identity.');
    }
  }

  const byTask = new Map<string, EvidenceBundleExecution[]>();
  const executionIds = new Set<string>();
  for (const execution of payload.executions) {
    if (executionIds.has(execution.execution_id)) fail('EXECUTION_CHAIN', 'The evidence bundle contains a duplicate execution.');
    executionIds.add(execution.execution_id);
    if (!tasks.has(execution.task_id)) {
      fail('EXECUTION_CHAIN', 'An execution references a Task that is absent from the bundle.');
    }
    const { record_sha256, ...record } = execution;
    if (executionDigest(record) !== record_sha256) fail('EXECUTION_CHAIN', 'An execution record does not match its digest.');
    const journalExecution = journal.executions.get(execution.execution_id);
    if (journalExecution === undefined || journalExecution.record_sha256 !== record_sha256
      || journalExecution.task_id !== execution.task_id) {
      fail('EXECUTION_CHAIN', 'An execution record is not bound to its latest journal execution entry.');
    }
    byTask.set(execution.task_id, [...(byTask.get(execution.task_id) ?? []), execution]);
  }
  for (const [executionId, expected] of journal.executions) {
    const actual = payload.executions.find((execution) => execution.execution_id === executionId);
    if (actual === undefined || actual.task_id !== expected.task_id || actual.record_sha256 !== expected.record_sha256) {
      fail('EXECUTION_CHAIN', `The evidence bundle is missing or altered execution ${executionId}.`);
    }
  }
  for (const [taskId, executions] of byTask) {
    const ordered = [...executions].sort((left, right) => left.attempt - right.attempt);
    for (const [index, execution] of ordered.entries()) {
      if (execution.attempt !== index + 1) fail('EXECUTION_CHAIN', 'An execution attempt sequence has a gap.');
      if (index === 0) {
        if (execution.attempt_kind !== 'initial' || execution.previous_execution_id !== undefined) {
          fail('EXECUTION_CHAIN', 'An execution chain does not start with an initial attempt.');
        }
      } else if (execution.attempt_kind === 'initial'
        || execution.previous_execution_id !== ordered[index - 1]?.execution_id) {
        fail('EXECUTION_CHAIN', 'An execution attempt has a mismatched predecessor.');
      }
    }
    const latest = ordered.at(-1);
    const task = tasks.get(taskId);
    if (task?.lifecycle_state === 'completed') {
      if (latest?.state !== 'completed') {
        fail('EXECUTION_CHAIN', 'A completed Task does not have a completed latest execution.');
      }
      if (task.audit_trail_ref !== undefined && latest === undefined) {
        fail('EXECUTION_CHAIN', 'A verified completed Task has no execution attempt.');
      }
    }
  }
}

/**
 * Offline fail-closed verification. Requires an external trust root and never reads the host,
 * the journal, the network, or any mutable state other than the two supplied documents.
 */
export function verifyEvidenceBundle(options: {
  bundle: EvidenceBundle | string;
  trust_root: TrustRoot;
  expected_head_hash?: string;
  now?: Date;
}): VerifiedEvidenceBundle {
  const bundle = parseEvidenceBundle(typeof options.bundle === 'string' ? options.bundle : JSON.stringify(options.bundle));
  const header = bundle.header;
  if (options.trust_root.schema_version !== 1) fail('MALFORMED_BUNDLE', 'The trust root schema is unsupported.');
  const trusted = options.trust_root.keys.find((key) => key.key_id === header.signing_key.key_id);
  if (!trusted) fail('UNKNOWN_KEY', `The bundle signing key ${header.signing_key.key_id} is absent from the trust root.`);
  if (trusted.status !== 'trusted') fail('KEY_REVOKED', `The bundle signing key ${header.signing_key.key_id} is revoked.`);
  if (trusted.public_key_pem !== header.signing_key.public_key_pem) {
    fail('UNKNOWN_KEY', 'The bundle signing key does not match the trust root key material.');
  }
  const now = (options.now ?? new Date()).getTime();
  if (now < Date.parse(trusted.not_before)) fail('KEY_NOT_YET_VALID', 'The bundle signing key is not yet valid.');
  if (now > Date.parse(trusted.not_after)) fail('KEY_EXPIRED', 'The bundle signing key is outside its validity window.');

  const { bundle_sha256, signature, ...payload } = bundle;
  const serialized = canonicalJson(payload);
  if (sha256(serialized) !== bundle_sha256) {
    fail('BUNDLE_DIGEST', 'The evidence bundle digest does not match its signed content.');
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    fail('SIGNATURE', 'The evidence bundle signature is malformed.');
  }
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) {
    fail('SIGNATURE', 'The evidence bundle signature is not canonical Ed25519.');
  }
  let valid = false;
  try {
    valid = cryptoVerify(
      null,
      Buffer.from(`${SIGNATURE_PREFIX}${serialized}`, 'utf8'),
      createPublicKey(trusted.public_key_pem),
      signatureBytes,
    );
  } catch {
    fail('SIGNATURE', 'The evidence bundle signature could not be verified.');
  }
  if (!valid) fail('SIGNATURE', 'The evidence bundle signature is invalid.');

  validateJournalChain(bundle.entries, header.source);
  validateBundleBindings(bundle);
  if (options.expected_head_hash !== undefined && options.expected_head_hash !== header.source.head_hash) {
    fail('REPLAY', 'The evidence bundle is not anchored to the expected journal head; it is stale or replayed.');
  }
  return {
    bundle_id: header.bundle_id,
    bundle_sha256,
    head_hash: header.source.head_hash,
    entry_head_hash: header.source.entry_head_hash,
    key_id: header.signing_key.key_id,
    record_count: header.source.record_count,
    task_count: bundle.tasks.length,
    artifact_count: bundle.artifacts.length,
    execution_count: bundle.executions.length,
    exported_at: header.exported_at,
  };
}

export function loadEvidenceBundle(path: string): EvidenceBundle {
  return parseEvidenceBundle(readFileSync(path, 'utf8'));
}

export function loadTrustRootForBundle(path: string): TrustRoot {
  return loadTrustRoot(path);
}

/** Writes a bundle atomically with owner-only permissions. */
export function writeEvidenceBundle(path: string, bundle: EvidenceBundle): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(bundle), 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  closeSync(descriptor);
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
