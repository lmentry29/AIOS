import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentEntity, TaskEntity } from '@aios/core';
import { makeAgent, makeTask } from './fixtures.js';

/**
 * KNOWN SPEC-VS-IMPLEMENTATION GAPS — DELIBERATELY FAILING TESTS.
 *
 * Everything in this file documents a normative COM requirement that the current
 * implementation does NOT enforce, verified by direct inspection of the source (not
 * guessed). Both tests below are EXPECTED TO FAIL when this suite runs, and are meant
 * to keep failing until a project-owner decision is made — this is not a test bug, not
 * a flaky test, and not something to "fix" by relaxing the assertion, adding
 * `.skip`/`.todo`, or silently loosening the expectation.
 *
 * Consequence: `pnpm vitest run --project conformance`, `pnpm turbo test`, and the
 * `conformance.yml` CI gate will all report red for as long as this file exists in its
 * current form. That is the deliberate purpose of the file, not an accident — it keeps
 * these two gaps visible in the same place the rest of the conformance evidence lives,
 * rather than buried in a comment or a separate doc nobody re-reads.
 *
 * Resolving either gap is a decision for the project owner, not a task for this suite:
 * either tighten the schema in packages/core/src/schema/{base,agent}.ts to match the
 * COM text, or amend the COM text if the MUST was aspirational rather than binding.
 * Whichever is chosen, this file should be updated to match — deleting the failing
 * case (schema now enforces it) or explicitly downgrading the COM citation (MUST -> a
 * documented exception), never just silencing the test in place.
 */

describe('KNOWN GAP — lifecycle_substate MUST map back to its parent lifecycle_state (COM §3.2)', () => {
  // COM §3.2: "lifecycle_substate | string | No | Entity-type-specific specialization
  // of the current canonical stage (e.g., an Agent in active may have substate
  // planning, reasoning, executing, or monitoring per the Agent Execution Loop,
  // ADR-0002). MUST map back to exactly one of the seven canonical stages — enforced
  // at the schema level by requiring lifecycle_substate to declare its parent
  // lifecycle_state."
  //
  // VERIFIED GAP: packages/core/src/schema/base.ts declares
  // `lifecycle_substate: z.string().optional()` — a free string with no relation to
  // `lifecycle_state` anywhere in the schema, and ObjectStore.transitionLifecycle()
  // (packages/objects/src/store.ts) passes substate through unchecked. Nothing
  // currently prevents constructing an entity with, e.g., lifecycle_state: 'created'
  // paired with lifecycle_substate: 'planning' — a substate that per COM §4.1's own
  // table only ever belongs to an Agent's 'active' stage.
  it('rejects a lifecycle_substate that does not belong to the declared lifecycle_state', () => {
    const bad = makeTask({ lifecycle_state: 'created', lifecycle_substate: 'planning' });
    expect(() => TaskEntity.parse(bad)).toThrow();
  });
});

describe('KNOWN GAP — an Agent instance’s owner_id MUST resolve to a human (COM §7)', () => {
  // COM §7: "An Agent can own Task, Workflow, Plugin, and Canonical Object instances,
  // but an Agent cannot own another Agent — Agent-to-Agent accountability would imply
  // a governance/authority relationship the certified architecture explicitly
  // reserves for the Human Layer and Executive Governance... An Agent instance's
  // owner_id MUST resolve to a human."
  //
  // VERIFIED GAP: packages/core/src/schema/agent.ts's only `.refine()` checks
  // work_hierarchy_parent; nothing constrains owner_id beyond the base ActorRef type,
  // which accepts either a UUID (any entity_id) or `human:<id>` — both currently
  // legal. AgentRunner.createAgent() (packages/agents/src/agent-runner.ts) adds no
  // further check; it calls AgentEntity.parse(agent) and nothing else.
  it('rejects an Agent whose owner_id is another entity’s UUID rather than a human', () => {
    const bad = makeAgent({ owner_id: randomUUID() });
    expect(() => AgentEntity.parse(bad)).toThrow();
  });
});
