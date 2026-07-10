# ADR-0003 — Unified Lifecycle Model

## Status
**Accepted** (upgraded from Proposed on 2026-07-10 during repository initialization, per senior architecture review — every downstream artifact, including the Canonical Object Model and its ratifying ADR-0007, already treats this lifecycle model as settled; leaving it formally Proposed while building nine packages on top of it was an inconsistent status label, not a real hedge). Implementation-level details not yet exercised against real code (state transition triggers, persistence guarantees, rollback semantics) remain **Proposed / Derived** until the first vertical slice validates them — see the Consequences section below, which still applies. This ADR does not inherit authority from Normative Amendment 001, which remains Historical/Superseded and whose proposed mechanism is formally deprecated (see Decision, founder resolution 2026-07-09).

## Context
The corpus contains at least seven independent lifecycle state machines scattered across Agents, Tasks, Workflows, Plugins, and Canonical Objects, with no stated relationship between them (Roadmap item 6). *Normative Amendment 001 — AIOS Foundation Architecture* proposed a unification (SEF/ADM/SAF, Trust Boundary Model) intended to solve exactly this fragmentation, but Amendment 001 itself remains **Draft** status and is not authoritative (per prior decision D3 in the Documentation Roadmap), and additionally contains an internal defect: its content from lines 1–350 is duplicated near-verbatim at lines 351–700, and the document ends abruptly without a formal closing section.

The underlying problem Amendment 001 identified — that AIOS has no single lifecycle concept, only a scatter of incompatible ones — is accepted as real and unresolved independent of the amendment's own draft status.

## Decision
AIOS adopts **one canonical lifecycle model**, specialized per entity type rather than reimplemented per entity type. All of the following are treated as specializations of the same underlying state progression, not as independent state machines:

- Agents
- Tasks
- Workflows
- Plugins
- Canonical Objects

The canonical lifecycle stages, at the level shared by all five entity types, are:

**Created → Validated → Active → Monitored → Suspended (optional) → Completed → Archived**

Each entity type MAY add entity-specific sub-states or additional gates within a canonical stage (e.g., an Agent's "Active" stage specializes into planning/reasoning/execution/monitoring per the Agent Execution Loop in ADR-0002; a Canonical Object's "Active" stage specializes into mutation/persistence/synchronization per the Object Lifecycle Loop). No entity type may introduce a stage that cannot be mapped back to one of the seven canonical stages above.

This unification is **independent of Amendment 001**: it accepts the problem statement Amendment 001 raised but does not adopt Amendment 001's proposed mechanism as the solution.

**Founder resolution (2026-07-09):** the following are formally **deprecated**, not merely deferred, and MUST NOT be repaired, extended, or cited as available machinery in future documentation:

- **SEF** (Specification Evolution Framework)
- **ADM** (Architectural Dependency Model)
- **SAF** (Semantic Architecture Framework)
- **Trust Boundary Model**
- **ARB/ERB/CRB governance bodies**

Rationale for deprecation (founder-stated): AIOS is currently a single-founder project. Enterprise-style governance apparatus (review boards, formal change-control frameworks) adds process overhead disproportionate to a project with one decision-maker and no implementation yet. Future governance, if and when it's needed, should emerge from real operational experience and be proposed through future ADRs — not speculatively designed ahead of any implementation that would need it.

## Rationale
- A model that lets each entity type specialize a shared backbone reconciles the seven-way fragmentation without forcing every entity into identical semantics, which the prior independent state machines correctly recognized was necessary (an Agent's lifecycle genuinely differs from a Plugin's).
- Rejecting Amendment 001's specific mechanism (rather than just its draft status) keeps this ADR from inheriting an unratified, internally duplicated document's authority — the problem statement is separable from the proposed fix, and only the problem statement is accepted here.
- A shared backbone is the minimum structure needed to satisfy the Single Source of Truth rule: one canonical lifecycle definition, referenced and specialized, rather than five to seven independently defined ones.

## Consequences
- Every existing per-entity lifecycle description in the corpus MUST be rewritten to (a) reference this canonical model and (b) express its entity-specific behavior as a specialization of one of the seven canonical stages, not as an independent state machine.
- Any implementation detail derived from this canonical model (state transition triggers, persistence guarantees, rollback semantics) MUST be labeled **Proposed** until formally ratified, per the instruction that unratified material be explicitly marked.
- Amendment 001's duplication defect (lines 1–350 repeated at 351–700) and missing closing section MUST be fixed if the amendment is retained as a historical record; since its mechanism is now deprecated rather than merely draft, Amendment 001 should be re-labeled **Historical / Superseded** in its own header, not left as "Draft."
- Governance apparatus resolution: Amendment 001's ARB/ERB/CRB is deprecated by this ADR (see Decision). Conformance Standard §23.6's "Certification Authority" is unaffected by this deprecation and remains whatever status it independently holds — this ADR does not touch it. Roadmap item 12 (relationship between the two) is now moot for ARB/ERB/CRB specifically, since one side of that comparison no longer exists as live architecture.
- SEF/ADM/SAF and Trust Boundary Model MUST NOT be cited as dependencies anywhere in the corpus going forward (this closes the "Provisional Dependency Notice" concern raised for these specific items in the original Roadmap's D3 consequence, though AIOS-FND/COM remain separately unratified and still need their own notices).

## Superseded Decisions
- No prior ADR exists to supersede. This ADR supersedes the *absence* of a unified model.
- Normative Amendment 001's proposed mechanism (SEF, ADM, SAF, Trust Boundary Model, ARB/ERB/CRB) is **deprecated by founder decision**, not merely left in Draft status. Amendment 001's problem statement (lifecycle fragmentation) is preserved and is the basis for this ADR's Decision.
