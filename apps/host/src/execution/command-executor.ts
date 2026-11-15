import { createHash, randomUUID } from "node:crypto";
import type { TaskEntity, TaskExecutionPlanStep } from "@aios/core";
import {
  TaskCancelledError,
  type AgentExecutionPort,
  type TaskExecutionResult,
} from "@aios/orchestration";
import type { HostExecutionConfig } from "../config.js";
import {
  HostExecutionError,
  HostUnavailableError,
  SandboxFilterUnavailableError,
  SandboxIsolationUnavailableError,
  SandboxResourceLimitUnavailableError,
  SandboxSyscallDeniedError,
  WorkspaceQuotaExceededError,
} from "../errors.js";
import { SECCOMP_DENIED_EXIT_CODE } from "./seccomp.js";
import { ExecutionLedger, type ExecutionLedgerRef } from "../persistence/execution-ledger.js";
import { processStartToken } from "./process-reaper.js";
import type { SandboxProvider, SandboxResult } from "./sandbox.js";
import { WorkspaceQuotaGuard, type RunWorkspaceManager } from "./workspace.js";

const ALLOWED_ENV = /^(LANG|LC_[A-Z0-9_]+|TZ|AIOS_[A-Z0-9_]+)$/;
// Provider configuration, verifier identity and signing material are host-only. A Task can
// never inject them through its declared environment.
const RESERVED_ENV =
  /^AIOS_(VERIFIER_ID|TRUST_ROOT|SIGNING[A-Z0-9_]*|GVISOR[A-Z0-9_]*|ARTIFACT[A-Z0-9_]*)$/;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_PLAN_STEPS = 8;
const FILTER_PROVIDERS = new Set(["bubblewrap", "docker"]);
const BOUNDARY_PROVIDERS = new Set([...FILTER_PROVIDERS, "gvisor"]);

interface CommandIntent {
  argv: string[];
  cwd?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
  env?: Record<string, string>;
}

interface CommandObservation {
  argv: string[];
  cwd: string;
  result: SandboxResult;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function filterEnvironment(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      ALLOWED_ENV.test(key) &&
      !RESERVED_ENV.test(key) &&
      typeof value === "string" &&
      value.length <= 256
    ) {
      allowed[key] = value;
    }
  }
  return allowed;
}

function sandboxProofEvidence(result: SandboxResult): string[] {
  return [
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
          `resource_limit_mechanism:${result.limits.mechanism ?? "unknown"}`,
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
          `sandbox_engine_rootless:${result.engine.rootless === null ? "unknown" : result.engine.rootless}`,
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
  ];
}

function planStepEvidence(index: number, observation: CommandObservation): string {
  const { result, cwd } = observation;
  const parts = [
    `provider=${result.provider}`,
    `assurance=${result.assurance}`,
    `argv_sha256=${digest(JSON.stringify(observation.argv))}`,
    `cwd_sha256=${digest(cwd)}`,
    `stdout_sha256=${digest(result.stdout)}`,
    `stderr_sha256=${digest(result.stderr)}`,
    `exit_code=${result.exitCode ?? "none"}`,
    `duration_ms=${result.durationMs}`,
    `output_truncated=${result.truncated}`,
    `filter_applied=${result.filter?.applied ?? false}`,
    `filter_sha256=${result.filter?.sha256 ?? "none"}`,
    `limits_applied=${result.limits?.applied ?? false}`,
    `boundary_applied=${result.boundary?.applied ?? false}`,
  ];
  return `plan_step_${index + 1}:${parts.join(";")}`;
}

/**
 * Executes the fixed `local_command` capability through one isolation provider.
 *
 * The adapter never turns `argv` into a shell string. A non-zero exit, timeout, spawn
 * failure, missing provider, or missing execution intent fails the dispatch rather than
 * manufacturing a successful result. Raw output is hashed, not copied into evidence,
 * so a command cannot inject credentials or untrusted text into the durable journal.
 *
 * ADR-0039 adds a bounded `local_plan`: one to eight fixed `local.exec` steps executed
 * sequentially in the same per-Task workspace under one total deadline. A plan that
 * declares Actions must bind one unique step to every Action, and the Agent must already
 * be the declared executor of each pending Action. A failed step aborts the plan; partial
 * work is never reported as completed Actions.
 */
export class LocalCommandExecutor implements AgentExecutionPort {
  private availability:
    | {
        checkedAt: number;
        available: boolean;
        reason: string;
        filterFailure?: boolean;
        isolationFailure?: boolean;
        resourceLimitFailure?: boolean;
      }
    | undefined;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly config: HostExecutionConfig,
    private readonly provider: SandboxProvider,
    private readonly workspaces: RunWorkspaceManager,
    /**
     * Optional late-bound durable ledger. Production composes it before the runtime exists
     * and sets `current` before listening; direct adapter tests may omit it. When present,
     * every plan step and sandbox process group is journaled before/after real work.
     */
    private readonly ledger?: ExecutionLedger | ExecutionLedgerRef,
  ) {}

  private currentLedger(): ExecutionLedger | undefined {
    if (this.ledger === undefined) return undefined;
    return this.ledger instanceof ExecutionLedger ? this.ledger : this.ledger.current;
  }

  async validateAgent(agentId: string): Promise<boolean> {
    if (agentId !== this.config.agent_id) return false;
    await this.ensureAvailable();
    return true;
  }

  async executeTask(agentId: string, task: TaskEntity): Promise<TaskExecutionResult> {
    if (agentId !== this.config.agent_id) {
      throw new HostExecutionError(
        "The task was dispatched to an Agent this executor does not own.",
      );
    }
    await this.ensureAvailable();
    const intent = task.execution;
    if (!intent || (intent.kind !== "local_command" && intent.kind !== "local_plan")) {
      throw new HostExecutionError(
        "Task has no local_command or local_plan execution intent; refusing to invent work.",
      );
    }
    if (intent.kind === "local_command" && task.actions.length > 1) {
      // One command is evidence for one declared Action at most. Mapping a single
      // exit status onto several Action records would manufacture completion that the
      // command never independently demonstrated. Use a local_plan instead.
      throw new HostExecutionError(
        "The local_command adapter can complete at most one declared Action; split the Task or use a verifiable local_plan.",
      );
    }
    if (intent.kind === "local_plan") {
      this.validatePlan(agentId, task, intent.steps);
    }

    if (this.active.has(task.entity_id)) {
      throw new HostExecutionError("This Task already has an active sandbox invocation.");
    }
    const controller = new AbortController();
    this.active.set(task.entity_id, controller);
    try {
      return intent.kind === "local_plan"
        ? await this.executePlan(agentId, task, intent, controller)
        : await this.executeSingleCommand(agentId, task, intent, controller);
    } finally {
      if (this.active.get(task.entity_id) === controller) this.active.delete(task.entity_id);
    }
  }

  async coordinate(): Promise<TaskExecutionResult> {
    throw new HostExecutionError(
      "The local command adapter does not coordinate multiple Agents; use a coordination adapter whose evidence can be verified independently.",
    );
  }

  /** Aborts the sandbox invocation for a Task. Returns false when nothing is active. */
  cancelTask(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private validatePlan(
    agentId: string,
    task: TaskEntity,
    steps: readonly TaskExecutionPlanStep[],
  ): void {
    if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) {
      throw new HostExecutionError(
        `A local_plan must contain between 1 and ${MAX_PLAN_STEPS} steps.`,
      );
    }
    if (task.actions.length === 0) {
      if (steps.some((step) => step.action_id !== undefined)) {
        throw new HostExecutionError(
          "A local_plan step cannot name an Action when the Task declares no Actions.",
        );
      }
      return;
    }

    const actions = new Map(task.actions.map((action) => [action.action_id, action]));
    if (actions.size !== task.actions.length) {
      throw new HostExecutionError("The Task contains duplicate Action identifiers.");
    }
    if (steps.length !== task.actions.length) {
      throw new HostExecutionError(
        "A local_plan over declared Actions must contain exactly one step per Action.",
      );
    }
    const seen = new Set<string>();
    for (const step of steps) {
      if (step.action_id === undefined) {
        throw new HostExecutionError(
          "Every step in an Action-backed local_plan must name its Action.",
        );
      }
      if (seen.has(step.action_id)) {
        throw new HostExecutionError("A local_plan cannot bind more than one step to one Action.");
      }
      seen.add(step.action_id);
      const action = actions.get(step.action_id);
      if (action === undefined) {
        throw new HostExecutionError(
          "A local_plan step names an Action that does not belong to this Task.",
        );
      }
      if (action.status !== "pending") {
        throw new HostExecutionError(
          "A local_plan can execute only pending Actions; it cannot replay terminal Action state.",
        );
      }
      if (action.executed_by !== agentId) {
        throw new HostExecutionError(
          "A local_plan cannot execute an Action assigned to a different Agent.",
        );
      }
    }
  }

  private async executeSingleCommand(
    agentId: string,
    task: TaskEntity,
    intent: CommandIntent,
    controller: AbortController,
  ): Promise<TaskExecutionResult> {
    const workspace = this.workspaces.getOrCreate(task.entity_id);
    const timeoutMs = Math.min(
      intent.timeout_ms ?? this.config.default_timeout_ms,
      this.config.default_timeout_ms,
    );
    const maxOutputBytes = Math.min(
      intent.max_output_bytes ?? this.config.max_output_bytes,
      this.config.max_output_bytes,
    );
    if (timeoutMs < 100 || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT_BYTES) {
      throw new HostExecutionError("Task execution limits are outside the host policy.");
    }

    const observation = await this.runCommand(task.entity_id, workspace, intent, {
      timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxOutputBytes,
      controller,
    });
    const { result, cwd } = observation;
    const evidence = [
      `executor:${agentId}`,
      `task:${task.entity_id}`,
      `execution_nonce:${randomUUID()}`,
      `provider:${result.provider}`,
      `assurance:${result.assurance}`,
      `argv_sha256:${digest(JSON.stringify(intent.argv))}`,
      `cwd_sha256:${digest(cwd)}`,
      `stdout_sha256:${digest(result.stdout)}`,
      `stderr_sha256:${digest(result.stderr)}`,
      `exit_code:${result.exitCode}`,
      `duration_ms:${result.durationMs}`,
      `output_truncated:${result.truncated}`,
      ...sandboxProofEvidence(result),
    ];

    return {
      summary: `Local command completed in ${result.durationMs} ms under ${result.provider}.`,
      evidence,
      ...(task.actions.length > 0
        ? {
            completed_actions: task.actions.map((action) => ({
              ...action,
              status: "completed" as const,
              executed_by: agentId,
            })),
          }
        : {}),
    };
  }

  private async executePlan(
    agentId: string,
    task: TaskEntity,
    intent: Extract<NonNullable<TaskEntity["execution"]>, { kind: "local_plan" }>,
    controller: AbortController,
  ): Promise<TaskExecutionResult> {
    const workspace = this.workspaces.getOrCreate(task.entity_id);
    const planBudgetMs = Math.min(
      intent.timeout_ms ?? this.config.default_timeout_ms,
      this.config.default_timeout_ms,
    );
    if (planBudgetMs < 100) {
      throw new HostExecutionError("Plan execution limits are outside the host policy.");
    }
    const deadlineAt = Date.now() + planBudgetMs;
    const stepEvidence: string[] = [];
    let first: CommandObservation | undefined;
    const startedAt = Date.now();
    const ledger = this.currentLedger();
    const execution = ledger?.getForTask(task.entity_id);
    if (ledger !== undefined && (execution === undefined || execution.state !== "running")) {
      throw new HostExecutionError(
        "A local_plan requires a running durable execution attempt before any step starts.",
      );
    }

    for (const [index, step] of intent.steps.entries()) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 100) {
        throw new HostExecutionError("The local_plan exceeded its total time limit.");
      }
      const timeoutMs = Math.min(step.timeout_ms ?? remainingMs, remainingMs, MAX_TIMEOUT_MS);
      const maxOutputBytes = Math.min(
        step.max_output_bytes ?? this.config.max_output_bytes,
        this.config.max_output_bytes,
      );
      if (timeoutMs < 100 || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT_BYTES) {
        throw new HostExecutionError("Plan step limits are outside the host policy.");
      }
      if (ledger !== undefined && execution !== undefined) {
        ledger.beginStep(execution.execution_id, {
          step_index: index,
          step_count: intent.steps.length,
          ...(step.action_id === undefined ? {} : { action_id: step.action_id }),
          argv_sha256: digest(JSON.stringify(step.argv)),
        });
      }
      let observation: CommandObservation;
      try {
        observation = await this.runCommand(task.entity_id, workspace, step, {
          timeoutMs,
          maxOutputBytes,
          controller,
          ...(ledger === undefined || execution === undefined
            ? {}
            : { stepIndex: index, executionId: execution.execution_id, ledger }),
        });
      } catch (error) {
        if (ledger !== undefined && execution !== undefined) {
          try {
            ledger.failStep(
              execution.execution_id,
              index,
              error instanceof TaskCancelledError
                ? "task_cancelled"
                : error instanceof Error && error.name.length > 0
                  ? error.name.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120)
                  : "execution_failed",
            );
          } catch {
            // A cancellation or competing terminal transition already closed the step;
            // the original execution error remains the authoritative failure.
          }
        }
        throw error;
      }
      first ??= observation;
      const evidenceLine = planStepEvidence(stepEvidence.length, observation);
      if (ledger !== undefined && execution !== undefined) {
        ledger.completeStep(execution.execution_id, index, {
          cwd_sha256: digest(observation.cwd),
          provider: observation.result.provider,
          assurance: observation.result.assurance,
          exit_code: observation.result.exitCode,
          duration_ms: observation.result.durationMs,
          stdout_sha256: digest(observation.result.stdout),
          stderr_sha256: digest(observation.result.stderr),
          output_truncated: observation.result.truncated,
          sandbox_evidence_sha256: digest(evidenceLine),
        });
      }
      stepEvidence.push(evidenceLine);
    }

    if (first === undefined) {
      throw new HostExecutionError("The local_plan had no executable steps.");
    }
    const evidence = [
      `executor:${agentId}`,
      `task:${task.entity_id}`,
      `execution_nonce:${randomUUID()}`,
      `provider:${first.result.provider}`,
      `assurance:${first.result.assurance}`,
      "plan_evidence_version:1",
      `plan_step_count:${intent.steps.length}`,
      `plan_timeout_ms:${planBudgetMs}`,
      `plan_actions_sha256:${digest(JSON.stringify(task.actions.map((action) => action.action_id)))}`,
      ...stepEvidence,
    ];
    const elapsedMs = Date.now() - startedAt;
    return {
      summary: `Bounded local execution plan completed ${intent.steps.length} of ${intent.steps.length} steps in ${elapsedMs} ms under ${first.result.provider}.`,
      evidence,
      ...(task.actions.length > 0
        ? {
            completed_actions: task.actions.map((action) => ({
              ...action,
              status: "completed" as const,
              executed_by: agentId,
            })),
          }
        : {}),
    };
  }

  /**
   * Runs one fixed argv through the provider and enforces every boundary proof the
   * selected provider must supply. This is the only place a plan step or single command
   * reaches the sandbox; both paths therefore get identical quota, cancellation and
   * fail-closed checks.
   */
  private async runCommand(
    taskId: string,
    workspace: string,
    command: CommandIntent,
    options: {
      timeoutMs: number;
      maxOutputBytes: number;
      controller: AbortController;
      stepIndex?: number;
      executionId?: string;
      ledger?: ExecutionLedger;
    },
  ): Promise<CommandObservation> {
    const cwd = this.workspaces.resolveCwd(workspace, command.cwd);
    const quota = new WorkspaceQuotaGuard(workspace, this.config.workspace_max_bytes, () =>
      options.controller.abort(),
    );
    const onProcessGroup =
      options.ledger === undefined ||
      options.executionId === undefined ||
      options.stepIndex === undefined
        ? undefined
        : (pid: number): void => {
            const startToken = processStartToken(pid);
            options.ledger?.recordProcessGroup(options.executionId as string, {
              step_index: options.stepIndex as number,
              pid,
              process_group: pid,
              provider: this.provider.id,
              ...(startToken === undefined ? {} : { start_token: startToken }),
            });
          };
    let result: SandboxResult;
    try {
      quota.start();
      result = await this.provider.run({
        argv: command.argv,
        workspaceDirectory: workspace,
        cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        env: filterEnvironment(command.env),
        signal: options.controller.signal,
        ...(onProcessGroup === undefined ? {} : { onProcessGroup }),
      });
    } finally {
      quota.stop();
    }

    // Enforced during the run: a crossed ceiling aborts the provider, and the oversized
    // workspace is discarded rather than retained for later ingestion. A failed measurement
    // also stops the run; continuing unmeasured would silently drop the cap.
    if (quota.state.measurementFailure !== undefined) {
      this.workspaces.discard(taskId);
      throw new HostExecutionError(
        `Workspace usage could not be measured (${quota.state.measurementFailure}); the run was stopped rather than left uncapped.`,
      );
    }
    if (quota.state.exceeded) {
      this.workspaces.discard(taskId);
      throw new WorkspaceQuotaExceededError(
        `Workspace exceeded its ${this.config.workspace_max_bytes}-byte limit; the run was stopped.`,
      );
    }

    if (result.cancelled) {
      throw new TaskCancelledError(taskId);
    }
    // gVisor's boundary is its user-space Sentry, not a host seccomp filter. Require its
    // distinct boundary proof; do not let a gVisor run borrow a filter claim it never made.
    if (this.provider.id === "gvisor" && result.boundary?.applied !== true) {
      this.workspaces.discard(taskId);
      throw new SandboxIsolationUnavailableError(
        `The gVisor Sentry boundary was not active for this run: ${result.boundary?.reason ?? "no boundary evidence"}.`,
      );
    }
    // Every filter-based boundary must provide proof that its system-call filter was active
    // before exec. Missing or failed evidence is a denial, never an unfiltered success.
    if (FILTER_PROVIDERS.has(this.provider.id) && result.filter?.applied !== true) {
      this.workspaces.discard(taskId);
      throw new SandboxFilterUnavailableError(
        `The system-call filter was not active for this run: ${result.filter?.reason ?? "no filter evidence"}.`,
      );
    }
    // Resource limits are part of the same pre-exec proof: a run whose limits were not
    // installed is denied rather than allowed to consume unbounded host resources.
    if (BOUNDARY_PROVIDERS.has(this.provider.id) && result.limits?.applied !== true) {
      this.workspaces.discard(taskId);
      throw new SandboxResourceLimitUnavailableError(
        `The per-run resource limits were not active: ${result.limits?.reason ?? "no resource-limit evidence"}.`,
      );
    }
    if (result.signal === "SIGSYS" || result.exitCode === SECCOMP_DENIED_EXIT_CODE) {
      this.workspaces.discard(taskId);
      throw new SandboxSyscallDeniedError(
        "The sandboxed command was killed by the system-call filter for using a denied syscall.",
        result.filter?.sha256,
      );
    }
    if (result.spawnError) {
      throw new HostExecutionError("The sandbox could not start the requested command.");
    }
    if (result.timedOut) {
      throw new HostExecutionError("The sandboxed command exceeded its time limit.");
    }
    if (result.exitCode !== 0) {
      throw new HostExecutionError(
        `The sandboxed command exited with code ${result.exitCode ?? "unknown"}.`,
      );
    }

    return { cwd, result, argv: command.argv };
  }

  private async ensureAvailable(): Promise<void> {
    if (this.availability && Date.now() - this.availability.checkedAt < 30_000) {
      if (!this.availability.available) {
        if (
          BOUNDARY_PROVIDERS.has(this.provider.id) &&
          this.availability.isolationFailure === true
        ) {
          throw new SandboxIsolationUnavailableError(
            `Local execution is unavailable because the sandbox boundary failed: ${this.availability.reason}`,
          );
        }
        if (BOUNDARY_PROVIDERS.has(this.provider.id) && this.availability.filterFailure === true) {
          throw new SandboxFilterUnavailableError(
            `Local execution is unavailable because the system-call filter failed: ${this.availability.reason}`,
          );
        }
        if (
          BOUNDARY_PROVIDERS.has(this.provider.id) &&
          this.availability.resourceLimitFailure === true
        ) {
          throw new SandboxResourceLimitUnavailableError(
            `Local execution is unavailable because the per-run resource limits failed: ${this.availability.reason}`,
          );
        }
        throw new HostUnavailableError(
          `Local execution is unavailable: ${this.availability.reason}`,
        );
      }
      return;
    }
    let check: {
      available: boolean;
      reason: string;
      filterFailure?: boolean;
      isolationFailure?: boolean;
      resourceLimitFailure?: boolean;
    };
    try {
      check = await this.provider.check();
    } catch {
      check = { available: false, reason: "The sandbox availability probe failed." };
    }
    this.availability = { checkedAt: Date.now(), ...check };
    if (!check.available) {
      if (BOUNDARY_PROVIDERS.has(this.provider.id) && check.isolationFailure === true) {
        throw new SandboxIsolationUnavailableError(
          `Local execution is unavailable because the sandbox boundary failed: ${check.reason}`,
        );
      }
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
