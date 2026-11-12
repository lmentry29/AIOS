import { randomUUID } from "node:crypto";
import type { AccessPolicy } from "@aios/founder";
import type { TaskEntity, WorkflowEntity } from "@aios/core";

export const FOUNDER = "human:founder";
export const OPERATOR = "human:operator";
export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const VERIFIER_ID = "22222222-2222-4222-8222-222222222222";
export const VAULT_RESOURCE_ID = "33333333-3333-4333-8333-333333333333";
export const GMAIL_RESOURCE_ID = "44444444-4444-4444-8444-444444444444";
export const NOTION_RESOURCE_ID = "55555555-5555-4555-8555-555555555555";
export const DECISION_COLLECTION_ID = "66666666-6666-4666-8666-666666666666";

export const FOUNDER_TOKEN = "founder-token-0123456789abcdef";
export const OPERATOR_TOKEN = "operator-token-abcdef0123456789";
export const AGENT_TOKEN = "agent-token-fedcba9876543210";

/** A bounded, future session expiry for tests that start a real host. */
export function sessionExpiresAt(offsetMs = 7 * 24 * 60 * 60 * 1000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function base(createdBy: string) {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    lifecycle_state: "created" as const,
    lifecycle_history: [],
    created_at: now,
    created_by: createdBy,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: createdBy,
    owner_type: "human" as const,
    relationships: [],
  };
}

export function makeTask(overrides: Record<string, unknown> = {}): TaskEntity {
  return {
    ...base(FOUNDER),
    entity_type: "task",
    name: "Execute the trusted host slice",
    work_hierarchy_parent: { entity_id: randomUUID(), level: "objective" },
    actions: [],
    ...overrides,
  } as unknown as TaskEntity;
}

export function makeWorkflow(
  taskIds: string[],
  overrides: Record<string, unknown> = {},
): WorkflowEntity {
  return {
    ...base(FOUNDER),
    entity_type: "workflow",
    name: "Trusted host execution",
    steps: taskIds,
    governing_loop: "system_execution_loop",
    ...overrides,
  } as unknown as WorkflowEntity;
}

/**
 * A policy covering the full slice plus the Founder decision collection.
 *
 * `intakeOnly` narrows it to intake so a test can prove dispatch is default-denied rather
 * than accidentally allowed by an over-broad fixture.
 */
export function makePolicy(
  taskId: string,
  workflowId: string,
  options: { intakeOnly?: boolean } = {},
): AccessPolicy {
  const founderActions = options.intakeOnly
    ? ["intake" as const]
    : ([
        "intake",
        "dispatch",
        "cancel",
        "resume",
        "retry",
        "read_status",
        "read_evidence",
        "administer_policy",
      ] as const);
  return {
    policy_id: randomUUID(),
    version: 1,
    rules: [
      {
        effect: "allow",
        subject_ids: [FOUNDER],
        actions: founderActions,
        resource_ids: [taskId, workflowId],
      },
      ...(options.intakeOnly
        ? []
        : [
            {
              effect: "allow" as const,
              subject_ids: [AGENT_ID],
              actions: ["execute" as const],
              resource_ids: [taskId],
            },
            {
              effect: "allow" as const,
              subject_ids: [VERIFIER_ID],
              actions: ["read_evidence" as const],
              resource_ids: [taskId],
            },
          ]),
      {
        effect: "allow",
        subject_ids: [FOUNDER],
        actions: ["intake", "read_evidence"],
        resource_ids: [DECISION_COLLECTION_ID],
      },
    ],
  };
}
