# ADR-0015 — Operational Persistence Substrate

## Status
**Proposed** (2026-11-10). This ADR does not amend ADR-0014. It concerns operational
Task/Workflow/Artifact/run state only, which ADR-0014 explicitly leaves as a separate
architectural question.

## Context

PR #1 lists operational persistence as a production blocker: Task, Workflow, run, and
evidence state live in in-memory adapters, so a restart loses all operational history.
Dispatch has no idempotency, leases, or crash recovery, and an interrupted run can leave a
Workflow `active` with no owner.

The host must persist and recover:

- canonical operational entities (Tasks, Workflows, Artifacts/evidence);
- dispatch runs, including the idempotency key that created them;
- lease ownership and expiry;
- enough history to distinguish "interrupted" from "completed".

Founder Intelligence is out of scope: ADR-0014 keeps the Obsidian vault as that substrate,
and this ADR must not create a competing Founder database.

The host is a **single-process, local-first** application (ADR-0013 relies on a trusted local
host; `FilePolicyRegistry` already enforces a single-process lock). Operational state volumes
are small: a founder's Tasks and Workflows, not a multi-tenant service.

## Decision

Use a **hash-chained, fsync'd append-only journal** per host, implemented in
`apps/host/src/persistence/`, as the substrate for operational state.

- One journal (`operational.jsonl`) holds entity mutations and run transitions.
- Each record is a JSON line carrying `sequence`, `kind`, `payload`, `previous_hash`, and a
  SHA-256 `hash` over canonical JSON. Open verifies the full chain.
- `append()` fsyncs before returning. A crash may leave an unterminated tail; only that torn
  tail is truncated on open. A complete record that fails validation fails closed.
- Records are replayed through validated `restore` paths, not re-executed, so versions,
  timestamps, and append-only lifecycle history cannot change on restart.
- The journal holds a single-process lock with stale-PID recovery, matching
  `FilePolicyRegistry`'s established pattern.
- Dispatch runs are journaled with caller-supplied idempotency keys and time-bounded leases.
  Startup recovery marks runs from a previous boot `interrupted` and the host suspends their
  Workflows and active Tasks rather than completing them.

### Substrates considered

| Option | Why not chosen now |
|---|---|
| `node:sqlite` | Attractive (transactions, indexes, concurrency) and available on Node 26, but the repository's declared `@types/node` range does not type it, so adopting it means either a dependency/type shim or untyped calls. Its concurrency benefits are unused by a single-process local host, and it would add a migration story before the port boundaries have stabilized. |
| External database | Contradicts local-first deployment and adds a service dependency for a single-founder workload. |
| In-memory only | The blocker this ADR resolves. |

The journal is deliberately behind the existing `TaskRepositoryPort` /
`EntityRepositoryPort` interfaces, so a SQLite adapter can replace it later without changing
orchestration, the host API, or tests' semantics.

## Consequences

- Operational state survives restart, with tamper-evident history.
- Unbounded growth is possible: the journal fails closed at a 64 MiB default rather than
  silently rotating. **Compaction/snapshotting is not implemented** and is tracked as
  follow-up work in the handoff. Until then, long-lived deployments must archive the journal
  deliberately.
- Multi-process concurrency is unsupported by construction. Scaling the host out requires a
  different substrate; the ports are the seam.
- No schema-migration framework exists yet. Journal records carry a `kind` and are validated
  by the Zod schemas on replay, so an incompatible schema change will fail closed instead of
  corrupting state. A versioned migration path is required before the first breaking change.
- Backup/restore is file-level: stop the host, copy the owner-only directory, restart. This is
  documented and testable, but not yet automated.
- Interrupted runs are recoverable as evidence, not silently retried. Operators must create a
  new Workflow (or a future resume operation) after reviewing the interrupted run.
