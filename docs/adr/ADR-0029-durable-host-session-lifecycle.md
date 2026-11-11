# ADR-0029 — Durable Host Session Lifecycle

## Status

**Accepted** (2026-11-11). Closes F-013 for the local trusted host. It does not add a login
flow, multi-factor authentication, rate limiting, TLS, external identity federation, or
multi-host session replication.

## Context

The host authenticated every request by comparing `Authorization: Bearer <token>` against
static SHA-256 digests in its owner-only configuration. A session had no required expiry,
no rotation endpoint, and no revocation endpoint. Removing a digest from the configuration
was the only way to retire a credential, which required editing the file and restarting the
process. A leaked token therefore remained valid until an operator performed that manual
change. The ledger recorded this as F-013 (Low).

The existing operational journal (ADR-0015) already persists Task, Workflow, Artifact, run,
and execution state with a hash chain, single-writer lock, fsync before acknowledgement, and
checkpoint compaction (ADR-0025). The identity boundary needed to use that durability rather
than introduce a second database or a test-only in-memory authority.

## Decision

1. **Bound every session lifetime.** Each configured session has a mandatory ISO-8601
   `expires_at`. The accepted lifetime is at most 30 days (`MAX_SESSION_LIFETIME_MS`). The
   authorization path compares the expiry with a caller-supplied clock and denies an expired
   token as `expired_token`. A configuration seed may already be expired: this is deliberate,
   because after a restart the journal may hold a valid rotated generation for the same
   session while the original seed expiry is in the past.

2. **Persist lifecycle state in the operational journal.** `SessionState` owns:
   - an active record per session (`session_id`, principal, label, token digest, generation,
     issue/expiry timestamps, optional scope, status);
   - a terminal retired-token map keyed by digest, recording the session, generation, reason
     (`rotated` or `revoked`), and retirement time;
   - the current generation and the active scope.

   Rotation and revocation append `session_rotated` / `session_revoked` records to the
   existing journal before the mutation is acknowledged. Replaying those records after a
   restart reconstructs the same state and rejects a record that does not continue the
   current generation or identity. Compaction snapshots include the session state; restore
   refuses a snapshot that resurrects a session removed from configuration, reuses a digest,
   or reactivates a retired token.

3. **Rotate explicitly and invalidate the predecessor.** `POST /v1/session/rotate` requires a
   currently valid session token and generates 32 random bytes encoded as base64url. The
   previous digest enters the retired map with reason `rotated`; the new token is returned
   once in the response and is never written to configuration or logs. The new generation
   can narrow or inherit the current scope, never broaden it. A request already authorized
   before rotation continues; its authorization decision is not retroactively withdrawn. A
   later request with the old token is denied as `rotated_token`. Losing the rotation response
   is an operator-visible loss of that token, not a reason to retain the predecessor.

4. **Revoke terminally.** `POST /v1/session/revoke` retires the current digest with reason
   `revoked` and returns a bounded summary. The operation is idempotent for a token that is
   already revoked, but a new token for the same session does not resurrect the old digest.
   A replay of a revocation journal record cannot restore the token because the retired map
   has no un-retire operation. These routes are self-service: they act on the caller's own
   token. Operator-initiated administration of another principal's session is a separate,
   human-only surface ratified by ADR-0030.

5. **Bind scopes in the real authorization path.** A session may carry optional `task_id`,
   `run_id`, and `evidence_sha256` constraints. After authentication, the HTTP host checks the
   binding against the route's actual task, run, and recomputed evidence digest before route
   logic. A mismatch is denied as `task_scope_mismatch`, `run_scope_mismatch`, or
   `evidence_scope_mismatch`. `GET /v1/runs/:runId` is the run-scoped read route. Self-service
   session inspection/rotation/revocation may use a scoped token without presenting a task or
   run binding; all other routes deny an unchecked scope. A token bound to one task/run cannot
   authorize another, and a token bound to an evidence digest is checked after artifact
   retrieval, not against a caller-supplied digest.

6. **Fail closed with distinguishable structured reasons.** The host returns HTTP 401 with a
   stable `reason` for missing, malformed, unknown, expired, rotated-away, revoked, and
   scope-mismatched credentials, and logs the same reason with a request ID. No failure path
   falls back to an unscoped or static identity. Unknown or malformed journal state fails
   startup rather than silently dropping lifecycle controls.

7. **Preserve independent verification.** These changes do not alter the verifier's separate
   principal or its durable attempt/digest checks. Rotation or revocation of an executor
   session cannot make the verifier accept an executor self-report, and the verifier's own
   session is independently authenticated and authorized.

## Consequences

- The configuration remains the provisioning authority: adding a session still requires an
  owner-only config change and restart. Rotation and revocation no longer do.
- The rotation token exists in the HTTP response and the client's possession only; the host
  stores only its digest. A lost response cannot be recovered from the journal.
- The journal and its compaction archives are trusted local state. An attacker who can rewrite
  both the journal and its digest chain can forge any state; this ADR does not add a detached
  signature or external custody (F-009).
- The host still binds loopback by default and serves plain HTTP. A local attacker able to
  observe loopback traffic or the client's token store is outside this control. Rate limiting,
  login, MFA, and token theft detection remain future work.
- Retired digests accumulate in the journal and snapshots. The bound is the existing
  `MAX_SESSIONS`/journal limits; revocation is terminal, so pruning retired digests would
  reopen replay unless an operator accepts that trade-off explicitly.
- Session state is single-process, like the rest of the journal. Multi-process or multi-host
  replication would need a different substrate.
- A session removed from configuration is not resurrected by an older snapshot; startup fails
  closed and requires operator reconciliation rather than silently reviving a credential.

## Verification

The implementation and regressions are in `apps/host/src/persistence/session-store.ts`,
`apps/host/src/identity.ts`, `apps/host/src/server.ts`, and
`apps/host/tests/session-lifecycle.test.ts`. Coverage includes controlled-clock expiry,
rotation-then-replay, revocation-then-replay, cross-task/run/evidence replay, in-flight work
across rotation, restart recovery, compaction, and snapshot-resurrection refusal. The
2026-11-11 validation entry records the full gate, live bubblewrap suite, security drills,
audit, and secret scan. See `docs/security/findings-ledger.md` (F-013) and
`docs/security/validation-ledger.md`. The operator administration surface and its CLI are
ADR-0030; `docs/security/session-operator-runbook.md` is the incident procedure.
