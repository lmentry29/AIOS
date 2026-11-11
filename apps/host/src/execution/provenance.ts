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

export interface GvisorRootfsBuildPin {
  schema_version: 1;
  provider: 'gvisor';
  base_image: {
    reference: string;
    digest: string;
    platform_digest_amd64: string;
  };
  apt_snapshot: {
    base_url: string;
    timestamp: string;
    suites: {
      bookworm: 'debian';
      'bookworm-updates': 'debian';
      'bookworm-security': 'debian-security';
    };
  };
  packages: Record<string, string>;
  dockerfile: string;
  excluded_paths: string[];
  construction: string;
}

export interface LoadedGvisorRootfsBuildPin {
  pin: GvisorRootfsBuildPin;
  pin_sha256: string;
  path: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_DIGEST_HEX = /^sha256:[0-9a-f]{64}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const SNAPSHOT_TIMESTAMP = /^[0-9]{8}T[0-9]{6}Z$/;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*$/;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProvenanceError(`The gVisor runtime pin field "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireRootfsString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProvenanceError(`The gVisor rootfs build pin field "${field}" must be a non-empty string.`);
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

/** Read and validate the immutable inputs used to build the gVisor drill rootfs. */
export function readGvisorRootfsBuildPin(pinPath: string): LoadedGvisorRootfsBuildPin {
  const path = resolve(pinPath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new ProvenanceError(`The gVisor rootfs build pin file does not exist: ${path}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProvenanceError(`The gVisor rootfs build pin must be a regular file, not a symlink: ${path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ProvenanceError(
      `The gVisor rootfs build pin is not valid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProvenanceError('The gVisor rootfs build pin must be a JSON object.');
  }
  if (parsed.schema_version !== 1) {
    throw new ProvenanceError('The gVisor rootfs build pin must declare schema_version 1.');
  }
  if (parsed.provider !== 'gvisor') {
    throw new ProvenanceError('The gVisor rootfs build pin must declare provider "gvisor".');
  }

  if (!isRecord(parsed.base_image)) {
    throw new ProvenanceError('The gVisor rootfs build pin must contain a base_image object.');
  }
  const reference = requireRootfsString(parsed.base_image.reference, 'base_image.reference');
  if (!/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(reference)) {
    throw new ProvenanceError('The gVisor rootfs build pin base_image.reference must be a repository image reference.');
  }
  const digest = requireRootfsString(parsed.base_image.digest, 'base_image.digest').toLowerCase();
  if (!SHA256_DIGEST_HEX.test(digest)) {
    throw new ProvenanceError('The gVisor rootfs build pin base_image.digest must be a sha256:<64 hex> digest.');
  }
  const platformDigest = requireRootfsString(parsed.base_image.platform_digest_amd64, 'base_image.platform_digest_amd64').toLowerCase();
  if (!SHA256_DIGEST_HEX.test(platformDigest)) {
    throw new ProvenanceError('The gVisor rootfs build pin base_image.platform_digest_amd64 must be a sha256:<64 hex> digest.');
  }

  if (!isRecord(parsed.apt_snapshot)) {
    throw new ProvenanceError('The gVisor rootfs build pin must contain an apt_snapshot object.');
  }
  const baseUrl = requireRootfsString(parsed.apt_snapshot.base_url, 'apt_snapshot.base_url');
  if (baseUrl !== 'http://snapshot.debian.org/archive' && baseUrl !== 'https://snapshot.debian.org/archive') {
    throw new ProvenanceError('The gVisor rootfs build pin apt_snapshot.base_url must be the snapshot.debian.org archive.');
  }
  const timestamp = requireRootfsString(parsed.apt_snapshot.timestamp, 'apt_snapshot.timestamp');
  if (!SNAPSHOT_TIMESTAMP.test(timestamp)) {
    throw new ProvenanceError('The gVisor rootfs build pin apt_snapshot.timestamp must use YYYYMMDDTHHMMSSZ.');
  }
  if (!isRecord(parsed.apt_snapshot.suites)) {
    throw new ProvenanceError('The gVisor rootfs build pin must contain apt_snapshot.suites.');
  }
  const suites = parsed.apt_snapshot.suites;
  if (suites.bookworm !== 'debian'
    || suites['bookworm-updates'] !== 'debian'
    || suites['bookworm-security'] !== 'debian-security') {
    throw new ProvenanceError(
      'The gVisor rootfs build pin apt_snapshot.suites must map bookworm and bookworm-updates to debian and bookworm-security to debian-security.',
    );
  }

  if (!isRecord(parsed.packages)) {
    throw new ProvenanceError('The gVisor rootfs build pin must contain a packages object.');
  }
  const packages: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.packages)) {
    if (!PACKAGE_NAME.test(name)) {
      throw new ProvenanceError(`The gVisor rootfs build pin package name is invalid: ${name}.`);
    }
    const version = requireRootfsString(value, `packages.${name}`);
    if (!PACKAGE_VERSION.test(version)) {
      throw new ProvenanceError(`The gVisor rootfs build pin package version is invalid: ${name}=${version}.`);
    }
    packages[name] = version;
  }
  for (const required of ['coreutils', 'perl', 'util-linux']) {
    if (packages[required] === undefined) {
      throw new ProvenanceError(`The gVisor rootfs build pin must pin ${required}.`);
    }
  }

  const dockerfile = requireRootfsString(parsed.dockerfile, 'dockerfile');
  if (Array.isArray(parsed.excluded_paths) === false
    || parsed.excluded_paths.some((entry) => typeof entry !== 'string' || !entry.startsWith('/'))) {
    throw new ProvenanceError('The gVisor rootfs build pin excluded_paths must be absolute paths.');
  }
  const construction = requireRootfsString(parsed.construction, 'construction');

  return {
    pin: {
      schema_version: 1,
      provider: 'gvisor',
      base_image: { reference, digest, platform_digest_amd64: platformDigest },
      apt_snapshot: {
        base_url: baseUrl,
        timestamp,
        suites: {
          bookworm: 'debian',
          'bookworm-updates': 'debian',
          'bookworm-security': 'debian-security',
        },
      },
      packages,
      dockerfile,
      excluded_paths: parsed.excluded_paths as string[],
      construction,
    },
    pin_sha256: hashFile(path, 'sha256'),
    path,
  };
}

/** Require the Dockerfile to use exactly the pinned base, snapshot and package versions. */
export function verifyGvisorRootfsBuildInputs(pin: GvisorRootfsBuildPin, dockerfilePath: string): void {
  const path = resolve(dockerfilePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new ProvenanceError(`The gVisor rootfs Dockerfile does not exist: ${path}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProvenanceError(`The gVisor rootfs Dockerfile must be a regular file, not a symlink: ${path}.`);
  }
  const contents = readFileSync(path, 'utf8');

  const froms = [...contents.matchAll(/^FROM\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const expectedBase = `${pin.base_image.reference}@${pin.base_image.digest}`;
  if (froms.length !== 1 || froms[0] !== expectedBase) {
    throw new ProvenanceError(
      `The gVisor rootfs Dockerfile must use the pinned base image ${expectedBase}, observed ${froms.join(', ') || 'none'}.`,
    );
  }

  const flattened = contents.replace(/\\\r?\n/g, ' ');
  const install = /apt-get\s+install\b([^;&]+)/.exec(flattened);
  const installArgs = install?.[1];
  if (installArgs === undefined) {
    throw new ProvenanceError('The gVisor rootfs Dockerfile must contain an apt-get install command.');
  }
  const observedPackages: Record<string, string> = {};
  for (const token of installArgs.trim().split(/\s+/).filter((entry) => entry.length > 0 && !entry.startsWith('-'))) {
    const separator = token.indexOf('=');
    if (separator <= 0 || separator === token.length - 1) {
      throw new ProvenanceError(`The gVisor rootfs Dockerfile must pin ${token} to an exact version.`);
    }
    observedPackages[token.slice(0, separator)] = token.slice(separator + 1);
  }
  const expectedNames = Object.keys(pin.packages).sort();
  const observedNames = Object.keys(observedPackages).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(observedNames)) {
    throw new ProvenanceError(
      `The gVisor rootfs Dockerfile package set does not match the pin (expected ${expectedNames.join(', ')}, observed ${observedNames.join(', ')}).`,
    );
  }
  for (const name of expectedNames) {
    if (observedPackages[name] !== pin.packages[name]) {
      throw new ProvenanceError(
        `The gVisor rootfs Dockerfile package ${name} does not match the pin (expected ${pin.packages[name]}, observed ${observedPackages[name]}).`,
      );
    }
  }

  const expectedSources = Object.entries(pin.apt_snapshot.suites).map(
    ([suite, archive]) => `${pin.apt_snapshot.base_url}/${archive}/${pin.apt_snapshot.timestamp} ${suite}`,
  );
  for (const source of expectedSources) {
    if (!contents.includes(source)) {
      throw new ProvenanceError(`The gVisor rootfs Dockerfile does not use the pinned snapshot source: ${source}.`);
    }
  }
  const observedTimestamps = [...contents.matchAll(/snapshot\.debian\.org\/archive\/(?:debian|debian-security)\/([^/\s]+)/g)]
    .map((match) => match[1]);
  if (observedTimestamps.length !== expectedSources.length
    || observedTimestamps.some((entry) => entry !== pin.apt_snapshot.timestamp)) {
    throw new ProvenanceError(
      `The gVisor rootfs Dockerfile snapshot timestamps do not match the pin (expected ${pin.apt_snapshot.timestamp}, observed ${observedTimestamps.join(', ') || 'none'}).`,
    );
  }

  for (const excluded of pin.excluded_paths) {
    if (!contents.includes(excluded)) {
      throw new ProvenanceError(`The gVisor rootfs Dockerfile does not remove excluded path ${excluded}.`);
    }
  }
}

/** Require two measured rootfs exports to agree exactly. */
export function assertReproducibleRootfs(first: RootfsDigest, second: RootfsDigest): void {
  if (first.sha256 !== second.sha256 || first.entries !== second.entries) {
    throw new ProvenanceError(
      `The gVisor rootfs export is not reproducible (first ${first.sha256}/${first.entries} entries, second ${second.sha256}/${second.entries}).`,
    );
  }
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
