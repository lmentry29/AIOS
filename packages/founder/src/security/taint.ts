import { randomUUID } from 'node:crypto';

/**
 * Explicit taint labels for content that entered AIOS from outside the host trust boundary.
 *
 * Taint is metadata, not sanitization. The caller must carry the mark with the value and
 * ask a sink policy before moving it to a lower-trust destination. Unknown labels, unknown
 * sinks, and failed declassification audits all fail closed.
 */
export const TAINT_LABELS = [
  'external_untrusted',
  'prompt_injection_risk',
  'connector_poisoning_risk',
] as const;

export type TaintLabel = (typeof TAINT_LABELS)[number];

const TAINT_LABEL_SET: ReadonlySet<string> = new Set(TAINT_LABELS);
const MAX_LABELS = TAINT_LABELS.length;
const MAX_SOURCES = 64;
const MAX_SOURCE_LENGTH = 1024;
const MAX_SINK_NAME = 128;
const MAX_REASON_LENGTH = 2000;

export interface TaintMark {
  readonly labels: readonly TaintLabel[];
  readonly sources: readonly string[];
}

export interface Tainted<T> {
  readonly value: T;
  readonly taint: TaintMark;
}

export class TaintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaintError';
  }
}

export class TaintSinkError extends TaintError {
  constructor(
    readonly code: 'unknown_sink' | 'blocked_label',
    message: string,
  ) {
    super(message);
    this.name = 'TaintSinkError';
  }
}

export class TaintDeclassificationError extends TaintError {
  constructor(
    readonly code: 'invalid_actor' | 'reason_required' | 'audit_failed',
    message: string,
  ) {
    super(message);
    this.name = 'TaintDeclassificationError';
  }
}

function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && /^human:[^\s:*]+$/.test(value);
}

function normalizeLabels(labels: readonly unknown[]): TaintLabel[] {
  const unique = new Set<TaintLabel>();
  for (const label of labels) {
    if (typeof label !== 'string' || !TAINT_LABEL_SET.has(label)) {
      throw new TaintError('Taint contains an unsupported label.');
    }
    unique.add(label as TaintLabel);
  }
  return TAINT_LABELS.filter((label) => unique.has(label));
}

function normalizeSources(sources: readonly unknown[]): string[] {
  if (sources.length > MAX_SOURCES) {
    throw new TaintError(`Taint contains more than ${MAX_SOURCES} sources.`);
  }
  const unique = new Set<string>();
  for (const source of sources) {
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_SOURCE_LENGTH) {
      throw new TaintError('Taint source identifiers must be non-empty bounded strings.');
    }
    unique.add(source);
  }
  return [...unique].sort();
}

export function taintMark(
  labels: readonly TaintLabel[] | readonly string[],
  sources: readonly string[],
): TaintMark {
  return Object.freeze({
    labels: Object.freeze(normalizeLabels(labels)),
    sources: Object.freeze(normalizeSources(sources)),
  });
}

export const EMPTY_TAINT: TaintMark = Object.freeze({
  labels: Object.freeze([] as TaintLabel[]),
  sources: Object.freeze([] as string[]),
});

export function mergeTaint(...marks: readonly (TaintMark | undefined)[]): TaintMark {
  const labels = new Set<TaintLabel>();
  const sources = new Set<string>();
  for (const mark of marks) {
    if (mark === undefined) continue;
    if (!Array.isArray(mark.labels) || !Array.isArray(mark.sources)) {
      throw new TaintError('Taint marks must contain labels and sources arrays.');
    }
    for (const label of normalizeLabels(mark.labels)) labels.add(label);
    for (const source of normalizeSources(mark.sources)) sources.add(source);
  }
  return taintMark([...labels], [...sources]);
}

export function taintValue<T>(
  value: T,
  labels: readonly TaintLabel[],
  sources: readonly string[],
): Tainted<T> {
  return Object.freeze({ value, taint: taintMark(labels, sources) });
}

export function mapTainted<T, R>(input: Tainted<T>, project: (value: T) => R): Tainted<R> {
  return Object.freeze({ value: project(input.value), taint: input.taint });
}

export interface TaintSinkPolicyOptions {
  /** Sink name to the labels that sink may receive. Unknown sinks are denied. */
  readonly allowed_labels: Readonly<Record<string, readonly TaintLabel[]>>;
}

/**
 * Fail-closed sink allow-list. A sink has to be named explicitly; there is no catch-all
 * sink and no label is allowed unless the exact sink lists it.
 */
export class TaintSinkPolicy {
  private readonly allowed = new Map<string, ReadonlySet<TaintLabel>>();

  constructor(options: TaintSinkPolicyOptions) {
    for (const [sink, labels] of Object.entries(options.allowed_labels)) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(sink)) {
        throw new TaintError('Taint sink names must be lowercase identifiers.');
      }
      this.allowed.set(sink, new Set(normalizeLabels(labels)));
    }
  }

  assertAllowed(mark: TaintMark, sink: string): void {
    if (typeof sink !== 'string' || sink.length === 0 || sink.length > MAX_SINK_NAME) {
      throw new TaintSinkError('unknown_sink', 'Taint sink name is invalid.');
    }
    const allowed = this.allowed.get(sink);
    if (allowed === undefined) {
      throw new TaintSinkError('unknown_sink', `Taint sink "${sink}" is not declared.`);
    }
    for (const label of normalizeLabels(mark.labels)) {
      if (!allowed.has(label)) {
        throw new TaintSinkError(
          'blocked_label',
          `Taint label "${label}" is not permitted at sink "${sink}".`,
        );
      }
    }
  }
}

export function assertTaintSink(
  mark: TaintMark,
  sink: string,
  policy: TaintSinkPolicy,
): void {
  policy.assertAllowed(mark, sink);
}

export interface TaintDeclassificationAuditRecord {
  event_id: string;
  actor_id: string;
  sink: string;
  labels: readonly TaintLabel[];
  sources: readonly string[];
  reason: string;
  timestamp: string;
}

/** Append-only audit sink. A declassification that cannot be audited must not happen. */
export interface TaintDeclassificationAudit {
  append(record: TaintDeclassificationAuditRecord): Promise<void>;
}

export class InMemoryTaintDeclassificationAudit implements TaintDeclassificationAudit {
  private readonly records: TaintDeclassificationAuditRecord[] = [];

  async append(record: TaintDeclassificationAuditRecord): Promise<void> {
    this.records.push(Object.freeze({
      ...record,
      labels: Object.freeze([...record.labels]),
      sources: Object.freeze([...record.sources]),
    }));
  }

  list(): TaintDeclassificationAuditRecord[] {
    return this.records.map((record) => ({
      ...record,
      labels: [...record.labels],
      sources: [...record.sources],
    }));
  }
}

export interface TaintDeclassificationRequest {
  actor_id: string;
  sink: string;
  reason: string;
}

/**
 * Removes taint only after a human actor supplies a reason and the audit append succeeds.
 * Audit failure rejects the declassification and the original tainted value remains the
 * only authoritative representation.
 */
export async function declassify<T>(
  input: Tainted<T>,
  request: TaintDeclassificationRequest,
  audit: TaintDeclassificationAudit,
): Promise<T> {
  if (!isHumanPrincipal(request.actor_id)) {
    throw new TaintDeclassificationError(
      'invalid_actor',
      'Only an authenticated human principal may declassify tainted content.',
    );
  }
  if (typeof request.sink !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(request.sink)) {
    throw new TaintDeclassificationError('reason_required', 'A valid sink is required.');
  }
  if (typeof request.reason !== 'string' || request.reason.trim().length === 0) {
    throw new TaintDeclassificationError('reason_required', 'A declassification reason is required.');
  }
  if (request.reason.length > MAX_REASON_LENGTH) {
    throw new TaintDeclassificationError(
      'reason_required',
      `The declassification reason exceeds ${MAX_REASON_LENGTH} characters.`,
    );
  }
  if (input.taint.labels.length === 0) return input.value;

  const record: TaintDeclassificationAuditRecord = {
    event_id: randomUUID(),
    actor_id: request.actor_id,
    sink: request.sink,
    labels: [...input.taint.labels],
    sources: [...input.taint.sources],
    reason: request.reason.trim(),
    timestamp: new Date().toISOString(),
  };
  try {
    await audit.append(record);
  } catch {
    throw new TaintDeclassificationError(
      'audit_failed',
      'Taint declassification was denied because its audit record could not be appended.',
    );
  }
  return input.value;
}

/** Maximum number of labels is exposed for callers that render or persist taint metadata. */
export const MAX_TAINT_LABELS = MAX_LABELS;
