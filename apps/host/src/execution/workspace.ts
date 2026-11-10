import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
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

  clear(): void {
    for (const path of this.paths.values()) rmSync(path, { recursive: true, force: true });
    this.paths.clear();
  }
}
