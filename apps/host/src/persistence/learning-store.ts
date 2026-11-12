import { join } from "node:path";
import type { MemoryObjectEntity as MemoryObjectEntityType } from "@aios/core";
import { MemoryObjectEntity as MemoryObjectSchema } from "@aios/core";
import type {
  KnowledgeRecord,
  KnowledgeRepositoryPort,
  KnowledgeStage,
  MemoryApprovalRepositoryPort,
  MemoryApprovalStatus,
  MemoryObjectRepositoryPort,
  MemoryWriteApproval,
} from "@aios/learning";
import {
  KNOWLEDGE_STAGES,
  isPermanentKnowledgeStage,
  memoryWriteContentHash,
  stageRank,
} from "@aios/learning";
import { AppendOnlyJournal, JournalError } from "./journal.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const STAGES = new Set<string>(KNOWLEDGE_STAGES);
const APPROVAL_STATUSES = new Set<string>(["pending", "approved", "rejected", "consumed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isActor(value: unknown): value is string {
  return typeof value === "string" && (/^human:[^\s:*]+$/.test(value) || UUID_PATTERN.test(value));
}

function isApprovalTransition(from: MemoryApprovalStatus, to: MemoryApprovalStatus): boolean {
  return (
    (from === "pending" && (to === "approved" || to === "rejected")) ||
    (from === "approved" && to === "consumed")
  );
}

function parseKnowledgeRecord(value: unknown): KnowledgeRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.subject !== "string" ||
    value.subject.trim().length === 0 ||
    typeof value.stage !== "string" ||
    !STAGES.has(value.stage) ||
    !("content" in value)
  ) {
    throw new JournalError("Learning journal contains an invalid knowledge record.");
  }
  return {
    id: value.id,
    stage: value.stage as KnowledgeStage,
    subject: value.subject,
    content: structuredClone(value.content),
  };
}

function parseApproval(value: unknown): MemoryWriteApproval {
  if (
    !isRecord(value) ||
    typeof value.approval_id !== "string" ||
    !UUID_PATTERN.test(value.approval_id) ||
    typeof value.memory_id !== "string" ||
    !UUID_PATTERN.test(value.memory_id) ||
    typeof value.content_hash !== "string" ||
    !CONTENT_HASH_PATTERN.test(value.content_hash) ||
    !isActor(value.requested_by) ||
    !isIsoTimestamp(value.requested_at) ||
    !isIsoTimestamp(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.requested_at) ||
    typeof value.status !== "string" ||
    !APPROVAL_STATUSES.has(value.status) ||
    typeof value.from_stage !== "string" ||
    !STAGES.has(value.from_stage) ||
    typeof value.target_stage !== "string" ||
    !STAGES.has(value.target_stage)
  ) {
    throw new JournalError("Learning journal contains an invalid Memory approval record.");
  }
  const fromStage = value.from_stage as KnowledgeStage;
  const targetStage = value.target_stage as KnowledgeStage;
  if (!isPermanentKnowledgeStage(targetStage) || stageRank(targetStage) <= stageRank(fromStage)) {
    throw new JournalError(
      "Learning journal contains a Memory approval for an invalid permanent transition.",
    );
  }
  if (value.decided_by !== undefined && !isActor(value.decided_by)) {
    throw new JournalError(
      "Learning journal contains a Memory approval with an invalid deciding principal.",
    );
  }
  if (value.decided_at !== undefined && !isIsoTimestamp(value.decided_at)) {
    throw new JournalError(
      "Learning journal contains a Memory approval with an invalid decision timestamp.",
    );
  }
  if (value.consumed_at !== undefined && !isIsoTimestamp(value.consumed_at)) {
    throw new JournalError(
      "Learning journal contains a Memory approval with an invalid consumption timestamp.",
    );
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || value.reason.length > 1000)
  ) {
    throw new JournalError("Learning journal contains a Memory approval with an invalid reason.");
  }
  const status = value.status as MemoryApprovalStatus;
  if (
    (status === "approved" || status === "rejected") &&
    (value.decided_by === undefined || value.decided_at === undefined)
  ) {
    throw new JournalError(
      "Learning journal contains a decided Memory approval without its decision record.",
    );
  }
  if (
    status === "pending" &&
    (value.decided_by !== undefined ||
      value.decided_at !== undefined ||
      value.consumed_at !== undefined)
  ) {
    throw new JournalError(
      "Learning journal contains a pending Memory approval with a decision or consumption.",
    );
  }
  if (
    status === "consumed" &&
    (value.decided_by === undefined ||
      value.decided_at === undefined ||
      value.consumed_at === undefined)
  ) {
    throw new JournalError(
      "Learning journal contains a consumed Memory approval without its decision and consumption records.",
    );
  }
  return {
    approval_id: value.approval_id,
    memory_id: value.memory_id,
    from_stage: fromStage,
    target_stage: targetStage,
    content_hash: value.content_hash,
    requested_by: value.requested_by,
    requested_at: value.requested_at,
    expires_at: value.expires_at,
    status,
    ...(value.decided_by === undefined ? {} : { decided_by: value.decided_by }),
    ...(value.decided_at === undefined ? {} : { decided_at: value.decided_at }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.consumed_at === undefined ? {} : { consumed_at: value.consumed_at }),
  };
}

function parseMemoryObject(value: unknown): MemoryObjectEntityType {
  try {
    return MemoryObjectSchema.parse(value);
  } catch {
    throw new JournalError(
      "Learning journal contains a Memory Object that fails its canonical schema.",
    );
  }
}

export interface DurableLearningStoreOptions {
  directory: string;
  maxJournalBytes?: number;
}

/**
 * Durable Learning System state: Memory Objects, knowledge-stage records, and the
 * approvals that authorize permanent promotions.
 *
 * This is deliberately a separate journal from `operational.jsonl`. ADR-0015 limits the
 * operational substrate to Task/Workflow/Artifact/run/execution state and does not amend
 * ADR-0014. This store holds organizational Learning/Memory state, not Founder
 * Intelligence (Founder Profile/Memory/Context remain in the Obsidian vault).
 *
 * A permanent promotion is committed as one `promotion` record carrying both the updated
 * knowledge record and the consumed approval, so the decision and the write cannot diverge
 * across a crash or reopen. Replay revalidates that correlation and refuses a promotion
 * whose approval was not approved, was bound to different content, or had already been
 * consumed.
 */
export class DurableLearningStore {
  readonly journal: AppendOnlyJournal;
  readonly memoryRepository: MemoryObjectRepositoryPort;
  readonly knowledgeRepository: KnowledgeRepositoryPort;
  readonly approvalRepository: MemoryApprovalRepositoryPort;

  private readonly memories = new Map<string, MemoryObjectEntityType>();
  private readonly knowledge = new Map<string, KnowledgeRecord>();
  private readonly approvals = new Map<string, MemoryWriteApproval>();

  constructor(options: DurableLearningStoreOptions) {
    if (
      !isRecord(options as unknown) ||
      typeof options.directory !== "string" ||
      options.directory.length === 0
    ) {
      throw new Error("Durable learning storage requires a directory.");
    }
    this.journal = new AppendOnlyJournal({
      filePath: join(options.directory.replace(/\/+$/, ""), "learning.jsonl"),
      ...(options.maxJournalBytes === undefined ? {} : { maxBytes: options.maxJournalBytes }),
    });

    this.memoryRepository = {
      create: (memory) => this.createMemory(memory),
      get: (entityId) => this.getMemory(entityId),
    };
    this.knowledgeRepository = {
      create: (record) => this.createKnowledge(record),
      get: (id) => this.getKnowledge(id),
      update: (record) => this.updateKnowledge(record),
      listByStage: (stage) => this.listByStage(stage),
      commitPromotion: (record, approval) => this.commitPromotion(record, approval),
    };
    this.approvalRepository = {
      create: (approval) => this.createApproval(approval),
      get: (approvalId) => this.getApproval(approvalId),
      update: (approval) => this.updateApproval(approval),
    };

    try {
      for (const entry of this.journal.read()) {
        if (entry.kind === "memory") {
          const memory = parseMemoryObject(entry.payload);
          if (this.memories.has(memory.entity_id)) {
            throw new JournalError("Learning journal contains a duplicate Memory Object.");
          }
          this.memories.set(memory.entity_id, memory);
        } else if (entry.kind === "knowledge") {
          const record = parseKnowledgeRecord(entry.payload);
          if (this.knowledge.has(record.id)) {
            throw new JournalError("Learning journal contains a duplicate knowledge record.");
          }
          this.knowledge.set(record.id, record);
        } else if (entry.kind === "approval") {
          const approval = parseApproval(entry.payload);
          const current = this.approvals.get(approval.approval_id);
          if (current && !isApprovalTransition(current.status, approval.status)) {
            throw new JournalError(
              "Learning journal contains an invalid Memory approval transition.",
            );
          }
          this.approvals.set(approval.approval_id, approval);
        } else if (entry.kind === "promotion") {
          this.restorePromotion(entry.payload);
        } else {
          throw new JournalError(
            `Learning journal contains an unknown record kind "${entry.kind}".`,
          );
        }
      }
    } catch (error) {
      this.journal.close();
      throw error;
    }
  }

  close(): void {
    this.journal.close();
  }

  private createMemory(memory: MemoryObjectEntityType): MemoryObjectEntityType {
    const parsed = parseMemoryObject(memory);
    if (this.memories.has(parsed.entity_id)) {
      throw new Error(`Memory Object "${parsed.entity_id}" already exists.`);
    }
    this.journal.append("memory", parsed);
    this.memories.set(parsed.entity_id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  private getMemory(entityId: string): MemoryObjectEntityType | undefined {
    const memory = this.memories.get(entityId);
    return memory ? structuredClone(memory) : undefined;
  }

  private createKnowledge(record: KnowledgeRecord): void {
    const parsed = parseKnowledgeRecord(record);
    if (this.knowledge.has(parsed.id)) {
      throw new Error(`Knowledge record "${parsed.id}" already exists.`);
    }
    this.journal.append("knowledge", parsed);
    this.knowledge.set(parsed.id, structuredClone(parsed));
  }

  private getKnowledge(id: string): KnowledgeRecord | undefined {
    const record = this.knowledge.get(id);
    return record ? structuredClone(record) : undefined;
  }

  private updateKnowledge(record: KnowledgeRecord): void {
    const parsed = parseKnowledgeRecord(record);
    const current = this.knowledge.get(parsed.id);
    if (!current) throw new Error(`Knowledge record "${parsed.id}" does not exist.`);
    if (stageRank(parsed.stage) < stageRank(current.stage)) {
      throw new Error(
        "Knowledge stages are forward-only; the learning journal refused a demotion.",
      );
    }
    this.journal.append("knowledge", parsed);
    this.knowledge.set(parsed.id, structuredClone(parsed));
  }

  private listByStage(stage: KnowledgeStage): KnowledgeRecord[] {
    return [...this.knowledge.values()]
      .filter((record) => record.stage === stage)
      .map((record) => structuredClone(record));
  }

  private createApproval(approval: MemoryWriteApproval): MemoryWriteApproval {
    const parsed = parseApproval(approval);
    if (this.approvals.has(parsed.approval_id)) {
      throw new Error(`Memory approval "${parsed.approval_id}" already exists.`);
    }
    this.journal.append("approval", parsed);
    this.approvals.set(parsed.approval_id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  private getApproval(approvalId: string): MemoryWriteApproval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  private updateApproval(approval: MemoryWriteApproval): MemoryWriteApproval {
    const parsed = parseApproval(approval);
    const current = this.approvals.get(parsed.approval_id);
    if (!current) throw new Error(`Memory approval "${parsed.approval_id}" does not exist.`);
    if (!isApprovalTransition(current.status, parsed.status)) {
      throw new Error(
        `Memory approval "${parsed.approval_id}" cannot move from ${current.status} to ${parsed.status}.`,
      );
    }
    this.journal.append("approval", parsed);
    this.approvals.set(parsed.approval_id, structuredClone(parsed));
    return structuredClone(parsed);
  }

  private commitPromotion(record: KnowledgeRecord, approval: MemoryWriteApproval): void {
    const parsedRecord = parseKnowledgeRecord(record);
    const parsedApproval = parseApproval(approval);
    const currentRecord = this.knowledge.get(parsedRecord.id);
    const currentApproval = this.approvals.get(parsedApproval.approval_id);
    if (!currentRecord || !currentApproval) {
      throw new Error(
        "A permanent Memory promotion requires an existing knowledge record and approval.",
      );
    }
    this.assertPromotionBinding(currentRecord, currentApproval, parsedRecord, parsedApproval);
    this.journal.append("promotion", { record: parsedRecord, approval: parsedApproval });
    this.knowledge.set(parsedRecord.id, structuredClone(parsedRecord));
    this.approvals.set(parsedApproval.approval_id, structuredClone(parsedApproval));
  }

  private assertPromotionBinding(
    currentRecord: KnowledgeRecord,
    currentApproval: MemoryWriteApproval,
    promotedRecord: KnowledgeRecord,
    consumedApproval: MemoryWriteApproval,
  ): void {
    if (currentApproval.status !== "approved" || consumedApproval.status !== "consumed") {
      throw new Error(
        "A permanent Memory promotion requires an approved approval and must consume it exactly once.",
      );
    }
    if (
      promotedRecord.stage !== currentApproval.target_stage ||
      currentRecord.stage !== currentApproval.from_stage ||
      stageRank(promotedRecord.stage) <= stageRank(currentRecord.stage)
    ) {
      throw new Error("The permanent Memory promotion does not match the approved transition.");
    }
    if (
      currentApproval.approval_id !== consumedApproval.approval_id ||
      currentApproval.memory_id !== consumedApproval.memory_id ||
      currentApproval.content_hash !== consumedApproval.content_hash ||
      currentApproval.from_stage !== consumedApproval.from_stage ||
      currentApproval.target_stage !== consumedApproval.target_stage ||
      currentApproval.decided_by !== consumedApproval.decided_by ||
      currentApproval.decided_at !== consumedApproval.decided_at ||
      currentApproval.expires_at !== consumedApproval.expires_at
    ) {
      throw new Error("The consumed approval does not match the recorded approval decision.");
    }
    if (
      promotedRecord.id !== currentApproval.memory_id ||
      memoryWriteContentHash(promotedRecord.id, promotedRecord.subject, promotedRecord.content) !==
        currentApproval.content_hash
    ) {
      throw new Error(
        "The permanent Memory promotion content does not match the approved content.",
      );
    }
  }

  private restorePromotion(payload: unknown): void {
    if (!isRecord(payload) || !("record" in payload) || !("approval" in payload)) {
      throw new JournalError("Learning journal contains an invalid promotion record.");
    }
    const record = parseKnowledgeRecord(payload.record);
    const approval = parseApproval(payload.approval);
    const currentRecord = this.knowledge.get(record.id);
    const currentApproval = this.approvals.get(approval.approval_id);
    if (!currentRecord || !currentApproval) {
      throw new JournalError(
        "Learning journal contains a promotion without its knowledge record or approval.",
      );
    }
    try {
      this.assertPromotionBinding(currentRecord, currentApproval, record, approval);
    } catch {
      throw new JournalError(
        "Learning journal contains a promotion that does not match its approval.",
      );
    }
    this.knowledge.set(record.id, record);
    this.approvals.set(approval.approval_id, approval);
  }
}
