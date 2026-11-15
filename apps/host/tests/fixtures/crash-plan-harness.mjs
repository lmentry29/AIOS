/**
 * Test-only crash harness.
 *
 * Runs a real bounded `local_plan` through the production `LocalCommandExecutor`,
 * `ManagedExecutionPort`, verifier and `OrchestrationKernel`, against a durable
 * `DurableOperationalStore`. It never shuts down cleanly: the parent test SIGKILLs this
 * process at the selected durability boundary, then reopens the same directory from a
 * fresh kernel/store.
 *
 * The sandbox provider is deliberately test-only and unsandboxed (it runs argv through the
 * shared process helper). It exists to prove journal/recovery behavior, not isolation.
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { TaskEntity, WorkflowEntity } from "@aios/core";
import { OrchestrationKernel } from "@aios/orchestration";
import { LocalCommandExecutor } from "../../dist/execution/command-executor.js";
import { LocalCommandVerifier } from "../../dist/execution/command-verifier.js";
import { ManagedExecutionPort } from "../../dist/execution/managed-execution.js";
import { runCapturedProcess } from "../../dist/execution/process.js";
import { RunWorkspaceManager } from "../../dist/execution/workspace.js";
import { DurableOperationalStore } from "../../dist/persistence/operational-store.js";

const stateDirectory = process.env.AIOS_CRASH_STATE;
const workspaceDirectory = process.env.AIOS_CRASH_WORKSPACES;
const boundary = process.env.AIOS_CRASH_BOUNDARY;
const readyPath = process.env.AIOS_CRASH_READY;
const childPidPath = process.env.AIOS_CRASH_CHILD_PID;
const taskId = process.env.AIOS_CRASH_TASK;
const workflowId = process.env.AIOS_CRASH_WORKFLOW;
const agentId = process.env.AIOS_CRASH_AGENT;
const verifierId = process.env.AIOS_CRASH_VERIFIER;
const founder = "human:founder";

if (
  !stateDirectory ||
  !workspaceDirectory ||
  !boundary ||
  !readyPath ||
  !childPidPath ||
  !taskId ||
  !workflowId ||
  !agentId ||
  !verifierId
) {
  throw new Error("Crash harness environment is incomplete.");
}

function ready() {
  writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
}

function holdForever() {
  return new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}

const now = new Date().toISOString();
const task = TaskEntity.parse({
  entity_id: taskId,
  entity_type: "task",
  name: "Crash recovery bounded plan",
  lifecycle_state: "created",
  lifecycle_history: [],
  created_at: now,
  created_by: founder,
  modified_at: now,
  version: 1,
  organizational_containers: [],
  owner_id: founder,
  owner_type: "human",
  relationships: [],
  work_hierarchy_parent: { entity_id: randomUUID(), level: "objective" },
  actions: [],
  execution: {
    kind: "local_plan",
    timeout_ms: 30_000,
    steps: [
      {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'step-one\\n')",
          "step-one.txt",
        ],
      },
      {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'step-two\\n')",
          "step-two.txt",
        ],
      },
    ],
  },
  verification: { kind: "local_command", argv: ["/bin/true"] },
});
const workflow = WorkflowEntity.parse({
  entity_id: workflowId,
  entity_type: "workflow",
  name: "Crash recovery workflow",
  steps: [taskId],
  governing_loop: "system_execution_loop",
  lifecycle_state: "created",
  lifecycle_history: [],
  created_at: now,
  created_by: founder,
  modified_at: now,
  version: 1,
  organizational_containers: [],
  owner_id: founder,
  owner_type: "human",
  relationships: [],
});

class CrashProvider {
  id = "test-only-crash-process";
  assurance = "test-only-process";
  calls = 0;

  async check() {
    return { available: true, reason: "crash harness process provider" };
  }

  async run(spec) {
    this.calls += 1;
    if (boundary === "mid-step" && this.calls === 1) {
      void runCapturedProcess(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)",
          childPidPath,
        ],
        {
          cwd: spec.workspaceDirectory,
          env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
          timeoutMs: 60_000,
          maxOutputBytes: 16 * 1024,
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
          ...(spec.onProcessGroup === undefined ? {} : { onProcessGroup: spec.onProcessGroup }),
        },
      );
      for (let attempt = 0; attempt < 100 && !existsSync(childPidPath); attempt += 1) {
        await delay(20);
      }
      ready();
      await holdForever();
    }
    if (boundary === "after-step-1" && this.calls === 2) {
      ready();
      await holdForever();
    }
    const [command, ...args] = spec.argv;
    const result = await runCapturedProcess(command, args, {
      cwd: spec.workspaceDirectory,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...spec.env },
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      ...(spec.onProcessGroup === undefined ? {} : { onProcessGroup: spec.onProcessGroup }),
    });
    return { ...result, provider: this.id, assurance: this.assurance };
  }
}

class CrashExecution {
  constructor(delegate) {
    this.delegate = delegate;
  }

  validateAgent(id) {
    return this.delegate.validateAgent(id);
  }

  hasCapacity() {
    return this.delegate.hasCapacity();
  }

  async executeTask(...args) {
    const result = await this.delegate.executeTask(...args);
    if (boundary === "before-verifier") {
      ready();
      await holdForever();
    }
    return result;
  }

  coordinate(...args) {
    return this.delegate.coordinate(...args);
  }

  cancelTask(id) {
    return this.delegate.cancelTask(id);
  }
}

const provider = new CrashProvider();
const store = new DurableOperationalStore({ directory: stateDirectory });
const workspaces = new RunWorkspaceManager(workspaceDirectory);
const config = {
  workspace_directory: workspaceDirectory,
  agent_id: agentId,
  verifier_id: verifierId,
  provider: "docker",
  image: "node:22-alpine",
  default_timeout_ms: 30_000,
  max_output_bytes: 64 * 1024,
  workspace_max_bytes: 16 * 1024 * 1024,
  max_concurrent_tasks: 1,
};
const ledgerRef = { current: store.executions };
const managed = new ManagedExecutionPort(
  new LocalCommandExecutor(config, provider, workspaces, ledgerRef),
  store.executions,
  1,
);
const verifier = new LocalCommandVerifier(config, provider, workspaces, ledgerRef);
const execution = new CrashExecution(managed);
const verification = {
  verifier_id: verifier.verifier_id,
  async verify(request) {
    const decision = await verifier.verify(request);
    if (boundary === "after-verifier") {
      ready();
      await holdForever();
    }
    return decision;
  },
  verifyProvenance(record) {
    return verifier.verifyProvenance(record);
  },
};
const kernel = new OrchestrationKernel(
  store.tasks,
  {
    authorization: { authorize: async () => true },
    execution,
    verification,
    resolveAgent: async () => agentId,
    cancellation: { isCancelled: async (id) => store.executions.isCancelled(id) },
    executionState: {
      latest: async (id) => store.executions.getForTask(id),
      history: async (id) => store.executions.listForTask(id),
    },
  },
  store.workflows,
  store.artifacts,
);

store.tasks.createTask(task);
store.workflows.create(workflow);
try {
  await kernel.dispatch(workflow, founder);
  process.stderr.write("crash harness unexpectedly completed\n");
  process.exit(3);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: "crash_harness_error",
      message: error instanceof Error ? error.stack : String(error),
    })}\n`,
  );
  process.exit(4);
}
