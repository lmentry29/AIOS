import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaskEntity, WorkflowEntity } from "@aios/core";
import { TaskStore } from "@aios/work-hierarchy";
import {
  AuthorizationService,
  InMemoryAuthorizationAuditStore,
  InMemoryPolicyRegistry,
  PolicyAdministrationService,
  type AccessPolicy,
} from "@aios/founder";
import { OrchestrationKernel, type AgentExecutionPort } from "@aios/orchestration";

const FOUNDER = "human:founder";
const AGENT_ID = randomUUID();
const VERIFIER_ID = randomUUID();

function makeTask(): TaskEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: "task",
    name: "Run the verified integration slice",
    lifecycle_state: "created",
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: "human",
    relationships: [],
    work_hierarchy_parent: { entity_id: randomUUID(), level: "objective" },
    actions: [],
  } as TaskEntity;
}

function makeWorkflow(taskId: string): WorkflowEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: "workflow",
    name: "Founder-authorized execution",
    lifecycle_state: "created",
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: "human",
    relationships: [],
    steps: [taskId],
    governing_loop: "system_execution_loop",
  } as WorkflowEntity;
}

describe("founder authorization → orchestration integration", () => {
  it("executes a Task only through published resource policy, independent verification, and audited evidence", async () => {
    const taskStore = new TaskStore();
    const candidate = makeTask();
    const workflow = makeWorkflow(candidate.entity_id);
    const policyId = randomUUID();
    const registry = new InMemoryPolicyRegistry();
    const administration = new PolicyAdministrationService(FOUNDER, registry, registry);
    const audit = new InMemoryAuthorizationAuditStore();

    const policy: AccessPolicy = {
      policy_id: policyId,
      version: 1,
      rules: [
        {
          effect: "allow",
          subject_ids: [FOUNDER],
          actions: ["intake", "dispatch", "read_status", "read_evidence"],
          resource_ids: [candidate.entity_id, workflow.entity_id],
        },
        {
          effect: "allow",
          subject_ids: [AGENT_ID],
          actions: ["execute"],
          resource_ids: [candidate.entity_id],
        },
        {
          effect: "allow",
          subject_ids: [VERIFIER_ID],
          actions: ["read_evidence"],
          resource_ids: [candidate.entity_id],
        },
      ],
    };

    await administration.publish(policy, FOUNDER);
    await administration.attach(candidate.entity_id, policyId, FOUNDER);
    await administration.attach(workflow.entity_id, policyId, FOUNDER);

    const authorization = new AuthorizationService(
      registry,
      (resourceId) => registry.resolve(resourceId),
      audit,
    );
    const execution: AgentExecutionPort = {
      validateAgent: async (agentId) => agentId === AGENT_ID,
      executeTask: async (_agentId, task) => ({
        summary: "The deterministic test executor completed the requested Task.",
        evidence: [`task:${task.entity_id}:executed`],
      }),
      coordinate: async () => {
        throw new Error("Coordination is not part of this single-Agent test.");
      },
    };

    const kernel = new OrchestrationKernel(taskStore, {
      authorization: { authorize: (request) => authorization.authorize(request) },
      execution,
      verification: {
        verifier_id: VERIFIER_ID,
        verify: async ({ task, execution_result }) => ({
          accepted: execution_result.evidence.includes(`task:${task.entity_id}:executed`),
          reason: "Integration verifier checked the executor evidence against the Task ID.",
          evidence: [`verified-task:${task.entity_id}`],
          verifier_id: VERIFIER_ID,
        }),
      },
      resolveAgent: async () => AGENT_ID,
    });

    await kernel.intake({ kind: "task", task: candidate }, FOUNDER);
    await kernel.intake({ kind: "workflow", workflow }, FOUNDER);
    const handle = await kernel.dispatch(workflow, FOUNDER);

    expect(await kernel.status(handle, FOUNDER)).toBe("completed");

    const completed = taskStore.getTask(candidate.entity_id);
    expect(completed?.lifecycle_state).toBe("completed");
    expect(completed?.assigned_agent).toBe(AGENT_ID);
    expect(completed?.audit_trail_ref).toBeTruthy();

    const evidence = await kernel.getExecutionEvidence(
      completed?.audit_trail_ref ?? "",
      candidate.entity_id,
      FOUNDER,
    );
    expect(evidence.artifact_kind).toBe("test_report");
    expect(evidence.lifecycle_state).toBe("completed");

    const decisions = audit.list();
    expect(decisions.length).toBeGreaterThanOrEqual(7);
    expect(decisions.every((decision) => decision.decision === "allow")).toBe(true);
    expect(decisions.map((decision) => decision.action)).toContain("execute");
    expect(decisions).toContainEqual(
      expect.objectContaining({
        actor_id: VERIFIER_ID,
        action: "read_evidence",
        decision: "allow",
      }),
    );
    expect(evidence.description).toContain(VERIFIER_ID);
    expect(registry.listAudit().map((event) => event.operation)).toEqual([
      "publish",
      "attach",
      "attach",
    ]);
  });

  it("denies execution when a resource has no attached policy and records the denial", async () => {
    const audit = new InMemoryAuthorizationAuditStore();
    const authorization = new AuthorizationService(
      new InMemoryPolicyRegistry(),
      async () => undefined,
      audit,
    );
    const allowed = await authorization.authorize({
      actor_id: FOUNDER,
      action: "dispatch",
      resource_id: randomUUID(),
    });

    expect(allowed).toBe(false);
    expect(audit.list()).toMatchObject([
      { decision: "deny", reason: "resource_policy_missing_or_invalid" },
    ]);
  });
});
