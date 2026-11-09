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
6. **Authorization semantics are ratified by ADR-0013.** Protected operations use
   resource-attached, exact-match, default-deny policies; explicit deny overrides allow;
   there are no wildcard grants, role expansion, or owner-implied permissions. Identity
   must come from a trusted host identity subsystem — a caller-supplied actor string is
   not authentication. Policy publication/attachment/revocation and authorization
   decisions require durable, append-only audit. The current evaluator and in-memory
   registry are test/development components, not a production security boundary. Do not
   change authorization semantics without an amending ADR, and do not claim production
   security until the host identity and durable policy/audit implementations exist.
7. **Plugin/Adapter execution remains deferred.** ADR-0012 is Proposed and establishes
   capability mediation as the intended requester-facing principle, but its replacement
   runtime contract and Capability Registry schema are follow-on work. The first real
   adapter integration is the reopening trigger for the deferred Plugin/Adapter execution
   model. Do not invent an invocation model or expose provider selection to requesters
   without the required architecture decision.
8. **`schemas/generated/**` is generated, never hand-edited.** Edit
   `packages/core/src/schema/*.ts` (Zod) instead and regenerate.
9. **Commit convention:** Conventional Commits, plus an AI-attribution trailer on
   AI-authored commits (`Implemented-by: Claude` or `Implemented-by: Ollama/<model>`),
   per `docs/process/ai-development-plan.md`.
10. **A completed lifecycle state is not proof of completed work.** The current
    `AgentRunner` is a lifecycle/conformance harness, not a tool-executing agent. The
    Orchestration Kernel may mark a Task complete only after an independent verifier
    accepts the result and evidence. Never allow an executor to self-attest.
11. **In-memory adapters are not production persistence.** Object, Task, Workflow,
    evidence, learning, policy, and audit stores currently include in-memory
    implementations for tests/development. Production use requires durable storage,
    transactions, recovery, trusted identity, protected secrets, sandboxed execution,
    and operational controls. Keep these limitations explicit in code and documentation.

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

## Local-model delegation

For any package classified **Ollama Suitable** in
`docs/process/ai-development-plan.md` §1, delegate implementation to the
`qwen-coder` subagent rather than writing it directly. Packages classified
**Claude Recommended** or **Human Review Required** are never delegated —
implement those directly or escalate, per that table.
