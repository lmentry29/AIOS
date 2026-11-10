import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const ZERO_HASH = '0'.repeat(64);

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

export interface JournalRecord {
  sequence: number;
  kind: string;
  payload: unknown;
  previous_hash: string;
  hash: string;
}

export interface AppendOnlyJournalOptions {
  /** Absolute path to the journal file inside an owner-only directory. */
  filePath: string;
  maxBytes?: number;
}

/**
 * Deterministic JSON with sorted keys, matching what `JSON.stringify` actually writes:
 * object properties whose value is `undefined` are omitted, and `undefined` array items
 * become `null`. Hashing a shape that serialization then changes would make every reload
 * look like tampering.
 */
function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
      .map(([key, json]) => `${JSON.stringify(key)}:${json}`);
    return `{${entries.join(',')}}`;
  }
  if (value === undefined) return undefined;
  return JSON.stringify(value) as string;
}

function recordHash(record: Omit<JournalRecord, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(record) ?? '').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRecord(value: unknown, expectedSequence: number, previousHash: string): JournalRecord {
  if (!isRecord(value)
    || value.sequence !== expectedSequence
    || typeof value.kind !== 'string' || value.kind.length === 0 || value.kind.length > 120
    || value.previous_hash !== previousHash
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
    || !('payload' in value)) {
    throw new JournalError('Operational journal contains a malformed or out-of-sequence record.');
  }
  const record = value as unknown as JournalRecord;
  const { hash, ...unsigned } = record;
  if (recordHash(unsigned) !== hash) {
    throw new JournalError('Operational journal hash-chain verification failed.');
  }
  return record;
}

/**
 * Crash-safe append-only journal for operational state.
 *
 * Design properties:
 * - One JSON record per line, fsync'd before `append()` returns. A write that was accepted
 *   is durable; a write interrupted by a crash is not observed as accepted.
 * - A torn tail (bytes after the last newline) is truncated on open. That is the only
 *   recovery action: a *complete* line that fails validation is treated as corruption and
 *   fails closed, because silently dropping committed operational history would be worse
 *   than refusing to start.
 * - Every record carries a SHA-256 hash over its canonical JSON plus the previous record's
 *   hash, so out-of-band edits and reordering are detected on open.
 * - A single-process lock (with stale-lock recovery) prevents two hosts from appending to
 *   the same journal. Multi-process concurrency is not supported by this substrate and is
 *   recorded as an explicit limitation in ADR-0015.
 *
 * The journal is the authority for recovery. Repository and run records are replayed through
 * validated restore paths, never re-executed, so timestamps and lifecycle history cannot
 * change on restart.
 */
export class AppendOnlyJournal {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly maxBytes: number;
  private descriptor: number | undefined;
  private lockDescriptor: number | undefined;
  private ownsLock = false;
  private closed = false;
  private lastHash = ZERO_HASH;
  private sequence = 0;
  private bytes = 0;
  private tornTailDiscarded = false;
  private readonly loaded: JournalRecord[] = [];

  constructor(options: AppendOnlyJournalOptions) {
    if (!options || typeof options.filePath !== 'string' || !isAbsolute(options.filePath)) {
      throw new JournalError('Operational journal path must be an absolute file path.');
    }
    const requested = resolve(options.filePath);
    const directory = dirname(requested);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = realpathSync(directory);
    if (!lstatSync(canonicalDirectory).isDirectory()) {
      throw new JournalError('Operational journal parent must be a directory.');
    }
    chmodSync(canonicalDirectory, 0o700);
    this.filePath = join(canonicalDirectory, basename(requested));
    this.lockPath = `${this.filePath}.lock`;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 4096) {
      throw new JournalError('Operational journal size limit is invalid.');
    }
    try {
      this.acquireLock();
      this.load();
      this.descriptor = openSync(this.filePath, 'a', 0o600);
      fsyncSync(this.descriptor);
    } catch (error) {
      this.releaseLock();
      if (this.descriptor !== undefined) {
        try { closeSync(this.descriptor); } catch { /* best effort */ }
        this.descriptor = undefined;
      }
      throw error;
    }
  }

  /** True when an interrupted final write was discarded during recovery. */
  get recoveredTornTail(): boolean {
    return this.tornTailDiscarded;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  read(): readonly JournalRecord[] {
    this.assertOpen();
    return this.loaded.map((record) => structuredClone(record));
  }

  append(kind: string, payload: unknown): JournalRecord {
    this.assertOpen();
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > 120) {
      throw new JournalError('Journal record kind is invalid.');
    }
    const unsigned = {
      sequence: this.sequence + 1,
      kind,
      payload,
      previous_hash: this.lastHash,
    };
    const record: JournalRecord = { ...unsigned, hash: recordHash(unsigned) };
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line, 'utf8');
    if (length > MAX_RECORD_BYTES) {
      throw new JournalError('Journal record exceeds the per-record size limit.');
    }
    if (this.bytes + length > this.maxBytes) {
      throw new JournalError('Operational journal reached its size limit; compaction is required before more state can be written.');
    }
    if (this.descriptor === undefined) throw new JournalError('Operational journal is not open for writing.');
    writeFileSync(this.descriptor, line, 'utf8');
    fsyncSync(this.descriptor);
    this.bytes += length;
    this.sequence = record.sequence;
    this.lastHash = record.hash;
    this.loaded.push(record);
    return structuredClone(record);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.descriptor !== undefined) {
      try { closeSync(this.descriptor); } catch { /* best effort */ }
      this.descriptor = undefined;
    }
    this.releaseLock();
  }

  private assertOpen(): void {
    if (this.closed) throw new JournalError('Operational journal is closed.');
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const stats = lstatSync(this.filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > this.maxBytes) {
      throw new JournalError('Operational journal must be a regular, unlinked file within the size limit.');
    }
    chmodSync(this.filePath, 0o600);

    let contents = readFileSync(this.filePath);
    if (contents.length > 0 && contents[contents.length - 1] !== 0x0a) {
      // Only the unterminated tail may be discarded: a completed append always ends with a
      // newline before fsync returns. Everything before it stays authoritative.
      const lastNewline = contents.lastIndexOf(0x0a);
      const retained = lastNewline + 1;
      truncateSync(this.filePath, retained);
      const recoveryDescriptor = openSync(this.filePath, 'r+');
      try {
        fsyncSync(recoveryDescriptor);
      } finally {
        closeSync(recoveryDescriptor);
      }
      contents = contents.subarray(0, retained);
      this.tornTailDiscarded = true;
    }
    this.bytes = contents.length;

    const text = contents.toString('utf8');
    if (text.length === 0) return;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let previousHash = ZERO_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) throw new JournalError('Operational journal contains an empty record.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new JournalError('Operational journal contains an unreadable record.');
      }
      const record = validateRecord(parsed, index + 1, previousHash);
      this.loaded.push(record);
      previousHash = record.hash;
    }
    const last = this.loaded[this.loaded.length - 1];
    this.sequence = last?.sequence ?? 0;
    this.lastHash = last?.hash ?? ZERO_HASH;
  }

  private acquireLock(): void {
    let descriptor: number;
    try {
      descriptor = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      let existing: unknown;
      try {
        existing = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      } catch {
        throw new JournalError('An unreadable operational-store lock exists; verify no AIOS host is running before removing it.');
      }
      if (!isRecord(existing) || !Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
        throw new JournalError('An invalid operational-store lock exists; refusing to remove it.');
      }
      let alive = true;
      try {
        process.kill(existing.pid as number, 0);
      } catch (processError) {
        alive = !isRecord(processError) || processError.code !== 'ESRCH';
      }
      if (alive) throw new JournalError('The operational store is already open in another process.');
      unlinkSync(this.lockPath);
      descriptor = openSync(this.lockPath, 'wx', 0o600);
    }
    this.lockDescriptor = descriptor;
    this.ownsLock = true;
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
    fsyncSync(descriptor);
  }

  private releaseLock(): void {
    if (this.lockDescriptor !== undefined) {
      try { closeSync(this.lockDescriptor); } catch { /* best effort */ }
      this.lockDescriptor = undefined;
    }
    if (this.ownsLock) {
      try { unlinkSync(this.lockPath); } catch { /* best effort */ }
      this.ownsLock = false;
    }
  }
}
