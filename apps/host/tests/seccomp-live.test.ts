import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import { SandboxSyscallDeniedError } from '../src/errors.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { createSandboxProvider, type SandboxProvider } from '../src/execution/sandbox.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { AGENT_ID, makeTask } from './fixtures.js';
import { makeExecutionConfig } from './sandbox-fixture.js';

const bwrapDirectory = process.env.AIOS_BWRAP_DIR;
const enabled = typeof bwrapDirectory === 'string' && bwrapDirectory.length > 0;
const originalPath = process.env.PATH;

function task(argv: string[]): TaskEntity {
  return makeTask({
    execution: { kind: 'local_command', argv, timeout_ms: 15_000 },
    verification: { kind: 'local_command', argv: ['/bin/true'] },
  });
}

function processesMatching(marker: string): number[] {
  const matches: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join('/proc', entry, 'cmdline'), 'utf8').includes(marker)) matches.push(Number(entry));
    } catch {
      // Process exited during the scan.
    }
  }
  return matches;
}

describe.skipIf(!enabled || process.platform !== 'linux')('live seccomp filter', () => {
  let provider: SandboxProvider;

  beforeAll(() => {
    process.env.PATH = `${bwrapDirectory}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    provider = createSandboxProvider({ provider: 'bubblewrap' });
  });

  it('applies the filter to an ordinary run and exposes Seccomp mode 2', async () => {
    const result = await provider.run({
      argv: ['/bin/sh', '-c', 'grep ^Seccomp /proc/self/status'],
      workspaceDirectory: makeExecutionConfig().workspace_directory,
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString('utf8')).toMatch(/^Seccomp:\s*2$/m);
    expect(result.filter?.applied).toBe(true);
    expect(result.filter?.profile).toBe('aios-seccomp-deny-v1-x64');
    expect(result.filter?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('denies a forbidden unshare syscall with SIGSYS and no child survives', async () => {
    const marker = `aios-seccomp-live-${Date.now()}`;
    const result = await provider.run({
      argv: [
        '/bin/sh',
        '-c',
        `sleep 120 & echo partial > /workspace/partial; exec /usr/bin/unshare -U true # ${marker}`,
      ],
      workspaceDirectory: makeExecutionConfig().workspace_directory,
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      env: {},
    });

    expect(result.filter?.applied).toBe(true);
    expect(result.exitCode).toBe(128 + 31);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processesMatching(marker)).toEqual([]);
  });

  it('records the denial through the executor, discards the workspace, and leaves the next run unfiltered by state', async () => {
    const marker = `aios-seccomp-executor-${Date.now()}`;
    const config = makeExecutionConfig(undefined, { provider: 'bubblewrap', image: undefined });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, provider, workspaces);

    const denied = task([
      '/bin/sh',
      '-c',
      `sleep 120 & echo partial > /workspace/partial; exec /usr/bin/unshare -U true # ${marker}`,
    ]);
    await expect(executor.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxSyscallDeniedError);
    expect(readdirSync(config.workspace_directory)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processesMatching(marker)).toEqual([]);

    const next = task(['/bin/sh', '-c', 'echo ok > /workspace/ok; grep ^Seccomp /proc/self/status']);
    const result = await executor.executeTask(AGENT_ID, next);
    expect(result.evidence).toContain('exit_code:0');
    expect(result.evidence.some((line) => line === 'syscall_filter_applied:true')).toBe(true);
    expect(readdirSync(config.workspace_directory)).toHaveLength(1);
  });
});
