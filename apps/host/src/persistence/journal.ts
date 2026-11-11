import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { fsyncDirectory } from './fsync-directory.js';
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

const ARCHIVE_FORMAT = 'aios-operational-journal-archive';
const ARCHIVE_VERSION = 1;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export interface JournalArchiveSource {
  file_name: string;
  record_count: number;
  head_hash: string;
  bytes: number;
}

export interface JournalArchive {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  created_at: string;
  source: JournalArchiveSource;
  records: JournalRecord[];
  /** SHA-256 over the canonical archive body; detects edits to any record or header. */
  archive_sha256: string;
}

function archiveDigest(source: JournalArchiveSource, records: JournalRecord[]): string {
  return createHash('sha256')
    .update(canonicalJson({ version: ARCHIVE_VERSION, source, records }) ?? '')
    .digest('hex');
}

/** Validates an archive completely before any byte of it is trusted. */
export function validateJournalArchive(value: unknown): JournalArchive {
  if (!isRecord(value)
    || value.format !== ARCHIVE_FORMAT
    || value.version !== ARCHIVE_VERSION
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || !isRecord(value.source)
    || typeof value.source.file_name !== 'string' || value.source.file_name.length === 0
    || !Number.isSafeInteger(value.source.record_count) || (value.source.record_count as number) < 1
    || typeof value.source.head_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.source.head_hash)
    || !Number.isSafeInteger(value.source.bytes) || (value.source.bytes as number) < 1
    || !Array.isArray(value.records) || value.records.length === 0
    || typeof value.archive_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.archive_sha256)) {
    throw new JournalError('Journal archive has an unsupported or malformed header.');
  }
  const source = value.source as unknown as JournalArchiveSource;
  if (value.records.length !== source.record_count) {
    throw new JournalError('Journal archive record count does not match its manifest.');
  }
  let previousHash = ZERO_HASH;
  const records: JournalRecord[] = [];
  for (let index = 0; index < value.records.length; index += 1) {
    const record = validateRecord(value.records[index], index + 1, previousHash);
    records.push(record);
    previousHash = record.hash;
  }
  if (records[records.length - 1]?.hash !== source.head_hash) {
    throw new JournalError('Journal archive head hash does not match its records.');
  }
  if (archiveDigest(source, records) !== value.archive_sha256) {
    throw new JournalError('Journal archive digest verification failed.');
  }
  return { ...(value as unknown as JournalArchive), source, records };
}

/** Reads and verifies a journal file without repairing or truncating it. */
function readVerifiedJournalFile(filePath: string, maxBytes: number): JournalRecord[] {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > maxBytes) {
    throw new JournalError('Journal file must be a regular, unlinked file within the size limit.');
  }
  const contents = readFileSync(filePath);
  if (contents.length === 0) return [];
  if (contents[contents.length - 1] !== 0x0a) {
    throw new JournalError('Journal file ends with an incomplete record.');
  }
  const text = contents.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const records: JournalRecord[] = [];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index] ?? '');
    } catch {
      throw new JournalError('Journal file contains an unreadable record.');
    }
    const record = validateRecord(parsed, index + 1, previousHash);
    records.push(record);
    previousHash = record.hash;
  }
  return records;
}

function writeFileAtomically(filePath: string, contents: string): void {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, filePath);
  fsyncDirectory(dirname(filePath));
}

function acquireOfflineLock(lockPath: string): number {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      throw new JournalError('An unreadable journal lock exists; verify no AIOS host is running before removing it.');
    }
    if (!isRecord(existing) || !Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
      throw new JournalError('An invalid journal lock exists; refusing to remove it.');
    }
    let alive = true;
    try {
      process.kill(existing.pid as number, 0);
    } catch (processError) {
      alive = !isRecord(processError) || processError.code !== 'ESRCH';
    }
    if (alive) throw new JournalError('The operational journal is open in another process.');
    unlinkSync(lockPath);
    descriptor = openSync(lockPath, 'wx', 0o600);
  }
  writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
  fsyncSync(descriptor);
  return descriptor;
}

function releaseOfflineLock(lockPath: string, descriptor: number): void {
  try { closeSync(descriptor); } catch { /* best effort */ }
  try { unlinkSync(lockPath); } catch { /* best effort */ }
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

  /**
   * Writes a bounded, self-verifying archive of every record currently in the journal.
   * The archive is written atomically before any compaction touches the live file.
   */
  exportArchive(destinationPath: string): {
    path: string;
    archive_sha256: string;
    record_count: number;
    head_hash: string;
    bytes: number;
  } {
    this.assertOpen();
    if (typeof destinationPath !== 'string' || !isAbsolute(destinationPath)) {
      throw new JournalError('Journal archive path must be absolute.');
    }
    const destination = resolve(destinationPath);
    if (!existsSync(dirname(destination))) {
      throw new JournalError('Journal archive directory does not exist.');
    }
    const source: JournalArchiveSource = {
      file_name: basename(this.filePath),
      record_count: this.loaded.length,
      head_hash: this.lastHash,
      bytes: this.bytes,
    };
    const records = this.loaded.map((record) => structuredClone(record));
    const archive: JournalArchive = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      created_at: new Date().toISOString(),
      source,
      records,
      archive_sha256: archiveDigest(source, records),
    };
    const contents = JSON.stringify(archive);
    if (Buffer.byteLength(contents, 'utf8') > MAX_ARCHIVE_BYTES) {
      throw new JournalError('Journal archive exceeds the supported size limit.');
    }
    writeFileAtomically(destination, contents);
    chmodSync(destination, 0o600);
    return {
      path: destination,
      archive_sha256: archive.archive_sha256,
      record_count: source.record_count,
      head_hash: source.head_hash,
      bytes: source.bytes,
    };
  }

  /**
   * Exports the full history, then replaces the live journal with one snapshot record.
   *
   * The snapshot names the archive digest and the source chain head, so the compacted
   * journal still proves where its state came from even though the old records now live in
   * the archive. A failed export aborts before the live file is touched.
   */
  compactWithSnapshot(kind: string, payload: unknown, archivePath: string): {
    archive_sha256: string;
    archive_path: string;
    through_sequence: number;
    bytes_before: number;
    bytes_after: number;
    record_count: number;
  } {
    this.assertOpen();
    if (typeof kind !== 'string' || kind.length === 0 || kind.length > 120) {
      throw new JournalError('Journal snapshot kind is invalid.');
    }
    if (!isRecord(payload)) {
      throw new JournalError('Journal snapshot payload must be an object.');
    }
    const archive = this.exportArchive(archivePath);
    const throughSequence = this.sequence;
    const throughHash = this.lastHash;
    const snapshotPayload = {
      ...payload,
      compaction: {
        through_sequence: throughSequence,
        through_hash: throughHash,
        archive_sha256: archive.archive_sha256,
        archive_file: basename(archive.path),
      },
    };
    const unsigned = { sequence: 1, kind, payload: snapshotPayload, previous_hash: ZERO_HASH };
    const record: JournalRecord = { ...unsigned, hash: recordHash(unsigned) };
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line, 'utf8');
    if (length > this.maxBytes) {
      throw new JournalError('Compaction snapshot exceeds the journal size limit; archive it and recover with a larger limit.');
    }
    const temporary = `${this.filePath}.compact-${process.pid}-${randomUUID()}`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, line, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor);
      this.descriptor = undefined;
    }
    renameSync(temporary, this.filePath);
    fsyncDirectory(dirname(this.filePath));
    this.descriptor = openSync(this.filePath, 'a', 0o600);
    fsyncSync(this.descriptor);
    this.loaded.length = 0;
    this.loaded.push(record);
    this.sequence = 1;
    this.lastHash = record.hash;
    this.bytes = length;
    return {
      archive_sha256: archive.archive_sha256,
      archive_path: archive.path,
      through_sequence: throughSequence,
      bytes_before: archive.bytes,
      bytes_after: length,
      record_count: archive.record_count,
    };
  }

  /**
   * Offline export: validates an archive and installs it atomically. The host must be
   * stopped; the journal lock is taken so a live process cannot race the replacement.
   * Restoring the same archive twice is a verified no-op. A different valid journal is
   * never overwritten. A damaged target is preserved as a backup before recovery.
   */
  static restore(options: { filePath: string; archivePath: string; maxBytes?: number }): {
    restored: boolean;
    unchanged: boolean;
    record_count: number;
    head_hash: string;
    backup_path?: string;
  } {
    if (!isRecord(options as unknown)
      || typeof options.filePath !== 'string' || !isAbsolute(options.filePath)
      || typeof options.archivePath !== 'string' || !isAbsolute(options.archivePath)) {
      throw new JournalError('Restore requires absolute journal and archive paths.');
    }
    const filePath = resolve(options.filePath);
    const archivePath = resolve(options.archivePath);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
    const archiveStats = lstatSync(archivePath);
    if (!archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.size > MAX_ARCHIVE_BYTES) {
      throw new JournalError('Journal archive must be a regular file within the archive size limit.');
    }
    let archiveValue: unknown;
    try {
      archiveValue = JSON.parse(readFileSync(archivePath, 'utf8'));
    } catch {
      throw new JournalError('Journal archive is not readable JSON.');
    }
    const archive = validateJournalArchive(archiveValue);
    if (!existsSync(dirname(filePath))) {
      throw new JournalError('Restore target directory does not exist.');
    }
    const lockPath = `${filePath}.lock`;
    const lockDescriptor = acquireOfflineLock(lockPath);
    try {
      let backupPath: string | undefined;
      if (existsSync(filePath)) {
        let existing: JournalRecord[] | undefined;
        try {
          existing = readVerifiedJournalFile(filePath, maxBytes);
        } catch {
          existing = undefined;
        }
        if (existing !== undefined && existing.length > 0) {
          if (existing.length === archive.records.length
            && existing[existing.length - 1]?.hash === archive.source.head_hash) {
            return {
              restored: false,
              unchanged: true,
              record_count: archive.records.length,
              head_hash: archive.source.head_hash,
            };
          }
          throw new JournalError('Restore target contains a different valid journal; refusing to overwrite it.');
        }
        backupPath = `${filePath}.pre-restore-${Date.now()}`;
        renameSync(filePath, backupPath);
        chmodSync(backupPath, 0o600);
      }
      const contents = `${archive.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
      writeFileAtomically(filePath, contents);
      chmodSync(filePath, 0o600);
      const verified = readVerifiedJournalFile(filePath, maxBytes);
      if (verified.length !== archive.records.length
        || verified[verified.length - 1]?.hash !== archive.source.head_hash) {
        throw new JournalError('Restored journal failed verification.');
      }
      return {
        restored: true,
        unchanged: false,
        record_count: verified.length,
        head_hash: archive.source.head_hash,
        ...(backupPath === undefined ? {} : { backup_path: backupPath }),
      };
    } finally {
      releaseOfflineLock(lockPath, lockDescriptor);
    }
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
