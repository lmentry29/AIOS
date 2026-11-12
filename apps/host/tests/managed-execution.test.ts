import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskEntity } from "@aios/core";
import {
  TaskCancelledError,
  type AgentExecutionPort,
  type TaskExecutionResult,
} from "@aios/orchestration";
import { ManagedExecutionPort } from "../src/execution/managed-execution.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { AGENT_ID, makeTask } from "./fixtures.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-managed-execution-"));
}

function deferredExecutor() {
  let release!: (result: TaskExecutionResult) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delegate: AgentExecutionPort = {
    validateAgent: async () => true,
    executeTask: async () => {
      started();
      return new Promise<TaskExecutionResult>((resolve) => {
        release = resolve;
      });
    },
    coordinate: async () => {
      throw new Error("not used");
    },
  };
  return {
    delegate,
    started: startedPromise,
    release: (result: TaskExecutionResult) => release(result),
  };
}

describe("managed execution lifecycle", () => {
  it("does not let a late executor result overwrite a terminal cancellation", async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    try {
      const task = makeTask() as TaskEntity;
      const late = deferredExecutor();
      const execution = new ManagedExecutionPort(late.delegate, store.executions, 1);

      const running = execution.executeTask(AGENT_ID, task);
      await late.started;
      expect(store.executions.getForTask(task.entity_id)?.state).toBe("running");

      store.executions.cancel({
        task_id: task.entity_id,
        actor_id: "human:founder",
        reason_code: "cancelled_by_request",
      });
      late.release({
        summary: "late success",
        evidence: [`execution_nonce:${randomUUID()}`, "late:evidence"],
      });

      await expect(running).rejects.toBeInstanceOf(TaskCancelledError);
      expect(store.executions.getForTask(task.entity_id)).toMatchObject({
        state: "cancelled",
        reason_code: "cancelled_by_request",
      });
    } finally {
      store.close();
    }
  });

  it("rejects the next execution while the cap is full and accepts it after release", async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    try {
      const first = makeTask() as TaskEntity;
      const second = makeTask() as TaskEntity;
      const late = deferredExecutor();
      const execution = new ManagedExecutionPort(late.delegate, store.executions, 1);

      const running = execution.executeTask(AGENT_ID, first);
      await late.started;
      await expect(execution.executeTask(AGENT_ID, second)).rejects.toThrow(
        /concurrency limit is full/,
      );
      expect(store.executions.getForTask(second.entity_id)).toBeUndefined();

      late.release({
        summary: "first success",
        evidence: [`execution_nonce:${randomUUID()}`, "first:evidence"],
      });
      await expect(running).resolves.toMatchObject({ summary: "first success" });
      expect(store.executions.getForTask(first.entity_id)?.state).toBe("completed");
    } finally {
      store.close();
    }
  });
});
