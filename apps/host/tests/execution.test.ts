import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import { TaskCancelledError } from '@aios/orchestration';
import { HostExecutionError, HostUnavailableError } from '../src/errors.js';
import { runCapturedProcess } from '../src/execution/process.js';
import { createSandboxProvider, type SandboxProvider, type SandboxResult, type SandboxRunSpec } from '../src/execution/sandbox.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { AGENT_ID, VERIFIER_ID, makeTask } from './fixtures.js';
import { StubSandbox, makeExecutionConfig as executionConfig } from './sandbox-fixture.js';

/**
 * Test-only process provider. It deliberately has no isolation boundary and is labelled
 * `test-only-process`; it exists to verify that cancellation SIGKILLs the real child the
 * production helper manages. It must never be selected by the host CLI.
 */
class TestProcessSandbox implements SandboxProvider {
  readonly id = 'test-only-process';
  readonly assurance = 'test-only-process' as const;

  async check(): Promise<{ available: boolean; reason: string }> {
    return { available: true, reason: 'test-only process helper' };
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    const [command, ...args] = spec.argv;
    if (!command) throw new Error('test process argv is empty');
    const result = await runCapturedProcess(command, args, {
      cwd: spec.workspaceDirectory,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...spec.env },
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    });
    return { ...result, provider: this.id, assurance: this.assurance };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function executableTask(overrides: Record<string, unknown> = {}): TaskEntity {
  return makeTask({
    execution: { kind: 'local_command', argv: ['/bin/echo', 'hello'] },
    verification: { kind: 'local_command', argv: ['/bin/true'] },
    ...overrides,
  });
}

describe('local command execution', () => {
  it('runs argv without a shell, passes only allowed environment values, and records hashes', async () => {
    const sandbox = new StubSandbox();
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);
    const task = executableTask({
      execution: {
        kind: 'local_command',
        argv: ['/bin/echo', 'hello'],
        env: { LANG: 'C', AWS_SECRET_ACCESS_KEY: 'must-not-cross', PATH: '/evil' },
        timeout_ms: 1_000,
      },
    });

    const result = await executor.executeTask(AGENT_ID, task);
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.argv).toEqual(['/bin/echo', 'hello']);
    expect(sandbox.calls[0]?.env).toEqual({ LANG: 'C' });
    expect(sandbox.calls[0]?.timeoutMs).toBe(1_000);
    expect(result.summary).toContain('stub-container');
    expect(result.evidence).toContain('exit_code:0');
    expect(result.evidence.join('\n')).not.toContain('must-not-cross');
    expect(result.evidence).not.toContain('ok\n');
    expect(result.evidence.some((line) => line.startsWith('stdout_sha256:'))).toBe(true);
  });

  it('fails closed for a non-zero exit, a timeout, and an unavailable provider', async () => {
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const sandbox = new StubSandbox();
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);

    sandbox.result = { exitCode: 3 };
    await expect(executor.executeTask(AGENT_ID, executableTask())).rejects.toBeInstanceOf(HostExecutionError);

    sandbox.result = { exitCode: null, timedOut: true };
    await expect(executor.executeTask(AGENT_ID, executableTask())).rejects.toThrow(/time limit/);

    const unavailable = new StubSandbox();
    unavailable.checkResult = { available: false, reason: 'no boundary' };
    const unavailableExecutor = new LocalCommandExecutor(config, unavailable, workspaces);
    await expect(unavailableExecutor.validateAgent(AGENT_ID)).rejects.toBeInstanceOf(HostUnavailableError);
    expect((await executor.validateAgent('11111111-1111-4111-8111-111111111112'))).toBe(false);
  });

  it('SIGKILLs the real sandbox child when cancellation is requested', async () => {
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, new TestProcessSandbox(), workspaces);
    const pidFile = join(config.workspace_directory, 'cancel-child.pid');
    const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)";
    const task = executableTask({
      execution: {
        kind: 'local_command',
        argv: [process.execPath, '-e', script, pidFile],
        timeout_ms: 20_000,
      },
    });

    const running = executor.executeTask(AGENT_ID, task);
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(processAlive(pid)).toBe(true);

    expect(executor.cancelTask(task.entity_id)).toBe(true);
    await expect(running).rejects.toBeInstanceOf(TaskCancelledError);
    for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(processAlive(pid)).toBe(false);
  });

  it('rejects an absolute or escaping cwd and requires an execution intent', async () => {
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const sandbox = new StubSandbox();
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);

    await expect(executor.executeTask(AGENT_ID, executableTask({
      execution: { kind: 'local_command', argv: ['/bin/true'], cwd: '/etc' },
    }))).rejects.toBeInstanceOf(HostExecutionError);
    await expect(executor.executeTask(AGENT_ID, executableTask({
      execution: { kind: 'local_command', argv: ['/bin/true'], cwd: '../escape' },
    }))).rejects.toBeInstanceOf(HostExecutionError);
    await expect(executor.executeTask(AGENT_ID, makeTask())).rejects.toThrow(/no local_command/);
    await expect(executor.executeTask(AGENT_ID, executableTask({
      actions: [
        { action_id: '11111111-1111-4111-8111-111111111113', status: 'pending', executed_by: AGENT_ID },
        { action_id: '11111111-1111-4111-8111-111111111114', status: 'pending', executed_by: AGENT_ID },
      ],
    }))).rejects.toThrow(/at most one/);
    expect(sandbox.calls).toHaveLength(0);
  });
});

describe('docker provider command construction', () => {
  it('passes the isolation flags without a shell and keeps argv elements intact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-fake-docker-'));
    const argsFile = join(directory, 'args.txt');
    const docker = join(directory, 'docker');
    writeFileSync(docker, `#!/bin/sh
if [ "$1" = "info" ]; then echo 'test-daemon'; exit 0; fi
if [ "$1" = "image" ]; then echo 'sha256:test'; exit 0; fi
if [ "$1" = "run" ]; then printf '%s\\n' "$@" > '${argsFile}'; exit 0; fi
exit 1
`);
    chmodSync(docker, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ''}`;
    try {
      const provider = createSandboxProvider({ provider: 'docker', image: 'aios-test:local' });
      await expect(provider.check()).resolves.toMatchObject({ available: true });
      const workspace = mkdtempSync(join(directory, 'workspace-'));
      const result = await provider.run({
        argv: ['/bin/echo', 'hello world'],
        workspaceDirectory: workspace,
        cwd: '.',
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
        env: { LANG: 'C' },
      });
      expect(result.exitCode).toBe(0);
      const args = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(args).toContain('--network=none');
      expect(args).toContain('--read-only');
      expect(args).toContain('--cap-drop=ALL');
      expect(args).toContain('--security-opt=no-new-privileges');
      expect(args).toContain('--pids-limit=128');
      expect(args).toContain('--memory=512m');
      expect(args).toContain('--cpus=1');
      expect(args).toContain('aios-test:local');
      expect(args.slice(-2)).toEqual(['/bin/echo', 'hello world']);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('independent command verification', () => {
  it('runs its own command in the executor workspace and binds the executor result by hash', async () => {
    const sandbox = new StubSandbox();
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces);
    const task = executableTask();
    const result = await executor.executeTask(AGENT_ID, task);

    const decision = await verifier.verify({
      task,
      agent_ids: [AGENT_ID],
      execution_result: result,
    });

    expect(decision.accepted).toBe(true);
    expect(sandbox.calls).toHaveLength(2);
    expect(sandbox.calls[1]?.argv).toEqual(['/bin/true']);
    expect(sandbox.calls[1]?.workspaceDirectory).toBe(sandbox.calls[0]?.workspaceDirectory);
    expect(decision.evidence).toContain(`verifier:${VERIFIER_ID}`);
    expect(decision.evidence.some((line) => line.startsWith('executor_result_sha256:'))).toBe(true);
  });

  it('rejects an unexpected exit status and refuses to verify its own execution', async () => {
    const sandbox = new StubSandbox();
    const config = executionConfig();
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const verifier = new LocalCommandVerifier(config, sandbox, workspaces);
    const task = executableTask();

    sandbox.result = { exitCode: 9 };
    const rejected = await verifier.verify({
      task,
      agent_ids: [AGENT_ID],
      execution_result: { summary: 'self report', evidence: ['executor says yes'] },
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain('instead of 0');

    await expect(verifier.verify({
      task,
      agent_ids: [VERIFIER_ID],
      execution_result: { summary: 'self report', evidence: ['executor says yes'] },
    })).rejects.toThrow(/independent/);
  });
});
