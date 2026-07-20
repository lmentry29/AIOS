import { describe, expect, it } from 'vitest';
import { TaskEntity } from '@aios/core';
import { makeTask } from './fixtures.js';

/**
 * KNOWN SPEC-VS-IMPLEMENTATION GAPS — DELIBERATELY FAILING TESTS.
 *
 * This file documents a normative COM requirement that the current implementation
 * does NOT enforce, verified by direct inspection of the source (not guessed). The
 * test below is EXPECTED TO FAIL when this suite runs, and is meant to keep failing
 * until a project-owner decision is made — this is not a test bug, not a flaky test,
 * and not something to "fix" by relaxing the assertion, adding `.skip`/`.todo`, or
 * silently loosening the expectation.
 *
 * Consequence: `pnpm vitest run --project conformance`, `pnpm turbo test`, and the
 * `conformance.yml` CI gate will all report red for as long as this file exists in its
 * current form. That is the deliberate purpose of the file, not an accident — it keeps
 * this gap visible in the same place the rest of the conformance evidence lives,
 * rather than buried in a comment or a separate doc nobody re-reads.
 *
 * Two other gaps previously documented here — Agent owner_id must resolve to a human
 * (COM §7) and ObjectStore.update()'s runtime bypass of relationships/lifecycle_history
 * (COM §11) — were audited, found to have zero existing dependents anywhere in the
 * repo, fixed, and moved into the main suite as passing, mutation-tested tests
 * (tests/conformance/core.test.ts and tests/conformance/objects.test.ts respectively).
 * See packages/core/src/schema/agent.ts and packages/objects/src/store.ts.
 *
 * This one is parked here deliberately, not merely undecided — see below.
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
  // (packages/objects/src/store.ts) passes substate through unchecked.
  //
  // WHY THIS ONE IS PARKED, NOT FIXED: unlike the two gaps resolved above, this one has
  // a REAL, PRODUCTION dependency on the permissive behavior, found by repo-wide grep
  // before any fix was attempted. packages/agents/src/agent-runner.ts:79 —
  // `this.taskStore.transitionTaskLifecycle(taskId, 'active', actor, 'executing')` —
  // deliberately sets a TASK entity's lifecycle_substate to 'executing', a value COM
  // §4.1's table defines only for Agent entities ("Agent-specific"); COM §4.2 defines no
  // substate table for Task at all. This is not accidental: the method's own docstring
  // says "transitions the Task to active/executing too — the cross-package interaction
  // the vertical slice mandate exists to exercise." A strict per-entity-type substate
  // rule would break this real, currently-passing production code path, plus every test
  // that exercises it: packages/agents/tests/agent-runner.test.ts,
  // packages/work-hierarchy/tests/task-store.test.ts,
  // tests/integration/work-hierarchy-agents.test.ts, tests/integration/full-chain.test.ts,
  // tests/integration/objects-work-hierarchy.test.ts, tests/integration/core-objects.test.ts,
  // tests/conformance/agents.test.ts, and tests/conformance/objects.test.ts. Resolving
  // this requires a project-owner decision — e.g. defining a Task substate vocabulary,
  // dropping the substate propagation in AgentRunner, or amending the COM text — not a
  // mechanical schema tightening.
  it('rejects a lifecycle_substate that does not belong to the declared lifecycle_state', () => {
    const bad = makeTask({ lifecycle_state: 'created', lifecycle_substate: 'planning' });
    expect(() => TaskEntity.parse(bad)).toThrow();
  });
});
