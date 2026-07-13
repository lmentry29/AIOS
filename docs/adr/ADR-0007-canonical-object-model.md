# ADR-0007 — Canonical Object Model

## Status
**Accepted** (2026-07-10) — **amended twice, both on 2026-07-13**: by [ADR-0010](ADR-0010-objective-canonical-object-subtype.md) as to **Objective**, and by [ADR-0011](ADR-0011-project-canonical-object-subtype.md) as to **Project**.

> **Read the Decision section below with both amendments in mind.** This ADR's Decision states: *"No sixth entity type is introduced. Mission, Objective, and Organizational Containers are reference/container fields, not entities."* **The second sentence is now partly superseded. The first is not.**
>
> **What is superseded:**
> - **Objective** (ADR-0010) is no longer a non-entity reference field. It is a **Canonical Object subtype** (`entity_subtype: 'objective'`), with identity, persistence, and an ADR-0003 lifecycle.
> - **Project** (ADR-0011) is no longer a non-entity container field. It is a **Canonical Object subtype** (`entity_subtype: 'project'`), on the same basis. Project nonetheless **remains an Organizational Container** — it does not become a Work Hierarchy level, and must not carry `work_hierarchy_parent`.
>
> **What is NOT superseded, and is expressly reaffirmed by both amendments:**
> - **"No sixth entity type is introduced."** This is the load-bearing boundary and it is intact. Objective and Project are subtypes of the existing **Canonical Object** type via the open, additive `entity_subtype` mechanism (COM §12), exactly as Memory Object and Artifact are. The taxonomy remains **five** entity types.
> - **Mission** remains a non-entity reference field. The corpus specifies no field-level model for it, so promoting it would mean inventing its fields.
> - **The other eight Organizational Container types** — `program`, `release`, `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace` — remain non-entity container fields, for the same evidentiary reason.
>
> Both promotions are **evidence-led, not symmetry-led**: Objective and Project each have a field-level specification in the corpus (Part VI Ch.4; Part XI). Mission and the other eight containers do not.
>
> The Decision text below is left **verbatim as the historical record** of what was ratified on 2026-07-10, per this ADR's own Consequences section ("amended, not silently superseded"). Do not read it as current status without this note.

## Context
ADR-0001 through ADR-0006 establish *that* AIOS has a ten-layer stack, three execution loops, a unified entity lifecycle, a Work Hierarchy distinct from Organizational Containers, resolved naming, and a cross-cutting Founder Intelligence capability. None of them establish what fields exist on an entity, what an entity is made of, or how entities reference each other — the gap between certified architecture and a database schema, an API contract, or a runtime type.

`docs/engineering/canonical-object-model.md` (produced as an engineering-readiness artifact following V1 certification, see `docs/process/v1-final-certification-report.md` §5) closes that gap. It formalizes ADR-0003's five lifecycle-bearing entity types (Agent, Task, Workflow, Plugin, Canonical Object) into one shared base schema (`CanonicalEntity`) plus per-type specializations, introducing no new entity types and no architectural principle beyond what ADR-0001–0006 already established.

## Decision
The Canonical Object Model, as documented in full in `docs/engineering/canonical-object-model.md`, is ratified as the canonical bridge from the accepted architecture to implementable code. In summary:

- Every Agent, Task, Workflow, Plugin, and Canonical Object instance extends one abstract base schema (`CanonicalEntity`): identity, lifecycle (per ADR-0003), provenance, hierarchy/container references (per ADR-0004 Amendment A — the two reference groups are never merged), ownership, relationships, and access/audit fields.
- No sixth entity type is introduced. Mission, Objective, and Organizational Containers are reference/container fields, not entities. Action is a non-lifecycle sub-object within a Task's Active stage, not an independently tracked entity.
- Memory Object and Artifact are modeled as Canonical Object specializations via an open `entity_subtype` field, not as peer types.
- Plugin is explicitly flagged as the lowest-confidence part of the model — no field-level Plugin specification exists anywhere in the certified corpus, so it is modeled provisionally from the Tooling Ecosystem's Adapter/Tool concepts.
- Access/authorization, the Event Model, and the Capability Model are typed as open placeholders, not resolved — no governance mechanism has existed since ADR-0003 deprecated SEF/ADM/ARB-ERB-CRB, and inventing one now would be a founder-level product decision, not an engineering-readiness task.

The full field-level schema, ownership model, relationship model, identity scheme, serialization format, persistence model, and inheritance rules are **not restated here** — `docs/engineering/canonical-object-model.md` is the source of truth this ADR ratifies, not a document this ADR summarizes into a competing copy.

## Rationale
- Every field and boundary in the COM traces back to an accepted ADR or an explicitly-flagged extrapolation from the certified corpus — it introduces no invented architecture, which is why ratifying it as a formal ADR is appropriate rather than treating it as informal engineering guidance.
- Formalizing it closes the last blocking gap identified at V1 certification (`docs/process/v1-final-certification-report.md` §3, item 1: "Canonical Object Model not yet drafted") and unblocks schema, runtime-interface, state-machine, and API-contract work, all of which already depend on it.
- Ratifying via ADR rather than leaving it as a standalone "Proposed" engineering document matches this project's own established pattern (ADR-0004 Amendment A) of using the ADR mechanism for genuine architectural closure, and resolves the status inconsistency noted during repository initialization: downstream artifacts (schemas, runtime interfaces, state machines) already treated the COM as settled before this ADR existed.

## Consequences
- `docs/engineering/canonical-object-model.md` is now ADR-gated per `docs/process/repository-design-specification.md` §1.4/§1.5 — a PR touching `docs/architecture/` for a COM-level change requires this ADR to be amended, not silently superseded by an engineering PR.
- `packages/core/src/schema/*.ts` (Zod definitions, once written) is the implementation source of truth for the field-level shape this ADR ratifies at the conceptual level; `docs/engineering/canonical-object-model.md` remains design-intent documentation, not implementation source (see ADR-0009 §1.10).
- The Task/Canonical-Object storage boundary (`docs/engineering/runtime-interfaces.md` §5) remains explicitly open — this ADR ratifies the entity model, not that unresolved implementation question. It is deferred to the first vertical slice per `docs/engineering/implementation-playbook.md`.
- Plugin's field-level model remains flagged lowest-confidence and revisable without requiring an ADR amendment, provided any revision stays within the entity-taxonomy boundaries this ADR ratifies (five entity types, no sixth).

## Superseded Decisions
None directly superseded. This ADR ratifies content that was already consistent with ADR-0001 through ADR-0006; it does not overturn any prior decision.
