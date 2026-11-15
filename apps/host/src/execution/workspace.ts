import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostConfigError, HostExecutionError } from "../errors.js";
import type { WorkspaceRecoveryEvidence } from "../persistence/execution-ledger.js";

const MAX_MANIFEST_ENTRIES = 20_000;
const MAX_HASHED_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_HASHED_FILE_BYTES = 4 * 1024 * 1024;
const TASK_WORKSPACE = /^task-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-.+$/;

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
  private pendingOrphans: Array<{ path: string; evidence: WorkspaceRecoveryEvidence }> = [];

  constructor(
    private readonly root: string,
    private readonly maxWorkspaces = 64,
  ) {
    if (!isAbsolute(root))
      throw new HostConfigError("Execution workspace_directory must be absolute.");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stats = lstatSync(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HostConfigError(
        "Execution workspace_directory must be a directory, not a symlink.",
      );
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
    if (cwd === undefined || cwd === "") return ".";
    if (isAbsolute(cwd) || cwd.includes("\0")) {
      throw new HostExecutionError("Task execution cwd must be a relative path without NUL bytes.");
    }
    const candidate = resolve(workspace, cwd);
    const rel = relative(workspace, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new HostExecutionError("Task execution cwd must stay inside the run workspace.");
    }
    try {
      const real = realpathSync(candidate);
      const realRel = relative(realpathSync(workspace), real);
      if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        throw new HostExecutionError("Task execution cwd must stay inside the run workspace.");
      }
      if (!statSync(real).isDirectory()) {
        throw new HostExecutionError("Task execution cwd must be a directory.");
      }
    } catch (error) {
      if (error instanceof HostExecutionError) throw error;
      // A missing cwd is left for the sandbox command to fail honestly; it is not a
      // host escape and the provider still receives a workspace-relative path.
    }
    return rel === "" ? "." : rel;
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

  /**
   * Startup inventory of workspaces left by a previous host process. There is no live
   * execution before the server listens, so every matching directory is orphaned. The
   * manager hashes a bounded manifest of its entries and artifact bytes but does not delete
   * anything yet: the caller must journal the manifest first, then call `removeOrphans`.
   *
   * Directory names are host-generated (`task-<uuid>-<mkdtemp suffix>`); unrelated entries
   * in the workspace root are never touched. Symlinks are not followed.
   */
  inventoryOrphans(): WorkspaceRecoveryEvidence[] {
    const recovered: WorkspaceRecoveryEvidence[] = [];
    this.pendingOrphans = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const match = TASK_WORKSPACE.exec(entry.name);
      if (!entry.isDirectory() || match === null) continue;
      const taskId = match[1];
      if (taskId === undefined) continue;
      const path = join(this.root, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const manifest = this.hashWorkspace(path);
      const evidence: WorkspaceRecoveryEvidence = {
        task_id: taskId,
        workspace_sha256: manifest.sha256,
        entries: manifest.entries,
        bytes: manifest.bytes,
        removed: false,
        ...(manifest.truncated ? { truncated: true } : {}),
      };
      recovered.push(evidence);
      this.pendingOrphans.push({ path, evidence });
    }
    this.paths.clear();
    return recovered;
  }

  /**
   * Removes only the directories inventoried by the immediately preceding
   * `inventoryOrphans` call. The returned evidence repeats the manifest digest and records
   * whether removal actually happened; a removal failure is reported, never hidden.
   */
  removeOrphans(): WorkspaceRecoveryEvidence[] {
    const removed: WorkspaceRecoveryEvidence[] = [];
    for (const orphan of this.pendingOrphans) {
      let deleted = false;
      try {
        rmSync(orphan.path, { recursive: true, force: true });
        deleted = true;
      } catch {
        deleted = false;
      }
      removed.push({ ...orphan.evidence, removed: deleted });
    }
    this.pendingOrphans = [];
    return removed;
  }

  private hashWorkspace(root: string): {
    sha256: string;
    entries: number;
    bytes: number;
    truncated: boolean;
  } {
    const hash = createHash("sha256");
    let entries = 0;
    let bytes = 0;
    let hashedContentBytes = 0;
    let truncated = false;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      let currentStats: ReturnType<typeof lstatSync>;
      try {
        currentStats = lstatSync(current);
      } catch {
        throw new HostExecutionError(
          "An orphaned execution workspace disappeared during recovery.",
        );
      }
      entries += 1;
      if (entries > MAX_MANIFEST_ENTRIES) {
        throw new HostExecutionError(
          "An orphaned execution workspace is too large to inventory safely; refusing to delete it unreviewed.",
        );
      }
      const rel = relative(root, current) || ".";
      hash.update(`${rel}\0${currentStats.mode}\0${currentStats.size}\0`);
      if (currentStats.isSymbolicLink()) {
        hash.update("symlink\0");
        continue;
      }
      if (currentStats.isDirectory()) {
        hash.update("directory\0");
        for (const name of readdirSync(current)) stack.push(join(current, name));
        continue;
      }
      if (!currentStats.isFile()) {
        hash.update("special\0");
        continue;
      }
      bytes += currentStats.size;
      if (
        currentStats.size <= MAX_SINGLE_HASHED_FILE_BYTES &&
        hashedContentBytes + currentStats.size <= MAX_HASHED_CONTENT_BYTES
      ) {
        hash.update(readFileSync(current));
        hashedContentBytes += currentStats.size;
      } else {
        truncated = true;
        hash.update("content-not-hashed\0");
      }
    }
    return { sha256: hash.digest("hex"), entries, bytes, truncated };
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
      throw new HostExecutionError("Workspace contains too many entries to measure safely.");
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
      this.measurementFailure =
        error instanceof Error ? error.message : "workspace measurement failed";
      this.onExceeded();
    }
  }
}
