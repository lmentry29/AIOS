import { describe, expect, it } from 'vitest';
import { AgentRunner } from '@aios/agents';
import { TaskStore } from '@aios/work-hierarchy';
import { makeAgent, makeTask } from './fixtures.js';

/**
 * BOUNDARY: @aios/work-hierarchy → @aios/agents
 *
 * AgentRunner runs one Agent through the full Agent Execution Loop (ADR-0002:
 * planning → reasoning → executing → monitoring → completion) against one real Task
 * held in a real TaskStore. This is the cross-package interaction the vertical-slice
 * mandate exists to exercise, and it is the closest thing the repo has to an
 * end-to-end path today.
 *
 * NOT COVERED, deliberately: the Mission → Objective → Task → Agent chain that
 * implementation-playbook.md §8 asks for in full. Objective has no schema in code
 * yet — ADR-0010 (which makes it a Canonical Object subtype) is still Proposed and
 * unimplemented, so there is nothing to construct. The Task's
 * work_hierarchy_parent.entity_id at level 'objective' remains a typed UUID with no
 * backing record. That gap is real and is left visible here rather than faked with a
 * stub Objective. See docs/process/divergence-log.md conflict #1.
 */

function setup() {
  const taskStore = new TaskStore();
  const runner = new AgentRunner(taskStore);

  const task = taskStore.createTask(makeTask());
  const agent = runner.createAgent(makeAgent());

  return { taskStore, runner, task, agent };
}

describe('work-hierarchy → agents: the Agent Execution Loop over a real Task', () => {
  it('drives the Agent through every ADR-0002 stage in order', () => {
    const { runner, task, agent } = setup();

    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);

    expect(finalAgent.lifecycle_state).toBe('completed');

    // The loop must be observable in the append-only history, not merely in the
    // final state — a runner that jumped straight to 'completed' would pass a
    // final-state-only assertion.
    const history = finalAgent.lifecycle_history.map((h) => `${h.state}:${h.substate ?? '-'}`);
    expect(history).toEqual([
      'validated:-',
      'active:planning',
      'active:reasoning',
      'active:executing',
      'active:monitoring',
      'completed:-',
    ]);
  });

  it('assigns the Agent to the Task in the store — the actual cross-package write', () => {
    const { taskStore, runner, task, agent } = setup();

    expect(taskStore.getTask(task.entity_id)?.assigned_agent).toBeUndefined();

    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    // The assignment is what makes this an integration test rather than two unit
    // tests: it is written by @aios/agents and read back from @aios/work-hierarchy.
    expect(taskStore.getTask(task.entity_id)?.assigned_agent).toBe(agent.entity_id);
  });

  it('carries the Task to completed through the store, not in the runner’s memory', () => {
    const { taskStore, runner, task, agent } = setup();

    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    // Re-read from the store rather than trusting the returned value — this is what
    // proves the write actually landed in persistence.
    const persisted = taskStore.getTask(task.entity_id);
    expect(persisted?.lifecycle_state).toBe('completed');
    expect(persisted?.lifecycle_history.map((h) => h.state)).toEqual(['active', 'completed']);
  });

  it('records the Agent as the actor on the Task’s lifecycle history', () => {
    const { taskStore, runner, task, agent } = setup();

    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    const persisted = taskStore.getTask(task.entity_id);
    // Provenance crosses the boundary: the Task's history must attribute the
    // transitions to the Agent that caused them, not to a generic actor.
    expect(persisted?.lifecycle_history.every((h) => h.actor === agent.entity_id)).toBe(true);
  });

  it('bumps the Task’s version on every store write the Agent makes', () => {
    const { taskStore, runner, task, agent } = setup();
    const before = taskStore.getTask(task.entity_id);

    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    const after = taskStore.getTask(task.entity_id);
    // Three writes: assigned_agent, → active/executing, → completed. COM §11's
    // atomic bump must hold for writes originating in another package.
    expect(after?.version).toBe((before?.version ?? 0) + 3);
  });

  it('leaves the Agent free of a Work Hierarchy position (COM §4.1)', () => {
    const { runner, task, agent } = setup();

    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);

    // An Agent acts ON Tasks; it does not occupy a position in the hierarchy. Running
    // a Task must never graft one onto it — core's schema refines against exactly this.
    expect(finalAgent.work_hierarchy_parent).toBeUndefined();
  });

  it('throws for an unknown agent id rather than silently no-oping', () => {
    const { runner, task } = setup();
    expect(() => runner.runFullLifecycle(crypto.randomUUID(), task.entity_id)).toThrow();
  });
});
