import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { delimiter, resolve } from 'node:path';

/**
 * Provenance primitives for the gVisor runtime and its OCI rootfs.
 *
 * These functions deliberately do not trust a provider's claim that it used a
 * particular binary or rootfs. The caller hashes the executable and every rootfs entry
 * itself. The runtime pin is repository-owned data; a missing or malformed pin is an
 * error, never an "unverified but continue" state.
 */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

export interface GvisorRuntimePin {
  schema_version: 1;
  provider: 'gvisor';
  release: string;
  architecture: 'x86_64' | 'arm64';
  artifact: {
    url: string;
    sha512: string;
  };
  runsc: {
    version: string;
    sha256: string;
  };
}

export interface LoadedGvisorRuntimePin {
  pin: GvisorRuntimePin;
  pin_sha256: string;
  path: string;
}

export interface RootfsDigest {
  sha256: string;
  entries: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProvenanceError(`The gVisor runtime pin field "${field}" must be a non-empty string.`);
  }
  return value;
}

/** Stream a file through a hash without loading it all into memory. */
export function hashFile(path: string, algorithm: 'sha256' | 'sha512'): string {
  const hash = createHash(algorithm);
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = readSync(descriptor, buffer, 0, buffer.length, null);
    while (bytes > 0) {
      hash.update(buffer.subarray(0, bytes));
      bytes = readSync(descriptor, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function readGvisorRuntimePin(pinPath: string): LoadedGvisorRuntimePin {
  const path = resolve(pinPath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new ProvenanceError(`The gVisor runtime pin file does not exist: ${path}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProvenanceError(`The gVisor runtime pin must be a regular file, not a symlink: ${path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ProvenanceError(
      `The gVisor runtime pin is not valid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProvenanceError('The gVisor runtime pin must be a JSON object.');
  }
  if (parsed.schema_version !== 1) {
    throw new ProvenanceError('The gVisor runtime pin must declare schema_version 1.');
  }
  if (parsed.provider !== 'gvisor') {
    throw new ProvenanceError('The gVisor runtime pin must declare provider "gvisor".');
  }
  const release = requireString(parsed.release, 'release');
  const architecture = requireString(parsed.architecture, 'architecture');
  if (architecture !== 'x86_64' && architecture !== 'arm64') {
    throw new ProvenanceError('The gVisor runtime pin architecture must be x86_64 or arm64.');
  }
  if (!isRecord(parsed.artifact)) {
    throw new ProvenanceError('The gVisor runtime pin must contain an artifact object.');
  }
  if (!isRecord(parsed.runsc)) {
    throw new ProvenanceError('The gVisor runtime pin must contain a runsc object.');
  }
  const url = requireString(parsed.artifact.url, 'artifact.url');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProvenanceError('The gVisor runtime pin artifact.url must be an absolute URL.');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new ProvenanceError('The gVisor runtime pin artifact.url must use HTTPS.');
  }
  const artifactSha512 = requireString(parsed.artifact.sha512, 'artifact.sha512').toLowerCase();
  if (!SHA512_HEX.test(artifactSha512)) {
    throw new ProvenanceError('The gVisor runtime pin artifact.sha512 must be 128 lowercase hexadecimal characters.');
  }
  const version = requireString(parsed.runsc.version, 'runsc.version');
  const runscSha256 = requireString(parsed.runsc.sha256, 'runsc.sha256').toLowerCase();
  if (!SHA256_HEX.test(runscSha256)) {
    throw new ProvenanceError('The gVisor runtime pin runsc.sha256 must be 64 lowercase hexadecimal characters.');
  }

  return {
    pin: {
      schema_version: 1,
      provider: 'gvisor',
      release,
      architecture,
      artifact: { url, sha512: artifactSha512 },
      runsc: { version, sha256: runscSha256 },
    },
    pin_sha256: hashFile(path, 'sha256'),
    path,
  };
}

/** Verify a downloaded release archive against the repository pin. */
export function verifyPinnedArtifact(archivePath: string, expectedSha512: string): string {
  const actual = hashFile(archivePath, 'sha512');
  if (actual !== expectedSha512.toLowerCase()) {
    throw new ProvenanceError(
      `The gVisor runtime archive does not match the pinned SHA-512 (expected ${expectedSha512.toLowerCase()}, observed ${actual}).`,
    );
  }
  return actual;
}

/** Resolve the executable the provider will actually launch, without trusting PATH for the hash. */
export function resolveExecutable(name: string): string {
  const searchPath = process.env.PATH ?? '';
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, name);
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0) continue;
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new ProvenanceError(`The ${name} executable is not installed on PATH.`);
}

/**
 * Canonical content digest of a rootfs directory.
 *
 * Zero-byte framing includes the relative path, entry type, permission bits, file size,
 * file-content SHA-256, and symlink target. Timestamps, uid/gid, xattrs, and traversal
 * order are deliberately excluded so the manifest describes content rather than the
 * export container's metadata. Paths and names are sorted by code unit.
 */
export function digestRootfs(rootfs: string): RootfsDigest {
  const root = resolve(rootfs);
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ProvenanceError('The gVisor rootfs manifest requires a real directory, not a symlink.');
  }

  const hash = createHash('sha256');
  hash.update('AIOS-GVISOR-ROOTFS-MANIFEST-v1\0');
  let entries = 0;

  const walk = (absolute: string, relative: string): void => {
    const names = readdirSync(absolute).sort();
    for (const name of names) {
      const childAbsolute = resolve(absolute, name);
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const stats = lstatSync(childAbsolute);
      const mode = (stats.mode & 0o7777).toString(8);
      entries += 1;
      if (stats.isSymbolicLink()) {
        hash.update(`L\0${childRelative}\0${mode}\0${readlinkSync(childAbsolute)}\0`);
      } else if (stats.isDirectory()) {
        hash.update(`D\0${childRelative}\0${mode}\0`);
        walk(childAbsolute, childRelative);
      } else if (stats.isFile()) {
        hash.update(`F\0${childRelative}\0${mode}\0${stats.size}\0${hashFile(childAbsolute, 'sha256')}\0`);
      } else {
        hash.update(`O\0${childRelative}\0${mode}\0${stats.size}\0`);
      }
    }
  };

  walk(root, '');
  return { sha256: hash.digest('hex'), entries };
}
