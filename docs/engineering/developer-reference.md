# AIOS Developer Reference (Tier 6)

**Status: Proposed.** Companion index + coding standards for engineers/agents implementing against Tiers 1–5. Deliberately short — a developer reference should point at the authoritative artifacts, not restate them.

**AI task allocation: Either.**

---

## 1. Document map (read in this order)

1. `AIOS-Canonical-Object-Model.md` — what entities exist, their fields, ownership, relationships, identity, persistence, inheritance.
2. `AIOS-Object-Schemas.md` — JSON Schema + TypeScript for every entity type.
3. `AIOS-Runtime-Interfaces.md` — component boundaries, service contracts, module/package layout, dependency graph.
4. `AIOS-State-Machines.md` — Mermaid diagrams for every lifecycle.
5. `AIOS-API-Contracts.md` — wire format (lower confidence, expect revision).
6. This document — how to actually build against the above.
7. `AIOS-Implementation-Roadmap.md` (Tier 7) — repo structure, build order, risk register.

Architecture background, if a question isn't answered by 1–5: `ADR-0001` through `ADR-0006` (+ Amendment A), `RECONCILIATION-CHANGELOG.md`, `V1-FINAL-CERTIFICATION-REPORT.md`.

---

## 2. Coding standards

- **Every persisted type MUST extend `CanonicalEntity`** (Tier 2 §1). No entity bypasses the base schema, even for "just a quick internal record" — that's exactly the pattern that produced the original corpus's seven independent lifecycle state machines (ADR-0003's Context section).
- **Never merge `work_hierarchy_parent` and `organizational_containers` into one field, one table, or one function parameter.** This is the single most-corrected defect in the entire reconciliation project (four separate fix locations, per `RECONCILIATION-CHANGELOG.md`). If a code review sees these two concepts touching the same variable, that's a defect, not a style preference.
- **Never write to `lifecycle_history` or `relationships` in place.** Append-only, per Tier 1 §11–§12. An in-place edit to either field is a data-integrity bug, not a valid optimization.
- **Treat `access_policy` as an unimplemented dependency, not a TODO to fill in casually.** No governance model is ratified (ADR-0003 deprecated the only one that existed). If a PR needs real authorization logic, that's a signal to raise a founder-level product decision, not to invent a permission model inline.
- **Plugin-related code should be written expecting change.** COM §4.4 and API Contracts §2 both flag Plugin as the lowest-confidence entity in this package. Don't build multiple Plugins against the current contract before it's been validated against one real implementation.

---

## 3. Terminology quick reference (for anyone who hasn't read the ADRs)

| Term | Means | Does NOT mean |
|---|---|---|
| Work Hierarchy | Mission → Objective → Task → Action (ADR-0004) | Project, Program, Release, Milestone — those are Organizational Containers |
| Organizational Container | Project, Program, Release, Milestone, Epic, Feature, Roadmap, Vision, Workspace | A Work Hierarchy level — containers hold/schedule, they don't decompose |
| Canonical Object | ADR-0003's entity type; unifies what the Specification's Part VI Ch.10 separately called "Runtime Object" | A sixth entity type distinct from the other four |
| Founder Intelligence | Cross-cutting capability spanning Human Layer/Executive Governance/Memory Engine/Learning System (ADR-0006) | A layer in the ten-layer stack |
| Agent vs. Worker | Same `entity_id`; Worker is a role flag (`current_role`) an Agent holds during bounded execution | Two separate entity types |

---

## 4. Where to file disagreement

If implementation reveals that something in Tiers 1–5 is wrong — not "I'd have designed it differently" but "this contradicts itself" or "this can't actually be built as specified" — that's a genuine architecture-revealing-a-flaw situation per the founder's own stop condition, and warrants a note back to the founder, not a silent workaround. Everything else (naming preferences, whether a field should be optional vs. defaulted, route shape) is Tier-appropriate engineering judgment and doesn't need to escalate.
