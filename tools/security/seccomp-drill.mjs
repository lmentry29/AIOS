#!/usr/bin/env node
/**
 * Recorded drill for the bubblewrap seccomp boundary.
 *
 * Build first, then run with a real bwrap:
 *   AIOS_BWRAP_DIR=/path/to/bwrap-dir node tools/security/seccomp-drill.mjs
 *
 * This demonstrates the generated deny-list is installed by the real provider, a denied
 * syscall terminates the workload, the executor maps it to a distinct failure, the
 * workspace is discarded, no marked child survives, and a subsequent run succeeds.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxSyscallDeniedError } from "../../apps/host/dist/errors.js";
import { LocalCommandExecutor } from "../../apps/host/dist/execution/command-executor.js";
import { createSandboxProvider } from "../../apps/host/dist/execution/sandbox.js";
import { RunWorkspaceManager } from "../../apps/host/dist/execution/workspace.js";

const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
assert.ok(bwrapDirectory, "AIOS_BWRAP_DIR must point at a directory containing bwrap");
process.env.PATH = `${bwrapDirectory}:${process.env.PATH ?? ""}`;

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER_ID = "22222222-2222-4222-8222-222222222222";
const root = mkdtempSync(join(tmpdir(), "aios-seccomp-drill-"));
const config = {
  workspace_directory: root,
  agent_id: AGENT_ID,
  verifier_id: VERIFIER_ID,
  provider: "bubblewrap",
  default_timeout_ms: 15_000,
  max_output_bytes: 65_536,
  workspace_max_bytes: 1024 * 1024,
  max_concurrent_tasks: 1,
};
const provider = createSandboxProvider({ provider: "bubblewrap" });
const workspaces = new RunWorkspaceManager(root);
const executor = new LocalCommandExecutor(config, provider, workspaces);

function task(id, argv) {
  return {
    entity_id: id,
    actions: [],
    execution: { kind: "local_command", argv, timeout_ms: 15_000 },
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

const probe = await provider.run({
  argv: ["/bin/sh", "-c", "grep ^Seccomp /proc/self/status"],
  workspaceDirectory: mkdtempSync(join(tmpdir(), "aios-seccomp-probe-")),
  timeoutMs: 5_000,
  maxOutputBytes: 4096,
  env: {},
});
assert.equal(probe.exitCode, 0, "seccomp probe exited nonzero");
assert.match(
  probe.stdout.toString("utf8"),
  /^Seccomp:\s*2$/m,
  "sandbox did not report Seccomp mode 2",
);
assert.equal(probe.filter?.applied, true, "provider did not report filter evidence");

const marker = `aios-seccomp-drill-${Date.now()}`;
let denied;
try {
  await executor.executeTask(
    AGENT_ID,
    task("00000000-0000-4000-8000-000000000011", [
      "/bin/sh",
      "-c",
      `sleep 120 & echo partial > /workspace/partial; exec /usr/bin/unshare -U true # ${marker}`,
    ]),
  );
  assert.fail("forbidden syscall run unexpectedly succeeded");
} catch (error) {
  assert.ok(
    error instanceof SandboxSyscallDeniedError,
    `expected SandboxSyscallDeniedError, got ${error?.name}: ${error?.message}`,
  );
  denied = { error: error.name, message: error.message, filter_sha256: error.filterSha256 };
}
await new Promise((resolve) => setTimeout(resolve, 100));
denied.workspace_entries = readdirSync(root).length;
denied.matching_processes = processesMatching(marker).length;
assert.equal(denied.workspace_entries, 0, "denied workspace was not discarded");
assert.equal(denied.matching_processes, 0, "denied run leaked a child process");

const legitimate = await executor.executeTask(
  AGENT_ID,
  task("00000000-0000-4000-8000-000000000012", [
    "/bin/sh",
    "-c",
    "echo ok > /workspace/ok; grep ^Seccomp /proc/self/status",
  ]),
);
assert.equal(
  legitimate.evidence.find((line) => line.startsWith("exit_code:"))?.slice("exit_code:".length),
  "0",
);
assert.ok(legitimate.evidence.includes("syscall_filter_applied:true"));

const next = await executor.executeTask(
  AGENT_ID,
  task("00000000-0000-4000-8000-000000000013", ["/bin/sh", "-c", "echo next > /workspace/next"]),
);
assert.equal(
  next.evidence.find((line) => line.startsWith("exit_code:"))?.slice("exit_code:".length),
  "0",
);
assert.equal(readdirSync(root).length, 2, "per-run workspaces were not independent");

process.stdout.write(
  `${JSON.stringify({
    drill: "seccomp-filter",
    kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    provider: provider.id,
    filter: {
      profile: probe.filter?.profile,
      sha256: probe.filter?.sha256,
      applied: probe.filter?.applied,
      seccomp_mode: probe.stdout.toString("utf8").match(/^Seccomp:\s*(\d+)$/m)?.[1],
    },
    denied,
    legitimate: {
      provider: legitimate.evidence
        .find((line) => line.startsWith("provider:"))
        ?.slice("provider:".length),
      exit_code: legitimate.evidence
        .find((line) => line.startsWith("exit_code:"))
        ?.slice("exit_code:".length),
      filter_applied: legitimate.evidence
        .find((line) => line.startsWith("syscall_filter_applied:"))
        ?.slice("syscall_filter_applied:".length),
    },
    next: {
      exit_code: next.evidence
        .find((line) => line.startsWith("exit_code:"))
        ?.slice("exit_code:".length),
      workspace_entries: readdirSync(root).length,
    },
  })}\n`,
);
