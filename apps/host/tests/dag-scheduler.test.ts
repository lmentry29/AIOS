import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { DagSchedulerError, DurableDagScheduler } from "../src/scheduler/dag-scheduler.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-scheduler-"));
}

function tasks(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

describe("durable dependency-DAG scheduler", () => {
  it("rejects cycles, duplicate tasks, unknown dependencies and self-dependencies", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const mission = randomUUID();
    const [a, b] = tasks(2);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [
          { task_id: a as string, depends_on: [b as string] },
          { task_id: b as string, depends_on: [a as string] },
        ],
      }),
    ).toThrow(DagSchedulerError);
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [{ task_id: a as string, depends_on: [a as string] }],
      }),
    ).toThrow(DagSchedulerError);
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [{ task_id: a as string, depends_on: [randomUUID()] }],
      }),
    ).toThrow(/not a node Task/);
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [{ task_id: a as string }, { task_id: a as string }],
      }),
    ).toThrow(/same Task twice/);
    // UUID hex casing is not a second identity. Both duplicate task aliases and a
    // self-dependency written with different casing must be rejected.
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [
          { task_id: a as string },
          { task_id: (a as string).toUpperCase(), depends_on: [a as string] },
        ],
      }),
    ).toThrow(/same Task twice/);
    expect(() =>
      store.scheduler.create({
        mission_id: mission,
        nodes: [{ task_id: a as string, depends_on: [(a as string).toUpperCase()] }],
      }),
    ).toThrow(/cycle/);
    store.close();
  });

  it("rejects journal replay that duplicates approvals or releases a gated node early", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID(), approval_quorum: 2 }],
    });
    const duplicateApprovals = store.scheduler.get(graph.graph_id);
    if (!duplicateApprovals) throw new Error("graph missing");
    duplicateApprovals.revision = 2;
    duplicateApprovals.nodes[0] = {
      ...duplicateApprovals.nodes[0],
      state: "pending",
      approvals: ["human:one", "human:one"],
    };
    store.journal.append("scheduler_graph", duplicateApprovals);
    store.close();
    expect(() => new DurableOperationalStore({ directory })).toThrow(
      /duplicate edges or approvals/,
    );
  });

  it("rejects a journal that releases a gated node without distinct quorum or skips a revision", () => {
    const directory = stateDirectory();
    let store = new DurableOperationalStore({ directory });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID(), approval_quorum: 2 }],
    });
    const early = store.scheduler.get(graph.graph_id);
    if (!early) throw new Error("graph missing");
    early.revision = 2;
    early.nodes[0] = {
      ...early.nodes[0],
      state: "running",
      approvals: ["human:one"],
    };
    store.journal.append("scheduler_graph", early);
    store.close();
    expect(() => new DurableOperationalStore({ directory })).toThrow(/without quorum/);

    const gapDirectory = stateDirectory();
    store = new DurableOperationalStore({ directory: gapDirectory });
    const clean = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }],
    });
    const skipped = store.scheduler.get(clean.graph_id);
    if (!skipped) throw new Error("graph missing");
    skipped.revision = 3;
    store.journal.append("scheduler_graph", skipped);
    store.close();
    expect(() => new DurableOperationalStore({ directory: gapDirectory })).toThrow(
      /non-monotonic scheduler graph/,
    );
  });

  it("rejects journal replay that mutates immutable graph fields or regresses a completed node", () => {
    const directory = stateDirectory();
    let store = new DurableOperationalStore({ directory });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }, { task_id: randomUUID() }],
    });
    const mutated = store.scheduler.get(graph.graph_id);
    if (!mutated) throw new Error("graph missing");
    mutated.revision = 2;
    mutated.mission_id = randomUUID();
    store.journal.append("scheduler_graph", mutated);
    store.close();
    expect(() => new DurableOperationalStore({ directory })).toThrow(/immutable scheduler graph/);

    const cleanDirectory = stateDirectory();
    store = new DurableOperationalStore({ directory: cleanDirectory });
    const clean = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }],
    });
    const claim = store.scheduler.claim()[0];
    if (!claim) throw new Error("claim missing");
    store.scheduler.complete(clean.graph_id, claim.node_id, true);
    const regressed = store.scheduler.get(clean.graph_id);
    if (!regressed) throw new Error("graph missing");
    regressed.revision += 1;
    regressed.nodes[0] = { ...regressed.nodes[0], state: "pending" };
    store.journal.append("scheduler_graph", regressed);
    store.close();
    expect(() => new DurableOperationalStore({ directory: cleanDirectory })).toThrow(
      /illegal DAG scheduler state transition/,
    );
  });

  it("rejects a replay that auto-resumes a graph that did not opt in", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }],
      auto_resume: false,
    });
    expect(store.scheduler.claim()).toHaveLength(1);
    const replayed = store.scheduler.get(graph.graph_id);
    if (!replayed) throw new Error("graph missing");
    replayed.revision += 1;
    replayed.nodes[0] = { ...replayed.nodes[0], state: "pending" };
    store.journal.append("scheduler_graph", replayed);
    store.close();
    expect(() => new DurableOperationalStore({ directory })).toThrow(
      /illegal DAG scheduler state transition/,
    );
  });

  it("refuses mid-run recovery so a live claim cannot be duplicated", () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }],
    });
    const claim = store.scheduler.claim()[0];
    expect(claim).toBeDefined();
    expect(() => store.scheduler.recover()).toThrow(/startup-only/);
    expect(store.scheduler.get(graph.graph_id)?.nodes[0]?.state).toBe("running");
    store.scheduler.complete(graph.graph_id, claim?.node_id ?? "", true);
    store.close();
  });

  it("does not turn a truncated completion record into a completed node", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }],
    });
    const claim = store.scheduler.claim()[0];
    if (!claim) throw new Error("claim missing");
    store.scheduler.complete(graph.graph_id, claim.node_id, true);
    store.close();

    const journalPath = join(directory, "operational.jsonl");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    writeFileSync(journalPath, `${lines.slice(0, -1).join("\n")}\n`, { mode: 0o600 });

    const recovered = new DurableOperationalStore({ directory });
    expect(recovered.scheduler.get(graph.graph_id)?.nodes[0]?.state).toBe("running");
    recovered.scheduler.recover();
    expect(recovered.scheduler.get(graph.graph_id)?.nodes[0]?.state).toBe("interrupted");
    expect(() =>
      recovered.scheduler.complete(
        graph.graph_id,
        recovered.scheduler.get(graph.graph_id)?.nodes[0]?.node_id ?? "",
        true,
      ),
    ).toThrow(/Only a running/);
    recovered.close();
  });

  it("topologically orders nodes and enforces dependency readiness", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const [first, second, third] = tasks(3);
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [
        { task_id: third as string, depends_on: [second as string] },
        { task_id: first as string },
        { task_id: second as string, depends_on: [first as string] },
      ],
    });
    expect(graph.nodes.map((node) => node.task_id)).toEqual([first, second, third]);

    const firstClaim = store.scheduler.claim();
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.task_id).toBe(first);
    expect(store.scheduler.claim()).toEqual([]);
    store.scheduler.complete(graph.graph_id, firstClaim[0]?.node_id ?? "", true);
    const secondClaim = store.scheduler.claim();
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0]?.task_id).toBe(second);
    store.close();
  });

  it("requires the full independent human approval quorum before a gated node can run", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const [gated] = tasks(1);
    const graph = store.scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: gated as string, approval_quorum: 2 }],
    });
    expect(store.scheduler.claim()).toEqual([]);
    store.scheduler.approve(graph.graph_id, graph.nodes[0]?.node_id ?? "", "human:one");
    expect(store.scheduler.claim()).toEqual([]);
    expect(() =>
      store.scheduler.approve(graph.graph_id, graph.nodes[0]?.node_id ?? "", "human:one"),
    ).toThrow(/cannot satisfy more than one/);
    store.scheduler.approve(graph.graph_id, graph.nodes[0]?.node_id ?? "", "human:two");
    const claims = store.scheduler.claim();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.task_id).toBe(gated);
    store.close();
  });

  it("bounds per-graph and host-wide parallelism and serves missions fairly", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const missionA = randomUUID();
    const missionB = randomUUID();
    const aTasks = tasks(3);
    const bTasks = tasks(2);
    const graphA = store.scheduler.create({
      mission_id: missionA,
      nodes: aTasks.map((task_id) => ({ task_id })),
      max_parallelism: 2,
    });
    const graphB = store.scheduler.create({
      mission_id: missionB,
      nodes: bTasks.map((task_id) => ({ task_id })),
      max_parallelism: 1,
    });
    // The operational scheduler has a host ceiling above both graph limits. Two graphs
    // with independent work must both be represented before either gets a second slot.
    const claims = store.scheduler.claim(new Date(), 4);
    expect(claims).toHaveLength(3);
    expect(claims.filter((claim) => claim.graph_id === graphA.graph_id)).toHaveLength(2);
    expect(claims.filter((claim) => claim.graph_id === graphB.graph_id)).toHaveLength(1);
    expect(store.scheduler.claim()).toEqual([]);
    store.close();
  });

  it("restarts with records intact, makes recovery opt-in, and carries graphs through compaction", () => {
    const directory = stateDirectory();
    const mission = randomUUID();
    const [autoTask] = tasks(1);
    let store = new DurableOperationalStore({ directory });
    const manual = store.scheduler.create({
      mission_id: mission,
      nodes: [{ task_id: autoTask as string }],
      auto_resume: false,
    });
    const manualClaim = store.scheduler.claim()[0];
    const autoGraph = store.scheduler.create({
      mission_id: mission,
      nodes: [{ task_id: randomUUID() }],
      auto_resume: true,
    });
    const autoClaim = store.scheduler.claim()[0];
    expect(manualClaim).toBeDefined();
    expect(autoClaim).toBeDefined();
    store.close();

    store = new DurableOperationalStore({ directory });
    expect(store.scheduler.get(manual.graph_id)?.revision).toBe(2);
    expect(store.scheduler.recover()).toHaveLength(2);
    expect(store.scheduler.get(manual.graph_id)?.nodes[0]?.state).toBe("interrupted");
    expect(store.scheduler.get(autoGraph.graph_id)?.nodes[0]?.state).toBe("pending");
    expect(() => store.scheduler.resume(autoGraph.graph_id)).toThrow(/no interrupted/);
    // Interrupted is not completed: a late completion call cannot silently close it.
    expect(() =>
      store.scheduler.complete(
        manual.graph_id,
        store.scheduler.get(manual.graph_id)?.nodes[0]?.node_id ?? "",
        true,
      ),
    ).toThrow(/Only a running/);
    store.scheduler.resume(manual.graph_id);
    expect(store.scheduler.get(manual.graph_id)?.nodes[0]?.state).toBe("pending");

    const archive = join(directory, "scheduler-archive.json");
    store.compact(archive);
    store.close();
    store = new DurableOperationalStore({ directory });
    expect(store.scheduler.get(manual.graph_id)?.nodes[0]?.state).toBe("pending");
    expect(store.scheduler.get(autoGraph.graph_id)?.auto_resume).toBe(true);
    store.close();
  });

  it("enforces a host-wide ceiling when only one claim slot is available", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    const scheduler = new DurableDagScheduler(store.journal, 1);
    const graph = scheduler.create({
      mission_id: randomUUID(),
      nodes: [{ task_id: randomUUID() }, { task_id: randomUUID() }],
    });
    expect(scheduler.claim()).toHaveLength(1);
    expect(scheduler.claim()).toEqual([]);
    const claim = scheduler.get(graph.graph_id)?.nodes.find((node) => node.state === "running");
    expect(claim).toBeDefined();
    scheduler.complete(graph.graph_id, claim?.node_id ?? "", true);
    expect(scheduler.claim()).toHaveLength(1);
    store.close();
  });
});
