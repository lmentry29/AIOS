# Project Addition Package

Deliverable 4. Determines which files from this entire session become permanent Claude Project assets.

---

## ADD TO CLAUDE PROJECT

| Filename | Purpose | Why it matters | Canonical | Replaces existing file | Implementation depends on it |
|---|---|---|---|---|---|
| `ADR-0001-canonical-layer-architecture.md` | 10-layer stack decision | Root architectural decision — every layer reference in the corpus traces here | Yes | No | Yes |
| `ADR-0002-execution-loop-architecture.md` | Three execution loops | Governs Tier 3/4's component boundaries and state machines directly | Yes | No | Yes |
| `ADR-0003-unified-lifecycle-model.md` | 7-stage lifecycle, deprecates SEF/ADM/SAF | Base of every entity's `lifecycle_state` field | Yes | No | Yes |
| `ADR-0004-canonical-work-hierarchy.md` | Work Hierarchy vs. Organizational Containers | Governs the single most-corrected defect pattern in the corpus; directly shapes `work_hierarchy_parent`/`organizational_containers` schema fields | Yes | No | Yes |
| `ADR-0005-aios-core-specification-naming.md` | Resolves "Core Specification" naming | Small but load-bearing — referenced by the Conformance Standard's precedence chain | Yes | No | Yes |
| `ADR-0006-founder-knowledge-architecture.md` | Founder Intelligence as cross-cutting capability | Governs `founder` package design and the Founder Interface component | Yes | No | Yes |
| `ADR-index.md` | Index of all 6 ADRs to Roadmap items resolved | Fast lookup, avoids re-deriving resolution history | Yes | No | No (reference only) |
| `AIOS Specification Project (reconciled).md` | Fully reconciled Core Specification | The single largest source of truth in the whole project | Yes | Yes — vault original | Yes |
| `AIOS Conformance Standard (reconciled).md` | Fully reconciled conformance methodology | Governs the conformance test suite (`AI-DEVELOPMENT-PLAN.md` §2) | Yes | Yes — vault original | Yes |
| `Appendix (reconciled).md` | Fully reconciled Glossary/Roadmap/Reference Architecture | Terminology source of truth — every schema field name traces back to a Glossary entry here | Yes | Yes — vault original | Yes |
| `Appendix-AIOS-Conformance-Standard-reconciled.md` | Fully reconciled Conformance Matrix/Checklist | Needed for conformance test suite | Yes | Yes — vault original | Yes |
| `Normative-Amendment-001-reconciled.md` | De-duplicated Amendment 001 with section-level status | Historical/proposed material referenced by open items (AIOS-FND candidate content) | Yes | Yes — vault original | Partial (reference only, mostly Deprecated/Historical content) |
| `AIOS-Documentation-Roadmap-reconciled.md` | Original audit, marked Historical, resolution-mapped | Traceability record — shows every original issue and what closed it | Yes | Yes — vault original | No |
| `RECONCILIATION-CHANGELOG.md` | 10-session append-only audit log | The single record of every decision's reasoning across the whole project — irreplaceable if lost | Yes | No | No (reference/audit only, but critical) |
| `V1-FINAL-CERTIFICATION-REPORT.md` | Final certification package, ✅ verdict | Authoritative record that Version 1 is certified and why | Yes | No | No (reference only) |
| `AI-Development-Workflow.md` | General risk-based Claude/Ollama policy | Standing policy referenced by `AI-DEVELOPMENT-PLAN.md` | Yes | No | No (process guidance) |
| `AIOS-Canonical-Object-Model.md` | Tier 1 — entity taxonomy, base schema, ownership/relationship/identity/serialization/persistence/inheritance | Direct prerequisite for every implementation package | Yes | No | Yes — foundational |
| `AIOS-Object-Schemas.md` | Tier 2 — JSON Schema + TypeScript | Copy-pasteable into `schemas/` and `packages/core` directly | Yes | No | Yes |
| `AIOS-Runtime-Interfaces.md` | Tier 3 — component boundaries, service contracts, dependency graph | Defines package structure implementation will follow | Yes | No | Yes |
| `AIOS-State-Machines.md` | Tier 4 — Mermaid lifecycle diagrams | Reference for every lifecycle-transition implementation | Yes | No | Yes |
| `AIOS-API-Contracts.md` | Tier 5 — internal/plugin/event APIs | Starting point for API implementation, flagged provisional | Yes (provisional) | No | Yes, with expected revision |
| `AIOS-Developer-Reference.md` | Tier 6 — doc map, coding standards, terminology reference | Onboarding document for any future contributor or AI agent joining implementation | Yes | No | No (guidance) |
| `AIOS-Implementation-Roadmap.md` | Tier 7 — repo structure, build order, risk register | Directly informs `IMPLEMENTATION-HANDOFF.md`'s repo layout and first-slice recommendation | Yes (provisional) | No | Yes |
| `ENGINEERING-READINESS-REPORT.md` | Synthesis, ⚠ Ready with Minor Risks verdict | The single-document status check for "can implementation start" | Yes | No | No (reference only) |
| `PROJECT-MANIFEST.md` | This session's file inventory | Needed to execute the vault cleanup and know what exists | Yes | No | No |
| `IMPLEMENTATION-HANDOFF.md` | Action plan: repo structure, first slice, first commit, first milestone | Directly operational — the next thing you act on | Yes | No | Yes |
| `AI-DEVELOPMENT-PLAN.md` | Per-package Claude/Ollama allocation, grounded in real machine specs | Determines who/what builds each package | Yes | No | Yes |
| `obsidian-plus-plus-setup-log.md` | Machine/toolchain setup record | Source of truth for local-model constraints used throughout `AI-DEVELOPMENT-PLAN.md` | Yes | No | Yes (as reference, not as spec) |

---

## DO NOT ADD

| Filename | Why not |
|---|---|
| `AIOS Specification Project.md` (vault original) | Superseded by the reconciled version; keeping both invites drift and duplicate-source confusion |
| `AIOS Conformance Standard.md` (vault original) | Superseded |
| `Appendix .md` (vault original) | Superseded |
| `Appendix AIOS Conformance Standard .md` (vault original) | Superseded |
| `Normative Amendment 001 — AIOS Foundation Architecture.md` (vault original) | Superseded — contains the unfixed 476-line self-duplication |
| `AIOS-Documentation-Roadmap.md` (vault original) | Superseded — the reconciled version already preserves it in full as Historical, so nothing is lost by not adding the original separately |
| `Normative Amendment 001 (reconciled).md` | Stray byproduct of a write-restriction workaround — an untouched raw copy, not actually reconciled despite the filename. Adding this would be actively misleading. |
| `Normative Amendment 001 (dedup-source).md` | Empty test artifact, zero content |
| `test_write.md` | Debug artifact, 5 bytes, no content relevance |
| `V1-COMPLETION-CRITERIA.md` | Superseded in relevance by `V1-FINAL-CERTIFICATION-REPORT.md`; keep in vault archive folder but not worth a permanent project slot — it's a means-to-an-end document, not a reference anyone will consult during implementation |

---

## PROJECT IMPORT CHECKLIST

Import in this order — later items reference earlier ones, so importing out of order just means some cross-references won't resolve until the batch finishes, not that anything breaks.

1. Import all 6 ADRs + `ADR-index.md` (7 files).
2. Import the 6 reconciled canonical documents (§ADD TO CLAUDE PROJECT rows 8–13): Specification Project, Conformance Standard, Appendix, Appendix-Conformance, Normative-Amendment-001-reconciled, Documentation-Roadmap-reconciled.
3. Import `RECONCILIATION-CHANGELOG.md` and `V1-FINAL-CERTIFICATION-REPORT.md` together (the certification report references the changelog).
4. Import `AI-Development-Workflow.md`.
5. Import the Tier 1–7 engineering set as one batch, in this order (each depends on the previous): `AIOS-Canonical-Object-Model.md` → `AIOS-Object-Schemas.md` → `AIOS-Runtime-Interfaces.md` → `AIOS-State-Machines.md` → `AIOS-API-Contracts.md` → `AIOS-Developer-Reference.md` → `AIOS-Implementation-Roadmap.md`.
6. Import `ENGINEERING-READINESS-REPORT.md`.
7. Import `obsidian-plus-plus-setup-log.md`.
8. Import `PROJECT-MANIFEST.md`, `IMPLEMENTATION-HANDOFF.md`, `AI-DEVELOPMENT-PLAN.md`, `PROJECT-ADDITION-PACKAGE.md` (this file) — the four deliverables from this closing pass, last, since they reference everything above.
9. **Do not import** any file listed under DO NOT ADD.
10. In your Obsidian vault (separate from the Claude project, per `IMPLEMENTATION-HANDOFF.md` §2): perform the 6 replace operations, then move `V1-COMPLETION-CRITERIA.md` and `AIOS-Documentation-Roadmap-reconciled.md` to an archive folder, then manually delete the 3 stray files I flagged and cannot remove myself.

Once step 10 is complete, the architecture and engineering-readiness phase is fully closed, per your instruction — no further planning documentation should be generated after this checklist is executed.
