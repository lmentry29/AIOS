# ADR-0012 — Capability-Mediated Access Extends to AIOS's End-Users; invoke()'s pluginId-Centric Shape Is Superseded

## Status
**Proposed** (2026-07-14) — founder direction, not yet accepted. Nothing in this ADR is
committed until the founder explicitly approves the final text. Intended to resolve
`docs/process/divergence-log.md` unresolved architectural conflict #4 once accepted. Does
not resolve conflict #3 — see Consequences.

## Context

`docs/process/divergence-log.md` conflict #4 asked whether `runtime-interfaces.md` §2.6's
`invoke(pluginId: string, operation: string, args: unknown)` — pluginId-centric, caller
names the provider — genuinely contradicts Part XIII's capability-mediated tool model, or
is reconcilable as an internal layer beneath one. That evaluation was left open, gated on
building `@aios/orchestration`/`@aios/founder` far enough to observe a real caller's needs.

This ADR resolves it directly, by founder decision, before that evidence-gathering
completed — and extends the ratified principle to new ground it did not previously cover.

### Product direction introduced during this discussion — not previously ratified

The premise that AIOS is a **personal AI operating system**, with the Engineering
Organization (the domain most of this corpus and repository describe) being **one
application running on top of that OS**, was introduced by founder guidance during this
session. It does not appear anywhere in the certified corpus prior to this ADR, and is
not ratified by it either.

**ADR-0012 relies on that product direction as contextual motivation** for extending
Part XIII Ch.7's Department-scoped capability-mediation principle to end-users (Decision
§2). It does **not** ratify the OS/application platform model itself. That model —
what it means concretely for AIOS to be an OS with applications running on it — is a
separate, larger architectural question this ADR deliberately does not answer. See
Decision §3 and Consequences.

## Decision

### 1. What's already ratified

Part XIII Ch.7 (*Capability Registry*), `docs/architecture/specification.md:5809-5810`:

> "The organization maintains a Capability Registry... Departments request capabilities
> from the registry rather than selecting tools directly."

The chapter also ratifies a capability record shape: Capability Identifier, Description,
Required Inputs, Expected Outputs, Supported Tool Categories, Security Requirements,
Quality Guarantees, Version. This principle is real and normative — but textually scoped
to **Departments**, an internal organizational construct. Nothing in Part XIII addresses
individual end-users requesting capabilities from AIOS directly.

### 2. What's newly decided here, by founder authority

**The Department→Registry principle extends to AIOS's end-users, not just internal
Departments.** This is new ground — Part XIII does not say this, and citing it as though
it already settled the user-facing case would misstate what's ratified versus what's
being decided now.

**Normative statement:** Users state what they want; AIOS is responsible for
interpreting that statement, resolving it into the capability or capabilities it
implies, selecting the provider(s) that satisfy each one, and constructing the execution
plan that carries it out. Providers are implementation details owned by AIOS, never part
of the contract exposed to a requester — user or Department alike. See Rationale for how
each of AIOS's four responsibilities grounds in existing ratified machinery, and for the
terminology choice behind "users state what they want."

**Consequence for `invoke()`:** `invoke(pluginId, operation, args)` requires the caller
to already know and name the specific provider — exactly the responsibility this
contract assigns to AIOS, not the requester. The signature is therefore superseded in
shape, not merely "in question" as conflict #4 left it. The concrete replacement
contract is follow-on engineering work (Consequences 1), not decided here.

### 3. What this ADR explicitly does not define or decide

To prevent this ADR from being read as settling more than it does, the following are
named as **out of scope here**, not resolved, and not implied by Decision §2's extension
of capability-mediation to end-users:

- the OS/application layer boundary — what distinguishes "AIOS the platform" from
  "an application running on AIOS," concretely;
- multi-tenancy;
- per-user AIOS instances;
- deployment architecture;
- identity boundaries;
- how the existing Canonical Object Model maps between platform-level services and
  applications running on top of AIOS.

Each remains a separate architectural question requiring its own future ADR (see
Consequences).

### 4. Supporting evidence — corroborating context, not justification

This session, while scoping a real job-listing-search caller, two vendor paths were
checked and found closed: ZipRecruiter's publisher/search API was shut down for all
partners (April 2025); Indeed's Publisher API was deprecated (2023) with no self-serve
replacement, current access being partner-approval-gated and sales-led. Both verified via
live lookup this session (2026-07-14), not assumed.

**This is corroborating context, not the reason for this decision, and the distinction
matters for anyone reading this later.** It demonstrates real-world provider volatility —
concretely the class of problem a capability-mediation layer exists to absorb, since a
capability request ("job-listing-search") can survive a provider's shutdown in a way a
hardcoded `pluginId` cannot. But the decision in §2 was made independently, on the
abstraction-boundary principle, by founder authority. **Had both vendors had stable
self-serve APIs, this decision would be unchanged.** It is not evidence-derived and not a
reaction to vendor failure — do not read it as either.

## Rationale

- **Why extend beyond Departments:** AIOS as a personal AI operating system makes the
  end-user the common-case requester, not an internal department acting on an
  organization's behalf. The structural argument for capability-mediation (isolate the
  requester from vendor-specific selection, enable provider substitution without
  requester-side changes) applies without modification to that position.
- **Why founder authority now, rather than waiting for the evidence-gathering pass:** the
  pass was one legitimate path to resolving conflict #4, not the only one. AGENTS.md rule 1
  names the ADR as the mechanism for exactly this class of decision; a founder-level call
  made directly satisfies that rule without requiring the evidence pass to run to
  completion first. This ADR resolves both the shape question and the Capability
  Registry roadmap-status question (Consequences 2) that conflict #4 had gated on that
  pass; the previously-approved `@aios/orchestration`/`@aios/founder` build proceeds as
  ordinary implementation work, not as evidence-gathering for an open architectural
  question.
- **How Decision §2's four AIOS-side responsibilities ground in existing ratified
  machinery** — none of them is a new mechanism invented by this ADR: interpreting a
  user's statement corresponds to the role Part VII Ch.7's *Intent Extraction* pipeline
  already plays for the Planning Engine; resolving it into capabilities and selecting
  providers correspond to Part XIII Ch.7/Ch.9 (Capability Registry, Tool Selection);
  constructing an execution plan corresponds to Part VII Ch.5's *Planning Architecture*.
  Department-initiated requests already enter this same downstream machinery at the
  capability-shaped point, via Part XIII Ch.3's ratified `Department → Capability
  Request` path, without needing the interpretation step a raw user statement requires
  first.
- **Terminology choice — "users state what they want," not a defined term:** deliberately
  plain, unreserved language, not "intent," "goal," or "request" as capitalized terms.
  Each of those is already ratified with a distinct, narrower scope elsewhere in the
  corpus — "Human Intent" (Ch.29, whole-system input), "Literal Request"/"Immediate
  Goal"/"Underlying Need" (Part VII Ch.7's extraction pipeline), "Intent Analysis" (Part
  VII Ch.5, operates on an existing Objective), "Capability Request" (Part XIII Ch.3,
  Department-scoped), and the founder's constitutional "Principle of Intent" (Part XIV
  Ch.3) — and none of them names what an ordinary end-user of a personal AI OS does when
  they ask for something. This is an editorial choice to avoid collision, not an
  architectural one, and does not change Decision §2's substance.

## Consequences

1. **`runtime-interfaces.md` §2.6 must be amended** to replace or supplement
   `invoke(pluginId, operation, args)` with a capability-mediated contract (a
   `requestCapability`-shaped method resolved through a ratified Capability Registry
   entity). This ADR decides the principle and the supersession; it does **not** specify
   the new method signature or the Capability Registry's schema — that is follow-on
   engineering work, consistent with how ADR-0011 separated "accepted" from
   "implemented."

2. **The Capability Registry's roadmap status — previously unscoped, folded into
   conflict #4 by founder direction 2026-07-14 — is resolved: it is now in scope.**
   Timing and implementation sequencing remain undecided and are follow-on work, not this
   ADR.

3. **Conflict #3 (Plugin/Adapter execution model) is reassessed, and is NOT superseded —
   it remains open and deferred, exactly as `docs/process/invoke-adapter-deferral.md`
   left it on 2026-07-14.** This ADR decides *who selects a provider* (AIOS, via the
   Registry); it does not decide *how a resolved provider actually executes*
   (`Plugin.wraps_adapter` still has no schema, store, or registry). That question now
   sits one layer beneath this decision: after the Capability Registry resolves which
   Plugin/Adapter satisfies a request, something still has to invoke it, and that
   mechanism is still unspecified. Separately: the planned `MockJobSearchProvider`
   fixture does **not** trigger conflict #3's reopening condition ("the first real
   adapter integration") — it is explicitly a pipeline-mechanics fixture, not a real
   vendor integration, per the deferral note's own trigger language. Conflict #3 stays
   deferred, untouched by this ADR and untouched by the mock.

4. **`MockJobSearchProvider` is an implementation detail, not part of this architectural
   decision.** It validates capability-request → registry-selection →
   provider-invocation → response-normalization pipeline mechanics using a fixture
   provider. It must be labeled unmistakably (naming, comments, tests) as a fixture
   validating mechanics — not a claim about ZipRecruiter, Indeed, or any real vendor's
   viability.

5. **A future ADR is required to formally define the AIOS Platform Model** — the
   relationship between the AIOS runtime, applications (including the Engineering
   Organization), user instances, deployment boundaries, and the OS/application-layer
   split named in Decision §3. ADR-0012 intentionally leaves all of it unresolved; it
   establishes only the capability-mediation abstraction principle, not the platform
   architecture that principle will eventually need to sit inside.

## Founder decisions folded into this revision (2026-07-14)

- Users (not only Departments) request capabilities; AIOS selects and manages providers —
  new product-level principle, extending Part XIII Ch.7 beyond its ratified scope.
- The AIOS-as-personal-AI-operating-system product direction, with the Engineering
  Organization as one application on top of it, is founder guidance introduced this
  session — contextual motivation for this ADR, not itself ratified by it.
- Capability Registry roadmap status: resolved to in-scope (timing still follow-on).
- ZipRecruiter/Indeed inaccessibility: corroborating evidence only, explicitly not the
  justification for this decision.
- `MockJobSearchProvider`: fixture validating mechanics, not vendor-viability evidence.
- Terminology for the user-facing side ("users state what they want," not "intent,"
  "goal," or "request" as defined terms): editorial choice to avoid collision with four
  distinct existing ratified uses, does not change the decision's substance.

## Divergence-log updates required (follow-on, not yet applied)

- **Conflict #4:** mark resolved — capability-mediated model adopted by ADR-0012, founder
  decision, not evidence-derived from a real caller.
- **Conflict #3:** mark reassessed, still open/deferred — not superseded. Scope note
  added: now understood as sitting beneath the Capability Registry layer this ADR
  establishes.
