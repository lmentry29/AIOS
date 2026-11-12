#!/usr/bin/env node
/**
 * Recorded drill for the per-run workspace disk ceiling.
 *
 * Run only after `pnpm --filter @aios/host build`, with a real bubblewrap binary:
 *   AIOS_BWRAP_DIR=/path/to/bwrap-dir node tools/security/workspace-quota-drill.mjs
 *
 * The ceiling is sampled host-side while the sandbox is live because this environment has
 * no unprivileged hard filesystem quota. This drill demonstrates abort, discard, no leaked
 * children, an unaffected under-cap run, and per-run isolation; it does not prove a hard
 * kernel quota.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceQuotaExceededError } from "../../apps/host/dist/errors.js";
import { LocalCommandExecutor } from "../../apps/host/dist/execution/command-executor.js";
import { createSandboxProvider } from "../../apps/host/dist/execution/sandbox.js";
import {
  RunWorkspaceManager,
  measureWorkspaceBytes,
} from "../../apps/host/dist/execution/workspace.js";

const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
assert.ok(bwrapDirectory, "AIOS_BWRAP_DIR must point at a directory containing bwrap");
process.env.PATH = `${bwrapDirectory}:${process.env.PATH ?? ""}`;

const CAP_BYTES = 1024 * 1024;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER_ID = "22222222-2222-4222-8222-222222222222";
const root = mkdtempSync(join(tmpdir(), "aios-quota-drill-"));
const config = {
  workspace_directory: root,
  agent_id: AGENT_ID,
  verifier_id: VERIFIER_ID,
  provider: "bubblewrap",
  default_timeout_ms: 15_000,
  max_output_bytes: 65_536,
  workspace_max_bytes: CAP_BYTES,
  max_concurrent_tasks: 1,
};
const provider = createSandboxProvider({ provider: "bubblewrap" });
const workspaces = new RunWorkspaceManager(root);
const executor = new LocalCommandExecutor(config, provider, workspaces);

function task(id, script) {
  return {
    entity_id: id,
    actions: [],
    execution: { kind: "local_command", argv: ["/bin/sh", "-c", script], timeout_ms: 15_000 },
  };
}

function processesMatching(marker) {
  const matches = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join("/proc", entry, "cmdline"), "utf8").includes(marker))
        matches.push(Number(entry));
    } catch {
      // Process exited during the scan.
    }
  }
  return matches;
}

const marker = `aios-quota-drill-${Date.now()}`;
let overCap;
try {
  await executor.executeTask(
    AGENT_ID,
    task(
      "00000000-0000-4000-8000-000000000001",
      `while :; do dd if=/dev/zero of=/workspace/growing.bin bs=256K count=1 oflag=append conv=notrunc 2>/dev/null || exit 1; done # ${marker}`,
    ),
  );
  assert.fail("over-cap run unexpectedly succeeded");
} catch (error) {
  assert.ok(
    error instanceof WorkspaceQuotaExceededError,
    `expected quota error, got ${error?.name}: ${error?.message}`,
  );
  overCap = { error: error.name, message: error.message };
}
await new Promise((resolve) => setTimeout(resolve, 100));
overCap.workspace_entries = readdirSync(root).length;
overCap.matching_processes = processesMatching(marker).length;
assert.equal(overCap.workspace_entries, 0, "over-cap workspace was not discarded");
assert.equal(overCap.matching_processes, 0, "over-cap run leaked a child process");

const underCap = await executor.executeTask(
  AGENT_ID,
  task(
    "00000000-0000-4000-8000-000000000002",
    "dd if=/dev/zero of=/workspace/small.bin bs=1024 count=64 2>/dev/null",
  ),
);
const firstDirectories = readdirSync(root);
assert.equal(firstDirectories.length, 1, "under-cap run did not retain exactly its own workspace");
const firstBytes = measureWorkspaceBytes(join(root, firstDirectories[0]));
assert.ok(firstBytes <= 64 * 1024, `under-cap workspace used ${firstBytes} bytes`);

const sequential = await executor.executeTask(
  AGENT_ID,
  task(
    "00000000-0000-4000-8000-000000000003",
    "dd if=/dev/zero of=/workspace/other.bin bs=1024 count=32 2>/dev/null",
  ),
);
const directories = readdirSync(root);
assert.equal(directories.length, 2, "sequential run did not get an independent workspace");
for (const directory of directories) {
  assert.ok(
    measureWorkspaceBytes(join(root, directory)) <= 64 * 1024,
    "per-run workspace exceeded the cap",
  );
}

process.stdout.write(
  `${JSON.stringify({
    drill: "workspace-quota",
    cap_bytes: CAP_BYTES,
    over_cap: {
      error: overCap.error,
      message: overCap.message,
      workspace_entries: overCap.workspace_entries,
      matching_processes: overCap.matching_processes,
    },
    under_cap: {
      provider: underCap.evidence
        .find((line) => line.startsWith("provider:"))
        ?.slice("provider:".length),
      exit_code: underCap.evidence
        .find((line) => line.startsWith("exit_code:"))
        ?.slice("exit_code:".length),
      workspace_entries: firstDirectories.length,
      workspace_bytes: firstBytes,
    },
    sequential: {
      provider: sequential.evidence
        .find((line) => line.startsWith("provider:"))
        ?.slice("provider:".length),
      workspace_entries: directories.length,
      workspace_bytes: directories.map((directory) => measureWorkspaceBytes(join(root, directory))),
    },
  })}\n`,
);
