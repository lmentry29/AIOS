import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import { HostExecutionError, HostUnavailableError } from '../src/errors.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { AGENT_ID, VERIFIER_ID, makeTask } from './fixtures.js';
import { StubSandbox, makeExecutionConfig as executionConfig } from './sandbox-fixture.js';

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
