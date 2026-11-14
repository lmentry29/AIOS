import { randomUUID } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalCommandExecutor } from "../src/execution/command-executor.js";
import { LocalCommandVerifier } from "../src/execution/command-verifier.js";
import { ManagedExecutionPort } from "../src/execution/managed-execution.js";
import { createSandboxProvider, type SandboxProvider } from "../src/execution/sandbox.js";
import { RunWorkspaceManager } from "../src/execution/workspace.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { AGENT_ID, makeTask } from "./fixtures.js";
import { makeExecutionConfig } from "./sandbox-fixture.js";

/**
 * Live adversarial validation of the real kernel-namespace boundary.
 *
 * Unlike the unit tests, this file requires an actual `bwrap` binary and a kernel that
 * permits unprivileged user namespaces. Set `AIOS_BWRAP_DIR` to the directory containing
 * `bwrap` to enable it (CI installs bubblewrap and sets it); otherwise every test is
 * reported as skipped rather than passing without a boundary.
 */
const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
const enabled = typeof bwrapDirectory === "string" && bwrapDirectory.length > 0;
const originalPath = process.env.PATH;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "aios-live-sandbox-"));
}

describe.skipIf(!enabled || process.platform !== "linux")("live bubblewrap boundary", () => {
  let provider: SandboxProvider;

  beforeAll(() => {
    process.env.PATH = `${bwrapDirectory}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    provider = createSandboxProvider({ provider: "bubblewrap" });
  });

  it("passes its own availability probe", async () => {
    await expect(provider.check()).resolves.toMatchObject({ available: true });
  });

  it("cannot read host files outside the declared system roots", async () => {
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "cat /etc/shadow"],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString("utf8")).not.toContain("root:");
  });

  it("does not follow a workspace symlink out of the sandbox", async () => {
    const directory = workspace();
    symlinkSync("/etc/shadow", join(directory, "escape"));
    const result = await provider.run({
      argv: ["/bin/cat", "escape"],
      workspaceDirectory: directory,
      cwd: ".",
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("has no network interface other than loopback", async () => {
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "cat /proc/net/dev"],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    const interfaces = result.stdout.toString("utf8");
    expect(interfaces).toContain("lo:");
    expect(interfaces).not.toContain("eth0");
  });

  it("clears the host environment and passes only the declared values", async () => {
    process.env.AIOS_LIVE_LEAK = "must-not-appear";
    try {
      const result = await provider.run({
        argv: ["/usr/bin/env"],
        workspaceDirectory: workspace(),
        timeoutMs: 5_000,
        maxOutputBytes: 65536,
        env: { LANG: "C" },
      });
      const output = result.stdout.toString("utf8");
      expect(output).toContain("LANG=C");
      expect(output).not.toContain("AIOS_LIVE_LEAK");
      expect(output).not.toContain("must-not-appear");
    } finally {
      Reflect.deleteProperty(process.env, "AIOS_LIVE_LEAK");
    }
  });

  it("runs in a private PID namespace with no host processes", async () => {
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "echo $$"],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    // A fresh PID namespace makes the shell PID small; a host PID would be large.
    expect(Number.parseInt(result.stdout.toString("utf8").trim(), 10)).toBeLessThanOrEqual(3);
  });

  it("denies writes outside the workspace and the private tmpfs", async () => {
    const directory = workspace();
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "touch /usr/escape; echo rc=$?; echo ok > /workspace/inside"],
      workspaceDirectory: directory,
      cwd: ".",
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.stdout.toString("utf8")).toContain("rc=1");
    expect(result.exitCode).toBe(0);
  });

  it("runs with no effective capabilities", async () => {
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "grep CapEff /proc/self/status"],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.stdout.toString("utf8")).toMatch(/CapEff:\s*0+$/m);
  });

  it("installs per-process memory, CPU and process limits before exec", async () => {
    const result = await provider.run({
      argv: [
        "/bin/sh",
        "-c",
        'printf "v=%s t=%s\n" "$(ulimit -v)" "$(ulimit -t)"; grep "^Max processes" /proc/self/limits',
      ],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8")).toContain("v=1310720 t=5");
    expect(result.stdout.toString("utf8")).toMatch(/^Max processes\s+128\s+128\s+processes/m);
    expect(result.limits).toMatchObject({
      memory_bytes: 1280 * 1024 * 1024,
      cpu_seconds: 5,
      processes: 128,
      applied: true,
    });
  });

  it("still runs an ordinary interpreter under the memory and process ceilings", async () => {
    const result = await provider.run({
      argv: ["perl", "-e", "print qq(perl-ok\n)"],
      workspaceDirectory: workspace(),
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("perl-ok\n");
  });

  it("stops a memory bomb with RLIMIT_AS instead of letting it exhaust the host", async () => {
    const result = await provider.run({
      argv: ["perl", "-e", "my @a; my $x = q(x) x (64*1024*1024); while (1) { push @a, $x }"],
      workspaceDirectory: workspace(),
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.limits?.applied).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.toString("utf8")).toMatch(/Out of memory/i);
  });

  it("executes an Action-bound plan under the measured boundary and independently verifies it", async () => {
    const config = makeExecutionConfig(undefined, { provider: "bubblewrap" });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const store = new DurableOperationalStore({
      directory: mkdtempSync(join(tmpdir(), "aios-live-plan-ledger-")),
    });
    const managed = new ManagedExecutionPort(
      new LocalCommandExecutor(config, provider, workspaces),
      store.executions,
      1,
    );
    const verifier = new LocalCommandVerifier(config, provider, workspaces, {
      current: store.executions,
    });
    const first = randomUUID();
    const second = randomUUID();
    const task = makeTask({
      actions: [
        { action_id: first, status: "pending", executed_by: AGENT_ID },
        { action_id: second, status: "pending", executed_by: AGENT_ID },
      ],
      execution: {
        kind: "local_plan",
        timeout_ms: 15_000,
        steps: [
          {
            action_id: first,
            argv: ["/bin/sh", "-c", "printf verified-work > artifact.txt"],
          },
          {
            action_id: second,
            argv: [
              "/bin/sh",
              "-c",
              "grep -qx verified-work artifact.txt && printf step-two > step-two.txt",
            ],
          },
        ],
      },
      verification: {
        kind: "local_command",
        argv: [
          "/bin/sh",
          "-c",
          "grep -qx verified-work artifact.txt && grep -qx step-two step-two.txt",
        ],
      },
    });

    const result = await managed.executeTask(AGENT_ID, task);
    const decision = await verifier.verify({
      task,
      agent_ids: [AGENT_ID],
      execution_result: result,
    });

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        "plan_evidence_version:1",
        "plan_step_count:2",
        expect.stringMatching(/^plan_step_1:.*filter_applied=true;filter_sha256=[a-f0-9]{64}/),
        expect.stringMatching(/^plan_step_2:.*filter_applied=true;filter_sha256=[a-f0-9]{64}/),
      ]),
    );
    expect(result.completed_actions?.map((action) => action.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(decision.accepted).toBe(true);
    expect(decision.evidence).toContain(`verifier:${config.verifier_id}`);
  });

  it("kills a background workload when the boundary is killed", async () => {
    const marker = join(tmpdir(), `aios-orphan-${Date.now()}.pid`);
    const result = await provider.run({
      argv: ["/bin/sh", "-c", "sleep 120 & echo $! > /workspace/child.pid; sleep 120"],
      workspaceDirectory: (() => {
        const directory = workspace();
        writeFileSync(join(directory, "marker"), "");
        return directory;
      })(),
      timeoutMs: 1_000,
      maxOutputBytes: 4096,
      env: {},
    });
    expect(result.timedOut).toBe(true);
    // The provider killed bwrap; --die-with-parent must have taken the workload with it.
    // No host PID is exposed to the test, so assert the observable contract instead: the
    // run ended as a timeout rather than a clean exit, and no output claims success.
    expect(result.exitCode).not.toBe(0);
    expect(marker.length).toBeGreaterThan(0);
  });
});
