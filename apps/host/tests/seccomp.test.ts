import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import type { AgentExecutionPort, TaskExecutionResult } from '@aios/orchestration';
import {
  SandboxFilterUnavailableError,
  SandboxResourceLimitUnavailableError,
  SandboxSyscallDeniedError,
} from '../src/errors.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import { ManagedExecutionPort } from '../src/execution/managed-execution.js';
import {
  buildDockerSeccompProfile,
  buildSeccompProfile,
  SECCOMP_DENIED_EXIT_CODE,
} from '../src/execution/seccomp.js';
import type { SandboxProvider, SandboxResult, SandboxRunSpec } from '../src/execution/sandbox.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { DurableOperationalStore } from '../src/persistence/operational-store.js';
import { AGENT_ID, makeTask } from './fixtures.js';
import { makeExecutionConfig } from './sandbox-fixture.js';

const FILTER = {
  profile: 'aios-seccomp-deny-v1-x64',
  sha256: 'a'.repeat(64),
  applied: true,
};

const LIMITS = {
  memory_bytes: 1280 * 1024 * 1024,
  cpu_seconds: 5,
  processes: 128,
  applied: true,
};

class FilterSandbox implements SandboxProvider {
  readonly id = 'bubblewrap';
  readonly assurance = 'kernel-namespace' as const;
  calls: SandboxRunSpec[] = [];
  result: Partial<SandboxResult> = {};
  checkResult: { available: boolean; reason: string; filterFailure?: boolean; resourceLimitFailure?: boolean } = {
    available: true,
    reason: 'filter test provider',
  };

  async check(): Promise<{ available: boolean; reason: string; filterFailure?: boolean; resourceLimitFailure?: boolean }> {
    return this.checkResult;
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    this.calls.push(spec);
    return {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from('ok\n'),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 1,
      provider: this.id,
      assurance: this.assurance,
      filter: FILTER,
      limits: LIMITS,
      ...this.result,
    };
  }
}

function task(argv: string[] = ['/bin/true']): TaskEntity {
  return makeTask({
    execution: { kind: 'local_command', argv },
    verification: { kind: 'local_command', argv: ['/bin/true'] },
  });
}

describe('generated seccomp profile', () => {
  it('builds a deterministic x86_64 filter with an architecture guard and deny-list', () => {
    const profile = buildSeccompProfile('x64');
    expect(profile.profile).toBe('aios-seccomp-deny-v1-x64');
    expect(profile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(profile.denied_syscalls).toEqual(expect.arrayContaining(['ptrace', 'unshare', 'bpf', 'io_uring_setup']));
    expect(profile.filter.length).toBe((5 + profile.denied_syscalls.length * 2) * 8);
    expect(profile.filter.length % 8).toBe(0);
    expect(buildSeccompProfile('x64').sha256).toBe(profile.sha256);
    expect(buildSeccompProfile('arm64').profile).toBe('aios-seccomp-deny-v1-arm64');
  });

  it('refuses to invent a filter for an unsupported architecture', () => {
    expect(() => buildSeccompProfile('mips')).toThrow(/No seccomp profile/);
  });

  it('builds the Docker libseccomp profile with the same deny-list and architecture guard', () => {
    const docker = buildDockerSeccompProfile('x64');
    const document = JSON.parse(docker.profile) as {
      defaultAction: string;
      architectures: string[];
      syscalls: Array<{ names: string[]; action: string }>;
    };
    expect(document.defaultAction).toBe('SCMP_ACT_ALLOW');
    expect(document.architectures).toEqual(['SCMP_ARCH_X86_64']);
    expect(document.syscalls).toHaveLength(1);
    expect(document.syscalls[0]?.action).toBe('SCMP_ACT_KILL');
    expect(document.syscalls[0]?.names).toEqual(expect.arrayContaining([
      'mount',
      'ptrace',
      'unshare',
      'bpf',
      'io_uring_setup',
    ]));
    expect(docker.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildDockerSeccompProfile('x64').sha256).toBe(docker.sha256);
    expect(JSON.parse(buildDockerSeccompProfile('arm64').profile).architectures)
      .toEqual(['SCMP_ARCH_AARCH64']);
    expect(() => buildDockerSeccompProfile('mips')).toThrow(/No Docker seccomp profile/);
  });
});

describe('sandbox filter evidence', () => {
  it('maps a preflight filter failure to the distinct unavailable error and durable reason', async () => {
    const store = new DurableOperationalStore({ directory: mkdtempSync(join(tmpdir(), 'aios-seccomp-preflight-')) });
    try {
      const config = makeExecutionConfig();
      const sandbox = new FilterSandbox();
      sandbox.checkResult = {
        available: false,
        filterFailure: true,
        reason: 'bwrap could not load the generated filter',
      };
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, new RunWorkspaceManager(config.workspace_directory)),
        store.executions,
        1,
      );
      const denied = task();
      await expect(managed.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxFilterUnavailableError);
      expect(store.executions.getForTask(denied.entity_id)).toMatchObject({
        state: 'failed',
        reason_code: 'sandbox_filter_unavailable',
      });
    } finally {
      store.close();
    }
  });

  it('denies a success result that has no proof the filter was applied', async () => {
    const config = makeExecutionConfig();
    const sandbox = new FilterSandbox();
    sandbox.result = { filter: undefined };
    const executor = new LocalCommandExecutor(config, sandbox, new RunWorkspaceManager(config.workspace_directory));
    const denied = task();

    await expect(executor.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxFilterUnavailableError);
    expect(sandbox.calls).toHaveLength(1);
  });

  it('distinguishes a SIGSYS denial and binds it to durable failure evidence', async () => {
    const store = new DurableOperationalStore({ directory: mkdtempSync(join(tmpdir(), 'aios-seccomp-ledger-')) });
    try {
      const config = makeExecutionConfig();
      const sandbox = new FilterSandbox();
      sandbox.result = { exitCode: SECCOMP_DENIED_EXIT_CODE };
      const workspaces = new RunWorkspaceManager(config.workspace_directory);
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, workspaces),
        store.executions,
        1,
      );
      const denied = task(['/bin/sh', '-c', 'exec /usr/bin/unshare -U true']);

      await expect(managed.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxSyscallDeniedError);
      const failed = store.executions.getForTask(denied.entity_id);
      expect(failed).toMatchObject({ state: 'failed', reason_code: 'sandbox_syscall_denied' });
      expect(failed?.evidence).toContain(`sandbox_filter_sha256:${FILTER.sha256}`);
      expect(readdirEntries(config.workspace_directory)).toEqual([]);

      const verifier = new LocalCommandVerifier(
        config,
        new FilterSandbox(),
        new RunWorkspaceManager(config.workspace_directory),
        { current: store.executions },
      );
      const decision = await verifier.verify({
        task: denied,
        agent_ids: [AGENT_ID],
        execution_result: { summary: 'denied run presented as success', evidence: [] },
      });
      expect(decision.accepted).toBe(false);
      expect(decision.evidence).toContain('failure_reason_code:sandbox_syscall_denied');
      expect(decision.evidence).toContain(`failed_sandbox_filter_sha256:${FILTER.sha256}`);
      expect(decision.evidence.some((line) => line.startsWith('execution_id:'))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('records an unavailable filter as its own durable reason and rejects verification', async () => {
    const store = new DurableOperationalStore({ directory: mkdtempSync(join(tmpdir(), 'aios-seccomp-ledger-')) });
    try {
      const config = makeExecutionConfig();
      const delegate: AgentExecutionPort = {
        validateAgent: async () => true,
        executeTask: async (): Promise<TaskExecutionResult> => {
          throw new SandboxFilterUnavailableError('filter installation failed');
        },
        coordinate: async () => {
          throw new Error('not used');
        },
      };
      const managed = new ManagedExecutionPort(delegate, store.executions, 1);
      const denied = task();

      await expect(managed.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxFilterUnavailableError);
      const failed = store.executions.getForTask(denied.entity_id);
      expect(failed).toMatchObject({ state: 'failed', reason_code: 'sandbox_filter_unavailable' });

      const verifier = new LocalCommandVerifier(
        config,
        new FilterSandbox(),
        new RunWorkspaceManager(config.workspace_directory),
        { current: store.executions },
      );
      const decision = await verifier.verify({
        task: denied,
        agent_ids: [AGENT_ID],
        execution_result: { summary: 'claimed success', evidence: [] },
      });
      expect(decision.accepted).toBe(false);
      expect(decision.evidence).toContain('failure_reason_code:sandbox_filter_unavailable');
    } finally {
      store.close();
    }
  });

  it('rejects a verifier command whose own filter proof is missing', async () => {
    const config = makeExecutionConfig();
    const sandbox = new FilterSandbox();
    sandbox.result = { filter: { ...FILTER, applied: false, reason: 'marker missing' } };
    const verifier = new LocalCommandVerifier(config, sandbox, new RunWorkspaceManager(config.workspace_directory));
    const decision = await verifier.verify({
      task: task(),
      agent_ids: [AGENT_ID],
      execution_result: { summary: 'claimed success', evidence: [] },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.evidence).toContain('verification_failure:sandbox_filter_unavailable');
  });

  it('maps absent per-run resource-limit proof to its own durable reason', async () => {
    const store = new DurableOperationalStore({ directory: mkdtempSync(join(tmpdir(), 'aios-limits-ledger-')) });
    try {
      const config = makeExecutionConfig();
      const sandbox = new FilterSandbox();
      sandbox.result = { limits: { ...LIMITS, applied: false, reason: 'ulimit failed' } };
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, new RunWorkspaceManager(config.workspace_directory)),
        store.executions,
        1,
      );
      const denied = task();

      await expect(managed.executeTask(AGENT_ID, denied)).rejects.toBeInstanceOf(SandboxResourceLimitUnavailableError);
      expect(store.executions.getForTask(denied.entity_id)).toMatchObject({
        state: 'failed',
        reason_code: 'sandbox_resource_limit_unavailable',
      });

      const verifier = new LocalCommandVerifier(
        config,
        new FilterSandbox(),
        new RunWorkspaceManager(config.workspace_directory),
        { current: store.executions },
      );
      const decision = await verifier.verify({
        task: denied,
        agent_ids: [AGENT_ID],
        execution_result: { summary: 'claimed success', evidence: [] },
      });
      expect(decision.accepted).toBe(false);
      expect(decision.evidence).toContain('failure_reason_code:sandbox_resource_limit_unavailable');
    } finally {
      store.close();
    }
  });

  it('rejects a verifier command whose own resource-limit proof is missing', async () => {
    const config = makeExecutionConfig();
    const sandbox = new FilterSandbox();
    sandbox.result = { limits: { ...LIMITS, applied: false, reason: 'ulimit failed' } };
    const verifier = new LocalCommandVerifier(config, sandbox, new RunWorkspaceManager(config.workspace_directory));
    const decision = await verifier.verify({
      task: task(),
      agent_ids: [AGENT_ID],
      execution_result: { summary: 'claimed success', evidence: [] },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.evidence).toContain('verification_failure:sandbox_resource_limit_unavailable');
  });
});

function readdirEntries(directory: string): string[] {
  return readdirSync(directory);
}
