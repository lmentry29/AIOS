# AIOS Implementation Handoff

Action-oriented companion to `PROJECT-MANIFEST.md`. That document classifies every file; this one tells you what to physically do and where to start building.

---

## 1. Files that should remain in the project (outputs folder)

All 26 files marked Canonical/Replace/Archive in `PROJECT-MANIFEST.md` §B1–B4. Nothing needs to be removed from the outputs folder itself — the "Delete" classification (§B5) refers to three stray files (`Normative Amendment 001 (reconciled).md`, `Normative Amendment 001 (dedup-source).md`, `test_write.md`) that I cannot delete myself (platform restriction) and that you can remove at your convenience; they carry no risk sitting there unused.

## 2. Files that should replace the originals in your Obsidian vault

| Replace this vault file... | ...with this file |
|---|---|
| `AIOS Specification Project.md` | `AIOS Specification Project (reconciled).md` |
| `AIOS Conformance Standard.md` | `AIOS Conformance Standard (reconciled).md` |
| `Appendix .md` | `Appendix (reconciled).md` |
| `Appendix AIOS Conformance Standard .md` | `Appendix-AIOS-Conformance-Standard-reconciled.md` |
| `Normative Amendment 001 — AIOS Foundation Architecture.md` | `Normative-Amendment-001-reconciled.md` |
| `AIOS-Documentation-Roadmap.md` | `AIOS-Documentation-Roadmap-reconciled.md` |

Everything else in the outputs folder (ADRs, changelog, certification report, all Tier 1–7 artifacts) has no vault original — add them to the vault as new files, don't use them to replace anything.

`obsidian-plus-plus-setup-log.md` is untouched and needs no action.

## 3. Files that should be archived

`V1-COMPLETION-CRITERIA.md` — its job (defining when reconciliation was done) is complete and its content is now redundant with `V1-FINAL-CERTIFICATION-REPORT.md`. Keep it for historical record of how "done" was defined at the time, but no implementation work should reference it going forward.

`AIOS-Documentation-Roadmap-reconciled.md` — already self-classified Historical in its own header; archive alongside the original it replaces rather than treating it as active guidance.

## 4. Files that should be deleted

`Normative Amendment 001 (reconciled).md`, `Normative Amendment 001 (dedup-source).md`, `test_write.md` — see `PROJECT-MANIFEST.md` §B5. I cannot delete these myself.

## 5. Final repository structure

Per `AIOS-Implementation-Roadmap.md` §1, unchanged here — repeated for handoff completeness:

```
aios/
├── packages/
│   ├── core/
│   ├── objects/
│   ├── work-hierarchy/
│   ├── containers/
│   ├── agents/
│   ├── tools/
│   ├── learning/
│   ├── orchestration/
│   └── founder/
├── schemas/
├── docs/                     # canonical architecture docs live here — see §6
└── tests/
    ├── unit/
    ├── integration/
    └── conformance/
```

## 6. Recommended repository layout for `docs/`

Not previously specified — added here since "repository layout" was asked for distinctly from "repository structure" above:

```
docs/
├── adr/                       # ADR-0001 through ADR-0006, ADR-index.md
├── architecture/              # the 6 reconciled canonical documents (§2 above)
├── engineering/                # AIOS-Canonical-Object-Model.md, AIOS-Object-Schemas.md,
│                                 AIOS-Runtime-Interfaces.md, AIOS-State-Machines.md,
│                                 AIOS-API-Contracts.md, AIOS-Developer-Reference.md,
│                                 AIOS-Implementation-Roadmap.md
├── process/                    # RECONCILIATION-CHANGELOG.md, V1-FINAL-CERTIFICATION-REPORT.md,
│                                 ENGINEERING-READINESS-REPORT.md, this file, PROJECT-MANIFEST.md
└── archive/                    # V1-COMPLETION-CRITERIA.md, AIOS-Documentation-Roadmap-reconciled.md
```

## 7. Recommended first implementation package

**`packages/core`** — per `AIOS-Implementation-Roadmap.md` §2's build order, it has zero dependencies and everything else depends on it. Implements `CanonicalEntity` and the base validation rules from `AIOS-Object-Schemas.md` §1 and §3.

## 8. Recommended first vertical slice

Unchanged from `AIOS-Implementation-Roadmap.md` §4, repeated here since it's the operative next action:

1. `core` — `CanonicalEntity` + base validation.
2. `objects` — Object Store, in-memory or SQLite persistence.
3. `work-hierarchy` — enough to create one Mission, one Objective, one Task.
4. `agents` — enough to run one Agent through the full lifecycle against that Task.
5. Stop. Log every place the real implementation diverged from Tiers 1–4. That divergence log is the input to whether the Task/Object storage boundary (`AIOS-Runtime-Interfaces.md` §5, still open) resolves as assumed.

## 9. Recommended first Git commit

A single commit establishing the docs/ tree and empty package skeletons, before any implementation logic:

```
git init
mkdir -p docs/{adr,architecture,engineering,process,archive} packages/{core,objects,work-hierarchy,containers,agents,tools,learning,orchestration,founder} schemas tests/{unit,integration,conformance}
# copy files per §6's layout
git add .
git commit -m "AIOS: import certified Version 1 architecture + engineering-readiness artifacts

- Architecture Version 1 certified (RECONCILIATION-CHANGELOG.md, V1-FINAL-CERTIFICATION-REPORT.md)
- 7 ADRs establishing canonical layer stack, execution loops, lifecycle model, work hierarchy
- Engineering-readiness Tiers 1-7: Canonical Object Model, schemas, runtime interfaces,
  state machines, API contracts, developer reference, implementation roadmap
- No implementation code yet — this commit is documentation/scaffolding only"
```

Deliberately one commit, not one-per-file — this is a snapshot of a completed planning phase, not a series of incremental engineering changes; the granular history that matters (nine reconciliation sessions, the certification process) already lives in `RECONCILIATION-CHANGELOG.md` and doesn't need to be replayed as separate Git commits.

## 10. Recommended first milestone

**"Vertical Slice Validated"** — completion criteria: the five-step sequence in §8 above is built and running, and the divergence log either confirms Tiers 1–4 as built or identifies specific, named corrections. This milestone is deliberately not "Package core complete" or "Package objects complete" — per this session's stated position throughout, a package being internally complete doesn't test whether the packages correctly integrate, and integration is exactly where doc-before-code risk (flagged repeatedly in the engineering-readiness artifacts) would surface first.
