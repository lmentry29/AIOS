# Trusted Host Composition Root

Status: implemented locally in `apps/host/` (application, not a tenth `@aios/*` package).
This document is living engineering reference; it does not amend `docs/architecture/`.

## Purpose

The architecture assigns caller authentication to a trusted host and requires one
authorization boundary across surfaces. Before this host existed, `@aios/founder` and
`@aios/orchestration` could each be constructed with a different `AuthorizationService`, and
nothing in the repository turned an HTTP request into a trusted principal.

`apps. host` closes that specific gap:

- Loads owner-only local configuration.
- Authenticates a bearer token and binds the request to a configured principal.
- Composes **one** durable `FilePolicyRegistry` and **one** `AuthorizationService`.
- Injects the same boundary adapter into Founder and Orchestration.
- Exposes a small, reviewed read/execute surface over loopback HTTP.
- Keeps policy administration off the network entirely.

Operational state (Tasks, Workflows, Artifacts, dispatch runs) is durable through a
hash-chained journal per ADR-0015. The host can compose the fixed `local.exec` executor and
an independently executed verifier (ADR-0019) when a Docker, bubblewrap, or Seatbelt
provider passes its probe. It does **not** close the other production blockers: there is no
general capability/provider runtime, no signed verifier provenance, evidence readers remain
unverified against a live Obsidian++, learning records are still in-memory, and there is no
Founder UI yet.

## Configuration

`loadHostConfig()` requires an absolute path to a regular, unlinked file with mode `0600`
or stricter, at most 64 KiB. Unknown fields are rejected, which is why a plaintext `token`
field fails startup instead of being silently ignored. A partial example (no secrets):

```json
{
  "schema_version": 1,
  "bind": { "host": "127.0.0.1", "port": 4780 },
  "policy_file": "/home/you/.aios/policy-state.json",
  "operational_store": { "directory": "/home/you/.aios/operational" },
  "dispatch_lease_ms": 300000,
  "decision_collection_id": "00000000-0000-4000-8000-000000000001",
  "resources": {
    "vault": "00000000-0000-4000-8000-000000000002",
    "gmail": "00000000-0000-4000-8000-000000000003",
    "notion": "00000000-0000-4000-8000-000000000004"
  },
  "bootstrap_principal_id": "human:founder",
  "sessions": [
    {
      "session_id": "00000000-0000-4000-8000-000000000005",
      "principal_id": "human:founder",
      "token_sha256": "<sha256 hex of a token you generate locally>",
      "label": "founder laptop"
    }
  ],
  "execution": {
    "workspace_directory": "/home/you/.aios/workspaces",
    "agent_id": "00000000-0000-4000-8000-000000000006",
    "verifier_id": "00000000-0000-4000-8000-000000000007",
    "provider": "docker",
    "image": "node:22-alpine",
    "default_timeout_ms": 60000,
    "max_output_bytes": 65536
  }
}
```

The `execution` block is optional. `agent_id` and `verifier_id` must be distinct UUIDs;
`provider` is `auto`, `bubblewrap`, `seatbelt`, or `docker`; Docker requires a local image
and never pulls one implicitly. The host checks the provider before advertising dispatch and
fails closed to 503 if it is unavailable.

`obsidian` is optional and, when present, must be `http://127.0.0.1:<port>` or
`http://[::1]:<port>` with no credentials, path, query, or fragment. The Obsidian++ password
is read from `AIOS_OBSIDIAN_PASSWORD` (minimum 32 bytes) and never from this file.

Rejected configurations include: non-loopback bind addresses, relative policy paths,
duplicate resource UUIDs, duplicate session identifiers or token digests, a non-human
bootstrap principal, a bootstrap principal with no session, and a group/world-readable
config file.

## Identity

`TrustedIdentityService` verifies `Authorization: Bearer <token>` against pre-provisioned
SHA-256 digests. It compares every entry with `timingSafeEqual` and does not exit early, so
timing does not disclose which session matched. Missing, malformed, oversized, wrong, and
expired credentials all return the same unauthenticated result.

The authenticated session is the only source of an actor identifier. Request bodies may not
name their own actor: `/v1/intake` requires `created_by` and `owner_id` to equal the session
principal, and `/v1/founder/decisions` requires `decided_by` (when present) to match it.
Caller-supplied actor strings are never treated as authentication, per ADR-0013.

## Durable operational state (ADR-0015)

Tasks, Workflows, Artifacts, and dispatch runs are stored in an owner-only directory as a
single `operational.jsonl` journal. It is deliberately separate from the Obsidian vault:
ADR-0014 remains the Founder Intelligence substrate, and this host never reads or writes
vault notes as operational storage.

- **Durability.** Each record is one JSON line, fsync'd before the write is acknowledged.
- **Integrity.** Every record carries a sequence, the previous hash, and a SHA-256 hash over
  canonical JSON. Open verifies the full chain; an altered or reordered committed record
  fails closed instead of loading.
- **Torn writes.** A crash can leave an unterminated final line. Only that tail is truncated
  on open; a *complete* record that fails validation is corruption, not a tail.
- **Single process.** A lock file with stale-PID recovery prevents two hosts sharing the
  journal. Multi-process concurrency is not supported; the repository ports are the seam for
  a different substrate later.
- **Replay, not re-execution.** Entities are restored through `ObjectStore.restore()`, which
  validates the schema and only allows monotonic versions with append-only history prefixes.
  Replay therefore cannot invent timestamps, versions, or lifecycle entries.
- **Idempotency and leases.** `POST /v1/workflows/:id/dispatch` requires an
  `Idempotency-Key` header. A completed run is replayed for the same key; a second key (or a
  second caller) while a lease is live receives `409 dispatch_conflict`. Leases are renewed
  while dispatch runs and expire if the worker disappears.
- **Recovery.** At startup, runs left by a previous boot are marked `interrupted`; their
  `active`/`monitored` Workflows and active Tasks are transitioned to `suspended`. Interrupted
  work is never completed by recovery, and `/health` reports how many Workflows were
  recovered.

Known limitations, recorded rather than hidden: no journal compaction or snapshotting yet
(the journal fails closed at 64 MiB), no schema-migration framework, backup/restore is a
file-level copy with the host stopped, and learning records are still in-memory.

## HTTP surface

Loopback only, no CORS headers, `no-store` responses.

| Method | Route | Notes |
|---|---|---|
| GET | `/health` | Unauthenticated readiness; no configuration or secrets |
| GET | `/v1/session` | Verified principal, session id, human flag |
| GET | `/v1/tasks/:id` | Requires `read_status` on the Task |
| GET | `/v1/workflows/:id` | Requires `read_status` on the Workflow |
| GET | `/v1/tasks/:taskId/evidence/:evidenceId` | Kernel enforces evidence linkage and `read_evidence` |
| POST | `/v1/intake` | `{ kind: "task" \| "workflow", entity }`; provenance must match the session |
| POST | `/v1/workflows/:id/dispatch` | Requires `Idempotency-Key`; replays a completed key, 409 while another lease is live, 503 without adapters |
| POST | `/v1/founder/query` | Authorization-filtered canonical and learning search |
| POST | `/v1/founder/evidence-query` | Requires composed vault reader |
| POST | `/v1/founder/gmail/search` | Separate Gmail resource grant |
| GET | `/v1/founder/notion/applications` | Separate Notion resource grant |
| GET/POST | `/v1/founder/decisions` | Decision capture is human-only |
| GET | `/v1/founder/queue` | Human-only review queue |
| GET | `/v1/audit/policies` | Bootstrap principal only |
| GET | `/v1/audit/authorization?limit=` | Bootstrap principal only |

Requests carrying a non-loopback `Host` header are rejected (DNS rebinding), as are requests
carrying any `Origin` header (no browser cross-origin client exists yet, so there is no CORS
surface to get wrong). JSON bodies require `application/json`, are bounded by
`request_body_limit_bytes` (256 KiB default), and are rejected with 413 rather than buffered
without limit.

## Policy provisioning

There is deliberately no policy-mutation route. `aios-host publish-policy` is the human-only
offline path:

```sh
aios-host publish-policy --config /abs/host.json --policy /abs/policy.json
```

The provisioning document is `{ "policy": { ... }, "attach_to": ["<resource-uuid>"] }`, must
be owner-only, and is applied through `PolicyAdministrationService` against the same durable
registry the host later evaluates. Publication and attachment each append a hash-chained
audit event. The host must be stopped while this runs because the registry holds a
single-process lock.

## Bootstrap sequence

1. Start Obsidian++ locally and confirm it passes its own authentication and loopback checks.
2. Generate a bearer token, store only its SHA-256 digest in the host config (mode `0600`).
3. Write a policy document granting exact subject/action/resource tuples, then run
   `publish-policy`.
4. `export AIOS_OBSIDIAN_PASSWORD=...` if evidence readers are configured.
5. `aios-host serve --config /abs/host.json`.
6. `GET /health` reports `dispatch: false` until a configured isolation provider passes its
   probe and both the fixed executor and independent verifier are composed. If the provider
   fails, the host still starts but dispatch returns 503 rather than falling back to a bare
   process (ADR-0019).
7. Configure execution only when the operator intends to run local commands:
   `execution.workspace_directory` must be an owner-only parent outside the Obsidian vault,
   `agent_id` and `verifier_id` must be distinct UUIDs, and `provider` is `auto`,
   `bubblewrap`, `seatbelt`, or `docker`. Docker additionally requires a pre-pulled image.
   The verifier runs its own command; it does not trust the executor's summary.

## Security properties, restated as tests

`apps/host/tests/http-host.test.ts` exercises, over real loopback HTTP:

- dispatch through the real fixed executor and independently executed verifier adapters
  (with a test-only sandbox stub; no real isolation is claimed by that test);

- health without authentication leaking nothing;
- identical 401 behavior across missing/malformed/wrong credentials;
- DNS-rebinding and cross-origin rejection;
- 404 for unknown routes and 405 with `Allow` for wrong methods;
- absence of any policy-administration route;
- default-deny intake and dispatch with no attached policy;
- agent impersonation and body-supplied actor rejection;
- intake-only policy denying dispatch with no lifecycle writes;
- full execute → independent verify → evidence retrieval;
- one audit chain containing the executor, verifier, dispatch, and Founder reads;
- 503 and unchanged lifecycle state when adapters are absent;
- conflict on re-dispatch of a completed workflow;
- human-only governance and bootstrap-only audit reads;
- media-type, JSON, and body-limit enforcement;
- policy-lock release and hash-chain re-verification after shutdown;
- restart recovery of Tasks/Workflows from the operational journal;
- interrupted dispatch recovered as `interrupted`, with its Workflow and Task `suspended`;
- idempotent replay of a completed dispatch and rejection of a conflicting one;
- missing `Idempotency-Key`, expired-lease reclaim, tamper detection, and torn-tail recovery
  (`tests/persistence.test.ts`).

## What remains open

- **Operational persistence limits.** Task/Workflow/Artifact/run state is durable, but the
  journal is not compacted or snapshotted, has no migration framework, and supports only one
  host process. Learning records remain in-memory. Backup/restore is a documented file copy,
  not an automated procedure. Dispatch is idempotent and leased, but there is no retry backoff
  or automatic resume of interrupted work.
- **Execution and verification.** The fixed `local.exec` path exists for Docker,
  bubblewrap, and macOS Seatbelt. It is not a general capability runtime; coordination is
  intentionally unsupported. Verifier independence is enforced as a distinct configured
  principal plus a separately executed command, but there is no signed verifier decision,
  key rotation, or protection against a compromised host process. Bubblewrap lacks cgroup
  accounting/seccomp and is suitable only for trusted local commands.
- **Live integrations.** Vault, Gmail, and Notion readers are composed but untested against
  real services; per-note vault authorization remains collection-level.
- **Founder experience.** The API is usable; there is no UI, and no Mission/Objective
  routes beyond Founder search and the Task/Workflow reads listed above. ADR-0017 records
  why Mission cannot be invented casually.
