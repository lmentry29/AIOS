import { createHash } from 'node:crypto';
import type { TaskEntity } from '@aios/core';
import { TaskCancelledError, type AgentExecutionPort, type TaskExecutionResult } from '@aios/orchestration';
import type { HostExecutionConfig } from '../config.js';
import {
  HostExecutionError,
  HostUnavailableError,
  SandboxFilterUnavailableError,
  SandboxResourceLimitUnavailableError,
  SandboxSyscallDeniedError,
  WorkspaceQuotaExceededError,
} from '../errors.js';
import { SECCOMP_DENIED_EXIT_CODE } from './seccomp.js';
import type { SandboxProvider, SandboxResult } from './sandbox.js';
import { WorkspaceQuotaGuard, type RunWorkspaceManager } from './workspace.js';

const ALLOWED_ENV = /^(LANG|LC_[A-Z0-9_]+|TZ|AIOS_[A-Z0-9_]+)$/;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const BOUNDARY_PROVIDERS = new Set(['bubblewrap', 'docker']);

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function filterEnvironment(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (ALLOWED_ENV.test(key) && typeof value === 'string' && value.length <= 256) {
      allowed[key] = value;
    }
  }
  return allowed;
}

/**
 * Executes the fixed `local_command` capability through one isolation provider.
 *
 * The adapter never turns `argv` into a shell string. A non-zero exit, timeout, spawn
 * failure, missing provider, or missing execution intent fails the dispatch rather than
 * manufacturing a successful result. Raw output is hashed, not copied into evidence,
 * so a command cannot inject credentials or untrusted text into the durable journal.
 */
export class LocalCommandExecutor implements AgentExecutionPort {
  private availability: { checkedAt: number; available: boolean; reason: string; filterFailure?: boolean; resourceLimitFailure?: boolean } | undefined;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly config: HostExecutionConfig,
    private readonly provider: SandboxProvider,
    private readonly workspaces: RunWorkspaceManager,
  ) {}

  async validateAgent(agentId: string): Promise<boolean> {
    if (agentId !== this.config.agent_id) return false;
    await this.ensureAvailable();
    return true;
  }

  async executeTask(agentId: string, task: TaskEntity): Promise<TaskExecutionResult> {
    if (agentId !== this.config.agent_id) {
      throw new HostExecutionError('The task was dispatched to an Agent this executor does not own.');
    }
    await this.ensureAvailable();
    const intent = task.execution;
    if (!intent || intent.kind !== 'local_command') {
      throw new HostExecutionError('Task has no local_command execution intent; refusing to invent work.');
    }
    // One command is evidence for one declared Action at most. Mapping a single
    // exit status onto several Action records would manufacture completion that the
    // command never independently demonstrated.
    if (task.actions.length > 1) {
      throw new HostExecutionError(
        'The local_command adapter can complete at most one declared Action; split the Task or use a verifiable multi-action adapter.',
      );
    }

    const workspace = this.workspaces.getOrCreate(task.entity_id);
    const cwd = this.workspaces.resolveCwd(workspace, intent.cwd);
    const timeoutMs = Math.min(intent.timeout_ms ?? this.config.default_timeout_ms, this.config.default_timeout_ms);
    const maxOutputBytes = Math.min(
      intent.max_output_bytes ?? this.config.max_output_bytes,
      this.config.max_output_bytes,
    );
    if (timeoutMs < 100 || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new HostExecutionError('Task execution limits are outside the host policy.');
    }

    if (this.active.has(task.entity_id)) {
      throw new HostExecutionError('This Task already has an active sandbox invocation.');
    }
    const controller = new AbortController();
    this.active.set(task.entity_id, controller);
    const quota = new WorkspaceQuotaGuard(
      workspace,
      this.config.workspace_max_bytes,
      () => controller.abort(),
    );
    let result: SandboxResult;
    try {
      quota.start();
      result = await this.provider.run({
        argv: intent.argv,
        workspaceDirectory: workspace,
        cwd,
        timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
        maxOutputBytes,
        env: filterEnvironment(intent.env),
        signal: controller.signal,
      });
    } finally {
      quota.stop();
      if (this.active.get(task.entity_id) === controller) this.active.delete(task.entity_id);
    }

    // Enforced during the run: a crossed ceiling aborts the provider, and the oversized
    // workspace is discarded rather than retained for later ingestion. A failed measurement
    // also stops the run; continuing unmeasured would silently drop the cap.
    if (quota.state.measurementFailure !== undefined) {
      this.workspaces.discard(task.entity_id);
      throw new HostExecutionError(
        `Workspace usage could not be measured (${quota.state.measurementFailure}); the run was stopped rather than left uncapped.`,
      );
    }
    if (quota.state.exceeded) {
      this.workspaces.discard(task.entity_id);
      throw new WorkspaceQuotaExceededError(
        `Workspace exceeded its ${this.config.workspace_max_bytes}-byte limit; the run was stopped.`,
      );
    }

    if (result.cancelled) {
      throw new TaskCancelledError(task.entity_id);
    }
    // Every production boundary must provide proof that its system-call filter was active
    // before exec. Missing or failed evidence is a denial, never an unfiltered success.
    if (BOUNDARY_PROVIDERS.has(this.provider.id) && result.filter?.applied !== true) {
      this.workspaces.discard(task.entity_id);
      throw new SandboxFilterUnavailableError(
        `The system-call filter was not active for this run: ${result.filter?.reason ?? 'no filter evidence'}.`,
      );
    }
    // Resource limits are part of the same pre-exec proof: a run whose limits were not
    // installed is denied rather than allowed to consume unbounded host resources.
    if (BOUNDARY_PROVIDERS.has(this.provider.id) && result.limits?.applied !== true) {
      this.workspaces.discard(task.entity_id);
      throw new SandboxResourceLimitUnavailableError(
        `The per-run resource limits were not active: ${result.limits?.reason ?? 'no resource-limit evidence'}.`,
      );
    }
    if (result.signal === 'SIGSYS' || result.exitCode === SECCOMP_DENIED_EXIT_CODE) {
      this.workspaces.discard(task.entity_id);
      throw new SandboxSyscallDeniedError(
        'The sandboxed command was killed by the system-call filter for using a denied syscall.',
        result.filter?.sha256,
      );
    }
    if (result.spawnError) {
      throw new HostExecutionError('The sandbox could not start the requested command.');
    }
    if (result.timedOut) {
      throw new HostExecutionError('The sandboxed command exceeded its time limit.');
    }
    if (result.exitCode !== 0) {
      throw new HostExecutionError(`The sandboxed command exited with code ${result.exitCode ?? 'unknown'}.`);
    }

    const evidence = [
      `executor:${agentId}`,
      `task:${task.entity_id}`,
      `provider:${result.provider}`,
      `assurance:${result.assurance}`,
      `argv_sha256:${digest(JSON.stringify(intent.argv))}`,
      `cwd_sha256:${digest(cwd)}`,
      `stdout_sha256:${digest(result.stdout)}`,
      `stderr_sha256:${digest(result.stderr)}`,
      `exit_code:${result.exitCode}`,
      `duration_ms:${result.durationMs}`,
      `output_truncated:${result.truncated}`,
      ...(result.filter === undefined
        ? []
        : [
            `syscall_filter:${result.filter.profile}`,
            `syscall_filter_sha256:${result.filter.sha256}`,
            `syscall_filter_applied:${result.filter.applied}`,
          ]),
      ...(result.limits === undefined
        ? []
        : [
            `resource_limit_mechanism:${result.limits.mechanism ?? 'unknown'}`,
            `resource_limit_memory_bytes:${result.limits.memory_bytes}`,
            `resource_limit_cpu_seconds:${result.limits.cpu_seconds}`,
            `resource_limit_processes:${result.limits.processes}`,
            `resource_limits_applied:${result.limits.applied}`,
          ]),
    ];

    return {
      summary: `Local command completed in ${result.durationMs} ms under ${result.provider}.`,
      evidence,
      ...(task.actions.length > 0
        ? {
            completed_actions: task.actions.map((action) => ({
              ...action,
              status: 'completed' as const,
              executed_by: agentId,
            })),
          }
        : {}),
    };
  }

  async coordinate(): Promise<TaskExecutionResult> {
    throw new HostExecutionError(
      'The local command adapter does not coordinate multiple Agents; use a coordination adapter whose evidence can be verified independently.',
    );
  }

  /** Aborts the sandbox invocation for a Task. Returns false when nothing is active. */
  cancelTask(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async ensureAvailable(): Promise<void> {
    if (this.availability && Date.now() - this.availability.checkedAt < 30_000) {
      if (!this.availability.available) {
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.filterFailure === true) {
          throw new SandboxFilterUnavailableError(
            `Local execution is unavailable because the system-call filter failed: ${this.availability.reason}`,
          );
        }
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.resourceLimitFailure === true) {
          throw new SandboxResourceLimitUnavailableError(
            `Local execution is unavailable because the per-run resource limits failed: ${this.availability.reason}`,
          );
        }
        throw new HostUnavailableError(`Local execution is unavailable: ${this.availability.reason}`);
      }
      return;
    }
    let check: { available: boolean; reason: string; filterFailure?: boolean; resourceLimitFailure?: boolean };
    try {
      check = await this.provider.check();
    } catch {
      check = { available: false, reason: 'The sandbox availability probe failed.' };
    }
    this.availability = { checkedAt: Date.now(), ...check };
    if (!check.available) {
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.filterFailure === true) {
        throw new SandboxFilterUnavailableError(
          `Local execution is unavailable because the system-call filter failed: ${check.reason}`,
        );
      }
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.resourceLimitFailure === true) {
        throw new SandboxResourceLimitUnavailableError(
          `Local execution is unavailable because the per-run resource limits failed: ${check.reason}`,
        );
      }
      throw new HostUnavailableError(`Local execution is unavailable: ${check.reason}`);
    }
  }
}
