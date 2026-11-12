import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskEntity } from "@aios/core";
import { ManagedExecutionPort } from "../src/execution/managed-execution.js";
import { LocalCommandExecutor } from "../src/execution/command-executor.js";
import { LocalCommandVerifier } from "../src/execution/command-verifier.js";
import { RunWorkspaceManager } from "../src/execution/workspace.js";
import { AppendOnlyJournal, JournalError } from "../src/persistence/journal.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { AGENT_ID, makeTask } from "./fixtures.js";
import { StubSandbox, makeExecutionConfig } from "./sandbox-fixture.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-journal-recovery-"));
}

function journalPath(directory: string): string {
  return join(directory, "operational.jsonl");
}

function archivePath(directory: string): string {
  return join(directory, "journal-archive.json");
}

describe("journal compaction and verified restore", () => {
  it("drives a bounded journal to its size limit, compacts it, and keeps writing", () => {
    const directory = stateDirectory();
    const filePath = join(directory, "probe.jsonl");
    const journal = new AppendOnlyJournal({ filePath, maxBytes: 4096 });
    let limitReached = false;
    for (let index = 0; index < 100; index += 1) {
      try {
        journal.append("probe", { index, note: "x".repeat(128) });
      } catch (error) {
        expect(error).toBeInstanceOf(JournalError);
        expect((error as Error).message).toMatch(/size limit/);
        limitReached = true;
        break;
      }
    }
    expect(limitReached).toBe(true);
    const before = journal.sizeBytes;

    const result = journal.compactWithSnapshot(
      "probe_snapshot",
      { resumed: true },
      archivePath(directory),
    );
    expect(result.bytes_after).toBeLessThan(before);
    expect(journal.sizeBytes).toBe(result.bytes_after);
    expect(result.record_count).toBeGreaterThan(0);

    journal.append("probe", { index: "after-compaction" });
    expect(journal.sizeBytes).toBeGreaterThan(result.bytes_after);
    journal.close();

    const reopened = new AppendOnlyJournal({ filePath, maxBytes: 4096 });
    try {
      const records = reopened.read();
      expect(records[0]?.kind).toBe("probe_snapshot");
      expect(records[0]?.payload).toMatchObject({
        resumed: true,
        compaction: {
          through_sequence: result.through_sequence,
          archive_sha256: result.archive_sha256,
        },
      });
      expect(records.at(-1)?.payload).toMatchObject({ index: "after-compaction" });
    } finally {
      reopened.close();
    }
  });

  it("detects a corrupted journal and recovers the archived state", () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    first.tasks.createTask(task);
    const exported = first.journal.exportArchive(archivePath(directory));
    expect(exported.record_count).toBeGreaterThan(0);
    first.close();

    const corrupted = Buffer.from(readFileSync(journalPath(directory)));
    const target = corrupted.indexOf(Buffer.from("Execute the trusted host slice"));
    expect(target).toBeGreaterThan(0);
    corrupted.write("Tampered task name", target, "utf8");
    writeFileSync(journalPath(directory), corrupted, { mode: 0o600 });

    expect(() => new DurableOperationalStore({ directory })).toThrow(JournalError);

    const restored = AppendOnlyJournal.restore({
      filePath: journalPath(directory),
      archivePath: archivePath(directory),
    });
    expect(restored.restored).toBe(true);
    expect(restored.unchanged).toBe(false);
    const backupPath = restored.backup_path;
    expect(backupPath).toBeDefined();
    if (backupPath === undefined) throw new Error("restore did not preserve a damaged journal");
    expect(readFileSync(backupPath, "utf8")).not.toBe(readFileSync(journalPath(directory), "utf8"));

    const reopened = new DurableOperationalStore({ directory });
    try {
      expect(reopened.tasks.getTask(task.entity_id)?.name).toBe(task.name);
    } finally {
      reopened.close();
    }
  });

  it("rejects a tampered archive without touching the target", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    store.tasks.createTask(makeTask());
    store.journal.exportArchive(archivePath(directory));
    store.close();

    const before = readFileSync(journalPath(directory));
    const parsed = JSON.parse(readFileSync(archivePath(directory), "utf8")) as {
      records: { payload: { entity: { name: string } } }[];
    };
    const firstRecord = parsed.records[0];
    if (firstRecord === undefined) throw new Error("archive has no records");
    firstRecord.payload.entity.name = "forged";
    writeFileSync(archivePath(directory), JSON.stringify(parsed), { mode: 0o600 });

    expect(() =>
      AppendOnlyJournal.restore({
        filePath: journalPath(directory),
        archivePath: archivePath(directory),
      }),
    ).toThrow(JournalError);
    expect(Buffer.compare(readFileSync(journalPath(directory)), before)).toBe(0);
  });

  it("is idempotent and refuses to overwrite a different valid journal", () => {
    const directory = stateDirectory();
    const store = new DurableOperationalStore({ directory });
    store.tasks.createTask(makeTask());
    store.journal.exportArchive(archivePath(directory));
    store.close();

    const first = AppendOnlyJournal.restore({
      filePath: journalPath(directory),
      archivePath: archivePath(directory),
    });
    expect(first).toMatchObject({ restored: false, unchanged: true });
    const identical = readFileSync(journalPath(directory));

    const second = AppendOnlyJournal.restore({
      filePath: journalPath(directory),
      archivePath: archivePath(directory),
    });
    expect(second).toMatchObject({ restored: false, unchanged: true });
    expect(Buffer.compare(readFileSync(journalPath(directory)), identical)).toBe(0);

    const otherDirectory = stateDirectory();
    const otherStore = new DurableOperationalStore({ directory: otherDirectory });
    otherStore.tasks.createTask(makeTask());
    otherStore.close();
    expect(() =>
      AppendOnlyJournal.restore({
        filePath: journalPath(otherDirectory),
        archivePath: archivePath(directory),
      }),
    ).toThrow(/different valid journal/);
  });

  it("compacts operational entities and preserves the execution attempt for verification", async () => {
    const directory = stateDirectory();
    const config = makeExecutionConfig();
    const sandbox = new StubSandbox();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const store = new DurableOperationalStore({ directory });
    const task: TaskEntity = makeTask({
      execution: { kind: "local_command", argv: ["/bin/echo", "ok"] },
      verification: { kind: "local_command", argv: ["/bin/true"] },
    });
    const managed = new ManagedExecutionPort(
      new LocalCommandExecutor(config, sandbox, workspaces),
      store.executions,
      1,
    );
    store.tasks.createTask(task);
    const result = await managed.executeTask(AGENT_ID, task);
    const compacted = store.compact(archivePath(directory));
    expect(compacted.bytes_after).toBeLessThan(compacted.bytes_before);
    store.close();

    const reopened = new DurableOperationalStore({ directory });
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
      current: reopened.executions,
    });
    try {
      expect(reopened.tasks.getTask(task.entity_id)).toBeDefined();
      expect(reopened.executions.getForTask(task.entity_id)?.state).toBe("completed");

      const accepted = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: result,
      });
      expect(accepted.accepted).toBe(true);
      expect(accepted.evidence.join("\n")).toContain("execution_id:");

      const forged = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: { ...result, summary: "forged after compaction" },
      });
      expect(forged.accepted).toBe(false);
      expect(forged.reason).toContain("does not match");
    } finally {
      reopened.close();
    }
  });
});
