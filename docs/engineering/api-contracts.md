# AIOS API Contracts (Tier 5) — Internal, Plugin, Runtime APIs, Event Contracts

**Status: Proposed — lower confidence than Tiers 1–4.** Per this session's opening pushback: these are wire-format decisions made before any implementation has exercised the underlying schemas or interfaces. Treat everything below as a reasonable starting default, not a fixed contract — expect it to change once `objects/`, `agents/`, and `orchestration/` (Tier 3) are actually built.

**AI task allocation:** REST/route shape (§1) — **Ollama Suitable**, mechanical given Tier 3's service contracts. Event/message contract design (§3) — **Claude Recommended**, since getting event ordering/delivery guarantees wrong is a correctness issue, not a style issue. Plugin API surface (§2) — **Human Review Required** before it's exposed externally, given COM §4.4 already flags Plugin as the lowest-confidence entity in the model; shipping a public API against an under-specified entity risks a breaking change the moment Plugin gets its real spec.

---

## 1. Internal / Runtime APIs

REST-style, one resource collection per Tier 3 component. Only representative routes shown — full CRUD is implied by Tier 3's service contracts and Tier 2's schemas, not restated per verb here to avoid an artifact whose value is mostly padding.

```
POST   /agents                        # AgentRuntime.instantiate
POST   /agents/{id}/activate          # AgentRuntime.activate
POST   /agents/{id}/step              # AgentRuntime.step
GET    /agents/{id}

POST   /objects                       # ObjectStore.create
PATCH  /objects/{id}                  # ObjectStore.mutate (rejected per immutability rule if MemoryObject+completed)
GET    /objects/{id}
GET    /objects?filter=...            # ObjectStore.query
POST   /objects/{id}/relate           # ObjectStore.relate

POST   /missions
POST   /objectives/{id}/assign        # body: { mission_id } — "assigned to", never "translated into" (ADR-0004 Amendment A)
POST   /tasks
POST   /tasks/{id}/actions

POST   /containers
POST   /containers/{id}/assign        # body: { entity_id, container_type }
POST   /containers/{id}/nest          # body: { child_container_id }

POST   /workflows
POST   /workflows/{id}/dispatch       # OrchestrationKernel.dispatch
GET    /workflows/{id}/status

POST   /plugins/install
POST   /plugins/{id}/enable
POST   /plugins/{id}/disable
POST   /plugins/{id}/invoke           # body: { operation, args } — see §2 caveat

POST   /learning/observations
POST   /learning/observations/{id}/promote

GET    /founder/queue                 # FounderInterface.reviewQueue
POST   /founder/decisions             # FounderInterface.recordDecision
```

**Auth note:** every route above implicitly requires `access_policy` resolution (COM §3.5), which has no ratified mechanism — routes are specified with the assumption that an auth middleware layer exists, but that middleware is explicitly out of scope here (COM §6 item 1) and remains a founder-level product decision when it becomes blocking, not before.

---

## 2. Plugin / Extension API

**Human Review Required before external exposure.**

```typescript
// The surface a Plugin implementation must satisfy to be installable.
interface PluginContract {
  manifest(): PluginManifest;                     // name, version, declared operations
  invoke(operation: string, args: unknown): Promise<unknown>;
  onInstall?(): Promise<void>;
  onEnable?(): Promise<void>;
  onDisable?(): Promise<void>;
}

interface PluginManifest {
  name: string;
  version: string;
  operations: string[];
  wraps_adapter?: string; // optional, per COM §4.4's provisional Adapter-wrapping model
}
```

This is the thinnest artifact in the whole package, by design — inventing a rich Plugin API against zero source specification (COM §4.4 already flags Plugin as having no field-level detail anywhere in the certified corpus) would be exactly the "confident-looking documentation that implementation falsifies" risk raised at the start of this session. Recommend treating this contract as a placeholder to validate against the first real Plugin implementation, not as a spec to build multiple Plugins against blind.

---

## 3. Event contracts

**Claude Recommended.**

Minimal event set, derived from the three execution loops (ADR-0002) and lifecycle transitions (ADR-0003) — every event below corresponds to an actual state transition already defined in Tier 1/4, not a new concept.

```typescript
interface AIOSEvent<T = unknown> {
  event_id: string;
  event_type: string;       // see enum below
  entity_id: string;
  entity_type: EntityType;
  occurred_at: string;      // ISO 8601
  actor: string;
  payload: T;
}

type AIOSEventType =
  | "entity.created" | "entity.validated" | "entity.activated"
  | "entity.suspended" | "entity.completed" | "entity.archived"
  | "agent.substate_changed"        // planning/reasoning/executing/monitoring transitions
  | "task.action_completed" | "task.action_failed"
  | "workflow.step_dispatched" | "workflow.step_completed"
  | "object.mutated" | "object.synchronized"
  | "memory_object.superseded"      // immutability-driven new-version event
  | "plugin.install_status_changed"
  | "relationship.created";
```

**Delivery guarantee (flagged, not resolved):** whether this is at-least-once or exactly-once delivery, and whether events are ordered per-entity, is a genuine implementation decision this document is not making — it depends on the message broker chosen in Tier 7, which hasn't happened yet. Noted here rather than silently assumed, consistent with this document's stated lower-confidence status.

---

## 4. Message format

JSON, matching Tier 1 §10's serialization decision — no separate format introduced for events. `AIOSEvent.payload` is typed per `event_type` using the corresponding Tier 2 interface (e.g., `entity.created` on a Task carries a `Task` payload).
