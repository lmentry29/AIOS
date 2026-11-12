# ADR-0036 — Mission, Infrastructure, and the Narrowed Container Contract

## Status

**Accepted** (2026-11-12). This ADR records the owner's completion decisions for CL-011,
CL-012 and CL-016 and accepts the previously Proposed ADR-0017 and ADR-0018.

## Context

Mission was a typed Work Hierarchy reference with no backing record, so an Objective could point
at an unresolvable Mission. Infrastructure records and a secret broker did not exist. The
Container Service contract named a `ContainerSpec` and eight non-Project container types with no
field-level source; ADR-0011 could close Project only.

The owner chose to complete the sourced work model and to narrow the container contract rather
than invent eight unsourced models.

## Decision

### 1. Mission is a Canonical Object subtype

Mission is accepted exactly as ADR-0017 proposes:

- `entity_subtype: 'mission'`;
- `name` and `purpose` (prose);
- `owner_id` / `owner_type`;
- the base Canonical Entity `lifecycle_state` and append-only `lifecycle_history`;
- no `work_hierarchy_parent` — Mission is the root;
- no sixth entity type and no Organizational Container merge.

Objectives may point at a Mission with `work_hierarchy_parent.level: 'mission'`. Existing
Mission references remain readable during the additive transition; a missing record returns
"not found" and is never fabricated.

The schema and in-memory Mission store are implemented in `@aios/core` and
`@aios/work-hierarchy`. Host routes and durable Mission journaling are follow-on work and must
authorize create/read by exact resource policy before they are exposed.

### 2. Infrastructure is canonical records plus a host-owned broker

Infrastructure descriptions are Canonical Object subtypes or supporting records. Credentials
are never fields on a canonical record: a record carries only a non-secret broker reference.
The host owns discovery, health, and credential resolution. Agents may request a capability but
may not enumerate hosts, choose a provider, or mutate infrastructure state.

The broker is host-owned and backed by the operator's HSM/KMS or OS keychain. Create, update,
delete, and credential resolution require exact-match policy and append-only audit; destructive
operations require a separate human approval. Vendor payloads stay behind bounded, non-secret
adapter metadata.

### 3. The public Container contract is Project-only

The supported Container service is the Project Canonical Object subtype. The following are
explicitly out of scope until a future ADR supplies a field-level source for each:

`program`, `release`, `milestone`, `epic`, `feature`, `roadmap`, `vision`, `workspace`.

`ContainerSpec` is not a public contract. `@aios/containers` exposes only the Project store.
A bare container reference may still carry one of those eight `container_type` values only as an
unresolved reference; callers must not assume it dereferences. This is the narrowed reading of
ADR-0011, not a claim that the Container Service is complete.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep Mission as a bare UUID | Leaves the top of the Work Hierarchy unresolvable. |
| Add Mission as a sixth entity | Conflicts with ADR-0007's ratified taxonomy. |
| Store credentials on infrastructure records | Leaks through logs, evidence, prompts, and generated schemas. |
| Invent ContainerSpec and eight models | Unilateral unsourced architecture; the exact failure ADR-0011 avoided. |
| Keep the Container Service half-implemented | Leaves a public contract that cannot be built or verified. |

## Consequences

- Mission has real schema and store tests; host integration remains explicit unfinished work.
- Infrastructure and the secret broker require a new store, broker adapter, policy routes, and
  tests; no credential is accepted in a canonical record.
- `@aios/containers` remains Project-only and must not expose unsupported container types as
  resolvable records.
- Project remains an Organizational Container; no Mission or Project hierarchy merge occurs.

## Tests required

- Mission round-trip, lifecycle, root-parent rejection, and Objective-to-Mission resolution.
- Default-deny Mission create/read through the host once routes exist.
- A secret-shaped field is rejected by the infrastructure schema, not merely ignored.
- A provider credential never appears in evidence, HTTP errors, or journal records.
- Project container operations remain authorized and durable; non-Project requests fail with a
  typed unsupported-type error rather than inventing a spec.
