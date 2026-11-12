import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TaskEntity, WorkflowEntity } from "@aios/core";
import { TaskStore } from "@aios/work-hierarchy";
import {
  OrchestrationError,
  OrchestrationKernel,
  type AgentExecutionPort,
  type AuthorizationPort,
  type AuthorizationRequest,
  type TaskExecutionObservation,
  type TaskVerificationDecision,
} from "../src/index.js";

function task() {
  const now = new Date().toISOString();
  return TaskEntity.parse({
    entity_id: randomUUID(),
    entity_type: "task",
    name: "Write integration test",
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
  });
}

function workflow(taskIds: string[]) {
  const now = new Date().toISOString();
  return WorkflowEntity.parse({
    entity_id: randomUUID(),
    entity_type: "workflow",
    name: "Test workflow",
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
    steps: taskIds,
    governing_loop: "system_execution_loop",
  });
}

function harness(
  overrides: {
    allowed?: boolean;
    verified?: boolean;
    evidence?: string[];
    denyAction?: string;
    verifierId?: string;
    sameVerifierAsExecutor?: boolean;
  } = {},
) {
  const tasks = new TaskStore();
  const agentId = randomUUID();
  const verifierId = overrides.sameVerifierAsExecutor
    ? agentId
    : (overrides.verifierId ?? randomUUID());
  const authorization: AuthorizationPort = {
    authorize: vi.fn(
      async (request) => (overrides.allowed ?? true) && request.action !== overrides.denyAction,
    ),
  };
  const execution: AgentExecutionPort = {
    validateAgent: vi.fn(async () => true),
    executeTask: vi.fn(async () => ({
      summary: "Acceptance criteria checked",
      evidence: overrides.evidence ?? ["test-report-1"],
    })),
    coordinate: vi.fn(async () => ({
      summary: "Coordination result checked",
      evidence: overrides.evidence ?? ["coordination-report-1"],
    })),
  };
  const verification = {
    verifier_id: verifierId,
    verify: vi.fn(async () => ({
      accepted: overrides.verified ?? true,
      reason: overrides.verified === false ? "test verifier rejection" : "test verifier accepted",
      evidence: overrides.verified === false ? [] : ["verifier:acceptance-criteria-checked"],
      verifier_id: verifierId,
    })),
  };
  const kernel = new OrchestrationKernel(tasks, {
    authorization,
    execution,
    verification,
    resolveAgent: async () => agentId,
  });
  return { tasks, agentId, verifierId, authorization, execution, verification, kernel };
}

describe("OrchestrationKernel", () => {
  it("dispatches ordered Tasks and completes only after verified execution", async () => {
    const h = harness();
    const first = h.tasks.createTask(task());
    const second = h.tasks.createTask(task());
    const wf = workflow([first.entity_id, second.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    const handle = await h.kernel.dispatch(wf, "human:founder");

    expect(await h.kernel.status(handle, "human:founder")).toBe("completed");
    expect(
      (await h.kernel.getWorkflow(handle.workflow_id, "human:founder")).lifecycle_history.every(
        (entry) => entry.actor === "human:founder",
      ),
    ).toBe(true);
    expect(h.tasks.getTask(first.entity_id)?.lifecycle_state).toBe("completed");
    expect(h.tasks.getTask(second.entity_id)?.lifecycle_state).toBe("completed");
    expect(
      h.tasks
        .getTask(first.entity_id)
        ?.lifecycle_history.every((entry) => entry.actor === h.agentId),
    ).toBe(true);
    expect(h.tasks.getTask(first.entity_id)?.assigned_agent).toBe(h.agentId);
    const evidenceId = h.tasks.getTask(first.entity_id)?.audit_trail_ref;
    expect(evidenceId).toBeDefined();
    const evidence = evidenceId
      ? await h.kernel.getExecutionEvidence(evidenceId, first.entity_id, "human:founder")
      : undefined;
    expect(evidence?.artifact_kind).toBe("test_report");
    expect(evidence?.lifecycle_state).toBe("completed");
    expect(evidence?.lifecycle_history).toHaveLength(3);
    expect(evidence?.description).toContain("Acceptance criteria checked");
    expect(h.execution.executeTask).toHaveBeenCalledTimes(2);
  });

  it("refuses self-verification when the verifier identity matches an executor", async () => {
    const h = harness({ sameVerifierAsExecutor: true });
    const current = h.tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(
      /verifier must have a valid identity distinct/,
    );
    expect(h.tasks.getTask(current.entity_id)?.lifecycle_state).toBe("suspended");
    expect(h.verification.verify).not.toHaveBeenCalled();
  });

  it("requires the verifier to have explicit evidence-read permission", async () => {
    const h = harness({ denyAction: "read_evidence" });
    const current = h.tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(
      /verifier .* not authorized to read the evidence/,
    );
    expect(h.tasks.getTask(current.entity_id)?.lifecycle_state).toBe("suspended");
    expect(h.verification.verify).not.toHaveBeenCalled();
  });

  it("rejects empty and duplicate workflow steps before lifecycle changes", async () => {
    const h = harness();
    const empty = workflow([]);
    await h.kernel.intake({ kind: "workflow", workflow: empty }, "human:founder");
    await expect(h.kernel.dispatch(empty, "human:founder")).rejects.toThrow(/no steps/);

    const t = h.tasks.createTask(task());
    const duplicate = workflow([t.entity_id, t.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: duplicate }, "human:founder");
    await expect(h.kernel.dispatch(duplicate, "human:founder")).rejects.toThrow(
      /duplicate Task IDs/,
    );
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("created");
  });

  it("does not reassign a Task already owned by an Agent", async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, { assigned_agent: randomUUID() });
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(
      /already assigned to an Agent/,
    );
    expect(h.execution.executeTask).not.toHaveBeenCalled();
  });

  it("requires every declared Task Action to be completed by an assigned Agent", async () => {
    const h = harness();
    const actionId = randomUUID();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, {
      actions: [{ action_id: actionId, status: "pending", executed_by: h.agentId }],
    });
    h.execution.executeTask = vi.fn(async () => ({
      summary: "Executor claims success",
      evidence: ["execution-evidence"],
      completed_actions: [{ action_id: actionId, status: "completed", executed_by: h.agentId }],
    }));
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await h.kernel.dispatch(wf, "human:founder");
    expect(h.tasks.getTask(t.entity_id)?.actions[0]?.status).toBe("completed");
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("completed");
  });

  it("does not complete a Task when an Action result is missing", async () => {
    const h = harness();
    const actionId = randomUUID();
    const t = h.tasks.createTask(task());
    h.tasks.updateTask(t.entity_id, {
      actions: [{ action_id: actionId, status: "pending", executed_by: h.agentId }],
    });
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(
      /complete Action result set/,
    );
    expect(h.tasks.getTask(t.entity_id)?.actions[0]?.status).toBe("pending");
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("suspended");
  });

  it("denies dispatch before changing Workflow lifecycle when requester lacks permission", async () => {
    const h = harness({ denyAction: "dispatch" });
    const wf = workflow([randomUUID()]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(/dispatch denied/);
    expect(await h.kernel.status({ workflow_id: wf.entity_id }, "human:founder")).toBe("created");
  });

  it("denies Workflow reads when the requesting actor lacks permission", async () => {
    const h = harness({ denyAction: "read_status" });
    const wf = workflow([]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.status({ workflow_id: wf.entity_id }, "human:founder")).rejects.toThrow(
      /read denied/,
    );
  });

  it("rejects forged created_by or owner_id values during intake", async () => {
    const h = harness();
    const wf = workflow([]);
    await expect(
      h.kernel.intake({ kind: "workflow", workflow: wf }, "human:attacker"),
    ).rejects.toThrow(/provenance and ownership/);
    await expect(h.kernel.status({ workflow_id: wf.entity_id }, "human:founder")).rejects.toThrow(
      /not found/,
    );
  });

  it("fails closed when intake authorization is denied", async () => {
    const h = harness({ allowed: false });
    const wf = workflow([]);
    await expect(
      h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder"),
    ).rejects.toThrow(/intake denied/);
  });

  it("does not mark a Task completed when execution is unverified", async () => {
    const h = harness({ verified: false });
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toBeInstanceOf(OrchestrationError);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("suspended");
  });

  it("preflights all workflow steps before dispatching any Task", async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id, randomUUID()]);
    await h.kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(h.kernel.dispatch(wf, "human:founder")).rejects.toThrow(/does not exist/);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("created");
    expect(h.execution.executeTask).not.toHaveBeenCalled();
  });

  it("requires at least two distinct Agents for coordination", async () => {
    const h = harness();
    const t = h.tasks.createTask(task());
    await expect(h.kernel.coordinate([h.agentId, h.agentId], t, "human:founder")).rejects.toThrow(
      /at least two distinct/,
    );
  });

  it("suspends a coordinated Task when the result is not verified", async () => {
    const h = harness({ verified: false });
    const t = h.tasks.createTask(task());
    await expect(
      h.kernel.coordinate([h.agentId, randomUUID()], t, "human:founder"),
    ).rejects.toThrow(/not completed/);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("suspended");
  });

  it("returns the full attempt history without executing or mutating work", async () => {
    const h = harness();
    const current = h.tasks.createTask(task());
    const wf = workflow([current.entity_id]);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const thirdId = randomUUID();
    const observations: TaskExecutionObservation[] = [
      {
        execution_id: firstId,
        task_id: current.entity_id,
        agent_id: h.agentId,
        state: "interrupted",
        attempt: 1,
        attempt_kind: "initial",
      },
      {
        execution_id: secondId,
        task_id: current.entity_id,
        agent_id: h.agentId,
        state: "interrupted",
        attempt: 2,
        attempt_kind: "resume",
        previous_execution_id: firstId,
      },
      {
        execution_id: thirdId,
        task_id: current.entity_id,
        agent_id: h.agentId,
        state: "completed",
        attempt: 3,
        attempt_kind: "resume",
        previous_execution_id: secondId,
      },
    ];
    const kernel = new OrchestrationKernel(h.tasks, {
      authorization: h.authorization,
      execution: h.execution,
      verification: h.verification,
      resolveAgent: async () => h.agentId,
      executionState: {
        latest: async (taskId) => observations.filter((item) => item.task_id === taskId).at(-1),
        history: async (taskId) => observations.filter((item) => item.task_id === taskId),
      },
    });
    await kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");
    const lifecycleBefore = h.tasks.getTask(current.entity_id)?.lifecycle_state;

    const taskHistory = await kernel.getTaskAttempts(current.entity_id, "human:founder");
    expect(taskHistory.task_id).toBe(current.entity_id);
    expect(
      taskHistory.attempts.map((item) => [item.attempt, item.attempt_kind, item.state]),
    ).toEqual([
      [1, "initial", "interrupted"],
      [2, "resume", "interrupted"],
      [3, "resume", "completed"],
    ]);
    expect(taskHistory.attempts[0]).toMatchObject({
      execution_id: firstId,
      predecessor_execution_ids: [],
    });
    expect(taskHistory.attempts[0]?.previous_execution_id).toBeUndefined();
    expect(taskHistory.attempts[1]).toMatchObject({
      execution_id: secondId,
      previous_execution_id: firstId,
      predecessor_execution_ids: [firstId],
    });
    expect(taskHistory.attempts[2]).toMatchObject({
      execution_id: thirdId,
      previous_execution_id: secondId,
      predecessor_execution_ids: [firstId, secondId],
    });

    expect(await kernel.getWorkflowAttempts(wf.entity_id, "human:founder")).toEqual({
      workflow_id: wf.entity_id,
      tasks: [taskHistory],
    });
    expect(h.tasks.getTask(current.entity_id)?.lifecycle_state).toBe(lifecycleBefore);
    expect(h.execution.executeTask).not.toHaveBeenCalled();
    expect(h.verification.verify).not.toHaveBeenCalled();

    await expect(kernel.getTaskAttempts(randomUUID(), "human:founder")).rejects.toThrow(
      /was not found/,
    );
  });

  it("denies Workflow attempt history before deriving any Task history when one step lacks read_status", async () => {
    for (const restrictedAt of ["first", "later"] as const) {
      const h = harness();
      const readableBefore = h.tasks.createTask(task());
      const restricted = h.tasks.createTask(task());
      const readableAfter = h.tasks.createTask(task());
      const steps =
        restrictedAt === "first"
          ? [restricted.entity_id, readableAfter.entity_id]
          : [readableBefore.entity_id, restricted.entity_id];
      const wf = workflow(steps);
      const granted = new Set([
        wf.entity_id,
        ...(restrictedAt === "first" ? [readableAfter.entity_id] : [readableBefore.entity_id]),
      ]);
      const authorize = vi.fn(
        async (request: AuthorizationRequest) =>
          request.action !== "read_status" || granted.has(request.resource_id),
      );
      const history = vi.fn(async () => [] as TaskExecutionObservation[]);
      const kernel = new OrchestrationKernel(h.tasks, {
        authorization: { authorize },
        execution: h.execution,
        verification: h.verification,
        resolveAgent: async () => h.agentId,
        executionState: { latest: async () => undefined, history },
      });
      await kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");
      authorize.mockClear();

      const denial = await kernel.getWorkflowAttempts(wf.entity_id, "human:founder").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(denial).toBeInstanceOf(OrchestrationError);
      expect((denial as Error).message).toMatch(/denied by authorization policy/);
      expect(history).not.toHaveBeenCalled();
      expect(authorize.mock.calls.map(([request]) => request.resource_id)).toEqual(
        restrictedAt === "first"
          ? [wf.entity_id, restricted.entity_id]
          : [wf.entity_id, readableBefore.entity_id, restricted.entity_id],
      );
      for (const created of [readableBefore, restricted, readableAfter]) {
        expect(h.tasks.getTask(created.entity_id)?.lifecycle_state).toBe("created");
      }
    }

    // Authorization still precedes lookup: an unknown Workflow must not reveal nonexistence.
    const h = harness();
    const kernel = new OrchestrationKernel(h.tasks, {
      authorization: { authorize: async () => false },
      execution: h.execution,
      verification: h.verification,
      resolveAgent: async () => h.agentId,
    });
    await expect(kernel.getWorkflowAttempts(randomUUID(), "human:founder")).rejects.toThrow(
      /denied by authorization policy/,
    );
  });

  it("rejects a verification decision attributed to a different verifier", async () => {
    const h = harness();
    const impostorId = randomUUID();
    const verify = vi.fn(async () => ({
      accepted: true,
      reason: "impostor verifier accepted",
      evidence: ["verifier:impostor"],
      verifier_id: impostorId,
    }));
    const kernel = new OrchestrationKernel(h.tasks, {
      authorization: h.authorization,
      execution: h.execution,
      verification: { verifier_id: h.verifierId, verify },
      resolveAgent: async () => h.agentId,
    });
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id]);
    await kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(kernel.dispatch(wf, "human:founder")).rejects.toThrow(/verifier identity/);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("suspended");
  });

  it("rejects a verification decision with no verifier identity", async () => {
    const h = harness();
    const unattributed = {
      accepted: true,
      reason: "unattributed verifier accepted",
      evidence: ["verifier:unattributed"],
    } as unknown as TaskVerificationDecision;
    const verify = vi.fn(async () => unattributed);
    const kernel = new OrchestrationKernel(h.tasks, {
      authorization: h.authorization,
      execution: h.execution,
      verification: { verifier_id: h.verifierId, verify },
      resolveAgent: async () => h.agentId,
    });
    const t = h.tasks.createTask(task());
    const wf = workflow([t.entity_id]);
    await kernel.intake({ kind: "workflow", workflow: wf }, "human:founder");

    await expect(kernel.dispatch(wf, "human:founder")).rejects.toThrow(/verifier identity/);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(h.tasks.getTask(t.entity_id)?.lifecycle_state).toBe("suspended");
  });
});
