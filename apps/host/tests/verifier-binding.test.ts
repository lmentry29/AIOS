import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import { ManagedExecutionPort } from '../src/execution/managed-execution.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { DurableOperationalStore } from '../src/persistence/operational-store.js';
import { AGENT_ID, makeTask } from './fixtures.js';

const OTHER_AGENT_ID = '11111111-1111-4111-8111-111111111115';
import { StubSandbox, makeExecutionConfig } from './sandbox-fixture.js';

function boundTask(): TaskEntity {
  return makeTask({
    execution: { kind: 'local_command', argv: ['/bin/echo', 'ok'] },
    verification: { kind: 'local_command', argv: ['/bin/true'] },
  });
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'aios-verifier-binding-'));
}

/**
 * These tests exercise the real managed-execution wrapper and the real verifier against a
 * durable journal. Only the OS boundary is a labelled test double, because the property
 * under test is evidence binding, not isolation.
 */
describe('durable verification binding', () => {
  it('binds acceptance to the committed execution attempt', async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    try {
      const config = makeExecutionConfig();
      const sandbox = new StubSandbox();
      const workspaces = new RunWorkspaceManager(config.workspace_directory);
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, workspaces),
        store.executions,
        1,
      );
      const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
        current: store.executions,
      });
      const task = boundTask();
      const result = await managed.executeTask(AGENT_ID, task);

      const decision = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: result,
      });

      expect(decision.accepted).toBe(true);
      const evidence = decision.evidence.join('\n');
      expect(evidence).toContain('execution_id:');
      expect(evidence).toContain('execution_attempt:1');
      expect(evidence).toContain('bound_result_sha256:');
    } finally {
      store.close();
    }
  });

  it('rejects a forged result whose digest does not match the durable attempt', async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    try {
      const config = makeExecutionConfig();
      const sandbox = new StubSandbox();
      const workspaces = new RunWorkspaceManager(config.workspace_directory);
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, workspaces),
        store.executions,
        1,
      );
      const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
        current: store.executions,
      });
      const task = boundTask();
      const result = await managed.executeTask(AGENT_ID, task);
      const callsBefore = sandbox.calls.length;

      const decision = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: { ...result, summary: 'forged success' },
      });

      expect(decision.accepted).toBe(false);
      expect(decision.reason).toContain('does not match');
      expect(sandbox.calls.length).toBe(callsBefore);
    } finally {
      store.close();
    }
  });

  it('rejects verification when no completed attempt exists or the actor differs', async () => {
    const store = new DurableOperationalStore({ directory: stateDirectory() });
    try {
      const config = makeExecutionConfig();
      const sandbox = new StubSandbox();
      const workspaces = new RunWorkspaceManager(config.workspace_directory);
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, workspaces),
        store.executions,
        1,
      );
      const verifier = new LocalCommandVerifier(config, sandbox, workspaces, {
        current: store.executions,
      });
      const neverRun = boundTask();
      const unbound = await verifier.verify({
        task: neverRun,
        agent_ids: [AGENT_ID],
        execution_result: { summary: 'self report', evidence: ['invented'] },
      });
      expect(unbound.accepted).toBe(false);
      expect(unbound.reason).toContain('No completed durable execution attempt');

      const task = boundTask();
      const result = await managed.executeTask(AGENT_ID, task);
      const wrongPrincipal = await verifier.verify({
        task,
        agent_ids: [OTHER_AGENT_ID],
        execution_result: result,
      });
      expect(wrongPrincipal.accepted).toBe(false);
      expect(wrongPrincipal.reason).toContain('different principal');
    } finally {
      store.close();
    }
  });
});
