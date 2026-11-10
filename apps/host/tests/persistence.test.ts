import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskEntity } from '@aios/core';
import { JournalError } from '../src/persistence/journal.js';
import {
  DispatchConflictError,
  DurableOperationalStore,
} from '../src/persistence/operational-store.js';
import { AGENT_ID, FOUNDER, makeTask, makeWorkflow } from './fixtures.js';

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'aios-operational-'));
}

function activateTask(store: DurableOperationalStore, task: TaskEntity): void {
  store.tasks.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER);
  store.tasks.transitionTaskLifecycle(task.entity_id, 'active', FOUNDER);
}

describe('durable operational state', () => {
  it('restores entities, versions, and append-only lifecycle history across restart', () => {
    const directory = stateDirectory();
    const task = makeTask();

    const first = new DurableOperationalStore({ directory });
    first.tasks.createTask(task);
    first.tasks.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER);
    first.tasks.updateTask(task.entity_id, { name: 'Renamed after review' });
    expect(first.tasks.getTask(task.entity_id)?.version).toBe(3);
    first.close();

    const second = new DurableOperationalStore({ directory });
    const restored = second.tasks.getTask(task.entity_id);
    expect(restored?.entity_id).toBe(task.entity_id);
    expect(restored?.name).toBe('Renamed after review');
    expect(restored?.version).toBe(3);
    expect(restored?.lifecycle_history.map((entry) => entry.state)).toEqual(['validated']);
    // entity_id is never reused, including after recovery (COM §9).
    expect(() => second.tasks.createTask(task)).toThrow(/already exists/);
    second.close();
  });

  it('keeps Workflows and evidence Artifacts durable too', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);

    const first = new DurableOperationalStore({ directory });
    first.workflows.create(workflow);
    first.workflows.transitionLifecycle(workflow.entity_id, 'validated', FOUNDER);
    first.workflows.transitionLifecycle(workflow.entity_id, 'active', FOUNDER);
    first.close();

    const second = new DurableOperationalStore({ directory });
    expect(second.workflows.get(workflow.entity_id)?.lifecycle_state).toBe('active');
    expect(second.workflows.get(workflow.entity_id)?.version).toBe(3);
    second.close();
  });

  it('detects tampering with a committed record instead of loading altered state', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    first.tasks.createTask(task);
    first.close();

    const journalPath = join(directory, 'operational.jsonl');
    const contents = readFileSync(journalPath, 'utf8');
    writeFileSync(
      journalPath,
      contents.replace('Execute the trusted host slice', 'Tampered task name'),
      { mode: 0o600 },
    );

    expect(() => new DurableOperationalStore({ directory })).toThrow(JournalError);
  });

  it('discards only an interrupted tail write and keeps every committed record', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    first.tasks.createTask(task);
    first.close();

    const journalPath = join(directory, 'operational.jsonl');
    appendFileSync(journalPath, '{"sequence":2,"kind":"run","payload":');

    const second = new DurableOperationalStore({ directory });
    expect(second.journal.recoveredTornTail).toBe(true);
    expect(second.tasks.getTask(task.entity_id)?.entity_id).toBe(task.entity_id);
    // The truncated tail is removed, so the journal is left in a writable, verified state.
    expect(() => second.tasks.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER)).not.toThrow();
    second.close();
    const third = new DurableOperationalStore({ directory });
    expect(third.tasks.getTask(task.entity_id)?.version).toBe(2);
    third.close();
  });

  it('allows exactly one process to own the operational store', () => {
    const directory = stateDirectory();
    const first = new DurableOperationalStore({ directory });
    expect(() => new DurableOperationalStore({ directory })).toThrow(/already open/);
    first.close();
    const second = new DurableOperationalStore({ directory });
    second.close();
  });
});

describe('durable dispatch runs', () => {
  it('replays a completed idempotency key and rejects a concurrent dispatch', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    let store = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    store.workflows.create(workflow);

    const started = store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'dispatch-key-0001',
    });
    expect(started.replayed).toBe(false);
    expect(() => store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'dispatch-key-0002',
    })).toThrow(DispatchConflictError);
    expect(() => store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'short',
    })).toThrow(DispatchConflictError);

    store.runs.complete(started.run.run_id);
    store.close();

    store = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    const replay = store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'dispatch-key-0001',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.run.run_id).toBe(started.run.run_id);
    expect(store.runs.list()).toHaveLength(1);
    expect(store.runs.list()[0]?.state).toBe('completed');
    store.close();
  });

  it('reclaims an expired lease and records the previous run as interrupted', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const store = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    store.workflows.create(workflow);

    const first = store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'lease-key-0001',
    }, new Date('2026-01-01T00:00:00.000Z'));

    const takeover = store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'lease-key-0002',
    }, new Date('2026-01-01T00:00:06.000Z'));

    expect(takeover.replayed).toBe(false);
    expect(takeover.run.run_id).not.toBe(first.run.run_id);
    expect(store.runs.get(first.run.run_id)?.state).toBe('interrupted');
    expect(store.runs.get(first.run.run_id)?.failure_reason).toBe('lease_reclaimed');
    expect(store.runs.get(takeover.run.run_id)?.state).toBe('running');
    store.close();
  });

  it('renews a lease only for its owner and extends the expiry', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const store = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    store.workflows.create(workflow);
    const started = store.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'renew-key-0001',
    }, new Date('2026-01-01T00:00:00.000Z'));

    const renewed = store.runs.renew(
      started.run.run_id,
      5_000,
      new Date('2026-01-01T00:00:02.000Z'),
    );
    expect(renewed.lease_expires_at).toBe('2026-01-01T00:00:07.000Z');
    expect(renewed.revision).toBe(2);
    store.close();
  });

  it('marks runs from a previous host boot interrupted on recovery', () => {
    const directory = stateDirectory();
    const task = makeTask({ assigned_workflow: undefined });
    const workflow = makeWorkflow([task.entity_id]);
    const first = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    first.workflows.create(workflow);
    first.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'recovery-key-0001',
    });
    first.close();

    const second = new DurableOperationalStore({ directory, leaseMs: 5_000 });
    expect(second.runs.recover()).toEqual([workflow.entity_id]);
    const recovered = second.runs.list()[0];
    expect(recovered?.state).toBe('interrupted');
    expect(recovered?.failure_reason).toBe('host_restarted');
    // Recovery is not completion, and a second recovery pass is a no-op.
    expect(second.runs.recover()).toEqual([]);
    second.close();
  });
});

describe('durable execution attempts', () => {
  it('keeps a terminal attempt immutable while appending retry history across restart', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    const initial = first.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
    expect(initial).toMatchObject({ attempt: 1, attempt_kind: 'initial', state: 'running' });
    first.executions.fail(initial.execution_id, 'execution_failed');
    expect(first.executions.listForTask(task.entity_id).map((record) => [record.attempt, record.state]))
      .toEqual([[1, 'failed']]);
    expect(() => first.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID }))
      .toThrow(/use resume or retry/);

    const retry = first.executions.retry({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: initial.execution_id,
    });
    expect(retry).toMatchObject({
      attempt: 2,
      attempt_kind: 'retry',
      previous_execution_id: initial.execution_id,
    });
    first.executions.complete(retry.execution_id, [`result_sha256:${'a'.repeat(64)}`]);    // The failed attempt is history, not a mutable pointer.
    expect(first.executions.get(initial.execution_id)).toMatchObject({ state: 'failed', revision: 2 });
    expect(first.executions.getForTask(task.entity_id)?.execution_id).toBe(retry.execution_id);
    first.close();

    const second = new DurableOperationalStore({ directory });
    const attempts = second.executions.listForTask(task.entity_id);
    expect(attempts.map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'failed'],
      [2, 'retry', 'completed'],
    ]);
    expect(attempts[1]?.previous_execution_id).toBe(initial.execution_id);
    second.close();
  });

  it('resumes only interrupted attempts and never reopens a cancellation', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const store = new DurableOperationalStore({ directory });
    const initial = store.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
    expect(() => store.executions.resume({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: initial.execution_id,
    })).toThrow(/Only an interrupted execution/);

    store.executions.reconcile();
    expect(store.executions.get(initial.execution_id)?.state).toBe('interrupted');
    const resumed = store.executions.resume({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: initial.execution_id,
    });
    expect(resumed).toMatchObject({
      attempt: 2,
      attempt_kind: 'resume',
      previous_execution_id: initial.execution_id,
    });

    store.executions.cancel({
      task_id: task.entity_id,
      actor_id: FOUNDER,
      reason_code: 'cancelled_by_request',
    });
    expect(store.executions.get(resumed.execution_id)?.state).toBe('cancelled');
    expect(() => store.executions.resume({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: resumed.execution_id,
    })).toThrow(/cancelled execution cannot be resumed/);

    const retried = store.executions.retry({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: resumed.execution_id,
    });
    expect(retried).toMatchObject({
      attempt: 3,
      attempt_kind: 'retry',
      previous_execution_id: resumed.execution_id,
    });
    expect(store.executions.get(resumed.execution_id)).toMatchObject({
      state: 'cancelled',
      revision: 2,
    });
    expect(store.executions.listForTask(task.entity_id)).toHaveLength(3);
    store.close();
  });

  it('rejects a non-contiguous attempt chain on journal replay', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    const initial = first.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
    first.journal.append('execution', {
      ...initial,
      execution_id: randomUUID(),
      attempt: 3,
      attempt_kind: 'retry',
      previous_execution_id: initial.execution_id,
      revision: 1,
    });
    first.close();
    expect(() => new DurableOperationalStore({ directory })).toThrow(/non-contiguous/);
  });

  it('reconciles an already-interrupted resumed attempt once and writes nothing on a second pass', () => {
    const directory = stateDirectory();
    const task = makeTask();
    const first = new DurableOperationalStore({ directory });
    const initial = first.executions.start({ task_id: task.entity_id, agent_id: AGENT_ID });
    first.executions.reconcile();
    const resumed = first.executions.resume({
      task_id: task.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: initial.execution_id,
    });
    first.close();

    const journalPath = join(directory, 'operational.jsonl');
    const second = new DurableOperationalStore({ directory });
    expect(second.executions.getForTask(task.entity_id)).toMatchObject({
      execution_id: resumed.execution_id,
      attempt: 2,
      attempt_kind: 'resume',
      state: 'running',
    });
    expect(second.executions.reconcile().map((record) => record.execution_id))
      .toEqual([resumed.execution_id]);
    expect(second.executions.listForTask(task.entity_id)).toHaveLength(2);
    expect(second.executions.get(initial.execution_id)).toMatchObject({
      state: 'interrupted',
      revision: 2,
    });

    // A second reconciliation over the same durable state appends no journal bytes.
    const bytesAfterReconciliation = readFileSync(journalPath).byteLength;
    expect(second.executions.reconcile()).toEqual([]);
    expect(readFileSync(journalPath).byteLength).toBe(bytesAfterReconciliation);
    second.close();

    const third = new DurableOperationalStore({ directory });
    expect(third.executions.listForTask(task.entity_id)
      .map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
    ]);
    expect(third.executions.reconcile()).toEqual([]);
    third.close();
  });
});
