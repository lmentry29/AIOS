# Session Operator Runbook

Incident procedure for rotating and revoking host session tokens through the first-class
operator CLI (ADR-0030). This is the human-facing companion to the durable session lifecycle
(ADR-0029). It covers the local trusted host only: loopback HTTP, owner-only local files, one
host process.

## What you need

- The host running (`aios-host serve --config /abs/host.json`). The CLI has no offline mode;
  it talks to the live host so the change takes effect immediately.
- A **healthy** human session with an exact `administer_sessions` grant on the target session
  id. The bootstrap principal receives no implicit grant.
- The bearer token for that session in an owner-only file: a regular, non-symlink file,
  mode `0600` or stricter, at most 4096 bytes, containing exactly the token and an optional
  trailing newline. Never pass the token as an argument and never paste it into a terminal,
  ticket, or chat.
- The target session id (`GET /v1/admin/sessions` output, or the incident report).

```sh
umask 077
printf '%s' "$OPERATOR_TOKEN" > /run/aios/operator.token   # or copy an existing 0600 file
chmod 600 /run/aios/operator.token
```

The token may come from the environment of a trusted shell, but do not leave it in shell
history or in a world-readable file. If the file is group- or world-readable, the CLI refuses
with exit code `2` before making a request.

## Commands

```sh
aios-host list-sessions   --config /abs/host.json --token-file /run/aios/operator.token
aios-host rotate-session --config /abs/host.json --token-file /run/aios/operator.token --session-id <uuid>
aios-host revoke-session --config /abs/host.json --token-file /run/aios/operator.token --session-id <uuid>
```

Each command writes one JSON object. `list-sessions` and `revoke-session` never contain token
material. `rotate-session` contains the **single new token** in its `token` field and nothing
else secret. Plan how to capture that one line before you run it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, including idempotent repeat revocation (`already_revoked: true`) |
| `2` | Usage or local configuration: missing/unsafe token file, malformed `--session-id`, unreadable config, non-live port |
| `3` | Denied: unknown token, non-human principal, missing exact `administer_sessions` grant, or a scoped token with no task/run binding |
| `4` | The target session id does not exist (only reported after authorization) |
| `5` | Retired or conflict: rotating a revoked or expired session |
| `6` | Transport or server failure: host down, timeout, non-JSON response, or an unexpected status |

A non-zero exit always prints one JSON object on stderr with `event: "session_admin_failed"`
and bounded fields (`error`, `reason`, `message`, `request_id`). No token or digest is printed.

### Listing

```json
{"event":"session_listed","sessions":[{"session_id":"…","principal_id":"human:…","label":"…","issued_at":"…","expires_at":"…","generation":1,"status":"active"}],"total":1}
```

The list is filtered to sessions on which **you** hold the exact grant. It is not a directory
of every session, and it never contains `token_sha256`. If an expected session is missing, you
lack the grant on that id; do not treat the absence as proof the session does not exist.

## Incident procedure: suspected token compromise

1. **Identify the session id.** Use `list-sessions` if you already hold the grant. If you do
   not, the incident owner must name the session id from provisioning records. A missing grant
   is a policy task, not something the CLI can bypass.
2. **Rotate first.** Rotation immediately retires the compromised digest and issues a fresh
   token for the same session, generation +1, with the same or narrower scope. The attacker's
   token is denied as `rotated_token` on the next request. Work already authorized before the
   rotation is not retroactively cancelled (ADR-0029).
3. **Capture the new token safely and hand it over out of band.** The rotation response is the
   only copy; the journal stores only its digest. Write stdout to an owner-only file, for
   example `umask 077` and redirect, then deliver it through your normal secret channel. Never
   re-print it, and do not use a shared shell with scrollback or history capture.
4. **Verify the old token is dead.** `GET /v1/session` with the old token must return 401 with
   `reason: "rotated_token"`. With the new token it must return 200 and the new generation.
5. **Revoke when rotation is not sufficient.** Rotate kills the known token; revoke retires the
   session itself. Revoke when the compromise is not contained — for example the token store,
   not just the token, may be exposed, the rotation response may have been observed, or the
   session should not continue to exist. Revocation is **terminal**: the target must be
   re-provisioned in the owner-only configuration and the host restarted to restore service.
   Do not revoke reflexively before rotating if you need the principal to keep working; the two
   are not reversible in the same way.
6. **If the operator's own token is the compromised one**, do not use it. Use another human
   session that holds the grant. If no such session exists, fall back to the offline path:
   stop the host, edit the owner-only configuration, and restart. That path re-seeds from
   configuration and cannot be done while the host is live; it also cannot un-revoke a session
   the journal already retired.
7. **Revoking a token that is already revoked is safe.** It returns exit `0` with
   `already_revoked: true` and appends nothing. Repeating the command during an incident is not
   an error.
8. **Rotating a revoked or expired session fails with exit `5`.** That is intentional: a
   retired credential is not resurrected. Provision a new session instead.

## What to check afterwards

- `GET /health` is still ready and reports the expected dispatch state.
- `list-sessions` shows the target's new `generation` and `status` (`active` after rotation;
  `revoked` plus `revoked_at`/`revocation_reason` after revocation).
- The retired token is denied in the live path, not only in the CLI's view:
  `GET /v1/session` with it returns 401 `rotated_token` or `revoked_token`.
- The new token works, if rotation was used, and its scope did not broaden.
- The operational journal contains a `session_rotated` or `session_revoked` record whose
  payload has digests only — no plaintext token. `session_revoked` for an idempotent repeat
  adds no duplicate record.
- `authorization-audit.jsonl` contains the `administer_sessions` allow (or deny) for the
  attempt, correlated with the request id. A denied attempt must show a deny and no lifecycle
  change.
- No token appears in host stdout/stderr, shell history, the CLI's own output (other than the
  one rotation token), or any log you are about to attach to the incident.

## Restart and compaction expectations

- **Restart:** state is durable. After a restart the rotated-away token is still denied as
  `rotated_token`, a revoked token is still denied as `revoked_token`, and the current
  generation's token still authenticates. The configuration seed is not re-applied on top of
  the journal's newer generation.
- **Compaction:** the operational journal snapshot includes session state. Run
  `aios-host compact-journal` only with the host stopped; the journal holds a single-process
  lock. A restored snapshot that would resurrect a retired token or reuse a digest is refused.
- **Clock:** expiry is evaluated against the host clock. If the host clock jumps forward past
  `expires_at`, the session is denied as `expired_token` regardless of the CLI; provision a new
  session rather than trying to rotate an expired one.

## Limits that remain

- The CLI is a transport over loopback HTTP. It does not add TLS, mutual TLS, login, MFA,
  step-up approval, or rate limiting. An attacker who can read the operator's token file or
  observe loopback traffic has the same authority the operator does.
- The operator session is a high-value credential: the grant is per target session, but a
  grant on many ids is effectively incident-response authority. There is no approval quorum.
- The list route exposes principal, label, timestamps, generation, scope, and status for
  granted sessions. It does not expose digests, and it does not enumerate ungranted sessions.
- Rotation delivery is one-time and manual. If the new token is lost, rotate again from a
  healthy operator session; do not attempt to recover it from the journal.
- Revocation is permanent. Pruning retired digests would reopen replay, so it is not offered.
- Session state is single-process, like the rest of the journal. Multi-host replication and
  external audit custody are not implemented (F-009).
- This surface does not change the independent verifier's identity or authorization rules. An
  executor session cannot administer sessions, and rotating or revoking an executor session
  cannot make the verifier accept an executor self-report.
