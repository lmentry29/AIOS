# ADR-0018 — Infrastructure Records Are Canonical Objects, Not New Entity Types

## Status

**Proposed** (2026-11-10). No infrastructure inventory, provider credential, or deployment
record is implemented by this ADR.

## Context

A personal AI operating system needs to describe the machines, storage, network
endpoints, and provider accounts it can use. The repository currently has no such model.
The temptation is to add a new top-level `Infrastructure` entity and let agents mutate it
directly. That would bypass the canonical taxonomy and create a second, unaudited source
of truth for capabilities and credentials.

## Decision (proposed)

1. **Infrastructure descriptions are Canonical Object subtypes** (for example
   `infrastructure_host`, `infrastructure_endpoint`, `infrastructure_store`) or
   supporting records referenced by one. They are not a sixth top-level entity type.
2. **Credentials are never fields on a canonical record.** A record may contain a
   non-secret reference to a secret-broker entry and a health/status field. Passwords,
   tokens, private keys, and connection strings with embedded credentials are forbidden
   in entities, evidence, logs, prompts, and generated schemas.
3. **The host owns discovery and health.** Agents may request a capability; they may not
   enumerate arbitrary hosts, choose a provider, or mutate infrastructure state. A future
   capability registry resolves providers under ADR-0012.
4. **Infrastructure state is operational state**, not Founder Intelligence. It belongs in
   the same durable operational substrate as Tasks and Workflows (ADR-0015), subject to
   its retention and compaction limits. It must not be written to the Obsidian vault.
5. **No mutation without a policy and an audit record.** Create/update/delete operations
   require exact-match authorization, a trusted human or host principal, and append-only
   audit. Destructive operations require a separate human approval gate.
6. **Provider-specific fields stay behind adapters.** The canonical record carries stable
   identity, kind, display name, endpoint reference, health, and provenance; vendor
   payloads may be retained only as bounded, non-secret adapter metadata.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| New top-level entity type | Conflicts with ADR-0007 and would require a taxonomy amendment. |
| Store infrastructure in `.env` files | Convenient for one machine, but not inspectable, authorizable, or auditable. |
| Let the UI own a separate inventory | Creates a second source of truth and bypasses host policy. |
| Store secrets in canonical records | Directly violates the no-credentials rule and would leak through logs/evidence. |

## Consequences

- Infrastructure support remains unimplemented until the record shapes and secret-broker
  boundary are reviewed.
- A future implementation must add schema/conformance tests and a migration path; it must
  not silently reinterpret existing Project or Plugin records.
- Health checks and provider adapters require their own timeout, retry, and credential
  handling tests.

## Tests required before acceptance

- A secret-shaped field is rejected by the schema, not merely ignored.
- An agent cannot create/update an infrastructure record without an exact policy grant.
- A provider credential never appears in an evidence artifact, HTTP error, or journal
  record.
- Restart recovery preserves infrastructure records and audit ordering.
