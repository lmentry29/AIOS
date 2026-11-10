import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HostConfigError, HostExecutionError } from '../errors.js';

/**
 * Owns per-task workspaces for an execution + verification pair.
 *
 * The verifier must be able to inspect the same files the executor produced, so the
 * workspace is keyed by Task ID and retained for the short verification window. It is
 * never the user's Obsidian vault and never a caller-supplied path. The root is
 * owner-only and a symlinked root is rejected rather than followed.
 */
export class RunWorkspaceManager {
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly maxWorkspaces = 64,
  ) {
    if (!isAbsolute(root)) throw new HostConfigError('Execution workspace_directory must be absolute.');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stats = lstatSync(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HostConfigError('Execution workspace_directory must be a directory, not a symlink.');
    }
    chmodSync(root, 0o700);
  }

  getOrCreate(taskId: string): string {
    const existing = this.paths.get(taskId);
    if (existing) return existing;
    if (this.paths.size >= this.maxWorkspaces) {
      const [oldestId, oldestPath] = this.paths.entries().next().value as [string, string];
      this.paths.delete(oldestId);
      rmSync(oldestPath, { recursive: true, force: true });
    }
    const workspace = mkdtempSync(join(this.root, `task-${taskId}-`));
    chmodSync(workspace, 0o700);
    this.paths.set(taskId, workspace);
    return workspace;
  }

  /**
   * Resolves a Task-relative cwd and rejects absolute paths, `..` escapes, and
   * symlinked directories that leave the workspace. Providers receive a relative
   * path, never the host path.
   */
  resolveCwd(workspace: string, cwd: string | undefined): string {
    if (cwd === undefined || cwd === '') return '.';
    if (isAbsolute(cwd) || cwd.includes('\0')) {
      throw new HostExecutionError('Task execution cwd must be a relative path without NUL bytes.');
    }
    const candidate = resolve(workspace, cwd);
    const rel = relative(workspace, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new HostExecutionError('Task execution cwd must stay inside the run workspace.');
    }
    try {
      const real = realpathSync(candidate);
      const realRel = relative(realpathSync(workspace), real);
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        throw new HostExecutionError('Task execution cwd must stay inside the run workspace.');
      }
      if (!statSync(real).isDirectory()) {
        throw new HostExecutionError('Task execution cwd must be a directory.');
      }
    } catch (error) {
      if (error instanceof HostExecutionError) throw error;
      // A missing cwd is left for the sandbox command to fail honestly; it is not a
      // host escape and the provider still receives a workspace-relative path.
    }
    return rel === '' ? '.' : rel;
  }

  /** Removes a failed run's workspace so oversized or partial state is not retained. */
  discard(taskId: string): void {
    const path = this.paths.get(taskId);
    if (path === undefined) return;
    this.paths.delete(taskId);
    rmSync(path, { recursive: true, force: true });
  }

  clear(): void {
    for (const path of this.paths.values()) rmSync(path, { recursive: true, force: true });
    this.paths.clear();
  }
}

const MAX_MEASURED_ENTRIES = 100_000;

/**
 * Sums regular-file bytes under a workspace without following symlinks.
 *
 * Symlinks are skipped rather than resolved, so a workspace link to a host file cannot
 * inflate or redirect the measurement. Hardlinks are counted once per name, which can
 * overstate unique bytes; that is the conservative direction for a ceiling. Directory
 * traversal is bounded to avoid turning a wide tree into a host-side denial of service.
 */
export function measureWorkspaceBytes(root: string): number {
  let total = 0;
  let entries = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch {
      // A file removed between listing and stat contributes no bytes.
      continue;
    }
    entries += 1;
    if (entries > MAX_MEASURED_ENTRIES) {
      throw new HostExecutionError('Workspace contains too many entries to measure safely.');
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(join(current, name));
    } else if (stats.isFile()) {
      total += stats.size;
    }
  }
  return total;
}

/**
 * Samples workspace usage while a sandbox invocation is live and signals the caller when
 * the configured ceiling is crossed. This is enforcement during the run, not a post-run
 * audit: `onExceeded` aborts the provider, which kills the process group. It is not a hard
 * filesystem quota — a very fast writer can overshoot between samples — and that limit is
 * recorded in the security documentation.
 */
export class WorkspaceQuotaGuard {
  private timer: NodeJS.Timeout | undefined;
  private exceeded = false;
  private measurementFailure: string | undefined;

  constructor(
    private readonly root: string,
    private readonly maxBytes: number,
    private readonly onExceeded: () => void,
    private readonly intervalMs = 25,
  ) {}

  get state(): { exceeded: boolean; measurementFailure: string | undefined } {
    return { exceeded: this.exceeded, measurementFailure: this.measurementFailure };
  }

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Final sample closes the window between the last interval tick and process exit.
    this.sample();
  }

  private sample(): void {
    if (this.exceeded || this.measurementFailure !== undefined) return;
    try {
      if (measureWorkspaceBytes(this.root) > this.maxBytes) {
        this.exceeded = true;
        this.onExceeded();
      }
    } catch (error) {
      this.measurementFailure = error instanceof Error ? error.message : 'workspace measurement failed';
      this.onExceeded();
    }
  }
}
