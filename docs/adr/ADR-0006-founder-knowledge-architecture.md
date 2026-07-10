# ADR-0006 — Founder Knowledge Architecture

## Status
**Accepted** (2026-07-09) — amended 2026-07-09 per founder decision on Founder Intelligence's architectural placement.

## Context
The corpus independently defines founder-related concepts in at least four places (Parts IV, V, VIII, XIV of *AIOS Specification Project.md*): "Founder Context," "Founder Profile," "Founder Preferences," and "Founder Intelligence Layer," with overlapping but non-identical descriptions (Roadmap item 8). Part V, Ch.1–3 in particular describes Founder Intelligence as "a living body of knowledge... the organization's understanding of how the founder thinks," and states the Founder Profile "should become the most important document inside AIOS" — but does not state how Founder Profile, Founder Context, and Founder Preferences relate to Founder Intelligence as a whole.

## Decision
These are **not independent, overlapping systems**. They are three views of one system, **Founder Intelligence**:

```
Founder Intelligence
├── Founder Profile   (static identity: role, philosophy, decision framework, long-term objectives)
├── Founder Memory    (persistent knowledge: accumulated preferences, prior decisions, institutional history)
└── Founder Context   (dynamic runtime state: current session state, active priorities, in-flight directives)
```

"Founder Preferences" (Part XIV) is a component of Founder Memory, not a fourth independent system. "Founder Intelligence Layer" (Part V Ch.9) names the same concept as "Founder Intelligence" above; the two terms are unified under **Founder Intelligence** — but the word "Layer" in that legacy name is dropped, not kept, per the founder resolution below.

**Founder resolution (2026-07-09, amended):** Founder Intelligence is **not a first-class architectural layer** and MUST NOT appear as an entry in the 10-layer stack (ADR-0001). It is a **cross-cutting capability** spanning four of the ten layers:

- **Human Layer** — the founder as source of intent and direction.
- **Executive Governance** — where founder-derived priorities are enacted as organizational decisions.
- **Memory Engine** — where Founder Profile and Founder Memory are persisted as data, alongside general organizational memory.
- **Learning System** — where founder-relevant patterns are learned and refined over time.

"Knowledge Architecture" is **not a canonical layer name** — it is an informal umbrella term for Memory Engine + Learning System together and MUST NOT be introduced as an eleventh layer or as a synonym that replaces either name in the ADR-0001 stack. Founder Intelligence represents strategic reasoning, founder intent, long-term vision, prioritization, and institutional knowledge. It influences these four layers; it does not run as an independent runtime layer alongside them, and no runtime component should be modeled as "the Founder Intelligence layer" or "the Knowledge Architecture layer" going forward.

## Rationale
- Part V's own description of Founder Intelligence as an umbrella "living body of knowledge" already implies the sub-concepts (Profile, Memory, Context) are facets of it rather than siblings; this decision makes that implicit structure explicit rather than inventing a new one.
- Static identity (Profile), persistent accumulated knowledge (Memory), and dynamic runtime state (Context) are genuinely different technical concerns — different persistence guarantees, different mutation frequency, different consumers — and collapsing them into one undifferentiated concept would lose information the corpus already distinguishes elsewhere (e.g., Part IV's "Founder Context" describes runtime state explicitly, not static identity).
- This satisfies No Duplicate Definitions: one root concept, three explicitly scoped sub-parts, each referenced rather than redefined wherever they appear.

## Consequences
- Parts IV, V, VIII, and XIV MUST be edited so that each founder-related section states which of the three views (Profile / Memory / Context) it is describing, and cross-references Founder Intelligence as the parent concept rather than redefining it locally.
- "Founder Preferences" (Part XIV) MUST be re-labeled as a Founder Memory component in all references.
- Any Reference/API documentation exposing founder-related data (e.g., a founder-profile endpoint, a founder-context runtime object) MUST map to exactly one of the three sub-parts, not to an undifferentiated "founder data" blob.
- Resolved: Founder Intelligence is a cross-cutting capability, not a layer, spanning Human Layer, Executive Governance, Memory Engine, and Learning System (founder decision, 2026-07-09, amended same day).
- Resolved: "Knowledge Architecture" is confirmed as an informal umbrella term for Memory Engine + Learning System, not a distinct layer. It MAY be used informally in prose but MUST NOT appear in the canonical layer list (ADR-0001) or be treated as a synonym that replaces either layer's name in normative text.

## Superseded Decisions
- Part IV, Part VIII, and Part XIV's independent framings of Founder Context, Founder Profile-adjacent material, and Founder Preferences as standalone concepts are superseded to the extent they conflict with the three-view model above; Part V's core description is retained and elevated as the parent definition.
