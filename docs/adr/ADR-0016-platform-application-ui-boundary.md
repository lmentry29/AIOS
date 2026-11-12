# ADR-0016 — Platform, Application, and UI Boundary

## Status

**Accepted** (2026-11-10). This ADR ratifies a boundary the implementation already
enforces; it does not authorize a browser client or a second authorization path.

## Context

The repository had no UI and `apps/host` rejected every request carrying an `Origin`
header. That was a deliberate fail-closed posture, but the boundary was not stated as an
architectural decision: it was possible to read the nine `@aios/*` packages as a product
surface and the host as an optional test harness. The blueprint requires a personal AI
operating system with applications on top, while preserving one trusted authorization and
persistence boundary.

## Decision

1. **`packages/*` are the platform domain.** They contain canonical schemas, domain
   services, ports, and deterministic in-process implementations. They do not listen on a
   socket, render UI, own a session, or read provider credentials.
2. **`apps/host` is the trusted local application/composition root.** It owns loopback
   binding, session authentication, policy evaluation, durable operational state, run
   leases, execution isolation, verifier identity, and audit. A platform package must not
   create a second evaluator or bypass the host boundary to reach a provider.
3. **UI is an untrusted client of the host, not part of the trust boundary.** A future
   desktop or web UI may call only reviewed HTTP routes. It must never receive the host
   configuration, bearer-token digests, provider passwords, raw workspace paths, policy
   administration capability, or unrestricted execution controls.
4. **No browser origin is accepted today.** The host rejects any request with `Origin` so
   there is no CORS or CSRF surface to get wrong. Enabling a browser UI requires a
   separate ADR covering session cookies (including `Secure`/`__Host-` behavior on
   loopback), CSRF, origin allowlisting, and token storage. A bearer token placed in
   browser storage is not an acceptable substitute.
5. **Applications do not merge trust domains.** An application can request work through
   the host, but it cannot select an arbitrary sandbox provider, verifier, policy, or
   Agent identity. Provider selection and execution policy remain host-owned.
6. **Founder Intelligence stays outside this boundary.** The host never treats the
   operational journal, an application database, or a UI cache as the Obsidian vault.
   ADR-0014 remains authoritative.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Put HTTP and auth in `@aios/orchestration` | Would make a domain package a process boundary and duplicate the host's single-evaluator guarantee. |
| Treat the UI as trusted because it is local | Any local process can load a page; local origin does not establish user identity or CSRF protection. |
| Add permissive CORS so a UI can be built quickly | Would expose bearer-authenticated routes to cross-origin pages before a session design exists. |
| Let applications choose providers | Contradicts ADR-0012's capability-mediation direction and ADR-0019's fixed execution contract. |

## Consequences

- The host remains the only supported product surface until a UI ADR and client
  authentication design exist.
- A UI can be added incrementally without moving domain logic out of the packages.
- Until then, the absence of a UI is an explicit product limitation, not an invitation to
  weaken Origin checks.
- Tests must continue to assert that the host rejects cross-origin requests and does not
  expose local configuration.

## Tests / evidence

`apps/host/tests/http-host.test.ts` exercises real loopback HTTP and asserts:
cross-origin rejection, DNS-rebinding rejection, no policy-administration route, and no
configuration paths in `/health`. The host's route table is the reviewable inventory of
the current application surface.
