# AIOS Documentation Completion — Reconciliation & Roadmap

> **Status: Historical / Superseded (2026-07-09).** This document served its purpose — it identified the Priority 0 punch list that produced ADR-0001 through ADR-0006 and drove the full corpus reconciliation. All 14 items in its punch list are now closed (see `RECONCILIATION-CHANGELOG.md`, which is the current living tracker). This document is preserved as the historical record of the original audit rather than edited further or deleted. Do not treat anything below as current status — check `RECONCILIATION-CHANGELOG.md` and the ADR files for that.

**Status:** Working document, Phase 7 output. Supersedes nothing yet — awaiting approval before Phase 8 (generation) begins.
**Basis:** Full-text audit of all 5 existing AIOS documents (16,790 lines, 100% read) — *AIOS Specification Project.md*, *AIOS Conformance Standard.md*, *Appendix .md*, *Appendix AIOS Conformance Standard .md*, *Normative Amendment 001 — AIOS Foundation Architecture.md*.

---

## 1. Decision Log

Four blocking architectural decisions were made before any new documentation could safely be planned. These override any conflicting statement in the existing documents.

| # | Question | Decision |
|---|---|---|
| D1 | Which conformance system is authoritative? | **Conformance Standard wins.** *AIOS Conformance Standard.md* becomes canonical. Part XV of *AIOS Specification Project.md* is deprecated as a conformance authority and either removed or rewritten as a non-normative summary that defers to the Standard. |
| D2 | Canonical Object Model (COM) — undefined but load-bearing. | **Draft it from context**, with a hard constraint: the draft must be derived only from what Parts VI–XIII and the Conformance Standard already imply. It must be labeled **Proposed / Derived**, and must not introduce capabilities, fields, or behaviors not already implied somewhere in the existing corpus. |
| D3 | Status of Normative Amendment 001 (SEF/ADM/SAF, Trust Boundary Model, ARB/ERB/CRB governance)? | **Draft only.** None of its content is treated as Established. Anything from it used going forward is labeled **Proposed**, and it must be cited as "per draft Amendment 001," not as settled architecture. |
| D4 | Roadmap priority? | **Fix contradictions first, then fill missing categories.** No net-new "Missing" category work (SDK, CLI, examples, install guide, etc.) starts until the Priority 0 reconciliation list below is closed, because that work would otherwise inherit unresolved ambiguity (e.g., which conformance vocabulary an SDK example should use). |

**Direct consequence of D1:** every place the Specification Project currently makes a conformance claim in its own vocabulary (informal MUST/SHOULD glosses in Part XV Ch.2) needs to be re-pointed at the Standard's RFC 2119/8174 vocabulary. This is not optional cleanup — it's required for D1 to actually resolve anything.

**Direct consequence of D2:** COM must be written *before* any Reference/API/Schema documentation, since API and schema docs are downstream of the object model they describe. This moves "Draft COM (Proposed)" to the top of Priority 1, not Priority 2.

**Direct consequence of D3:** Trust Boundary Model, SEF, ADM, SAF, and the ARB/ERB/CRB governance structure cannot be relied on as prerequisites elsewhere. Every place the Conformance Standard cites them as dependencies (§1.5, §2.2) needs a **Provisional Dependency Notice** until they're formally ratified — this is itself a documentation task, not just a labeling exercise.

---

## 2. Priority 0 — Reconciliation (must close before net-new docs)

This is the punch list from the Phase 5 consistency review, each item paired with the resolution direction implied by the Decision Log. Items are unordered within the list except where a dependency is noted.

1. **Conformance vocabulary conflict** (Part XV Ch.2 vs. Conformance Standard §2.3) — *Resolved by D1.* Action: rewrite/deprecate Part XV Ch.2's informal glosses to point at the Standard.
2. **Circular precedence chain** (Conformance Standard §2.5 ranks documents that don't exist above itself, contradicting its own §4.2 anti-supersession clause) — Action: until AIOS-FND/COM/SEF/ADM/SAF are ratified, §2.5's precedence order needs a footnoted exception clause, or it's self-contradicting in production.
3. **COM undefined but cited as authoritative by 3 documents** — *Addressed by D2*, but blocks Reference/API/Schema work until drafted.
4. **Layer-stack contradiction**: 9 layers (Part II / Part XV Ch.6) vs. 11 layers (Appendix C Ch.2, adds a Learning System layer, renames Infrastructure/Hardware) — Needs an explicit decision: which layer count is correct. **Not yet resolved — flagged below as an open question.**
5. **Three unreconciled top-level execution loops** (Part VI Ch.2/Appendix C Ch.4; Part X Ch.4; Part VI Ch.10) — Needs a single authoritative execution-loop diagram; currently unresolved.
6. **7+ independent lifecycle state machines** — the exact fragmentation Amendment 001 names as the problem it exists to fix, and doesn't. Since D3 marks Amendment 001 as draft-only, this problem is currently **unfixed and unowned**. Needs a decision on whether to revive Amendment 001's unification proposal or start fresh.
7. **Task/Action/Mission decomposition drift** across Glossary, Part X Ch.10, Part VII Ch.9, Part XI Ch.12 (at least 3 non-identical hierarchies) — Needs a single canonical hierarchy; Glossary should win per Appendix A's own stated precedence rule, but the other three sections then need rewriting to match.
8. **Founder-knowledge triplication** ("Founder Profile," "Founder Memory," "Founder Intelligence Layer" — Parts IV, V, VIII, XIV, overlapping and independently defined) — Needs a reconciling statement or a merge into one concept with clearly scoped sub-parts.
9. **"Agent" used constantly, never formally defined, absent from Glossary** — despite AIOS being characterized as an agent runtime. Needs a Glossary entry; likely the single highest-leverage one-line fix in the whole punch list.
10. **Reserved Terms list gaps** (Appendix A protected-term list omits "Autonomous Software Architecture," "Tooling Ecosystem," "Objective," which are equally load-bearing) — mechanical fix once the terms it does cover are stable.
11. **Amendment 001 self-duplication** (lines 1–350 repeated near-verbatim at 351–700) and abrupt ending — cosmetic but blocks anyone from citing it cleanly even as a draft.
12. **Governance apparatus duplication** (Amendment 001 Ch.19.8–19.10 ARB/ERB/CRB vs. Conformance Standard §23.6 "Certification Authority," no stated relationship) — deferred; low urgency since both are non-authoritative or draft-status per D1/D3, but will need resolution before Governance docs are written.
13. **"AIOS Core Specification" cited (Conformance Standard §1.5) as if it's a delivered document distinct from both the Specification Project and AIOS-FND** — it isn't. Needs either deletion of the reference or a decision that *AIOS Specification Project.md* IS the Core Specification (likely answer, but needs confirmation).
14. **Structural mismatch**: Specification Project promises its own appendices, which are actually delivered as a separate file — cosmetic, fix by cross-linking explicitly in both documents.

---

## 3. Condensed Coverage Matrix

Full 40-row matrix is in the Phase 3 output already delivered in-conversation. Condensed here to what's actually actionable for Priority 1/2 planning:

**Complete / usable as-is:** Runtime (Part VI), Memory Engine (Part VIII), Glossary (Appendix A, pending items #9–10 above), Best Practices (Part III, XII), Future Work / roadmap narrative.

**Partial — needs targeted fixes, not full rewrites:** Core Concepts, Execution Model, Scheduler (philosophy only, no algorithm), Agents (concept exists, term undefined), Plugin System (exists as Tool Abstraction Layer, unlabeled), Security (scattered, no threat model), Anti-patterns (generic, no concrete examples), Design Rationale/ADRs (template exists, zero actual ADRs).

**Missing outright:** Foundation (AIOS-FND), SDK, CLI, Configuration reference, Installation guide, Reference/API docs, worked Examples, Tutorials, Developer Guide, Contribution Guide (promised, never delivered), Release Process detail, FAQ, Troubleshooting, Known Limitations, Canonical Object Model (until D2 draft exists).

---

## 4. Roadmap

### Priority 0 (this phase) — Reconciliation
Items 1–14 above. Nothing in Priority 1 should start until the *architectural* items (4, 5, 6, 7, 8, 13) are either resolved or explicitly deferred with owner sign-off — labeling fixes (1, 2, 9, 10, 11, 14) can proceed immediately since they don't require new decisions.

**Rationale:** every downstream document (SDK, examples, API reference) will silently inherit whichever conflicting model happens to get used first. Fixing this after generation means rewriting generated docs, not just source docs — strictly worse than fixing it now, which is exactly what D4 says.

### Priority 1 — Core, high-impact
- Canonical Object Model draft (Proposed/Derived, per D2) — blocks everything below it
- Core Architecture (reconciled layer count, single execution loop diagram)
- Developer Guide
- Quick Start
- Implementation Guide
- Reference/API documentation (depends on COM)
- Conformance (already Complete under D1, but needs Part XV cross-reference cleanup)

**Rationale:** these are the documents an implementing engineer touches first and most often; per the mission's own success criterion ("another engineering team can build a compatible implementation using only the documentation"), these are the ones that make or break that test.

### Priority 2 — Ecosystem
- Plugin Development / Extension API (formalize Tool Abstraction Layer as the named plugin mechanism)
- SDK
- Worked Examples (currently zero across 16,800 lines — highest ROI item in this tier)
- CLI
- Configuration reference
- Security (threat model, auth, encryption — currently the thinnest major category)

**Rationale:** these make the spec *usable*, not just *implementable* — they're what separates "technically complete" from "a team would actually choose to build on this."

### Priority 3 — Governance & long-tail
- Governance (reconcile Amendment 001's ARB/ERB/CRB proposal against Conformance Standard §23.6, once both are ratified or one is dropped)
- Migration tooling/procedure
- Release Process
- FAQ
- Troubleshooting
- Known Limitations (currently absent — a spec claiming production-readiness with no stated limitations is a credibility problem, not just a documentation gap)
- Future Work (already Complete, low-touch)

---

## 5. Open Questions Not Yet Resolved

These weren't part of the four blocking decisions but will need answers before Priority 0 item resolution is complete:

**Architecture**
- Is the correct layer count 9 (Part II/XV) or 11 (Appendix C)? [item 4]
- Which of the three execution loops is authoritative, or do they describe different scopes (e.g., system-level vs. agent-level vs. object-level) that were never labeled as such? [item 5]
- Should Amendment 001's lifecycle-unification proposal be revived, or is a fresh unification effort warranted given D3 marked the amendment as draft-only? [item 6]

**Naming**
- Glossary as tiebreaker for Task/Action/Mission — confirm, since it changes three other Parts. [item 7]
- Is "AIOS Specification Project.md" itself the "AIOS Core Specification" the Conformance Standard cites, or is that a fourth document that hasn't been written yet? [item 13]

**Scope**
- Founder Profile / Founder Memory / Founder Intelligence Layer — one concept with three views, or three genuinely distinct systems that happen to share a name? [item 8]

---

## Next Step

Priority 0 labeling fixes (items 1, 2, 9, 10, 11, 14) can start immediately on approval — they don't require further input.

The architectural items (4, 5, 6, 7, 8, 13) need your call before Phase 8 generation touches anything downstream of them, since every one of them changes what the "correct" answer looks like in later documents.

---

## Resolution Status (added 2026-07-09, reconciliation closure)

Every item in this document's Priority 0 punch list is now closed. Full detail in `RECONCILIATION-CHANGELOG.md`.

| Item | Resolution |
|---|---|
| 1. Conformance vocabulary conflict | Resolved — *AIOS Specification Project.md* Part XV Ch.2 now defers explicitly to *AIOS Conformance Standard.md* §2.3. |
| 2. Circular precedence chain | Resolved — ADR-0005 identifies the Core Specification; §2.5 rewritten to mark AIOS-FND's rung explicitly vacant rather than silently assumed; SEF/ADM/SAF removed from the chain (deprecated). |
| 3. COM undefined but cited | Not yet drafted — still the next architectural deliverable (founder decision), tracked as open technical debt, not a documentation defect. |
| 4. Layer-stack contradiction (9 vs. 11) | Resolved — ADR-0001: canonical is 10 layers (founder-corrected the count; neither 9 nor 11 was right). |
| 5. Three unreconciled execution loops | Resolved — ADR-0002: System / Agent / Object Lifecycle Loops, formally distinguished and cross-referenced. |
| 6. 7+ lifecycle state machines | Resolved — ADR-0003: Unified Lifecycle Model, with Amendment 001's proposed mechanism (SEF/ADM/SAF/Trust Boundary/ARB-ERB-CRB) deprecated rather than revived. |
| 7. Task/Action/Mission decomposition drift | Resolved — ADR-0004 plus Amendment A: Work Hierarchy (Mission→Objective→Task→Action) vs. Organizational Containers (Project, Program, Release, etc.) as two distinct, non-competing categories. |
| 8. Founder-knowledge triplication | Resolved — ADR-0006: Founder Intelligence is a cross-cutting capability (Human Layer, Executive Governance, Memory Engine, Learning System), not a layer; Founder Profile/Memory/Context formally distinguished. |
| 9. "Agent" undefined | Resolved — formal Glossary entry added in *Appendix .md*. |
| 10. Reserved Terms gaps | Resolved — Reserved Terms list expanded from 14 to 24 entries. |
| 11. Amendment 001 self-duplication / abrupt ending | Resolved — duplicate removed (verified programmatically), closing section added, per-section status classification applied. |
| 12. Governance apparatus duplication (ARB/ERB/CRB vs. Certification Authority) | Resolved — ARB/ERB/CRB deprecated; Certification Authority stands as the sole governance mechanism. |
| 13. "AIOS Core Specification" undefined reference | Resolved — ADR-0005: it is *AIOS Specification Project.md*, no separate document. |
| 14. Structural mismatch (appendices promised, delivered separately) | Resolved — explicit cross-link added at the end of *AIOS Specification Project.md*. |

All items closed. This roadmap's job is done.
