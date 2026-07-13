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

## Unresolved architectural conflict (NOT fixed — flagged)

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
