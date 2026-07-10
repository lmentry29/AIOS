> **Superseded 2026-07-10.** This document's hand-written JSON Schema and TypeScript definitions are superseded by `@aios/core`'s Zod schema definitions (`packages/core/src/schema/`), from which JSON Schema is now generated (see `schemas/generated/` and `docs/process/repository-design-specification.md` §1.10). Retained here for the original design reasoning, not as an implementation source.

# AIOS Object Schemas (Tier 2) — JSON Schema + TypeScript

**Status: Proposed.** Direct mechanical translation of `AIOS-Canonical-Object-Model.md` (Tier 1) into implementable formats. No new modeling decisions are made here — anything that looks like a decision below is inherited from the COM and cross-referenced back to it. Where the COM left a field open (e.g., `capabilities`, `relationship_type` vocabulary), the schema types it as an open string/enum rather than inventing closure.

**AI task allocation for schema work in this file: Either.** Mechanical translation from a fixed design to two well-known formats is low architectural risk and does not require Claude-level reasoning; Ollama-class local models are suitable if given this document plus the COM as context. Recommend Claude only for the base-schema/inheritance layer (§1 below) where getting the discriminated-union pattern wrong would propagate errors into every downstream type; Ollama-suitable for the mechanical per-subtype schemas (§3) once the pattern is established.

---

## 1. Base schema — `CanonicalEntity`

**Claude Recommended** (discriminated union correctness is foundational — errors here propagate everywhere).

### JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://aios.dev/schemas/canonical-entity.json",
  "title": "CanonicalEntity",
  "type": "object",
  "required": ["entity_id", "entity_type", "name", "lifecycle_state", "lifecycle_history",
               "created_at", "created_by", "modified_at", "version", "owner_id", "owner_type"],
  "properties": {
    "entity_id": { "type": "string", "format": "uuid" },
    "entity_type": { "type": "string", "enum": ["agent", "task", "workflow", "plugin", "canonical_object"] },
    "entity_subtype": { "type": "string" },
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },

    "lifecycle_state": { "type": "string", "enum": ["created", "validated", "active", "monitored", "suspended", "completed", "archived"] },
    "lifecycle_substate": { "type": "string" },
    "lifecycle_history": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["state", "entered_at", "actor"],
        "properties": {
          "state": { "type": "string", "enum": ["created", "validated", "active", "monitored", "suspended", "completed", "archived"] },
          "substate": { "type": "string" },
          "entered_at": { "type": "string", "format": "date-time" },
          "actor": { "type": "string", "description": "entity_id of an Agent, or human:<founder_id>" }
        }
      },
      "minItems": 1
    },

    "created_at": { "type": "string", "format": "date-time" },
    "created_by": { "type": "string" },
    "modified_at": { "type": "string", "format": "date-time" },
    "version": { "type": "integer", "minimum": 1 },

    "work_hierarchy_parent": {
      "type": "object",
      "properties": {
        "entity_id": { "type": "string", "format": "uuid" },
        "level": { "type": "string", "enum": ["mission", "objective", "task"] }
      },
      "required": ["entity_id", "level"]
    },
    "organizational_containers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["entity_id", "container_type"],
        "properties": {
          "entity_id": { "type": "string", "format": "uuid" },
          "container_type": { "type": "string", "enum": ["project", "program", "release", "milestone", "epic", "feature", "roadmap", "vision", "workspace"] }
        }
      }
    },

    "owner_id": { "type": "string" },
    "owner_type": { "type": "string", "enum": ["agent", "human"] },

    "relationships": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["target_entity_id", "target_entity_type", "relationship_type", "direction"],
        "properties": {
          "target_entity_id": { "type": "string", "format": "uuid" },
          "target_entity_type": { "type": "string", "enum": ["agent", "task", "workflow", "plugin", "canonical_object"] },
          "relationship_type": { "type": "string", "description": "Open vocabulary; minimum set defined in COM §8: supersedes, superseded_by, assigned_to, depends_on, blocks, derived_from, contains" },
          "direction": { "type": "string", "enum": ["outbound", "inbound"] }
        }
      }
    },

    "access_policy": { "type": "string", "description": "Reference type only — no ratified access model yet, see COM §6 item 1" },
    "audit_trail_ref": { "type": "string" }
  },
  "allOf": [
    { "if": { "properties": { "entity_type": { "const": "agent" } } }, "then": { "$ref": "agent.json" } },
    { "if": { "properties": { "entity_type": { "const": "task" } } }, "then": { "$ref": "task.json" } },
    { "if": { "properties": { "entity_type": { "const": "workflow" } } }, "then": { "$ref": "workflow.json" } },
    { "if": { "properties": { "entity_type": { "const": "plugin" } } }, "then": { "$ref": "plugin.json" } },
    { "if": { "properties": { "entity_type": { "const": "canonical_object" } } }, "then": { "$ref": "canonical-object.json" } }
  ]
}
```

### TypeScript

```typescript
export type LifecycleState =
  | "created" | "validated" | "active" | "monitored" | "suspended" | "completed" | "archived";

export type EntityType = "agent" | "task" | "workflow" | "plugin" | "canonical_object";

export interface LifecycleEvent {
  state: LifecycleState;
  substate?: string;
  entered_at: string; // ISO 8601
  actor: string;       // entity_id or human:<founder_id>
}

export type WorkHierarchyLevel = "mission" | "objective" | "task";

export interface WorkHierarchyRef {
  entity_id: string;
  level: WorkHierarchyLevel;
}

export type OrganizationalContainerType =
  | "project" | "program" | "release" | "milestone" | "epic" | "feature" | "roadmap" | "vision" | "workspace";

export interface OrganizationalContainerRef {
  entity_id: string;
  container_type: OrganizationalContainerType;
}

export type RelationshipDirection = "outbound" | "inbound";

// Minimum relationship_type vocabulary per COM §8; open beyond this list.
export type RelationshipType =
  | "supersedes" | "superseded_by" | "assigned_to" | "depends_on" | "blocks" | "derived_from" | "contains"
  | (string & {});

export interface Relationship {
  target_entity_id: string;
  target_entity_type: EntityType;
  relationship_type: RelationshipType;
  direction: RelationshipDirection;
}

// Base type — every entity type extends this. Never instantiated directly (matches
// COM §12: inheritance is closed at the top, single-level from this abstract base).
export interface CanonicalEntity {
  entity_id: string;
  entity_type: EntityType;
  entity_subtype?: string;
  name: string;
  description?: string;

  lifecycle_state: LifecycleState;
  lifecycle_substate?: string;
  lifecycle_history: LifecycleEvent[];

  created_at: string;
  created_by: string;
  modified_at: string;
  version: number;

  work_hierarchy_parent?: WorkHierarchyRef;
  organizational_containers?: OrganizationalContainerRef[];

  owner_id: string;
  owner_type: "agent" | "human";

  relationships?: Relationship[];

  access_policy?: string;
  audit_trail_ref?: string;
}
```

---

## 2. Entity-type schemas

**Ollama Suitable** (mechanical extension of §1's established pattern).

### 2.1 Agent

```typescript
export type AgentSubstate = "planning" | "reasoning" | "executing" | "monitoring";
export type AgentRole = "agent" | "worker";
export type AgentGoverningLayer = "organizational_departments" | "runtime_coordination_kernel";

export interface Agent extends CanonicalEntity {
  entity_type: "agent";
  current_role: AgentRole;
  governing_layer: AgentGoverningLayer;
  assigned_tasks?: string[]; // Task entity_ids
  capabilities?: string[];   // open vocabulary, see COM §6 item 3
}
```

```json
{
  "$id": "https://aios.dev/schemas/agent.json",
  "type": "object",
  "required": ["current_role", "governing_layer"],
  "properties": {
    "current_role": { "type": "string", "enum": ["agent", "worker"] },
    "governing_layer": { "type": "string", "enum": ["organizational_departments", "runtime_coordination_kernel"] },
    "assigned_tasks": { "type": "array", "items": { "type": "string", "format": "uuid" } },
    "capabilities": { "type": "array", "items": { "type": "string" } }
  }
}
```

### 2.2 Task

```typescript
export type ActionStatus = "pending" | "executing" | "completed" | "failed";

export interface Action {
  action_id: string;       // unique within parent Task only, not a CanonicalEntity (COM §2a)
  status: ActionStatus;
  executed_by: string;     // Agent entity_id
}

export interface Task extends CanonicalEntity {
  entity_type: "task";
  work_hierarchy_parent: WorkHierarchyRef & { level: "objective" }; // required, always objective-level
  actions?: Action[];
  assigned_agent?: string;
  assigned_workflow?: string;
}
```

### 2.3 Workflow

```typescript
export interface Workflow extends CanonicalEntity {
  entity_type: "workflow";
  steps: string[]; // ordered Task entity_ids
  trigger?: string; // reference or schedule expression; Event Model open (COM §6 item 2)
  governing_loop: "system_execution_loop";
}
```

### 2.4 Plugin

```typescript
export type PluginInstallStatus = "available" | "installed" | "enabled" | "disabled" | "removed";

export interface Plugin extends CanonicalEntity {
  entity_type: "plugin";
  governing_layer: "tool_abstraction_layer";
  wraps_adapter?: string; // lowest-confidence field in the whole model, see COM §4.4
  install_status: PluginInstallStatus;
}
```

### 2.5 Canonical Object (+ Memory Object, Artifact)

```typescript
export type CanonicalObjectSubtype = "memory_object" | "artifact" | (string & {}); // open list

export interface CanonicalObject extends CanonicalEntity {
  entity_type: "canonical_object";
  entity_subtype: CanonicalObjectSubtype;
}

export type MemoryType =
  | "semantic" | "episodic" | "procedural" | "decision" | "project" | "founder" | "research" | "operational" | "reference";

export interface MemoryObject extends CanonicalObject {
  entity_subtype: "memory_object";
  memory_type: MemoryType;
  confidence?: number | string;
  importance?: string;
  evidence?: string[];
  source_references?: string[];
  // Immutability rule (COM §5.1): once lifecycle_state === "completed", no further
  // "active" mutation is valid on this entity_id. Enforce at the validation layer
  // (Tier 3), not just in this type — TypeScript's type system cannot express
  // "readonly after a runtime condition" natively.
}

export type ArtifactKind =
  | "documentation" | "source_code" | "architecture_diagram" | "research_report" | "adr" | "benchmark" | "test_report";

export interface Artifact extends CanonicalObject {
  entity_subtype: "artifact";
  artifact_kind: ArtifactKind;
}
```

---

## 3. Validation constraints (beyond structural typing)

**Claude Recommended** (these encode architectural invariants from certified ADRs — getting them wrong reintroduces defects the reconciliation project spent nine sessions removing).

1. **`lifecycle_substate` must map to its declared `lifecycle_state`.** Structural JSON Schema can't express this cross-field constraint; implement as a runtime validator keyed off the tables in COM §4.1 and §4.5 (e.g., reject `lifecycle_state: "created"` with `lifecycle_substate: "planning"` — `planning` is only valid under `active`).
2. **`Agent.owner_id` must resolve to a human**, never another Agent (COM §7). Runtime validator, not expressible in JSON Schema alone without a lookup.
3. **`Task.work_hierarchy_parent.level` must always be `"objective"`.** Encoded structurally above via TypeScript's literal type; JSON Schema equivalent should use a `const` on the nested `level` field in `task.json`, not just the shared enum.
4. **Memory Object immutability** (§2.5 comment) — validate at write time: if `entity_subtype === "memory_object"` and prior stored `lifecycle_state === "completed"`, reject any incoming write that isn't a new `entity_id` with a `supersedes` relationship back to the prior version.
5. **`entity_id` uniqueness and non-reuse** (COM §9) — enforced at the persistence layer (Tier 3), not the schema layer; JSON Schema validates shape, not global uniqueness.
6. **`relationships[].direction` consistency** — if entity A stores an `outbound` relationship to B, no separate `inbound` copy should exist on B's own record (COM §8's "stored once" rule); this is a data-integrity check for the persistence layer, not a per-document schema check.

---

## 4. Versioning rules

- **Schema versioning:** every `.json` schema file above carries a `$id` with no version suffix during Tier 2's initial release (v1 is implicit). Once implementation begins and the first breaking schema change is needed, switch to `$id` suffixes (`-v2.json`) and require `CanonicalEntity` gain a `schema_version` field — deliberately not added now, since adding it pre-emptively for a v1 schema that has never been implemented against is exactly the kind of speculative future-proofing flagged as a risk in this session's opening pushback.
- **Entity versioning** (`CanonicalEntity.version`, COM §3.3) is a data-instance concept (this specific Task went through 4 revisions) and is unrelated to schema versioning (the Task *type* changed shape) — keep these two concepts named distinctly in implementation to avoid the confusion their similar names invite.
