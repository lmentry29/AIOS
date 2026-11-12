import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
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
    store.close();
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
