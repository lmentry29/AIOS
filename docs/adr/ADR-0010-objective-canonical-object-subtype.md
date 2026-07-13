# ADR-0010 — Mission Remains a Non-Entity; Objective Becomes a Canonical Object Subtype

## Status
**Proposed** (2026-07-12) — amends ADR-0007 (Canonical Object Model). Confirms ADR-0007's five-entity-type boundary and ADR-0004 Amendment A's Work Hierarchy split, and resolves the Objective gap neither specified.

## Context

The vertical slice (`docs/process/divergence-log.md`) built `core → objects → work-hierarchy → agents` and stopped, per `docs/engineering/implementation-playbook.md` §5. It halted on one unresolved conflict, deliberately flagged rather than routed around:

**Mission and Objective have no schema anywhere in the codebase, and two documents that both claim authority disagree about whether they should.**

- The ratified COM (`docs/engineering/canonical-object-model.md` §2, ratified by ADR-0007) states: *"Mission, Objective, and Organizational Containers (Project, Program, Release, etc.) are not entities in this model — they are reference/container fields."* ADR-0007's Decision restates this: *"No sixth entity type is introduced."* This traces back to ADR-0004 Amendment A, which separated the Work Hierarchy from Organizational Containers.
- The raw corpus (*AIOS Specification Project*, Part VI Ch.4, "Objective Model") specifies a full field-level Objective schema — Objective ID, Owner, Purpose, Desired Outcome, Constraints, Success Criteria, Priority, Risk Profile, Dependencies, Known Unknowns, Acceptance Criteria, Creation Timestamp, Current Status — and asserts *"Objectives remain immutable."* This was never reconciled into the ratified COM.
- ADR-0004 settles the Mission → Objective → Task → Action *ordering* and gives prose definitions, but no field-level schema.

The conflict is concrete in code today: `TaskEntity.work_hierarchy_parent` (`packages/core/src/schema/task.ts`) is **required**, with `level` pinned to the literal `'objective'` and `entity_id` typed as a UUID. Every Task therefore points at an Objective by UUID — and that UUID resolves to nothing. There is no Objective schema, no store, no record. The reference is well-typed and dangling.

Per the project's standing rule, inventing Mission/Objective schemas mid-implementation would itself be the unilateral resolution that rule exists to prevent. This ADR is the founder-level decision that rule demands.

## Decision

### 1. No sixth entity type. ADR-0007's boundary holds.

The entity taxonomy remains exactly five types: Agent, Task, Workflow, Plugin, Canonical Object. Nothing below introduces a sixth.

### 2. Objective is persisted as a **Canonical Object subtype**: `entity_subtype: 'objective'`.

An Objective is a real, persisted, lifecycle-bearing record — a Canonical Object, exactly as Memory Object (§5.1) and Artifact (§5.2) are. It gains identity, persistence, and an ADR-0003 lifecycle *through the already-ratified fifth entity type*, not by becoming a new one.

This uses the extension mechanism the COM already ratified rather than straining it. COM §12: *"specialization is **open and additive via `entity_subtype`** … nothing prevents future subtypes being added without schema-breaking changes, provided they still satisfy the full base schema (§3) and their parent entity type's schema (§4)."* COM §4.5 lists `entity_subtype` values as an *"open list"* with *"others: open, pending further specification as implementation proceeds."* `objective` is such a subtype.

**Consequence, stated directly: `Task.work_hierarchy_parent.entity_id` at level `'objective'` now dereferences to a real Canonical Object record.** The dangling reference the divergence log identified is closed, not merely narrowed.

### 3. Mission remains a pure non-entity reference field. Unchanged.

Mission gets no schema and no record. `work_hierarchy_parent` at level `'mission'` remains a typed UUID with nothing behind it.

**Mission and Objective are therefore treated asymmetrically, deliberately.** The justification is evidentiary, not architectural preference: Part VI Ch.4 specifies a field-level model for Objective and the corpus specifies *nothing* comparable for Mission. Promoting Mission would require inventing its fields, which is precisely the unilateral act this ADR exists to avoid. If a Mission field-level model is later sourced or authored, it can take this same path (a `mission` Canonical Object subtype) without amending this ADR's taxonomy.

### 4. Ch.4's field list becomes the record's data payload — reduced by COM §12's field-unification rule.

COM §12 is binding here: *"where a subtype's naturally-occurring field is semantically identical to a base-schema field … the subtype schema **must not** redeclare it — this is the mechanism that keeps the model from re-fragmenting into per-subtype duplicate fields."*

Applying it, five of Ch.4's thirteen fields **unify into the base schema and are not redeclared**:

| Ch.4 field | Unifies into | Why |
|---|---|---|
| Objective ID | `entity_id` (§3.1) | It *is* the entity id now. Redeclaring would create two ids for one record. |
| Owner | `owner_id` + `owner_type` (§7) | Base ownership model, `ActorRef` shape. |
| Creation Timestamp | `created_at` (§3.3) | Identical semantics; ISO 8601 UTC per §10. |
| Current Status | `lifecycle_state` (§3.2) | An Objective is now lifecycle-bearing per ADR-0003. Object Lifecycle Loop substates per §4.5. |
| Dependencies | `relationships[]` with `relationship_type: 'depends_on'` (§8) | `depends_on` is already in the ratified relationship vocabulary. A parallel `dependencies` array would be the same edge expressed twice. |

The remaining eight are genuinely new and constitute `ObjectiveEntity`'s payload, in `packages/core/src/schema/objective.ts`, extending `CanonicalObjectEntity`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `purpose` | string | Yes | Distinct from base `description` — *why the Objective exists*, per Ch.4. |
| `desired_outcome` | string | Yes | |
| `constraints` | string[] | No, `[]` | |
| `success_criteria` | string[] | Yes | Non-empty. An Objective with none is not gradeable. |
| `priority` | enum | Yes | |
| `risk_profile` | enum | Yes | |
| `known_unknowns` | string[] | No, `[]` | |
| `acceptance_criteria` | string[] | Yes | Non-empty. Retained separately from `success_criteria` — see Consequences 3. |

### 5. Immutability reuses the ratified Memory Object mechanism (§5.1) — it does not invent a new one.

Ch.4's *"Objectives remain immutable"* is implemented as the constraint COM §5.1 already defines and `@aios/objects` already enforces at write-time: **the Objective's definition fields (the eight above) are immutable after creation. Revision does not mutate them — it creates a NEW `entity_id` with an incremented `version` and a `supersedes` relationship pointing at the prior Objective.**

`lifecycle_state` transitions remain permitted and are **not** definition mutations: `lifecycle_history` is append-only (COM §11, AGENTS.md rule 5), so status advances without the definition ever changing. This is the narrowest reading that makes both halves of Ch.4's source text true — *"Objectives remain immutable"* and *"Current Status"* — and it dissolves what would otherwise be a contradiction in the source.

As with Memory Object, this is **not enforceable by Zod's static shape validation alone**. It is a write-time rule the persistence layer must enforce, alongside the Memory Object immutability check that already exists in `@aios/objects`.

### 6. Storage location.

`ObjectiveStore` is `ObjectStore<ObjectiveEntity>` — the existing generic store parameterized by the Objective schema, exactly as `TaskStore` is `ObjectStore<TaskEntity>`. It requires **no new persistence machinery**. It belongs in `@aios/work-hierarchy` alongside `TaskStore`, because Objective is a Work Hierarchy level.

## Rationale

- **It closes the dangling reference rather than documenting it.** A `work_hierarchy_parent.entity_id` that resolves to nothing is a latent bug in required, already-shipped code; embedding-only would have left it dangling.
- **It costs no new architecture.** Five entity types, the existing `ObjectStore`, the existing immutability mechanism, the existing relationship vocabulary, and the `entity_subtype` extension point the COM explicitly left open. The only genuinely new artifact is eight fields.
- **It gives Objectives an authoring home.** Objectives can be created, enumerated, and queried independently — and "find every Task under Objective X" is a store query, not a full scan of every Task.
- **It avoids denormalization.** One Objective, one record, referenced by id — not a full copy embedded in each of N Tasks.
- **It reconciles Part VI Ch.4 with the ratified COM** without discarding either: the field list survives as a payload, the five-type taxonomy survives intact.

## Consequences

1. **COM §2 must be amended.** Its sentence *"Mission, Objective, and Organizational Containers … are not entities in this model — they are reference/container fields"* is no longer true of Objective. It remains true of Mission and of Organizational Containers. COM §2, §4.5's subtype list, and §5 are updated by this ADR (§5 gains an Objective subsection alongside Memory Object and Artifact). This is a genuine amendment to a ratified document, which is why it takes an ADR.

2. **`work_hierarchy_parent` at level `'mission'` still dangles.** Only `'objective'` now dereferences. This is a knowingly-retained gap, not an oversight — see Decision 3.

3. **`success_criteria` and `acceptance_criteria` are both retained and are not obviously distinct.** Kept separate because Ch.4 lists both; collapsing them would be a substantive change rather than a transcription. Flagged for a possible follow-on cleanup, not resolved here.

4. **Objective immutability is a write-time invariant, not a type-level one.** It can be violated by any code path that writes an Objective without going through the enforcing store. This is the same exposure Memory Object already carries and is mitigated the same way.

5. **The Objective schema will be the first change to `packages/core/src/schema/` since the generator gap was found.** `pnpm --filter @aios/core run generate:schemas` is still the initialization placeholder and currently **exits 1** whenever `src/schema/` is non-empty, which makes `.github/workflows/schema-check.yml` red on any PR touching that path — including this one. The real generator (glob → `zodToJsonSchema` → `schemas/generated/*.json`, committed) must land before or with the Objective schema. Tracked as immediate follow-on work, not resolved by this ADR.

## Superseded Decisions

**Amends ADR-0007.** ADR-0007's Decision states *"Mission, Objective, and Organizational Containers are reference/container fields, not entities."* That clause is superseded **as to Objective only**. ADR-0007's load-bearing boundary — *"No sixth entity type is introduced"* — is **not** superseded and is expressly reaffirmed: Objective is a subtype of the existing Canonical Object type, not a new type.

ADR-0004 and its Amendment A are untouched. The Mission → Objective → Task → Action ordering, and the Work Hierarchy vs. Organizational Containers split, both stand exactly as ratified.

`docs/process/divergence-log.md`'s "Unresolved architectural conflict" section is closed by this ADR and should be marked as such once this is accepted.
