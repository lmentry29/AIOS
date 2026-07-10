# AIOS Canonical Object Model (COM) — v1

**Status: Proposed.** This is the first implementation-readiness artifact produced after AIOS Architecture Version 1 Certification (see `V1-FINAL-CERTIFICATION-REPORT.md`). It is derived entirely from the seven accepted ADRs/amendments and the certified corpus; it introduces no new architectural principle. Per the founder's standing instruction, it is authored autonomously as a "logical consequence of the accepted architecture" and does not require sign-off before use — flag disagreements as they surface rather than blocking on review.

Recommended action once reviewed: ratify as **ADR-0007 — Canonical Object Model**, per `V1-FINAL-CERTIFICATION-REPORT.md` §5.

---

## 0. Purpose

The certified architecture establishes *that* AIOS has a unified entity lifecycle (ADR-0003), three execution loops (ADR-0002), a ten-layer stack (ADR-0001), and a Work Hierarchy distinct from Organizational Containers (ADR-0004). It does not establish *what fields exist on an entity*, *what an entity is made of*, or *how entities reference each other*. That gap is what blocks implementation — you cannot write a database schema, an API contract, or a runtime type against "Agents have a lifecycle." The COM closes that gap: it is the bridge between the certified architecture and running code.

---

## 1. Design principles

1. **No new entity types.** ADR-0003 names exactly five entity types as lifecycle-bearing: Agent, Task, Workflow, Plugin, Canonical Object. The COM formalizes these five and nothing else at the top level. Everything else in the corpus (Memory Object, Mission, Objective, Action, Project, Worker, Adapter, Artifact...) is modeled as either a **specialization** of one of the five, a **supporting/reference type**, or a **container**, not a sixth peer entity — introducing a sixth would itself be an architectural decision requiring founder input, so this model deliberately doesn't.
2. **One shared base schema.** Per ADR-0003's mandate that all five types share one lifecycle backbone rather than five independent ones, they also share one base object schema. Type-specific fields are additive, not replacements.
3. **Work Hierarchy fields are structural, not decorative.** Per ADR-0004 and its Amendment A, every entity that participates in execution must be able to state its position in Mission → Objective → Task → Action and, separately, which Organizational Container(s) it's assigned into. These are two different reference fields, never merged.
4. **Terminology unified where the corpus used two names for one thing.** The Specification (Part VI Ch.10) uses "Runtime Object" for exactly the concept ADR-0003 calls "Canonical Object." This is a naming variance, not a conceptual conflict — both describe the same lifecycle-bearing persisted entity, specialized via the Object Lifecycle Loop (ADR-0002). The COM canonicalizes on **Canonical Object** (the ADR-0003 term, since ADR-0003 is the more recent, ratifying decision) and treats "Runtime Object" as a deprecated synonym to retire from future documentation. This is a terminology fix, not a founder-level decision — consistent with the reconciliation project's existing pattern of resolving naming variance autonomously.
5. **Memory Object is a specialization of Canonical Object, not a sixth type.** Part VIII Ch.5's Memory Object field list (Memory Identifier, Memory Type, Title, Description, Owner, Project Association, Creation Time, Modification History, Confidence, Importance, Relationships, Evidence, Version, Source References, Access Policy) is the most fully-specified entity schema anywhere in the corpus. It is adopted here as the model for how a Canonical Object specializes the base schema — Memory Object is what a Canonical Object looks like when its type is "stored organizational knowledge." Other Canonical Object types (see §5) follow the same pattern with different type-specific fields.
6. **Plugin is thin in the source corpus (documentation-thinness debt, not a modeling blocker).** "Plugin" appears in ADR-0003's entity list but nowhere else in the certified corpus with field-level detail — the Tooling Ecosystem (Part XIII) describes Tools and Adapters but never uses the word "Plugin." The COM treats Plugin as the installable/extensible unit operating at the Tool Abstraction Layer (ADR-0001, layer 8), modeled from the Adapter/Tool concepts that *are* specified, and flags the thinness explicitly (§5.4) rather than inventing unsourced detail.
7. **Everything is Proposed until ratified.** Per ADR-0003's own status ("implementation details remain Proposed/Derived until formally ratified"), every schema below inherits that status. Nothing here overrides an ADR; where the corpus is silent, this document says so rather than presenting invention as fact.

---

## 2. Entity taxonomy

```
                         Canonical Entity (abstract base — §3)
                                    │
        ┌───────────┬──────────────┼──────────────┬───────────────┐
        │           │              │               │               │
      Agent        Task         Workflow         Plugin      Canonical Object
   (autonomous   (Work         (structured    (installable/    (persisted,
    execution     Hierarchy     activity        extensible      lifecycle-
    entity)       unit —        sequence)       unit, Tool      bearing data
                  see §2a)                       Abstraction    entity)
                                                  Layer)              │
                                                                      ├── Memory Object (§5.1)
                                                                      ├── Artifact (§5.2)
                                                                      └── [other Canonical
                                                                           Object types, open]
```

**§2a — Task and Action are not both top-level lifecycle entities.** ADR-0003 lists "Tasks" (plural, matching the Work Hierarchy's Task level) as lifecycle-bearing but does not separately list Action. Resolution: **Task** is the lifecycle-bearing entity (Created→...→Archived per ADR-0003); **Action** is modeled as a sub-state/step within a Task's Active stage, consistent with Appendix A's definition ("Actions are indivisible from the perspective of the Planning Engine" — i.e., Actions are not independently tracked through the full lifecycle, they execute within a Task's Active stage). This is a schema-level clarification, not a new architectural claim — ADR-0004 already establishes Task consists of Actions; this just states which of the two carries lifecycle state.

**Mission, Objective, and Organizational Containers (Project, Program, Release, etc.) are not entities in this model — they are reference/container fields.** Per ADR-0004 Amendment A, they organize and scope entities but are not themselves lifecycle-bearing execution units in the ADR-0003 sense. They appear below as foreign-key-style fields on the entities that reference them (§3.4), not as rows in the entity taxonomy diagram above.

---

## 3. Base schema — Canonical Entity

Every Agent, Task, Workflow, Plugin, and Canonical Object instance carries these fields. Type-specific schemas (§4–§5) add to this set; none may omit it.

### 3.1 Identity

| Field | Type | Required | Notes |
|---|---|---|---|
| `entity_id` | UUID | Yes | Globally unique across all five entity types, not just within one type. Prevents ID collisions when entities cross-reference each other. |
| `entity_type` | enum(`agent`, `task`, `workflow`, `plugin`, `canonical_object`) | Yes | Discriminator. Determines which type-specific schema (§4–§5) applies. |
| `entity_subtype` | string | No | Free-text specialization within a type, e.g. `canonical_object` → `memory_object`, `artifact`. Open vocabulary, not enumerated here — see §5's note on why this is deliberately left open. |
| `name` | string | Yes | Human-readable label. Not guaranteed unique. |
| `description` | string | No | |

### 3.2 Lifecycle (per ADR-0003)

| Field | Type | Required | Notes |
|---|---|---|---|
| `lifecycle_state` | enum(`created`, `validated`, `active`, `monitored`, `suspended`, `completed`, `archived`) | Yes | The seven canonical stages, verbatim from ADR-0003. `suspended` is optional per ADR-0003's own text ("Suspended (optional)") — an entity MAY transition `active`/`monitored` → `completed` without passing through `suspended`. |
| `lifecycle_substate` | string | No | Entity-type-specific specialization of the current canonical stage (e.g., an Agent in `active` may have substate `planning`, `reasoning`, `executing`, or `monitoring` per the Agent Execution Loop, ADR-0002). MUST map back to exactly one of the seven canonical stages — enforced at the schema level by requiring `lifecycle_substate` to declare its parent `lifecycle_state`. |
| `lifecycle_history` | array of `{state, substate, entered_at, actor}` | Yes | Append-only. Every transition is a new array entry, never an overwrite — this is the field that makes Audit (per the Glossary's "Audit" definition) possible at all. |

### 3.3 Provenance

| Field | Type | Required | Notes |
|---|---|---|---|
| `created_at` | timestamp | Yes | |
| `created_by` | reference (Agent entity_id, or `human:<founder_id>`) | Yes | Every entity's origin is either an Agent or a human — no entity is created without an attributable actor, consistent with Founder Intelligence's audit expectations (ADR-0006). |
| `modified_at` | timestamp | Yes | |
| `version` | integer | Yes | Monotonically increasing. Mirrors Memory Object's `Version` field (§5.1), generalized to all entity types. |

### 3.4 Hierarchy and container references

This is the field group that directly implements ADR-0004 Amendment A's split. **The two reference groups below are never merged into one field** — that was the exact defect ADR-0004 Amendment A corrected in four places in the prose corpus, and merging them back together in the schema would silently reintroduce it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `work_hierarchy_parent` | reference + level enum(`mission`, `objective`, `task`) | Conditional | Present on Task and (optionally) Workflow entities that execute *within* the Work Hierarchy. An Agent or Plugin instance is not itself a Work Hierarchy member and omits this field — it *acts on* Tasks rather than occupying a position in the hierarchy. |
| `organizational_containers` | array of reference + container_type enum(`project`, `program`, `release`, `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace`) | No | Zero or more. Per ADR-0004 Amendment A, containers "hold, group, or schedule" — this is deliberately an array (an entity can be scoped inside more than one container simultaneously, e.g. a Task inside both a Project and a Milestone), whereas `work_hierarchy_parent` is deliberately singular (Work Hierarchy position is a strict tree, not a graph). |

### 3.5 Access and audit

| Field | Type | Required | Notes |
|---|---|---|---|
| `access_policy` | reference | No | Generalizes Memory Object's `Access Policy` field (§5.1) to all entity types. Governance/authorization mechanism itself is out of scope for this document — SEF/ADM/ARB-ERB-CRB are deprecated (ADR-0003) and no replacement has been ratified, so this field is a placeholder reference type pending that future governance work, not a fully specified permission model. |
| `audit_trail_ref` | reference | No | Points to the Audit reconstruction record (Glossary: "Audit") if one has been generated for this entity. |

---

## 4. Entity-specific schemas

### 4.1 Agent

Extends the base schema (§3). Governed by the **Agent Execution Loop** (ADR-0002): planning → reasoning → execution → monitoring → completion, mapped onto the base `lifecycle_state`/`lifecycle_substate` fields as follows:

| `lifecycle_state` | `lifecycle_substate` (Agent-specific) |
|---|---|
| `created` | *(instantiated, not yet validated)* |
| `validated` | *(capability/authorization check passed)* |
| `active` | `planning`, `reasoning`, `executing`, `monitoring` |
| `suspended` | *(paused mid-loop)* |
| `completed` | *(loop terminated normally)* |
| `archived` | *(retired)* |

Additional fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `current_role` | enum(`agent`, `worker`) | Yes | Per the Glossary's Agent/Worker distinction: an Agent acting through the Worker role during a bounded unit of execution sets this to `worker` for that duration. Same `entity_id` throughout — Worker is a role flag, not a separate entity, resolving the Glossary's careful "every Agent acts through the Worker role... but Agent refers to the entity, Worker to the role" language into a concrete field. |
| `governing_layer` | fixed = `organizational_departments` \| `runtime_coordination_kernel` | Yes | Per the Glossary: "Agents operate within the Organizational Departments and Runtime Coordination Kernel layers" (ADR-0001, layers 4–5). Never `human_layer` or `executive_governance` — Agents "never hold constitutional or governance authority" per the same Glossary entry. |
| `assigned_tasks` | array of Task `entity_id` | No | Tasks currently being executed by this Agent. |
| `capabilities` | array of string | No | Open vocabulary pending a future Capability Model (candidate AIOS-FND material per `V1-FINAL-CERTIFICATION-REPORT.md` §3). |

### 4.2 Task

Extends the base schema. `work_hierarchy_parent` is **required** at level `objective` (a Task's parent must be an Objective, never a Mission or another Task directly — per ADR-0004's canonical chain Mission → Objective → Task → Action).

| Field | Type | Required | Notes |
|---|---|---|---|
| `actions` | array of Action sub-objects (§4.2.1) | No | Actions execute within a Task's `active` stage; they are not independently addressable Canonical Entities (see §2a). |
| `assigned_agent` | reference (Agent `entity_id`) | No | The Agent currently executing this Task, if any. |
| `assigned_workflow` | reference (Workflow `entity_id`) | No | If this Task is a step within a larger Workflow. |

#### 4.2.1 Action (sub-object, not a top-level entity)

| Field | Type | Required | Notes |
|---|---|---|---|
| `action_id` | UUID | Yes | Unique within its parent Task, not globally required per §3.1's `entity_id` rule — Actions are explicitly excluded from the "every entity has a global entity_id" requirement because they are not Canonical Entities. |
| `status` | enum(`pending`, `executing`, `completed`, `failed`) | Yes | A simplified, non-ADR-0003 status field — Actions don't carry the full seven-stage lifecycle since they're "indivisible from the perspective of the Planning Engine" (Appendix A) and complete atomically within a Task's `active` stage. |
| `executed_by` | reference (Agent `entity_id`) | Yes | |

### 4.3 Workflow

Extends the base schema.

| Field | Type | Required | Notes |
|---|---|---|---|
| `steps` | ordered array of Task `entity_id` | Yes | Per the Glossary: "a structured sequence of organizational activities designed to achieve a defined outcome." A Workflow is a sequencing/orchestration wrapper over Tasks, not a container in the ADR-0004 Amendment A sense (it doesn't "hold or schedule" — it *sequences execution*, which is a System Execution Loop concern, ADR-0002). |
| `trigger` | reference or schedule expression | No | What initiates this Workflow — left open pending a future Event Model (AIOS-FND candidate material). |
| `governing_loop` | fixed = `system_execution_loop` | Yes | Per ADR-0002: Workflows are dispatched/coordinated at the system level, distinct from the Agent Execution Loop that governs individual Task execution within a Workflow's steps. |

### 4.4 Plugin

Extends the base schema. **Flagged as thin per §1.6** — modeled from Tooling Ecosystem's Adapter/Tool concepts, not from a dedicated Plugin specification (none exists in the certified corpus).

| Field | Type | Required | Notes |
|---|---|---|---|
| `governing_layer` | fixed = `tool_abstraction_layer` | Yes | ADR-0001, layer 8. |
| `wraps_adapter` | reference (Adapter, if formally modeled) | No | Per the Glossary: "Adapter — a software component that translates AIOS capability interfaces into tool-specific operations." A Plugin is provisionally modeled as an installable unit that packages one or more Adapters; this mapping is this document's own inference, not sourced from the corpus, and should be treated as the lowest-confidence claim in this model. |
| `install_status` | enum(`available`, `installed`, `enabled`, `disabled`, `removed`) | Yes | Distinct from `lifecycle_state` — installation status and ADR-0003 lifecycle state are orthogonal (a Plugin can be `lifecycle_state: active` and `install_status: disabled` simultaneously, e.g. temporarily turned off without being archived). |

### 4.5 Canonical Object

Extends the base schema. Governed by the **Object Lifecycle Loop** (ADR-0002): validation → mutation → persistence → synchronization → archival, mapped onto `lifecycle_state`/`lifecycle_substate`:

| `lifecycle_state` | `lifecycle_substate` (Canonical Object-specific) |
|---|---|
| `created` | *(instantiated, not yet validated)* |
| `validated` | *(passed Object Lifecycle Loop validation)* |
| `active` | `mutating`, `persisting`, `synchronizing` |
| `suspended` | *(locked, e.g. pending conflict resolution)* |
| `completed` | *(finalized, no further mutation expected)* |
| `archived` | *(per Memory Object: "immutable after publication — evolution creates new versions," archival here means the object itself, not a version)* |

`entity_subtype` values observed/specified in the certified corpus (open list, §5 expands the two that have field-level detail):

- `memory_object` — see §5.1
- `artifact` — see §5.2
- others: open, pending further specification as implementation proceeds

---

## 5. Canonical Object specializations

### 5.1 Memory Object

The most fully-specified Canonical Object subtype, sourced directly from *AIOS Specification Project* Part VIII Ch.5 (found and flagged as COM candidate input during the final reconciliation read, per `RECONCILIATION-CHANGELOG.md` Session 8). Adds these fields on top of the base Canonical Entity schema (§3) and Canonical Object schema (§4.5):

| Field (source name) | COM field | Type | Notes |
|---|---|---|---|
| Memory Identifier | *(mapped to base `entity_id`)* | UUID | No longer a separate field — unified with the base schema's identity field per design principle 2. |
| Memory Type | `memory_type` | enum | Semantic / Episodic / Procedural / Decision / Project / Founder / Research / Operational / Reference (per Part VIII Ch.6's Memory Domains). |
| Title | *(mapped to base `name`)* | string | Unified with base schema. |
| Description | *(mapped to base `description`)* | string | Unified with base schema. |
| Owner | `owner` | reference (Agent `entity_id` or `human:<founder_id>`) | |
| Project Association | *(mapped to base `organizational_containers`, filtered to `container_type: project`)* | array | Unified with base schema's container references (§3.4) rather than kept as a separate single-project field — generalizes correctly since §3.4 already supports multiple containers. |
| Creation Time | *(mapped to base `created_at`)* | timestamp | Unified. |
| Modification History | *(mapped to base `lifecycle_history`, extended)* | array | Unified — Memory Object's modification history is a specialization of the base audit trail. |
| Confidence | `confidence` | float or enum | Memory Object-specific; mirrors the Assumption Glossary entry's "confidence, provenance, and review criteria." |
| Importance | `importance` | enum | Memory Object-specific. |
| Relationships | `relationships` | array of `{target entity_id, relationship_type}` | Open relationship-type vocabulary — no enumerated list exists in the source; left open rather than invented. |
| Evidence | `evidence` | array of reference | |
| Version | *(mapped to base `version`)* | integer | Unified with base schema. |
| Source References | `source_references` | array of reference | |
| Access Policy | *(mapped to base `access_policy`)* | reference | Unified with base schema. |

**Immutability note carried forward verbatim:** "Memory Objects are immutable after publication. Evolution creates new versions" (Part VIII Ch.5). This is a constraint on `lifecycle_state` transitions specific to this subtype: once a Memory Object reaches `completed`, no further `active` mutation is permitted on that `entity_id` — a new `entity_id` with an incremented `version` and a `relationships` entry of type `supersedes` pointing back to the prior version is created instead. This is the one place in the COM where a subtype constrains the base lifecycle rather than merely specializing its substates, and it's called out explicitly rather than left implicit.

### 5.2 Artifact

Per the Glossary's Artifact entry ("any persistent output... becomes organizational knowledge after publication"). Modeled as a thin Canonical Object subtype — `entity_subtype: artifact`, `artifact_kind` enum(`documentation`, `source_code`, `architecture_diagram`, `research_report`, `adr`, `benchmark`, `test_report`) per the Glossary's own example list. No further field-level detail exists in the certified corpus; not expanded further here to avoid inventing unsourced structure.

---

## 6. Open items (explicitly not resolved here)

Per design principle 7, listed rather than silently decided:

1. **Access/authorization model** — `access_policy` is a placeholder reference type. The deprecation of SEF/ADM/ARB-ERB-CRB (ADR-0003) removed the only governance mechanism the corpus had; no replacement is ratified. Not a founder-level architectural decision to raise now — it's a future artifact (Validation Specification or a dedicated Access Model), noted here as a dependency the COM has but does not resolve.
2. **Event Model** — `Workflow.trigger` and any future event-driven Agent dispatch reference this. AIOS-FND candidate material (per `V1-FINAL-CERTIFICATION-REPORT.md` §3) covers this; not duplicated here.
3. **Capability Model** — `Agent.capabilities` is an open string array pending formal capability taxonomy. Same status as above.
4. **Plugin field detail** — flagged low-confidence in §4.4; should be revisited once the Tooling Ecosystem gets its own dedicated schema pass (a natural next artifact, see §7).
5. **Relationship-type vocabulary** (§5.1) — left open, no enumerated list existed to draw from.

None of the above block producing the next artifacts in dependency order (§7) — they're referenced as open/typed-as-reference fields, which is sufficient to keep moving without inventing unsourced governance or event semantics.

---

## 7. Ownership model

Every Canonical Entity has exactly one accountable owner at any point in time, distinct from `created_by` (§3.3, which is provenance/origin and never changes) and from `assigned_agent`/`assigned_workflow` (which are execution assignment, not accountability).

| Field | Type | Required | Notes |
|---|---|---|---|
| `owner_id` | reference (Agent `entity_id` or `human:<founder_id>`) | Yes | Accountable party. Mutable — ownership can transfer (e.g., a Task escalated from an Agent to the founder). Every transfer is logged as a `lifecycle_history` entry with `actor` set to the party initiating the transfer, not the new owner, so the audit trail records *who reassigned it* not just *who has it now*. |
| `owner_type` | enum(`agent`, `human`) | Yes | Redundant with `owner_id`'s prefix but kept explicit for query performance — implementations MAY use only the prefix if preferred; this field is a convenience, not a separate source of truth. |

Ownership rules:
- A human (the founder, currently the only human in a single-founder project per ADR-0003's stated context) can own any entity type. An Agent can own Task, Workflow, Plugin, and Canonical Object instances, but **an Agent cannot own another Agent** — Agent-to-Agent accountability would imply a governance/authority relationship the certified architecture explicitly reserves for the Human Layer and Executive Governance (per the Glossary's Agent entry: Agents "never hold constitutional or governance authority"). An Agent instance's `owner_id` MUST resolve to a human.
- Ownership is a stronger claim than the base schema's `access_policy` (§3.5) — `access_policy` governs *who may act on* an entity; `owner_id` governs *who is accountable for* it. They are typically but not necessarily the same party.

## 8. Relationship model

Generalizes Memory Object's ad hoc `relationships` field (§5.1) into a model that applies across all five entity types, not just Canonical Objects.

| Field | Type | Notes |
|---|---|---|
| `relationships` | array of `{target_entity_id, target_entity_type, relationship_type, direction}` | Present on the base schema (§3), not just Canonical Object. Every relationship is stored once and interpreted bidirectionally via `direction` (`outbound`/`inbound`) rather than duplicated on both entities — avoids the two-copies-of-the-same-fact problem the reconciliation project spent nine sessions removing from prose documentation; no reason to reintroduce it in schema form. |

Relationship types, minimum set (open vocabulary beyond this, per §6 item 5 — this is the floor, not the ceiling):

- `supersedes` / `superseded_by` — versioning (used by Memory Object's immutability rule, §5.1).
- `assigned_to` — Task→Agent, Workflow→Agent (mirrors `assigned_agent`/`assigned_workflow` as first-class relationship entries, not just flat fields — the flat fields are a query convenience, the relationship entries are the source of truth, matching how `work_hierarchy_parent` and `relationships` coexist elsewhere in this model).
- `depends_on` / `blocks` — Task-to-Task or Workflow-step ordering, needed for Tier 3's dependency graph and Tier 7's build-order artifacts, not yet used elsewhere in this document.
- `derived_from` — Canonical Object provenance where an object was generated from another (e.g., a Research Report Artifact derived from Memory Objects it cites).
- `contains` — the inverse of Organizational Container membership (§3.4), exposed as a relationship for cases where container structure itself needs to be queried as a graph.

## 9. Identity scheme

- `entity_id` (§3.1) is a UUIDv4, globally unique, assigned at creation, and **never reused or reassigned**, including after archival — an archived entity's ID is permanently retired, not recycled, so historical references (audit trails, `relationships`, `lifecycle_history.actor`) never silently point to a different entity later.
- Human identity uses the `human:<founder_id>` convention introduced in §3.3/§8 rather than a UUID, since AIOS currently has exactly one human participant and a UUID would imply a registry/directory system that doesn't exist yet. This is a **provisional convention**, explicitly flagged: if AIOS ever has more than one human participant, `human:<founder_id>` needs to become a real identity subsystem — noted as a founder-level product decision if/when it becomes relevant, not resolved here.
- No entity is ever identified by `name` (§3.1) alone — `name` is explicitly non-unique (stated in §3.1) and MUST NOT be used as a foreign key anywhere in the schemas produced in Tier 2.

## 10. Serialization

- **Canonical serialization format: JSON.** Chosen because (a) it is what Tier 2's JSON Schema artifacts will validate against directly with no transformation step, (b) it is what both Claude-based and Ollama-based implementation agents can read/write without additional tooling, satisfying the AI Development Strategy's "prefer local models whenever practical" guidance by not requiring a binary/protobuf toolchain on constrained laptop environments.
- `lifecycle_history` and `relationships` (arrays that grow over time) are serialized as JSON arrays inline for entities below a size threshold (not fixed here — an implementation detail for Tier 3) and as a paginated/external reference for entities with long histories, to avoid unbounded document growth. This is flagged as a **persistence-layer concern** (§12), not a serialization-format concern — the wire format is still JSON either way; only the storage strategy differs.
- Timestamps serialize as ISO 8601 UTC strings, not epoch integers — human-readable in raw form, which matters given founder-facing tooling (Founder Operating Manual, Part XIV) will need to display these directly without a formatting layer in early implementation phases.

## 11. Persistence model

- **One canonical record per `entity_id`**, updated in place for base/identity fields, append-only for `lifecycle_history` and `relationships` (§3.2, §9) — this matches Memory Object's existing "immutable after publication, evolution creates new versions" rule (§5.1) generalized: the *record* is mutable, but its *history* is not.
- Persistence is modeled here as a required capability, not a required specific technology — per ADR-0001, entities are described down to the Memory Engine layer (layer 6) but the Compute/Network/Storage layer (layer 10) is explicitly the substrate underneath it, and choosing a specific database engine is an implementation decision for the team building against this model, not an architectural one this document should make. Flagged as **Either** (Claude or Ollama suitable) in the Tier 2/3 AI task allocation, since it's a well-bounded, low-architectural-risk decision once this model is fixed.
- Every Canonical Entity write MUST update `modified_at` and increment `version` (§3.3) atomically with the field change it accompanies — no partial writes that change data without updating provenance, since that would break the Audit capability the Glossary defines as a core organizational function.

## 12. Inheritance and specialization

- Inheritance in this model is **single-level and closed at the top, open at the bottom**: every Canonical Entity inherits from exactly one abstract base (§3) — there is no multi-base inheritance, and no entity type may inherit from another entity type (e.g., Plugin cannot inherit from Agent). This is closed by ADR-0003's explicit five-type list (§1, design principle 1).
- Below the entity-type level, specialization is **open and additive via `entity_subtype`** (§3.1, §4.5) — Memory Object and Artifact (§5) are Canonical Object subtypes; nothing prevents future subtypes (e.g., a `research_report` subtype) being added without schema-breaking changes, provided they still satisfy the full base schema (§3) and their parent entity type's schema (§4).
- Field-unification note (referenced from §5.1): where a subtype's naturally-occurring field is semantically identical to a base-schema field (Memory Identifier → `entity_id`, Title → `name`, etc.), the subtype schema **must not** redeclare it — this is the mechanism that keeps the model from re-fragmenting into per-subtype duplicate fields, the exact failure mode ADR-0003 was written to close at the lifecycle level and this document closes at the schema level.

---

## 13. What this unblocks

With entity types, base schema, and lifecycle mapping fixed, the next highest-value artifacts (in dependency order, per the founder's standing instruction to continue producing them autonomously) are:

1. **Object schemas as formal JSON Schema / type definitions** — a direct mechanical translation of §3–§5 into an implementable format (the tables above are the design; this is the artifact that makes it copy-pasteable into code).
2. **State machine diagrams** — one per entity type, rendering §3.2 and §4's lifecycle-substate tables as formal transition diagrams, including which transitions are valid and which actor/loop triggers each.
3. **Runtime interface / component contracts** — what operations each of the three execution loops (ADR-0002) performs against these schemas (e.g., what the Object Lifecycle Loop's "validation" step actually checks against the Canonical Object schema).
4. **API definitions** — CRUD-style and lifecycle-transition endpoints per entity type, now that the field-level shape of each entity is fixed.

This document does not produce those yet — it is the prerequisite for all of them and is being delivered first, per dependency order.
