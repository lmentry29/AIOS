# ADR-0017 — Mission as a Canonical Object Subtype

## Status

**Accepted** (2026-11-12). The owner approved the field model and additive migration.
The Mission schema and store are implemented in `@aios/core` and `@aios/work-hierarchy`;
host routes and durable Mission journaling are follow-on work. When this ADR was Proposed
(2026-11-10), the code still followed ADR-0010 and Mission was a typed reference.

## Context

ADR-0004 ratifies the order Mission → Objective → Task → Action. ADR-0010 deliberately
left Mission as a non-entity because the certified corpus specifies no field-level model
for it; promoting it without a source would mean inventing product semantics. The
blueprint now requires Mission to be a first-class part of the work hierarchy, so the
asymmetry between Mission and Objective is a real implementation blocker: a Task can point
at a Mission ID that no store can resolve.

At the same time, the Canonical Object Model forbids a sixth top-level entity type, and
AGENTS.md rule 4 forbids merging the Work Hierarchy with Organizational Containers. Any
resolution must preserve both constraints.

## Decision

1. **Mission becomes a Canonical Object subtype**, `entity_subtype: 'mission'`, exactly as
   Objective and Project are Canonical Object subtypes. It is not a sixth top-level
   entity type and must not be modeled as a container.
2. **Mission remains the top rung of the Work Hierarchy.** A Mission record may be the
   target of `work_hierarchy_parent` at level `'mission'`; it must not carry an
   `organizational_containers`-only substitute, and it must not be placed inside a
   Project record as a parent.
3. **The field model must be sourced before acceptance.** The accepted minimum is:
`name`, `purpose` (prose), `status`, `owner_id`, and append-only lifecycle history
inherited from `CanonicalEntity`. `status` is the base `lifecycle_state`; it is not a
second status axis. No schedule, budget, department, or container fields
   are added without a source and a separate decision.
4. **Storage follows the existing object-store seam.** A Mission is created and read
   through a canonical repository, not through a new database or the Obsidian vault.
   Operational Mission state is not Founder Intelligence and must not be written to the
   vault as a side effect.
5. **Migration is additive.** Existing `work_hierarchy_parent.level: 'mission'` references
   remain valid as typed references during a transition; a resolver may return “not
   found” rather than fabricate a Mission. No bulk rewrite of existing Tasks is allowed.
6. **Authorization is unchanged.** Creating or reading a Mission goes through the host's
   exact-match, default-deny policy; ownership is not a grant. No new action vocabulary is
   introduced by this ADR.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep Mission as a bare UUID forever | Leaves the top of the work hierarchy unresolvable and blocks a coherent Mission view. |
| Add Mission as a sixth canonical entity | Contradicts ADR-0007's taxonomy and would require a much larger amendment. |
| Promote Mission as an Organizational Container | Merges the Work Hierarchy with containers, the defect AGENTS.md rule 4 exists to prevent. |
| Store Mission only in Obsidian | Confuses operational hierarchy with Founder Intelligence and violates ADR-0014's boundary. |

## Consequences

- No Mission UI, API, scheduler, or store should be claimed until this ADR is accepted and
  the field model is reviewed.
- If accepted, the schema must be added to `packages/core`, generated JSON Schema must be
  regenerated, and lifecycle/conformance tests must cover the new subtype.
- The unresolved Mission model is recorded as a product gap rather than silently replaced
  by a Project or a free-text field.

## Tests required before acceptance

- Schema round-trip and lifecycle validation for `entity_subtype: 'mission'`.
- A Task's `work_hierarchy_parent` resolves to a Mission record, not a Project.
- A Mission cannot be used as an Organizational Container and a Project cannot be its
  work-hierarchy parent.
- Default-deny create/read tests through the host, with no ownership bypass.
- Durable-journal restart test for a Mission and its Task relationship.

## Evidence

Current code: `docs/engineering/canonical-object-model.md` §2b/§2c and
`packages/core/src/schema/task.ts`. No Mission schema or store exists. This ADR is
intentionally not marked Accepted.
