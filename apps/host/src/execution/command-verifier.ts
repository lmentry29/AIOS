import { createHash } from 'node:crypto';
import type {
  TaskVerificationDecision,
  TaskVerificationPort,
  TaskVerificationRequest,
} from '@aios/orchestration';
import type { VerifierDecisionBody, VerifierDecisionSigner } from './verifier-decision.js';
import type { HostExecutionConfig } from '../config.js';
import {
  HostExecutionError,
  HostUnavailableError,
  SandboxFilterUnavailableError,
  SandboxIsolationUnavailableError,
  SandboxResourceLimitUnavailableError,
} from '../errors.js';
import { evidenceDigest, type ExecutionLedger } from '../persistence/execution-ledger.js';
import {
  EXECUTION_BINDING_VERSION,
  evidenceDigestEquals,
  executionResultBinding,
  isEvidenceDigest,
  isExecutionNonce,
  parseEvidenceEntries,
  resultExecutionNonce,
  snapshotExecutionResult,
} from './evidence.js';
import type { SandboxProvider } from './sandbox.js';
import { SECCOMP_DENIED_EXIT_CODE } from './seccomp.js';
import { WorkspaceQuotaGuard, type RunWorkspaceManager } from './workspace.js';

const FILTER_PROVIDERS = new Set(['bubblewrap', 'docker']);
const BOUNDARY_PROVIDERS = new Set([...FILTER_PROVIDERS, 'gvisor']);

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
  private availability: { checkedAt: number; available: boolean; reason: string; filterFailure?: boolean; isolationFailure?: boolean; resourceLimitFailure?: boolean } | undefined;

  constructor(
    private readonly config: HostExecutionConfig,
    private readonly provider: SandboxProvider,
    private readonly workspaces: RunWorkspaceManager,
    private readonly ledger?: ExecutionLedgerRef,
    private readonly signer?: VerifierDecisionSigner,
  ) {
    this.verifier_id = config.verifier_id;
  }

  async verify(request: TaskVerificationRequest): Promise<TaskVerificationDecision> {
    const decision = await this.verifyInternal(request);
    if (this.signer === undefined) return decision;
    const values = new Map<string, string>();
    for (const line of decision.evidence) {
      const separator = line.indexOf(':');
      if (separator > 0) {
        const key = line.slice(0, separator);
        if (!values.has(key)) values.set(key, line.slice(separator + 1));
      }
    }
    const executionId = values.get('execution_id');
    const attemptText = values.get('execution_attempt');
    const attempt = attemptText !== undefined && /^[1-9][0-9]{0,8}$/.test(attemptText)
      ? Number(attemptText)
      : null;
    const binding = values.get('executor_result_sha256') ?? values.get('bound_result_sha256');
    const body: VerifierDecisionBody = {
      schema_version: 1,
      task_id: request.task.entity_id,
      execution_id: executionId ?? null,
      attempt,
      bound_result_sha256: binding !== undefined && /^[a-f0-9]{64}$/.test(binding) ? binding : null,
      verifier_id: decision.verifier_id,
      accepted: decision.accepted,
      reason: decision.reason,
      evidence: decision.evidence,
    };
    return { ...decision, provenance: this.signer.sign(body) };
  }

  async verifyProvenance(record: Record<string, unknown>): Promise<boolean> {
    if (this.signer === undefined) return true;
    try {
      this.signer.verifyRecord(record);
      return true;
    } catch {
      return false;
    }
  }

  private async verifyInternal(request: TaskVerificationRequest): Promise<TaskVerificationDecision> {
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
    let boundAttempt: { execution_id: string; attempt: number; binding: string } | undefined;
    let bindingProblem: string | undefined;
    const ledger = this.ledger?.current;
    if (ledger === undefined) {
      // The command may still run below for diagnostics, but no result can be accepted
      // without a durable attempt binding.
      bindingProblem = 'The verifier is not bound to a durable execution ledger.';
    } else {
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
        || terminalFailure === 'sandbox_isolation_unavailable'
        || terminalFailure === 'sandbox_resource_limit_unavailable'
        || terminalFailure === 'sandbox_syscall_denied') {
        const failedFilter = attempt.evidence.find((entry) => entry.startsWith('sandbox_filter_sha256:'))?.slice('sandbox_filter_sha256:'.length);
        const reason = terminalFailure === 'disk_quota_exceeded'
          ? 'The durable execution attempt was stopped by the per-workspace disk quota.'
          : terminalFailure === 'sandbox_syscall_denied'
            ? 'The durable execution attempt was killed by the sandbox system-call filter.'
            : terminalFailure === 'sandbox_resource_limit_unavailable'
              ? 'The durable execution attempt could not be launched under the per-run resource limits.'
              : terminalFailure === 'sandbox_isolation_unavailable'
                ? 'The durable execution attempt could not be launched under the sandbox boundary.'
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
      if (attempt.task_id !== request.task.entity_id) {
        return this.rejectWithoutRunning('The durable attempt belongs to a different Task.');
      }
      if (!request.agent_ids.includes(attempt.agent_id)) {
        return this.rejectWithoutRunning('The durable attempt was executed by a different principal.');
      }
      let entries: Map<string, string>;
      try {
        entries = parseEvidenceEntries(attempt.evidence);
      } catch {
        return this.rejectWithoutRunning('The durable attempt evidence is malformed or ambiguous.');
      }
      if (entries.get('execution_binding') !== EXECUTION_BINDING_VERSION) {
        return this.rejectWithoutRunning(
          'The durable attempt has no attempt-bound evidence; re-run the execution under the current evidence version.',
        );
      }
      let snapshot: ReturnType<typeof snapshotExecutionResult>;
      try {
        snapshot = snapshotExecutionResult(request.execution_result);
      } catch {
        return this.rejectWithoutRunning('The executor result is not a bounded plain-data snapshot.');
      }
      const nonce = resultExecutionNonce(snapshot);
      if (!isExecutionNonce(nonce) || entries.get('execution_nonce') !== nonce) {
        return this.rejectWithoutRunning(
          'The executor result nonce does not belong to the durable attempt; a replayed result is rejected.',
        );
      }
      const history = typeof ledger.listForTask === 'function' ? ledger.listForTask(attempt.task_id) : [];
      if (history.some((record) => record.execution_id !== attempt.execution_id
        && record.evidence.includes(`execution_nonce:${nonce}`))) {
        return this.rejectWithoutRunning('The executor result nonce was already used by an earlier attempt; replay is rejected.');
      }
      let observed: string;
      try {
        observed = executionResultBinding({
          execution_id: attempt.execution_id,
          task_id: attempt.task_id,
          agent_id: attempt.agent_id,
          attempt: attempt.attempt,
        }, snapshot);
      } catch {
        return this.rejectWithoutRunning('The executor result is not a bounded plain-data snapshot.');
      }
      const expected = entries.get('bound_result_sha256');
      if (!isEvidenceDigest(expected) || !evidenceDigestEquals(expected, observed)) {
        return this.rejectWithoutRunning('The executor result does not match the durable attempt evidence.');
      }
      boundAttempt = { execution_id: attempt.execution_id, attempt: attempt.attempt, binding: observed };
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
      if (error instanceof SandboxFilterUnavailableError
        || error instanceof SandboxIsolationUnavailableError
        || error instanceof SandboxResourceLimitUnavailableError) {
        this.workspaces.discard(request.task.entity_id);
        const filterFailure = error instanceof SandboxFilterUnavailableError;
        const isolationFailure = error instanceof SandboxIsolationUnavailableError;
        const failure = isolationFailure
          ? 'sandbox_isolation_unavailable'
          : filterFailure
            ? 'sandbox_filter_unavailable'
            : 'sandbox_resource_limit_unavailable';
        return {
          accepted: false,
          reason: isolationFailure
            ? 'The verification command could not be launched under the sandbox boundary.'
            : filterFailure
              ? 'The verification command could not be launched under the system-call filter.'
              : 'The verification command could not be launched under the per-run resource limits.',
          verifier_id: this.verifier_id,
          evidence: [
            `verifier:${this.verifier_id}`,
            `task:${request.task.entity_id}`,
            `verification_failure:${failure}`,
            `${isolationFailure ? 'isolation' : filterFailure ? 'filter' : 'resource_limit'}_error_sha256:${digest(error.message)}`,
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

    if (this.provider.id === 'gvisor' && result.boundary?.applied !== true) {
      this.workspaces.discard(request.task.entity_id);
      return {
        accepted: false,
        reason: 'The verification command was not proven to run under the gVisor Sentry boundary.',
        verifier_id: this.verifier_id,
        evidence: [
          `verifier:${this.verifier_id}`,
          `task:${request.task.entity_id}`,
          'verification_failure:sandbox_isolation_unavailable',
          `isolation_evidence_sha256:${digest(result.boundary?.reason ?? 'missing')}`,
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
    if (FILTER_PROVIDERS.has(this.provider.id) && result.filter?.applied !== true) {
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
    if (BOUNDARY_PROVIDERS.has(this.provider.id) && result.limits?.applied !== true) {
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

    const commandSucceeded = !result.spawnError
      && !result.timedOut
      && result.exitCode === expectedExitCode;
    const accepted = bindingProblem === undefined && commandSucceeded;
    const reason = bindingProblem !== undefined
      ? `The verification command ${commandSucceeded ? 'completed' : 'did not complete'}, but acceptance was denied: ${bindingProblem}`
      : result.spawnError
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
        'verification_evidence_version:2',
        `execution_binding:${boundAttempt === undefined ? 'unbound' : 'attempt-v2'}`,
        `provider:${result.provider}`,
        `assurance:${result.assurance}`,
        `verification_argv_sha256:${digest(JSON.stringify(intent.argv))}`,
        `stdout_sha256:${digest(result.stdout)}`,
        `stderr_sha256:${digest(result.stderr)}`,
        `exit_code:${result.exitCode ?? 'none'}`,
        `expected_exit_code:${expectedExitCode}`,
        `timed_out:${result.timedOut}`,
        `executor_result_sha256:${boundAttempt?.binding ?? 'unbound'}`,
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
        ...(result.boundary === undefined
          ? []
          : [
              `sandbox_boundary:${result.boundary.mechanism}`,
              `sandbox_boundary_applied:${result.boundary.applied}`,
              `sandbox_boundary_version:${result.boundary.version}`,
              `sandbox_boundary_rootless:${result.boundary.rootless}`,
            ]),
        ...(result.engine === undefined
          ? []
          : [
              `sandbox_engine:${result.engine.name}`,
              `sandbox_engine_version:${result.engine.version}`,
              `sandbox_engine_rootless:${result.engine.rootless === null ? 'unknown' : result.engine.rootless}`,
            ]),
        ...(result.provenance === undefined
          ? []
          : [
              `sandbox_runtime_release:${result.provenance.runtime.release}`,
              `sandbox_runtime_sha256:${result.provenance.runtime.binary_sha256}`,
              `sandbox_runtime_artifact_sha512:${result.provenance.runtime.artifact_sha512}`,
              `sandbox_runtime_pin_sha256:${result.provenance.runtime.pin_sha256}`,
              `sandbox_rootfs_sha256:${result.provenance.rootfs.sha256}`,
              `sandbox_rootfs_entries:${result.provenance.rootfs.entries}`,
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
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.isolationFailure === true) {
          throw new SandboxIsolationUnavailableError(
            `Independent verification is unavailable because the sandbox boundary failed: ${this.availability.reason}`,
          );
        }
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.filterFailure === true) {
          throw new SandboxFilterUnavailableError(
            `Independent verification is unavailable because the system-call filter failed: ${this.availability.reason}`,
          );
        }
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.resourceLimitFailure === true) {
          throw new SandboxResourceLimitUnavailableError(
            `Independent verification is unavailable because the per-run resource limits failed: ${this.availability.reason}`,
          );
        }
        throw new HostUnavailableError(`Independent verification is unavailable: ${this.availability.reason}`);
      }
      return;
    }
    let check: { available: boolean; reason: string; filterFailure?: boolean; isolationFailure?: boolean; resourceLimitFailure?: boolean };
    try {
      check = await this.provider.check();
    } catch {
      check = { available: false, reason: 'The sandbox availability probe failed.' };
    }
    this.availability = { checkedAt: Date.now(), ...check };
    if (!check.available) {
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.isolationFailure === true) {
        throw new SandboxIsolationUnavailableError(
          `Independent verification is unavailable because the sandbox boundary failed: ${check.reason}`,
        );
      }
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.filterFailure === true) {
        throw new SandboxFilterUnavailableError(
          `Independent verification is unavailable because the system-call filter failed: ${check.reason}`,
        );
      }
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.resourceLimitFailure === true) {
        throw new SandboxResourceLimitUnavailableError(
          `Independent verification is unavailable because the per-run resource limits failed: ${check.reason}`,
        );
      }
      throw new HostUnavailableError(`Independent verification is unavailable: ${check.reason}`);
    }
  }
}
