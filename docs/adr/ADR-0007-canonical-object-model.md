# ADR-0007 — Canonical Object Model

## Status
**Accepted** (2026-07-10)

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
