import { createHash } from 'node:crypto';
import type {
  TaskVerificationDecision,
  TaskVerificationPort,
  TaskVerificationRequest,
} from '@aios/orchestration';
import type { HostExecutionConfig } from '../config.js';
import { HostExecutionError, HostUnavailableError } from '../errors.js';
import type { SandboxProvider } from './sandbox.js';
import type { RunWorkspaceManager } from './workspace.js';

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Runs the Task's independent verification command in a fresh sandbox invocation.
 *
 * It deliberately does not accept because the executor said so. The executor's result
 * is bound by digest for audit, then the verifier's own command is run and its actual
 * exit status determines the decision. The verifier has a distinct principal identity
 * configured by the host; the kernel additionally rejects a verifier that is also an
 * executor.
 */
export class LocalCommandVerifier implements TaskVerificationPort {
  readonly verifier_id: string;
  private availability: { checkedAt: number; available: boolean; reason: string } | undefined;

  constructor(
    private readonly config: HostExecutionConfig,
    private readonly provider: SandboxProvider,
    private readonly workspaces: RunWorkspaceManager,
  ) {
    this.verifier_id = config.verifier_id;
  }

  async verify(request: TaskVerificationRequest): Promise<TaskVerificationDecision> {
    if (request.agent_ids.includes(this.verifier_id)) {
      throw new HostExecutionError('The verifier must be independent from every executor.');
    }
    await this.ensureAvailable();
    const intent = request.task.verification;
    if (!intent || intent.kind !== 'local_command') {
      throw new HostExecutionError('Task has no independent local_command verification intent.');
    }

    const workspace = this.workspaces.getOrCreate(request.task.entity_id);
    const cwd = this.workspaces.resolveCwd(workspace, intent.cwd);
    const timeoutMs = Math.min(intent.timeout_ms ?? this.config.default_timeout_ms, this.config.default_timeout_ms);
    const expectedExitCode = intent.expected_exit_code ?? 0;
    const result = await this.provider.run({
      argv: intent.argv,
      workspaceDirectory: workspace,
      cwd,
      timeoutMs,
      maxOutputBytes: this.config.max_output_bytes,
      env: { AIOS_TASK_ID: request.task.entity_id, AIOS_VERIFIER_ID: this.verifier_id },
    });

    const accepted = !result.spawnError
      && !result.timedOut
      && result.exitCode === expectedExitCode;
    const reason = result.spawnError
      ? 'Verification command could not be started.'
      : result.timedOut
        ? 'Verification command exceeded its time limit.'
        : accepted
          ? `Verification command exited with the expected code ${expectedExitCode}.`
          : `Verification command exited with ${result.exitCode ?? 'no code'} instead of ${expectedExitCode}.`;

    return {
      accepted,
      reason,
      evidence: [
        `verifier:${this.verifier_id}`,
        `task:${request.task.entity_id}`,
        `provider:${result.provider}`,
        `assurance:${result.assurance}`,
        `verification_argv_sha256:${digest(JSON.stringify(intent.argv))}`,
        `stdout_sha256:${digest(result.stdout)}`,
        `stderr_sha256:${digest(result.stderr)}`,
        `exit_code:${result.exitCode ?? 'none'}`,
        `expected_exit_code:${expectedExitCode}`,
        `timed_out:${result.timedOut}`,
        `executor_result_sha256:${digest(JSON.stringify(request.execution_result))}`,
      ],
    };
  }

  private async ensureAvailable(): Promise<void> {
    if (this.availability && Date.now() - this.availability.checkedAt < 30_000) {
      if (!this.availability.available) {
        throw new HostUnavailableError(`Independent verification is unavailable: ${this.availability.reason}`);
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
      throw new HostUnavailableError(`Independent verification is unavailable: ${check.reason}`);
    }
  }
}
