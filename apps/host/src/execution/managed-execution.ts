import type { TaskEntity } from '@aios/core';
import {
  ExecutionCapacityError,
  TaskCancelledError,
  type AgentExecutionPort,
  type ExecutionAttemptRequest,
  type TaskExecutionResult,
} from '@aios/orchestration';
import {
  SandboxFilterUnavailableError,
  SandboxSyscallDeniedError,
  WorkspaceQuotaExceededError,
} from '../errors.js';
import { type ExecutionLedger, type ExecutionRecord, evidenceDigest } from '../persistence/execution-ledger.js';

export interface CancellableExecutionPort {
  cancelTask(taskId: string): boolean;
}

function isCancellable(value: AgentExecutionPort): value is AgentExecutionPort & CancellableExecutionPort {
  return typeof (value as Partial<CancellableExecutionPort>).cancelTask === 'function';
}

function failureCode(error: unknown): string {
  if (error instanceof WorkspaceQuotaExceededError) return 'disk_quota_exceeded';
  if (error instanceof SandboxFilterUnavailableError) return 'sandbox_filter_unavailable';
  if (error instanceof SandboxSyscallDeniedError) return 'sandbox_syscall_denied';
  if (error instanceof TaskCancelledError) return 'task_cancelled';
  if (error instanceof Error && error.name.length > 0) {
    return error.name.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
  }
  return 'execution_failed';
}

/**
 * Host-owned execution lifecycle around any AgentExecutionPort.
 *
 * - Enforces the configured concurrency cap. A dispatch beyond the cap is rejected with
 *   `ExecutionCapacityError` before the kernel writes active lifecycle state, rather than
 *   being silently fanned out. This is a non-blocking, deterministic reject policy.
 * - Journals `running` before invoking the executor, then one terminal state.
 * - Rechecks the durable ledger after the executor returns, so a late result cannot
 *   overwrite a cancellation.
 * - Aborts the underlying executor when cancellation is requested; the local executor
 *   terminates the sandbox child and returns a `cancelled` result.
 *
 * The wrapper is not a sandbox and does not add isolation. It only manages lifecycle.
 */
export class ManagedExecutionPort implements AgentExecutionPort {
  private active = 0;

  constructor(
    private readonly delegate: AgentExecutionPort,
    private readonly ledger: ExecutionLedger,
    private readonly maxConcurrentTasks: number,
  ) {
    if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
      throw new Error('Execution concurrency limit must be a positive integer.');
    }
  }

  hasCapacity(): boolean {
    return this.active < this.maxConcurrentTasks;
  }

  async validateAgent(agentId: string): Promise<boolean> {
    return this.delegate.validateAgent(agentId);
  }

  async executeTask(
    agentId: string,
    task: TaskEntity,
    attempt?: ExecutionAttemptRequest,
  ): Promise<TaskExecutionResult> {
    // An initial dispatch may never run a Task whose latest attempt was cancelled. A
    // retry is the only path that appends after a cancellation, and it is separately
    // authorized; resume requires an interrupted predecessor, so it is never cancelled.
    if (attempt === undefined && this.ledger.isCancelled(task.entity_id)) {
      throw new TaskCancelledError(task.entity_id);
    }
    if (!this.hasCapacity()) throw new ExecutionCapacityError();

    this.active += 1;
    let execution: ExecutionRecord;
    try {
      const request = {
        task_id: task.entity_id,
        ...(task.assigned_workflow === undefined ? {} : { workflow_id: task.assigned_workflow }),
        agent_id: agentId,
      };
      execution = attempt?.kind === 'resume'
        ? this.ledger.resume({ ...request, previous_execution_id: attempt.previous_execution_id })
        : attempt?.kind === 'retry'
          ? this.ledger.retry({ ...request, previous_execution_id: attempt.previous_execution_id })
          : this.ledger.start(request);
    } catch (error) {
      this.active -= 1;
      throw error;
    }

    try {
      const result = await this.delegate.executeTask(agentId, task);
      const current = this.ledger.getForTask(task.entity_id);
      if (current?.execution_id !== execution.execution_id || current.state !== 'running') {
        throw new TaskCancelledError(task.entity_id);
      }
      this.ledger.complete(execution.execution_id, [
        `result_sha256:${evidenceDigest(result)}`,
        `evidence_sha256:${evidenceDigest(result.evidence)}`,
      ]);
      return result;
    } catch (error) {
      const current = this.ledger.getForTask(task.entity_id);
      if (current?.execution_id === execution.execution_id && current.state === 'running') {
        if (error instanceof TaskCancelledError) {
          this.ledger.cancel({
            task_id: task.entity_id,
            ...(task.assigned_workflow === undefined ? {} : { workflow_id: task.assigned_workflow }),
            actor_id: agentId,
            reason_code: 'execution_cancelled',
          });
        } else {
          const code = failureCode(error);
          this.ledger.fail(execution.execution_id, code, [
            `error_type:${evidenceDigest(code)}`,
            ...(error instanceof SandboxSyscallDeniedError && error.filterSha256 !== undefined
              ? [`sandbox_filter_sha256:${error.filterSha256}`]
              : []),
          ]);
        }
      }
      throw error;
    } finally {
      this.active -= 1;
    }
  }

  async coordinate(agents: string[], task: TaskEntity): Promise<TaskExecutionResult> {
    return this.delegate.coordinate(agents, task);
  }

  /** Aborts the actual executor. Ledger cancellation is performed by the authorized route. */
  cancelTask(taskId: string): boolean {
    return isCancellable(this.delegate) ? this.delegate.cancelTask(taskId) : false;
  }
}
