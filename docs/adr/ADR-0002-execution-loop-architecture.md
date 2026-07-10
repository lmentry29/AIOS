# ADR-0002 — Execution Loop Architecture

## Status
**Accepted** (2026-07-09)

## Context
The corpus describes three execution loops in three separate locations, with no stated relationship between them:

- **Part VI Ch.2 / Appendix C Ch.4** — a loop describing overall runtime orchestration: how the system as a whole cycles through intake, dispatch, and coordination.
- **Part X Ch.4** — a loop describing an individual agent's behavior: planning, reasoning, execution, monitoring, completion.
- **Part VI Ch.10** — a loop describing how a Canonical Object moves through validation, mutation, persistence, synchronization, and archival.

The Priority 0 audit (Roadmap item 5) flagged these as unreconciled and asked whether they are genuinely conflicting or simply unlabeled views at different abstraction levels.

## Decision
The three loops are **not conflicting definitions of the same thing**. They are retained as three distinct, formally named loops operating at three different abstraction levels:

1. **System Execution Loop** (formerly Part VI Ch.2 / Appendix C Ch.4) — orchestration of the overall AIOS runtime: intake, dispatch, coordination across departments and agents.
2. **Agent Execution Loop** (formerly Part X Ch.4) — the lifecycle of an individual autonomous agent: planning, reasoning, execution, monitoring, completion.
3. **Object Lifecycle Loop** (formerly Part VI Ch.10) — the lifecycle of a Canonical Object: validation, mutation, persistence, synchronization, archival.

Each loop MUST be documented with an explicit scope statement naming which entity it governs (system, agent, or object), and each MUST state how it invokes or is invoked by the others (e.g., the System Execution Loop dispatches work that triggers Agent Execution Loops, which in turn mutate Canonical Objects governed by the Object Lifecycle Loop).

## Rationale
- Collapsing these into one loop would either over-constrain agent behavior to system-level orchestration semantics, or under-specify object persistence guarantees — neither is correct given how each is described independently elsewhere in the corpus.
- The three loops already operate on different subjects (the runtime, an agent, an object) and different verbs (orchestrate, reason, persist); this is a scope distinction, not a duplicate definition, and does not violate the Single Source of Truth or No Duplicate Definitions rules, provided each loop's scope is stated explicitly.
- This reconciliation is lower-cost than inventing a single unified loop: it requires labeling and cross-referencing, not redesign.

## Consequences
- All three loops MUST be documented together in one authoritative diagram (Core Architecture doc) showing their relationship, in addition to being described individually where they're used.
- Every existing reference to "the execution loop" (singular, unscoped) in the corpus MUST be updated to name which of the three is meant.
- The relationship diagram becomes a prerequisite for the Reference/API documentation, since API operations will map to one loop or another (e.g., agent-lifecycle endpoints → Agent Execution Loop; object CRUD → Object Lifecycle Loop).
- This decision does not resolve the separate Unified Lifecycle question (state machines for Agents/Tasks/Workflows/Plugins/Objects) — see ADR-0003. The Object Lifecycle Loop described here is the *loop*, not the *state machine*; ADR-0003 addresses the state machine that the Object Lifecycle Loop steps through.

## Superseded Decisions
None. This ADR reconciles three previously unlabeled, unrelated descriptions rather than superseding any of them.
