# CLAUDE-CODE-HANDOFF.md

**This document is written for you, Claude Code, not for the founder.** You have filesystem access and will execute repository creation on the founder's local machine. Everything in this document is already decided — layer count, execution loops, lifecycle model, work hierarchy, implementation language, package manager, build tool, repo structure. Do not re-derive or second-guess these; execute them. The only judgment calls left for you are noted explicitly in §7, and they are operational (confirm a path, verify a step succeeded), not architectural.

Full reasoning for every decision below lives in `AIOS-Repository-Design-Specification.md`, in the same source folder as this file. Read it if you want the "why." This document tells you the "what" and "in what order," and should be sufficient on its own to execute correctly.

---

## 1. Source of truth for input files

All source files referenced below live at this path on the founder's Mac (confirmed persistent, not a temporary session path):

```
/Users/HOME/Library/Application Support/Claude/local-agent-mode-sessions/40d14eb4-a546-4617-86da-c3e2bf19537c/ea616f34-a26d-47ec-b823-d9a428973249/local_a72da1e5-2b42-4d82-b8b4-7c7024323dec/outputs/
```

Call this `SOURCE_DIR` below. Every filename referenced in §4's migration table exists in `SOURCE_DIR` unless marked `[vault]`.

**`[vault]`-marked files are different: `obsidian-plus-plus-setup-log.md` and the 6 original (pre-reconciliation) architecture documents live in the founder's actual Obsidian vault, not in `SOURCE_DIR`.** You do not know that path. **Ask the founder for it before touching anything vault-related** (§7, item 1). Everything else in this handoff does not depend on the vault path and can proceed without it.

## 2. Architectural decisions summary (context only — do not re-decide any of this)

- AIOS Architecture Version 1 is certified. All corpus documents fully reconciled.
- The Canonical Object Model (5 entity types: Agent, Task, Workflow, Plugin, Canonical Object) is accepted.
- TypeScript/Node.js is the canonical implementation language (ADR-0008).
- Single private GitHub repository, monorepo (ADR-0009).
- The Git repository is the sole source of truth. Obsidian is no longer authoritative for AIOS documentation.
- `docs/adr/` and `docs/architecture/` change only via ADR. `docs/engineering/` changes with normal engineering review.
- Package manager: **pnpm**. Build orchestrator: **Turborepo**. Linter/formatter: **Biome**. Test runner: **Vitest**. Schema/validation: **Zod**, with JSON Schema generated from it (not hand-written).
- Nine packages: `@aios/core`, `@aios/objects`, `@aios/work-hierarchy`, `@aios/containers`, `@aios/agents`, `@aios/tools`, `@aios/learning`, `@aios/orchestration`, `@aios/founder`.

## 3. Target repository location

**Ask the founder to confirm the local path for the new repo root before running any commands** (§7, item 2) — a prior message mentioned "a new local folder intended for implementation" but the exact path was never stated to you. Do not guess a path and do not create one under this session's temporary directories; this repo needs to live somewhere the founder's normal `git`/GitHub workflow can find it permanently.

Once confirmed, call that path `REPO_ROOT` for the rest of this document.

## 4. File migration table

Copy from `SOURCE_DIR` (or the vault, once its path is confirmed) to `REPO_ROOT`, renaming as specified. "Verb" tells you the operation.

| Source (`SOURCE_DIR/...` unless noted) | Verb | Destination (`REPO_ROOT/...`) |
|---|---|---|
| `ADR-0001-canonical-layer-architecture.md` | copy | `docs/adr/ADR-0001-canonical-layer-architecture.md` |
| `ADR-0002-execution-loop-architecture.md` | copy | `docs/adr/ADR-0002-execution-loop-architecture.md` |
| `ADR-0003-unified-lifecycle-model.md` | copy | `docs/adr/ADR-0003-unified-lifecycle-model.md` |
| `ADR-0004-canonical-work-hierarchy.md` | copy | `docs/adr/ADR-0004-canonical-work-hierarchy.md` |
| `ADR-0005-aios-core-specification-naming.md` | copy | `docs/adr/ADR-0005-aios-core-specification-naming.md` |
| `ADR-0006-founder-knowledge-architecture.md` | copy | `docs/adr/ADR-0006-founder-knowledge-architecture.md` |
| `ADR-index.md` | copy + rename | `docs/adr/index.md` |
| `AI-Development-Workflow.md` | copy + rename | `docs/process/ai-development-workflow.md` |
| `AIOS Conformance Standard (reconciled).md` | copy + rename | `docs/architecture/conformance-standard.md` |
| `AIOS Specification Project (reconciled).md` | copy + rename | `docs/architecture/specification.md` |
| `AIOS-API-Contracts.md` | copy + rename | `docs/engineering/api-contracts.md` |
| `AIOS-Canonical-Object-Model.md` | copy + rename | `docs/engineering/canonical-object-model.md` |
| `AIOS-Developer-Reference.md` | copy + rename | `docs/engineering/developer-reference.md` |
| `AIOS-Documentation-Roadmap-reconciled.md` | copy + rename | `docs/archive/documentation-roadmap.md` |
| `AIOS-Implementation-Roadmap.md` | copy + rename | `docs/engineering/implementation-roadmap.md` |
| `AIOS-Object-Schemas.md` | copy + rename + prepend supersession notice (see §5) | `docs/archive/object-schemas-superseded.md` |
| `AIOS-Runtime-Interfaces.md` | copy + rename | `docs/engineering/runtime-interfaces.md` |
| `AIOS-State-Machines.md` | copy + rename | `docs/engineering/state-machines.md` |
| `Appendix (reconciled).md` | copy + rename | `docs/architecture/appendix.md` |
| `Appendix-AIOS-Conformance-Standard-reconciled.md` | copy + rename | `docs/architecture/appendix-conformance-standard.md` |
| `ENGINEERING-READINESS-REPORT.md` | copy + rename | `docs/archive/engineering-readiness-report.md` |
| `Normative-Amendment-001-reconciled.md` | copy + rename | `docs/architecture/normative-amendment-001.md` |
| `RECONCILIATION-CHANGELOG.md` | copy + rename | `docs/process/reconciliation-changelog.md` |
| `V1-COMPLETION-CRITERIA.md` | copy + rename | `docs/archive/v1-completion-criteria.md` |
| `V1-FINAL-CERTIFICATION-REPORT.md` | copy + rename | `docs/process/v1-final-certification-report.md` |
| `PROJECT-MANIFEST.md` | copy + rename | `docs/archive/prior-manifests/project-manifest.md` |
| `IMPLEMENTATION-HANDOFF.md` | copy + rename | `docs/archive/prior-manifests/implementation-handoff.md` |
| `AI-DEVELOPMENT-PLAN.md` | copy + rename | `docs/process/ai-development-plan.md` |
| `PROJECT-ADDITION-PACKAGE.md` | copy + rename | `docs/archive/prior-manifests/project-addition-package.md` |
| `AIOS-Repository-Design-Specification.md` | copy | `docs/process/repository-design-specification.md` |
| this file | copy | `docs/process/claude-code-handoff.md` (keep a copy in the repo for the record, after execution) |
| `[vault]` `obsidian-plus-plus-setup-log.md` | copy + rename, **only after path confirmed** | `docs/ops/environment-setup-log.md` |

**Do not copy** — leave in `SOURCE_DIR`, take no action:
- `Normative Amendment 001 (reconciled).md` — stray, superseded raw copy
- `Normative Amendment 001 (dedup-source).md` — stray, empty test artifact
- `test_write.md` — debug artifact

**Vault originals (6 files, `[vault]`, only after path confirmed per §7 item 1):** delete from the live Obsidian vault once their reconciled replacements exist in the repo (they are: *AIOS Specification Project.md*, *AIOS Conformance Standard.md*, *Appendix .md*, *Appendix AIOS Conformance Standard .md*, *Normative Amendment 001 — AIOS Foundation Architecture.md*, *AIOS-Documentation-Roadmap.md*). If the founder wants provenance copies kept, copy them to `docs/archive/vault-originals/` before deleting from the vault — ask which they want (§7 item 1), do not decide this yourself.

## 5. Content edits required during migration (not just file moves)

1. **`docs/archive/object-schemas-superseded.md`** — prepend this notice before the existing content:
   > **Superseded 2026-07-XX.** This document's hand-written JSON Schema and TypeScript definitions are superseded by `@aios/core`'s Zod schema definitions (`packages/core/src/schema/`), from which JSON Schema is now generated (see `schemas/generated/` and `docs/process/repository-design-specification.md` §1.10). Retained here for the original design reasoning, not as an implementation source.
2. **`docs/adr/ADR-0007-canonical-object-model.md`** (new file, create it) — write a standard ADR (Status/Context/Decision/Rationale/Consequences, matching the format of ADR-0001–0006) that formally ratifies the Canonical Object Model, summarizing `docs/engineering/canonical-object-model.md`'s decision. Do not re-derive the model — restate its already-accepted content in ADR form.
3. **`docs/adr/ADR-0008-canonical-implementation-language.md`** (new file, create it) — ADR formalizing TypeScript/Node.js as canonical, noting future SDKs/bindings in other languages are not precluded (per the founder's own stated framing when this was decided).
4. **`docs/adr/ADR-0009-repository-and-workspace-organization.md`** (new file, create it) — ADR formalizing this repository's structure (monorepo, pnpm/Turborepo/Biome/Vitest/Zod stack, docs/architecture vs. docs/engineering split) as the accepted decision.
5. **`docs/adr/index.md`** — add ADR-0007, ADR-0008, ADR-0009 entries following the existing format.

## 6. Repository scaffolding to generate (no prior file exists — write these fresh)

Follow `AIOS-Repository-Design-Specification.md` §1.1–§1.9 exactly for content/config of each:

- Root: `README.md`, `AGENTS.md`, `CLAUDE.md` (pointer to `AGENTS.md`), `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `vitest.workspace.ts`, `.nvmrc`, `.gitignore`, `.gitattributes`, `.env.example`.
- `.github/CODEOWNERS` (per spec §1.5), `.github/workflows/ci.yml`, `.github/workflows/schema-check.yml`, `.github/workflows/conformance.yml`, `.github/workflows/release.yml` (per spec §1.9).
- `.changeset/config.json` (Changesets init).
- Nine packages under `packages/`, each with `package.json` (name `@aios/<name>`), `tsconfig.json` extending root, empty `src/index.ts`, empty `tests/` folder. **Scaffolding only — no implementation logic.**
- `schemas/generated/.gitkeep` plus a short comment file noting this directory is populated by `pnpm generate:schemas` once `@aios/core` has real Zod definitions (that generation is implementation work, out of scope for this handoff).
- `tests/integration/.gitkeep`, `tests/conformance/.gitkeep`.

## 7. Judgment calls reserved for the founder — ask before proceeding

Ask these as direct questions before you touch the filesystem for the relevant step. These are operational parameters, not architecture — you're not being asked to make a decision, just to not guess one:

1. **Vault path and provenance-copy preference.** You need the real Obsidian vault path to migrate `obsidian-plus-plus-setup-log.md` and to optionally archive the 6 original documents before deleting them from the vault. Ask: "What's the path to your Obsidian vault, and do you want provenance copies of the 6 superseded originals kept in `docs/archive/vault-originals/`, or should I just confirm the reconciled replacements are correct and leave the vault deletion to you?"
2. **Target repo root path.** Ask: "What local path should the `aios` repository live at?" Do not create it under any temporary/session directory.
3. **GitHub repo creation.** Confirm you have (or the founder will provide) `gh` CLI authentication or equivalent before attempting `gh repo create`. If you can't create the GitHub remote yourself, scaffold everything locally, commit, and tell the founder exactly what to run to push it.

Everything else in this document is executable without further questions.

## 8. Ordered execution plan

1. Ask §7 items 1–3.
2. `git init` at `REPO_ROOT`; create the GitHub private repo; set `origin`.
3. Write all root tooling/config files (§6, root bullet).
4. `corepack enable && pnpm install` to establish the lockfile.
5. Create the full `docs/` tree and execute every row in §4's migration table (copies + renames).
6. Apply the 5 content edits in §5, including drafting ADR-0007/0008/0009.
7. Scaffold all 9 packages and `schemas/generated/` per §6.
8. Write `.github/workflows/*.yml` and `.changeset/config.json`.
9. Write `README.md`, `AGENTS.md`, `CLAUDE.md`.
10. Stage everything. Single commit:
    ```
    git commit -m "AIOS: initialize repository from certified Version 1 architecture + engineering-readiness artifacts

    - Architecture Version 1 certified; Engineering Readiness complete (see docs/process/)
    - 9 ADRs: canonical layers, execution loops, lifecycle model, work hierarchy,
      naming, founder knowledge, Canonical Object Model, implementation language,
      repository organization
    - docs/architecture (certified, ADR-gated) and docs/engineering (living reference) established
    - 9 packages scaffolded under packages/, no implementation logic yet
    - Tooling: pnpm + Turborepo + Biome + Vitest + Zod-first schema generation
    - This commit is documentation/scaffolding only"
    ```
11. Push to GitHub (or hand the founder exact push commands if remote auth isn't available to you).
12. Verify CI runs and fails only on "no tests found" / empty-package grounds, not on configuration errors — fix configuration errors, do not fix the expected empty-package failures.
13. Run the validation checklist in §9.
14. Report back per §10.

## 9. Validation checklist

- [ ] Every row in §4's migration table has a file at its destination path.
- [ ] The 3 not-copied files were not carried into the repo.
- [ ] `docs/adr/` contains 9 ADRs + `index.md`, index references all 9.
- [ ] `docs/archive/object-schemas-superseded.md` has the supersession notice prepended.
- [ ] `pnpm install` succeeds at repo root with no errors.
- [ ] `turbo build` runs (may produce "no packages to build" output — that's expected, not a failure) without configuration errors.
- [ ] CI workflows are present and triggered on the initial push.
- [ ] No file exists in two places with different content (spot-check a few against `SOURCE_DIR`).
- [ ] Git log shows exactly one commit.

## 10. Expected final state and report-back

Final repo state: full `docs/` tree populated per §4/§5, 9 scaffolded (empty) packages, complete tooling config, CI configured, one commit, pushed to a private GitHub remote.

Report to the founder: the repository URL, confirmation of §9's checklist, and this explicit punch list of deferred work (do not do these now, just name them):

- `docs/engineering/developer-reference.md` needs a content update to reference the Zod-as-source decision (it predates that decision).
- The two largest architecture documents (`specification.md`, `conformance-standard.md`) are flagged as future candidates for per-Part splitting to improve PR reviewability — not done now, low priority, good candidate for Ollama-driven mechanical work later.
- First real implementation decision — resolving the Task/Canonical Object storage boundary (`docs/engineering/runtime-interfaces.md` §5) — belongs to the first PR against `@aios/core`, not to this initialization.

**Do not proceed past step 14. Do not begin implementing package logic. Do not make any additional structural decisions not covered by this document — if you hit one, stop and ask, per §7's spirit even for cases not explicitly listed there.**
