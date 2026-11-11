# ADR-0030 — Human-Only Operator Session Administration

## Status

**Accepted** (2026-11-11). Adds an operator administration surface over the session
lifecycle ratified by ADR-0029. It does not add a login flow, multi-factor authentication,
step-up approval, rate limiting, TLS, external identity federation, or a second session
authority.

## Context

ADR-0029 added rotation and revocation, but both routes are self-service: they act on the
digest presented in the caller's own `Authorization` header. An operator responding to an
incident usually does not hold the compromised token — they hold a different, healthy
session and need to retire someone else's credential. Before this decision the only options
were a hand-written HTTP call using the compromised principal's token, or editing the
owner-only configuration and restarting the host. The first is error-prone and may be
impossible precisely when the token is lost; the second loses the immediate-effect property
the lifecycle was built for and is a poor fit for an incident timeline.

Two shortcuts were considered and rejected:

- **A CLI that writes the journal directly.** The operational journal is single-process and
  locked by the running host; a second writer either fails or corrupts state. Worse, a direct
  write would not update the live in-memory session map, so a revocation could be reported as
  successful while the running host kept authorizing the retired token.
- **A shared administrator bearer token.** That would be a second authentication path with
  different rules and no per-session binding, weakening rather than extending ADR-0029.

## Decision

1. **Add one exact action, `administer_sessions`.** Its resource is the target session UUID.
   Like `administer_policy` and `revoke_policy`, it may be granted only to human principals,
   is never implied by another action, ownership, or the bootstrap identity, and has no
   wildcard or role expansion. Policy validation rejects the action for any non-human
   subject. The durable decision audit accepts the new action in its fixed allowlist.

2. **Authorize before existence.** `POST /v1/admin/sessions/:sessionId/rotate` and
   `POST /v1/admin/sessions/:sessionId/revoke` require an exact `administer_sessions` allow
   on that UUID and a human principal before the session is looked up. An unauthorized caller
   receives 403 whether or not the UUID exists, so the route is not an existence oracle. A
   malformed UUID is a 400 before authorization; a body is rejected with 400 because these
   routes take no caller input beyond the path.

3. **Filter the list, never publish digests.** `GET /v1/admin/sessions` iterates the live
   session records and returns only those on which the caller holds the exact grant. It never
   returns a token digest, and `total` is the filtered length rather than a global count. A
   session the caller cannot administer does not appear at all.

4. **Mutate through the live authority.** The routes call
   `DurableSessionStore.rotateById`/`revokeById`, which plan against the same in-memory
   `SessionState` the authenticator uses, append the same `session_rotated`/`session_revoked`
   journal record, and apply the mutation before the response is written. The running host
   therefore denies the retired token on its next request, and a restart replays the same
   record instead of re-seeding from configuration.

5. **Bound every response.** Rotation returns exactly one new token plus session id,
   generation, expiry, and optional scope. It is the only response on any surface that
   contains token material. Revocation returns session id, generation, `revoked_at`, and
   `already_revoked`. Listing returns public metadata only: id, principal, label, issue and
   expiry timestamps, generation, status, optional scope, and revocation metadata when
   present.

6. **Idempotency and terminality are explicit.** Revoking an already-revoked session returns
   200 with `already_revoked: true` and appends nothing. Rotating a revoked session, or an
   expired one, is 409 `session_conflict`; the operator must provision a new session rather
   than resurrect a retired credential. Rotation keeps the session id, increments the
   generation, and can narrow or inherit the existing scope but never broaden it.

7. **The CLI is a transport, not an authority.** `aios-host list-sessions`,
   `rotate-session`, and `revoke-session` read the bearer token from an owner-only regular
   file (mode `0600` or stricter, no symlink, at most 4096 bytes), never from argv, and send
   it only as an `Authorization` header to the configured loopback bind. Each invocation
   prints one JSON object on stdout on success or one structured JSON object on stderr on
   failure. Exit codes are stable: `0` success, `2` usage or local configuration, `3` denied,
   `4` not found, `5` retired or conflict, `6` transport or server failure. The CLI opens no
   journal and takes no lock, so it is safe to run while the host is live; it does require
   the host to be running.

8. **Reuse the existing audit trail.** Every admin attempt is an ordinary authorization
   decision and is appended to `authorization-audit.jsonl` with the host request id, allow or
   deny, and the decisive policy rule. The lifecycle change itself is appended to the
   operational journal. An audit append failure denies before any mutation, exactly as on
   every other protected operation.

## Consequences

- An operator can retire another principal's session without that principal's token, without
  editing configuration, and without a restart. The target loses access on its next request;
  work already authorized keeps ADR-0029's in-flight rule and is not retroactively cancelled.
- Rotation delivers the new token to the operator, not to the target principal. Handover is
  out of band and the response is the only copy; a lost response is a lost token, not a
  reason to keep the predecessor.
- The operator's session becomes a high-value credential: an exact grant on many session ids
  is effectively incident-response authority. There is no step-up, hardware key, quorum, or
  separate approval. This raises the impact of operator-token theft and is recorded as a
  residual rather than treated as solved.
- A human with a grant on a session id can see that session's principal, label, and status.
  Because the grant is per session, this is not a global directory; a grant on one id says
  nothing about another.
- Revocation remains terminal. Restoring service for a revoked session requires provisioning
  a new session in the owner-only configuration and restarting the host; no CLI command
  un-revokes.
- The surface is loopback HTTP with bearer credentials, like the rest of the host. It does not
  add TLS, rate limiting, login, MFA, external audit custody, or a detached signature over
  the journal. Those remain open (F-009 and the ADR-0029 residuals).

## Verification

The implementation is in `apps/host/src/persistence/session-store.ts`,
`apps/host/src/server.ts`, `apps/host/src/operator-session.ts`, and
`apps/host/src/cli.ts`; the exact action and human-only validation are in
`packages/founder/src/authorization.ts` with the audit allowlists in
`packages/founder/src/file-policy-registry.ts` and
`apps/host/src/persistence/authorization-audit-store.ts`.

`apps/host/tests/session-operator.test.ts` covers, over real loopback HTTP and the real
durable journal: listing without digests, rotation through the live host with the old token
denied as `rotated_token`, the new token accepted, restart recovery of both, revocation
denying the target's next request and surviving restart, idempotent repeat revocation, 409 on
rotating a retired session, the denied/not-found/usage exit codes, a non-human denial, a
scoped-token denial with `scope_binding_required`, and absence of token material in stdout,
stderr, and the journal. `packages/founder/tests/authorization.test.ts` proves the exact,
human-only grant. `tools/security/session-operator-drill.mjs` runs the same flow through the
compiled `aios-host` binary against a real host process and real restarts. See
`docs/security/validation-ledger.md` for the measured results and
`docs/security/session-operator-runbook.md` for the incident procedure.
