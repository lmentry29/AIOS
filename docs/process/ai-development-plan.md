# AI Development Plan — Per-Package Allocation

Applies `AI-Development-Workflow.md`'s general risk-based policy (Claude for high-blast-radius, Ollama for lower-risk) concretely to the nine packages in `AIOS-Implementation-Roadmap.md`. Grounded in your actual machine (`obsidian-plus-plus-setup-log.md`): MacBook Air M5, 16GB unified memory, fanless — 7B–13B models at Q4 quantization comfortably fit, 30B+ is not viable locally. Providers currently connected: OpenCode Free (via 9router), Gemini/AI Studio, Claude Fable 5 (via Claude Code directly, not 9router). Optimizing for local-first per your standing instruction, without letting that push high-risk work onto a model that can't be trusted with it.

---

## 1. Per-package allocation

| Package | Allocation | Reasoning complexity | Notes |
|---|---|---|---|
| `core` | **Claude Recommended** | High | `CanonicalEntity` base schema and its validation rules are the foundation every other package inherits (`AIOS-Runtime-Interfaces.md` §4 dependency graph — everything depends on `core`, nothing depends back on it). A subtle error here (e.g., the `lifecycle_substate`-to-`lifecycle_state` mapping validator from `AIOS-Object-Schemas.md` §3) propagates into all nine packages before anyone notices. This is exactly the "high-blast-radius" category `AI-Development-Workflow.md` reserves for Claude. |
| `objects` | **Claude Recommended** | High | Object Store implements the immutability rule for Memory Objects (`AIOS-Canonical-Object-Model.md` §5.1) and the append-only `lifecycle_history`/`relationships` constraints (§11–§12) — data-integrity logic where a bug means silent corruption, not a visible crash. Silent-failure-mode work is the other category `AI-Development-Workflow.md` flags as Claude-appropriate regardless of raw complexity. |
| `work-hierarchy` | **Either**, lean Claude for the boundary decision | Medium | The Task/Canonical Object storage boundary (`AIOS-Runtime-Interfaces.md` §5) is still an open question this package will resolve in practice — the first implementation pass through this ambiguity should be Claude, so the resolution gets recorded with reasoning; once resolved, routine CRUD work on Mission/Objective/Task is Ollama-suitable. |
| `containers` | **Ollama Suitable** | Low | Straightforward CRUD + nesting over an already-fixed schema (`AIOS-Runtime-Interfaces.md` §2.5); no architectural ambiguity remains once `core`/`objects` exist. Good first local-model task — bounded, testable against `AIOS-Object-Schemas.md` directly. |
| `agents` | **Claude Recommended** | High | Implements the Agent Execution Loop's substate machine (`AIOS-State-Machines.md` §2) plus the Agent/Worker role-flag logic (`AIOS-Canonical-Object-Model.md` §4.1) — an autonomous execution entity acting on behalf of the organization is squarely inside the "high-blast-radius" category by definition, independent of raw code complexity. |
| `tools` (Plugin) | **Ollama Suitable for scaffolding, Human Review Required before any real Plugin ships** | Low–Medium | The schema itself is explicitly the lowest-confidence artifact in the whole package (`AIOS-Canonical-Object-Model.md` §4.4). Low risk to prototype locally since almost nothing else depends on it yet (`AIOS-Runtime-Interfaces.md` §4 dependency graph — `tools` is a leaf), but don't let a local model's plausible-looking Plugin API get treated as settled without a human pass, per `AIOS-API-Contracts.md` §2's own caveat. |
| `learning` | **Ollama Suitable** | Low–Medium | Domain-specific lifecycle already verified non-conflicting with the base model (`RECONCILIATION-CHANGELOG.md` Session 8) — implementing Observation→Candidate→Validated→Published→Institutional Standard→Historical Archive is a bounded state machine against a schema that's already settled. |
| `orchestration` | **Claude Recommended** | High | System Execution Loop dispatch/coordination logic touches every other package at once (`AIOS-Runtime-Interfaces.md` §2.1) — a coordination bug here can misroute work across the whole system, the definition of high blast radius. |
| `founder` | **Human Review Required for design, Claude Recommended for implementation** | Medium–High | Composes `objects` + `learning` per ADR-0006's cross-cutting model (`AIOS-Runtime-Interfaces.md` §1's note on Founder Interface) — this is the surface where you interact with AIOS directly, so implementation should be Claude-built but design choices (what `FounderInterface.query()` actually returns, how `reviewQueue()` prioritizes) warrant your review before they're load-bearing, since they encode judgment calls about what you see and when. |

---

## 2. Cross-cutting work (not package-specific)

| Task | Allocation | Notes |
|---|---|---|
| JSON Schema / TypeScript generation from `AIOS-Object-Schemas.md` into actual `schemas/` files | **Ollama Suitable** | Mechanical translation, already flagged this way in the schema document itself. |
| Mermaid diagrams → any visual tooling/doc site | **Ollama Suitable** | Pure rendering, no logic. |
| Test suite scaffolding (`tests/unit`, `tests/integration`) | **Either** | Once package interfaces are fixed, writing tests against them is bounded work; integration tests touching the open Task/Object storage question (§1, `work-hierarchy` row) should follow whichever model resolved that boundary. |
| Conformance test suite (`tests/conformance`, validating against *AIOS Conformance Standard (reconciled).md*) | **Claude Recommended** | Requires correctly interpreting RFC 2119 MUST/SHALL language against the reconciled corpus — a misread here would silently certify non-conformant behavior as conformant. |
| Access/authorization model design (when it becomes blocking, per `AIOS-Implementation-Roadmap.md` §5) | **Human Review Required**, Claude Recommended for drafting | No ratified governance mechanism exists (ADR-0003 deprecated the only one). This is close to a founder-level product decision the moment it's needed — draft with Claude, decide with you. |

---

## 3. Local model recommendations (Ollama)

Grounded in the actual constraint from `obsidian-plus-plus-setup-log.md`: 16GB unified memory, 7B–13B at Q4 comfortable, 30B+ not viable, Metal GPU (not NVIDIA) via Ollama.

- **Primary recommendation: `qwen2.5-coder:7b` (Q4)** — strong code-generation performance at a size that fits comfortably alongside OS/browser/editor on this machine; good fit for `containers`, `learning`, and `tools` scaffolding (§1).
- **If more headroom is available for a given session: `qwen2.5-coder:14b` (Q4)** — still within the stated "7B–13B... comfortably fit" ceiling's upper edge; worth testing thermal/memory behavior on the fanless M5 before relying on it for long sessions (the setup log notes fanless → throttling risk under sustained inference, not damage — expect slower, not broken).
- **For general (non-code) reasoning tasks within Ollama-suitable work** (e.g., drafting a Plugin manifest description in plain language before the schema is filled in): `llama3.1:8b` — well-rounded, smaller footprint, faster turnaround for short tasks.
- **Not recommended locally:** anything in the 30B+ class (setup log explicitly rules this out for this hardware) — if a task seems to need that scale of model, that's itself a signal it may belong in the Claude-Recommended column instead of pushing local hardware past its stated ceiling.
- **Pause/resume discipline**, per the setup log: `ollama stop <model>` between sessions to free memory instantly; no corruption risk, so there's no cost to being aggressive about unloading when switching between local and Claude-based work in the same day.

## 4. Why Claude for the flagged rows, stated plainly

Every "Claude Recommended" row in §1 shares one property: the cost of a subtle, plausible-looking error is disproportionate to how "hard" the code looks. `core` and `objects` sit at the base of the dependency graph, so an error there is invisible locally and expensive globally. `agents` and `orchestration` are autonomous-execution and system-coordination code, where a bug's effect is behavioral (the system does the wrong thing while looking like it's working) rather than a compiler error. Local 7B–13B models are capable of writing plausible code against a fixed schema — they are not the bottleneck for straightforward implementation. The bottleneck is catching the error that looks fine, and that's a reasoning-depth problem, not a code-generation problem, which is why raw "complexity" alone (§1's column) sometimes understates the case for Claude on packages that aren't algorithmically hard but are consequential if wrong.
