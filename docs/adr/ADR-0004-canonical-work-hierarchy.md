# ADR-0004 — Canonical Work Hierarchy

## Status
**Accepted** (2026-07-09) — **amended 2026-07-09** to add the Work Hierarchy vs. Organizational Containers distinction (Amendment A), resolving a deeper conflict found during corpus reconciliation than the original Decision covered. **Amendment A further amended 2026-07-13 by [ADR-0011](ADR-0011-project-canonical-object-subtype.md), as to Project only.**

> **The Work Hierarchy / Organizational Container split is NOT amended. It stands exactly as ratified.** Read this note before assuming otherwise — the split is the single most-corrected thing in this corpus (four separate fix locations, `docs/process/reconciliation-changelog.md`), and ADR-0011 was written specifically not to reopen it.
>
> **What ADR-0011 changed:** a **Project** is now a persisted, lifecycle-bearing record — a **Canonical Object subtype** (`entity_subtype: 'project'`) — rather than a bare id. Amendment A's claim that containers "are not themselves lifecycle-bearing execution units in the ADR-0003 sense" no longer holds for Project. Only its *backing* changed: from a reference to a real record.
>
> **What ADR-0011 did NOT change:** **Project remains an Organizational Container.** It does **not** become a rung of Mission → Objective → Task → Action, and a Project **must not** carry `work_hierarchy_parent`. Containers still "hold, group, or schedule"; the Work Hierarchy is still a strict tree of Mission → Objective → Task → Action. Merging the two remains the defect this Amendment exists to prevent (AGENTS.md rule 4).
>
> The other eight container types (`program`, `release`, `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace`) remain non-entity container fields — the corpus specifies no field-level model for any of them.
>
> Separately, [ADR-0010](ADR-0010-objective-canonical-object-subtype.md) (2026-07-13) made **Objective** a Canonical Object subtype. That does not amend this ADR: Objective's *position* in the Work Hierarchy, which is what this ADR ratifies, is unchanged. **Mission** remains a non-entity reference field with no backing record.

## Context
At least three non-identical decomposition hierarchies for units of work exist across the corpus: Appendix A (Glossary), Part X Ch.10, Part VII Ch.9, and Part XI Ch.12 of *AIOS Specification Project.md* (Roadmap item 7). Appendix A itself states a precedence rule making the Glossary the tiebreaker for terminology conflicts, but the other three sections have not been reconciled against it.

Appendix A's definitions (paraphrased from the source):
- **Mission** — organizational execution is initiated by Objectives, implying Mission sits above Objective as the outcome Objectives serve.
- **Objective** — "Objectives initiate planning" and "Objectives become executable plans without manual decomposition," implying Objective is the unit that decomposes into Tasks.
- **Task** — "Tasks consist of Actions."
- **Action** — "indivisible from the perspective of the Planning Engine."

## Decision
Appendix A Glossary is confirmed as the source of truth for the work hierarchy, per its own stated precedence rule. The canonical hierarchy is:

**Mission → Objective → Task → Action**

Definitions (canonical, superseding all conflicting phrasing elsewhere):
- **Mission** — the highest-level business outcome an organization (AIOS instance) pursues.
- **Objective** — a measurable milestone supporting a Mission; Objectives initiate planning and decompose into Tasks without requiring manual decomposition.
- **Task** — a logical unit of work; a Task consists of one or more Actions.
- **Action** — an atomic executable operation; indivisible from the perspective of the Planning Engine.

## Rationale
- Appendix A already claims tiebreaker authority for terminology; honoring that rule is lower-risk than adjudicating a fresh precedence order, and it directly satisfies the Single Source of Truth principle.
- The four-level hierarchy is consistent with the Agent Execution Loop (ADR-0002), where an agent's planning stage operates on Objectives/Tasks and its execution stage operates on Actions — no relabeling of the loop is required.

## Amendment A — Work Hierarchy vs. Organizational Containers (2026-07-09)

### Context for the amendment
The original Decision above assumed Part X Ch.10, Part VII Ch.9, and Part XI Ch.12 were simply *variant phrasings* of the same four-level hierarchy and could be mechanically rewritten to match it. Reconciliation work surfaced a deeper problem: those three chapters describe genuinely different, partially contradictory structures —

- Part VII Ch.9: Mission → Program → Project → Milestone → Feature → Task → Action
- Part X Ch.9–10: Objective → Mission → Work Package → ... (Objective *above* Mission — inverted relative to this ADR's Decision)
- Part XI Ch.12: Vision → Roadmap → Release → Milestone → Epic → Feature → Task → Action

Collapsing all of this to strict Mission → Objective → Task → Action would require deleting Project, Program, Milestone, Feature, Epic, Release, Roadmap, Vision, and Work Package as formal concepts — including "Project," which an entire ~580-line Part (XI, *Project Operating System*) is built around. Founder decision: do not delete Project as a first-class concept.

### Amendment decision
The corpus conflates two different kinds of thing that must be kept distinct:

1. **Work Hierarchy** (execution-scoped, this ADR's original Decision, unchanged): **Mission → Objective → Task → Action.** This is the hierarchy the Agent Execution Loop, Object Lifecycle Loop, and any Reference/API work-item types operate on. It answers "what is being executed and at what granularity."

2. **Organizational Containers** (planning/organizational-scoped, new): **Vision, Roadmap, Program, Project, Release, Milestone, Epic, Feature, Workspace,** and similar terms found across Part VII, X, and XI are **not hierarchy levels**. They are organizational containers and planning constructs that *hold, group, or schedule* instances of the Work Hierarchy — a Project contains Missions and Objectives; a Roadmap sequences Releases which bundle Milestones; none of these are executable units in their own right, and none of them decompose into Actions directly.

The inversion in Part X ("Objectives are translated into Missions") is resolved as a **container relationship, not a hierarchy relationship**: an Objective, once approved, is *assigned to* a Mission-scoped container for execution tracking — it is not that Objective formally outranks Mission in the Work Hierarchy. Part X Ch.9–10 must be rewritten so "translated into" becomes "assigned to" or equivalent container language, removing the appearance of hierarchy inversion.

Any term in the Organizational Containers list MAY be nested inside another (Program contains Projects; Roadmap sequences Releases) using whatever structure is useful for planning, but that nesting is explicitly **not** part of the canonical Work Hierarchy and MUST NOT be described using Work Hierarchy language (no container may be said to "decompose into" or be "the parent of" a Mission/Objective/Task/Action in the formal sense — it *contains* or *schedules* them).

### Rationale for the amendment
- Preserves Part XI's premise (Project as a first-class organizational unit) without contorting the four-level execution hierarchy to accommodate it.
- Resolves the Mission/Objective ordering conflict without picking a "winner" between Part VII and Part X — both were actually describing containers, not hierarchy, once "Mission" is read as a container-assignment target rather than a hierarchy rung in Part X's usage.
- Is a clarification of scope (what ADR-0004 governs vs. what it doesn't), not a new architectural principle — consistent with amending this ADR rather than opening ADR-0007, per founder direction.

## Consequences
- Part X Ch.9–10 MUST be rewritten: "Objectives are translated into Missions" → Objective assigned to a Mission container; Work Package reframed as a container-level breakdown aid, not a Work Hierarchy level.
- Part VII Ch.9 MUST be rewritten: Program/Project/Milestone/Feature reframed as Organizational Containers; Mission → Task → Action remains as the Work Hierarchy skeleton running through the same chapter.
- Part XI Ch.12 MUST be rewritten: Vision/Roadmap/Release/Milestone/Epic/Feature reframed as Organizational Containers; Task → Action remains the Work Hierarchy tail.
- A new Glossary distinction (Appendix A) SHOULD be added: a short "Work Hierarchy vs. Organizational Containers" note alongside the existing Mission/Objective/Task/Action definitions, so future readers don't rediscover this ambiguity.
- The Reserved Terms list in Appendix A (Roadmap item 10) MUST be checked against both lists now — "Objective" for the Work Hierarchy, and "Project" (at minimum) for Organizational Containers, since Project is equally load-bearing as a protected term.
- Any Reference/API documentation exposing work-item types (e.g., a `Task` resource, an `Action` resource) MUST use Work Hierarchy terms; any documentation exposing planning/grouping resources (e.g., a `Project` resource, a `Milestone` resource) MUST be clearly scoped as Organizational Container types, not Work Hierarchy types, in any schema or API description.

## Superseded Decisions
- Part X Ch.10, Part VII Ch.9, and Part XI Ch.12 of *AIOS Specification Project.md* — their decomposition hierarchies are superseded as *hierarchy* claims, but their container vocabulary (Project, Milestone, Epic, etc.) is preserved and re-scoped as Organizational Containers rather than deleted.
