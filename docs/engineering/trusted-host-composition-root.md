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

It does **not** close the other production blockers: operational stores are still in-memory,
no execution or verification adapter is invented, evidence readers remain unverified against
a live Obsidian++, and there is no Founder UI yet.

## Configuration

`loadHostConfig()` requires an absolute path to a regular, unlinked file with mode `0600`
or stricter, at most 64 KiB. Unknown fields are rejected, which is why a plaintext `token`
field fails startup instead of being silently ignored. A partial example (no secrets):

```json
{
  "schema_version": 1,
  "bind": { "host": "127.0.0.1", "port": 4780 },
  "policy_file": "/home/you/.aios/policy-state.json",
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
  ]
}
```

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
| POST | `/v1/workflows/:id/dispatch` | Authorizes before revealing existence; 503 without adapters |
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
6. `GET /health` must report `dispatch: false` until an execution adapter and independent
   verifier are supplied programmatically; dispatch then returns 503 rather than pretending
   to execute.

## Security properties, restated as tests

`apps/host/tests/http-host.test.ts` exercises, over real loopback HTTP:

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
- policy-lock release and hash-chain re-verification after shutdown.

## What remains open

- **Operational persistence.** Tasks, Workflows, Artifacts, and learning records are the
  in-memory adapters. Leases, idempotency keys, retries, transactional dispatch, and crash
  recovery are not implemented. A restart loses operational state; the policy registry and
  its audit survive.
- **Execution and verification.** No production `AgentExecutionPort` or verifier exists. The
  host composes only what it is given and fails closed otherwise. Verifier provider/process
  independence is still unproven.
- **Live integrations.** Vault, Gmail, and Notion readers are composed but untested against
  real services; per-note vault authorization remains collection-level.
- **Founder experience.** The API is usable; there is no UI, and no mission/objective routes
  beyond Founder search and the Task/Workflow reads listed above.
