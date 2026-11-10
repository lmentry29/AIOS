import { createHash } from 'node:crypto';
import type {
  TaskVerificationDecision,
  TaskVerificationPort,
  TaskVerificationRequest,
} from '@aios/orchestration';
import type { HostExecutionConfig } from '../config.js';
import {
  HostExecutionError,
  HostUnavailableError,
  SandboxFilterUnavailableError,
  SandboxResourceLimitUnavailableError,
} from '../errors.js';
import { evidenceDigest, type ExecutionLedger } from '../persistence/execution-ledger.js';
import type { SandboxProvider } from './sandbox.js';
import { SECCOMP_DENIED_EXIT_CODE } from './seccomp.js';
import { WorkspaceQuotaGuard, type RunWorkspaceManager } from './workspace.js';

/** Late-bound reference to the host's durable execution ledger. */
export interface ExecutionLedgerRef {
  current?: ExecutionLedger;
}

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
  private availability: { checkedAt: number; available: boolean; reason: string; filterFailure?: boolean; resourceLimitFailure?: boolean } | undefined;

  constructor(
    private readonly config: HostExecutionConfig,
    private readonly provider: SandboxProvider,
    private readonly workspaces: RunWorkspaceManager,
    private readonly ledger?: ExecutionLedgerRef,
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

    // Bind acceptance to the durable attempt rather than to whatever object reached this
    // port. The executor's committed record is the authority; a forged or replayed result
    // whose digest does not match it is rejected before the verification command runs.
    let boundAttempt: { execution_id: string; attempt: number } | undefined;
    if (this.ledger !== undefined) {
      const ledger = this.ledger.current;
      if (ledger === undefined) {
        throw new HostExecutionError('The verifier is not bound to a durable execution ledger.');
      }
      const attempt = ledger.getForTask(request.task.entity_id);
      if (attempt === undefined) {
        return this.rejectWithoutRunning('No completed durable execution attempt exists for this Task.');
      }
      // A quota- or filter-stopped run is a terminal durable failure, never a success.
      // Bind the rejection to that exact attempt and its evidence, so a caller cannot
      // present the failed run as an accepted result or detach the failure from its
      // journal record.
      const terminalFailure = attempt.state === 'failed' ? attempt.reason_code : undefined;
      if (terminalFailure === 'disk_quota_exceeded'
        || terminalFailure === 'sandbox_filter_unavailable'
        || terminalFailure === 'sandbox_resource_limit_unavailable'
        || terminalFailure === 'sandbox_syscall_denied') {
        const failedFilter = attempt.evidence.find((entry) => entry.startsWith('sandbox_filter_sha256:'))?.slice('sandbox_filter_sha256:'.length);
        const reason = terminalFailure === 'disk_quota_exceeded'
          ? 'The durable execution attempt was stopped by the per-workspace disk quota.'
          : terminalFailure === 'sandbox_syscall_denied'
            ? 'The durable execution attempt was killed by the sandbox system-call filter.'
            : terminalFailure === 'sandbox_resource_limit_unavailable'
              ? 'The durable execution attempt could not be launched under the per-run resource limits.'
              : 'The durable execution attempt could not be launched under the system-call filter.';
        return {
          accepted: false,
          reason,
          verifier_id: this.verifier_id,
          evidence: [
            `verifier:${this.verifier_id}`,
            `task:${request.task.entity_id}`,
            `execution_id:${attempt.execution_id}`,
            `execution_attempt:${attempt.attempt}`,
            `failure_reason_code:${terminalFailure}`,
            `failure_evidence_sha256:${evidenceDigest(attempt.evidence)}`,
            ...(failedFilter === undefined ? [] : [`failed_sandbox_filter_sha256:${failedFilter}`]),
          ],
        };
      }
      if (attempt.state !== 'completed') {
        return this.rejectWithoutRunning('No completed durable execution attempt exists for this Task.');
      }
      if (!request.agent_ids.includes(attempt.agent_id)) {
        return this.rejectWithoutRunning('The durable attempt was executed by a different principal.');
      }
      const expected = attempt.evidence.find((entry) => entry.startsWith('result_sha256:'))?.slice('result_sha256:'.length);
      if (expected === undefined || expected !== evidenceDigest(request.execution_result)) {
        return this.rejectWithoutRunning('The executor result does not match the durable attempt evidence.');
      }
      boundAttempt = { execution_id: attempt.execution_id, attempt: attempt.attempt };
    }

    const workspace = this.workspaces.getOrCreate(request.task.entity_id);
    const cwd = this.workspaces.resolveCwd(workspace, intent.cwd);
    const timeoutMs = Math.min(intent.timeout_ms ?? this.config.default_timeout_ms, this.config.default_timeout_ms);
    const expectedExitCode = intent.expected_exit_code ?? 0;
    const controller = new AbortController();
    const quota = new WorkspaceQuotaGuard(
      workspace,
      this.config.workspace_max_bytes,
      () => controller.abort(),
    );
    let result: Awaited<ReturnType<SandboxProvider['run']>>;
    try {
      quota.start();
      result = await this.provider.run({
        argv: intent.argv,
        workspaceDirectory: workspace,
        cwd,
        timeoutMs,
        maxOutputBytes: this.config.max_output_bytes,
        env: { AIOS_TASK_ID: request.task.entity_id, AIOS_VERIFIER_ID: this.verifier_id },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof SandboxFilterUnavailableError) {
        this.workspaces.discard(request.task.entity_id);
        return {
          accepted: false,
          reason: 'The verification command could not be launched under the system-call filter.',
          verifier_id: this.verifier_id,
          evidence: [
            `verifier:${this.verifier_id}`,
            `task:${request.task.entity_id}`,
            'verification_failure:sandbox_filter_unavailable',
            `filter_error_sha256:${digest(error.message)}`,
            ...(boundAttempt === undefined
              ? []
              : [
                  `execution_id:${boundAttempt.execution_id}`,
                  `execution_attempt:${boundAttempt.attempt}`,
                  `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
                ]),
          ],
        };
      }
      throw error;
    } finally {
      quota.stop();
    }

    if (quota.state.measurementFailure !== undefined || quota.state.exceeded) {
      this.workspaces.discard(request.task.entity_id);
      return {
        accepted: false,
        reason: quota.state.exceeded
          ? 'Verification workspace exceeded its disk limit; the command was stopped and no artifact was accepted.'
          : 'Verification workspace usage could not be measured; the command was stopped rather than accepted unmeasured.',
        verifier_id: this.verifier_id,
        evidence: [
          `verifier:${this.verifier_id}`,
          `task:${request.task.entity_id}`,
          `quota_limit_bytes:${this.config.workspace_max_bytes}`,
          `quota_exceeded:${quota.state.exceeded}`,
          `quota_measurement_failure:${quota.state.measurementFailure !== undefined}`,
          ...(boundAttempt === undefined
            ? []
            : [
                `execution_id:${boundAttempt.execution_id}`,
                `execution_attempt:${boundAttempt.attempt}`,
                `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
              ]),
        ],
      };
    }

    if (this.provider.id === 'bubblewrap' && result.filter?.applied !== true) {
      this.workspaces.discard(request.task.entity_id);
      return {
        accepted: false,
        reason: 'The verification command was not proven to run under the system-call filter.',
        verifier_id: this.verifier_id,
        evidence: [
          `verifier:${this.verifier_id}`,
          `task:${request.task.entity_id}`,
          'verification_failure:sandbox_filter_unavailable',
          `filter_evidence_sha256:${digest(result.filter?.reason ?? 'missing')}`,
          ...(boundAttempt === undefined
            ? []
            : [
                `execution_id:${boundAttempt.execution_id}`,
                `execution_attempt:${boundAttempt.attempt}`,
                `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
              ]),
        ],
      };
    }
    if (this.provider.id === 'bubblewrap' && result.limits?.applied !== true) {
      this.workspaces.discard(request.task.entity_id);
      return {
        accepted: false,
        reason: 'The verification command was not proven to run under the per-run resource limits.',
        verifier_id: this.verifier_id,
        evidence: [
          `verifier:${this.verifier_id}`,
          `task:${request.task.entity_id}`,
          'verification_failure:sandbox_resource_limit_unavailable',
          `resource_limit_evidence_sha256:${digest(result.limits?.reason ?? 'missing')}`,
          ...(boundAttempt === undefined
            ? []
            : [
                `execution_id:${boundAttempt.execution_id}`,
                `execution_attempt:${boundAttempt.attempt}`,
                `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
              ]),
        ],
      };
    }
    if (result.signal === 'SIGSYS' || result.exitCode === SECCOMP_DENIED_EXIT_CODE) {
      this.workspaces.discard(request.task.entity_id);
      return {
        accepted: false,
        reason: 'The verification command was killed by the sandbox system-call filter.',
        verifier_id: this.verifier_id,
        evidence: [
          `verifier:${this.verifier_id}`,
          `task:${request.task.entity_id}`,
          'verification_failure:sandbox_syscall_denied',
          `exit_code:${result.exitCode}`,
          `syscall_filter_sha256:${result.filter?.sha256 ?? 'unknown'}`,
          ...(boundAttempt === undefined
            ? []
            : [
                `execution_id:${boundAttempt.execution_id}`,
                `execution_attempt:${boundAttempt.attempt}`,
                `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
              ]),
        ],
      };
    }

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
      verifier_id: this.verifier_id,
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
              `resource_limit_memory_bytes:${result.limits.memory_bytes}`,
              `resource_limit_cpu_seconds:${result.limits.cpu_seconds}`,
              `resource_limit_processes:${result.limits.processes}`,
              `resource_limits_applied:${result.limits.applied}`,
            ]),
        ...(boundAttempt === undefined
          ? []
          : [
              `execution_id:${boundAttempt.execution_id}`,
              `execution_attempt:${boundAttempt.attempt}`,
              `bound_result_sha256:${evidenceDigest(request.execution_result)}`,
            ]),
      ],
    };
  }

  private rejectWithoutRunning(reason: string): TaskVerificationDecision {
    return {
      accepted: false,
      reason,
      verifier_id: this.verifier_id,
      evidence: [`verifier:${this.verifier_id}`, 'execution_binding:rejected'],
    };
  }

  private async ensureAvailable(): Promise<void> {
    if (this.availability && Date.now() - this.availability.checkedAt < 30_000) {
      if (!this.availability.available) {
        if (this.provider.id === 'bubblewrap' && this.availability.filterFailure === true) {
          throw new SandboxFilterUnavailableError(
            `Independent verification is unavailable because the system-call filter failed: ${this.availability.reason}`,
          );
        }
        if (this.provider.id === 'bubblewrap' && this.availability.resourceLimitFailure === true) {
          throw new SandboxResourceLimitUnavailableError(
            `Independent verification is unavailable because the per-run resource limits failed: ${this.availability.reason}`,
          );
        }
        throw new HostUnavailableError(`Independent verification is unavailable: ${this.availability.reason}`);
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
      if (this.provider.id === 'bubblewrap' && check.filterFailure === true) {
        throw new SandboxFilterUnavailableError(
          `Independent verification is unavailable because the system-call filter failed: ${check.reason}`,
        );
      }
      if (this.provider.id === 'bubblewrap' && check.resourceLimitFailure === true) {
        throw new SandboxResourceLimitUnavailableError(
          `Independent verification is unavailable because the per-run resource limits failed: ${check.reason}`,
        );
      }
      throw new HostUnavailableError(`Independent verification is unavailable: ${check.reason}`);
    }
  }
}
