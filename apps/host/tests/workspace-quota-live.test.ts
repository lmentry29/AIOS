import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TaskEntity } from "@aios/core";
import { WorkspaceQuotaExceededError } from "../src/errors.js";
import { LocalCommandExecutor } from "../src/execution/command-executor.js";
import { createSandboxProvider, type SandboxProvider } from "../src/execution/sandbox.js";
import { RunWorkspaceManager, measureWorkspaceBytes } from "../src/execution/workspace.js";
import { AGENT_ID, makeTask } from "./fixtures.js";
import { makeExecutionConfig } from "./sandbox-fixture.js";

/**
 * Live drill for the per-run workspace ceiling. It requires a real bubblewrap binary and
 * unprivileged user namespaces; without `AIOS_BWRAP_DIR` it is skipped rather than passing
 * against a mock. The sampler is host-side because no unprivileged filesystem quota is
 * available, so this proves live abort and discard, not a hard kernel quota.
 */
const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
const enabled = typeof bwrapDirectory === "string" && bwrapDirectory.length > 0;
const originalPath = process.env.PATH;
const CAP_BYTES = 1024 * 1024;

function task(argv: string[]): TaskEntity {
  return makeTask({
    execution: { kind: "local_command", argv, timeout_ms: 15_000 },
    verification: { kind: "local_command", argv: ["/bin/true"] },
  });
}

function processesMatching(marker: string): number[] {
  const matches: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = readFileSync(join("/proc", entry, "cmdline"), "utf8");
      if (commandLine.includes(marker)) matches.push(Number(entry));
    } catch {
      // The process exited between listing and reading.
    }
  }
  return matches;
}

describe.skipIf(!enabled || process.platform !== "linux")("live workspace quota", () => {
  let provider: SandboxProvider;

  beforeAll(() => {
    process.env.PATH = `${bwrapDirectory}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    provider = createSandboxProvider({ provider: "bubblewrap" });
  });

  it("stops an over-cap live run, records the quota failure, and leaves no children or oversized workspace", async () => {
    const marker = `aios-quota-live-${Date.now()}`;
    const config = makeExecutionConfig(undefined, { workspace_max_bytes: CAP_BYTES });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, provider, workspaces);
    const overCap = task([
      "/bin/sh",
      "-c",
      `while :; do dd if=/dev/zero of=/workspace/growing.bin bs=256K count=1 oflag=append conv=notrunc 2>/dev/null || exit 1; done # ${marker}`,
    ]);

    await expect(executor.executeTask(AGENT_ID, overCap)).rejects.toBeInstanceOf(
      WorkspaceQuotaExceededError,
    );
    expect(readdirSync(config.workspace_directory)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processesMatching(marker)).toEqual([]);
  });

  it("completes an under-cap run and keeps the next per-run workspace independent", async () => {
    const config = makeExecutionConfig(undefined, { workspace_max_bytes: CAP_BYTES });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, provider, workspaces);

    const first = task([
      "/bin/sh",
      "-c",
      "dd if=/dev/zero of=/workspace/small.bin bs=1024 count=64 2>/dev/null",
    ]);
    const second = task([
      "/bin/sh",
      "-c",
      "dd if=/dev/zero of=/workspace/other.bin bs=1024 count=32 2>/dev/null",
    ]);
    await expect(executor.executeTask(AGENT_ID, first)).resolves.toMatchObject({
      evidence: expect.arrayContaining([expect.stringMatching(/^provider:bubblewrap$/)]),
    });
    await expect(executor.executeTask(AGENT_ID, second)).resolves.toMatchObject({
      evidence: expect.arrayContaining([expect.stringMatching(/^provider:bubblewrap$/)]),
    });

    const directories = readdirSync(config.workspace_directory);
    expect(directories).toHaveLength(2);
    for (const directory of directories) {
      expect(
        measureWorkspaceBytes(join(config.workspace_directory, directory)),
      ).toBeLessThanOrEqual(64 * 1024);
    }
  });
});
