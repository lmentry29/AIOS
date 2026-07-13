import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRunner } from '@aios/agents';
import { ImmutableObjectiveFieldError } from '@aios/objects';
import { ObjectiveStore, TaskStore } from '@aios/work-hierarchy';
import { FOUNDER, makeAgent, makeObjective, makeTask } from './fixtures.js';

/**
 * FULL CHAIN: Mission → Objective → Task → Agent
 *
 * implementation-playbook.md §8's Milestone 1 Definition of Done: "One Mission → one
 * Objective → one Task → one Agent execution, start to finish, has an integration test
 * in tests/integration/ exercising it — not just unit tests in isolation."
 *
 * This test could not exist until now. It was blocked by divergence-log conflict #1:
 * Objective had no schema anywhere in the codebase, so there was nothing to construct
 * between Mission and Task. ADR-0010 (Accepted 2026-07-13) resolved that by making
 * Objective a Canonical Object subtype, and packages/core/src/schema/objective.ts
 * implements it. This is the test that closes the Milestone 1 DoD.
 *
 * MISSION IS STILL A DANGLING REFERENCE, and that is deliberate, not a shortcut.
 * ADR-0010 §3 keeps Mission a non-entity: the corpus specifies no field-level model
 * for it, so promoting it would mean inventing its fields. The chain below is therefore
 * genuinely asymmetric — the Objective→Task link dereferences to a real record, and the
 * Mission→Objective link does not. Both facts are asserted, so the gap stays visible
 * rather than being quietly papered over by a stub Mission.
 */

describe('Mission → Objective → Task → Agent (playbook §8, Milestone 1 DoD)', () => {
  function buildChain() {
    const objectiveStore = new ObjectiveStore();
    const taskStore = new TaskStore();
    const runner = new AgentRunner(taskStore);

    // Mission: a typed UUID with no backing record, by design (ADR-0010 §3).
    const missionId = randomUUID();

    const objective = objectiveStore.createObjective(
      makeObjective({
        work_hierarchy_parent: { entity_id: missionId, level: 'mission' },
      }),
    );

    const task = taskStore.createTask(
      makeTask({
        work_hierarchy_parent: { entity_id: objective.entity_id, level: 'objective' },
      }),
    );

    const agent = runner.createAgent(makeAgent());

    return { objectiveStore, taskStore, runner, missionId, objective, task, agent };
  }

  it('links the whole chain, and the Task’s parent dereferences to a real Objective', () => {
    const { objectiveStore, task, objective, missionId } = buildChain();

    // THE ASSERTION ADR-0010 EXISTS TO MAKE TRUE. Before it, this entity_id was a
    // well-typed UUID pointing at nothing — the dangling reference that stopped the
    // vertical slice. It now resolves to a persisted record.
    expect(task.work_hierarchy_parent.level).toBe('objective');
    const parent = objectiveStore.getObjective(task.work_hierarchy_parent.entity_id);
    expect(parent).toBeDefined();
    expect(parent?.entity_id).toBe(objective.entity_id);
    expect(parent?.purpose).toBe('CI feedback is too slow to be useful');

    // And the Objective hangs off the Mission, completing the ADR-0004 chain.
    expect(objective.work_hierarchy_parent?.level).toBe('mission');
    expect(objective.work_hierarchy_parent?.entity_id).toBe(missionId);
  });

  it('leaves Mission a dangling reference — knowingly retained, not an oversight', async () => {
    const { objective } = buildChain();

    // The Mission id is well-typed and points at nothing: @aios/work-hierarchy exports
    // a store for Objective and Task, and none for Mission, so there is nothing to
    // resolve it against. ADR-0010 §3 — the corpus specifies no field-level model for
    // Mission, and inventing one would be the unilateral resolution the standing rule
    // forbids. This asserts the asymmetry against the package's real public surface,
    // so if a MissionStore is ever added, this test fails and forces an update.
    const workHierarchy = await import('@aios/work-hierarchy');
    expect(Object.keys(workHierarchy)).toContain('ObjectiveStore');
    expect(Object.keys(workHierarchy)).toContain('TaskStore');
    expect(Object.keys(workHierarchy)).not.toContain('MissionStore');

    expect(objective.work_hierarchy_parent?.level).toBe('mission');
    expect(objective.work_hierarchy_parent?.entity_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('runs an Agent through the full ADR-0002 loop against the Task under that Objective', () => {
    const { objectiveStore, taskStore, runner, objective, task, agent } = buildChain();

    const { agent: finalAgent } = runner.runFullLifecycle(agent.entity_id, task.entity_id);

    // Agent: full Agent Execution Loop, observable in append-only history.
    expect(finalAgent.lifecycle_state).toBe('completed');
    expect(finalAgent.lifecycle_history.map((h) => `${h.state}:${h.substate ?? '-'}`)).toEqual([
      'validated:-',
      'active:planning',
      'active:reasoning',
      'active:executing',
      'active:monitoring',
      'completed:-',
    ]);

    // Task: completed, assigned to the Agent, still parented to the same Objective.
    const persistedTask = taskStore.getTask(task.entity_id);
    expect(persistedTask?.lifecycle_state).toBe('completed');
    expect(persistedTask?.assigned_agent).toBe(agent.entity_id);
    expect(persistedTask?.work_hierarchy_parent.entity_id).toBe(objective.entity_id);

    // Objective: still resolvable, and its definition is untouched by everything the
    // Agent just did. Execution happens beneath an Objective; it does not rewrite it.
    const persistedObjective = objectiveStore.getObjective(objective.entity_id);
    expect(persistedObjective?.purpose).toBe('CI feedback is too slow to be useful');
    expect(persistedObjective?.success_criteria).toEqual(['p95 < 180s over a 7-day window']);
  });

  it('advances the Objective’s Current Status without mutating its definition', () => {
    const { objectiveStore, runner, objective, task, agent } = buildChain();

    runner.runFullLifecycle(agent.entity_id, task.entity_id);

    // The Objective's own status can move as work beneath it completes — Current Status
    // maps to lifecycle_state (COM §5.3) and lifecycle_history is append-only.
    const completed = objectiveStore.transitionObjectiveLifecycle(
      objective.entity_id,
      'completed',
      FOUNDER,
    );

    expect(completed.lifecycle_state).toBe('completed');
    expect(completed.purpose).toBe('CI feedback is too slow to be useful');
    // Both halves of Part VI Ch.4 hold at once: "Objectives remain immutable" AND
    // "Current Status".
    expect(() =>
      objectiveStore.updateObjective(objective.entity_id, { purpose: 'rewritten' } as never),
    ).toThrow(ImmutableObjectiveFieldError);
  });
});
