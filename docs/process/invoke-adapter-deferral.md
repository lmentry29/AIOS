# Decision note — `invoke()` / Adapter execution model is deferred, not deleted

**Status: Decided (2026-07-14). Founder decision, docs/process tier — no ADR.**
Closes `divergence-log.md` unresolved architectural conflict #3 by **deferring** it.

This note exists because the reasoning behind *not* implementing `invoke()` is more
valuable than the method would have been, and because a gap that is left open without a
written reason reads, six months later, as an oversight rather than a decision.

## The gap

`docs/engineering/runtime-interfaces.md` §2.6 specifies:

```typescript
invoke(pluginId: string, operation: string, args: unknown): Promise<unknown>;
```

Nothing in the certified corpus can make this method do anything. `invoke()` must resolve
a plugin id to executable code, and:

- `Plugin.wraps_adapter` (COM §4.4, `packages/core/src/schema/plugin.ts`) is an optional
  UUID pointing at an **Adapter** concept that has **no schema, no store, and no registry
  anywhere in the model**. The reference is well-typed and dangling — the same defect class
  ADR-0010 closed for Objective and ADR-0011 closed for Project. This is the third instance.
- COM §4.4 flags Plugin as the lowest-confidence entity in the whole model: "no field-level
  Plugin specification exists anywhere in the certified corpus." Part XIII (*Tooling
  Ecosystem*) never uses the word "Plugin" at all.
- The corpus specifies an Adapter's *responsibilities* (Part XIII Ch.6 — authentication,
  request translation, response normalization, capability discovery, error translation,
  version compatibility) and four things every adapter *records* (Ch.18). It never
  specifies an Adapter's fields, identity, or store, and it defines no mechanism by which
  executable code enters the process.

Implementing `invoke()` therefore requires **inventing** a Plugin/Adapter execution model.
That is an architectural decision, not an implementation detail.

## The decision

**`invoke()` stays unimplemented until the first real adapter integration exists to
validate it against.** `@aios/tools` ships `install` / `enable` / `disable` — the part of
§2.6 that is fully specified and invents nothing — and the gap is left visible in the code.

Founder confirmation (2026-07-14): **no adapter integration is planned this cycle.** There
is consequently no implementation to validate a speculative contract against, and building
one anyway is precisely what `AGENTS.md` rule 7 exists to prevent: *"Plugin-related code
should be written expecting change… Don't build multiple Plugins against the current
contract before it's validated against one real implementation."*

Three facts made deferral the cheap option rather than the timid one:

1. **There is no consumer.** `@aios/tools` is a leaf. No workspace package depends on it,
   `runtime-interfaces.md` §4's dependency graph has a `core --> tools` edge and **no
   outgoing edge from `tools` at all**, and nothing anywhere calls `invoke()`. It would
   have shipped as dead code satisfying a `Status: Proposed` document.
2. **The method's shape is itself in question.** §2.6's `invoke(pluginId, operation, args)`
   is pluginId-centric; ratified Part XIII Ch.3/7/9 specifies a capability-mediated
   selection model ("Departments request capabilities from the registry rather than
   selecting tools directly"). Committing to an execution model underneath a signature that
   may not survive would be building the foundation after the house. **This deferral does
   not settle that question and must not be read as settling it — it is tracked separately
   as `divergence-log.md` unresolved architectural conflict #4, and its resolution is gated
   on the `@aios/orchestration` / `@aios/founder` evidence-gathering pass.**
3. **Reversal cost is symmetric and near-zero today.** Nothing depends on the outcome, so
   waiting costs nothing and deciding early buys nothing.

## The reopening trigger

**The first real adapter integration.** When an actual tool integration is scheduled — a
model provider, a repository host, anything that must execute against an external system —
this decision reopens automatically, and that adapter is the implementation that validates
whatever contract gets written. Not before.

At that point, the proposal in `packages/tools/DRAFT-invoke-adapter-resolution.md`
(deliberately **uncommitted**, so that a proposal cannot become the decision merely by
sitting in `src/`) is the starting point, not the answer. It proposes caller-registered
handlers via `registerHandler(pluginId, handler)`, leaving `wraps_adapter` inert. Its own
stated smell stands: that makes `wraps_adapter` a field the model defines and the runtime
ignores.

## What this note does NOT decide

Recorded explicitly, so a future reader does not mistake silence for settlement:

- **It does not specify the Adapter.** No schema, no store, no registry. `wraps_adapter`
  stays optional and unresolved.
- **It does not establish an invocation precondition.** The draft gates invocation on
  `install_status === 'enabled'` and never on `lifecycle_state` (COM §4.4 makes the two
  axes orthogonal — a disabled plugin whose `lifecycle_state` is `'active'` must still
  refuse invocation). That reasoning is sound and should survive into any future
  implementation *along with its test*, but the corpus states no invocation precondition
  and this note ratifies none.
- **It does not scope the Capability Registry.** Part XIII Ch.5/7/9's capability model, and
  COM §6 item 3's open Capability Model placeholder, remain unscoped. Per founder
  direction, their status is to be resolved as part of the future
  `@aios/orchestration` / `@aios/founder` evidence-gathering pass, not before.
- **It does not delete `invoke()` from §2.6.** The method remains in the contract, marked
  deferred. Deleting it would discard a real requirement; implementing it would invent an
  architecture. Marking it is the honest third option.
