# ADR-0011 — Project Becomes a Canonical Object Subtype; Program and Release Remain Non-Entities

## Status
**Accepted** (2026-07-13) — amends ADR-0007 (Canonical Object Model) and ADR-0004 Amendment A (Work Hierarchy vs. Organizational Containers), as to **Project only**. Same mechanism as ADR-0010.

> **Accepted, not yet implemented.** No code implements this, and `canonical-object-model.md` does not yet reflect it — both are follow-on work (see Consequence 1 for the COM sections that must change).
>
> Founder decisions folded in across revisions 2 and 3: Mission/Vision are **prose strings**, not references; this amends **ADR-0004 Amendment A**, not ADR-0003; Ch.6's eleven-stage model becomes a **third orthogonal axis**, `project_phase`; `SHELVED_PROJECT` is a **required named test fixture**; and `project_status` gets an append-only history while `project_phase` does not.

## Context

`docs/process/divergence-log.md` conflict #2 blocks `@aios/containers` entirely:

- The ratified COM (`canonical-object-model.md` §2b, per ADR-0007 and ADR-0004 Amendment A) states Organizational Containers **are not entities** — "they organize and scope entities but are not themselves lifecycle-bearing execution units in the ADR-0003 sense."
- But `runtime-interfaces.md` §2.5's `ContainerService` requires persisted container records with real identity: `createContainer(...): Promise<string>` mints and returns an id; `nestContainer(childId, parentId)` must store the nesting. `api-contracts.md` reinforces this with real routes (`POST /containers/{id}/nest`).
- `CanonicalEntity.organizational_containers[].entity_id` (COM §3.4) is therefore a typed UUID pointing at nothing — the same dangling reference ADR-0010 closed for Objective, one field over.
- **`ContainerSpec` is referenced by the contract and defined nowhere in the corpus.**

That last point is why conflict #2 was logged as *strictly worse* than #1 and left for a founder decision. **This ADR narrows it rather than solving it wholesale, and the narrowing is the point:** there is no field-level source for "a container" in general, but there **is** one for **Project** specifically — an entire ~580-line Part XI (*Project Operating System*) is built around it.

Verified in the corpus while drafting:

- **Part XI Ch.3 ("Project Identity")** — eleven fields: Project Identifier, Name, Mission, Purpose, Vision, **Status**, Owner, Creation Date, Organizational Scope, Project DNA, **Lifecycle State**. "Project Identity changes infrequently. Implementation evolves continuously."
- **Part XI Ch.4 ("Project DNA")** — eight sub-fields (mission, core principles, target users, architectural philosophy, quality expectations, long-term objectives, non-goals, governance constraints), described as the project's **"immutable characteristics"** and its **"constitutional document."**
- **Part XI Ch.6 ("Project Lifecycle")** — eleven stages: Concept → Research → Architecture → Planning → Implementation → Validation → Deployment → Operation → Evolution → Retirement → Archive. "Projects may revisit earlier stages as new information emerges."
- **Part XI Ch.7 ("Project State")** — nine operational states: Initializing, Planning, Active Development, Maintenance, Paused, Blocked, Migrating, Archived, Retired. "State transitions are explicit and auditable."
- **Part XI Ch.8 ("Project Registry")** — "The organization maintains a centralized Project Registry" recording active projects, archived projects, dependencies, ownership. A store, in the corpus's own words.

ADR-0004's Amendment A already refused to delete Project as a first-class concept (founder decision, recorded there). This ADR gives it the schema that decision implies it needs.

## Decision

### 1. No sixth entity type. ADR-0007's boundary holds.

The taxonomy remains exactly five: Agent, Task, Workflow, Plugin, Canonical Object.

### 2. Project is persisted as a **Canonical Object subtype**: `entity_subtype: 'project'`.

A Project is a real, persisted, lifecycle-bearing record — gaining identity, persistence, and an ADR-0003 lifecycle through the **already-ratified fifth entity type**, via the open, additive `entity_subtype` mechanism (COM §12: "nothing prevents future subtypes being added without schema-breaking changes"), exactly as Memory Object, Artifact, and now Objective do.

**Consequence:** `organizational_containers[].entity_id` dereferences to a real record **when `container_type` is `'project'`** — and only then. See Consequence 2.

**This does not merge the Work Hierarchy into Organizational Containers.** Project remains a *container*; it does not become a rung of Mission → Objective → Task → Action. ADR-0004 Amendment A's split, and AGENTS.md rule 4, stand untouched. What changes is only that a container is now *backed by a record* instead of being a bare id. The reconciliation already considered and rejected making Project a hierarchy level (`reconciliation-changelog.md`, option B); it chose the container reading (option C), and this ADR implements that choice rather than reopening it.

### 3. Project carries **three orthogonal status axes**. This is deliberate, and none of them are aliases.

This is the crux of the ADR, so it is stated before the field table.

| Axis | Field | Source | Answers |
|---|---|---|---|
| **Runtime lifecycle** | `lifecycle_state` (base, §3.2) | ADR-0003 | *What is the state of this record in the system?* |
| **Operational state** | `project_status` (new) | Part XI **Ch.7** | *What is this project doing right now?* |
| **Developmental phase** | `project_phase` (new) | Part XI **Ch.6** | *How mature is this project's development?* |

**Why three, and why this resolves Ch.3's oddity.** Ch.3's Identity list names **both** "Status" **and** "Lifecycle State" as separate fields — which looks like a duplication until you notice Part XI defines two different models: Ch.7 ("Project **State**") and Ch.6 ("Project **Lifecycle**"). Ch.3's two fields are pointers to those two models:

- Ch.3 **"Status"** → Ch.7's nine operational states → `project_status`.
- Ch.3 **"Lifecycle State"** → Ch.6's eleven developmental stages → `project_phase`.

Neither of them is ADR-0003's `lifecycle_state`. Part XI predates the COM and does not describe record lifecycle at all; the base `lifecycle_state` is a third thing Ch.3 never mentions. The three-axis model is therefore *what the corpus already says*, not an invention layered on top of it.

**`project_phase` is NOT a duplicate of `project_status`.** It measures **developmental maturity**; `project_status` measures **operational state**. They vary independently, and **a Project may hold any combination of the two.** Concretely: a project **Paused** (status) while in the **Implementation** phase is normal and must be representable — the work is half-built and currently stopped. So is **Blocked** while in **Validation**. So is **Maintenance** while in **Operation**. Any logic that infers one axis from the other is a defect.

**No aliasing, in any direction, between any of the three.** They MUST NOT be unified, aliased, widened into one another, or derived from one another. Downstream code MUST read the axis it actually means. See Consequence 4 — the vocabularies overlap in five places, and the overlap is a trap.

`project_phase` is **not monotonic.** Ch.6: "Projects may revisit earlier stages as new information emerges." Unlike Objective promotion (ADR-0010), phase transitions may move backward, and the schema must not enforce a forward-only rule.

### 4. Ch.3's field list is field-unified per COM §12.

COM §12 is binding: a subtype "**must not** redeclare" a field semantically identical to a base-schema field. Applying it to Ch.3's eleven:

| Ch.3 field | Unifies into | Notes |
|---|---|---|
| Project Identifier | `entity_id` (§3.1) | It *is* the entity id. |
| Name | `name` (§3.1) | |
| Owner | `owner_id` + `owner_type` (§7) | Base `ActorRef` shape. |
| Creation Date | `created_at` (§3.3) | ISO 8601 UTC per §10. |
| Organizational Scope | `organizational_containers[]` (§3.4) | A Project nested in a Program is *container* nesting (`nestContainer`, runtime-interfaces §2.5). **Never** `work_hierarchy_parent`. |
| Status | `project_status` (new) | Ch.7. See §3. |
| Lifecycle State | `project_phase` (new) | Ch.6. See §3. **Not** base `lifecycle_state`. |

Remaining as new fields on the subtype:

| Field | Type | Required | Notes |
|---|---|---|---|
| `purpose` | string | Yes | |
| `mission` | string | Yes | **Prose.** A mission *statement*, not a reference to a Work Hierarchy Mission — see §5. |
| `vision` | string | Yes | **Prose.** A vision *statement*, not a reference to a `vision` container — see §5. |
| `project_dna` | `ProjectDna` value object | Yes | Ch.4's eight sub-fields. Immutable — see §6. |
| `project_status` | `ProjectStatus` enum | Yes | `initializing`, `planning`, `active_development`, `maintenance`, `paused`, `blocked`, `migrating`, `archived`, `retired` |
| `project_phase` | `ProjectPhase` enum | Yes | `concept`, `research`, `architecture`, `planning`, `implementation`, `validation`, `deployment`, `operation`, `evolution`, `retirement`, `archive` |
| `project_status_history` | `Array<{ status, entered_at, actor }>` | Yes, `[]` | Append-only, per Ch.7's "explicit and auditable" and AGENTS.md rule 5. Mirrors `lifecycle_history`. **No `project_phase_history` — Ch.6 requires no audit trail; see Consequence 6.** |

`ProjectDna` (Ch.4) is a nested **value object**, not an entity — no independent identity, persistence, or lifecycle: `mission`, `core_principles[]`, `target_users[]`, `architectural_philosophy`, `quality_expectations[]`, `long_term_objectives[]`, `non_goals[]`, `governance_constraints[]`.

### 5. `mission` and `vision` are prose strings, not references. (Founder-confirmed.)

Both words name other things in the model — **Mission** is the Work Hierarchy's top level (ADR-0004), and **`vision`** is a member of the `container_type` enum (COM §3.4) — so this must be stated rather than assumed.

They are **prose**. Ch.4's Project DNA lists "mission" alongside "core principles," "non-goals," and "governance constraints," which are unambiguously prose; Ch.3's usage is the same register. Typed as `string`.

**This is load-bearing, not pedantry.** Had `Project.mission` been modeled as a Work-Hierarchy reference, it would have hung a **Work Hierarchy level onto an Organizational Container** — precisely the merge ADR-0004 Amendment A corrected in four separate places and that AGENTS.md rule 4 exists to prevent. A Project does not *have* a position in the Work Hierarchy. It **must not** gain `work_hierarchy_parent`.

### 6. Project DNA is immutable, reusing the ADR-0010 / COM §5.1 mechanism.

Ch.4: Project DNA is the project's "immutable characteristics" and "constitutional document." Enforced as a **write-time rule in the persistence layer** — the same mechanism as Memory Object immutability (§5.1) and Objective definition immutability (§5.3), not a third one.

`project_dna` is immutable after creation. Revision creates a **new `entity_id`** with an incremented `version` and a `supersedes` relationship to the prior Project. Transitions of `project_status`, `project_phase`, and `lifecycle_state` are **not** DNA mutations and remain permitted.

Ch.4 does say "Significant modifications require governance review" — implying DNA is amendable *under governance*, not absolutely frozen. **No governance model is ratified** (COM §6 item 1; ADR-0003 deprecated SEF/ADM/ARB-ERB-CRB and nothing replaced them). Strict immutability is therefore the conservative reading: it cannot be *wrongly* mutated, and a future governance model can relax it. The reverse — permitting mutation now and tightening later — would silently allow exactly the edits Ch.4 calls constitutional.

### 7. Program and Release remain non-entities. No placeholder subtypes.

**Explicitly not created.** The corpus contains **no field-level specification for either** — nothing remotely comparable to Part XI's ~580 lines on Project. Creating `entity_subtype: 'program'` or `'release'` would mean inventing their fields outright: the unilateral resolution the standing rule forbids, and exactly the mistake a "for symmetry" argument invites.

Same for the remaining container types: `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace`. They stay bare references. Should a field-level model for any later be sourced, it can take this same path without amending this ADR's taxonomy.

## Rationale

- **It uses the mechanism the COM already ratified** (`entity_subtype`, §12) — no sixth entity type, no new persistence machinery, no new immutability mechanism.
- **It is evidence-led, not symmetry-led.** Project is promoted because Part XI specifies it in depth; Program and Release are not, because nothing specifies them. That asymmetry is the discipline, and it is the same reasoning ADR-0010 used to promote Objective while leaving Mission alone.
- **The three axes are read off the corpus, not invented.** Ch.3 names two status fields; Ch.6 and Ch.7 define two distinct models; ADR-0003 supplies the record lifecycle. Collapsing any of them would be the invention.
- **It does not reopen ADR-0004 Amendment A's split.** Project stays a container. Only its *backing* changes.

## Consequences

1. **COM §2b must be amended, and §4.5/§5 extended.** §2b's "Organizational Containers … are not entities" ceases to be true of Project. It remains true of every other container type. §4.5's `entity_subtype` list gains `project`; §5 gains a Project subsection.

2. **`organizational_containers` becomes *partially* dereferenceable, which is a real wart.** An entry with `container_type: 'project'` resolves to a record; the other eight (`program`, `release`, `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace`) still resolve to nothing. Callers cannot assume a container id is resolvable — they must branch on `container_type`. This is ergonomically worse than either "all containers are entities" or "none are," and it is accepted deliberately, because the alternative is inventing eight field models from nothing. State it loudly wherever the field is consumed.

3. **`ContainerService` (runtime-interfaces §2.5) is still not fully implementable.** `createContainer(type, spec)` remains unimplementable for non-Project types, and `ContainerSpec` remains undefined in the corpus. **`@aios/containers` is therefore still blocked as a whole package** — this ADR unblocks *Project*, not the Container Service. Divergence-log conflict #2 is **narrowed, not closed**.

4. **⚠️ THE THREE VOCABULARIES OVERLAP IN FIVE PLACES. SHARED TERMINOLOGY DOES NOT MEAN SHARED MEANING.**

   This is the single most likely way a future change corrupts this model: someone sees the same word on two axes, assumes they are the same concept, and aliases them. They are not. Every collision below is a **different concept wearing the same name**:

   | Term | `lifecycle_state` (ADR-0003) | `project_status` (Ch.7) | `project_phase` (Ch.6) |
   |---|---|---|---|
   | **archive/archived** | `archived` — record is a lifecycle terminus | `archived` — project is operationally shelved | `archive` — final developmental stage |
   | **planning** | — | `planning` — currently doing planning work | `planning` — developmental stage after Architecture |
   | **retire/retired** | — | `retired` — project is operationally retired | `retirement` — developmental stage before Archive |
   | **active** | `active` — record is in its Active lifecycle stage | `active_development` — team is actively building | — |
   | **validate/validation** | `validated` — record passed lifecycle validation | — | `validation` — developmental stage after Implementation |

   The **archived** collision is three-way and the worst: a Project can legitimately be `project_status: 'archived'` (operationally shelved) while its record is `lifecycle_state: 'active'` (still live and readable) and its `project_phase` is `'operation'` (it was shipped and running when it got shelved). Any code that treats one as implying another is wrong.

   **Rules, to be enforced in code and tests:**
   - No axis may be derived from, defaulted from, or validated against another.
   - No shared enum type, no shared union, no string-comparison across axes.
   - No single combined history array with an axis discriminator — that would put three vocabularies in one place and invite the very aliasing this forbids. See Consequence 6.

   **REQUIRED TEST FIXTURE — `SHELVED_PROJECT`.** The following combination is the canonical proof that the no-aliasing rules hold, and it MUST exist, under this name, in the Project test suite:

   ```
   SHELVED_PROJECT:
     project_status:  'archived'    // operationally shelved — nobody is working on it
     lifecycle_state: 'active'      // the RECORD is live, readable, not a lifecycle terminus
     project_phase:   'operation'   // it already shipped; it was running when it got shelved
   ```

   A shelved project whose record is still live and whose phase says it already shipped. Every one of the three values says something different and true, and **no two of them can be inferred from each other.** Any implementation that aliases the axes — that reads `project_status: 'archived'` and concludes the record is archived, or that derives `lifecycle_state` from `project_status` — fails on this fixture and only on this fixture. That is what makes it the one that matters.

   Tests MUST assert that `SHELVED_PROJECT` validates, persists, and round-trips with all three values intact. A second, weaker case SHOULD also be pinned: `project_status: 'paused'` + `project_phase: 'implementation'` + `lifecycle_state: 'active'` (a half-built project, currently stopped).

   This is the same class of defect as merging `work_hierarchy_parent` with `organizational_containers` (AGENTS.md rule 4): concepts that look mergeable and are not. It cost that reconciliation four separate fix locations.

5. **`project_phase` is not monotonic** (Ch.6: "Projects may revisit earlier stages"). No forward-only constraint, unlike Objective promotion. A phase moving backward is legal and must not be rejected.

6. **`project_status` gets an append-only history. `project_phase` does NOT.**

   `lifecycle_history` (COM §3.2) is append-only but records **`lifecycle_state`** transitions only — it has no room for the other two axes. Without something equivalent, you can read a Project's current status but have no record of how it got there.

   **`project_status_history` — added. Not a judgment call.** Ch.7 states the requirement outright: *"State transitions are explicit and auditable."* That is a MUST in the corpus, and the shape is already established by `lifecycle_history` and governed by AGENTS.md rule 5 (append-only, never written in place). Field: `project_status_history: Array<{ status, entered_at, actor }>`, mirroring `LifecycleHistoryEntry`.

   **`project_phase_history` — deliberately NOT added.** **Ch.6 states no auditability requirement.** It says only that "Projects may revisit earlier stages as new information emerges." A phase history is therefore **unsourced** — an earlier revision of this ADR recommended one, which was an extrapolation of Ch.7's requirement onto Ch.6 and exactly the kind of unsourced structure this project's standing rule forbids. It is omitted.

   The cost of omitting it is near-zero and recoverable: adding an optional field later is an additive, non-breaking minor release (`implementation-playbook.md` §3). The cost of guessing wrong now is a permanent unsourced field in a ratified schema. If real usage shows phase history is needed, that is the trigger to add it — with evidence rather than by analogy.

   **Rejected alternative:** a single combined `status_history` array with an `axis` discriminator. It would hold three distinct vocabularies in one array — including three different meanings of `archived` (see Consequence 4) — which is an open invitation to the aliasing bug this ADR exists to prevent. Separate fields, separate vocabularies, no shared container.

## Founder decisions folded into this revision (2026-07-13)

- **Ch.6's eleven-stage model becomes `project_phase`**, a third orthogonal axis (was Question 1 → resolved to option (b)). Rationale recorded in §3.
- **`mission` and `vision` are prose strings**, not references (was Question 2). Recorded in §5, with the rule-4 hazard the other reading would have created.
- **This ADR amends ADR-0004 Amendment A, not ADR-0003** (was Question 3). ADR-0003 ratifies five lifecycle-bearing entity types; Project is a subtype of one of them (Canonical Object), so the five-type list is untouched. Precedent is exact: Plugin's `install_status` is an orthogonal status axis introduced with **no** ADR-0003 amendment (COM §4.4). Both `project_status` and `project_phase` follow that pattern.

**Revision 3 (2026-07-13)** closes the last open item and adds one binding test requirement:

- **`SHELVED_PROJECT` is now a REQUIRED, named test fixture** (Consequence 4): `project_status: 'archived'` + `lifecycle_state: 'active'` + `project_phase: 'operation'`. It is the canonical proof that the no-aliasing rules hold — the one case an aliasing implementation cannot pass.
- **Consequence 6 is resolved, and one of its two halves was my error.** `project_status_history` is added because Ch.7 *requires* auditability ("State transitions are explicit and auditable") — not a judgment call. `project_phase_history` is **dropped**: Ch.6 states no such requirement, so recommending one in revision 2 was an unsourced extrapolation. Omitted, and additive to add later if evidence appears.

No open items remain. This ADR is ready to accept or reject.

## Superseded Decisions

**Amends ADR-0007**, whose Decision states "Mission, Objective, and Organizational Containers are reference/container fields, not entities." That clause is superseded **as to Project only** (ADR-0010 already superseded it as to Objective). Its load-bearing boundary — **"No sixth entity type is introduced"** — is **not** superseded and is expressly reaffirmed.

**Amends ADR-0004 Amendment A**, as to Project only: a Project is now a lifecycle-bearing record. **The Work Hierarchy / Organizational Container split itself is NOT amended** — Project remains a container and does not become a rung of the Work Hierarchy. That split stands exactly as ratified, and §5 above hardens it.

**ADR-0003 is not amended.** Neither `project_status` nor `project_phase` competes with the Unified Lifecycle Model; both are orthogonal axes in the sense `reconciliation-changelog.md` Session 8 already established for other domain lifecycles ("legitimately different axes from ADR-0003"). Note that Part XI Ch.6/Ch.7 were **absent** from that session's verified list — this ADR is where they get the same treatment.

**ADR-0010 is not affected.**

Divergence-log conflict #2 is **narrowed, not closed** — `@aios/containers` remains blocked on `ContainerSpec` and the eight unsourced container types.
