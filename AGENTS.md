# AGENTS.md — instructions for AI agents working in this repository

This file is the entry point for any AI agent (Claude, Ollama-based local models, or
otherwise) working in this repository. If you are implementing a package, read
[`docs/engineering/implementation-playbook.md`](docs/engineering/implementation-playbook.md)
next — it is the primary implementation entry point and consolidates the guidance below
into build order, milestones, and Definition of Done per phase.

## What this repository is

AIOS's architecture and engineering-readiness planning are complete and certified
(`docs/process/v1-final-certification-report.md`). This repository is where that
architecture becomes running code. As of repository initialization, **no package contains
implementation logic** — everything under `packages/*/src/` is a scaffold.

## Rules that apply to every change

1. **`docs/adr/` and `docs/architecture/` change only via a new or amending ADR.**
   `.github/CODEOWNERS` flags any PR touching them regardless of who or what opened it.
   If implementation reveals that something in `docs/architecture/` is wrong (not just
   under-specified), that is the trigger for a new ADR — propose one, don't silently
   route around it.
2. **`docs/engineering/` is living reference — normal PR review, no ADR required**, unless
   your change would contradict `docs/architecture/`, in which case see rule 1.
3. **Every persisted type extends `CanonicalEntity`** (`docs/engineering/canonical-object-model.md`
   §3). No entity bypasses the base schema, even for "just a quick internal record."
4. **Never merge `work_hierarchy_parent` and `organizational_containers` into one field,
   table, or function parameter.** This was the single most-corrected defect across the
   entire architecture reconciliation (four separate fix locations,
   `docs/process/reconciliation-changelog.md`). If a review sees these two concepts
   touching the same variable, that's a defect, not a style preference.
5. **Never write to `lifecycle_history` or `relationships` in place.** Both are append-only.
   An in-place edit to either is a data-integrity bug, not a valid optimization.
6. **`access_policy` is an unimplemented dependency, not a TODO to fill in casually.**
   No governance/authorization model is ratified. If a change needs real authorization
   logic, that's a signal to raise a founder-level product decision, not to invent a
   permission model inline.
7. **Plugin-related code should be written expecting change.** It's the lowest-confidence
   entity in the model — no source specification for it exists anywhere in the certified
   corpus. Don't build multiple Plugins against the current contract before it's validated
   against one real implementation.
8. **`schemas/generated/**` is generated, never hand-edited.** Edit
   `packages/core/src/schema/*.ts` (Zod) instead and regenerate.
9. **Commit convention:** Conventional Commits, plus an AI-attribution trailer on
   AI-authored commits (`Implemented-by: Claude` or `Implemented-by: Ollama/<model>`),
   per `docs/process/ai-development-plan.md`.

## Where to file disagreement

If implementation reveals that something in the engineering docs is wrong — not "I'd have
designed it differently" but "this contradicts itself" or "this can't actually be built as
specified" — say so explicitly rather than silently working around it. Naming preferences,
optional-vs-defaulted fields, and route shape are ordinary engineering judgment calls and
don't need to escalate. See `docs/engineering/developer-reference.md` §4 for the fuller
version of this rule.

## Document map

Full map, reading order, and terminology quick-reference:
[`docs/engineering/developer-reference.md`](docs/engineering/developer-reference.md).
Implementation strategy, build order, and AI task allocation:
[`docs/engineering/implementation-playbook.md`](docs/engineering/implementation-playbook.md).
