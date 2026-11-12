import { randomUUID } from "node:crypto";
import type { AppendOnlyJournal } from "../persistence/journal.js";
import { JournalError } from "../persistence/journal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_ACTOR = /^human:[^\s:*]+$/;
export const MAX_DAG_NODES = 256;
export const MAX_DAG_PARALLELISM = 32;

export type DagNodeState =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface DagNode {
  node_id: string;
  task_id: string;
  depends_on: string[];
  /** 0 means ungated; 1-5 independent human approvals are required before a claim. */
  approval_quorum: number;
  approvals: string[];
  state: DagNodeState;
}

export interface DagGraph {
  graph_id: string;
  mission_id: string;
  nodes: DagNode[];
  max_parallelism: number;
  /** Opt-in only. A restarted graph with this false stays interrupted until resumed. */
  auto_resume: boolean;
  created_at: string;
  updated_at: string;
  last_started_at?: string;
  revision: number;
}

export interface DagGraphInput {
  mission_id: string;
  nodes: Array<{
    task_id: string;
    depends_on?: string[];
    approval_quorum?: number;
  }>;
  max_parallelism?: number;
  auto_resume?: boolean;
}

export interface DagClaim {
  graph_id: string;
  mission_id: string;
  node_id: string;
  task_id: string;
}

export class DagSchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagSchedulerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Legal persisted state transitions between two appended graph revisions. */
const NODE_STATE_TRANSITIONS: Record<DagNodeState, readonly DagNodeState[]> = {
  pending: ["pending", "running"],
  awaiting_approval: ["awaiting_approval", "pending"],
  running: ["running", "completed", "failed", "interrupted", "pending"],
  interrupted: ["interrupted", "pending", "awaiting_approval"],
  completed: ["completed"],
  failed: ["failed"],
};

function validateGraph(value: unknown): DagGraph {
  if (
    !isRecord(value) ||
    !isUuid(value.graph_id) ||
    !isUuid(value.mission_id) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > MAX_DAG_NODES ||
    !Number.isSafeInteger(value.max_parallelism) ||
    (value.max_parallelism as number) < 1 ||
    (value.max_parallelism as number) > MAX_DAG_PARALLELISM ||
    typeof value.auto_resume !== "boolean" ||
    !isIso(value.created_at) ||
    !isIso(value.updated_at) ||
    !(value.last_started_at === undefined || isIso(value.last_started_at)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  ) {
    throw new JournalError("Operational journal contains an invalid DAG scheduler graph.");
  }
  const nodeIds = new Set<string>();
  const taskIds = new Set<string>();
  const nodes: DagNode[] = [];
  for (const raw of value.nodes) {
    if (
      !isRecord(raw) ||
      !isUuid(raw.node_id) ||
      !isUuid(raw.task_id) ||
      !Array.isArray(raw.depends_on) ||
      raw.depends_on.length > MAX_DAG_NODES ||
      raw.depends_on.some((dependency) => !isUuid(dependency)) ||
      !Number.isSafeInteger(raw.approval_quorum) ||
      (raw.approval_quorum as number) < 0 ||
      (raw.approval_quorum as number) > 5 ||
      !Array.isArray(raw.approvals) ||
      raw.approvals.length > 5 ||
      raw.approvals.some((actor) => typeof actor !== "string" || !HUMAN_ACTOR.test(actor)) ||
      (raw.state !== "pending" &&
        raw.state !== "awaiting_approval" &&
        raw.state !== "running" &&
        raw.state !== "completed" &&
        raw.state !== "failed" &&
        raw.state !== "interrupted")
    ) {
      throw new JournalError("Operational journal contains an invalid DAG scheduler node.");
    }
    const nodeId = raw.node_id.toLowerCase();
    const taskId = raw.task_id.toLowerCase();
    const dependsOn = (raw.depends_on as string[]).map((dependency) => dependency.toLowerCase());
    const approvals = raw.approvals as string[];
    const quorum = raw.approval_quorum as number;
    if (
      new Set(dependsOn).size !== dependsOn.length ||
      new Set(approvals).size !== approvals.length ||
      approvals.length > quorum
    ) {
      throw new JournalError("Operational journal DAG contains duplicate edges or approvals.");
    }
    if (raw.state === "awaiting_approval") {
      if (quorum === 0 || approvals.length >= quorum) {
        throw new JournalError("Operational journal DAG has an inconsistent approval state.");
      }
    } else if (quorum > 0 && approvals.length < quorum) {
      throw new JournalError("Operational journal DAG released a gated node without quorum.");
    }
    if (nodeIds.has(nodeId) || taskIds.has(taskId)) {
      throw new JournalError("Operational journal DAG contains duplicate nodes.");
    }
    nodeIds.add(nodeId);
    taskIds.add(taskId);
    nodes.push({
      node_id: nodeId,
      task_id: taskId,
      depends_on: dependsOn,
      approval_quorum: quorum,
      approvals,
      state: raw.state,
    });
  }
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!nodeIds.has(dependency) || dependency === node.node_id) {
        throw new JournalError("Operational journal DAG contains a missing dependency.");
      }
    }
  }
  try {
    topologicalOrder(nodes);
  } catch {
    throw new JournalError("Operational journal DAG contains a dependency cycle.");
  }
  return {
    graph_id: value.graph_id.toLowerCase(),
    mission_id: value.mission_id.toLowerCase(),
    nodes,
    max_parallelism: value.max_parallelism as number,
    auto_resume: value.auto_resume,
    created_at: value.created_at,
    updated_at: value.updated_at,
    ...(value.last_started_at === undefined ? {} : { last_started_at: value.last_started_at }),
    revision: value.revision as number,
  };
}

/**
 * Rejects cycles and returns a stable topological order. Input order breaks ties, so two
 * identical graphs always persist in the same order.
 */
function topologicalOrder(nodes: readonly DagNode[]): DagNode[] {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const indegree = new Map(nodes.map((node) => [node.node_id, node.depends_on.length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      const list = dependents.get(dependency) ?? [];
      list.push(node.node_id);
      dependents.set(dependency, list);
    }
  }
  const ready = nodes.filter((node) => indegree.get(node.node_id) === 0);
  const ordered: DagNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) break;
    ordered.push(node);
    for (const dependentId of dependents.get(node.node_id) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) {
        const dependent = byId.get(dependentId);
        if (dependent) ready.push(dependent);
      }
    }
  }
  if (ordered.length !== nodes.length) {
    throw new DagSchedulerError("DAG contains a dependency cycle.");
  }
  return ordered;
}

function isReady(node: DagNode, byId: Map<string, DagNode>): boolean {
  return node.depends_on.every((dependency) => byId.get(dependency)?.state === "completed");
}

/**
 * Durable dependency-DAG scheduler.
 *
 * The scheduler owns only scheduling state. Execution remains in the Orchestration Kernel:
 * a claim names a Task for an already-authorized caller, and completion is recorded only by
 * an explicit completion call. Every mutation is appended to the operational journal and a
 * compacted snapshot carries the same records through the validated restore path.
 *
 * Fairness is mission-aware: each scheduling round prefers the mission with the fewest
 * starts in that round, then the graph least recently started. Parallelism is enforced both
 * per graph and by the host-wide ceiling.
 */
export class DurableDagScheduler {
  private readonly graphs = new Map<string, DagGraph>();
  private readonly maxParallelism: number;
  private used = false;

  constructor(
    private readonly journal: AppendOnlyJournal,
    maxParallelism = 4,
  ) {
    if (
      !Number.isSafeInteger(maxParallelism) ||
      maxParallelism < 1 ||
      maxParallelism > MAX_DAG_PARALLELISM
    ) {
      throw new DagSchedulerError("DAG scheduler parallelism is outside the supported range.");
    }
    this.maxParallelism = maxParallelism;
  }

  create(input: DagGraphInput, now: Date = new Date()): DagGraph {
    this.used = true;
    if (!isRecord(input as unknown) || !isUuid(input.mission_id)) {
      throw new DagSchedulerError("A DAG requires a Mission UUID.");
    }
    const missionId = input.mission_id.toLowerCase();
    if (
      !Array.isArray(input.nodes) ||
      input.nodes.length === 0 ||
      input.nodes.length > MAX_DAG_NODES
    ) {
      throw new DagSchedulerError(`A DAG requires 1-${MAX_DAG_NODES} nodes.`);
    }
    const requestedParallelism = input.max_parallelism ?? this.maxParallelism;
    if (
      !Number.isSafeInteger(requestedParallelism) ||
      requestedParallelism < 1 ||
      requestedParallelism > this.maxParallelism
    ) {
      throw new DagSchedulerError("A DAG parallelism must be between 1 and the host-wide ceiling.");
    }
    if (input.auto_resume !== undefined && typeof input.auto_resume !== "boolean") {
      throw new DagSchedulerError("DAG auto_resume must be a boolean.");
    }

    const nodes: DagNode[] = [];
    const taskIds = new Set<string>();
    for (const raw of input.nodes) {
      if (!isRecord(raw as unknown) || !isUuid(raw.task_id)) {
        throw new DagSchedulerError("Every DAG node requires a Task UUID.");
      }
      // UUID comparison is case-insensitive. Canonicalizing here prevents the same Task
      // being supplied twice with different hex casing, and makes dependency resolution
      // agree with the node identity used by the execution ledger.
      const taskId = raw.task_id.toLowerCase();
      if (taskIds.has(taskId)) {
        throw new DagSchedulerError("A DAG must not contain the same Task twice.");
      }
      taskIds.add(taskId);
      const rawDependsOn = raw.depends_on ?? [];
      if (
        !Array.isArray(rawDependsOn) ||
        rawDependsOn.length > MAX_DAG_NODES ||
        rawDependsOn.some((dependency) => !isUuid(dependency))
      ) {
        throw new DagSchedulerError("DAG dependencies must be distinct Task UUIDs.");
      }
      const dependsOn = rawDependsOn.map((dependency) => dependency.toLowerCase());
      if (new Set(dependsOn).size !== dependsOn.length) {
        throw new DagSchedulerError("DAG dependencies must be distinct Task UUIDs.");
      }
      const quorum = raw.approval_quorum ?? 0;
      if (!Number.isSafeInteger(quorum) || quorum < 0 || quorum > 5) {
        throw new DagSchedulerError("DAG approval quorum must be an integer between 0 and 5.");
      }
      nodes.push({
        node_id: randomUUID(),
        task_id: taskId,
        depends_on: dependsOn,
        approval_quorum: quorum,
        approvals: [],
        state: quorum === 0 ? "pending" : "awaiting_approval",
      });
    }

    // Dependencies refer to node ids, while callers naturally supply task ids. Resolve
    // task-id references to the generated node ids before validation.
    const nodeIdByTaskId = new Map(nodes.map((node) => [node.task_id, node.node_id]));
    for (const node of nodes) {
      const resolved: string[] = [];
      for (const dependency of node.depends_on) {
        const nodeId = nodeIdByTaskId.get(dependency);
        if (!nodeId) {
          throw new DagSchedulerError(`DAG dependency "${dependency}" is not a node Task.`);
        }
        resolved.push(nodeId);
      }
      node.depends_on = resolved;
    }
    const ordered = topologicalOrder(nodes);
    const nowIso = now.toISOString();
    const graph: DagGraph = {
      graph_id: randomUUID(),
      mission_id: missionId,
      nodes: ordered,
      max_parallelism: requestedParallelism,
      auto_resume: input.auto_resume ?? false,
      created_at: nowIso,
      updated_at: nowIso,
      revision: 1,
    };
    this.persist(graph);
    return clone(graph);
  }

  get(graphId: string): DagGraph | undefined {
    const graph = this.graphs.get(graphId);
    return graph ? clone(graph) : undefined;
  }

  list(): DagGraph[] {
    return [...this.graphs.values()].map((graph) => clone(graph));
  }

  /** Adds one independent human approval and releases the node when quorum is met. */
  approve(graphId: string, nodeId: string, actorId: string, now: Date = new Date()): DagGraph {
    this.used = true;
    if (!HUMAN_ACTOR.test(actorId)) {
      throw new DagSchedulerError("DAG approval requires a human principal.");
    }
    const graph = this.requireGraph(graphId);
    const node = graph.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!node) throw new DagSchedulerError("DAG node was not found.");
    if (node.approval_quorum === 0) {
      throw new DagSchedulerError("This DAG node does not require approval.");
    }
    if (node.state === "running" || node.state === "completed" || node.state === "failed") {
      throw new DagSchedulerError("A started or terminal DAG node cannot be approved.");
    }
    if (node.approvals.includes(actorId)) {
      throw new DagSchedulerError("The same principal cannot satisfy more than one approval.");
    }
    if (node.approvals.length >= node.approval_quorum) {
      throw new DagSchedulerError("DAG node approval quorum is already satisfied.");
    }
    node.approvals.push(actorId);
    if (node.approvals.length >= node.approval_quorum) node.state = "pending";
    this.touch(graph, now);
    this.persist(graph);
    return clone(graph);
  }

  /**
   * Claims ready nodes up to free capacity. Claims are scheduling decisions only; callers
   * still execute through the Orchestration Kernel and must hold the Task's execute grant.
   */
  claim(now: Date = new Date(), limit = this.maxParallelism): DagClaim[] {
    this.used = true;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxParallelism) {
      throw new DagSchedulerError("DAG claim limit is outside the supported range.");
    }
    const free = Math.min(limit, this.maxParallelism - this.runningCount());
    if (free <= 0) return [];
    const claims: DagClaim[] = [];
    const startsByMission = new Map<string, number>();

    while (claims.length < free) {
      const candidates = [...this.graphs.values()]
        .filter(
          (graph) =>
            this.runningInGraph(graph) < graph.max_parallelism &&
            graph.nodes.some((node) => node.state === "pending"),
        )
        .sort((left, right) => {
          const leftStarts = startsByMission.get(left.mission_id) ?? 0;
          const rightStarts = startsByMission.get(right.mission_id) ?? 0;
          if (leftStarts !== rightStarts) return leftStarts - rightStarts;
          const leftLast = Date.parse(left.last_started_at ?? left.created_at);
          const rightLast = Date.parse(right.last_started_at ?? right.created_at);
          if (leftLast !== rightLast) return leftLast - rightLast;
          return left.created_at.localeCompare(right.created_at);
        });

      let claimed = false;
      for (const graph of candidates) {
        const byId = new Map(graph.nodes.map((node) => [node.node_id, node]));
        const node = graph.nodes.find(
          (candidate) => candidate.state === "pending" && isReady(candidate, byId),
        );
        if (!node) continue;
        node.state = "running";
        graph.last_started_at = now.toISOString();
        this.touch(graph, now);
        this.persist(graph);
        startsByMission.set(graph.mission_id, (startsByMission.get(graph.mission_id) ?? 0) + 1);
        claims.push({
          graph_id: graph.graph_id,
          mission_id: graph.mission_id,
          node_id: node.node_id,
          task_id: node.task_id,
        });
        claimed = true;
        break;
      }
      if (!claimed) break;
    }
    return claims;
  }

  /** Records the terminal state of a claimed node. */
  complete(graphId: string, nodeId: string, success: boolean, now: Date = new Date()): DagGraph {
    this.used = true;
    const graph = this.requireGraph(graphId);
    const node = graph.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!node) throw new DagSchedulerError("DAG node was not found.");
    if (node.state !== "running") {
      throw new DagSchedulerError("Only a running DAG node can be completed.");
    }
    node.state = success ? "completed" : "failed";
    this.touch(graph, now);
    this.persist(graph);
    return clone(graph);
  }

  /**
   * Startup reconciliation: every running node's process is gone. Auto-resume is opt-in, so
   * only graphs that explicitly enabled it return to pending. Others stay interrupted and
   * require an explicit resume decision.
   */
  recover(now: Date = new Date()): string[] {
    if (this.used) {
      throw new DagSchedulerError("DAG recovery is a startup-only operation.");
    }
    this.used = true;
    const recovered: string[] = [];
    for (const graph of this.graphs.values()) {
      let changed = false;
      for (const node of graph.nodes) {
        if (node.state !== "running") continue;
        node.state = graph.auto_resume ? "pending" : "interrupted";
        changed = true;
      }
      if (changed) {
        this.touch(graph, now);
        this.persist(graph);
        recovered.push(graph.graph_id);
      }
    }
    return recovered;
  }

  /** Explicitly returns an interrupted graph to pending; never implied by a read. */
  resume(graphId: string, now: Date = new Date()): DagGraph {
    this.used = true;
    const graph = this.requireGraph(graphId);
    let changed = false;
    for (const node of graph.nodes) {
      if (node.state !== "interrupted") continue;
      node.state =
        node.approval_quorum > 0 && node.approvals.length < node.approval_quorum
          ? "awaiting_approval"
          : "pending";
      changed = true;
    }
    if (!changed) throw new DagSchedulerError("DAG has no interrupted nodes to resume.");
    this.touch(graph, now);
    this.persist(graph);
    return clone(graph);
  }

  snapshot(): DagGraph[] {
    return this.list();
  }

  /** Journal replay only. */
  restore(value: unknown): void {
    const graph = validateGraph(value);
    const current = this.graphs.get(graph.graph_id);
    if (current) {
      if (graph.revision !== current.revision + 1) {
        throw new JournalError("Operational journal contains a non-monotonic scheduler graph.");
      }
      if (
        graph.mission_id !== current.mission_id ||
        graph.max_parallelism !== current.max_parallelism ||
        graph.auto_resume !== current.auto_resume ||
        graph.created_at !== current.created_at ||
        graph.nodes.length !== current.nodes.length ||
        Date.parse(graph.updated_at) < Date.parse(current.updated_at) ||
        (current.last_started_at !== undefined &&
          (graph.last_started_at === undefined ||
            Date.parse(graph.last_started_at) < Date.parse(current.last_started_at)))
      ) {
        throw new JournalError("Operational journal mutated immutable scheduler graph fields.");
      }
      for (let index = 0; index < current.nodes.length; index += 1) {
        const previous = current.nodes[index];
        const next = graph.nodes[index];
        if (
          !previous ||
          !next ||
          previous.node_id !== next.node_id ||
          previous.task_id !== next.task_id ||
          previous.approval_quorum !== next.approval_quorum ||
          previous.depends_on.join("\u0000") !== next.depends_on.join("\u0000") ||
          !NODE_STATE_TRANSITIONS[previous.state].includes(next.state) ||
          // A running node may return directly to pending only through the opt-in
          // auto-resume path. A non-opted graph must pass through interrupted and an
          // explicit resume.
          (previous.state === "running" && next.state === "pending" && !graph.auto_resume) ||
          next.approvals.length < previous.approvals.length ||
          previous.approvals.some((actor, approvalIndex) => next.approvals[approvalIndex] !== actor)
        ) {
          throw new JournalError(
            "Operational journal contains an illegal DAG scheduler state transition.",
          );
        }
      }
    }
    this.graphs.set(graph.graph_id, graph);
  }

  private requireGraph(graphId: string): DagGraph {
    if (!isUuid(graphId)) throw new DagSchedulerError("DAG identifier must be a UUID.");
    const graph = this.graphs.get(graphId);
    if (!graph) throw new DagSchedulerError("DAG was not found.");
    return graph;
  }

  private runningCount(): number {
    let count = 0;
    for (const graph of this.graphs.values()) count += this.runningInGraph(graph);
    return count;
  }

  private runningInGraph(graph: DagGraph): number {
    return graph.nodes.filter((node) => node.state === "running").length;
  }

  private touch(graph: DagGraph, now: Date): void {
    graph.updated_at = now.toISOString();
    graph.revision += 1;
  }

  private persist(graph: DagGraph): void {
    this.journal.append("scheduler_graph", clone(graph));
    this.graphs.set(graph.graph_id, graph);
  }
}
