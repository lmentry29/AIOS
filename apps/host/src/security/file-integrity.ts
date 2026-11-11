import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';

export type FileIntegrityFailure = 'missing' | 'not_regular' | 'too_large' | 'changed';

export class FileIntegrityError extends Error {
  constructor(
    readonly code: FileIntegrityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'FileIntegrityError';
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null;
}

/**
 * Reads a bounded regular file through one descriptor.
 *
 * `O_NOFOLLOW` refuses a final-component symlink, `fstat` binds the check to the opened
 * inode, and the descriptor is measured again after reading. This closes the lstat-then-
 * read replacement window for the file itself. Parent-directory replacement still requires
 * an OS-level `openat2`/`RESOLVE_BENEATH` primitive that portable Node does not expose.
 */
export function readBoundedRegularFile(
  path: string,
  label: string,
  maxBytes: number,
): Buffer {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new FileIntegrityError('missing', `The ${label} path is invalid.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new FileIntegrityError('too_large', `The ${label} size limit is invalid.`);
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new FileIntegrityError('not_regular', `The ${label} cannot be read safely because this platform has no no-follow open flag.`);
  }
  const resolved = resolve(path);
  let descriptor: number;
  try {
    descriptor = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (!isErrno(error)) throw error;
    if (error.code === 'ENOENT') {
      throw new FileIntegrityError('missing', `The ${label} does not exist: ${resolved}.`);
    }
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw new FileIntegrityError('not_regular', `The ${label} must be a regular file, not a symlink: ${resolved}.`);
    }
    throw error;
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new FileIntegrityError('not_regular', `The ${label} must be a regular file: ${resolved}.`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new FileIntegrityError('too_large', `The ${label} exceeds the ${maxBytes}-byte limit: ${resolved}.`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > maxBytes) {
        throw new FileIntegrityError('too_large', `The ${label} exceeds the ${maxBytes}-byte limit: ${resolved}.`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || total !== Number(after.size)
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new FileIntegrityError('changed', `The ${label} changed while it was being read: ${resolved}.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}
