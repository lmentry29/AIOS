import { randomUUID } from 'node:crypto';

const FOUNDER = 'human:founder';

export function baseProject(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: 'canonical_object',
    entity_subtype: 'project',
    name: 'a project',
    purpose: 'p',
    mission: 'm',
    vision: 'v',
    project_dna: {
      mission: 'm',
      core_principles: [],
      target_users: [],
      architectural_philosophy: 'a',
      quality_expectations: [],
      long_term_objectives: [],
      non_goals: [],
      governance_constraints: [],
    },
    project_status_history: [],
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: 'human',
    relationships: [],
    ...overrides,
  };
}

/**
 * SHELVED_PROJECT — the canonical no-aliasing fixture, REQUIRED BY NAME by ADR-0011
 * Consequence 4 and COM §5.4. Do not rename it; the ADR cites this identifier.
 *
 * A shelved project whose record is still live and whose phase says it already shipped:
 *
 *   project_status:  'archived'   — operationally shelved; nobody is working on it
 *   lifecycle_state: 'active'     — the RECORD is live and readable, NOT a terminus
 *   project_phase:   'operation'  — it shipped, and was running when it got shelved
 *
 * Every value is different and true, and NONE can be inferred from the others. The word
 * "archive" appears on all three axes with three different meanings, which is exactly
 * the trap: an implementation that aliases the axes — that reads project_status
 * 'archived' and concludes the record is archived, or derives lifecycle_state from
 * project_status — fails on this case AND ONLY ON THIS CASE. Every weaker combination
 * passes even when the aliasing bug is present. That is what makes it the one that
 * matters.
 */
export const SHELVED_PROJECT = baseProject({
  name: 'SHELVED_PROJECT',
  project_status: 'archived',
  lifecycle_state: 'active',
  project_phase: 'operation',
});

/**
 * Secondary case (ADR-0011 Consequence 4, SHOULD): a half-built project, currently
 * stopped. The weaker companion to SHELVED_PROJECT.
 */
export const PAUSED_MID_IMPLEMENTATION = baseProject({
  name: 'PAUSED_MID_IMPLEMENTATION',
  project_status: 'paused',
  lifecycle_state: 'active',
  project_phase: 'implementation',
});
