# Vertical Slice Divergence Log

Per docs/engineering/implementation-playbook.md §5: this log compares
what was actually built during the mandated vertical slice
(core → objects → work-hierarchy → agents → stop) against the design
docs, before proceeding to the remaining five packages.

## What was built

- **@aios/core**: Zod base `CanonicalEntity` schema (COM §3) plus
  type-specific extensions for Agent, Task, Workflow, Plugin, Canonical
  Object (COM §4), and Memory Object / Artifact specializations (COM
  §5). Commit 1b3e795.
- **@aios/objects**: `ObjectStore<T>`, generic over entity type and
  parameterized by Zod schema. Implements COM §9 (identity — entity_id
  never reused, including after archival), §11 (atomic version/
  modified_at bump on every write, append-only lifecycle_history and
  relationships), and §5.1 (Memory Object immutability, enforced at
  write-time). Commits fe81f95, e939ef4.
- **@aios/work-hierarchy**: `TaskStore`, a thin wrapper constructing
  `ObjectStore<TaskEntity>` with the full Task schema rather than the
  base schema. Task only — see "Unresolved conflict" below.
- **@aios/agents**: `AgentRunner`, running one Agent through the full
  Agent Execution Loop (ADR-0002: planning → reasoning → executing →
  monitoring → completion) against one real Task from TaskStore.

## Bugs found and fixed during this slice

1. **@aios/core's src/index.ts never re-exported ./schema.** The
   package built and typechecked cleanly in isolation the entire time
   this bug existed, because nothing inside @aios/core's own typecheck
   verifies that its public entry point actually surfaces its internal
   modules. Only surfaced when @aios/objects attempted its first
   cross-package import and got `undefined` where it expected the Zod
   schema value. Fixed in 1b3e795.

2. **zod version drift.** `pnpm add zod@^3.24.1` in @aios/objects
   resolved to `^3.25.76` in package.json rather than the literal range
   passed — confirmed as ordinary pnpm resolver behavior (no catalog,
   no overrides causing it), not a config issue. Re-pinned to an exact
   `3.24.1` matching @aios/core. Fixed before fe81f95/e939ef4.

3. **COM §10 evidence: generic base-schema ObjectStore silently drops
   type-specific fields on write.** A store validated only against the
   base CanonicalEntity schema (e.g. `new ObjectStore()`) does not throw
   when a caller patches a Task-specific field like `assigned_agent` —
   it succeeds, but Zod strips the unrecognized key by default, so the
   field is silently discarded rather than persisted. Documented as a
   passing test in @aios/objects (not hidden), then resolved at the
   root in Phase 1 of this slice's completion: ObjectStore was
   generalized to accept a schema parameter, so @aios/work-hierarchy's
   TaskStore constructs `ObjectStore<TaskEntity>` with the full Task
   schema and the field survives correctly.

## Unresolved architectural conflict #1 — Mission/Objective — CLOSED by ADR-0010 (2026-07-12)

> **Status: RESOLVED.** Closed by
> [`docs/adr/ADR-0010-objective-canonical-object-subtype.md`](../adr/ADR-0010-objective-canonical-object-subtype.md).
> Objective is now persisted as a Canonical Object subtype
> (`entity_subtype: 'objective'`), so `work_hierarchy_parent.entity_id`
> at level `'objective'` dereferences to a real record. No sixth entity
> type was introduced. Mission remains a non-entity reference field —
> deliberately, because the corpus specifies no field-level model for it.
> The original conflict is preserved verbatim below as the record of what
> was found and why it stopped the slice.

**Mission and Objective have no entity schema anywhere in this
codebase, and this is a genuine, unreconciled conflict between two
documents that both claim authority — not an oversight.**

- The ratified Canonical Object Model (`docs/engineering/canonical-object-model.md`
  §2, ratified by ADR-0007) states explicitly: "Mission, Objective, and
  Organizational Containers... are not entities in this model — they
  are reference/container fields." Only five types get schemas: Agent,
  Task, Workflow, Plugin, Canonical Object. Mission and Objective
  deliberately received no `MissionEntity`/`ObjectiveEntity`.
- The raw corpus (*AIOS Specification Project*, Part VI Ch.4,
  "Objective Model") specifies a full field-level Objective schema:
  Objective ID, Owner, Purpose, Desired Outcome, Constraints, Success
  Criteria, Priority, Risk Profile, Dependencies, Known Unknowns,
  Acceptance Criteria, Creation Timestamp, Current Status — and states
  "Objectives remain immutable." This was never reconciled into the
  ratified COM.
- ADR-0004 (Canonical Work Hierarchy) settles the Mission → Objective →
  Task → Action *ordering* and gives prose definitions, but no
  field-level schema of its own.

**Consequence for this vertical slice**: the mandate to build "one
Mission/Objective/Task" is only partially satisfiable as written. Only
Task was built. `work_hierarchy_parent.entity_id` for level `mission`
or `objective` remains a valid, typed UUID reference with no backing
store or schema — the gap made concrete in code rather than hidden.

**Not resolved here** because per the project's own standing rule ("if
a genuine architectural conflict surfaces during implementation, stop
and flag it — don't route around it silently, and don't unilaterally
amend an ADR without it being named as a decision"), inventing
Mission/Objective schemas mid-implementation would itself be exactly
the kind of unilateral resolution that rule exists to prevent. This
needs a founder-level decision, likely via a new or amending ADR, on:
should Objective become a sixth ratified entity type (using Part VI
Ch.4's field list as a starting point), and if so, does Mission get
one too or stay a pure reference field one level up?

## Unresolved architectural conflict #2 — Organizational Containers (NOT fixed — flagged, blocks @aios/containers)

**Found 2026-07-12, on the first attempt to build `@aios/containers`.
It is the same class of conflict as #1, and it blocks that package
entirely. It is NOT resolved here, for the same reason #1 wasn't.**

- The ratified COM (`docs/engineering/canonical-object-model.md` §2b,
  ratified by ADR-0007, and untouched by ADR-0010) still states that
  **Organizational Containers are not entities — they are
  reference/container fields.** No `ContainerEntity` schema exists in
  `packages/core/src/schema/`, by design.
- But `docs/engineering/runtime-interfaces.md` §2.5 specifies a
  `ContainerService` whose contract **requires persisted container
  records with real identity**:
  - `createContainer(type, spec): Promise<string>` — mints and returns
    a container id, which has to be stored somewhere.
  - `nestContainer(childId, parentId): Promise<void>` — Project inside
    Program. Nesting has to be stored *on* something.
  - `docs/engineering/api-contracts.md` reinforces this with real REST
    routes (`POST /containers/{id}/nest`).
- `CanonicalEntity.organizational_containers[].entity_id` (COM §3.4) is
  therefore a typed UUID pointing at nothing — **the exact dangling
  reference that conflict #1 had for Objective**, one field over.
- **`ContainerSpec` is referenced by the contract and defined nowhere in
  the corpus.** This is strictly worse than #1: Objective at least had
  *AIOS Specification Project* Part VI Ch.4's thirteen-field list to
  reconcile from. Container has no field-level source anywhere. Building
  it means inventing the fields outright.

**Why this is not resolved here.** Two available paths, both barred:

1. Make Organizational Containers a Canonical Object subtype
   (`entity_subtype: 'project' | 'program' | ...`), symmetric with what
   ADR-0010 just did for Objective. This is an architectural decision —
   it requires an amending ADR and a COM §2b change, and ADR-0010
   deliberately scoped itself to Objective *only*, leaving Containers
   explicitly untouched.
2. Invent `ContainerSpec`'s fields to satisfy the contract. This is
   precisely the unilateral resolution the project's standing rule
   forbids, and with no source material it would be pure fabrication.

Note that path 1 is *not* automatically correct just because it worked
for Objective. The symmetry is superficial: Objective is a Work
Hierarchy level with a specified field model, whereas Containers are the
thing ADR-0004 Amendment A worked hardest to keep *separate* from the
Work Hierarchy. Resolving #2 by analogy to #1 would risk re-merging the
two concepts that AGENTS.md rule 4 exists to keep apart. That is a
founder call, not an implementation one.

**Consequence:** `@aios/containers` is not built. `@aios/tools` and
`@aios/learning` were built instead — per
`implementation-playbook.md` §2, those four packages are explicitly
parallelizable with no interdependencies among them, so skipping
containers blocks nothing downstream except containers itself.

## Unresolved architectural conflict #3 — Plugin/Adapter execution model (NOT fixed — flagged, blocks `invoke()`)

**`runtime-interfaces.md` §2.6 specifies `invoke(pluginId, operation, args)`,
and nothing in the certified corpus could make it do anything.**

- `Plugin.wraps_adapter` (COM §4.4) is an optional UUID pointing at an
  **Adapter** concept that has **no schema, no store, and no registry
  anywhere in the model.** `invoke()` must resolve a plugin id to
  executable code and has no ratified means of doing so.
- COM §4.4 already flags Plugin as the lowest-confidence entity in the
  entire model — "no field-level Plugin specification exists anywhere in
  the certified corpus."
- `AGENTS.md` rule 7 is explicit: Plugin code "should be written expecting
  change… Don't build multiple Plugins against the current contract before
  it's validated against one real implementation."

**Implementing `invoke()` therefore requires inventing a Plugin/Adapter
execution model.** That is an architectural decision, not an implementation
detail — the same class as #1 and #2, just smaller. It is not resolved here.

**Consequence:** `@aios/tools` ships `install` / `enable` / `disable` — the
part of §2.6 that is fully specified and invents nothing — and does **not**
implement `invoke()`. The gap is left visible in the code rather than
filled.

A proposed (explicitly **not adopted**) resolution — caller-registered
handlers via a `registerHandler(pluginId, handler)` method, leaving
`wraps_adapter` inert — is written up in
`packages/tools/DRAFT-invoke-adapter-resolution.md`, kept **uncommitted** so
that a proposal cannot become the decision merely by sitting in `src/`. Note
that even that draft has a smell worth weighing: it makes `wraps_adapter` a
field the model defines and the runtime ignores. The honest option may be
that `invoke()` stays unimplemented until one real adapter exists to validate
it against, per AGENTS.md rule 7.

## Spec gaps found building @aios/tools and @aios/learning (2026-07-12)

Unlike the three conflicts above, each of these has a defensible resolution
that invents no architecture and touches no ratified document, so each was
resolved in code and recorded here rather than escalated. They are logged
because silent deviation is what makes a divergence log untrustworthy
(implementation-playbook.md §8).

1. **`implementation-playbook.md` §2's dependency graph contradicts
   `runtime-interfaces.md` §3/§4 — playbook bug, reported per its own
   rule.** The playbook's shorthand graph
   (`core → objects → {work-hierarchy, containers, tools, learning}`)
   implies `objects → tools`. runtime-interfaces §3 ("tools/ — depends on:
   core") and §4's graph (a `core --> tools` edge, no `objects --> tools`
   edge) both say **core only**. The playbook states that when it and a
   linked document disagree, the linked document wins and the playbook has
   a bug. `@aios/tools` therefore depends on core only and keeps its own
   Plugin registry. The playbook's §2 graph should be corrected to match
   §4's, or annotated as a lossy simplification.

2. **`install()` also omits `install_status` from its input**, which §2.6's
   `Omit<Plugin, "entity_id" | "lifecycle_history">` does not exclude. A
   method named `install()` that honours a caller-supplied `install_status`
   of `'removed'` is incoherent — installing is the act that sets that
   field, so the service owns it. Per AGENTS.md, optional-vs-defaulted
   fields are ordinary engineering judgment calls; every field the contract
   requires a caller to supply is still required.

   *(`invoke()`'s missing adapter execution model was originally logged
   here as a resolved spec gap. It is not one — it is an architectural
   decision, and it has been promoted to conflict #3 above.)*

3. **`runtime-interfaces.md` §2.7's `recordObservation(subject, content)`
   has nowhere to put `content`.** COM §5.1's Memory Object payload fields
   are exhausted by `name`, `description`, `memory_type`, `confidence`,
   `importance`, `evidence`, and `source_references` — there is **no
   content or body field**. Resolved by holding the content payload in
   `@aios/learning`, keyed by the backing Memory Object's `entity_id`,
   rather than serializing it into `description` (lossy; a string field is
   not a content field) or adding a field to core (which would require
   amending the ratified COM §5.1). If Memory Objects are meant to carry
   content, §5.1 needs a field and this should be revisited.

4. **The Knowledge Evolution stage lives in `@aios/learning`, not on the
   Memory Object.** Not a gap so much as a deliberate reading:
   runtime-interfaces §2.7 calls it a "distinct axis from
   `CanonicalEntity.lifecycle_state`", and Session 8 of the reconciliation
   verified these domain lifecycles as "legitimately different axes from
   ADR-0003", documented rather than merged into the base model. Adding a
   `knowledge_stage` field to core's Memory Object would perform exactly
   the merge the corpus declined to perform. The axis stays in the package
   that owns it.

## Spec gap found implementing objective.ts (2026-07-13)

**`priority` and `risk_profile` are ratified as enums with no members
specified anywhere.** *AIOS Specification Project* Part VI Ch.4 names
"Priority" and "Risk Profile" in the Objective field list and stops there —
it enumerates no values. ADR-0010 §5.3 and COM §5.3 both carry the field
forward as `enum`, Required, and likewise name no members. Part XI Ch.11's
"Priority categories" is about the Work Hierarchy / Container split, not a
severity scale, so it is not a source for these either.

The field *types* are settled by an accepted ADR; only the *members* are
unsourced. Rather than invent a new vocabulary, both reuse the
`low | medium | high | critical` scale this repo already ratified for Memory
Object's `importance` (COM §5.1) — the same shape, so the model gains no new
severity axis. Flagged rather than silently chosen. If a real priority or
risk taxonomy is later sourced, these members are what to revisit.

## Untested boundary — integration suite — RESOLVED (2026-07-13)

> **Status: FIXED.** `pnpm-workspace.yaml` now globs `tests/*`, so
> `tests/integration` is a workspace package (`@aios/integration-tests`) and
> can resolve `@aios/*` imports. 24 boundary tests now cover
> core → objects, objects → work-hierarchy, and work-hierarchy → agents.
> Turbo picks the package up automatically, so `ci.yml`'s existing
> `turbo lint typecheck test build` runs the suite with no workflow change
> (39 tasks, up from 36). Original problem statement preserved below.

**Original problem.** `tests/integration/` was empty and *could not hold a
working test*: `pnpm-workspace.yaml` declared only `packages/*`, so nothing
under `tests/` was a workspace package and nothing there could resolve
`@aios/*` imports. `vitest.workspace.ts` defined `integration` and
`conformance` projects with nothing runnable in them.

That meant no package met implementation-playbook.md §8's per-package
Definition of Done, which requires "an integration test covering its
boundary with whatever it depends on, not just isolated unit coverage."
Unit coverage was real; cross-package coverage was zero.

### Still outstanding after this fix

1. ~~**The full Mission → Objective → Task → Agent chain (§8's Milestone 1
   DoD) is still NOT covered**~~ — **RESOLVED 2026-07-13.** ADR-0010 was
   accepted, `packages/core/src/schema/objective.ts` implements it, and
   `tests/integration/full-chain.test.ts` now exercises the chain
   end-to-end. `Task.work_hierarchy_parent.entity_id` at level
   `'objective'` dereferences to a real, persisted Objective record. **The
   Mission link remains dangling by design** (ADR-0010 §3) and the chain is
   therefore genuinely asymmetric — the test asserts both halves so the gap
   stays visible rather than being papered over with a stub Mission.

2. **`tests/conformance/` is still empty**, and `conformance.yml` runs
   `pnpm vitest run --project conformance` against it. Per playbook §6 that
   suite should not be written before the vertical slice exists — it now
   does, so this is unblocked but unwritten.

3. **The suite's value is boundary *coverage*, not bug-catching power that
   unit tests lack.** Honest note from validating it: reintroducing the
   COM §10 field-stripping defect (constructing `TaskStore` with the base
   schema instead of `TaskEntity`) fails 4 integration tests — but it also
   fails `@aios/work-hierarchy`'s and `@aios/agents`' own unit tests. The
   defect this suite is uniquely positioned to catch is the divergence-log
   bug-1 class: a barrel that stops re-exporting, which builds and
   typechecks clean and only breaks on cross-package import. That case is
   now pinned in both `core-objects.test.ts` and `@aios/core`'s own
   entry-point test.

## Other notes

- Biome's lint config in this repo does not appear to include
  `noUnusedImports` — an unused import (`afterEach`, `beforeEach` in
  an earlier @aios/objects test edit) passed lint cleanly. Not a defect
  introduced by this slice, but worth knowing: lint passing here is a
  weaker guarantee than it would be with that rule enabled.
- The turbo warning "no output files found for task #test" is
  pre-existing `turbo.json` configuration (no declared `outputs` for
  the test task), unrelated to any change in this slice.

## Checkpoint status

Per the mandated order, this completes core → objects →
work-hierarchy (Task only) → agents → stop. Per implementation-playbook.md
§5, no further packages (containers, tools, learning, orchestration,
founder) should be started until this log is reviewed — and, per the
unresolved conflict above, until Mission/Objective's status gets a
founder-level decision, since `@aios/containers` and any future
Mission/Objective work would build directly on top of whatever that
decision turns out to be.
