# AGENTS.md — instructions for AI agents working in this repository

This file is the entry point for any AI agent (Claude, Ollama-based local models, or
otherwise) working in this repository. If you are implementing a package, read
[`docs/engineering/implementation-playbook.md`](docs/engineering/implementation-playbook.md)
next — it is the primary implementation entry point and consolidates the guidance below
into build order, milestones, and Definition of Done per phase.

## What this repository is

AIOS's architecture and engineering-readiness planning are complete and certified
(`docs/process/v1-final-certification-report.md`). This repository is where that
architecture becomes running code. The nine `packages/*` now contain domain
implementations at different maturity levels, and `apps/host` is the trusted local
composition root. Maturity is uneven: most operational stores and integrations still have
in-memory or test-only adapters, and the host has no UI. Read
`docs/process/project-state.md` and the ADR index; do not infer production readiness from a
passing build.

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
   decisions require durable, append-only audit. The host composes a durable
   `FilePolicyRegistry` and `authorization-audit.jsonl`; runtime publication is a
   human-only `POST /v1/policies` path requiring an exact `administer_policy` grant on
   every target, with an audit append failure blocking the mutation. Runtime retirement is
   the human-only `POST /v1/policies/:policyId/revoke` path (ADR-0024): it requires an exact
   `revoke_policy` grant on every resource that references the version, accepts only the
   complete target set, and falls back to the newest remaining version or leaves the
   resource unattached and denying. The offline `publish-policy` and `revoke-policy` CLIs
   remain the out-of-band bootstrap paths. `administer_policy` may be
   granted only to human subjects; it is never implied by another action, ownership, or
   the bootstrap identity. Neither action is implied by the other. Policy bundles and
   decisions now carry detached Ed25519 provenance (ADR-0034), verified before rule
   matching and re-verified on audit reads; verifier decisions are bound to the durable
   execution attempt, and the host refuses to compose the policy signing key as a verifier
   key. This is still not a production security boundary: production key custody, external
   audit custody, protection against a coordinated whole-store audit rollback, and a
   purpose-bound trust-root key-role schema are absent. A local signed authorization-audit
   high-water mark detects truncation and reordering while the current head remains. Do not change authorization semantics without an amending ADR.
7. **General plugin/adapter execution remains deferred; fixed local execution is not.**
   ADR-0012 is Proposed and establishes capability mediation as the intended
   requester-facing principle, but its replacement runtime contract and Capability
   Registry schema are follow-on work. ADR-0019 accepts one narrow implemented exception:
   the fixed `local.exec` command contract in `apps/host/src/execution/`. That exception
   does not authorize provider selection, model invocation, plugin discovery, or arbitrary
   host execution. Do not generalize it without the required architecture decision and
   sandbox/secret design.
8. **`schemas/generated/**` is generated, never hand-edited.** Edit
   `packages/core/src/schema/*.ts` (Zod) instead and regenerate.
9. **Commit convention:** Conventional Commits, plus an AI-attribution trailer on
   AI-authored commits (`Implemented-by: GPT-6`, `Implemented-by: Claude`, or `Implemented-by: Ollama/<model>`),
   per `docs/process/ai-development-plan.md`.
10. **Founder governance is human-only.** Agents may read only through explicit resource policy, but they cannot publish policies, record Founder decisions, or operate the human review queue. Decision artifacts must remain scoped to their protected collection.
11. **A completed lifecycle state is not proof of completed work.** The current
    `AgentRunner` is a lifecycle/conformance harness, not a tool-executing agent. The
    Orchestration Kernel may mark a Task complete only after an independent verifier
    accepts the result and evidence. Never allow an executor to self-attest.
12. **Founder Intelligence persists in the Obsidian vault.** ADR-0014 is Accepted: do not add a separate Founder Intelligence database. AIOS validates managed records against canonical schemas. Vault integration is read-and-propose by default; permanent Memory writes require explicit human review and authorization. Do not hydrate, migrate, rename, rewrite, or normalize existing notes without a reviewed proposal and a separate human-approved write action.
13. **Know which stores are durable and which are not.** Task, Workflow, Artifact/evidence,
    and dispatch-run state are durable through the hash-chained operational journal
    (ADR-0015), with idempotency, leases, and startup recovery. Learning records are durable
    in a separate hash-chained `learning.jsonl`, and permanent Memory stages require a
    recorded human approval. In the host, every authorization allow and deny is durable in
    `authorization-audit.jsonl` with request correlation (ADR-0013), and policy lifecycle
    events are durable with policy state. The canonical object store used only for Founder
    queries and some policy/evidence paths still has in-memory or test/development
    implementations.
    The operational journal supports offline checkpoint compaction (`compact-journal`) and
    verified restore (`restore-journal`) under ADR-0025; the learning and authorization-audit
    journals are not compacted, and no journal has a migration framework. All journals remain
    single-process. Production use still requires protected secrets,
    a completed sandbox/provider matrix, operational controls, and independent review.
    Keep these limitations explicit in code and documentation.
14. **No unrestricted host execution.** A task may run only through the fixed
    `local.exec` contract and a provider that passes its own availability probe
    (ADR-0019). A bare child process, shell string, test double, or fallback when the
    provider is unavailable is a security defect, not a convenience. Evidence must be
    bounded and hashed; never copy untrusted stdout/stderr into the journal or HTTP
    responses, and never pass provider credentials through a Task environment.
15. **UI is not a trust boundary.** `apps/host` rejects every `Origin` today. Do not add
    CORS, browser token storage, or a UI route that bypasses session identity without an
    accepted ADR covering origin, CSRF, and cookie behavior (ADR-0016).

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
