import { createHash, timingSafeEqual } from 'node:crypto';
import type { TaskExecutionResult } from '@aios/orchestration';

/**
 * Host-side evidence binding for executor results.
 *
 * Executor output is attacker-controlled. Digests must therefore be computed over a bounded,
 * canonical snapshot of plain data: no accessors, class instances, symbols, cycles, BigInt,
 * non-finite numbers or prototype keys. The digest also includes the durable attempt identity
 * so a result replayed from another run, Task or Agent cannot validate even when its content is
 * byte-identical.
 */

export class EvidenceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceBindingError';
  }
}

export const EXECUTION_BINDING_VERSION = 'attempt-v2' as const;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING = 8192;
const MAX_SUMMARY = 1024;
const MAX_RESULT_EVIDENCE_ITEMS = 64;
const MAX_RESULT_EVIDENCE_LENGTH = 512;
const MAX_COMPLETED_ACTIONS = 256;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_LINE = 300;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EVIDENCE_LINE = /^([a-z][a-z0-9_]{0,63}):([^\r\n]{0,299})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EXECUTION_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertNoAccessors(record: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      throw new EvidenceBindingError(`The executor result field "${path}${key}" is not a data property.`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new EvidenceBindingError(`The executor result field "${path}${key}" must not be an accessor.`);
    }
  }
  if (Object.getOwnPropertySymbols(record).length !== 0) {
    throw new EvidenceBindingError(`The executor result field "${path}" must not contain symbol keys.`);
  }
}

/** Canonical JSON for bounded plain data; key order cannot change the digest. */
export function canonicalEvidenceJson(value: unknown, depth = 0, path = '$'): string {
  if (depth > MAX_DEPTH) {
    throw new EvidenceBindingError(`The executor result exceeds ${MAX_DEPTH} nesting levels.`);
  }
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) {
      throw new EvidenceBindingError(`The executor result string at "${path}" is too long.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EvidenceBindingError(`The executor result number at "${path}" is not finite.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new EvidenceBindingError(`The executor result array at "${path}" has too many entries.`);
    }
    return `[${value.map((entry, index) => canonicalEvidenceJson(entry, depth + 1, `${path}[${index}]`)).join(',')}]`;
  }
  if (!isPlainRecord(value)) {
    throw new EvidenceBindingError(`The executor result field "${path}" must be a plain object, array or primitive.`);
  }
  assertNoAccessors(value, `${path}.`);
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) {
    throw new EvidenceBindingError(`The executor result object at "${path}" has too many keys.`);
  }
  const entries = keys
    .sort()
    .map((key) => {
      if (key.length > 128 || DANGEROUS_KEYS.has(key)) {
        throw new EvidenceBindingError(`The executor result key "${path}.${key}" is not allowed.`);
      }
      return `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key], depth + 1, `${path}.${key}`)}`;
    });
  return `{${entries.join(',')}}`;
}

export interface ExecutionResultSnapshot {
  summary: string;
  evidence: string[];
  completed_actions?: unknown[];
}

/**
 * Snapshot the executor's result under a fixed schema before it is hashed or journaled.
 * Unknown top-level fields, accessors, prototype keys, nulls and non-canonical values fail.
 */
export function snapshotExecutionResult(value: unknown): ExecutionResultSnapshot {
  if (!isPlainRecord(value)) {
    throw new EvidenceBindingError('The executor result must be a plain object.');
  }
  assertNoAccessors(value, '');
  const allowed = new Set(['summary', 'evidence', 'completed_actions']);
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new EvidenceBindingError(`The executor result key "${key}" is not allowed.`);
    }
    if (!allowed.has(key)) {
      throw new EvidenceBindingError(`The executor result contains an unknown field "${key}".`);
    }
  }
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0 || value.summary.length > MAX_SUMMARY) {
    throw new EvidenceBindingError('The executor result summary must be a bounded non-empty string.');
  }
  if (!Array.isArray(value.evidence)
    || value.evidence.length === 0
    || value.evidence.length > MAX_RESULT_EVIDENCE_ITEMS) {
    throw new EvidenceBindingError('The executor result must contain between 1 and 64 evidence entries.');
  }
  const evidence = value.evidence.map((entry, index) => {
    if (typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_RESULT_EVIDENCE_LENGTH) {
      throw new EvidenceBindingError(`The executor result evidence entry ${index} must be a bounded string.`);
    }
    return entry;
  });
  const snapshot: ExecutionResultSnapshot = { summary: value.summary, evidence };
  if (value.completed_actions !== undefined) {
    if (!Array.isArray(value.completed_actions)
      || value.completed_actions.length > MAX_COMPLETED_ACTIONS) {
      throw new EvidenceBindingError('The executor result completed_actions must be a bounded array.');
    }
    snapshot.completed_actions = value.completed_actions;
  }
  // Force the same canonical validation used for the digest.
  canonicalEvidenceJson(snapshot);
  return snapshot;
}

export interface ExecutionIdentity {
  execution_id: string;
  task_id: string;
  agent_id: string;
  attempt: number;
}

function assertIdentity(identity: ExecutionIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (name === 'attempt') continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      throw new EvidenceBindingError(`The execution identity field "${name}" must be a bounded non-empty string.`);
    }
  }
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) {
    throw new EvidenceBindingError('The execution attempt must be a positive safe integer.');
  }
}

/** Digest binding one result snapshot to exactly one durable attempt. */
export function executionResultBinding(identity: ExecutionIdentity, result: unknown): string {
  assertIdentity(identity);
  const snapshot = snapshotExecutionResult(result);
  const serialized = canonicalEvidenceJson({
    schema_version: 1,
    execution_id: identity.execution_id,
    task_id: identity.task_id,
    agent_id: identity.agent_id,
    attempt: identity.attempt,
    result: snapshot,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

/** Stable digest of the attempt identity, recorded in verification evidence. */
export function executionIdentityBinding(identity: ExecutionIdentity): string {
  assertIdentity(identity);
  return createHash('sha256')
    .update(canonicalEvidenceJson({
      schema_version: 1,
      execution_id: identity.execution_id,
      task_id: identity.task_id,
      agent_id: identity.agent_id,
      attempt: identity.attempt,
    }))
    .digest('hex');
}

/** Strict evidence-line parser: no duplicate keys, no newline injection, bounded values. */
export function parseEvidenceEntries(evidence: readonly string[]): Map<string, string> {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new EvidenceBindingError(`Execution evidence must contain at most ${MAX_EVIDENCE_ITEMS} entries.`);
  }
  const entries = new Map<string, string>();
  for (const [index, line] of evidence.entries()) {
    if (typeof line !== 'string' || line.length === 0 || line.length > MAX_EVIDENCE_LINE) {
      throw new EvidenceBindingError(`Execution evidence entry ${index} must be a bounded non-empty string.`);
    }
    const match = EVIDENCE_LINE.exec(line);
    if (match === null) {
      throw new EvidenceBindingError(`Execution evidence entry ${index} is not a "key:value" line.`);
    }
    const [, key, value] = match as unknown as [string, string, string];
    if (entries.has(key)) {
      throw new EvidenceBindingError(`Execution evidence contains a duplicate "${key}" entry.`);
    }
    entries.set(key, value);
  }
  return entries;
}

export function isEvidenceDigest(value: string | undefined): value is string {
  return value !== undefined && DIGEST.test(value);
}

/** A per-invocation UUID that distinguishes otherwise byte-identical results across attempts. */
export function isExecutionNonce(value: string | undefined): value is string {
  return value !== undefined && EXECUTION_NONCE.test(value);
}

export function resultExecutionNonce(result: unknown): string | undefined {
  try {
    const matches = snapshotExecutionResult(result).evidence
      .filter((entry) => entry.startsWith('execution_nonce:'));
    if (matches.length !== 1) return undefined;
    const nonce = matches[0]?.slice('execution_nonce:'.length);
    return isExecutionNonce(nonce) ? nonce : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time comparison for two lowercase hex digests of equal length. */
export function evidenceDigestEquals(left: string, right: string): boolean {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export type { TaskExecutionResult };
