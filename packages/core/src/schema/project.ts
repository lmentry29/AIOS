import { z } from 'zod';
import { ActorRef } from './base.js';
import { CanonicalObjectEntity } from './canonical-object.js';

// §5.4 Project — Canonical Object subtype, added by ADR-0011 (amending ADR-0007 and
// ADR-0004 Amendment A). NOT a sixth entity type: it specializes the existing Canonical
// Object type via the open, additive entity_subtype mechanism (§12), exactly as Memory
// Object, Artifact, and Objective do.
//
// Source: AIOS Specification Project Part XI (Project Operating System) — Ch.3
// (Identity), Ch.4 (DNA), Ch.6 (Lifecycle), Ch.7 (State), Ch.8 (Registry).
//
// PROJECT IS AN ORGANIZATIONAL CONTAINER, NOT A WORK HIERARCHY LEVEL. It does not
// occupy a position in Mission → Objective → Task → Action, and it must not carry
// work_hierarchy_parent — enforced by the refine at the bottom of this file. Merging
// the Work Hierarchy with Organizational Containers is the defect ADR-0004 Amendment A
// corrected in four separate places and that AGENTS.md rule 4 exists to prevent.
//
// Per §12's field-unification rule, five of Ch.3's eleven Identity fields are
// semantically identical to base-schema fields and are deliberately NOT redeclared:
//   Project Identifier   -> entity_id                   (§3.1)
//   Name                 -> name                        (§3.1)
//   Owner                -> owner_id / owner_type       (§7)
//   Creation Date        -> created_at                  (§3.3)
//   Organizational Scope -> organizational_containers[] (§3.4) — container nesting
// Two more map onto the status axes below (Status -> project_status, Lifecycle State ->
// project_phase). Redeclaring any of them is the re-fragmentation §12 forbids.

// --- Ch.4: Project DNA ---

/**
 * Project DNA — a nested VALUE OBJECT, not an entity. No independent entity_id, no
 * persistence of its own, no lifecycle. Embedded on the Project that owns it.
 *
 * Ch.4 calls this the project's "immutable characteristics" and its "constitutional
 * document." That immutability is a WRITE-TIME rule enforced in the persistence layer
 * (@aios/objects), not something Zod's static shape validation can express — the same
 * situation as Memory Object immutability (§5.1) and Objective definition immutability
 * (§5.3). See PROJECT_IMMUTABLE_FIELDS below.
 */
export const ProjectDna = z.object({
  mission: z.string(),
  core_principles: z.array(z.string()).default([]),
  target_users: z.array(z.string()).default([]),
  architectural_philosophy: z.string(),
  quality_expectations: z.array(z.string()).default([]),
  long_term_objectives: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  governance_constraints: z.array(z.string()).default([]),
});
export type ProjectDna = z.infer<typeof ProjectDna>;

// --- The three orthogonal status axes ---
//
// A Project carries THREE independent status axes. They are separate Zod enums with no
// shared type, no shared union, and no shared vocabulary type, deliberately:
//
//   lifecycle_state (base, §3.2, ADR-0003) — what state is this RECORD in?
//   project_status  (Ch.7)                 — what is this project DOING right now?
//   project_phase   (Ch.6)                 — how MATURE is this project's development?
//
// THE THREE VOCABULARIES COLLIDE IN FIVE PLACES. SHARED TERMINOLOGY DOES NOT MEAN
// SHARED MEANING:
//
//   archive/archived  — all THREE axes ('archived' terminus / operationally shelved /
//                       final developmental stage)
//   planning          — project_status + project_phase
//   retire/retired    — project_status ('retired') + project_phase ('retirement')
//   active            — lifecycle_state ('active') + project_status
//                       ('active_development')
//   validate/validation — lifecycle_state ('validated') + project_phase ('validation')
//
// NO AXIS MAY BE DERIVED FROM, DEFAULTED FROM, ALIASED TO, OR VALIDATED AGAINST
// ANOTHER. No shared enum type. No cross-axis string comparison. The canonical proof
// case is the SHELVED_PROJECT fixture (ADR-0011 Consequence 4): project_status
// 'archived' + lifecycle_state 'active' + project_phase 'operation' — a shelved project
// whose record is still live and whose phase says it already shipped. Every value is
// different and true; none can be inferred from the others.

/** Ch.7 — operational state. NOT lifecycle_state. NOT project_phase. */
export const ProjectStatus = z.enum([
  'initializing',
  'planning',
  'active_development',
  'maintenance',
  'paused',
  'blocked',
  'migrating',
  'archived',
  'retired',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * Ch.6 — developmental maturity. NOT lifecycle_state. NOT project_status.
 *
 * NOT MONOTONIC. Ch.6: "Projects may revisit earlier stages as new information
 * emerges." Unlike Objective promotion (ADR-0010), a backward transition is legal and
 * must not be rejected. No forward-only rule is enforced anywhere.
 */
export const ProjectPhase = z.enum([
  'concept',
  'research',
  'architecture',
  'planning',
  'implementation',
  'validation',
  'deployment',
  'operation',
  'evolution',
  'retirement',
  'archive',
]);
export type ProjectPhase = z.infer<typeof ProjectPhase>;

/**
 * Append-only history of project_status transitions.
 *
 * Required by Ch.7: "State transitions are explicit and auditable." Mirrors
 * LifecycleHistoryEntry's shape, and is governed by the same rule (AGENTS.md rule 5:
 * append-only, never written in place).
 *
 * There is deliberately NO project_phase_history. Ch.6 states no auditability
 * requirement, so inventing one would be unsourced structure (ADR-0011, Consequence 6).
 */
export const ProjectStatusHistoryEntry = z.object({
  status: ProjectStatus,
  entered_at: z.string().datetime(), // §10: ISO 8601 UTC, not epoch
  actor: ActorRef,
});
export type ProjectStatusHistoryEntry = z.infer<typeof ProjectStatusHistoryEntry>;

/**
 * The fields immutable after creation, enforced write-time by @aios/objects.
 *
 * Only project_dna. Ch.4 calls it the project's "immutable characteristics" and
 * "constitutional document." Everything else on a Project — including all three status
 * axes — is mutable; transitions are exactly what a Project is for.
 */
export const PROJECT_IMMUTABLE_FIELDS = ['project_dna'] as const;

const ProjectEntityShape = CanonicalObjectEntity.extend({
  entity_subtype: z.literal('project'),

  purpose: z.string(),
  // PROSE, not references. `mission` is a mission *statement*, not a Work Hierarchy
  // Mission; `vision` is a vision *statement*, not a `vision` container reference. This
  // is load-bearing, not pedantic: modeling either as a reference would hang a Work
  // Hierarchy level / container onto an Organizational Container. Ch.4's Project DNA
  // lists "mission" alongside "core principles" and "non-goals", which are
  // unambiguously prose; Ch.3 uses the same register.
  mission: z.string(),
  vision: z.string(),

  project_dna: ProjectDna,

  project_status: ProjectStatus,
  project_phase: ProjectPhase,
  project_status_history: z.array(ProjectStatusHistoryEntry).default([]),
});

/**
 * A Project must NOT occupy a Work Hierarchy position. Same mechanism AgentEntity uses
 * (§4.1) — an Agent acts on Tasks rather than sitting in the hierarchy, and a Project
 * holds work rather than being a rung of it.
 */
export const ProjectEntity = ProjectEntityShape.refine(
  (p: z.infer<typeof ProjectEntityShape>) => p.work_hierarchy_parent === undefined,
  {
    message:
      'A Project is an Organizational Container, not a Work Hierarchy level — it must not carry work_hierarchy_parent (ADR-0004 Amendment A, ADR-0011, COM §2d)',
  }
);
export type ProjectEntity = z.infer<typeof ProjectEntity>;
