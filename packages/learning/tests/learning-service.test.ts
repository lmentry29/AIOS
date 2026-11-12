import { describe, expect, it } from "vitest";
import { LearningService } from "../src/learning-service.js";
import {
  ArchivedKnowledgeError,
  InvalidStagePromotionError,
  KnowledgeNotFoundError,
} from "../src/errors.js";
import { KNOWLEDGE_STAGES } from "../src/knowledge-stage.js";

const APPROVER = "human:founder";
const allowAll = { authorize: async () => true };

function makeService(): LearningService {
  return new LearningService(undefined, undefined, undefined, allowAll);
}

async function approve(
  svc: LearningService,
  id: string,
  stage: "published" | "institutional_standard",
): Promise<string> {
  const approval = await svc.requestPermanentPromotion(id, stage, APPROVER);
  await svc.decidePermanentPromotion(approval.approval_id, "approved", APPROVER);
  return approval.approval_id;
}

describe("LearningService — recordObservation (runtime-interfaces §2.7)", () => {
  it("creates a backing Memory Object and returns its entity_id", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("build times regressed", { p95_seconds: 412 });

    const memory = svc.getMemoryObject(id);
    expect(memory).toBeDefined();
    expect(memory?.entity_type).toBe("canonical_object");
    expect(memory?.entity_subtype).toBe("memory_object");
    expect(memory?.name).toBe("build times regressed");
    expect(memory?.entity_id).toBe(id);
  });

  it("enters the axis at the observation stage", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("subject", "content");
    expect(svc.getKnowledge(id)?.stage).toBe("observation");
  });

  it("holds the content payload, which COM §5.1 has no field for", async () => {
    const svc = makeService();
    const content = { nested: { value: 42 } };
    const id = await svc.recordObservation("structured observation", content);
    content.nested.value = 99;

    // The Memory Object is the canonical entity; the arbitrary content payload lives
    // here because §5.1's schema has nowhere to put it. Caller mutation after write
    // must not mutate the service's stored knowledge payload.
    expect(svc.getKnowledge(id)?.content).toEqual({ nested: { value: 42 } });
  });

  it("gives each observation a distinct entity_id (COM §9)", async () => {
    const svc = makeService();
    const a = await svc.recordObservation("a", 1);
    const b = await svc.recordObservation("b", 2);
    expect(a).not.toBe(b);
  });
});

describe("LearningService — promote (Memory Engine Ch.23 axis)", () => {
  it("advances through the full chain in order", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});

    await svc.promote(id, "candidate");
    expect(svc.getKnowledge(id)?.stage).toBe("candidate");
    await svc.promote(id, "validated");
    expect(svc.getKnowledge(id)?.stage).toBe("validated");
    const publishedApproval = await approve(svc, id, "published");
    await svc.promote(id, "published", publishedApproval);
    expect(svc.getKnowledge(id)?.stage).toBe("published");
    const standardApproval = await approve(svc, id, "institutional_standard");
    await svc.promote(id, "institutional_standard", standardApproval);
    expect(svc.getKnowledge(id)?.stage).toBe("institutional_standard");
  });

  it("permits skipping forward — the corpus states the ordering, not adjacency", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    const approvalId = await approve(svc, id, "published");
    await svc.promote(id, "published", approvalId);
    expect(svc.getKnowledge(id)?.stage).toBe("published");
  });

  it("refuses to move backward — demotion is not a defined operation", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    await svc.promote(id, "validated");

    await expect(svc.promote(id, "candidate")).rejects.toThrow(InvalidStagePromotionError);
    expect(svc.getKnowledge(id)?.stage).toBe("validated");
  });

  it("refuses a no-op promotion to the current stage", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    await svc.promote(id, "candidate");
    await expect(svc.promote(id, "candidate")).rejects.toThrow(InvalidStagePromotionError);
  });

  it("never touches lifecycle_state — the knowledge axis is orthogonal (§2.7)", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    const before = svc.getMemoryObject(id);

    const approvalId = await approve(svc, id, "institutional_standard");
    await svc.promote(id, "institutional_standard", approvalId);

    const after = svc.getMemoryObject(id);
    // Promotion is epistemic, not a runtime lifecycle transition. Writing
    // lifecycle_state here is exactly the conflation ADR-0003 exists to prevent.
    expect(after?.lifecycle_state).toBe(before?.lifecycle_state);
    expect(after?.lifecycle_history).toEqual([]);
    expect(after?.version).toBe(before?.version);
  });

  it("throws KnowledgeNotFoundError for an unknown id", async () => {
    const svc = makeService();
    await expect(svc.promote("nope", "candidate")).rejects.toThrow(KnowledgeNotFoundError);
  });
});

describe("LearningService — archiveKnowledge", () => {
  it("moves a record to historical_archive from any stage", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    const approvalId = await approve(svc, id, "published");
    await svc.promote(id, "published", approvalId);
    await svc.archiveKnowledge(id);
    expect(svc.getKnowledge(id)?.stage).toBe("historical_archive");
  });

  it("makes historical_archive terminal — no promotion out of it", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("finding", {});
    await svc.archiveKnowledge(id);
    await expect(svc.promote(id, "validated")).rejects.toThrow(ArchivedKnowledgeError);
  });
});

describe("LearningService — queries", () => {
  it("returns detached nested knowledge snapshots", async () => {
    const svc = makeService();
    const id = await svc.recordObservation("snapshot", { nested: { value: 1 } });

    const first = svc.getKnowledge(id);
    if (!first) throw new Error("Knowledge record missing.");
    (first.content as { nested: { value: number } }).nested.value = 99;

    const listed = svc.listByStage("observation")[0];
    if (!listed) throw new Error("Knowledge record missing from stage query.");
    (listed.content as { nested: { value: number } }).nested.value = 77;

    expect((svc.getKnowledge(id)?.content as { nested: { value: number } }).nested.value).toBe(1);
  });

  it("lists records by stage", async () => {
    const svc = makeService();
    const a = await svc.recordObservation("a", {});
    await svc.recordObservation("b", {});
    await svc.promote(a, "validated");

    expect(svc.listByStage("observation").map((r) => r.subject)).toEqual(["b"]);
    expect(svc.listByStage("validated").map((r) => r.subject)).toEqual(["a"]);
  });

  it("exposes the Ch.23 chain in order", () => {
    expect(KNOWLEDGE_STAGES).toEqual([
      "observation",
      "candidate",
      "validated",
      "published",
      "institutional_standard",
      "historical_archive",
    ]);
  });
});
