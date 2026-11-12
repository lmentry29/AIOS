import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fsyncDirectory } from "../persistence/fsync-directory.js";
import { HostConfigError, HostUnavailableError } from "../errors.js";

const KEY_BYTES = 32;
const MAX_KEY_FILE_BYTES = 4096;
const MAX_SECRET_BYTES = 2048;
// A fixed plaintext block hides the secret length from the ciphertext file. The four-byte
// big-endian prefix inside the encrypted block is the real length.
const PLAINTEXT_BLOCK_BYTES = 4096;
const STORE_VERSION = 1;

export interface SecretBrokerPort {
  readonly available: boolean;
  /** Stores a secret and returns only its opaque entry id. */
  create(secret: string): string;
  /** Replaces the value behind an existing entry id. */
  rotate(entryId: string, secret: string): void;
  /** Host-side resolution. This method is never exposed by an HTTP route. */
  resolve(entryId: string): string;
  has(entryId: string): boolean;
  /** Removes an unreferenced entry after a partially completed create. */
  remove(entryId: string): void;
}

export class SecretBrokerUnavailableError extends HostUnavailableError {
  constructor() {
    super("The host secret broker is not configured; credential operations are unavailable.");
    this.name = "SecretBrokerUnavailableError";
  }
}

export class SecretBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBrokerError";
  }
}

/** Fail-closed placeholder used when the operator has not provisioned broker custody. */
export class UnavailableSecretBroker implements SecretBrokerPort {
  readonly available = false;

  create(): string {
    throw new SecretBrokerUnavailableError();
  }

  rotate(): void {
    throw new SecretBrokerUnavailableError();
  }

  resolve(): string {
    throw new SecretBrokerUnavailableError();
  }

  has(): boolean {
    return false;
  }

  remove(): void {
    throw new SecretBrokerUnavailableError();
  }
}

interface EncryptedEntry {
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface BrokerFile {
  version: typeof STORE_VERSION;
  entries: Record<string, EncryptedEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMasterKey(keyFile: string): Buffer {
  if (!isAbsolute(keyFile)) {
    throw new HostConfigError("Secret broker key file must be an absolute path.");
  }
  const resolved = resolve(keyFile);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new HostConfigError("Secret broker key file could not be read.");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new HostConfigError("Secret broker key file must be a regular, unlinked file.");
  }
  if (stats.size > MAX_KEY_FILE_BYTES) {
    throw new HostConfigError("Secret broker key file exceeds the supported size limit.");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new HostConfigError("Secret broker key file must be owner-only (chmod 600).");
  }
  const raw = readFileSync(resolved);
  if (raw.length === KEY_BYTES) return raw;
  if (raw.length === KEY_BYTES * 2 && /^[a-f0-9]+$/.test(raw.toString("ascii"))) {
    return Buffer.from(raw.toString("ascii"), "hex");
  }
  throw new HostConfigError(
    "Secret broker key file must contain exactly 32 raw bytes or 64 hex characters.",
  );
}

function parseStore(value: unknown): BrokerFile {
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.entries)) {
    throw new SecretBrokerError("Secret broker state has an unsupported format.");
  }
  const entries: Record<string, EncryptedEntry> = {};
  for (const [entryId, entry] of Object.entries(value.entries)) {
    if (
      !/^[0-9a-f-]{36}$/i.test(entryId) ||
      !isRecord(entry) ||
      typeof entry.nonce !== "string" ||
      typeof entry.ciphertext !== "string" ||
      typeof entry.tag !== "string"
    ) {
      throw new SecretBrokerError("Secret broker state contains a malformed entry.");
    }
    entries[entryId] = {
      nonce: entry.nonce,
      ciphertext: entry.ciphertext,
      tag: entry.tag,
    };
  }
  return { version: STORE_VERSION, entries };
}

function writeStore(filePath: string, store: BrokerFile): void {
  const directory = dirname(filePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = lstatSync(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new SecretBrokerError("Secret broker store parent must be a real directory.");
  }
  // Never chmod an operator-owned parent (for example /tmp) as a side effect. Refuse a
  // group/world-accessible directory instead.
  if ((directoryStats.mode & 0o077) !== 0) {
    throw new SecretBrokerError("Secret broker store parent must be owner-only (chmod 700).");
  }
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(store)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
  fsyncDirectory(dirname(filePath));
}

/**
 * Host-owned encrypted secret broker for local development and single-host operation.
 *
 * Secrets are encrypted with AES-256-GCM under an owner-only 32-byte key file. The
 * ciphertext store is separate from the operational journal, so no secret or encrypted
 * secret travels through journal replay, evidence, HTTP responses, or logs. This is not a
 * claim of HSM/KMS custody: production custody remains the owner-gated CL-007 requirement.
 */
export class EncryptedFileSecretBroker implements SecretBrokerPort {
  readonly available = true;
  private readonly storeFile: string;
  private readonly key: Buffer;
  private entries: Record<string, EncryptedEntry>;

  constructor(options: { store_file: string; key_file: string }) {
    if (
      !isRecord(options as unknown) ||
      typeof options.store_file !== "string" ||
      !isAbsolute(options.store_file)
    ) {
      throw new HostConfigError("Secret broker store path must be an absolute file path.");
    }
    this.storeFile = resolve(options.store_file);
    this.key = readMasterKey(options.key_file);
    if (!existsSync(this.storeFile)) {
      this.entries = {};
      return;
    }
    const stats = lstatSync(this.storeFile);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size > 8 * 1024 * 1024
    ) {
      throw new HostConfigError(
        "Secret broker state must be a regular, unlinked file within the size limit.",
      );
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new HostConfigError("Secret broker state must be owner-only (chmod 600).");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.storeFile, "utf8"));
    } catch {
      throw new SecretBrokerError("Secret broker state is not readable JSON.");
    }
    this.entries = parseStore(parsed).entries;
  }

  create(secret: string): string {
    const entryId = randomUUID();
    const encrypted = this.encrypt(entryId, this.validateSecret(secret));
    this.entries[entryId] = encrypted;
    try {
      this.persist();
    } catch (error) {
      delete this.entries[entryId];
      throw error;
    }
    return entryId;
  }

  rotate(entryId: string, secret: string): void {
    if (!this.has(entryId)) {
      throw new SecretBrokerError("Secret broker entry was not found.");
    }
    const encrypted = this.encrypt(entryId, this.validateSecret(secret));
    const previous = this.entries[entryId];
    this.entries[entryId] = encrypted;
    try {
      this.persist();
    } catch (error) {
      if (previous) this.entries[entryId] = previous;
      else delete this.entries[entryId];
      throw error;
    }
  }

  remove(entryId: string): void {
    if (!this.has(entryId)) return;
    const previous = this.entries[entryId];
    delete this.entries[entryId];
    try {
      this.persist();
    } catch (error) {
      if (previous) this.entries[entryId] = previous;
      throw error;
    }
  }

  resolve(entryId: string): string {
    const entry = this.entries[entryId];
    if (!entry) throw new SecretBrokerError("Secret broker entry was not found.");
    const nonce = Buffer.from(entry.nonce, "base64");
    const tag = Buffer.from(entry.tag, "base64");
    const ciphertext = Buffer.from(entry.ciphertext, "base64");
    let block: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from(entryId, "utf8"));
      decipher.setAuthTag(tag);
      block = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new SecretBrokerError("Secret broker entry authentication failed.");
    }
    if (block.length !== PLAINTEXT_BLOCK_BYTES) {
      throw new SecretBrokerError("Secret broker entry has an invalid encrypted block.");
    }
    const length = block.readUInt32BE(0);
    if (length < 1 || length > MAX_SECRET_BYTES) {
      throw new SecretBrokerError("Secret broker entry has an invalid secret length.");
    }
    return block.subarray(4, 4 + length).toString("utf8");
  }

  has(entryId: string): boolean {
    return Object.hasOwn(this.entries, entryId);
  }

  private validateSecret(secret: string): string {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new SecretBrokerError("Secret material must be a non-empty string.");
    }
    if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
      throw new SecretBrokerError("Secret material exceeds the supported length.");
    }
    if (secret.includes("\u0000")) {
      throw new SecretBrokerError("Secret material must not contain NUL characters.");
    }
    return secret;
  }

  private encrypt(entryId: string, secret: string): EncryptedEntry {
    const value = Buffer.from(secret, "utf8");
    const block = Buffer.alloc(PLAINTEXT_BLOCK_BYTES);
    block.writeUInt32BE(value.length, 0);
    value.copy(block, 4);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(entryId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(block), cipher.final()]);
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  private persist(): void {
    writeStore(this.storeFile, { version: STORE_VERSION, entries: this.entries });
  }
}
