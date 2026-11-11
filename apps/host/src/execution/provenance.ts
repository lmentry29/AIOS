import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

/**
 * Canonical rootfs measurement.
 *
 * Manifest v2 hashes the entry path, type, permission bits (including setuid/setgid/sticky),
 * owner uid/gid, file size, file-content SHA-256, symlink target and extended attributes.
 * `content_sha256` preserves the v1 content-only algorithm so earlier evidence remains
 * comparable; `timestamps_sha256` attests mtime separately because Docker export does not
 * produce byte-identical directory timestamps across independent image builds.
 */
export interface RootfsDigest {
  manifest_version: 2;
  sha256: string;
  entries: number;
  content_sha256: string;
  metadata_sha256: string;
  timestamps_sha256: string;
  xattrs: 'captured' | 'unavailable';
}

/** A digest, or a legacy two-field digest that predates manifest v2. */
export type RootfsDigestLike = Pick<RootfsDigest, 'sha256' | 'entries'> & Partial<Pick<
  RootfsDigest,
  'content_sha256' | 'metadata_sha256' | 'timestamps_sha256' | 'xattrs'
>>;

export interface RootfsDigestOptions {
  /**
   * `auto` records whether extended attributes were readable; `required` fails closed when
   * no reader is installed; `skip` deliberately records the omission.
   */
  xattrs?: 'auto' | 'required' | 'skip';
}

export interface MaterializedExecutable {
  path: string;
  source: string;
  sha256: string;
  device: number;
  inode: number;
  size: number;
}

/** A directory created by this invocation, identified by inode for ownership-safe cleanup. */
export interface OwnedDirectory {
  path: string;
  device: number;
  inode: number;
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
  // The platform digest is the manifest the amd64 build actually resolves to. Pinning the
  // manifest list alone leaves the per-platform manifest unpinned, so the Dockerfile must
  // name the platform digest and CI proves it is a child of the pinned index.
  const expectedBase = `${pin.base_image.reference}@${pin.base_image.platform_digest_amd64}`;
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

/**
 * Create a private staging directory next to its eventual destination. The parent must be a
 * real directory, not a symlink, and the staging path is unique to this invocation.
 */
export function createOwnedStagingDirectory(parent: string, prefix: string): OwnedDirectory {
  const root = resolve(parent);
  let parentStats: ReturnType<typeof lstatSync>;
  try {
    parentStats = lstatSync(root);
  } catch {
    throw new ProvenanceError(`The staging parent does not exist: ${root}.`);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new ProvenanceError(`The staging parent must be a real directory, not a symlink: ${root}.`);
  }
  const path = mkdtempSync(join(root, prefix));
  const stats = lstatSync(path);
  return { path, device: stats.dev, inode: stats.ino };
}

/**
 * Remove only the directory this invocation created. If the path was replaced by a symlink
 * or a different inode, leave it untouched; cleanup must never recurse over operator state.
 */
export function removeOwnedDirectory(directory: OwnedDirectory): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(directory.path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  if (stats.dev !== directory.device || stats.ino !== directory.inode) return;
  rmSync(directory.path, { recursive: true, force: true });
}

/** Reject an existing output before any expensive extraction or Docker work begins. */
export function assertDestinationAbsent(destination: string): void {
  const target = resolve(destination);
  try {
    lstatSync(target);
    throw new ProvenanceError(`Refusing to overwrite an existing gVisor output: ${target}.`);
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Promote a completed staging directory without replacing an existing destination. The
 * source inode is checked immediately before rename; cleanup remains restricted to the
 * staging path and never touches the promoted output.
 */
export function promoteOwnedDirectory(directory: OwnedDirectory, destination: string): void {
  const target = resolve(destination);
  if (target === directory.path) {
    throw new ProvenanceError('The staging directory cannot be its own promotion destination.');
  }
  const parent = dirname(target);
  let parentStats: ReturnType<typeof lstatSync>;
  try {
    parentStats = lstatSync(parent);
  } catch {
    throw new ProvenanceError(`The promotion parent does not exist: ${parent}.`);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new ProvenanceError(`The promotion parent must be a real directory, not a symlink: ${parent}.`);
  }
  try {
    const destinationStats = lstatSync(target);
    if (destinationStats.isSymbolicLink() || destinationStats.isDirectory() || destinationStats.isFile()) {
      throw new ProvenanceError(`Refusing to replace an existing gVisor output: ${target}.`);
    }
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stats = lstatSync(directory.path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ProvenanceError(`The staged output is not a real directory: ${directory.path}.`);
  }
  if (stats.dev !== directory.device || stats.ino !== directory.inode) {
    throw new ProvenanceError(`The staged output was replaced during preparation: ${directory.path}.`);
  }
  renameSync(directory.path, target);
}

function digestMismatches(first: RootfsDigestLike, second: RootfsDigestLike, timestamps: boolean): string[] {
  const mismatched: string[] = [];
  if (first.sha256 !== second.sha256) mismatched.push(`sha256 ${first.sha256}/${second.sha256}`);
  if (first.entries !== second.entries) mismatched.push(`entries ${first.entries}/${second.entries}`);
  if (first.content_sha256 !== undefined && second.content_sha256 !== undefined
    && first.content_sha256 !== second.content_sha256) {
    mismatched.push(`content_sha256 ${first.content_sha256}/${second.content_sha256}`);
  }
  if (first.metadata_sha256 !== undefined && second.metadata_sha256 !== undefined
    && first.metadata_sha256 !== second.metadata_sha256) {
    mismatched.push(`metadata_sha256 ${first.metadata_sha256}/${second.metadata_sha256}`);
  }
  if (first.xattrs !== undefined && second.xattrs !== undefined && first.xattrs !== second.xattrs) {
    mismatched.push(`xattrs ${first.xattrs}/${second.xattrs}`);
  }
  if (timestamps
    && first.timestamps_sha256 !== undefined && second.timestamps_sha256 !== undefined
    && first.timestamps_sha256 !== second.timestamps_sha256) {
    mismatched.push(`timestamps_sha256 ${first.timestamps_sha256}/${second.timestamps_sha256}`);
  }
  return mismatched;
}

/**
 * Require two measured rootfs exports to agree exactly.
 *
 * Timestamps are asserted only where the comparison is expected to be timestamp-stable
 * (two exports of the same image). Independent builds legitimately differ in directory
 * mtimes because Docker export does not normalize them.
 */
export function assertReproducibleRootfs(
  first: RootfsDigestLike,
  second: RootfsDigestLike,
  detail = '',
  options: { timestamps?: boolean } = {},
): void {
  const mismatched = digestMismatches(first, second, options.timestamps === true);
  if (mismatched.length > 0) {
    throw new ProvenanceError(`The gVisor rootfs export is not reproducible (${mismatched.join('; ')}).${detail}`);
  }
}

/**
 * Require the rootfs handed to the runtime to be unchanged after execution. A change means
 * the result is not bound to the artifact whose digest was attested, so it is rejected.
 */
export function assertRootfsUnchanged(before: RootfsDigestLike, after: RootfsDigestLike): void {
  const mismatched = digestMismatches(before, after, true);
  if (mismatched.length > 0) {
    throw new ProvenanceError(
      `The gVisor rootfs changed while the sandbox was running (${mismatched.join('; ')}); the result is not bound to the verified artifact.`,
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
 * Copy a verified executable into a private directory and measure the copy.
 *
 * The provider executes this copy, not the PATH-resolved original, so replacing the original
 * after verification cannot change the bytes that run. The directory must be owned by this
 * invocation, not a symlink, and not group- or world-writable.
 */
export function materializeVerifiedExecutable(
  source: string,
  expectedSha256: string,
  directory: OwnedDirectory,
): MaterializedExecutable {
  const resolved = resolve(source);
  const directoryStats = lstatSync(directory.path);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new ProvenanceError(`The private executable directory is not a real directory: ${directory.path}.`);
  }
  if (directoryStats.dev !== directory.device || directoryStats.ino !== directory.inode) {
    throw new ProvenanceError(`The private executable directory was replaced during preparation: ${directory.path}.`);
  }
  if ((directoryStats.mode & 0o022) !== 0) {
    throw new ProvenanceError('The private executable directory must not be group- or world-writable.');
  }
  const sourceStats = lstatSync(resolved);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new ProvenanceError(`The verified executable must be a regular file, not a symlink: ${resolved}.`);
  }
  const target = join(directory.path, 'runsc');
  try {
    lstatSync(target);
    throw new ProvenanceError(`The private executable path already exists: ${target}.`);
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  copyFileSync(resolved, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
  try {
    chmodSync(target, 0o500);
    const sha256 = hashFile(target, 'sha256');
    if (sha256 !== expectedSha256.toLowerCase()) {
      throw new ProvenanceError(
        `The materialized gVisor runsc does not match the verified SHA-256 (expected ${expectedSha256.toLowerCase()}, observed ${sha256}).`,
      );
    }
    const stats = lstatSync(target);
    return { path: target, source: resolved, sha256, device: stats.dev, inode: stats.ino, size: stats.size };
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
}

/**
 * Re-measure the materialized executable immediately before execution. A replaced inode, a
 * changed size, a writable copy, or different bytes all fail closed. The remaining window is
 * confined to a directory only the invoking user can write, which is inside the host trust
 * boundary rather than the PATH search path.
 */
export function assertMaterializedExecutableUnchanged(executable: MaterializedExecutable): void {
  const stats = lstatSync(executable.path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProvenanceError(`The materialized gVisor runsc is not a regular file: ${executable.path}.`);
  }
  if (stats.dev !== executable.device || stats.ino !== executable.inode || stats.size !== executable.size) {
    throw new ProvenanceError(`The materialized gVisor runsc was replaced after verification: ${executable.path}.`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new ProvenanceError(`The materialized gVisor runsc became writable after verification: ${executable.path}.`);
  }
  if (hashFile(executable.path, 'sha256') !== executable.sha256) {
    throw new ProvenanceError(`The materialized gVisor runsc changed after verification: ${executable.path}.`);
  }
}

/** Select the single linux/amd64 manifest digest from a pinned OCI image index. */
export function selectPlatformManifestDigest(index: unknown, os: string, architecture: string): string {
  if (!isRecord(index)) {
    throw new ProvenanceError('The OCI image index must be a JSON object.');
  }
  const manifests = index.manifests;
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new ProvenanceError('The OCI image index must contain a non-empty manifests array.');
  }
  const matches: string[] = [];
  for (const entry of manifests) {
    if (!isRecord(entry) || !isRecord(entry.platform)) continue;
    if (entry.platform.os !== os || entry.platform.architecture !== architecture) continue;
    const digest = entry.digest;
    if (typeof digest !== 'string' || !SHA256_DIGEST_HEX.test(digest)) {
      throw new ProvenanceError('The OCI image index platform entry has no valid sha256 digest.');
    }
    matches.push(digest);
  }
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    throw new ProvenanceError(
      `The OCI image index must contain exactly one ${os}/${architecture} manifest, observed ${matches.length}.`,
    );
  }
  return only;
}

const XATTR_READER = 'getfattr';
const XATTR_NAME = /^[A-Za-z0-9_.:@-]+$/;

interface XattrTable {
  available: boolean;
  entries: Map<string, string[]>;
}

/**
 * Read extended attributes for every entry under `root` through `getfattr`.
 *
 * Node exposes no extended-attribute API, so the reader is an external tool. When it is not
 * installed the manifest records `xattrs: 'unavailable'`; a caller that requires completeness
 * asks for `required` and fails closed instead of silently omitting attestation.
 */
function readXattrTable(root: string): XattrTable {
  // `-h` is required: without it getfattr dereferences symlinks and would read host
  // attributes through absolute symlink targets inside the rootfs. `-m` is not used
  // because GNU getfattr treats it as a regular expression, not a glob.
  const result = spawnSync(XATTR_READER, ['-R', '-h', '-d', '.'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, entries: new Map() };
    }
    throw new ProvenanceError(`The extended-attribute reader failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // GNU getfattr reports `Operation not supported` for entries that cannot carry the
    // requested attributes (symlinks on ext4/overlayfs). That is an empty attribute set,
    // not an incomplete measurement. Any other reader error fails closed.
    const errors = (result.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const onlyUnsupported = errors.length > 0
      && errors.every((line) => /: Operation not supported$/.test(line));
    if (!onlyUnsupported) {
      const detail = errors[0] ?? 'no output';
      throw new ProvenanceError(`The extended-attribute reader exited ${result.status ?? 'unknown'}: ${detail.slice(0, 200)}`);
    }
  }
  const entries = new Map<string, string[]>();
  let current: string | undefined;
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith('# file: ')) {
      const path = line.slice('# file: '.length).replace(/^\.\//, '');
      current = path === '.' ? '' : path;
      continue;
    }
    const separator = line.indexOf('=');
    if (current === undefined || separator <= 0 || !XATTR_NAME.test(line.slice(0, separator))) {
      throw new ProvenanceError(`The extended-attribute listing could not be parsed: ${line.slice(0, 120)}.`);
    }
    const list = entries.get(current) ?? [];
    list.push(line);
    entries.set(current, list);
  }
  for (const list of entries.values()) list.sort();
  return { available: true, entries };
}

/**
 * Canonical content-and-metadata digest of a rootfs directory (manifest v2).
 *
 * Zero-byte framing includes the relative path, entry type, permission bits, uid, gid, file
 * size, file-content SHA-256, symlink target and extended attributes. Paths are sorted by
 * code unit so traversal order cannot affect the digest. Modification time is hashed
 * separately in `timestamps_sha256`; atime and ctime are excluded because reading the tree
 * changes atime and ctime is not reproducible across exports. See
 * docs/security/rootfs-metadata-attestation.md for the normalization rationale.
 */
export function digestRootfs(rootfs: string, options: RootfsDigestOptions = {}): RootfsDigest {
  const root = resolve(rootfs);
  const rootStats = lstatSync(root, { bigint: true });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new ProvenanceError('The gVisor rootfs manifest requires a real directory, not a symlink.');
  }

  const xattrMode = options.xattrs ?? 'auto';
  const table: XattrTable = xattrMode === 'skip'
    ? { available: false, entries: new Map() }
    : readXattrTable(root);
  if (xattrMode === 'required' && !table.available) {
    throw new ProvenanceError(
      'The gVisor rootfs manifest requires extended attributes, but no getfattr reader is installed.',
    );
  }
  const xattrs: RootfsDigest['xattrs'] = table.available ? 'captured' : 'unavailable';
  const extended = (relative: string): string => (table.entries.get(relative) ?? []).join('\0');

  const content = createHash('sha256');
  content.update('AIOS-GVISOR-ROOTFS-MANIFEST-v1\0');
  const manifest = createHash('sha256');
  manifest.update(`AIOS-GVISOR-ROOTFS-MANIFEST-v2\0${xattrs}\0`);
  const metadata = createHash('sha256');
  metadata.update(`AIOS-GVISOR-ROOTFS-METADATA-v2\0${xattrs}\0`);
  const timestamps = createHash('sha256');
  timestamps.update('AIOS-GVISOR-ROOTFS-TIMESTAMPS-v2\0');
  let entries = 0;

  const rootMode = Number(rootStats.mode & 0o7777n).toString(8);
  metadata.update(`R\0${rootMode}\0${rootStats.uid}\0${rootStats.gid}\0${extended('')}\0`);
  timestamps.update(`R\0${rootStats.mtimeNs}\0`);

  const walk = (absolute: string, relative: string): void => {
    const names = readdirSync(absolute).sort();
    for (const name of names) {
      const childAbsolute = resolve(absolute, name);
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const stats = lstatSync(childAbsolute, { bigint: true });
      const mode = Number(stats.mode & 0o7777n).toString(8);
      const owner = `${stats.uid}\0${stats.gid}`;
      const xattr = extended(childRelative);
      entries += 1;
      timestamps.update(`${childRelative}\0${stats.mtimeNs}\0`);
      metadata.update(`P\0${childRelative}\0${mode}\0${owner}\0${xattr}\0`);
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(childAbsolute);
        content.update(`L\0${childRelative}\0${mode}\0${target}\0`);
        manifest.update(`L\0${childRelative}\0${mode}\0${owner}\0${target}\0${xattr}\0`);
      } else if (stats.isDirectory()) {
        content.update(`D\0${childRelative}\0${mode}\0`);
        manifest.update(`D\0${childRelative}\0${mode}\0${owner}\0${xattr}\0`);
        walk(childAbsolute, childRelative);
      } else if (stats.isFile()) {
        const fileHash = hashFile(childAbsolute, 'sha256');
        content.update(`F\0${childRelative}\0${mode}\0${stats.size}\0${fileHash}\0`);
        manifest.update(`F\0${childRelative}\0${mode}\0${owner}\0${stats.size}\0${fileHash}\0${xattr}\0`);
      } else {
        content.update(`O\0${childRelative}\0${mode}\0${stats.size}\0`);
        manifest.update(`O\0${childRelative}\0${mode}\0${owner}\0${stats.size}\0${xattr}\0`);
      }
    }
  };

  walk(root, '');
  return {
    manifest_version: 2,
    sha256: manifest.digest('hex'),
    entries,
    content_sha256: content.digest('hex'),
    metadata_sha256: metadata.digest('hex'),
    timestamps_sha256: timestamps.digest('hex'),
    xattrs,
  };
}
