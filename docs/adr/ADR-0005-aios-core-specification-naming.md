# ADR-0005 — AIOS Core Specification Naming

## Status
**Accepted** (2026-07-09)

## Context
*AIOS Conformance Standard.md* (§1.5, definitions §, and elsewhere) cites an "AIOS Core Specification" as the authoritative document defining AIOS's architecture, concepts, behaviors, interfaces, and normative requirements, and states that all conformance claims are ultimately evaluated against it. No document by that exact name exists in the corpus. *AIOS Specification Project.md* itself states "the core specification is now complete" (line 7098), suggesting it considers itself that document, but this was never made explicit anywhere the Conformance Standard could cross-reference. The Appendix (Conformance Standard companion) also lists "AIOS Core Specification identified" as a checklist item without resolving what it refers to (Roadmap item 13).

## Decision
There will **not** be a new, separate "AIOS Core Specification" document. The existing ***AIOS Specification Project.md*** is hereby designated the **AIOS Core Specification**. Every reference to "AIOS Core Specification" anywhere in the corpus — normative or informal — resolves to this document.

## Rationale
- *AIOS Specification Project.md* already fulfills the description the Conformance Standard gives for the "Core Specification" (architecture, concepts, behaviors, interfaces, normative requirements) and already declares itself complete in that role.
- Inventing a fourth document would fragment authority further at exactly the moment the corpus is trying to consolidate it (Single Source of Truth), and would leave *AIOS Specification Project.md*'s purpose ambiguous.
- This is the "likely answer" the prior audit (Roadmap item 13) already flagged as probable; formalizing it removes the last unresolved document-identity question blocking Priority 0 closure.

## Consequences
- *AIOS Specification Project.md* SHOULD be retitled or subtitled to state explicitly, at its top, that it constitutes the AIOS Core Specification referenced throughout the standards family (as defined in *AIOS Conformance Standard.md*, "Definitions").
- All references to "AIOS Core Specification" in *AIOS Conformance Standard.md* (§1.5, Definitions, §2.5 precedence chain) and in *Appendix AIOS Conformance Standard.md* (checklist item "AIOS Core Specification identified") MUST be updated to cite *AIOS Specification Project.md* by name, or to a stable canonical title if the document is renamed.
- The Conformance Standard's §2.5 precedence chain, which currently ranks documents including AIOS-FND/COM/SEF/ADM/SAF that don't yet exist above itself (Roadmap item 2), should be revisited now that one of its referents (Core Specification) is confirmed to exist — this closes one leg of that circular-precedence problem but does not resolve the others (AIOS-FND, COM, SEF, ADM, SAF remain not-yet-ratified).
- Per Part XV Ch.2 vs. Conformance Standard §2.3 (D1 in the prior Roadmap), *AIOS Specification Project.md*, now formally the Core Specification, must still defer to *AIOS Conformance Standard.md* as the authoritative conformance vocabulary — this ADR does not reopen that decision.

## Superseded Decisions
None directly superseded; this ADR resolves an undefined reference rather than overturning a prior stated decision.
