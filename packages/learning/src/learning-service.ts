import { createHash, randomUUID } from "node:crypto";
import type {
  Importance,
  MemoryObjectEntity as MemoryObjectEntityType,
  MemoryType,
} from "@aios/core";
import { MemoryObjectEntity } from "@aios/core";
import { ObjectStore } from "@aios/objects";
import {
  ArchivedKnowledgeError,
  InvalidStagePromotionError,
  KnowledgeNotFoundError,
  MemoryApprovalError,
} from "./errors.js";
import { type KnowledgeStage, type PromotableStage, stageRank } from "./knowledge-stage.js";

export interface ObservationOptions {
  memory_type?: MemoryType;
  importance?: Importance;
  confidence?: number;
  owner_id?: string;
  owner_type?: "agent" | "human";
}

/** What this service tracks per record, alongside the Memory Object in the Object Store. */
export interface MemoryObjectRepositoryPort {
  create(memory: MemoryObjectEntityType): MemoryObjectEntityType;
  get(entityId: string): MemoryObjectEntityType | undefined;
}

export interface KnowledgeRecord {
  /** entity_id of the backing Memory Object in the Object Store. */
  id: string;
  stage: KnowledgeStage;
  subject: string;
  content: unknown;
}

export interface KnowledgeRepositoryPort {
  create(record: KnowledgeRecord): void;
  get(id: string): KnowledgeRecord | undefined;
  update(record: KnowledgeRecord): void;
  listByStage(stage: KnowledgeStage): KnowledgeRecord[];
  /**
   * Optional atomic commit for an approval-bound permanent promotion. A durable adapter
   * implements this so the stage change and the approval consumption are one journal
   * record; the service falls back to update()+approval.update() for in-memory adapters.
   */
  commitPromotion?(record: KnowledgeRecord, approval: MemoryWriteApproval): void;
}

/** Stages that make a Memory record permanent. Draft stages need no approval. */
export const PERMANENT_KNOWLEDGE_STAGES = ["published", "institutional_standard"] as const;
export type PermanentKnowledgeStage = (typeof PERMANENT_KNOWLEDGE_STAGES)[number];

export function isPermanentKnowledgeStage(stage: KnowledgeStage): stage is PermanentKnowledgeStage {
  return stage === "published" || stage === "institutional_standard";
}

export type MemoryApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

/**
 * A recorded request to make one Memory record permanent, bound to the exact record,
 * transition, and content the principal reviewed. `expires_at` is enforced at decision
 * and write time; a pending or approved-but-expired approval never authorizes a write.
 */
export interface MemoryWriteApproval {
  approval_id: string;
  memory_id: string;
  from_stage: KnowledgeStage;
  target_stage: PermanentKnowledgeStage;
  /** SHA-256 over the memory id, subject, and content at request time. */
  content_hash: string;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  status: MemoryApprovalStatus;
  decided_by?: string;
  decided_at?: string;
  reason?: string;
  consumed_at?: string;
}

export interface MemoryApprovalRepositoryPort {
  create(approval: MemoryWriteApproval): MemoryWriteApproval;
  get(approvalId: string): MemoryWriteApproval | undefined;
  update(approval: MemoryWriteApproval): MemoryWriteApproval;
}

/** The trusted host supplies the existing deny-by-default authorization boundary here. */
export interface MemoryApprovalAuthorityPort {
  authorize(actorId: string, approval: MemoryWriteApproval): Promise<boolean>;
}

export interface LearningServiceOptions {
  /** Lifetime of a pending approval; defaults to 15 minutes and is bounded to 24 hours. */
  approval_ttl_ms?: number;
  /** Injectable clock for tests and deterministic expiry. */
  now?: () => Date;
}

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MIN_APPROVAL_TTL_MS = 1_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function isActorIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^human:[^\s:*]+$/.test(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
  );
}

function isHumanPrincipal(value: string): boolean {
  return /^human:[^\s:*]+$/.test(value);
}

/** Deterministic serialization so an approval cannot be replayed against altered content. */
function canonicalForHash(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalForHash(item))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalForHash(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value) as string;
}

export function memoryWriteContentHash(
  memoryId: string,
  subject: string,
  content: unknown,
): string {
  return createHash("sha256")
    .update(canonicalForHash({ memory_id: memoryId, subject, content }))
    .digest("hex");
}

/** In-memory approval adapter for tests and single-process development; not durable. */
export class InMemoryMemoryApprovalRepository implements MemoryApprovalRepositoryPort {
  private readonly approvals = new Map<string, MemoryWriteApproval>();

  create(approval: MemoryWriteApproval): MemoryWriteApproval {
    if (this.approvals.has(approval.approval_id)) {
      throw new Error(`Memory approval "${approval.approval_id}" already exists.`);
    }
    this.approvals.set(approval.approval_id, structuredClone(approval));
    return structuredClone(approval);
  }

  get(approvalId: string): MemoryWriteApproval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  update(approval: MemoryWriteApproval): MemoryWriteApproval {
    if (!this.approvals.has(approval.approval_id)) {
      throw new Error(`Memory approval "${approval.approval_id}" does not exist.`);
    }
    this.approvals.set(approval.approval_id, structuredClone(approval));
    return structuredClone(approval);
  }
}

/** In-memory adapter for tests and single-process development; not durable. */
export class InMemoryKnowledgeRepository implements KnowledgeRepositoryPort {
  private readonly records = new Map<string, KnowledgeRecord>();

  create(record: KnowledgeRecord): void {
    if (this.records.has(record.id))
      throw new Error(`Knowledge record "${record.id}" already exists.`);
    this.records.set(record.id, cloneKnowledge(record));
  }

  get(id: string): KnowledgeRecord | undefined {
    const record = this.records.get(id);
    return record ? cloneKnowledge(record) : undefined;
  }

  update(record: KnowledgeRecord): void {
    if (!this.records.has(record.id)) throw new KnowledgeNotFoundError(record.id);
    this.records.set(record.id, cloneKnowledge(record));
  }

  listByStage(stage: KnowledgeStage): KnowledgeRecord[] {
    return [...this.records.values()]
      .filter((record) => record.stage === stage)
      .map(cloneKnowledge);
  }
}

/**
 * LearningService — the Knowledge Evolution lifecycle, per
 * docs/engineering/runtime-interfaces.md §2.7.
 *
 * Each observation is persisted as a real Memory Object (COM §5.1) through
 * @aios/objects, so it gets the ratified identity, versioning, and immutability
 * machinery for free rather than a parallel store. Dependency matches
 * runtime-interfaces §3/§4 exactly: learning → core, objects.
 *
 * TWO THINGS LIVE HERE RATHER THAN ON THE MEMORY OBJECT, DELIBERATELY. Both are
 * deviations from a literal reading of §2.7, flagged per the playbook's Definition
 * of Done:
 *
 * 1. **The knowledge stage.** §2.7 states it is a "distinct axis from
 *    CanonicalEntity.lifecycle_state", and reconciliation-changelog.md Session 8
 *    verified these domain lifecycles as "legitimately different axes from ADR-0003"
 *    that were documented rather than merged into the base model. Adding a
 *    knowledge_stage field to core's Memory Object schema would do exactly the
 *    merging the corpus declined to do — and would require amending the ratified COM
 *    §5.1. So the axis stays in the package that owns it.
 *
 * 2. **The observation content.** §2.7's recordObservation takes
 *    `content: unknown`, but COM §5.1's Memory Object has NO content or body field —
 *    its payload fields are exhausted by name, description, memory_type, confidence,
 *    importance, evidence, and source_references. There is nowhere in the ratified
 *    schema to put an arbitrary content payload. Rather than serialize it into
 *    `description` (lossy, and a string field is not a content field) or add a field
 *    to core (a COM change, requiring an ADR-gated review), the content is held here
 *    against the Memory Object's entity_id. This is a genuine gap between the Tier 3
 *    contract and the Tier 1/2 schema; it is logged in
 *    docs/process/divergence-log.md rather than papered over.
 *
 * The Memory Object remains the canonical, persisted entity. This service holds the
 * two things the ratified model has no field for, keyed by that entity's id.
 */
function cloneKnowledge(record: KnowledgeRecord): KnowledgeRecord {
  const seen = new WeakMap<object, unknown>();
  const cloneValue = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      for (const item of value) result.push(cloneValue(item));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, nested] of Object.entries(value)) result[key] = cloneValue(nested);
    return result;
  };
  return cloneValue(record) as KnowledgeRecord;
}

export class LearningService {
  private readonly memories: MemoryObjectRepositoryPort;
  private readonly knowledge: KnowledgeRepositoryPort;
  private readonly approvals: MemoryApprovalRepositoryPort;
  private readonly authority: MemoryApprovalAuthorityPort;
  private readonly now: () => Date;
  private readonly approvalTtlMs: number;

  constructor(
    store?: MemoryObjectRepositoryPort,
    knowledgeStore?: KnowledgeRepositoryPort,
    approvalStore?: MemoryApprovalRepositoryPort,
    authority?: MemoryApprovalAuthorityPort,
    options: LearningServiceOptions = {},
  ) {
    this.memories = store ?? new ObjectStore<MemoryObjectEntityType>(MemoryObjectEntity);
    this.knowledge = knowledgeStore ?? new InMemoryKnowledgeRepository();
    this.approvals = approvalStore ?? new InMemoryMemoryApprovalRepository();
    // Absent an explicit authority, every approval decision is denied. This is the same
    // default-deny posture as the rest of the host authorization chain.
    this.authority = authority ?? { authorize: async () => false };
    this.now = options.now ?? (() => new Date());
    this.approvalTtlMs = options.approval_ttl_ms ?? DEFAULT_APPROVAL_TTL_MS;
    if (
      !Number.isSafeInteger(this.approvalTtlMs) ||
      this.approvalTtlMs < MIN_APPROVAL_TTL_MS ||
      this.approvalTtlMs > MAX_APPROVAL_TTL_MS
    ) {
      throw new MemoryApprovalError(
        "Memory approval lifetime must be between one second and 24 hours.",
      );
    }
  }

  /**
   * Records a new observation — the entry point of the Knowledge Evolution axis.
   * Creates a Memory Object and returns its entity_id, which is the id every other
   * method on this service takes.
   */
  async recordObservation(
    subject: string,
    content: unknown,
    options: ObservationOptions = {},
  ): Promise<string> {
    const normalizedSubject = subject.trim();
    if (!normalizedSubject) throw new Error("Knowledge subject must not be empty.");
    const now = new Date().toISOString();
    const owner_id = options.owner_id ?? "human:founder";

    const memory = this.memories.create(
      MemoryObjectEntity.parse({
        entity_id: randomUUID(),
        entity_type: "canonical_object",
        entity_subtype: "memory_object",
        name: normalizedSubject,
        // 'episodic' — an observation is a record of something that happened
        // (Part VIII Ch.6's Memory Domains). Overridable; not a claim that every
        // observation is episodic.
        memory_type: options.memory_type ?? "episodic",
        // A raw observation is by definition the least-established stage of the
        // axis, so it starts at low confidence unless the caller knows better.
        confidence: options.confidence ?? 0.5,
        importance: options.importance ?? "medium",
        evidence: [],
        source_references: [],
        lifecycle_state: "created",
        lifecycle_history: [],
        created_at: now,
        created_by: owner_id,
        modified_at: now,
        version: 1,
        organizational_containers: [],
        owner_id,
        owner_type: options.owner_type ?? "human",
        relationships: [],
      }),
    );

    this.knowledge.create(
      cloneKnowledge({
        id: memory.entity_id,
        stage: "observation",
        subject: normalizedSubject,
        content,
      }),
    );

    return memory.entity_id;
  }

  /**
   * Advances a record along the Knowledge Evolution axis. Forward-only: demotion is
   * not an operation the corpus defines, and this method is named promote().
   *
   * Deliberately does NOT touch lifecycle_state — that is the orthogonal axis, and
   * writing it here is the conflation §2.7 warns against.
   */
  async promote(
    observationId: string,
    toStage: PromotableStage,
    approvalId?: string,
  ): Promise<void> {
    const record = this.require(observationId);

    if (record.stage === "historical_archive") {
      throw new ArchivedKnowledgeError(observationId);
    }

    if (stageRank(toStage) <= stageRank(record.stage)) {
      throw new InvalidStagePromotionError(observationId, record.stage, toStage);
    }

    if (!isPermanentKnowledgeStage(toStage)) {
      this.knowledge.update({ ...record, stage: toStage });
      return;
    }

    // Permanent memory writes are deny-by-default: no approval, no write. The approval is
    // bound to this memory, this transition, and this content, and is consumed exactly once.
    const approval = this.requireApprovedPromotion(approvalId, record, toStage);
    const promoted = { ...record, stage: toStage };
    const consumed: MemoryWriteApproval = {
      ...approval,
      status: "consumed",
      consumed_at: this.now().toISOString(),
    };
    if (this.knowledge.commitPromotion) {
      this.knowledge.commitPromotion(promoted, consumed);
    } else {
      this.knowledge.update(promoted);
      this.approvals.update(consumed);
    }
  }

  /**
   * Proposes making a record permanent. A proposal is not an authorization and writes no
   * Memory: it creates a pending approval bound to the record, transition, and content.
   */
  async requestPermanentPromotion(
    memoryId: string,
    toStage: PromotableStage,
    actorId: string,
  ): Promise<MemoryWriteApproval> {
    if (!isActorIdentifier(actorId)) {
      throw new MemoryApprovalError(
        "A permanent Memory approval request requires a valid authenticated actor identifier.",
      );
    }
    if (!isPermanentKnowledgeStage(toStage)) {
      throw new MemoryApprovalError(
        "Only published or institutional_standard Memory promotions require approval.",
      );
    }
    const record = this.require(memoryId);
    if (record.stage === "historical_archive") throw new ArchivedKnowledgeError(memoryId);
    if (stageRank(toStage) <= stageRank(record.stage)) {
      throw new InvalidStagePromotionError(memoryId, record.stage, toStage);
    }

    const now = this.now();
    return this.approvals.create({
      approval_id: randomUUID(),
      memory_id: memoryId,
      from_stage: record.stage,
      target_stage: toStage,
      content_hash: memoryWriteContentHash(record.id, record.subject, record.content),
      requested_by: actorId,
      requested_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.approvalTtlMs).toISOString(),
      status: "pending",
    });
  }

  /**
   * Records a human principal's explicit decision. Deny-by-default: the actor must be a
   * human principal and the injected authorization boundary must allow the decision.
   */
  async decidePermanentPromotion(
    approvalId: string,
    decision: "approved" | "rejected",
    actorId: string,
    reason?: string,
  ): Promise<MemoryWriteApproval> {
    if (!isActorIdentifier(actorId) || !isHumanPrincipal(actorId)) {
      throw new MemoryApprovalError(
        "Permanent Memory approvals can only be decided by an authenticated human principal.",
      );
    }
    if (decision !== "approved" && decision !== "rejected") {
      throw new MemoryApprovalError(
        "A permanent Memory approval decision must be approved or rejected.",
      );
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 1000)) {
      throw new MemoryApprovalError(
        "Approval reasons must be strings of at most 1,000 characters.",
      );
    }
    const approval = this.approvals.get(approvalId);
    if (!approval)
      throw new MemoryApprovalError(`No permanent Memory approval found with id "${approvalId}".`);
    if (approval.status !== "pending") {
      throw new MemoryApprovalError(
        `Memory approval "${approvalId}" is already ${approval.status}.`,
      );
    }
    const now = this.now();
    if (Date.parse(approval.expires_at) <= now.getTime()) {
      throw new MemoryApprovalError(`Memory approval "${approvalId}" has expired.`);
    }

    let allowed = false;
    try {
      allowed = await this.authority.authorize(actorId, approval);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new MemoryApprovalError(
        `Permanent Memory approval "${approvalId}" was denied for principal "${actorId}".`,
      );
    }

    const trimmedReason = reason?.trim();
    return this.approvals.update({
      ...approval,
      status: decision,
      decided_by: actorId,
      decided_at: now.toISOString(),
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    });
  }

  getMemoryApproval(approvalId: string): MemoryWriteApproval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  private requireApprovedPromotion(
    approvalId: string | undefined,
    record: KnowledgeRecord,
    toStage: PermanentKnowledgeStage,
  ): MemoryWriteApproval {
    if (!approvalId) {
      throw new MemoryApprovalError(
        `Promoting knowledge "${record.id}" to "${toStage}" is a permanent Memory write and requires an explicit approval.`,
      );
    }
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new MemoryApprovalError(`No permanent Memory approval found with id "${approvalId}".`);
    }
    if (approval.status !== "approved") {
      throw new MemoryApprovalError(
        `Permanent Memory approval "${approvalId}" is ${approval.status}; a pending, rejected, or consumed approval cannot authorize a write.`,
      );
    }
    if (
      approval.memory_id !== record.id ||
      approval.from_stage !== record.stage ||
      approval.target_stage !== toStage ||
      approval.content_hash !== memoryWriteContentHash(record.id, record.subject, record.content)
    ) {
      throw new MemoryApprovalError(
        `Permanent Memory approval "${approvalId}" is bound to a different record, transition, or content.`,
      );
    }
    if (Date.parse(approval.expires_at) <= this.now().getTime()) {
      throw new MemoryApprovalError(`Permanent Memory approval "${approvalId}" has expired.`);
    }
    return approval;
  }

  /** Moves a record to 'historical_archive', the terminal stage of the axis (§2.7). */
  async archiveKnowledge(id: string): Promise<void> {
    const record = this.require(id);
    this.knowledge.update({ ...record, stage: "historical_archive" });
  }

  getKnowledge(id: string): KnowledgeRecord | undefined {
    const record = this.knowledge.get(id);
    return record ? cloneKnowledge(record) : undefined;
  }

  /** The backing Memory Object (COM §5.1) for a knowledge record. */
  getMemoryObject(id: string): MemoryObjectEntityType | undefined {
    return this.memories.get(id);
  }

  listByStage(stage: KnowledgeStage): KnowledgeRecord[] {
    return this.knowledge.listByStage(stage).map(cloneKnowledge);
  }

  private require(id: string): KnowledgeRecord {
    const record = this.knowledge.get(id);
    if (!record) {
      throw new KnowledgeNotFoundError(id);
    }
    return record;
  }
}
