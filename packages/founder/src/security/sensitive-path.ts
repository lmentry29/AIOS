import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * High-confidence sensitive path detection and symlink-aware containment.
 *
 * This is deliberately a deny-list of credential/secret locations, not a claim that every
 * other path is safe. Callers must still apply their own resource authorization and, for
 * reads, use a no-follow file descriptor where the platform supports it.
 */
export type SensitivePathKind =
  | 'environment_file'
  | 'private_key'
  | 'credential_store'
  | 'secret_store'
  | 'browser_or_wallet_store'
  | 'shell_history';

export interface SensitivePathMatch {
  kind: SensitivePathKind;
  segment: string;
}

export class SensitivePathError extends Error {
  constructor(
    readonly code: 'sensitive_path' | 'path_escape' | 'symlink' | 'not_directory',
    message: string,
  ) {
    super(message);
    this.name = 'SensitivePathError';
  }
}

const SENSITIVE_DIRECTORIES: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gcloud',
]);

const SENSITIVE_EXACT: Readonly<Record<string, SensitivePathKind>> = Object.freeze({
  '.git-credentials': 'credential_store',
  '.netrc': 'credential_store',
  '.npmrc': 'credential_store',
  '.pypirc': 'credential_store',
  '.bash_history': 'shell_history',
  '.zsh_history': 'shell_history',
  '.sh_history': 'shell_history',
  'credentials': 'credential_store',
  'credentials.json': 'credential_store',
  'secrets': 'secret_store',
  'secrets.json': 'secret_store',
  'service-account.json': 'credential_store',
  'kubeconfig': 'credential_store',
  'wallet.dat': 'browser_or_wallet_store',
});

const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/i;
const ENV_FILE = /^\.env(?:\..+)?$/i;
const PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const KEY_MATERIAL = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn)$/i;
const SERVICE_ACCOUNT = /(?:^|[-_.])service-account(?:[-_.].*)?\.json$/i;
const CLOUD_CREDENTIAL = /(?:^|[-_.])credentials(?:[-_.].*)?\.json$/i;

function segmentsOf(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function classifySegment(segment: string, lowerPath: string): SensitivePathKind | undefined {
  const lower = segment.toLowerCase();
  if (ENV_TEMPLATE.test(lower)) return undefined;
  if (ENV_FILE.test(lower)) return 'environment_file';
  if (PRIVATE_KEY.test(lower)) return 'private_key';
  if (KEY_MATERIAL.test(lower)) return 'private_key';
  if (SERVICE_ACCOUNT.test(lower) || CLOUD_CREDENTIAL.test(lower)) return 'credential_store';
  const exact = SENSITIVE_EXACT[lower];
  if (exact !== undefined) return exact;
  if (lowerPath.includes('/.config/gcloud/') || lowerPath.startsWith('.config/gcloud/')) {
    return 'credential_store';
  }
  return undefined;
}

/**
 * Classifies a relative or absolute path by its credential-like segments. `.env.example`,
 * `.env.sample`, and `.env.template` are explicitly non-sensitive templates.
 */
export function classifySensitivePath(value: string): SensitivePathMatch | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return undefined;
  }
  const segments = segmentsOf(value);
  const lowerPath = segments.join('/').toLowerCase();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const lower = segment.toLowerCase();
    if (SENSITIVE_DIRECTORIES.has(lower)) {
      return { kind: 'credential_store', segment };
    }
    // `.config/gcloud` is two segments; classify the directory wherever it appears.
    if (lower === '.config' && segments[index + 1]?.toLowerCase() === 'gcloud') {
      return { kind: 'credential_store', segment: '.config/gcloud' };
    }
    const kind = classifySegment(segment, lowerPath);
    if (kind !== undefined) return { kind, segment };
  }
  return undefined;
}

export function assertNotSensitivePath(value: string, label = 'path'): void {
  const match = classifySensitivePath(value);
  if (match !== undefined) {
    throw new SensitivePathError(
      'sensitive_path',
      `${label} resolves to a protected ${match.kind} location ("${match.segment}").`,
    );
  }
}

export interface ContainedPathOptions {
  /**
   * `reject` refuses any symlink in the chain. `follow-contained` permits symlinks only
   * when their real target remains under the canonical root.
   */
  symlinks?: 'reject' | 'follow-contained';
  /** Permit a missing final component, as required for create/write operations. */
  allowMissingLeaf?: boolean;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Resolves a path under a root and rejects traversal and symlinked escapes.
 *
 * The containment check is repeated on the canonical path after the per-segment walk. A
 * caller that then opens the path should use `O_NOFOLLOW` for the final component and
 * compare the opened descriptor identity; no portable Node API can atomically pin every
 * parent directory against a same-user rename race.
 */
export function resolveContainedPath(
  root: string,
  candidate: string,
  options: ContainedPathOptions = {},
): string {
  if (typeof root !== 'string' || typeof candidate !== 'string'
    || root.length === 0 || candidate.length === 0
    || root.includes('\0') || candidate.includes('\0')) {
    throw new SensitivePathError('path_escape', 'Path containment requires non-empty paths without NUL bytes.');
  }
  const rootPath = resolve(root);
  let rootStats: ReturnType<typeof lstatSync>;
  try {
    rootStats = lstatSync(rootPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new SensitivePathError('not_directory', `Containment root does not exist: ${rootPath}.`);
    }
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new SensitivePathError('not_directory', `Containment root must be a real directory: ${rootPath}.`);
  }
  const rootReal = realpathSync(rootPath);
  const candidatePath = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(rootPath, candidate);
  const initialRelative = relative(rootPath, candidatePath);
  if (initialRelative === '..' || initialRelative.startsWith(`..${sep}`) || isAbsolute(initialRelative)) {
    throw new SensitivePathError('path_escape', 'Candidate path escapes the containment root.');
  }

  const segments = initialRelative === '' ? [] : initialRelative.split(sep);
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment === '') continue;
    current = resolve(current, segment);
    const isLeaf = index === segments.length - 1;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isEnoent(error) && options.allowMissingLeaf === true && isLeaf) return candidatePath;
      if (isEnoent(error)) {
        throw new SensitivePathError('path_escape', `Path component does not exist: ${current}.`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      if ((options.symlinks ?? 'reject') === 'reject') {
        throw new SensitivePathError('symlink', `Path contains a symlink: ${current}.`);
      }
      const real = realpathSync(current);
      const relativeReal = relative(rootReal, real);
      if (relativeReal === '..' || relativeReal.startsWith(`..${sep}`) || isAbsolute(relativeReal)) {
        throw new SensitivePathError('path_escape', `Symlink escapes the containment root: ${current}.`);
      }
      continue;
    }
    if (!isLeaf && !stats.isDirectory()) {
      throw new SensitivePathError('path_escape', `Path component is not a directory: ${current}.`);
    }
  }

  const real = realpathSync(candidatePath);
  const relativeReal = relative(rootReal, real);
  if (relativeReal === '..' || relativeReal.startsWith(`..${sep}`) || isAbsolute(relativeReal)) {
    throw new SensitivePathError('path_escape', 'Canonical path escapes the containment root.');
  }
  return candidatePath;
}
