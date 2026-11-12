#!/usr/bin/env node
/**
 * Signed application archive for the `local-secure` profile (ADR-0038).
 *
 * `create` packages only built host/package output plus the workspace manifests,
 * writes a deterministic ustar archive, and signs the exact archive bytes with an
 * artifact-purpose key. `verify` is offline: it checks the detached signature,
 * the manifest, the file inventory and the release identity before reporting success.
 *
 * The archive contains no `.env`, private key, trust root, journal, workspace or
 * node_modules content. Verification never extracts the archive.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  keyIdForPublicKey,
  loadTrustRoot,
  parseStrictJson,
  signArtifact,
  verifyArtifactSignature,
} from "../../apps/host/dist/execution/artifact-signing.js";

const SCHEMA_VERSION = 1;
const ARCHIVE_FORMAT = "ustar";
const BLOCK_SIZE = 512;
const MAX_FILES = 20_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 255;
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "trust-root.json",
]);
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".sqlite", ".db"];

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

function fail(message) {
  throw new ArchiveError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function posixPath(path) {
  return path.split(sep).join("/");
}

function isSecretPath(path) {
  const normalized = posixPath(path);
  const segments = normalized.split("/");
  if (
    segments.includes(".git") ||
    segments.includes("node_modules") ||
    segments.includes(".turbo")
  ) {
    return true;
  }
  const name = basename(normalized).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SECRET_BASENAMES.has(name)) return true;
  return SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function assertSafeArchivePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_BYTES) {
    fail("The archive contains an invalid or overlong path.");
  }
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.endsWith("/")) {
    fail(`The archive path "${path}" is not a relative POSIX file path.`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`The archive path "${path}" contains a traversal segment.`);
  }
  if (isSecretPath(path)) fail(`The archive path "${path}" is secret-bearing and is refused.`);
}

function sortedDirectory(path) {
  return readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function collectTree(root, directory, output) {
  const absolute = join(root, directory);
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory()) fail(`The release input ${directory} is not a directory.`);
  for (const entry of sortedDirectory(absolute)) {
    const child = join(directory, entry.name);
    const childAbsolute = join(root, child);
    const childMetadata = lstatSync(childAbsolute);
    if (childMetadata.isSymbolicLink()) {
      fail(`The release input ${child} is a symbolic link; symlinks are not archived.`);
    }
    if (childMetadata.isDirectory()) {
      collectTree(root, child, output);
      continue;
    }
    if (!childMetadata.isFile()) fail(`The release input ${child} is not a regular file.`);
    output.push(child);
  }
}

function collectReleaseFiles(root) {
  const files = [];
  const hostDist = join(root, "apps/host/dist");
  if (!lstatSync(hostDist, { throwIfNoEntry: false })?.isDirectory()) {
    fail("apps/host/dist is missing; build the workspace before creating a release archive.");
  }
  collectTree(root, "apps/host/dist", files);

  const packagesDirectory = join(root, "packages");
  for (const entry of sortedDirectory(packagesDirectory)) {
    if (!entry.isDirectory()) continue;
    const dist = join(packagesDirectory, entry.name, "dist");
    if (!lstatSync(dist, { throwIfNoEntry: false })?.isDirectory()) continue;
    collectTree(root, posixPath(relative(root, dist)), files);
  }

  for (const required of ["package.json", "pnpm-lock.yaml"]) {
    const metadata = lstatSync(join(root, required), { throwIfNoEntry: false });
    if (!metadata?.isFile()) fail(`The release input ${required} is missing or is not a file.`);
    files.push(required);
  }
  for (const path of files) assertSafeArchivePath(path);
  if (!files.includes("apps/host/dist/cli.js")) {
    fail("The release archive must contain the host entrypoint apps/host/dist/cli.js.");
  }
  return [...new Set(files)].sort();
}

function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object.`);
  }
  return parsed;
}

function releaseManifest(root, options, files) {
  const hostPackage = readJson(join(root, "apps/host/package.json"), "apps/host/package.json");
  if (typeof hostPackage.version !== "string" || hostPackage.version.length === 0) {
    fail("apps/host/package.json has no version.");
  }
  if (options.version !== undefined && options.version !== hostPackage.version) {
    fail(
      `The requested version ${options.version} does not match host version ${hostPackage.version}.`,
    );
  }
  if (!COMMIT.test(options.commit)) fail("--commit must be a 40-character lowercase Git SHA.");
  if (!RELEASE.test(options.release)) fail("--release contains unsupported characters.");
  if (!RELEASE.test(options.profile)) fail("--profile contains unsupported characters.");
  return {
    schema_version: SCHEMA_VERSION,
    release: options.release,
    version: hostPackage.version,
    commit: options.commit,
    profile: options.profile,
    archive_format: ARCHIVE_FORMAT,
    isolation_provider_required: true,
    founder_integrations: {
      gmail: "read-only",
      notion: "read-only",
      obsidian: "read-only",
    },
    entrypoint: "apps/host/dist/cli.js",
    files: files.map((path) => {
      const bytes = readFileSync(join(root, path));
      return { path, size: bytes.length, sha256: sha256(bytes) };
    }),
  };
}

function tarHeader(path, size) {
  const name = Buffer.from(path, "utf8");
  let prefix = Buffer.alloc(0);
  let shortName = name;
  if (name.length > 100) {
    const split = path.lastIndexOf("/", 255 - 101);
    if (split <= 0) fail(`The archive path "${path}" exceeds the ustar name limit.`);
    prefix = Buffer.from(path.slice(0, split), "utf8");
    shortName = Buffer.from(path.slice(split + 1), "utf8");
    if (shortName.length > 100 || prefix.length > 155) {
      fail(`The archive path "${path}" exceeds the ustar name limit.`);
    }
  }
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  shortName.copy(header, 0);
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write("root", 265, "ascii");
  header.write("root", 297, "ascii");
  prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function tarEntry(path, bytes) {
  assertSafeArchivePath(path);
  return Buffer.concat([
    tarHeader(path, bytes.length),
    bytes,
    Buffer.alloc((BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE),
  ]);
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readTarOctal(header, offset, length) {
  const text = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) fail("The archive contains a malformed octal header field.");
  return Number.parseInt(text, 8);
}

function parseArchive(bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES) fail("The archive exceeds the 256 MiB limit.");
  const entries = new Map();
  let offset = 0;
  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < BLOCK_SIZE; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (readTarOctal(header, 148, 8) !== checksum)
      fail("The archive contains a bad ustar checksum.");
    const path = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullPath = prefix.length === 0 ? path : `${prefix}/${path}`;
    assertSafeArchivePath(fullPath);
    const type = readTarString(header, 156, 1);
    if (type !== "0" && type !== "\0") fail(`The archive entry ${fullPath} is not a regular file.`);
    const size = readTarOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) fail("The archive contains an invalid size.");
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) fail(`The archive entry ${fullPath} is truncated.`);
    if (entries.has(fullPath)) fail(`The archive contains duplicate path ${fullPath}.`);
    entries.set(fullPath, bytes.subarray(dataStart, dataEnd));
    if (entries.size > MAX_FILES) fail(`The archive exceeds the ${MAX_FILES}-file limit.`);
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

function manifestEntry(entries) {
  const bytes = entries.get("release-manifest.json");
  if (!bytes) fail("The archive has no release-manifest.json.");
  if (bytes.length > MAX_MANIFEST_BYTES) fail("The release manifest is too large.");
  let manifest;
  try {
    manifest = parseStrictJson(bytes.toString("utf8"), "release manifest");
  } catch (error) {
    fail(error instanceof Error ? error.message : "The release manifest is invalid.");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    fail("The release manifest must be a JSON object.");
  }
  return manifest;
}

function validateManifest(manifest, entries, expected) {
  const required = [
    "schema_version",
    "release",
    "version",
    "commit",
    "profile",
    "archive_format",
    "isolation_provider_required",
    "founder_integrations",
    "entrypoint",
    "files",
  ];
  for (const field of required) {
    if (!Object.hasOwn(manifest, field)) fail(`The release manifest has no ${field}.`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION)
    fail("The release manifest schema version is unsupported.");
  for (const field of ["release", "version", "commit", "profile"]) {
    if (manifest[field] !== expected[field]) {
      fail(`The release manifest ${field} does not match the requested ${expected[field]}.`);
    }
  }
  if (manifest.archive_format !== ARCHIVE_FORMAT)
    fail("The release manifest archive format is unsupported.");
  if (manifest.isolation_provider_required !== true)
    fail("The release manifest must require an isolation provider.");
  if (!manifest.founder_integrations || typeof manifest.founder_integrations !== "object") {
    fail("The release manifest has no Founder integration policy.");
  }
  if (manifest.entrypoint !== "apps/host/dist/cli.js")
    fail("The release manifest entrypoint is unsupported.");
  if (!Array.isArray(manifest.files)) fail("The release manifest has no file inventory.");
  const inventory = new Map();
  for (const entry of manifest.files) {
    if (typeof entry !== "object" || entry === null)
      fail("The release manifest has a malformed file entry.");
    const { path, size, sha256: digest } = entry;
    if (typeof path !== "string" || typeof size !== "number" || typeof digest !== "string") {
      fail("The release manifest has a malformed file entry.");
    }
    assertSafeArchivePath(path);
    if (inventory.has(path)) fail(`The release manifest lists ${path} more than once.`);
    inventory.set(path, { size, sha256: digest });
  }
  const archivePaths = [...entries.keys()]
    .filter((path) => path !== "release-manifest.json")
    .sort();
  const inventoryPaths = [...inventory.keys()].sort();
  if (JSON.stringify(archivePaths) !== JSON.stringify(inventoryPaths)) {
    fail("The release manifest inventory does not match the archive contents.");
  }
  for (const path of archivePaths) {
    const bytes = entries.get(path);
    const expectedEntry = inventory.get(path);
    if (!bytes || bytes.length !== expectedEntry.size || sha256(bytes) !== expectedEntry.sha256) {
      fail(`The release archive entry ${path} does not match its manifest digest.`);
    }
  }
  if (!entries.has(manifest.entrypoint)) fail("The release archive has no host entrypoint.");
}

export function createReleaseArchive(options) {
  const root = realpathSync(resolve(options.root));
  const files = collectReleaseFiles(root);
  const manifest = releaseManifest(root, options, files);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const archivePath = resolve(options.archive);
  const entries = [...files].sort();
  const parts = entries.map((file) => tarEntry(file, readFileSync(join(root, file))));
  parts.push(tarEntry("release-manifest.json", manifestBytes));
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  const bytes = Buffer.concat(parts);
  if (bytes.length > MAX_ARCHIVE_BYTES) fail("The release archive exceeds the 64 MiB limit.");
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  writeFileSync(archivePath, bytes, { mode: 0o600 });
  const unsigned = { bytes: bytes.length, sha256: sha256(bytes) };
  if (!options.privateKeyPem || !options.keyId || !options.trustRoot) {
    return {
      archive: archivePath,
      archive_sha256: unsigned.sha256,
      archive_bytes: unsigned.bytes,
      manifest,
      signed: false,
    };
  }
  let privateKeyPublicPem;
  try {
    privateKeyPublicPem = createPublicKey(createPrivateKey(options.privateKeyPem)).export({
      type: "spki",
      format: "pem",
    });
  } catch {
    fail("The signing key file is not a valid private key.");
  }
  if (keyIdForPublicKey(privateKeyPublicPem) !== options.keyId) {
    fail("The signing key id does not match the private key.");
  }
  const statement = signArtifact({
    artifact_kind: "application-archive",
    artifact_path: archivePath,
    key_id: options.keyId,
    private_key_pem: options.privateKeyPem,
    subject: {
      release: manifest.release,
      version: manifest.version,
      commit: manifest.commit,
      profile: manifest.profile,
    },
    trust_root: options.trustRoot,
  });
  if (!options.signature) fail("A signed archive requires --signature.");
  const signaturePath = resolve(options.signature);
  mkdirSync(dirname(signaturePath), { recursive: true, mode: 0o700 });
  writeFileSync(signaturePath, `${JSON.stringify(statement, null, 2)}\n`, { mode: 0o600 });
  return {
    archive: archivePath,
    signature: signaturePath,
    archive_sha256: unsigned.sha256,
    archive_bytes: unsigned.bytes,
    manifest,
    signed: true,
    key_id: statement.key_id,
  };
}

export function verifyReleaseArchive(options) {
  const now = options.now ?? new Date();
  const verified = verifyArtifactSignature({
    artifact_kind: "application-archive",
    artifact_path: resolve(options.archive),
    signature_path: resolve(options.signature),
    trust_root_path: resolve(options.trustRootPath),
    expected_subject: {
      release: options.release,
      version: options.version,
      commit: options.commit,
      profile: options.profile,
    },
    now,
  });
  const bytes = readFileSync(resolve(options.archive));
  const entries = parseArchive(bytes);
  const manifest = manifestEntry(entries);
  validateManifest(manifest, entries, options);
  return {
    archive_sha256: verified.artifact_sha256,
    signature_sha256: verified.signature_sha256,
    key_id: verified.key_id,
    signed_at: verified.signed_at,
    manifest,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for --${key}.`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) fail(`Missing --${key}.`);
  return value;
}

function readPrivateKey(path) {
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024) fail("The signing key file is too large.");
  return bytes.toString("utf8");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const values = parseArgs(rest);
  if (command === "create") {
    const privateKeyPem =
      values["key-file"] === undefined ? undefined : readPrivateKey(required(values, "key-file"));
    const keyId = values["key-id"];
    if ((privateKeyPem === undefined) !== (keyId === undefined)) {
      fail("Provide both --key-file and --key-id, or neither for an unsigned archive.");
    }
    const trustRoot =
      privateKeyPem === undefined
        ? undefined
        : loadTrustRoot(resolve(required(values, "trust-root")), "artifact");
    const result = createReleaseArchive({
      root: required(values, "root"),
      archive: required(values, "out"),
      signature: values.signature,
      commit: required(values, "commit"),
      release: values.release ?? "aios-host",
      profile: values.profile ?? "local-secure",
      version: values.version,
      privateKeyPem,
      keyId,
      trustRoot,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "verify") {
    const result = verifyReleaseArchive({
      archive: required(values, "archive"),
      signature: required(values, "signature"),
      trustRootPath: required(values, "trust-root"),
      release: values.release ?? "aios-host",
      version: required(values, "version"),
      commit: required(values, "commit"),
      profile: values.profile ?? "local-secure",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  fail("Usage: app-archive.mjs <create|verify> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
