import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskExecutionResult } from "@aios/orchestration";
import { LocalCommandVerifier } from "../src/execution/command-verifier.js";
import { LocalCommandExecutor } from "../src/execution/command-executor.js";
import {
  canonicalEvidenceJson,
  evidenceDigestEquals,
  executionIdentityBinding,
  executionResultBinding,
  EXECUTION_BINDING_VERSION,
  parseEvidenceEntries,
  resultExecutionNonce,
  snapshotExecutionResult,
} from "../src/execution/evidence.js";
import { ManagedExecutionPort } from "../src/execution/managed-execution.js";
import { RunWorkspaceManager } from "../src/execution/workspace.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import type { ExecutionLedger } from "../src/persistence/execution-ledger.js";
import { AGENT_ID, makeTask } from "./fixtures.js";
import { StubSandbox, makeExecutionConfig } from "./sandbox-fixture.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-evidence-binding-"));
}

const identity = {
  execution_id: "11111111-1111-4111-8111-111111111111",
  task_id: "22222222-2222-4222-8222-222222222222",
  agent_id: AGENT_ID,
  attempt: 1,
};

const result: TaskExecutionResult = {
  summary: "Local command completed in 7 ms under stub-container.",
  evidence: ["executor:agent", "task:example", "exit_code:0"],
};

function task() {
  return makeTask({
    execution: { kind: "local_command", argv: ["/bin/echo", "ok"] },
    verification: { kind: "local_command", argv: ["/bin/true"] },
  });
}

describe("canonical execution evidence", () => {
  it("rejects accessors, class instances, prototype keys and unbounded data", () => {
    const accessor = { summary: "s", evidence: ["e"] } as Record<string, unknown>;
    Object.defineProperty(accessor, "summary", { get: () => "s", enumerable: true });
    expect(() => snapshotExecutionResult(accessor)).toThrow(/must not be an accessor/);

    class Result {
      summary = "s";
      evidence = ["e"];
    }
    expect(() => snapshotExecutionResult(new Result())).toThrow(/plain object/);

    const dangerous = { summary: "s", evidence: ["e"] } as Record<string, unknown>;
    Object.defineProperty(dangerous, "__proto__", { value: { polluted: true }, enumerable: true });
    expect(() => snapshotExecutionResult(dangerous)).toThrow(/not allowed/);

    expect(() => canonicalEvidenceJson({ value: BigInt(1) })).toThrow(/plain object/);
    expect(() => canonicalEvidenceJson({ value: Number.NaN })).toThrow(/not finite/);
    expect(() => canonicalEvidenceJson({ value: "a".repeat(20_000) })).toThrow(/too long/);
    expect(() => canonicalEvidenceJson({ value: Array.from({ length: 300 }, () => 1) })).toThrow(
      /too many entries/,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalEvidenceJson(cyclic)).toThrow(/nesting/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects unknown result fields, oversized/empty evidence and newline injection", () => {
    expect(() => snapshotExecutionResult({ ...result, extra: "field" })).toThrow(/unknown field/);
    expect(() => snapshotExecutionResult({ summary: "", evidence: ["e"] })).toThrow(/summary/);
    expect(() => snapshotExecutionResult({ summary: "s", evidence: [] })).toThrow(
      /evidence entries/,
    );
    // Opaque result evidence may contain newlines; it is hashed as data, never parsed as lines.
    expect(() =>
      snapshotExecutionResult({ summary: "s", evidence: ["line\nopaque"] }),
    ).not.toThrow();
    expect(
      resultExecutionNonce({ summary: "s", evidence: ["execution_nonce:\nforged"] }),
    ).toBeUndefined();
    expect(() =>
      snapshotExecutionResult({ summary: "s", evidence: Array.from({ length: 65 }, () => "e") }),
    ).toThrow(/evidence entries/);
  });
});

describe("attempt binding", () => {
  it("changes when any result field or identity field changes", () => {
    const base = executionResultBinding(identity, result);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(executionResultBinding({ ...identity, attempt: 2 }, result)).not.toBe(base);
    expect(executionResultBinding({ ...identity, execution_id: "x".repeat(36) }, result)).not.toBe(
      base,
    );
    expect(executionResultBinding({ ...identity, task_id: "y".repeat(36) }, result)).not.toBe(base);
    expect(executionResultBinding({ ...identity, agent_id: "z".repeat(36) }, result)).not.toBe(
      base,
    );

    expect(executionResultBinding(identity, { ...result, summary: "changed" })).not.toBe(base);
    expect(
      executionResultBinding(identity, { ...result, evidence: [...result.evidence, "extra"] }),
    ).not.toBe(base);
    const actions = [{ action_id: "a", status: "completed", executed_by: AGENT_ID }];
    expect(executionResultBinding(identity, { ...result, completed_actions: actions })).not.toBe(
      base,
    );
    expect(
      executionResultBinding(identity, {
        ...result,
        completed_actions: [...actions, { action_id: "b" }],
      }),
    ).not.toBe(executionResultBinding(identity, { ...result, completed_actions: actions }));
  });

  it("produces a stable identity digest and constant-time comparison", () => {
    expect(executionIdentityBinding(identity)).toBe(executionIdentityBinding({ ...identity }));
    expect(executionIdentityBinding({ ...identity, attempt: 2 })).not.toBe(
      executionIdentityBinding(identity),
    );
    expect(evidenceDigestEquals("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(evidenceDigestEquals("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(evidenceDigestEquals("not-a-digest", "not-a-digest")).toBe(false);
  });

  it("parses evidence strictly and rejects duplicate or injected keys", () => {
    const entries = parseEvidenceEntries([
      "execution_binding:attempt-v2",
      "bound_result_sha256:abc",
    ]);
    expect(entries.get("execution_binding")).toBe("attempt-v2");
    expect(() => parseEvidenceEntries(["a:1", "a:2"])).toThrow(/duplicate/);
    expect(() => parseEvidenceEntries(["a:1\nforged:2"])).toThrow(/key:value/);
    expect(() => parseEvidenceEntries(["A:1"])).toThrow(/key:value/);
    expect(() => parseEvidenceEntries(["a:".repeat(300)])).toThrow(/bounded/);
  });
});

describe("verifier evidence boundary", () => {
  it("accepts the bound attempt and rejects replayed, cross-task and legacy evidence", async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    const config = makeExecutionConfig();
    const sandbox = new StubSandbox();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const execution = new ManagedExecutionPort(
      new LocalCommandExecutor(config, sandbox, workspaces),
      store.executions,
      1,
    );
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
      current: store.executions,
    });
    try {
      const firstTask = task();
      const first = await execution.executeTask(AGENT_ID, firstTask);
      expect(
        (
          await verifier.verify({
            task: firstTask,
            agent_ids: [AGENT_ID],
            execution_result: first,
          })
        ).accepted,
      ).toBe(true);

      // Retry appends attempt 2. The same result content must not validate against it.
      const latest = store.executions.getForTask(firstTask.entity_id);
      if (latest === undefined) throw new Error("missing first attempt");
      const second = await execution.executeTask(AGENT_ID, firstTask, {
        kind: "retry",
        previous_execution_id: latest.execution_id,
      });
      const callsBefore = sandbox.calls.length;
      const replayed = await verifier.verify({
        task: firstTask,
        agent_ids: [AGENT_ID],
        execution_result: first,
      });
      expect(replayed.accepted, replayed.reason).toBe(false);
      expect(replayed.reason).toMatch(/nonce|does not match/);
      expect(sandbox.calls.length).toBe(callsBefore);

      expect(
        (
          await verifier.verify({
            task: firstTask,
            agent_ids: [AGENT_ID],
            execution_result: second,
          })
        ).accepted,
      ).toBe(true);

      // A second Task with an identical result cannot reuse the first Task's result.
      const secondTask = task();
      await execution.executeTask(AGENT_ID, secondTask);
      const crossTask = await verifier.verify({
        task: secondTask,
        agent_ids: [AGENT_ID],
        execution_result: first,
      });
      expect(crossTask.accepted, crossTask.reason).toBe(false);
      expect(crossTask.reason).toMatch(/nonce|does not match/);
    } finally {
      store.close();
    }
  });

  it("rejects malformed, legacy and post-hoc-tampered ledger evidence without running", async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    const config = makeExecutionConfig();
    const sandbox = new StubSandbox();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const execution = new ManagedExecutionPort(
      new LocalCommandExecutor(config, sandbox, workspaces),
      store.executions,
      1,
    );
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
      current: store.executions,
    });
    try {
      const taskValue = task();
      const resultValue = await execution.executeTask(AGENT_ID, taskValue);
      const record = store.executions.getForTask(taskValue.entity_id);
      if (record === undefined) throw new Error("missing completed attempt");
      expect(record.evidence).toContain(`execution_binding:${EXECUTION_BINDING_VERSION}`);
      const callsBefore = sandbox.calls.length;

      const legacy = { ...record, evidence: [`result_sha256:${"a".repeat(64)}`] };
      const legacyLedger = { getForTask: () => legacy } as unknown as ExecutionLedger;
      const legacyDecision = await new LocalCommandVerifier(config, sandbox, workspaces, {
        current: legacyLedger,
      }).verify({ task: taskValue, agent_ids: [AGENT_ID], execution_result: resultValue });
      expect(legacyDecision.accepted).toBe(false);
      expect(legacyDecision.reason).toContain("no attempt-bound evidence");

      const tampered = {
        ...record,
        evidence: record.evidence.filter((entry) => !entry.startsWith("bound_result_sha256:")),
      };
      const tamperedLedger = { getForTask: () => tampered } as unknown as ExecutionLedger;
      const tamperedDecision = await new LocalCommandVerifier(config, sandbox, workspaces, {
        current: tamperedLedger,
      }).verify({ task: taskValue, agent_ids: [AGENT_ID], execution_result: resultValue });
      expect(tamperedDecision.accepted).toBe(false);
      expect(tamperedDecision.reason).toContain("does not match");

      const duplicate = {
        ...record,
        evidence: [...record.evidence, `bound_result_sha256:${"b".repeat(64)}`],
      };
      const duplicateLedger = { getForTask: () => duplicate } as unknown as ExecutionLedger;
      const duplicateDecision = await new LocalCommandVerifier(config, sandbox, workspaces, {
        current: duplicateLedger,
      }).verify({ task: taskValue, agent_ids: [AGENT_ID], execution_result: resultValue });
      expect(duplicateDecision.accepted).toBe(false);
      expect(duplicateDecision.reason).toContain("malformed");

      expect(sandbox.calls.length).toBe(callsBefore);
    } finally {
      store.close();
    }
  });

  it("never accepts without a durable ledger binding", async () => {
    const config = makeExecutionConfig();
    const sandbox = new StubSandbox();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces);
    const taskValue = task();
    const decision = await verifier.verify({
      task: taskValue,
      agent_ids: [AGENT_ID],
      execution_result: result,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain("not bound");
    expect(sandbox.calls).toHaveLength(1);
  });

  it("does not let a Task inject verifier identity or signing configuration", async () => {
    const config = makeExecutionConfig();
    const sandbox = new StubSandbox();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);
    const taskValue = makeTask({
      execution: {
        kind: "local_command",
        argv: ["/bin/echo", "ok"],
        env: {
          AIOS_VERIFIER_ID: "forged-verifier",
          AIOS_TRUST_ROOT: "/tmp/forged-trust-root.json",
          AIOS_SIGNING_KEY: "forged-key",
          AIOS_GVISOR_ROOTFS: "/tmp/forged-rootfs",
          AIOS_SAFE_VALUE: "kept",
          LANG: "C",
        },
      },
      verification: { kind: "local_command", argv: ["/bin/true"] },
    });
    await executor.executeTask(AGENT_ID, taskValue);
    const env = sandbox.calls[0]?.env ?? {};
    expect(env.AIOS_SAFE_VALUE).toBe("kept");
    expect(env.LANG).toBe("C");
    expect(env.AIOS_VERIFIER_ID).toBeUndefined();
    expect(env.AIOS_TRUST_ROOT).toBeUndefined();
    expect(env.AIOS_SIGNING_KEY).toBeUndefined();
    expect(env.AIOS_GVISOR_ROOTFS).toBeUndefined();
  });
});
