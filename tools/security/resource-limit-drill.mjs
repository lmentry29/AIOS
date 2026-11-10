#!/usr/bin/env node
/**
 * Recorded drill for the bubblewrap per-run resource limits.
 *
 * Build first, then run with a real bwrap:
 *   AIOS_BWRAP_DIR=/path/to/bwrap-dir node tools/security/resource-limit-drill.mjs
 *
 * This exercises the production provider path: prlimit installs RLIMIT_AS, RLIMIT_CPU and
 * RLIMIT_NPROC inside the user/PID namespace, the wrapper proves the exact kernel limits and
 * Seccomp mode before exec, and a memory bomb is stopped by RLIMIT_AS rather than the run
 * timeout. It does not claim cgroup aggregate accounting.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCommandExecutor } from '../../apps/host/dist/execution/command-executor.js';
import { createSandboxProvider } from '../../apps/host/dist/execution/sandbox.js';
import { RunWorkspaceManager } from '../../apps/host/dist/execution/workspace.js';

const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
assert.ok(bwrapDirectory, 'AIOS_BWRAP_DIR must point at a directory containing bwrap');
process.env.PATH = `${bwrapDirectory}:${process.env.PATH ?? ''}`;

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const VERIFIER_ID = '22222222-2222-4222-8222-222222222222';
const root = mkdtempSync(join(tmpdir(), 'aios-resource-drill-'));
const config = {
  workspace_directory: root,
  agent_id: AGENT_ID,
  verifier_id: VERIFIER_ID,
  provider: 'bubblewrap',
  default_timeout_ms: 15_000,
  max_output_bytes: 65_536,
  workspace_max_bytes: 1024 * 1024,
  max_concurrent_tasks: 1,
};
const provider = createSandboxProvider({ provider: 'bubblewrap' });
const workspaces = new RunWorkspaceManager(root);
const executor = new LocalCommandExecutor(config, provider, workspaces);

function task(id, argv) {
  return {
    entity_id: id,
    actions: [],
    execution: { kind: 'local_command', argv, timeout_ms: 15_000 },
  };
}

function memAvailableKb() {
  return Number.parseInt(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? '0', 10);
}

const beforeKb = memAvailableKb();
const probe = await provider.run({
  argv: ['/bin/sh', '-c', 'printf "v=%s t=%s\\n" "$(ulimit -v)" "$(ulimit -t)"; grep "^Max processes" /proc/self/limits; grep ^Seccomp /proc/self/status'],
  workspaceDirectory: mkdtempSync(join(tmpdir(), 'aios-resource-probe-')),
  timeoutMs: 5_000,
  maxOutputBytes: 4096,
  env: {},
});
assert.equal(probe.exitCode, 0, 'resource-limit probe exited nonzero');
assert.equal(probe.filter?.applied, true, 'provider did not report filter evidence');
assert.equal(probe.limits?.applied, true, 'provider did not report resource-limit evidence');
const output = probe.stdout.toString('utf8');
assert.match(output, /v=1310720 t=5/);
assert.match(output, /^Max processes\s+128\s+128\s+processes/m);
assert.match(output, /^Seccomp:\s*2$/m);

const legitimate = await executor.executeTask(
  AGENT_ID,
  task('00000000-0000-4000-8000-000000000021', ['perl', '-e', 'print qq(ok\\n)']),
);
assert.ok(legitimate.evidence.includes('syscall_filter_applied:true'));
assert.ok(legitimate.evidence.includes('resource_limits_applied:true'));
assert.ok(legitimate.evidence.includes('resource_limit_memory_bytes:1342177280'));
assert.ok(legitimate.evidence.includes('resource_limit_cpu_seconds:15'));
assert.ok(legitimate.evidence.includes('resource_limit_processes:128'));

const denied = await provider.run({
  argv: ['perl', '-e', 'my @a; my $x = q(x) x (64*1024*1024); while (1) { push @a, $x }'],
  workspaceDirectory: mkdtempSync(join(tmpdir(), 'aios-resource-bomb-')),
  timeoutMs: 15_000,
  maxOutputBytes: 4096,
  env: {},
});
assert.equal(denied.limits?.applied, true, 'memory bomb did not run with resource-limit evidence');
assert.notEqual(denied.exitCode, 0, 'memory bomb unexpectedly succeeded');
assert.equal(denied.timedOut, false, 'memory bomb was stopped by the deadline, not RLIMIT_AS');
assert.match(denied.stderr.toString('utf8'), /Out of memory/i, 'memory bomb did not report allocation failure');
const afterKb = memAvailableKb();

process.stdout.write(`${JSON.stringify({
  drill: 'bubblewrap-resource-limits',
  kernel: readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
  provider: provider.id,
  limits: probe.limits,
  limits_report: output.trim().split('\n'),
  filter: {
    profile: probe.filter?.profile,
    sha256: probe.filter?.sha256,
    applied: probe.filter?.applied,
    seccomp_mode: output.match(/^Seccomp:\s*(\d+)$/m)?.[1],
  },
  legitimate: {
    exit_code: legitimate.evidence.find((line) => line.startsWith('exit_code:'))?.slice('exit_code:'.length),
    resource_limits_applied: legitimate.evidence.find((line) => line.startsWith('resource_limits_applied:'))?.slice('resource_limits_applied:'.length),
  },
  memory_bomb: {
    exit_code: denied.exitCode,
    timed_out: denied.timedOut,
    stderr: denied.stderr.toString('utf8').trim(),
  },
  host_mem_available_kb: { before: beforeKb, after: afterKb },
})}\n`);
