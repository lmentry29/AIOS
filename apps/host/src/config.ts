import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { HostConfigError } from './errors.js';

/**
 * Local host configuration.
 *
 * The host never authenticates with a plaintext token from this file. Each session stores
 * only the SHA-256 digest of a bearer token, so leaking the configuration does not leak a
 * usable credential. Provider secrets (the Obsidian++ password) are read from the
 * environment and are deliberately absent from this schema; unknown keys are rejected so a
 * well-meaning `"token": "..."` entry fails startup instead of being silently ignored.
 */
export interface HostSessionEntry {
  /** Stable UUID used for audit correlation. */
  session_id: string;
  /** Trusted principal this session authenticates as: `human:<id>` or an Agent UUID. */
  principal_id: string;
  /** Lowercase hex SHA-256 of the bearer token. */
  token_sha256: string;
  /** Optional human-readable device label. */
  label?: string;
  /** Optional ISO-8601 expiry; expired sessions never authenticate. */
  expires_at?: string;
}

export interface HostConfig {
  schema_version: 1;
  bind: {
    /** Literal loopback address only. `0.0.0.0`, hostnames, and interfaces are rejected. */
    host: '127.0.0.1' | '::1';
    port: number;
  };
  /** Absolute path to the durable policy/audit state file. */
  policy_file: string;
  /**
   * Owner-only directory for the durable operational journal (Tasks, Workflows,
   * Artifacts, dispatch runs). Never the Obsidian vault: ADR-0014 keeps Founder
   * Intelligence in the vault and ADR-0015 keeps operational state separate.
   */
  operational_store: {
    directory: string;
  };
  /** Dispatch lease duration in milliseconds; renewed while a dispatch is running. */
  dispatch_lease_ms: number;
  /** Protected Founder decision collection resource UUID. */
  decision_collection_id: string;
  resources: {
    vault: string;
    gmail: string;
    notion: string;
  };
  /** Present only when the local Obsidian++ evidence readers should be composed. */
  obsidian?: {
    base_url: string;
  };
  /**
   * Human principal allowed to read the authorization audit. Policy administration is
   * separately gated by exact `administer_policy` grants; this field is not an admin bypass.
   */
  bootstrap_principal_id: string;
  sessions: HostSessionEntry[];
  request_body_limit_bytes: number;
  /**
   * Optional fixed local-command execution (ADR-0019). When absent, dispatch is
   * disabled and `/health` reports it as unavailable. Presence does not guarantee
   * dispatch: the configured isolation provider must also pass its runtime checks.
   */
  execution?: HostExecutionConfig;
}

export type SandboxProviderKind = 'auto' | 'bubblewrap' | 'seatbelt' | 'docker';

/**
 * Fixed execution and verification wiring. Both commands are conceptually the same
 * `local.exec` capability but use distinct Agent/verifier principals and distinct
 * sandbox invocations. No task may select a provider or image at dispatch time.
 */
export interface HostExecutionConfig {
  /** Absolute owner-only parent for per-run workspaces. Never the Obsidian vault. */
  workspace_directory: string;
  /** Agent UUID recorded as the executor of every command run by this host. */
  agent_id: string;
  /** Independent verifier UUID; must differ from `agent_id`. */
  verifier_id: string;
  provider: SandboxProviderKind;
  /** Container image used by the Docker provider. Required for `docker`. */
  image?: string;
  /** Upper bound applied to every execution and verification command. */
  default_timeout_ms: number;
  /** Upper bound applied to captured stdout and stderr per stream. */
  max_output_bytes: number;
  /**
   * Maximum number of Task executions allowed to run at once. A dispatch beyond this
   * limit is rejected before execution with HTTP 429; it is not silently fanned out.
   */
  max_concurrent_tasks: number;
}

const DEFAULT_BODY_LIMIT = 256 * 1024;
const MIN_BODY_LIMIT = 1024;
const MAX_BODY_LIMIT = 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SESSIONS = 32;
const DEFAULT_DISPATCH_LEASE_MS = 5 * 60 * 1000;
const MIN_DISPATCH_LEASE_MS = 5_000;
const MAX_DISPATCH_LEASE_MS = 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_PRINCIPAL = /^human:[^\s:*]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'bind',
  'policy_file',
  'operational_store',
  'dispatch_lease_ms',
  'decision_collection_id',
  'resources',
  'obsidian',
  'bootstrap_principal_id',
  'sessions',
  'request_body_limit_bytes',
  'execution',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isHumanPrincipal(value: unknown): value is string {
  return typeof value === 'string' && HUMAN_PRINCIPAL.test(value);
}

function isPrincipal(value: unknown): value is string {
  return isUuid(value) || isHumanPrincipal(value);
}

function fail(path: string, message: string): never {
  throw new HostConfigError(`Host configuration ${path} ${message}.`);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `contains an unsupported field "${key}"`);
  }
}

function requireString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'must be a non-empty string');
  }
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return value;
}

function requireUuid(value: unknown, path: string): string {
  if (!isUuid(value)) fail(path, 'must be a UUID');
  return value;
}

function parseBind(raw: unknown): HostConfig['bind'] {
  if (!isRecord(raw)) fail('bind', 'must be an object');
  assertKnownKeys(raw, new Set(['host', 'port']), 'bind');
  if (typeof raw.host !== 'string' || !LOOPBACK_HOSTS.has(raw.host)) {
    fail('bind.host', 'must be the literal loopback address 127.0.0.1 or ::1');
  }
  if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) {
    fail('bind.port', 'must be an integer between 0 and 65535');
  }
  return { host: raw.host as HostConfig['bind']['host'], port: raw.port };
}

function parseExecution(raw: unknown): HostExecutionConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail('execution', 'must be an object');
  assertKnownKeys(raw, new Set([
    'workspace_directory',
    'agent_id',
    'verifier_id',
    'provider',
    'image',
    'default_timeout_ms',
    'max_output_bytes',
    'max_concurrent_tasks',
  ]), 'execution');

  const workspaceDirectory = requireString(
    raw.workspace_directory,
    'execution.workspace_directory',
    4096,
  );
  if (!isAbsolute(workspaceDirectory)) {
    fail('execution.workspace_directory', 'must be an absolute path');
  }
  const agentId = requireUuid(raw.agent_id, 'execution.agent_id');
  const verifierId = requireUuid(raw.verifier_id, 'execution.verifier_id');
  if (agentId === verifierId) {
    fail('execution.verifier_id', 'must differ from execution.agent_id');
  }
  if (raw.provider !== 'auto' && raw.provider !== 'bubblewrap'
    && raw.provider !== 'seatbelt' && raw.provider !== 'docker') {
    fail('execution.provider', 'must be auto, bubblewrap, seatbelt, or docker');
  }
  const provider = raw.provider;

  let image: string | undefined;
  if (raw.image !== undefined) {
    image = requireString(raw.image, 'execution.image', 255);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
      fail('execution.image', 'must be a container image reference without whitespace or shell metacharacters');
    }
  }
  if (provider === 'docker' && image === undefined) {
    fail('execution.image', 'is required when provider is docker');
  }
  if (provider !== 'docker' && image !== undefined) {
    fail('execution.image', 'is only valid with provider docker');
  }

  let defaultTimeoutMs = 60_000;
  if (raw.default_timeout_ms !== undefined) {
    const value = raw.default_timeout_ms;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 300_000) {
      fail('execution.default_timeout_ms', 'must be an integer between 100 and 300000');
    }
    defaultTimeoutMs = value;
  }

  let maxOutputBytes = 64 * 1024;
  if (raw.max_output_bytes !== undefined) {
    const value = raw.max_output_bytes;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 1_048_576) {
      fail('execution.max_output_bytes', 'must be an integer between 1024 and 1048576');
    }
    maxOutputBytes = value;
  }

  let maxConcurrentTasks = 1;
  if (raw.max_concurrent_tasks !== undefined) {
    const value = raw.max_concurrent_tasks;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32) {
      fail('execution.max_concurrent_tasks', 'must be an integer between 1 and 32');
    }
    maxConcurrentTasks = value;
  }

  return {
    workspace_directory: resolve(workspaceDirectory),
    agent_id: agentId,
    verifier_id: verifierId,
    provider,
    ...(image === undefined ? {} : { image }),
    default_timeout_ms: defaultTimeoutMs,
    max_output_bytes: maxOutputBytes,
    max_concurrent_tasks: maxConcurrentTasks,
  };
}

function parseObsidian(raw: unknown): HostConfig['obsidian'] {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail('obsidian', 'must be an object');
  assertKnownKeys(raw, new Set(['base_url']), 'obsidian');
  const baseUrl = requireString(raw.base_url, 'obsidian.base_url', 2048);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail('obsidian.base_url', 'must be an absolute URL');
  }
  if (parsed.protocol !== 'http:') fail('obsidian.base_url', 'must use plain HTTP on the loopback interface');
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) fail('obsidian.base_url', 'must target 127.0.0.1 or [::1]');
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    fail('obsidian.base_url', 'must not include credentials, a path, a query, or a fragment');
  }
  return { base_url: `${parsed.protocol}//${parsed.host}` };
}

function parseSessions(raw: unknown): HostSessionEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('sessions', 'must contain at least one session');
  if (raw.length > MAX_SESSIONS) fail('sessions', `must contain at most ${MAX_SESSIONS} sessions`);
  const sessionIds = new Set<string>();
  const tokenHashes = new Set<string>();
  const sessions: HostSessionEntry[] = [];
  raw.forEach((entry, index) => {
    const path = `sessions[${index}]`;
    if (!isRecord(entry)) fail(path, 'must be an object');
    assertKnownKeys(entry, new Set(['session_id', 'principal_id', 'token_sha256', 'label', 'expires_at']), path);
    const sessionId = requireUuid(entry.session_id, `${path}.session_id`);
    if (sessionIds.has(sessionId)) fail(`${path}.session_id`, 'duplicates another session');
    sessionIds.add(sessionId);
    if (!isPrincipal(entry.principal_id)) {
      fail(`${path}.principal_id`, 'must be a human principal or an Actor UUID');
    }
    const tokenHash = requireString(entry.token_sha256, `${path}.token_sha256`, 64);
    if (!SHA256_HEX.test(tokenHash)) {
      fail(`${path}.token_sha256`, 'must be a lowercase hex SHA-256 digest');
    }
    if (tokenHashes.has(tokenHash)) fail(`${path}.token_sha256`, 'duplicates another session');
    tokenHashes.add(tokenHash);
    let label: string | undefined;
    if (entry.label !== undefined) label = requireString(entry.label, `${path}.label`, 120);
    let expiresAt: string | undefined;
    if (entry.expires_at !== undefined) {
      const value = requireString(entry.expires_at, `${path}.expires_at`, 40);
      if (!Number.isFinite(Date.parse(value))) fail(`${path}.expires_at`, 'must be an ISO-8601 timestamp');
      expiresAt = value;
    }
    sessions.push({
      session_id: sessionId,
      principal_id: entry.principal_id as string,
      token_sha256: tokenHash,
      ...(label === undefined ? {} : { label }),
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    });
  });
  return sessions;
}

/**
 * Validates an already-parsed configuration document. Exported so tests can exercise every
 * rejection path without touching the filesystem.
 */
export function parseHostConfig(raw: unknown): HostConfig {
  if (!isRecord(raw)) fail('document', 'must be a JSON object');
  assertKnownKeys(raw, TOP_LEVEL_KEYS, 'document');
  if (raw.schema_version !== 1) fail('schema_version', 'must be 1');

  const bind = parseBind(raw.bind);

  const policyFile = requireString(raw.policy_file, 'policy_file', 4096);
  if (!isAbsolute(policyFile)) fail('policy_file', 'must be an absolute path');

  if (!isRecord(raw.operational_store)) fail('operational_store', 'must be an object');
  assertKnownKeys(raw.operational_store, new Set(['directory']), 'operational_store');
  const operationalDirectory = requireString(
    raw.operational_store.directory,
    'operational_store.directory',
    4096,
  );
  if (!isAbsolute(operationalDirectory)) {
    fail('operational_store.directory', 'must be an absolute path');
  }

  let dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS;
  if (raw.dispatch_lease_ms !== undefined) {
    const value = raw.dispatch_lease_ms;
    if (typeof value !== 'number' || !Number.isInteger(value)
      || value < MIN_DISPATCH_LEASE_MS || value > MAX_DISPATCH_LEASE_MS) {
      fail(
        'dispatch_lease_ms',
        `must be an integer between ${MIN_DISPATCH_LEASE_MS} and ${MAX_DISPATCH_LEASE_MS}`,
      );
    }
    dispatchLeaseMs = value;
  }

  const decisionCollectionId = requireUuid(raw.decision_collection_id, 'decision_collection_id');

  if (!isRecord(raw.resources)) fail('resources', 'must be an object');
  assertKnownKeys(raw.resources, new Set(['vault', 'gmail', 'notion']), 'resources');
  const vault = requireUuid(raw.resources.vault, 'resources.vault');
  const gmail = requireUuid(raw.resources.gmail, 'resources.gmail');
  const notion = requireUuid(raw.resources.notion, 'resources.notion');
  if (new Set([vault, gmail, notion]).size !== 3) {
    fail('resources', 'must give the vault, Gmail, and Notion three distinct UUIDs');
  }

  const obsidian = parseObsidian(raw.obsidian);
  const execution = parseExecution(raw.execution);

  if (!isHumanPrincipal(raw.bootstrap_principal_id)) {
    fail('bootstrap_principal_id', 'must be a human principal');
  }
  const bootstrapPrincipalId = raw.bootstrap_principal_id;

  const sessions = parseSessions(raw.sessions);
  if (!sessions.some((session) => session.principal_id === bootstrapPrincipalId)) {
    fail('sessions', 'must include at least one session for bootstrap_principal_id');
  }

  let bodyLimit = DEFAULT_BODY_LIMIT;
  if (raw.request_body_limit_bytes !== undefined) {
    const value = raw.request_body_limit_bytes;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_BODY_LIMIT || value > MAX_BODY_LIMIT) {
      fail('request_body_limit_bytes', `must be an integer between ${MIN_BODY_LIMIT} and ${MAX_BODY_LIMIT}`);
    }
    bodyLimit = value;
  }

  return {
    schema_version: 1,
    bind,
    policy_file: resolve(policyFile),
    operational_store: { directory: resolve(operationalDirectory) },
    dispatch_lease_ms: dispatchLeaseMs,
    decision_collection_id: decisionCollectionId,
    resources: { vault, gmail, notion },
    ...(obsidian === undefined ? {} : { obsidian }),
    bootstrap_principal_id: bootstrapPrincipalId,
    sessions,
    request_body_limit_bytes: bodyLimit,
    ...(execution === undefined ? {} : { execution }),
  };
}

/**
 * Loads a configuration file that must be a regular, unlinked, owner-only file.
 *
 * The permission check is part of the contract, not advice: a group- or world-readable
 * file could expose session digests and local resource UUIDs, so the host refuses to start
 * with one and tells the operator to `chmod 600` it.
 */
export function loadHostConfig(filePath: string): HostConfig {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new HostConfigError('Host configuration path must be absolute.');
  }
  const resolved = resolve(filePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new HostConfigError('Host configuration file could not be read.');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new HostConfigError('Host configuration must be a regular file, not a symlink.');
  }
  if (stats.nlink !== 1) {
    throw new HostConfigError('Host configuration must not be a hard link.');
  }
  if (stats.size > MAX_CONFIG_BYTES) {
    throw new HostConfigError('Host configuration exceeds the 64 KiB size limit.');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new HostConfigError('Host configuration must be owner-only (chmod 600) before the host will read it.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    throw new HostConfigError('Host configuration is not valid JSON.');
  }
  return parseHostConfig(parsed);
}
