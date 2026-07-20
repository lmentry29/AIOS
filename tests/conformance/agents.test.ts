import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRunner } from '@aios/agents';
import { TaskStore } from '@aios/work-hierarchy';
import { makeAgent, makeTask } from './fixtures.js';

/**
 * CONFORMANCE SUBJECT: @aios/agents
 *
 * Declared scope (AIOS-CONFORMANCE §7.7): AgentRunner, implementing the Agent
 * Execution Loop (ADR-0002) over a real Task held in @aios/work-hierarchy's
 * TaskStore. Per packages/agents/src/agent-runner.ts's own header: "No orchestration,
 * no multi-agent coordination, no System Execution Loop" — those are
 * @aios/orchestration's declared scope and are explicitly out of scope here.
 */

function setup() {
  const taskStore = new TaskStore();
  const runner = new AgentRunner(taskStore);
  const task = taskStore.createTask(makeTask());
  const agent = runner.createAgent(makeAgent());
  return { taskStore, runner, task, agent };
}

describe('Requirement Category: Lifecycle — the Agent Execution Loop runs its exact stage sequence, in order (ADR-0002 Decision 2, COM §4.1 table)', () => {
  // "Agent Execution Loop ... the lifecycle of an individual autonomous agent:
  // planning, reasoning, execution, monitoring, completion." (ADR-0002 §2) Mapped onto
  // lifecycle_state/lifecycle_substate per COM §4.1's table: active/{planning,
  // reasoning, executing, monitoring} between validated and completed. No stage may be
  // skipped and none may be reordered.
  it('produces the exact six-entry history, in order, with no stage skipped or reordered', () => {
    const { runner, task, agent } = setup();
    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);

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
});

describe('Requirement Category: Architectural — running an Agent never grafts a Work Hierarchy position onto it (COM §4.1, §3.4)', () => {
  // "An Agent or Plugin instance is not itself a Work Hierarchy member... it acts on
  // Tasks rather than occupying a position in the hierarchy." (COM §3.4) The schema
  // rejects work_hierarchy_parent on an Agent (tested in core.test.ts); this proves
  // the runner's own writes never attempt to set it, across a full execution.
  it('leaves work_hierarchy_parent undefined on the Agent after a full run', () => {
    const { runner, task, agent } = setup();
    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);
    expect(finalAgent.work_hierarchy_parent).toBeUndefined();
  });
});

describe('Requirement Category: Governance — every history entry the runner writes attributes the driving Agent as actor (COM §3.2 actor field; Glossary "Audit")', () => {
  // "lifecycle_history | array of {state, substate, entered_at, actor}" (COM §3.2) —
  // actor is what makes reconstruction of "who did this" (the Glossary's Audit
  // definition) possible. A runner that hardcoded a generic actor would break Audit
  // for every entity it touches.
  it('attributes every entry on the Agent’s own history to the Agent’s entity_id', () => {
    const { runner, task, agent } = setup();
    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);
    expect(finalAgent.lifecycle_history.every((h) => h.actor === agent.entity_id)).toBe(true);
  });

  it('attributes every entry the run adds to the Task’s history to the Agent, not a generic actor', () => {
    const { taskStore, runner, task, agent } = setup();
    runner.runFullLifecycle(agent.entity_id, task.entity_id);
    const persisted = taskStore.getTask(task.entity_id);
    expect(persisted?.lifecycle_history.every((h) => h.actor === agent.entity_id)).toBe(true);
  });
});

describe('Requirement Category: Behavioral — an unknown Agent id fails the whole operation, not just the Agent half (COM §11 atomicity)', () => {
  // "Every Canonical Entity write MUST update modified_at and increment version
  // atomically with the field change it accompanies — no partial writes." (COM §11)
  // Applied across this package's one cross-package operation: a run against an
  // unregistered Agent must fail before touching the Task at all, not leave the Task
  // partially advanced.
  it('throws before making any write to the Task store', () => {
    const { taskStore, runner, task } = setup();
    const before = taskStore.getTask(task.entity_id);

    expect(() => runner.runFullLifecycle(randomUUID(), task.entity_id)).toThrow();

    const after = taskStore.getTask(task.entity_id);
    expect(after?.version).toBe(before?.version);
    expect(after?.lifecycle_state).toBe(before?.lifecycle_state);
    expect(after?.assigned_agent).toBeUndefined();
  });
});
