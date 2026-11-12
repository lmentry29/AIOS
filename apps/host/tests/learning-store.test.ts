import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryApprovalAuthorityPort } from "@aios/learning";
import { LearningService, MemoryApprovalError } from "@aios/learning";
import { DurableLearningStore } from "../src/persistence/learning-store.js";
import { FOUNDER } from "./fixtures.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-learning-"));
}

const allowAll: MemoryApprovalAuthorityPort = { authorize: async () => true };

function learningFor(store: DurableLearningStore): LearningService {
  return new LearningService(
    store.memoryRepository,
    store.knowledgeRepository,
    store.approvalRepository,
    allowAll,
  );
}

describe("durable learning memory approvals", () => {
  it("persists an approved permanent promotion and its approval correlation across reopen", async () => {
    const directory = stateDirectory();
    const first = new DurableLearningStore({ directory });
    const svc = learningFor(first);
    const id = await svc.recordObservation("Launch checklist", { step: "verify rollback" });

    // Deny-by-default before any approval exists: the draft Memory Object stays an
    // observation and no permanent knowledge record is written.
    await expect(svc.promote(id, "published")).rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe("observation");

    const approval = await svc.requestPermanentPromotion(id, "published", FOUNDER);
    await svc.decidePermanentPromotion(approval.approval_id, "approved", FOUNDER);
    await svc.promote(id, "published", approval.approval_id);

    expect(svc.getKnowledge(id)?.stage).toBe("published");
    expect(svc.listByStage("published").map((record) => record.id)).toEqual([id]);
    expect(svc.getMemoryApproval(approval.approval_id)).toMatchObject({
      status: "consumed",
      memory_id: id,
      target_stage: "published",
      decided_by: FOUNDER,
    });
    first.close();

    const second = new DurableLearningStore({ directory });
    const restored = learningFor(second);
    expect(restored.getKnowledge(id)?.stage).toBe("published");
    expect(restored.listByStage("published").map((record) => record.id)).toEqual([id]);
    expect(restored.getMemoryObject(id)?.name).toBe("Launch checklist");
    expect(restored.getMemoryApproval(approval.approval_id)).toMatchObject({
      status: "consumed",
      memory_id: id,
      target_stage: "published",
      decided_by: FOUNDER,
    });
    expect(restored.getMemoryApproval(approval.approval_id)?.consumed_at).toBeDefined();
    second.close();
  });

  it("persists no permanent entry when an approval is rejected", async () => {
    const directory = stateDirectory();
    const first = new DurableLearningStore({ directory });
    const svc = learningFor(first);
    const id = await svc.recordObservation("Rejected finding", { value: 1 });
    const approval = await svc.requestPermanentPromotion(id, "published", FOUNDER);
    await svc.decidePermanentPromotion(
      approval.approval_id,
      "rejected",
      FOUNDER,
      "insufficient evidence",
    );

    await expect(svc.promote(id, "published", approval.approval_id)).rejects.toThrow(
      MemoryApprovalError,
    );
    expect(svc.getKnowledge(id)?.stage).toBe("observation");
    expect(svc.listByStage("published")).toEqual([]);
    first.close();

    const second = new DurableLearningStore({ directory });
    const restored = learningFor(second);
    expect(restored.getKnowledge(id)?.stage).toBe("observation");
    expect(restored.listByStage("published")).toEqual([]);
    expect(restored.getMemoryApproval(approval.approval_id)).toMatchObject({
      status: "rejected",
      decided_by: FOUNDER,
      reason: "insufficient evidence",
    });
    second.close();
  });

  it("replays the approval and promotion as a single correlated record", async () => {
    const directory = stateDirectory();
    const first = new DurableLearningStore({ directory });
    const svc = learningFor(first);
    const id = await svc.recordObservation("Correlated finding", { value: 1 });
    const approval = await svc.requestPermanentPromotion(id, "published", FOUNDER);
    await svc.decidePermanentPromotion(approval.approval_id, "approved", FOUNDER);
    await svc.promote(id, "published", approval.approval_id);
    first.close();

    const second = new DurableLearningStore({ directory });
    const promotions = second.journal.read().filter((record) => record.kind === "promotion");
    expect(promotions).toHaveLength(1);
    expect(promotions[0]?.payload).toMatchObject({
      record: { id, stage: "published" },
      approval: { approval_id: approval.approval_id, status: "consumed", memory_id: id },
    });
    second.close();
  });
});
