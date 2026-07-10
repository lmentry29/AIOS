# ADR-0001 — Canonical Layer Architecture

## Status
**Accepted** (2026-07-09) — amended 2026-07-09 per founder decision to correct layer count from 11 to 10.

## Context
Two incompatible layer stacks exist in the corpus:

- **9-layer stack** (*AIOS Specification Project.md*, Part II and Part XV Ch.6): Executive → Planning → Department → Execution → Memory → Infrastructure, with layering requirements ("Implementations MUST preserve the architectural layering... Lower layers SHALL NOT directly modify higher-layer policy") stated separately in Part XV.
- **11-layer stack** (*Appendix .md*, Appendix C Ch.2): Human Layer → Executive Governance → Planning & Reasoning Engine → Organizational Departments → Runtime Coordination Kernel → Memory Engine → Learning System → Tool Abstraction Layer → External Technologies → Compute/Network/Storage.

The 11-layer version adds an explicit **Human Layer** at the top, a **Learning System** layer between Memory and Tool Abstraction, and renames several layers for precision (e.g., "Infrastructure Layer" → "Compute / Network / Storage", "Execution Layer" → "Runtime Coordination Kernel"). It is the more recent and more complete of the two.

**Known gap:** Appendix C Ch.2 states the stack has "eleven logical layers" but its own diagram enumerates only ten.

**Founder resolution (2026-07-09):** confirmed as a documentation inconsistency, not an architectural omission. The canonical layer count is **ten**. No Security or Governance layer is to be invented to satisfy the stated count of eleven — the text is wrong, not the diagram.

## Decision
AIOS adopts the **10-layer architecture** (Appendix C Ch.2's diagram, text corrected to match) as the single canonical layer model. The 9-layer model (Part II / Part XV Ch.6 of the Specification Project) is **deprecated** and retained only as a historical/simplified reference, explicitly labeled as such wherever it appears.

The canonical stack, top to bottom:

1. Human Layer
2. Executive Governance
3. Planning & Reasoning Engine
4. Organizational Departments
5. Runtime Coordination Kernel
6. Memory Engine
7. Learning System
8. Tool Abstraction Layer
9. External Technologies
10. Compute / Network / Storage

Appendix C Ch.2's prose ("organized into eleven logical layers") MUST be corrected to read "ten logical layers." No new layer is introduced. Founder Intelligence is explicitly **not** a layer in this stack — see ADR-0006.

## Rationale
- The 11-layer model is a strict superset of the 9-layer model's concepts (department/execution/memory/infrastructure all map onto it) plus additions (Human Layer, Learning System) that are load-bearing elsewhere in the corpus — the Human Layer is presupposed by every founder-interaction section, and the Learning System is presupposed by the Memory Engine's stated evolution behavior.
- Preferring the more complete, more recently elaborated model avoids silently dropping architecture (Human Layer, Learning System) that other Parts already depend on.
- A single canonical count is a prerequisite for every downstream architecture diagram; maintaining two counts guarantees future contradiction.

## Consequences
- All documentation referencing "9 layers," "nine-layer architecture," "eleven layers," Part II's layer names, or Part XV Ch.6's layering requirements MUST be updated to reference the 10-layer stack and MUST cross-reference this ADR rather than restate the model.
- Part XV Ch.6's layering requirements ("MUST preserve layering," "SHALL NOT directly modify higher-layer policy," "layer boundaries MUST remain explicit") are **retained as normative** but re-scoped to the 10-layer stack; they are not superseded, only re-targeted.
- Appendix C Ch.2's stated count is a mechanical text fix (eleven → ten); no new layer content is required.
- Every subsequent architecture diagram in new documentation (Core Architecture, Developer Guide, Reference/API docs) must use this stack and this ADR's layer names verbatim.

## Superseded Decisions
- Part II and Part XV Ch.6 of *AIOS Specification Project.md* (9-layer model) — superseded as the canonical architecture; retained as historical reference only.
