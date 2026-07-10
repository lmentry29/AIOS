# AIOS Repository Design Specification

**Status: Definitive.** This is the document Claude Code executes against. It supersedes every prior repository-layout recommendation made during this project, including my own from the previous turn, wherever this document says something different — per explicit founder instruction not to optimize for preserving previous work.

**Self-critique applied before finalizing (the "would I build it this way from scratch" test):** three things changed from my last recommendation after actually designing this down to the tooling level:

1. **`AIOS-Object-Schemas.md`'s hand-written parallel JSON Schema + TypeScript is superseded, not just CI-guarded.** Last turn I recommended a CI check to catch drift between two hand-maintained artifacts. That's treating a symptom. The better fix is to not have two hand-maintained artifacts — TypeScript (Zod) becomes the single source in code, and JSON Schema is *generated* from it. This eliminates the drift class entirely instead of policing it. See §1.10.
2. **A concrete toolchain is chosen, not left open.** "npm or pnpm" and "add CI checks" without naming a package manager, build orchestrator, linter, or test runner isn't actually executable by Claude Code without it making its own judgment calls — which the founder explicitly doesn't want happening at the tooling layer, only at the architecture layer. §1.1–§1.9 now name specific tools with reasoning.
3. **The two largest reconciled documents (~150K + ~180K bytes) are flagged for eventual per-Part splitting for reviewability, but that split is explicitly deferred, not part of this initialization.** Splitting them now would be a large mechanical migration with real risk of introducing errors into certified content, for a diffability benefit that doesn't matter until someone is actually editing those files under PR review. Recommended as a follow-up task (good Ollama candidate, see `AI-DEVELOPMENT-PLAN.md`), not a blocker.

---

## 1. Repository Architecture

### 1.1 Complete repository tree

```
aios/
├── README.md
├── AGENTS.md
├── CLAUDE.md                      # one-line pointer to AGENTS.md, for Claude Code's own file-discovery convention
├── LICENSE                        # deferred — private repo, revisit if/when open-sourced
├── package.json                   # root workspace manifest, private: true
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                 # generated
├── turbo.json
├── tsconfig.base.json
├── biome.json
├── vitest.workspace.ts
├── .nvmrc
├── .gitignore
├── .gitattributes
├── .env.example
├── .github/
│   ├── CODEOWNERS
│   └── workflows/
│       ├── ci.yml                 # lint, typecheck, test, build — every PR
│       ├── schema-check.yml       # regenerate schemas, fail on diff
│       ├── conformance.yml        # run tests/conformance against docs/architecture
│       └── release.yml            # Changesets — version + publish on main
├── .changeset/
│   └── config.json
├── docs/
│   ├── adr/
│   │   ├── ADR-0001-canonical-layer-architecture.md
│   │   ├── ADR-0002-execution-loop-architecture.md
│   │   ├── ADR-0003-unified-lifecycle-model.md
│   │   ├── ADR-0004-canonical-work-hierarchy.md
│   │   ├── ADR-0005-aios-core-specification-naming.md
│   │   ├── ADR-0006-founder-knowledge-architecture.md
│   │   ├── ADR-0008-canonical-implementation-language.md     # new, formalizes TS/Node.js decision
│   │   ├── ADR-0009-repository-and-workspace-organization.md # new, formalizes this document's structure
│   │   └── index.md
│   ├── architecture/              # certified, ADR-gated, edited rarely
│   │   ├── specification.md
│   │   ├── conformance-standard.md
│   │   ├── appendix.md
│   │   ├── appendix-conformance-standard.md
│   │   └── normative-amendment-001.md
│   ├── engineering/                # living reference, changes as implementation proceeds
│   │   ├── canonical-object-model.md
│   │   ├── runtime-interfaces.md
│   │   ├── state-machines.md
│   │   ├── api-contracts.md
│   │   ├── developer-reference.md
│   │   └── implementation-roadmap.md
│   ├── process/                     # decision + status record, append-mostly
│   │   ├── reconciliation-changelog.md
│   │   ├── v1-final-certification-report.md
│   │   ├── ai-development-plan.md
│   │   └── ai-development-workflow.md
│   ├── ops/
│   │   └── environment-setup-log.md
│   └── archive/
│       ├── documentation-roadmap.md
│       ├── v1-completion-criteria.md
│       ├── engineering-readiness-report.md
│       ├── object-schemas-superseded.md
│       ├── vault-originals/            # optional, see Migration Plan §2 note
│       └── prior-manifests/
│           ├── project-manifest.md
│           ├── implementation-handoff.md
│           └── project-addition-package.md
├── packages/
│   ├── core/                      # @aios/core
│   ├── objects/                    # @aios/objects
│   ├── work-hierarchy/              # @aios/work-hierarchy
│   ├── containers/                   # @aios/containers
│   ├── agents/                        # @aios/agents
│   ├── tools/                          # @aios/tools
│   ├── learning/                        # @aios/learning
│   ├── orchestration/                    # @aios/orchestration
│   └── founder/                           # @aios/founder
├── schemas/
│   └── generated/                 # JSON Schema, generated from @aios/core's Zod definitions — never hand-edited
└── tests/
    ├── integration/
    └── conformance/
```

Each `packages/*` follows the same internal shape:

```
packages/core/
├── package.json          # name: "@aios/core"
├── tsconfig.json          # extends ../../tsconfig.base.json
├── src/
│   ├── index.ts
│   └── ...
└── tests/                  # unit tests live beside the package, not in a top-level tests/unit
```

**Note on `tests/`:** unit tests are colocated with their package (`packages/*/tests/`), not centralized — a unit test is package-owned and should move/delete with its package. `tests/integration` and `tests/conformance` are centralized at the repo root because they exist precisely to test *across* package boundaries, which no single package should own.

### 1.2 Directory responsibilities

| Directory | Owns | Change frequency | Review bar |
|---|---|---|---|
| `docs/adr/` | Architectural decisions | Rare — one per genuine decision | Founder-level, this is the whole point of an ADR |
| `docs/architecture/` | Certified corpus (Specification, Conformance Standard, Appendices, Amendment 001) | Rare — only via a new/amending ADR | Founder-level |
| `docs/engineering/` | Canonical Object Model, schemas design intent, runtime interfaces, state machines, API contracts, dev reference, roadmap | Routine — expected to change as implementation reveals friction | Normal PR review; escalate to ADR only if a change contradicts `docs/architecture/` |
| `docs/process/` | Changelog, certification report, AI development plan/workflow | Append-mostly | Normal PR review |
| `docs/ops/` | Environment/toolchain notes | As needed | Normal PR review |
| `docs/archive/` | Superseded/historical material, kept for provenance | Frozen — no edits, only additions of newly-archived material | N/A |
| `packages/*` | Implementation code | Continuous | Normal PR review |
| `schemas/generated/` | Machine-generated JSON Schema | Regenerated by CI/build, never hand-edited | N/A — generated artifact, see §1.10 |
| `tests/integration`, `tests/conformance` | Cross-package and cross-document correctness | Continuous | Normal PR review |

### 1.3 Package organization

Nine packages, npm-scoped `@aios/*`, matching `docs/engineering/runtime-interfaces.md`'s component boundaries and dependency graph exactly — no change to the boundaries themselves, only to naming and physical layout:

```
@aios/core  →  @aios/objects  →  @aios/{work-hierarchy, containers, tools, learning}  →  @aios/agents  →  @aios/orchestration  →  @aios/founder
```

Package manager: **pnpm**, via `pnpm-workspace.yaml`. Reasoning: native workspace protocol (`workspace:*` internal deps), content-addressable store (meaningfully lower disk usage than npm across 9 packages sharing dependencies), strictest node_modules layout (catches accidental undeclared-dependency bugs npm/yarn allow silently) — the strictness matters specifically because multiple AI models will be writing code across these packages, and npm's looser resolution would let a model accidentally depend on something it never declared, working locally and breaking elsewhere.

Build orchestration: **Turborepo**. Reasoning: understands the workspace dependency graph natively (matches `runtime-interfaces.md` §4's Mermaid graph), caches build/test/lint outputs so a change to `@aios/tools` doesn't re-run `@aios/core`'s test suite, and requires near-zero configuration for a graph this size. This is a genuinely new recommendation, not carried over from any prior turn — the dependency graph already existed conceptually in Tier 3, Turborepo just makes it operationally real.

### 1.4 Documentation organization & architecture-vs-engineering strategy

Two-tier documentation, enforced by directory (not just convention):

- **`docs/adr/` + `docs/architecture/` = architecture.** Changing anything here requires a new or amending ADR. This is the tier that was the subject of the entire ten-session reconciliation project — it earned its stability, and the directory boundary now protects it.
- **`docs/engineering/` = engineering.** Changing anything here is normal engineering work. If a change here reveals that something in `docs/architecture/` is actually wrong (not just under-specified), that's the trigger for a new ADR — exactly the escalation rule already established throughout this project, now given a physical location to enforce it (a PR touching `docs/architecture/` without a corresponding ADR reference is a review flag, see §1.5).

### 1.5 Ownership boundaries

`.github/CODEOWNERS` (even solo-maintained, this is useful — it turns "I should remember to review this carefully" into a GitHub-enforced PR annotation):

```
/docs/adr/            @founder
/docs/architecture/   @founder
/docs/engineering/     # no owner restriction — normal review
/packages/             # no owner restriction — normal review
```

Practical effect: any PR touching `docs/adr/` or `docs/architecture/` gets flagged for your direct attention regardless of who or what (Claude, Ollama) opened it — the one place automation doesn't get to self-approve.

### 1.6 Repository conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) — standard, tool-supported, and what Changesets expects.
- **AI attribution trailer:** every AI-authored commit includes a trailer, e.g. `Implemented-by: Claude` or `Implemented-by: Ollama/qwen2.5-coder:7b`, per `docs/process/ai-development-plan.md`'s per-package allocation. Cheap to add now, valuable later if a bug pattern traces back to one model's output systematically.
- **Package naming:** `@aios/<package>`, kebab-case directory names matching the package name exactly.
- **File naming in `docs/`:** lowercase-kebab-case, no `(reconciled)`/`(1)`-style suffixes — those suffixes existed to distinguish draft from final during reconciliation; in the repo there is only ever one canonical version per concept, so the suffix is dead weight going forward (see Migration Plan renames).

### 1.7 Versioning strategy

- **Software semver, starting at `0.1.0`**, tracked via **Changesets** (per-package changelogs, coordinated version bumps across the monorepo, standard tool for this exact pnpm+Turborepo shape). Explicitly distinct from "AIOS Architecture Version 1" — the architecture version and the software version are different axes and will diverge in practice (architecture could reach "Version 2" while software is still `0.4.x`, or vice versa).
- **ADR numbering** continues its existing sequence (next is ADR-0007, already reserved for the Canonical Object Model's formal ratification per `V1-FINAL-CERTIFICATION-REPORT.md` §5 — see Migration Plan for how ADR-0007/0008/0009 are handled).
- **Git tags** mark real milestones, not arbitrary time: `v0.1.0` at "vertical slice validated" (per `docs/engineering/implementation-roadmap.md` §4), not before.

### 1.8 Git workflow

Trunk-based: `main` is always buildable (CI-enforced), short-lived branches per package or per vertical slice, merged via PR even when self-reviewed (keeps history and CI checks consistent regardless of who — human or AI — opened the PR). No long-lived `develop` branch — unnecessary ceremony for this team size, the same reasoning ADR-0003 used to reject premature governance apparatus.

### 1.9 CI/CD recommendations

GitHub Actions, four workflows:

1. **`ci.yml`** (every PR and push to `main`): `pnpm install --frozen-lockfile` → `turbo lint typecheck test build`.
2. **`schema-check.yml`** (every PR touching `packages/core/src/schema/**`): regenerate `schemas/generated/**` from the Zod source, `git diff --exit-code` — fails the build if generated output doesn't match what's committed, which is only possible if someone hand-edited a generated file or forgot to run the generator. This is the concrete implementation of §1.10's single-source decision.
3. **`conformance.yml`** (every PR touching `packages/**` or `docs/architecture/conformance-standard.md`): runs `tests/conformance` against the current implementation.
4. **`release.yml`** (on merge to `main`): Changesets action — opens/updates a "Version Packages" PR, publishes on merge of that PR (internal-only publish target initially, since this isn't a public npm package yet — can point at a private registry or simply tag-and-skip-publish until there's a reason to actually distribute packages).

### 1.10 Generated artifacts vs. manual artifacts

**This is the one substantive change from every prior recommendation in this project, so it's called out on its own.**

Manual (source of truth, hand-edited): `packages/core/src/schema/*.ts` — Zod schema definitions. Zod is chosen because it's already the de facto standard for runtime-validated TypeScript in exactly this kind of application, and — critically — a single Zod schema definition gives you three things at once that `AIOS-Object-Schemas.md` previously hand-maintained as two separate artifacts: the TypeScript type (via `z.infer<>`), runtime validation (Zod's actual purpose), and a JSON Schema (via `zod-to-json-schema`). One source, three derived outputs, instead of two hand-written outputs that could silently disagree.

Generated (never hand-edited, regenerated by tooling, git-tracked so diffs are visible in PRs): `schemas/generated/*.json` — output of `zod-to-json-schema` run against `packages/core/src/schema/*.ts`.

`docs/engineering/canonical-object-model.md` and the now-archived `docs/archive/object-schemas-superseded.md` remain valuable as **design-intent documentation** — they explain *why* the fields exist and what they mean — but are no longer the implementation source. The Zod definitions in `packages/core` are.

---

## 2. Repository Migration Plan

Every significant file from this project, with an unambiguous verb. "Source" paths reference the outputs folder unless marked `[vault]`.

| # | File | Verb | Destination | Notes |
|---|---|---|---|---|
| 1 | `ADR-0001-canonical-layer-architecture.md` | Remain, Canonical | `docs/adr/` | No rename |
| 2 | `ADR-0002-execution-loop-architecture.md` | Remain, Canonical | `docs/adr/` | No rename |
| 3 | `ADR-0003-unified-lifecycle-model.md` | Remain, Canonical | `docs/adr/` | No rename |
| 4 | `ADR-0004-canonical-work-hierarchy.md` | Remain, Canonical | `docs/adr/` | No rename |
| 5 | `ADR-0005-aios-core-specification-naming.md` | Remain, Canonical | `docs/adr/` | No rename |
| 6 | `ADR-0006-founder-knowledge-architecture.md` | Remain, Canonical | `docs/adr/` | No rename |
| 7 | `ADR-index.md` | Remain, Canonical | `docs/adr/index.md` | Renamed, add entries for ADR-0007/0008/0009 |
| 8 | *(new)* ADR-0007 | Create, Canonical | `docs/adr/ADR-0007-canonical-object-model.md` | Ratifies the COM per `V1-FINAL-CERTIFICATION-REPORT.md` §5's own recommendation — content is `docs/engineering/canonical-object-model.md`'s decision summarized into ADR form, not rewritten from scratch |
| 9 | *(new)* ADR-0008 | Create, Canonical | `docs/adr/ADR-0008-canonical-implementation-language.md` | Formalizes TypeScript/Node.js as canonical language, per this session's founder decision |
| 10 | *(new)* ADR-0009 | Create, Canonical | `docs/adr/ADR-0009-repository-and-workspace-organization.md` | Formalizes this document's structure as the accepted decision |
| 11 | `AI-Development-Workflow.md` | Remain, Canonical | `docs/process/ai-development-workflow.md` | Renamed (lowercase) |
| 12 | `AIOS Conformance Standard (reconciled).md` | Remain, Canonical | `docs/architecture/conformance-standard.md` | Renamed — drop "(reconciled)," it's the only version now |
| 13 | `AIOS Specification Project (reconciled).md` | Remain, Canonical | `docs/architecture/specification.md` | Renamed. Flagged for future per-Part split (not part of this migration) |
| 14 | `AIOS-API-Contracts.md` | Remain, Canonical (provisional) | `docs/engineering/api-contracts.md` | Renamed (lowercase) |
| 15 | `AIOS-Canonical-Object-Model.md` | Remain, Canonical | `docs/engineering/canonical-object-model.md` | Renamed. Now design-intent doc; implementation source is `packages/core/src/schema/` |
| 16 | `AIOS-Developer-Reference.md` | Remain, Canonical | `docs/engineering/developer-reference.md` | Renamed. **Needs a content update** (not part of this migration, flag as first post-init PR) to reference the Zod-as-source decision, since it currently doesn't know about it |
| 17 | `AIOS-Documentation-Roadmap-reconciled.md` | Archive | `docs/archive/documentation-roadmap.md` | Renamed |
| 18 | `AIOS-Implementation-Roadmap.md` | Remain, Canonical (provisional) | `docs/engineering/implementation-roadmap.md` | Renamed |
| 19 | `AIOS-Object-Schemas.md` | **Superseded** | `docs/archive/object-schemas-superseded.md` | Superseded by §1.10's Zod-first approach. Retained for the design reasoning, not as an implementation source — say so at the top of the file |
| 20 | `AIOS-Runtime-Interfaces.md` | Remain, Canonical | `docs/engineering/runtime-interfaces.md` | Renamed |
| 21 | `AIOS-State-Machines.md` | Remain, Canonical | `docs/engineering/state-machines.md` | Renamed |
| 22 | `Appendix (reconciled).md` | Remain, Canonical | `docs/architecture/appendix.md` | Renamed |
| 23 | `Appendix-AIOS-Conformance-Standard-reconciled.md` | Remain, Canonical | `docs/architecture/appendix-conformance-standard.md` | Renamed |
| 24 | `ENGINEERING-READINESS-REPORT.md` | Archive | `docs/archive/engineering-readiness-report.md` | Point-in-time snapshot, superseded in relevance once implementation starts |
| 25 | `Normative Amendment 001 (reconciled).md` | **Delete** | — | Stray, untouched raw copy, not the real reconciled file |
| 26 | `Normative Amendment 001 (dedup-source).md` | **Delete** | — | Stray, empty test artifact |
| 27 | `Normative-Amendment-001-reconciled.md` | Archive | `docs/architecture/normative-amendment-001.md` | **Not** `docs/archive/` — despite being mostly Deprecated/Historical content, §19.13's ADR mechanism section is Canonical and this file is the one place it's documented at length; keeping it under `docs/architecture/` (not `docs/archive/`) preserves that it's still occasionally load-bearing, with its own internal status notices doing the rest of the classification work |
| 28 | `RECONCILIATION-CHANGELOG.md` | Remain, Canonical | `docs/process/reconciliation-changelog.md` | Renamed |
| 29 | `V1-COMPLETION-CRITERIA.md` | Archive | `docs/archive/v1-completion-criteria.md` | Renamed |
| 30 | `V1-FINAL-CERTIFICATION-REPORT.md` | Remain, Canonical | `docs/process/v1-final-certification-report.md` | Renamed |
| 31 | `test_write.md` | **Delete** | — | Debug artifact |
| 32 | `PROJECT-MANIFEST.md` | **Superseded**, Archive | `docs/archive/prior-manifests/project-manifest.md` | Superseded by this document's §2 |
| 33 | `IMPLEMENTATION-HANDOFF.md` | **Superseded**, Archive | `docs/archive/prior-manifests/implementation-handoff.md` | Superseded by this document's §4 |
| 34 | `AI-DEVELOPMENT-PLAN.md` | Remain, Canonical | `docs/process/ai-development-plan.md` | **Not superseded** — its per-package Claude/Ollama allocation content is a different concern from repo structure and remains valid |
| 35 | `PROJECT-ADDITION-PACKAGE.md` | **Superseded**, Archive | `docs/archive/prior-manifests/project-addition-package.md` | Superseded by this document's §3 |
| 36 | `obsidian-plus-plus-setup-log.md` `[vault]` | Remain, Canonical | `docs/ops/environment-setup-log.md` | Renamed |
| 37–42 | 6 vault originals `[vault]` (Specification, Conformance Standard, Appendix, Appendix-Conformance, Amendment 001, Documentation-Roadmap) | **Delete from Obsidian**, optional archive copy | `docs/archive/vault-originals/` (optional) | See note below |

**Note on row 37–42:** these 6 files should stop existing in the live Obsidian vault once the repo has their reconciled replacements — leaving superseded copies in the place most likely to be mistaken for current is exactly the drift risk this whole document exists to prevent. Whether to also keep read-only archive copies in the repo for provenance is optional and low-priority; if you want that, `CLAUDE-CODE-HANDOFF.md` §6 asks you for the real vault path before attempting it, since this session's read-only vault mount is not guaranteed to be the same location Claude Code sees on your actual filesystem.

---

## 3. Claude Project Curation

Final, intentionally smaller than every previous pass at this list. Included only where the value is "fast, compact, high-reuse context for a new AI session," not "complete coverage."

| File | Why included |
|---|---|
| `ADR-0001` through `ADR-0009` + index | The decision layer, by definition compact and high-reuse — this is what any new session needs first |
| `docs/engineering/canonical-object-model.md` | The single most-referenced design document for any implementation task |
| `docs/engineering/runtime-interfaces.md` | Needed for any task touching component boundaries or the dependency graph |
| `docs/engineering/state-machines.md` | Needed for any lifecycle-related task |
| `docs/engineering/developer-reference.md` | Literally the onboarding document — terminology table, coding standards, doc map |
| `docs/process/reconciliation-changelog.md` | The reasoning trail behind every ADR — valuable when a session needs to understand *why*, not just *what* |
| `docs/process/v1-final-certification-report.md` | Compact status record of what's certified and what isn't |
| `docs/process/ai-development-plan.md` | Needed for any session deciding which model should do a task |
| This document (`AIOS-Repository-Design-Specification.md`) | Repo orientation — supersedes needing the old manifests in context at all |

**Explicitly excluded, with reasoning:**

- `docs/architecture/specification.md` and `docs/architecture/conformance-standard.md` — hundreds of KB combined, consulted rarely, and every load-bearing rule from them is already restated more compactly in the ADRs and engineering docs. Including them would burn context budget on content a session will almost never need to quote verbatim.
- `docs/architecture/appendix*.md`, `normative-amendment-001.md` — same reasoning; Glossary terms that matter are already inline in `developer-reference.md`'s terminology table.
- `docs/engineering/api-contracts.md`, `implementation-roadmap.md` — explicitly provisional/fast-churning (§1.10's philosophy again: don't keep a curated copy of something expected to change before implementation has even validated it).
- `docs/archive/**` — archived by definition; a session needing archived material should read the repo directly, not carry it as standing context.
- `docs/ops/environment-setup-log.md` — machine-specific, low reasoning value for architecture questions; `ai-development-plan.md` already extracted the load-bearing facts (7B–13B/Q4 ceiling, specific model recommendations) into a form more useful for AI context than the raw log.

---

## 4. Repository Initialization Plan

Mechanical, ordered, no architectural decisions left open for whoever executes it.

1. **Confirm target location.** Get the real local path for the new repo root from the founder (not assumed — see `CLAUDE-CODE-HANDOFF.md` §1).
2. **Initialize git + GitHub.** `git init`, create the private GitHub repo, set `origin`.
3. **Root tooling files first**, before any content: `package.json` (private, workspaces), `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `vitest.workspace.ts`, `.nvmrc`, `.gitignore`, `.gitattributes`, `.env.example`, `.github/CODEOWNERS`.
4. **Install tooling.** `corepack enable`, `pnpm install` (establishes the lockfile against an otherwise-empty workspace).
5. **Create `docs/` tree** and migrate every file per the Migration Plan (§2) — copy from the outputs folder path, rename per the table, do not alter content during the move except the explicitly-flagged supersession notices (row 19).
6. **Draft and add ADR-0007, ADR-0008, ADR-0009** (§2 rows 8–10) — these are new but not new *decisions*; they formalize decisions already made in this conversation.
7. **Scaffold `packages/*`** — nine packages, each with `package.json` (`@aios/<name>`), `tsconfig.json` extending the base, an empty `src/index.ts`, and a `tests/` folder. No implementation logic yet — scaffolding only, per the founder's instruction that this handoff is structure, not implementation.
8. **Scaffold `schemas/generated/`** as an empty directory with a `.gitkeep` and a comment file explaining it's populated by `pnpm generate:schemas` once `@aios/core` has real Zod definitions — which is implementation work, not part of this initialization.
9. **Write `.github/workflows/*.yml`** per §1.9 — these will fail meaningfully (no packages have real content yet) until implementation begins; that's expected and correct, not a bug to fix during initialization.
10. **Write `README.md`, `AGENTS.md`, `CLAUDE.md`.**
11. **First commit.** One commit, matching `IMPLEMENTATION-HANDOFF.md`'s original reasoning (a snapshot of a completed planning phase, not incremental engineering history) — see `CLAUDE-CODE-HANDOFF.md` for exact message.
12. **Push to GitHub**, confirm CI runs (and fails gracefully on the empty packages — verify the failure is "no tests found," not a configuration error).
13. **Validation pass:** confirm every file in the Migration Plan landed at its specified destination, confirm the 3 marked-Delete files were not carried over, confirm no file was duplicated by accident.
14. **Report back to the founder** — repository URL, confirmation of the validation pass, and the two flagged-but-deferred follow-ups (Developer Reference content update per row 16, optional vault-originals archival per rows 37–42) as a short punch list, not as work already done.

This plan intentionally stops at scaffolding. The first real engineering decision — resolving the Task/Canonical Object storage boundary left open in `runtime-interfaces.md` §5 — belongs to the first implementation PR against `@aios/core`, not to repository initialization.
