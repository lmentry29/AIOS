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
- Keeps policy administration behind an authenticated, exact-granted human-only path; the offline bootstrap CLI remains available.

Operational state (Tasks, Workflows, Artifacts, dispatch runs) is durable through a
hash-chained journal per ADR-0015. The host can compose the fixed `local.exec` executor and
an independently executed verifier (ADR-0019) when a Docker, bubblewrap, or Seatbelt
provider passes its probe. Authorization decisions are durable in a dedicated hash-chained
journal with request correlation. It does **not** close the other production blockers: there
is no general capability/provider runtime, no signed verifier provenance, evidence readers
remain unverified against a live Obsidian++, learning records are durable in a separate
approval-gated journal, and there is no Founder UI yet.

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
    "max_output_bytes": 65536,
    "max_concurrent_tasks": 1
  }
}
```

The `execution` block is optional. `agent_id` and `verifier_id` must be distinct UUIDs;
`provider` is `auto`, `bubblewrap`, `seatbelt`, or `docker`; Docker requires a local image
and never pulls one implicitly. The host checks the provider before advertising dispatch and
fails closed to 503 if it is unavailable. `max_concurrent_tasks` is optional, must be an
integer from 1 to 32, and defaults to 1. A dispatch beyond the cap is rejected with 429
`execution_capacity_exceeded` before any lifecycle write; it is not queued and it does not
start a sandbox invocation.

`obsidian` is optional and, when present, must be `http://127.0.0.1:<port>` or
`http://[::1]:<port>` with no credentials, path, query, or fragment. The Obsidian++ password
is read from `AIOS_OBSIDIAN_PASSWORD` (minimum 32 bytes) and never from this file.

Rejected configurations include: non-loopback bind addresses, relative policy paths,
duplicate resource UUIDs, duplicate session identifiers or token digests, a non-human
bootstrap principal, a bootstrap principal with no session, nonsensical or out-of-range
execution limits, and a group/world-readable config file.

`bootstrap_principal_id` is the principal allowed to read the authorization audit; it is not
a policy-administration bypass. Runtime publication requires an exact `administer_policy`
grant on every target, and the offline CLI remains the bootstrap path.

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

Tasks, Workflows, Artifacts, dispatch runs, and per-Task execution records are stored in an
owner-only directory as a single `operational.jsonl` journal. It is deliberately separate from the Obsidian vault:
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
- **Execution lifecycle.** A separate per-Task execution record is journaled before the
  sandbox starts and driven to exactly one terminal state: `completed`, `failed`, `cancelled`,
  or `interrupted`. Terminal records are immutable. Evidence is bounded and hashed; raw
  output and exception messages are not copied into the journal. A late executor result
  cannot overwrite a cancellation.
- **Cancellation.** `POST /v1/tasks/:taskId/cancel` requires an exact `cancel` grant. The
  terminal cancellation record is committed before the active sandbox is aborted. The local
  executor sends `SIGKILL`; Docker additionally kills its uniquely named container. The
  verifier is skipped when cancellation is observed before verification starts. An active
  Task becomes `suspended`; a queued Task remains `created`, and a later dispatch is rejected.
- **Resume and retry (ADR-0022).** The ledger is an append-only chain of attempts. Each
  attempt carries its own `execution_id`, a monotonic `attempt`, an `attempt_kind`
  (`initial`/`resume`/`retry`), and the `previous_execution_id` it follows; the predecessor is
  never rewritten. `POST /v1/workflows/:id/resume` requires exact `resume` grants on the
  Workflow and on each interrupted Task it re-drives, skips completed Tasks, executes
  remaining `created` Tasks, and refuses a `failed`/`cancelled`/unverified-completed sibling
  with 409 until that Task is explicitly retried. `POST /v1/tasks/:id/resume` accepts only an
  `interrupted` latest attempt. `POST /v1/tasks/:id/retry` accepts `failed`, `cancelled`, or
  an unverified `completed` attempt and appends a distinct attempt. All three authorize before
  lookup, re-enter the same concurrency cap, and return 200 idempotently once the Task or
  Workflow is already complete. Attempts are not capped at two: a resumed attempt can itself
  be interrupted and resumed again, and every successor links to its immediate predecessor.
  A duplicate concurrent resume/retry for the same Workflow or Task returns a typed 409
  `execution_conflict` before any second attempt or sandbox start; an in-process kernel claim
  and the ledger's terminal-predecessor check both enforce it. Attempt history is available
  read-only at `GET /v1/tasks/:id/attempts` and `GET /v1/workflows/:id/attempts` under exact
  `read_status` grants; it returns the ledger's attempts oldest-first with immediate and
  full predecessor links, and never appends, transitions, or executes. Workflow inspection
  is all-or-nothing: every declared step Task is authorized before any step is resolved or
  any history is read, so one missing grant denies the whole request with the existing 403
  and returns no partial chain.
- **Recovery.** At startup, runs left by a previous boot are marked `interrupted`; running
  Task executions are also marked `interrupted`; and their `active`/`monitored` Workflows and
  Tasks are transitioned to `suspended`. Interrupted work is never re-executed or completed
  by recovery. A second startup sees terminal records and is a no-op; if the latest attempt
  is already `interrupted` by an earlier resume, reconciliation creates no attempt and a
  repeated pass writes nothing. `/health` reports how many Workflows and executions were
  recovered.

Known limitations, recorded rather than hidden: no journal compaction or snapshotting yet
(the journal fails closed at 64 MiB), no schema-migration framework, backup/restore is a
file-level copy with the host stopped, and the separate learning and authorization-audit
journals have the same no-compaction/migration limits.

### Permanent Memory approvals

`LearningService.recordObservation()` is an ephemeral draft write and stays unapproved.
Promoting a knowledge record to `published` or `institutional_standard` is a permanent
Memory write and requires a recorded approval bound to the Memory Object, the source and
target stages, and a SHA-256 of its subject and content. Only an authenticated `human:*`
principal can decide the approval, and only when the shared default-deny boundary allows
the existing exact `intake` grant on the protected Founder decision collection. Pending,
rejected, expired, and consumed approvals never authorize a write.

The approval and the resulting promotion are appended as one `promotion` record in
`learning.jsonl`, so they cannot diverge across a crash or reopen; replay revalidates the
binding. `apps/host/tests/learning-store.test.ts` proves approve-then-write survives
close-and-reopen and that a rejected approval leaves no permanent entry;
`packages/learning/tests/memory-approval.test.ts` proves default denial, expiry,
content/transition binding, and human-only decisions; the host-boundary case in
`apps/host/tests/http-host.test.ts` proves an unprivileged human is denied. No public HTTP
Memory write route was added.

### Authorization decision audit

Every allow and deny from the single evaluator is appended to `authorization-audit.jsonl`
using the same `AppendOnlyJournal` contract as operational state: fsync before append
returns, a SHA-256 hash chain, single-process lock, torn-tail truncation on open, and
fail-closed rejection of a malformed complete record. Records carry the request id,
principal, action, resource, policy id/version, decision, fixed reason code, decisive rule
index/effect when a rule matched, and timestamp; unknown fields and non-fixed reasons are
rejected. The host request id is propagated through `SharedAuthorizationBoundary`, so every
decision made while handling one request shares that correlation id.

If the append fails, `AuthorizationService` returns deny even when a rule would have allowed
the operation. Policy lifecycle events remain atomically committed with policy state in the
policy registry. `GET /v1/audit/authorization` is bootstrap-only and also requires the exact
`read_evidence` grant on the protected decision collection; no unauthenticated audit route
exists.

## HTTP surface

Loopback only, no CORS headers, `no-store` responses.

| Method | Route | Notes |
|---|---|---|
| GET | `/health` | Unauthenticated readiness; no configuration or secrets |
| GET | `/v1/session` | Verified principal, session id, human flag |
| POST | `/v1/policies` | Human-only; exact `administer_policy` on every target; atomic publish and attach; 201 |
| GET | `/v1/tasks?limit=` | Lists only Tasks on which the session has `read_status` |
| GET | `/v1/workflows?limit=` | Lists only Workflows on which the session has `read_status` |
| GET | `/v1/tasks/:id` | Requires `read_status` on the Task |
| GET | `/v1/workflows/:id` | Requires `read_status` on the Workflow |
| GET | `/v1/tasks/:id/attempts` | Requires `read_status`; ordered attempts plus oldest-first predecessor chain; read-only |
| GET | `/v1/workflows/:id/attempts` | Requires `read_status` on the Workflow and each step Task, all-or-nothing before any history read; per-Task chains in step order |
| POST | `/v1/tasks/:id/cancel` | Requires exact `cancel`; optional bounded `reason`; 202, or 200 if already cancelled |
| POST | `/v1/workflows/:id/resume` | Requires exact `resume` on the Workflow and each interrupted Task; completed Tasks are skipped |
| POST | `/v1/tasks/:id/resume` | Requires exact `resume`; only an `interrupted` latest attempt; 200 idempotent when already completed |
| POST | `/v1/tasks/:id/retry` | Requires exact `retry`; appends a distinct attempt after `failed`, `cancelled`, or unverified `completed` |
| GET | `/v1/tasks/:taskId/evidence/:evidenceId` | Kernel enforces evidence linkage, `read_evidence`, and the accepted verifier-identity binding |
| POST | `/v1/intake` | `{ kind: "task" \| "workflow", entity }`; provenance must match the session |
| POST | `/v1/workflows/:id/dispatch` | Requires `Idempotency-Key`; replays a completed key, 409 while another lease is live, 503 without adapters |
| POST | `/v1/founder/query` | Authorization-filtered canonical and learning search |
| POST | `/v1/founder/evidence-query` | Requires composed vault reader |
| POST | `/v1/founder/gmail/search` | Separate Gmail resource grant |
| GET | `/v1/founder/notion/applications` | Separate Notion resource grant |
| GET/POST | `/v1/founder/decisions` | Decision capture is human-only |
| GET | `/v1/founder/queue` | Human-only review queue |
| GET | `/v1/audit/policies` | Bootstrap principal only |
| GET | `/v1/audit/authorization?limit=` | Bootstrap principal plus exact `read_evidence` on the decision collection |

Requests carrying a non-loopback `Host` header are rejected (DNS rebinding), as are requests
carrying any `Origin` header (no browser cross-origin client exists yet, so there is no CORS
surface to get wrong). JSON bodies require `application/json`, are bounded by
`request_body_limit_bytes` (256 KiB default), and are rejected with 413 rather than buffered
without limit. The cancel route accepts an empty body; when a reason is supplied it is
bounded and represented in the journal by a SHA-256 digest, not the caller's text.

## Policy provisioning and runtime administration

`aios-host publish-policy` remains the human-only offline bootstrap path:

```sh
aios-host publish-policy --config /abs/host.json --policy /abs/policy.json
```

The provisioning document is `{ "policy": { ... }, "attach_to": ["<resource-uuid>"] }`, must
be owner-only, and is applied through `PolicyAdministrationService` against the same durable
registry the host later evaluates. Publication and attachment each append a hash-chained
audit event. The host must be stopped while this runs because the registry holds a
single-process lock.

While the host is running, `POST /v1/policies` accepts the same envelope under a verified
bearer session. It requires an authenticated `human:*` principal and an exact
`administer_policy` allow on **every** target before any mutation. The new policy must have a
new UUID and a positive version, may reference only the resources in `attach_to`, and every
target must be referenced by at least one of its rules. Its version must exceed the effective
version of every already-attached target. `FilePolicyRegistry.publishAndAttach()` validates
the whole operation and writes the policy, all attachments, and lifecycle events as one
fsync'd snapshot; a rejected artifact leaves both the disk state and the effective policy
unchanged.

Successful publication returns `201` with the policy id, version, and attached resources.
Typed failures are `400 invalid_policy`/`invalid_targets`, `409 policy_exists`/
`version_conflict`, `403 policy_admin_denied`/`human_principal_required`, and
`401 unauthenticated`. Every target decision is written to `authorization-audit.jsonl`; if that
append fails, the request is denied before the registry is called. The route is not a
bootstrap bypass: a non-bootstrap human with the exact grants may use it, and the bootstrap
principal receives no implicit grant.

There is no detached policy signature in this trust model: authority is the verified session
plus the exact grant, and a caller-supplied signature field is rejected. There is also no
HTTP revocation route yet. A policy version cannot be rolled back by reattaching an older
policy; publish a new, higher version containing the desired rules.

## Bootstrap sequence

1. Start Obsidian++ locally and confirm it passes its own authentication and loopback checks.
2. Generate a bearer token, store only its SHA-256 digest in the host config (mode `0600`).
3. Write a policy document granting exact subject/action/resource tuples, then run
   `publish-policy` for the initial bootstrap. Later replacements may use `POST /v1/policies`
   once a human holds the exact `administer_policy` grants.
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
   The verifier runs its own command; it does not trust the executor's summary. Its decision
   must name the configured verifier, and persisted evidence is re-checked on read: a missing
   or mismatched verifier identity is rejected rather than presented as verified.

## Security properties, restated as tests

`apps/host/tests/http-host.test.ts` exercises, over real loopback HTTP:

- dispatch through the real fixed executor and independently executed verifier adapters
  (with a test-only sandbox stub; no real isolation is claimed by that test);
- Task/Workflow lists filtered per resource, not by hiding an unauthorized global list
  behind a 403;

- health without authentication leaking nothing;
- identical 401 behavior across missing/malformed/wrong credentials;
- DNS-rebinding and cross-origin rejection;
- 404 for unknown routes and 405 with `Allow` for wrong methods;
- runtime policy publication succeeding only with an exact `administer_policy` grant on every
  target, with a non-bootstrap human exercising the path, the replacement deciding later
  reads, and the allow decision recorded in the durable journal;
- agent, action/resource/scope mismatch, unauthenticated, malformed, schema-invalid, stale,
  audit-failure, and restart cases for runtime publication, with the prior policy unchanged
  on every rejection;
- default-deny intake and dispatch with no attached policy;
- agent impersonation and body-supplied actor rejection;
- intake-only policy denying dispatch with no lifecycle writes;
- full execute → independent verify → evidence retrieval;
- one decision-audit chain containing decisions for the executor, verifier, dispatch, and
  Founder reads, with request-id correlation and exact grant binding;
- verification evidence bound to the configured verifier: a matching record reads back
  unchanged across a reopen, a swapped verifier configuration rejects the persisted record
  with `orchestration_rejected` and records no completion, and a record with no verifier
  identity is rejected while its Task stays `created`;
- 503 and unchanged lifecycle state when adapters are absent;
- conflict on re-dispatch of a completed workflow;
- human-only governance and bootstrap-only, policy-granted audit reads;
- media-type, JSON, and body-limit enforcement;
- policy-lock and authorization-audit lock release, plus hash-chain re-verification after
  shutdown;
- authorized cancellation of an executing Task, with the sandbox stub aborted, the verifier
  skipped, and a terminal cancelled execution plus cancelled run recorded;
- queued cancellation and denied cancellation, with no execution or ledger write on denial;
- concurrent dispatch rejected with 429 before lifecycle writes, then retried successfully;
- crash-interrupted Workflow resume appending attempt 2 while attempt 1 stays `interrupted`,
  then a repeated resume returning 200 idempotently with no third attempt;
- a persisted three-generation `interrupted → resume → interrupted → resume → completed`
  chain across two restarts, with monotonic attempts, correct kinds, immediate-predecessor
  links, and unchanged earlier records;
- repeated reconciliation over an already-interrupted resumed attempt creating no attempt and
  writing no journal bytes, proven through the real persisted ledger;
- concurrent duplicate Workflow resume, Task resume, and Task retry each returning one 409
  and producing exactly one appended attempt and one sandbox start;
- cancellation of a resumed attempt aborting the sandbox and leaving attempts 1 and 2
  immutable, followed by an explicit retry that appends attempt 3 and completes the Task;
- Task and Workflow attempt inspection returning a persisted three-generation chain in order
  with correct kinds, monotonic numbers, immediate links, and oldest-first predecessor
  chains, plus single-attempt and failed-then-retried histories;
- the same inspection leaving the operational journal byte-identical (SHA-256), appending no
  attempt, and preserving every attempt state/revision after reopening the persisted ledger;
- attempt inspection returning the existing 401 and 403 contracts on both routes and 404 for
  a granted-but-unknown Task or Workflow;
- Workflow attempt inspection denying all-or-nothing when a first or later step Task lacks
  `read_status`, with no partial payload, no ledger history read, and a byte-identical
  operational journal across both denials;
- both persisted Task ledgers unchanged after reopening the host following those denials;
- a fully authorized multi-Task Workflow returning every step Task's history in declared
  order, including the unchanged three-generation chain;
- a cancelled attempt refusing `resume` with 409 while an authorized `retry` appends a
  distinct attempt and preserves the cancelled record;
- a failed attempt blocking Workflow resume until its Task is explicitly retried, then a
  Workflow resume that skips the completed Task and starts no sandbox;
- `resume`, `retry`, and the retried Agent's `execute` each denied with 403 before lookup and
  with no attempt or lifecycle write;
- the concurrency cap rejecting a later-generation Workflow resume with 429 before any
  attempt/lifecycle write, then succeeding after capacity is released;
- authorization allow and deny records with exact rule binding and default-deny reasons;
- authorization decisions remaining ordered and readable after a host restart, correlated to
  the guarded request id, with no token material in the journal;
- authorization-audit tamper detection, torn-tail recovery, and append-failure denial;
- restart recovery of Tasks/Workflows and running executions from the operational journal;
- interrupted dispatch/execution recovered as `interrupted`, with its Workflow and Task
  `suspended`, and a second startup making no further changes;
- idempotent replay of a completed dispatch and rejection of a conflicting one;
- missing `Idempotency-Key`, expired-lease reclaim, tamper detection, and torn-tail recovery
  (`tests/persistence.test.ts`).

## What remains open

- **Policy administration assurance.** Runtime publication is exact-granted and human-only,
  with atomic replacement and durable decision audit. There is no detached policy signature,
  HTTP revocation route, key rotation, external audit custody, or reattachment of an older
  version for rollback; recovery from a bad policy is a new higher-version publication. The
  registry is single-process and local-disk only.
- **Operational persistence limits.** Task/Workflow/Artifact/run state is durable, but the
  journal is not compacted or snapshotted, has no migration framework, and supports only one
  host process. Learning state is durable in a separate journal and approval-gated for
  permanent stages, but it shares the same missing compaction/migration story. Backup/restore
  is a documented file copy, not an automated procedure. Dispatch is idempotent and leased. Resume and retry are
  deliberate, authorized, append-only operations (ADR-0022); there is still no automatic
  resume, backoff loop, scheduler, or capacity queue. Multi-generation resume and duplicate
  suppression are proven only against the labelled `stub-container` double, not a real
  container runtime.
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
