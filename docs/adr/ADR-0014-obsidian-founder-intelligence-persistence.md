# ADR-0014 — Obsidian as Founder Intelligence Persistence Substrate

## Status

**Accepted** — founder decision, 2026-08-17 (Option C hybrid).

## Context

ADR-0006 establishes Founder Intelligence as one cross-cutting capability with three views: Founder Profile, Founder Memory, and Founder Context. The runtime needs a durable source for founder-authored knowledge, prior decisions, preferences, and evidence without creating a second competing knowledge store.

A separate database would duplicate the Obsidian vault's role as the founder's human-readable knowledge system and create an additional synchronization and reconciliation problem. Conversely, treating arbitrary Markdown notes as canonical AIOS objects would bypass the Canonical Object Model and could silently reinterpret user-authored material.

## Decision

Adopt the **Option C hybrid**:

1. **The Obsidian vault is the persistence substrate and human-readable source of truth for Founder Intelligence.**
2. **The AIOS object model remains the validation and invariant-enforcement authority.** Any record read from the vault and treated as a managed AIOS object must be parsed and validated against the relevant canonical schema before use.
3. **Do not introduce a separate database for Founder Intelligence.** A database must not be added as a parallel persistence layer for Founder Profile, Founder Memory, Founder Context, or their evidence without a superseding founder decision.
4. **Git remains the source of truth for AIOS implementation and architecture.** The Obsidian vault is the source of truth for founder knowledge and human-authored memory. These roles are complementary, not interchangeable.
5. **AIOS is read-and-propose by default.** Reading evidence and proposing classifications or changes does not authorize mutation of the vault.
6. **Permanent Memory changes require explicit human review and authorization.** No agent may silently promote an observation, inferred preference, candidate fact, or generated summary into permanent Founder Memory.
7. **Existing notes are not automatically migrated or reclassified.** Only notes explicitly marked as AIOS-managed and valid under the relevant schema may be hydrated as canonical objects. Ambiguous, malformed, contradictory, or unmarked notes remain source evidence and must not be rewritten.

## Read-only reconciliation gate

A read-only reconciliation was completed before any migration. It found no existing notes explicitly managed as Founder canonical objects, and no records were hydrated or migrated. Candidate classifications remain proposals pending human review.

That result does **not** authorize bulk migration, automatic frontmatter insertion, note renaming, metadata normalization, or permanent-memory writes. The reconciliation report is evidence for review, not a migration instruction.

## Implementation contract

- Implement a read-only vault evidence adapter first. It must preserve source path, title, frontmatter, content, modification metadata, and a content hash/provenance reference.
- Treat unmarked Markdown as raw evidence, not as a KnowledgeRecord, ArtifactEntity, or other canonical object.
- Hydrate only explicit AIOS-managed records after schema validation; reject invalid records without rewriting their source files.
- Default to deny when a resource policy is absent or invalid. The trusted host must provide the authenticated human identity and resource policy mapping.
- The adapter must not call vault mutation endpoints. No write, append, completion, frontmatter update, rename, or deletion operation is part of the read-only adapter.
- Proposed classifications and proposed memory updates must be presented as reviewable diffs. A separate human-approved command is required before any persistent write is attempted.
- Keep the Obsidian application/API local-only and authenticated. AIOS must not send credentials to a non-loopback host, and must not connect until the vault API's path containment, origin boundary, and authentication controls are verified.
- Keep runtime task/run execution state distinct from Founder Intelligence persistence. Its persistence contract remains an explicit engineering decision; this ADR does not authorize a separate database for Founder Intelligence.

## Consequences

- The founder and learning packages must expose read-only adapter ports that can be implemented over the vault without weakening canonical schema validation.
- The current in-memory stores remain test/development implementations until a vault-backed read adapter is implemented and validated.
- A future write adapter requires a separate threat review, explicit human authorization semantics, atomic file replacement, backup/recovery behavior, and a new verification suite.
- Any change to the source-of-truth boundary or introduction of a parallel Founder Intelligence database requires a superseding ADR.
