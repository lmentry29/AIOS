# AIOS Architecture Decision Records — Index

Phase 8 output. Resolves the six architectural open questions left unclosed by *AIOS-Documentation-Roadmap.md* (Priority 0, items 4, 5, 6, 7, 8, 13).

All six ADRs were amended 2026-07-09 to incorporate explicit founder decisions (layer count corrected to 10; Founder Intelligence confirmed cross-cutting, not a layer; Amendment 001 mechanism formally deprecated).

**Update (2026-07-10, repository initialization):** ADR-0007, ADR-0008, and ADR-0009 added, ratifying the Canonical Object Model, the canonical implementation language, and the repository/workspace organization respectively. ADR-0003 upgraded from Proposed to Accepted at the same time — see its own Status section for why. All six items listed below under "Still open after this batch" were in fact closed during the corpus reconciliation that followed this index's original creation; see `docs/process/reconciliation-changelog.md` and the Resolution Status table in `docs/archive/documentation-roadmap.md` for the full record. That section is left below unedited, as the historical record of what was still open at the time this index was written.

| ADR | Title | Status | Resolves Roadmap Item |
|---|---|---|---|
| [ADR-0001](ADR-0001-canonical-layer-architecture.md) | Canonical Layer Architecture | Accepted — **10 layers**, not 11 | Item 4 (9 vs. 11 layers) |
| [ADR-0002](ADR-0002-execution-loop-architecture.md) | Execution Loop Architecture | Accepted | Item 5 (three execution loops) |
| [ADR-0003](ADR-0003-unified-lifecycle-model.md) | Unified Lifecycle Model | **Accepted** (upgraded from Proposed 2026-07-10). SEF/ADM/SAF/Trust Boundary Model/ARB-ERB-CRB **deprecated**. | Item 6 (7+ lifecycle state machines) |
| [ADR-0004](ADR-0004-canonical-work-hierarchy.md) | Canonical Work Hierarchy | Accepted | Item 7 (Mission/Objective/Task/Action drift) |
| [ADR-0005](ADR-0005-aios-core-specification-naming.md) | AIOS Core Specification Naming | Accepted | Item 13 ("AIOS Core Specification" undefined) |
| [ADR-0006](ADR-0006-founder-knowledge-architecture.md) | Founder Knowledge Architecture | Accepted — cross-cutting, **not** a layer | Item 8 (Founder Profile/Memory/Intelligence triplication) |
| [ADR-0007](ADR-0007-canonical-object-model.md) | Canonical Object Model | Accepted (2026-07-10) | Ratifies `docs/engineering/canonical-object-model.md`; closes V1 certification's one blocking gap |
| [ADR-0008](ADR-0008-canonical-implementation-language.md) | Canonical Implementation Language | Accepted (2026-07-10) | Establishes TypeScript/Node.js as canonical |
| [ADR-0009](ADR-0009-repository-and-workspace-organization.md) | Repository and Workspace Organization | Accepted (2026-07-10) | Ratifies `docs/process/repository-design-specification.md`'s structure |

## Still open after this batch — HISTORICAL, ALL ITEMS BELOW ARE NOW RESOLVED

> **Corrected 2026-07-10, senior architecture review.** This section's heading previously read as current status with no inline marker, which a cold reader could reasonably (and incorrectly) take at face value — an internal contradiction with the "Update" paragraph above, which already says these were all closed. Every item below is resolved. Do not treat this section as a live punch list; it's kept verbatim as the historical record of what this index's author still saw as open on the day it was written. See `docs/process/reconciliation-changelog.md` and `docs/archive/documentation-roadmap.md`'s Resolution Status table for exactly how and when each item closed.

Closing the original six ADRs did **not**, on the day this index was written, close Priority 0 in full. At that time, still outstanding per the Roadmap:

- **Item 1** — Conformance vocabulary conflict (Part XV Ch.2 vs. Conformance Standard §2.3): mechanical rewrite, no new decision needed, not yet executed. *(Resolved during corpus reconciliation — see changelog.)*
- **Item 2** — Circular precedence chain in Conformance Standard §2.5: partially addressed by ADR-0005 (Core Specification now identified), but AIOS-FND, COM, SEF, ADM, SAF are still unratified and still create circularity. *(Resolved — COM ratified by ADR-0007; SEF/ADM/SAF formally deprecated by ADR-0003; AIOS-FND's vacancy explicitly documented rather than left circular.)*
- **Item 3 / D2** — Canonical Object Model is still undrafted. This blocks Reference/API/Schema documentation and is independent of the six ADRs above. *(Resolved — drafted and ratified as ADR-0007; see `docs/engineering/canonical-object-model.md`.)*
- **Item 9** — "Agent" is used throughout the corpus but has no Glossary entry. Flagged as the single highest-leverage one-line fix outstanding. *(Resolved during corpus reconciliation.)*
- **Item 10** — Reserved Terms list gaps ("Autonomous Software Architecture," "Tooling Ecosystem"; "Objective" flagged for addition per ADR-0004). *(Resolved during corpus reconciliation.)*
- **Item 11** — Amendment 001's self-duplication (lines 1–350 repeated at 351–700) and abrupt ending, per ADR-0003's Consequences. *(Resolved — duplication removed, see `docs/archive/prior-manifests` history and the reconciliation changelog.)*
- **Item 12** — Governance apparatus duplication (Amendment 001 ARB/ERB/CRB vs. Conformance Standard §23.6), explicitly deferred by ADR-0003. *(Resolved — ARB/ERB/CRB formally deprecated by ADR-0003; no duplication remains.)*
- **Item 14** — Structural cross-linking between *AIOS Specification Project.md* and its appendix files. *(Resolved during corpus reconciliation.)*

## Scope note
These six ADRs resolve the architectural *decisions*. They do not yet constitute the rewritten corpus — Part II, Part VI, Part VII, Part X, Part XI, Part XV of *AIOS Specification Project.md*, and the relevant sections of *AIOS Conformance Standard.md* and *Appendix .md*, still need to be edited to conform to them. That is the actual Priority 0 close-out and Priority 1 start (Canonical Object Model, Core Architecture doc) referenced in the Roadmap's "Next Step" section, and is a substantially larger editing pass than six ADRs — recommend scoping it as its own follow-on phase rather than folding it into this one silently.
