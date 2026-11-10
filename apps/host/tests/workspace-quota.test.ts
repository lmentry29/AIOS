import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import type { AgentExecutionPort, TaskExecutionResult } from '@aios/orchestration';
import { WorkspaceQuotaExceededError } from '../src/errors.js';
import { ManagedExecutionPort } from '../src/execution/managed-execution.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import type { SandboxProvider, SandboxResult, SandboxRunSpec } from '../src/execution/sandbox.js';
import { RunWorkspaceManager, measureWorkspaceBytes } from '../src/execution/workspace.js';
import { DurableOperationalStore } from '../src/persistence/operational-store.js';
import { AGENT_ID, makeTask } from './fixtures.js';
import { makeExecutionConfig } from './sandbox-fixture.js';

/**
 * Test-only provider that writes a real file into the workspace and holds the invocation
 * briefly so the live sampler observes it. It has no isolation boundary; the real boundary
 * drill is in `workspace-quota-live.test.ts`.
 */
class FileWritingSandbox implements SandboxProvider {
  readonly id = 'test-only-process';
  readonly assurance = 'test-only-process' as const;
  calls: SandboxRunSpec[] = [];

  async check(): Promise<{ available: boolean; reason: string }> {
    return { available: true, reason: 'test-only workspace writer' };
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    this.calls.push(spec);
    const bytes = Number(spec.argv[1] ?? '0');
    writeFileSync(join(spec.workspaceDirectory, 'payload.bin'), Buffer.alloc(bytes));
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (spec.signal?.aborted) {
      return {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        cancelled: true,
        truncated: false,
        durationMs: 5,
        provider: this.id,
        assurance: this.assurance,
      };
    }
    return {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from('ok\n'),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 5,
      provider: this.id,
      assurance: this.assurance,
    };
  }
}

function quotaTask(bytes: number): TaskEntity {
  return makeTask({
    execution: { kind: 'local_command', argv: ['/bin/true', String(bytes)] },
    verification: { kind: 'local_command', argv: ['/bin/true'] },
  });
}

describe('workspace disk quota', () => {
  it('measures regular files without following a symlink out of the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'aios-measure-'));
    const outside = mkdtempSync(join(tmpdir(), 'aios-measure-outside-'));
    writeFileSync(join(root, 'inside.bin'), Buffer.alloc(100));
    writeFileSync(join(outside, 'outside.bin'), Buffer.alloc(4096));
    symlinkSync(join(outside, 'outside.bin'), join(root, 'link.bin'));
    expect(measureWorkspaceBytes(root)).toBe(100);
    symlinkSync('/etc/shadow', join(root, 'host-link'));
    expect(measureWorkspaceBytes(root)).toBe(100);
  });

  it('stops a live run that crosses the cap and discards its oversized workspace', async () => {
    const config = makeExecutionConfig(undefined, { workspace_max_bytes: 1024 });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const executor = new LocalCommandExecutor(config, new FileWritingSandbox(), workspaces);
    const task = quotaTask(64 * 1024);

    await expect(executor.executeTask(AGENT_ID, task)).rejects.toBeInstanceOf(WorkspaceQuotaExceededError);
    expect(readdirSync(config.workspace_directory)).toEqual([]);
  });

  it('leaves an under-cap run and a following per-run workspace unaffected', async () => {
    const config = makeExecutionConfig(undefined, { workspace_max_bytes: 1024 * 1024 });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const sandbox = new FileWritingSandbox();
    const executor = new LocalCommandExecutor(config, sandbox, workspaces);

    const first = quotaTask(512);
    const second = quotaTask(1024);
    await expect(executor.executeTask(AGENT_ID, first)).resolves.toMatchObject({ summary: expect.stringContaining('test-only-process') });
    await expect(executor.executeTask(AGENT_ID, second)).resolves.toMatchObject({ summary: expect.stringContaining('test-only-process') });

    const directories = readdirSync(config.workspace_directory);
    expect(directories).toHaveLength(2);
    for (const directory of directories) {
      expect(measureWorkspaceBytes(join(config.workspace_directory, directory))).toBeLessThan(1024 * 1024);
    }
  });

  it('records disk_quota_exceeded as the durable failure reason', async () => {
    const store = new DurableOperationalStore({ directory: mkdtempSync(join(tmpdir(), 'aios-quota-ledger-')) });
    try {
      const delegate: AgentExecutionPort = {
        validateAgent: async () => true,
        executeTask: async (): Promise<TaskExecutionResult> => {
          throw new WorkspaceQuotaExceededError('workspace exceeded its cap');
        },
        coordinate: async () => {
          throw new Error('not used');
        },
      };
      const managed = new ManagedExecutionPort(delegate, store.executions, 1);
      const task = quotaTask(0);

      await expect(managed.executeTask(AGENT_ID, task)).rejects.toBeInstanceOf(WorkspaceQuotaExceededError);
      const failed = store.executions.getForTask(task.entity_id);
      expect(failed).toMatchObject({
        state: 'failed',
        reason_code: 'disk_quota_exceeded',
      });
      expect(failed?.execution_id).toBeDefined();

      const config = makeExecutionConfig(undefined, { workspace_max_bytes: 1024 });
      const verifier = new LocalCommandVerifier(
        config,
        new FileWritingSandbox(),
        new RunWorkspaceManager(config.workspace_directory),
        { current: store.executions },
      );
      const decision = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: { summary: 'failed run presented as success', evidence: [] },
      });
      expect(decision.accepted).toBe(false);
      expect(decision.reason).toContain('disk quota');
      expect(decision.evidence).toContain(`execution_id:${failed?.execution_id}`);
      expect(decision.evidence).toContain('failure_reason_code:disk_quota_exceeded');
      expect(decision.evidence.some((line) => line.startsWith('failure_evidence_sha256:'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('rejects verification that crosses the cap without accepting or ingesting its output', async () => {
    const config = makeExecutionConfig(undefined, { workspace_max_bytes: 1024 });
    const workspaces = new RunWorkspaceManager(config.workspace_directory);
    const verifier = new LocalCommandVerifier(config, new FileWritingSandbox(), workspaces);
    const task = makeTask({
      verification: { kind: 'local_command', argv: ['/bin/true', String(64 * 1024)] },
    });

    const decision = await verifier.verify({
      task,
      agent_ids: [AGENT_ID],
      execution_result: { summary: 'claimed success', evidence: ['claimed'] },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('disk limit');
    expect(decision.evidence).toContain('quota_exceeded:true');
    expect(existsSync(join(config.workspace_directory, task.entity_id))).toBe(false);
    expect(readdirSync(config.workspace_directory)).toEqual([]);
  });
});
