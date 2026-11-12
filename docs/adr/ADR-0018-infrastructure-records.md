# ADR-0018 — Infrastructure Records Are Canonical Objects, Not New Entity Types

## Status

**Accepted** (2026-11-12). The owner approved canonical infrastructure records with a
host-owned secret broker. The host implementation is recorded in the amendment below;
production HSM/KMS custody remains CL-007.

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

## Implementation amendment (2026-11-12)

CL-012 now has a working host implementation:

- `InfrastructureEntity` is a Canonical Object subtype with `infrastructure_host`,
  `infrastructure_endpoint`, and `infrastructure_store` values. Its fields are the base
  identity fields, a bounded endpoint, health, a bounded adapter label, and an optional
  opaque `secret_ref` (`entry_id` plus broker kind). The object is strict: unknown fields are
  rejected, not stripped, and text fields reject secret-shaped assignments, private-key
  blocks, provider-token shapes, and credential-bearing endpoint URLs.
- `EncryptedFileSecretBroker` is the host-owned local adapter. It encrypts fixed-size
  plaintext blocks with AES-256-GCM under an owner-only 32-byte key file and writes ciphertext
  to a separate owner-only store. The key is never in configuration, the record, the journal,
  a response, or the repository. This is a local custody adapter, not the HSM/KMS custody
  required by CL-007.
- Routes: `POST /v1/infrastructure` (exact `intake`, human-only), `GET /v1/infrastructure`
  (grant-filtered `read_status`), `GET /v1/infrastructure/:id` (`read_status`), `GET
  /v1/infrastructure/:id/policy` (`read_status`, returns only policy id/version), and `POST
  /v1/infrastructure/:id/rotate` (exact `execute`, human-only). Every decision goes through
  `SharedAuthorizationBoundary`, so allow/deny records are durable in the authorization audit.
- Infrastructure records and each mutation are persisted through the operational journal's
  `infrastructure` entity collection and restored by the same validated replay/restart path.
  Compaction carries the collection in its snapshot; pre-existing snapshots remain readable.
- When no broker is configured, credential creation and rotation fail closed with HTTP 503.
  The caller cannot supply a broker reference; the host creates it only after authorization.

Tests: `apps/host/tests/infrastructure.test.ts` (schema strictness, human/agent denial,
policy read, create/read/rotate, restart, broker resolution, plaintext redaction in journal,
broker store, response and authorization audit, unavailable-broker and reserved-reference
denial).

## Tests required before acceptance

- A secret-shaped field is rejected by the schema, not merely ignored.
- An agent cannot create/update an infrastructure record without an exact policy grant.
- A provider credential never appears in an evidence artifact, HTTP error, or journal
  record.
- Restart recovery preserves infrastructure records and audit ordering.
