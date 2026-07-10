# AIOS Implementation Roadmap (Tier 7) — Repo Structure, Build Order, Risk Register

**Status: Proposed — lowest confidence tier in this package**, by design (stated in this session's opening pushback): repo/build planning made before any code exists is the most likely tier to be revised once implementation starts.

**AI task allocation: Either** for structure/build order; **Human Review Required** for the risk register's prioritization, since risk tolerance is a founder judgment call, not an engineering one.

---

## 1. Repository structure

> **Superseded notice (added 2026-07-10, repository initialization / senior architecture review):** the tree below predates and conflicts with the structure the repository was actually built with. It is retained verbatim for historical continuity (this is what the tier documents were reasoning against at the time), but is **not** the structure to build against. Authoritative structure: `docs/process/repository-design-specification.md` §1.1 — notably `schemas/generated/` (not flat `schemas/`), unit tests colocated per-package at `packages/*/tests/` (not a top-level `tests/unit/`), and a six-way `docs/` split (`adr/architecture/engineering/process/ops/archive`, not the four-way split implied below). The build order, critical path, and risk register in the rest of this document (§2–§6) are unaffected by this correction and remain accurate.

Mirrors `AIOS-Runtime-Interfaces.md` §3's module boundaries directly — no new grouping invented.

```
aios/
├── packages/
│   ├── core/                # CanonicalEntity, base schemas (Tier 1/2)
│   ├── objects/              # Object Store
│   ├── work-hierarchy/       # Mission/Objective/Task/Action service
│   ├── containers/           # Organizational Container service
│   ├── agents/                # Agent Runtime
│   ├── tools/                  # Tool Abstraction Service
│   ├── learning/                # Learning Service
│   ├── orchestration/            # Orchestration Kernel
│   └── founder/                    # Founder Interface
├── schemas/                  # generated JSON Schema artifacts (source of truth: AIOS-Object-Schemas.md)
├── docs/                     # this artifact set + ADRs, copied/synced from the reconciled vault
└── tests/
    ├── unit/                 # per-package
    ├── integration/          # cross-package, especially work-hierarchy <-> objects (see open item, Runtime Interfaces §5)
    └── conformance/           # validates implementation against AIOS Conformance Standard
```

---

## 2. Build order (topological, per Runtime Interfaces §4's dependency graph)

1. `core`
2. `objects`
3. `work-hierarchy`, `containers`, `tools`, `learning` (parallelizable — no interdependencies among these four)
4. `agents`
5. `orchestration`
6. `founder`

---

## 3. Critical path

`core → objects → work-hierarchy → agents → orchestration`

This is the critical path because it's the only chain required to execute the simplest possible end-to-end scenario (a Task moves from Created to Completed under an Agent, dispatched by the Orchestration Kernel). `containers`, `tools`, `learning`, and `founder` are all reachable off this spine but not required for a first working vertical slice — recommend building the critical path first specifically so that the "validate the model against real implementation" step (this session's opening recommendation) happens as early as possible, before investing in the four non-critical-path packages.

---

## 4. Recommended first vertical slice

Not part of the founder's original tier list, added because it directly follows from this session's opening pushback and is the cheapest way to test whether Tiers 1–5 hold up:

1. Implement `core` (Tier 2's `CanonicalEntity` + validation rules from Tier 2 §3).
2. Implement `objects` with in-memory or SQLite persistence (Tier 1 §11).
3. Implement `work-hierarchy` enough to create one Mission, one Objective, one Task.
4. Implement `agents` enough to run one Agent through the full lifecycle (Tier 4 §2) against that one Task.
5. Stop. Compare what was actually built against Tiers 1–4. Log every place reality diverged from the spec.

That divergence log is more valuable than proceeding straight to `tools`/`learning`/`founder` — it's the fastest way to find out whether the Task/Object storage ambiguity (Runtime Interfaces §5) and the Plugin thinness (COM §4.4) are the only two soft spots, or whether there are others this document-only process couldn't have found.

---

## 5. Risk register

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| Task/Canonical Object storage ambiguity (Runtime Interfaces §5) resolves differently than assumed (Option B) | Medium | Medium | Contained — affects `objects`/`work-hierarchy` boundary only, not the rest of the graph. Recommended first-vertical-slice (§4) surfaces this early. |
| Plugin model (COM §4.4) is substantially wrong once a real Plugin is built | High | Low | Deliberately low-investment area; cheap to revise since nothing else depends on `tools` on the critical path. |
| No ratified access/authorization model | High | High if reached before implementation needs it; currently Low | Explicitly out of scope everywhere in this package (COM §6 item 1). Becomes a founder-level product decision the moment any multi-actor or external-facing feature is built — flag before that point, not after. |
| Event delivery guarantees undefined (API Contracts §3) | Medium | Medium | Depends on a broker choice not yet made; doesn't block the recommended first vertical slice, which has no cross-process event traffic. |
| Tiers 5–7 were produced before any implementation exists, per this session's opening pushback | Certain | Unknown until tested | Not a defect — a known characteristic of doc-first sequencing. Mitigated by §4's recommendation to build the critical path first and compare. |
| Single-founder project, no second reviewer for architectural decisions | Certain | Structural | Inherent to project stage, not a defect of this package — noted for completeness in the risk register, not something this document can mitigate. |

---

## 6. Implementation order recommendation

Follow §4's vertical slice before proceeding to full Tier 7 build-out. After the slice, resume the full build order (§2) informed by whatever the divergence log found.
