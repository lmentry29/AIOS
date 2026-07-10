# AIOS Project Manifest

Complete inventory of every file touched by this project — the original vault (read-only source), and everything generated in my output folder. Classification legend:

- **Canonical** — the authoritative version of this content going forward; keep, use as-is.
- **Replace** — a generated file that should overwrite/replace a specific vault original.
- **Archive** — served its purpose, keep for historical record, not actively referenced going forward.
- **Deprecated** — formally superseded per an ADR; preserved, not deleted, not actively used.
- **Delete** — no value, safe to remove.
- **New** — has no vault original; a net-new addition to the project.

No architectural judgment is required to act on this table — every row is a mechanical file operation.

---

## A. Vault originals (`/docs/` — read-only source)

| File | Purpose | Status | Depends on | Replacement target |
|---|---|---|---|---|
| `AIOS Specification Project.md` | Original core specification, Parts I–XV | Replace | — | `AIOS Specification Project (reconciled).md` |
| `AIOS Conformance Standard.md` | Original conformance methodology | Replace | — | `AIOS Conformance Standard (reconciled).md` |
| `Appendix .md` | Original Glossary + Roadmap + Reference Architecture | Replace | — | `Appendix (reconciled).md` |
| `Appendix AIOS Conformance Standard .md` | Original Conformance Matrix / Certification Checklist | Replace | — | `Appendix-AIOS-Conformance-Standard-reconciled.md` |
| `Normative Amendment 001 — AIOS Foundation Architecture.md` | Original draft AIOS-FND proposal (self-duplicated, contains deprecated SEF/ADM/SAF) | Replace | — | `Normative-Amendment-001-reconciled.md` |
| `AIOS-Documentation-Roadmap.md` | Original Phase 7 audit / Priority 0 punch list | Replace | — | `AIOS-Documentation-Roadmap-reconciled.md` |
| `obsidian-plus-plus-setup-log.md` | Environment/toolchain setup record (machine specs, Ollama/9router/Fable5 config) — unrelated to the architecture corpus, never touched by reconciliation | Canonical | — | n/a — not replaced, used directly as source for `AI-DEVELOPMENT-PLAN.md`'s local-model recommendations |
| `ADR-0001-canonical-layer-architecture.md` through `ADR-0006-founder-knowledge-architecture.md`, `ADR-index.md` | Appear in the vault mount as of this session, matching the outputs-folder versions | Canonical | — | Already present; see §B for authoritative source copies |

---

## B. Generated files (outputs folder)

### B1. ADRs and index

| File | Purpose | Status | Depends on | Add to Claude project |
|---|---|---|---|---|
| `ADR-0001-canonical-layer-architecture.md` | 10-layer canonical stack | Canonical | — | Yes |
| `ADR-0002-execution-loop-architecture.md` | Three execution loops (System/Agent/Object) | Canonical | — | Yes |
| `ADR-0003-unified-lifecycle-model.md` | Unified 7-stage lifecycle; deprecates SEF/ADM/SAF/Trust Boundary/ARB-ERB-CRB | Canonical | ADR-0002 (loops it specializes) | Yes |
| `ADR-0004-canonical-work-hierarchy.md` | Mission→Objective→Task→Action + Amendment A (Work Hierarchy vs. Organizational Containers) | Canonical | — | Yes |
| `ADR-0005-aios-core-specification-naming.md` | Resolves "Core Specification" to *AIOS Specification Project.md* | Canonical | — | Yes |
| `ADR-0006-founder-knowledge-architecture.md` | Founder Intelligence as cross-cutting capability, not a layer | Canonical | ADR-0001 (clarifies it's not layer 11) | Yes |
| `ADR-index.md` | Maps all 6 ADRs to the Roadmap items they resolve | Canonical | All 6 ADRs | Yes |

### B2. Reconciled canonical documents (vault replacements)

| File | Purpose | Status | Depends on | Add to Claude project |
|---|---|---|---|---|
| `AIOS Specification Project (reconciled).md` | Core Specification, fully reconciled against all 7 ADRs/amendments, every line read | Canonical / Replace | ADR-0001–0006 | Yes |
| `AIOS Conformance Standard (reconciled).md` | Conformance methodology, fully reconciled | Canonical / Replace | ADR-0003, ADR-0005 | Yes |
| `Appendix (reconciled).md` | Glossary + Roadmap + Reference Architecture, fully reconciled (new Agent/Project/Organizational Container entries) | Canonical / Replace | ADR-0001, ADR-0004 Amendment A | Yes |
| `Appendix-AIOS-Conformance-Standard-reconciled.md` | Conformance Matrix / Certification Checklist, fully reconciled | Canonical / Replace | ADR-0003 | Yes |
| `Normative-Amendment-001-reconciled.md` | Amendment 001 with duplication removed, sections classified Deprecated/Canonical/Superseded/Historical | Canonical / Replace | ADR-0003 | Yes |
| `AIOS-Documentation-Roadmap-reconciled.md` | Original audit, marked Historical, with Resolution Status table | Archive / Replace | All 6 ADRs (resolution mapping) | Optional — historical reference only |

### B3. Reconciliation process records

| File | Purpose | Status | Depends on | Add to Claude project |
|---|---|---|---|---|
| `RECONCILIATION-CHANGELOG.md` | Append-only audit log, all 10 sessions, every fix and rationale | Canonical | — | Yes — this is the audit trail for every decision above |
| `V1-COMPLETION-CRITERIA.md` | Definition of Done used to know when reconciliation was finished | Archive | — | Optional — historical reference, superseded in relevance by the certification report below |
| `V1-FINAL-CERTIFICATION-REPORT.md` | Final certification package: migration report, audit, tech debt, statistics, ✅ verdict | Canonical | RECONCILIATION-CHANGELOG.md | Yes |
| `AI-Development-Workflow.md` | Original general risk-based Claude/Ollama allocation policy | Canonical | — | Yes — general policy, not superseded by `AI-DEVELOPMENT-PLAN.md` (see §D) |

### B4. Engineering-readiness artifacts (Tiers 1–7)

| File | Purpose | Status | Depends on | Add to Claude project |
|---|---|---|---|---|
| `AIOS-Canonical-Object-Model.md` | Tier 1 — entity taxonomy, base schema, ownership/relationship/identity/serialization/persistence/inheritance | Canonical | All 6 ADRs | Yes |
| `AIOS-Object-Schemas.md` | Tier 2 — JSON Schema + TypeScript for all entity types | Canonical | AIOS-Canonical-Object-Model.md | Yes |
| `AIOS-Runtime-Interfaces.md` | Tier 3 — component boundaries, service contracts, module layout, dependency graph | Canonical | AIOS-Object-Schemas.md, ADR-0002 | Yes |
| `AIOS-State-Machines.md` | Tier 4 — Mermaid lifecycle diagrams, all 5 entity types + 3-loop sequence | Canonical | AIOS-Canonical-Object-Model.md §4 | Yes |
| `AIOS-API-Contracts.md` | Tier 5 — internal/plugin/event APIs (explicitly lower confidence) | Canonical (provisional) | AIOS-Runtime-Interfaces.md | Yes — flagged provisional in its own header, not excluded |
| `AIOS-Developer-Reference.md` | Tier 6 — document map, coding standards, terminology quick reference | Canonical | All Tier 1–5 artifacts | Yes |
| `AIOS-Implementation-Roadmap.md` | Tier 7 — repo structure, build order, critical path, risk register | Canonical (provisional) | AIOS-Runtime-Interfaces.md | Yes |
| `ENGINEERING-READINESS-REPORT.md` | Synthesis report, ⚠ Ready with Minor Risks verdict | Canonical | All Tier 1–7 artifacts | Yes |

### B5. Stray / debug files — no canonical value

| File | Purpose | Status | Depends on | Add to Claude project |
|---|---|---|---|---|
| `Normative Amendment 001 (reconciled).md` | Untouched raw copy, byproduct of the write-restriction workaround (Session 6) — **not** the correct reconciled file | Delete | — | No |
| `Normative Amendment 001 (dedup-source).md` | Empty test artifact from debugging the same write restriction | Delete | — | No |
| `test_write.md` | 5-byte debug artifact from testing outputs-folder write permissions | Delete | — | No |

**Note on deletion:** I do not have permission to delete files from the outputs folder (platform restriction, documented since Session 6). These three are flagged for you to remove manually; nothing else in this manifest requires manual deletion.

---

## C. Summary counts

- Vault originals to replace: 6
- Vault-external file, unaffected: 1 (`obsidian-plus-plus-setup-log.md`)
- New canonical ADRs: 6 + 1 index
- New canonical process records: 4 (changelog, completion criteria, certification report, AI dev workflow)
- New canonical engineering-readiness artifacts: 8
- Stray files to delete: 3
- **Total files with any canonical status: 26**
- **Total files to delete: 3**

---

## D. One artifact-placement note, per your instruction to flag anything stranded

`AI-Development-Workflow.md` (general, produced early) and `AI-DEVELOPMENT-PLAN.md` (per-package, produced as part of this deliverable set) are not duplicates and neither supersedes the other: the first is standing policy ("Claude for high-blast-radius, Ollama for lower-risk"), the second is that policy applied concretely to each of the nine implementation packages named in `AIOS-Implementation-Roadmap.md`. Both are Canonical. No other artifact from this conversation was found unintegrated or stranded — every Tier 1–7 engineering document is already positioned as its own standalone canonical file (that was the deliberate structure chosen when they were produced, per `AIOS-Developer-Reference.md`'s document map), so no additional integration work was needed here.
