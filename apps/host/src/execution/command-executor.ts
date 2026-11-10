import { createHash } from 'node:crypto';
import type { TaskEntity } from '@aios/core';
import type { AgentExecutionPort, TaskExecutionResult } from '@aios/orchestration';
import type { HostExecutionConfig } from '../config.js';
import { HostExecutionError, HostUnavailableError } from '../errors.js';
import type { SandboxProvider } from './sandbox.js';
import type { RunWorkspaceManager } from './workspace.js';

const ALLOWED_ENV = /^(LANG|LC_[A-Z0-9_]+|TZ|AIOS_[A-Z0-9_]+)$/;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_048_576;

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
  private availability: { checkedAt: number; available: boolean; reason: string } | undefined;

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

    const result = await this.provider.run({
      argv: intent.argv,
      workspaceDirectory: workspace,
      cwd,
      timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxOutputBytes,
      env: filterEnvironment(intent.env),
    });

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

  private async ensureAvailable(): Promise<void> {
    if (this.availability && Date.now() - this.availability.checkedAt < 30_000) {
      if (!this.availability.available) {
        throw new HostUnavailableError(`Local execution is unavailable: ${this.availability.reason}`);
      }
      return;
    }
    let check: { available: boolean; reason: string };
    try {
      check = await this.provider.check();
    } catch {
      check = { available: false, reason: 'The sandbox availability probe failed.' };
    }
    this.availability = { checkedAt: Date.now(), ...check };
    if (!check.available) {
      throw new HostUnavailableError(`Local execution is unavailable: ${check.reason}`);
    }
  }
}
