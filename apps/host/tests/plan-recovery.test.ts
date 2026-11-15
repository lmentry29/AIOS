import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TaskEntity } from "@aios/core";
import { LocalCommandVerifier } from "../src/execution/command-verifier.js";
import { RunWorkspaceManager } from "../src/execution/workspace.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { reconcileInterruptedWork } from "../src/runtime.js";
import { AGENT_ID, VERIFIER_ID } from "./fixtures.js";
import { StubSandbox, makeExecutionConfig } from "./sandbox-fixture.js";

const HARNESS = fileURLToPath(new URL("./fixtures/crash-plan-harness.mjs", import.meta.url));
const boundaries = ["after-step-1", "mid-step", "before-verifier", "after-verifier"] as const;
type Boundary = (typeof boundaries)[number];

interface CrashState {
  directory: string;
  workspaceDirectory: string;
  readyPath: string;
  childPidPath: string;
  taskId: string;
  workflowId: string;
  journalPath: string;
}

interface CrashResult extends CrashState {
  child: ChildProcess;
  stderr: string;
}

function stateDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `aios-plan-${prefix}-`));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(child: ChildProcess, readyPath: string, stderr: () => string) {
  for (let attempt = 0; attempt < 750; attempt += 1) {
    if (existsSync(readyPath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Crash harness exited before its boundary:\n${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Crash harness did not reach its boundary:\n${stderr()}`);
}

async function runCrash(boundary: Boundary): Promise<CrashResult> {
  const directory = stateDirectory(boundary);
  const workspaceDirectory = join(directory, "workspaces");
  const operationalDirectory = join(directory, "operational");
  const taskId = randomUUID();
  const workflowId = randomUUID();
  const readyPath = join(directory, "ready");
  const childPidPath = join(directory, "child.pid");
  const child = spawn(process.execPath, [HARNESS], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIOS_CRASH_STATE: operationalDirectory,
      AIOS_CRASH_WORKSPACES: workspaceDirectory,
      AIOS_CRASH_BOUNDARY: boundary,
      AIOS_CRASH_READY: readyPath,
      AIOS_CRASH_CHILD_PID: childPidPath,
      AIOS_CRASH_TASK: taskId,
      AIOS_CRASH_WORKFLOW: workflowId,
      AIOS_CRASH_AGENT: AGENT_ID,
      AIOS_CRASH_VERIFIER: VERIFIER_ID,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await waitForReady(child, readyPath, () => stderr);
    child.kill("SIGKILL");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    directory,
    workspaceDirectory,
    readyPath,
    childPidPath,
    taskId,
    workflowId,
    journalPath: join(operationalDirectory, "operational.jsonl"),
    child,
    stderr,
  };
}

function taskFor(taskId: string): TaskEntity {
  const now = new Date().toISOString();
  return {
    entity_id: taskId,
    entity_type: "task",
    name: "Crash recovery bounded plan",
    lifecycle_state: "created",
    lifecycle_history: [],
    created_at: now,
    created_by: "human:founder",
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: "human:founder",
    owner_type: "human",
    relationships: [],
    work_hierarchy_parent: { entity_id: randomUUID(), level: "objective" },
    actions: [],
    execution: { kind: "local_command", argv: ["/bin/true"] },
    verification: { kind: "local_command", argv: ["/bin/true"] },
  } as unknown as TaskEntity;
}

describe("bounded plan crash recovery", () => {
  it.each(boundaries)(
    "reconciles a real plan after SIGKILL at %s",
    async (boundary) => {
      const crash = await runCrash(boundary);
      const workspacePath = existsSync(crash.workspaceDirectory)
        ? readdirSync(crash.workspaceDirectory).map((name) => join(crash.workspaceDirectory, name))
        : [];
      const childPid =
        boundary === "mid-step" && existsSync(crash.childPidPath)
          ? Number(readFileSync(crash.childPidPath, "utf8"))
          : undefined;
      let store: DurableOperationalStore | undefined;
      try {
        // This is a genuinely fresh process plus a fresh store/kernel composition: the
        // crashed process is gone and this instance rebuilt every object from the journal.
        store = new DurableOperationalStore({ directory: join(crash.directory, "operational") });
        const before = store.executions.getForTask(crash.taskId);
        expect(before).toBeDefined();
        if (before === undefined) throw new Error("no execution attempt");
        const beforeTask = store.tasks.getTask(crash.taskId);
        expect(beforeTask?.lifecycle_state).toBe("active");
        expect(store.executions.recoveryFor(before.execution_id)).toBeUndefined();

        const stepsBefore = store.executions.stepsFor(before.execution_id);
        if (boundary === "after-step-1") {
          expect(before.state).toBe("running");
          expect(stepsBefore.map((step) => step.state)).toEqual(["completed", "started"]);
          expect(existsSync(join(workspacePath[0] ?? "", "step-two.txt"))).toBe(false);
        } else if (boundary === "mid-step") {
          expect(before.state).toBe("running");
          expect(stepsBefore.map((step) => step.state)).toEqual(["started"]);
          expect(childPid).toBeDefined();
          expect(processAlive(childPid as number)).toBe(true);
        } else {
          expect(before.state).toBe("completed");
          expect(stepsBefore.map((step) => step.state)).toEqual(["completed", "completed"]);
          expect(beforeTask?.audit_trail_ref).toBeUndefined();
        }

        const workspaces = new RunWorkspaceManager(crash.workspaceDirectory);
        const recovered = reconcileInterruptedWork(store, workspaces);
        const after = store.executions.getForTask(crash.taskId);
        expect(after).toBeDefined();
        if (after === undefined) throw new Error("execution disappeared");
        expect(store.tasks.getTask(crash.taskId)?.lifecycle_state).toBe("suspended");
        expect(store.workflows.get(crash.workflowId)?.lifecycle_state).toBe("suspended");

        if (boundary === "after-step-1" || boundary === "mid-step") {
          expect(after).toMatchObject({
            state: "interrupted",
            reason_code: "host_restarted",
          });
          expect(after.evidence).toEqual(
            expect.arrayContaining([
              "interruption_reason:host_restarted",
              boundary === "after-step-1" ? "plan_steps_completed:1" : "plan_steps_completed:0",
              "plan_steps_total:2",
            ]),
          );
          expect(recovered.uncommitted).not.toContain(after.execution_id);
        } else {
          expect(after.state).toBe("completed");
          const recovery = store.executions.recoveryFor(after.execution_id);
          expect(recovery).toMatchObject({
            outcome: "interrupted",
            reason_code: "host_restarted_before_terminal_commit",
          });
          expect(recovered.uncommitted).toContain(after.execution_id);
        }

        const finalSteps = store.executions.stepsFor(after.execution_id);
        if (boundary === "after-step-1") {
          expect(finalSteps.map((step) => step.state)).toEqual(["completed", "interrupted"]);
        } else if (boundary === "mid-step") {
          expect(finalSteps.map((step) => step.state)).toEqual(["interrupted"]);
        } else {
          expect(finalSteps.map((step) => step.state)).toEqual(["completed", "completed"]);
        }
        for (const step of finalSteps) {
          expect(step.argv_sha256).toMatch(/^[a-f0-9]{64}$/);
          if (step.state === "completed") {
            expect(step.cwd_sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(step.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(step.sandbox_evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
          }
        }

        expect(recovered.workspaces).toHaveLength(1);
        expect(recovered.workspaces[0]).toMatchObject({
          task_id: crash.taskId,
          removed: true,
        });
        expect(recovered.workspaces[0]?.workspace_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(
          existsSync(crash.workspaceDirectory)
            ? readdirSync(crash.workspaceDirectory).filter((name) => name.startsWith("task-"))
            : [],
        ).toEqual([]);
        const summaries = store.listRecoverySummaries();
        expect(summaries.length).toBeGreaterThanOrEqual(1);
        expect(summaries[0]?.executions).toContain(after.execution_id);
        // The manifest summary is durable before removal; the final summary records the
        // actual removal outcome.
        expect(summaries.at(-1)?.workspaces[0]).toMatchObject({
          task_id: crash.taskId,
          removed: true,
        });
        expect(store.journal.verifyOnDisk().length).toBeGreaterThan(0);

        if (boundary === "mid-step") {
          const pid = childPid as number;
          for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(processAlive(pid)).toBe(false);
        }

        // Recovery is idempotent: a second pass writes no journal bytes and creates no
        // second attempt or recovery tombstone.
        const bytesBefore = readFileSync(crash.journalPath).byteLength;
        const again = reconcileInterruptedWork(
          store,
          new RunWorkspaceManager(crash.workspaceDirectory),
        );
        expect(again.uncommitted).toEqual([]);
        expect(readFileSync(crash.journalPath).byteLength).toBe(bytesBefore);
        expect(store.executions.listForTask(crash.taskId)).toHaveLength(1);

        // A deliberate redrive is a new linked attempt; no committed step is replayed by
        // recovery itself. The successor starts with zero progress.
        const next =
          after.state === "interrupted"
            ? store.executions.resume({
                task_id: crash.taskId,
                agent_id: AGENT_ID,
                previous_execution_id: after.execution_id,
              })
            : store.executions.retry({
                task_id: crash.taskId,
                agent_id: AGENT_ID,
                previous_execution_id: after.execution_id,
              });
        expect(next).toMatchObject({
          attempt: 2,
          previous_execution_id: after.execution_id,
          state: "running",
          attempt_kind: after.state === "interrupted" ? "resume" : "retry",
        });
        expect(store.executions.stepsFor(next.execution_id)).toEqual([]);
        store.executions.fail(next.execution_id, "test_complete");
        expect(store.executions.getForTask(crash.taskId)?.state).toBe("failed");
      } finally {
        store?.close();
        if (childPid !== undefined && processAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        rmSync(crash.directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("fails closed when a durable plan-step record is tampered after a crash", async () => {
    const crash = await runCrash("after-step-1");
    try {
      const lines = readFileSync(crash.journalPath, "utf8").trimEnd().split("\n");
      let found = false;
      const tampered = lines.map((line) => {
        const record = JSON.parse(line) as { kind?: string; payload?: { state?: string } };
        if (record.kind !== "execution_step" || record.payload?.state !== "completed") return line;
        found = true;
        record.payload.state = "started";
        return JSON.stringify(record);
      });
      expect(found).toBe(true);
      writeFileSync(crash.journalPath, `${tampered.join("\n")}\n`, { mode: 0o600 });
      expect(
        () => new DurableOperationalStore({ directory: join(crash.directory, "operational") }),
      ).toThrow(/hash-chain/);
    } finally {
      rmSync(crash.directory, { recursive: true, force: true });
    }
  });

  it("rejects an uncommitted completed attempt in the independent verifier", async () => {
    const directory = stateDirectory("verifier");
    const workspaceDirectory = join(directory, "workspaces");
    const store = new DurableOperationalStore({ directory: join(directory, "operational") });
    const sandbox = new StubSandbox();
    const config = makeExecutionConfig(workspaceDirectory);
    const ledgerRef = { current: store.executions };
    const verifier = new LocalCommandVerifier(
      config,
      sandbox,
      new RunWorkspaceManager(workspaceDirectory),
      ledgerRef,
    );
    try {
      const task = taskFor(randomUUID());
      store.tasks.createTask(task);
      const execution = store.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
      store.executions.complete(execution.execution_id, [`bound_result_sha256:${"a".repeat(64)}`]);
      store.executions.markUncommitted(execution.execution_id, "active");
      const decision = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: { summary: "forged after recovery", evidence: ["forged"] },
      });
      expect(decision.accepted).toBe(false);
      expect(decision.reason).toContain("recovered before terminal commit");
      expect(sandbox.calls).toHaveLength(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
