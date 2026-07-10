# AIOS Implementation Playbook

**This is the primary entry point for implementing AIOS.** It does not restate the
engineering-readiness corpus — it tells you the order to read it in, the order to build
in, how work is allocated across Claude/Ollama/human review, and what "done" means at each
checkpoint. Every claim below links to the document that is its actual source of truth;
if this playbook and a linked document ever disagree, the linked document wins and this
playbook has a bug — report it as one (see `AGENTS.md`, "Where to file disagreement").

Audience: any AI agent or human engineer about to write code against a `packages/*`
directory. Read `AGENTS.md` first if you haven't (repository-wide rules), then this
document, then only the specific engineering docs your task needs.

---

## 1. Overall implementation strategy

AIOS's architecture (ADR-0001–0009) and its engineering-readiness artifacts
(`docs/engineering/canonical-object-model.md` through `api-contracts.md`) were produced
doc-first, before any code existed. That sequencing is a named, accepted risk, not a
secret flaw — `docs/engineering/implementation-roadmap.md` §5's risk register calls it out
directly ("Tiers 5–7 were produced before any implementation exists... a structural
property of doc-first sequencing that no amount of additional writing fixes"), and
`docs/archive/engineering-readiness-report.md` rated the corpus **⚠ Ready with Minor
Risks**, not an unqualified ✅, specifically because of this.

The strategy that follows from that fact: **do not build all nine packages against
unvalidated specs.** Build the smallest slice that exercises the real dependency chain
end-to-end, compare what you actually built against what the docs said, log every
divergence, and only then proceed to the remaining packages — informed by evidence instead
of more documentation. This is §5 below, and it is the single most important section in
this playbook. Everything else (build order, milestones, task allocation) is organized
around getting to that slice quickly and using it honestly.

**Source of truth for this strategy:** `docs/engineering/implementation-roadmap.md` §4–§6
(vertical slice, risk register, implementation order). This playbook consolidates it with
the package-allocation and testing guidance that roadmap doesn't cover; it does not
override it.

---

## 2. Package dependency order

Nine packages, one-to-one with `docs/engineering/runtime-interfaces.md` §1's component
boundaries. Full method-signature-level contracts live there (§2); the dependency graph
(§4) is the authority for build order — reproduced here only as a quick reference:

```
@aios/core  →  @aios/objects  →  @aios/{work-hierarchy, containers, tools, learning}  →  @aios/agents  →  @aios/orchestration  →  @aios/founder
```

Topological build order (per `docs/engineering/implementation-roadmap.md` §2):

1. `core` — no dependencies, everything else depends on it directly or transitively.
2. `objects`
3. `work-hierarchy`, `containers`, `tools`, `learning` — parallelizable, no interdependencies among these four.
4. `agents`
5. `orchestration`
6. `founder` — never depended on by others (ADR-0006: Founder Interface is a cross-cutting
   access surface, not a foundational component).

**Critical path:** `core → objects → work-hierarchy → agents → orchestration` — the only
chain required for the simplest end-to-end scenario (a Task moves from Created to
Completed under an Agent, dispatched by the Orchestration Kernel). `containers`, `tools`,
`learning`, and `founder` are reachable off this spine but not required for the first
vertical slice (§5).

**Open question this build order does not resolve:** whether Task/Mission/Objective are
stored via `@aios/objects` or via a dedicated backing store `@aios/work-hierarchy` owns
directly (`docs/engineering/runtime-interfaces.md` §5). The corpus assumed Option B
(separate storage) throughout but flagged this as revisitable. **Resolve this with the
vertical slice, not by reasoning about it further** — see §5.

---

## 3. Versioning and compatibility policy for `@aios/core`

**Added 2026-07-10, per an independent senior-architecture-review finding.** Changesets is
wired up mechanically (`.changeset/config.json`, `release.yml`) but nothing previously
stated what happens when `@aios/core`'s Zod schemas change in a way that breaks a
downstream package. That's a policy question, not an implementation question — it's fully
answerable today, and it gets more expensive to answer the more of `objects`,
`work-hierarchy`, `containers`, `agents`, `tools`, `learning`, `orchestration`, and
`founder` exist and depend on `core` transitively. Writing it now, while only `core` exists,
costs one paragraph. Retrofitting it after five packages have been built against an implicit
(nonexistent) contract costs an audit of every existing usage for violations.

**Policy:**

- `@aios/core`'s Zod schema exports follow semver *as a contract*, even before `core` itself
  reaches `1.0.0`: a **patch** release adds nothing observable; a **minor** release adds an
  optional field, a new entity subtype, or a new relationship type (additive, non-breaking
  for existing consumers); a **major** release (or, pre-1.0, any `0.x.0` minor bump per the
  `0.x` convention where minor-is-breaking is standard) removes a field, changes a field's
  type, tightens a validation constraint that previously-valid data could fail, or changes
  `lifecycle_state`/`lifecycle_substate` transition rules.
- Every schema-affecting Changeset must state, in the changeset body, which downstream
  packages (`docs/engineering/runtime-interfaces.md` §4's dependency graph) are affected and
  whether the change is additive or breaking — this is a one-line discipline, not a new
  process, and it's what makes `pnpm changeset` output actually useful instead of a rubber
  stamp.
- A breaking change to `core` requires the PR to also update every downstream package's
  usage in the same PR, or to explicitly document why a downstream package is left
  temporarily broken with a tracking note — never a silent breakage discovered later by a
  failing build in an unrelated package.
- This policy itself is engineering process, not architecture — it doesn't need an ADR and
  can be revised here directly as implementation reveals better practice, per this
  playbook's own change-tier (§1, `docs/engineering/` is the living-reference tier).

---

## 4. AI task allocation — Claude vs. Ollama vs. Human

Full per-package table and reasoning: `docs/process/ai-development-plan.md`. General
policy it applies: `docs/process/ai-development-workflow.md`. Not restated here in full;
summary of the allocation logic and the specific rows that matter most at the start of
implementation:

- **Allocate by blast radius, not by "could a smaller model technically do this."**
  Subtle, plausible-looking mistakes in low-level foundational code (schema validation,
  lifecycle transitions, persistence) are expensive precisely because they're invisible
  until something built on top of them breaks. That risk profile, not raw code
  complexity, is what routes work to Claude.
- **Claude Recommended:** `core`, `objects`, `agents`, `orchestration` — the critical-path
  packages, plus any change touching more than one of these at once, plus code review of
  Ollama-authored output before it lands in any of them.
- **Ollama Suitable:** `containers`, `learning`, boilerplate/scaffolding, tests once the
  thing under test is Claude-reviewed, mechanical schema translation once a pattern is
  established.
- **Either, lean Claude for the first pass:** `work-hierarchy` — specifically because it's
  where the Task/Object storage boundary (§2 above) gets resolved in practice; the first
  implementation pass through that ambiguity should be Claude so the resolution is
  recorded with reasoning, not guessed.
- **Ollama Suitable for scaffolding, Human Review Required before shipping:** `tools`
  (Plugin) — the schema itself is the lowest-confidence artifact in the whole model
  (`docs/engineering/canonical-object-model.md` §4.4); cheap to prototype locally since
  almost nothing depends on it yet, but don't let a plausible-looking local-model Plugin
  API get treated as settled without a human pass.
- **Human Review Required regardless of complexity:** anything touching the
  access/authorization model once it becomes blocking, and the risk register's own
  prioritization — both are judgment calls about risk tolerance, not engineering
  correctness.
- **Known unvalidated assumption:** `docs/process/ai-development-workflow.md` states its
  own confidence on the exact model-size cutoff as "Medium-Low... not benchmarked against
  your specific Ollama setup." Treat the whole Claude/Ollama split as a starting default,
  not a rule to enforce mechanically — spot-check one real module against your actual
  local models before trusting the boundary further.

---

## 5. Vertical slice (do this first, before anything else in §2's build order)

**This supersedes "build packages in dependency order" as the actual first step.** Per
`docs/engineering/implementation-roadmap.md` §4:

1. Implement `@aios/core` — `CanonicalEntity` base schema (Zod, per ADR-0008/0009) and the
   validation constraints in `docs/archive/object-schemas-superseded.md` §3 (design intent
   only now — see that file's supersession notice; the Zod definitions in
   `packages/core/src/schema/` are the implementation source).
2. Implement `@aios/objects` with in-memory or SQLite persistence
   (`docs/engineering/canonical-object-model.md` §11).
3. Implement `@aios/work-hierarchy` enough to create one Mission, one Objective, one Task.
4. Implement `@aios/agents` enough to run one Agent through the full lifecycle
   (`docs/engineering/state-machines.md` §2) against that one Task.
5. **Stop.** Do not proceed to `containers`, `tools`, `learning`, or `founder`. Compare
   what was actually built against `docs/engineering/canonical-object-model.md` through
   `state-machines.md` (Tiers 1–4). Log every place reality diverged from the spec —
   including, specifically, how the Task/Object storage boundary actually resolved.

The divergence log from step 5 is the input to §8 (Milestone 1's Definition of Done) and
to whichever founder decision the Task/Object storage question turns out to need. It is
more valuable than proceeding straight to the remaining packages — it's the fastest way to
find out whether that boundary and the Plugin thinness (§4 above) are the only two soft
spots in the specification corpus, or whether there are others a document-only process
couldn't have found.

---

## 6. Testing strategy

- **Unit tests** are colocated per-package (`packages/*/tests/`) — owned by the package,
  move/delete with it. Not centralized.
- **Integration tests** (`tests/integration/`) are centralized because they test *across*
  package boundaries, which no single package should own — the `work-hierarchy` ↔
  `objects` boundary (§2's open question) is the first and most important thing this
  suite needs to cover once the vertical slice exists.
- **Conformance tests** (`tests/conformance/`) validate the implementation against
  `docs/architecture/conformance-standard.md`. **Claude Recommended** for this suite
  specifically (`docs/process/ai-development-plan.md` §2) — correctly interpreting RFC
  2119 MUST/SHALL language against the certified corpus is a correctness-sensitive
  reasoning task; a misread here would silently certify non-conformant behavior as
  conformant. Do not write this suite before the vertical slice exists — there is nothing
  real to conform yet.
- **Schema tests** are structural, not a separate suite: `schema-check.yml` (CI) fails the
  build if `schemas/generated/**` doesn't match what regenerating from
  `packages/core/src/schema/*.ts` produces. This is the enforcement mechanism for ADR-0009
  §1.10's single-source-of-truth decision, not something to duplicate with hand-written
  schema-drift tests.
- **All test execution runs through the single Vitest workspace** (`vitest.workspace.ts`,
  repo root) — per-package projects plus the two centralized `integration`/`conformance`
  projects, not separate tooling per tier.

---

## 7. Milestones

Per `docs/archive/prior-manifests/implementation-handoff.md` §10 (superseded for repo
structure, still correct on this point) and `docs/engineering/implementation-roadmap.md`
§6:

1. **Vertical Slice Validated** — the five-step sequence in §5 is built and running, and
   the divergence log either confirms Tiers 1–4 as built or identifies specific, named
   corrections. Deliberately not "Package `core` complete" or "Package `objects`
   complete" — a package being internally complete doesn't test whether packages
   correctly integrate, and integration is exactly where doc-before-code risk would
   surface first.
2. **Divergence Review Closed** — every item in the divergence log is either fixed,
   or explicitly re-scoped as a founder decision (per `AGENTS.md` rule 1 if it implicates
   `docs/architecture/`), or logged as accepted debt. No open divergence items carried
   silently into the next milestone.
3. **Critical Path Complete** — `orchestration` built and exercising the full
   `core → objects → work-hierarchy → agents → orchestration` chain on real (not
   single-example) workloads.
4. **Full Build Complete** — `containers`, `tools`, `learning`, `founder` built, informed
   by the divergence log rather than the original, unvalidated Tier 5–7 assumptions.
5. **API Surface Revisited** — `docs/engineering/api-contracts.md` treated as a draft
   until this point, per its own status note; only stabilized once `objects`/`agents`/
   `orchestration` exist for real.

---

## 8. Definition of Done per phase

**Vertical slice (Milestone 1):**
- All four packages in §5 build, typecheck, and pass their own unit tests via
  `turbo lint typecheck test build`.
- One Mission → one Objective → one Task → one Agent execution, start to finish, has an
  integration test in `tests/integration/` exercising it — not just unit tests in
  isolation.
- A divergence log exists (as a PR description, an ADR, or a doc under
  `docs/engineering/`, whichever fits the size of what was found) and explicitly states
  whether Option A or Option B won the Task/Object storage question.
- No `docs/architecture/` content was contradicted without a corresponding new/amending
  ADR.

**Each subsequent package (post-vertical-slice):**
- Builds, typechecks, passes unit tests, and passes `schema-check.yml` if it touches
  `packages/core/src/schema/**`.
- Has an integration test covering its boundary with whatever it depends on, not just
  isolated unit coverage.
- Any deviation from its Tier 1–5 spec (`canonical-object-model.md` through
  `api-contracts.md`) is noted inline (code comment or PR description) referencing which
  document it deviates from and why — silent deviation is what makes a divergence log
  untrustworthy.
- Conventional Commits + AI-attribution trailer, per `AGENTS.md` rule 9.

**Critical Path Complete (Milestone 3):**
- `tests/conformance/` exists and passes against `docs/architecture/conformance-standard.md`
  for whatever surface area the critical path actually covers (not the full corpus —
  that's disproportionate before `containers`/`tools`/`learning`/`founder` exist).
- CI (`ci.yml`, `schema-check.yml`, `conformance.yml`) is green on `main`, not just
  locally reproducible.

**Full Build Complete (Milestone 4):**
- All nine packages meet the per-package bar above.
- `docs/engineering/api-contracts.md` and `implementation-roadmap.md` are updated to
  reflect what was actually built, or explicitly marked where they still describe
  aspirational surface area not yet implemented.
- Access/authorization model decision is either made (if a multi-actor or external-facing
  feature has been scoped by this point) or explicitly still deferred with a named
  trigger condition, not silently absent.

---

## 9. Validation checkpoints

- **After the vertical slice, before building anything else:** the divergence review in
  §7 Milestone 2. Do not let this become optional under schedule pressure — it's the one
  point in the whole plan where the corpus's central risk (doc-before-code) gets tested
  against reality instead of asserted away.
- **Every PR touching `packages/core/src/schema/**`:** `schema-check.yml` (automatic).
- **Every PR touching `packages/**` or `docs/architecture/conformance-standard.md`:**
  `conformance.yml` (automatic, meaningful only after the vertical slice produces
  something to test conformance against).
- **Every PR touching `docs/adr/` or `docs/architecture/`:** `CODEOWNERS`-enforced human
  review (automatic flag, not automatic block — still requires an actual read).
- **Before Milestone 3 (Critical Path Complete):** confirm the Task/Object storage
  boundary resolution from Milestone 1 held up under `orchestration`'s coordination logic,
  not just under `agents`' simpler single-Task case — coordination bugs are exactly the
  "high blast radius" category §4 routes to Claude, and this is where they'd surface.

---

## 10. Canonical source documents (this playbook consolidates, does not replace)

| Topic | Source of truth |
|---|---|
| Architecture decisions | `docs/adr/` (start at `index.md`) |
| Entity model, fields, ownership, relationships | `docs/engineering/canonical-object-model.md` |
| Schema design intent (superseded as implementation source by Zod, ADR-0009 §1.10) | `docs/archive/object-schemas-superseded.md` |
| Component boundaries, service contracts, dependency graph | `docs/engineering/runtime-interfaces.md` |
| Lifecycle diagrams | `docs/engineering/state-machines.md` |
| Wire format / API surface (provisional) | `docs/engineering/api-contracts.md` |
| Coding standards, terminology, document reading order | `docs/engineering/developer-reference.md` |
| Repo structure, build order, critical path, risk register | `docs/engineering/implementation-roadmap.md` |
| Repository/tooling design and full reasoning | `docs/process/repository-design-specification.md` |
| Per-package Claude/Ollama/Human allocation | `docs/process/ai-development-plan.md` |
| General task-allocation policy | `docs/process/ai-development-workflow.md` |
| Why the corpus looks the way it does (defects found, fixed, deferred) | `docs/process/reconciliation-changelog.md` |
| What "certified" and "ready" actually mean here | `docs/process/v1-final-certification-report.md`, `docs/archive/engineering-readiness-report.md` |
| Repository-wide rules for AI agents | `AGENTS.md` |

If you find yourself about to duplicate content from one of these into a PR description,
a new doc, or a code comment — link it instead. The reconciliation history in
`reconciliation-changelog.md` exists precisely because this corpus once had the same fact
stated in three places that quietly drifted apart. Don't recreate that failure mode at the
implementation layer.
