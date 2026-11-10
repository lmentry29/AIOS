# ADR-0019 — Execution Isolation, Fixed Grant, and Verifier Trust

## Status

**Accepted** (2026-11-10). This ADR ratifies the execution contract implemented in
`apps/host/src/execution/`. It does not claim that every platform has a usable isolation
provider, and it does not authorize arbitrary shell or host execution.

## Context

The host previously had no production `AgentExecutionPort`; dispatch failed closed. The
orchestration kernel requires a distinct verifier identity and evidence, but a distinct
UUID alone is not independence: the executor could self-report success, and the verifier
could simply echo the executor's strings. The blueprint requires a fixed grant for the
first local slice and explicitly rejects a subprocess as a security boundary.

## Decision

1. **The first grant is fixed `local.exec`.** A Task carries a narrow `local_command`
   execution intent: an argument vector, relative cwd, bounded timeout/output, and an
   allowlisted environment. The requester cannot choose a provider, image, shell, model,
   or verifier.
2. **Argument vectors only.** The host never interpolates a shell command. Providers
   receive `argv` and spawn without a shell. `cwd` must resolve inside a per-run workspace;
   absolute paths and `..` escapes are rejected.
3. **Isolation is a prerequisite, not an implementation detail.** Production execution is
   available only through:
   - Docker: no network, read-only root, writable workspace only, dropped capabilities,
     no-new-privileges, PID/memory/CPU limits, non-root user;
   - Linux bubblewrap: unshared namespaces, no network, read-only system, writable
     workspace;
   - macOS Seatbelt: deny-default profile, no network, workspace-scoped writes.
   A bare child process, an in-process `eval`, or a test double must never be presented as
   a security boundary. If no provider passes its probe, the host advertises dispatch as
   disabled and returns 503; it does not fall back.
4. **Bubblewrap is honestly labelled.** It is a kernel-namespace boundary without cgroup
   accounting or a seccomp profile. It is trusted-local hardening, not a VM or a complete
   untrusted-code boundary. The stronger Docker path is preferred when configured.
5. **The verifier is independent in identity and execution.** The host configures a
   verifier UUID distinct from the executor. The verifier runs its own command in a fresh
   sandbox invocation against the same workspace, and its decision is based on that
   command's actual exit status—not on executor prose.
6. **Evidence is bounded and hashed.** The executor records provider, assurance, argv/cwd
   digests, stdout/stderr digests, exit code, duration, and truncation. It does not copy
   raw output into the journal. The verifier binds the executor result by digest and
   records its own command/output hashes. The kernel commits completion only after the
   verifier accepts.
7. **Failure never becomes success.** Non-zero exit, timeout, spawn failure, malformed
   result, missing verification intent, unavailable provider, or a verifier equal to an
   executor leaves the Task unverified and suspends the run.
8. **No secret channel.** Task environment is allowlisted (`LANG`, `LC_*`, `TZ`,
   `AIOS_*`). Provider credentials must not be passed through a Task, and raw stdout is
   not evidence.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Run a child process with `shell: true` | No boundary; shell injection and host access. |
| Let each Task name a sandbox provider | Provider selection is a host/capability decision, not requester input. |
| Treat the verifier UUID as proof of independence | Identity is necessary but not sufficient; the verifier must execute its own check. |
| Accept executor stdout as verification | Self-attestation; untrusted output and no independent evidence. |
| Return `success: true` when no provider exists | The exact fake-success failure mode the project forbids. |

## Consequences

- Local execution is unavailable on hosts without Docker, bubblewrap, or Seatbelt; that is
  visible in `/health` and is a supported state, not a bug.
- Docker requires a pre-pulled image; the host never pulls one implicitly.
- Bubblewrap/Landlock/seccomp hardening, retry/backoff, and resource accounting beyond the
  provider limits remain follow-up work. Cancellation, bounded concurrency, and restart
  reconciliation of Task executions are implemented under ADR-0021.
- A signed verifier decision is not yet implemented. The current trust anchor is the
  host-configured verifier principal plus an actual independent command; a future ADR must
  add key distribution/rotation before claiming cryptographic verifier provenance.
- Coordination (`coordinate()`) is not implemented by the local adapter. It fails rather
  than pretending that one command coordinated multiple Agents.

## Amendment (2026-11-10) — execution lifecycle

ADR-0021 extends this ADR without weakening its isolation or verifier trust model. It adds:

- a per-Task durable execution ledger, separate from dispatch runs;
- an exact `cancel` authorization action and `POST /v1/tasks/:taskId/cancel`;
- `AbortSignal` propagation into every provider so cancellation kills the child (Docker also
  kills its named container explicitly);
- a strict `execution.max_concurrent_tasks` cap (1–32, default 1) with deterministic 429
  rejection before lifecycle writes; and
- startup reconciliation that marks running executions `interrupted` and suspends affected
  Workflows/Tasks exactly once.

A cancelled execution still cannot be marked complete by a late executor result, and the
verifier is skipped when cancellation is observed before verification starts. The production
sandbox providers remain unverified on this host; the test-only process provider and sandbox
stub are explicitly non-isolating.

## Tests / evidence

`apps/host/tests/execution.test.ts` covers argv/no-shell, environment filtering, hashed
evidence, non-zero/timeout/unavailable failure, cwd escape rejection, verifier independence,
unexpected verification exit, executor-result digest binding, and Docker command
construction via a fake CLI (flags/argv only; not real isolation). `config.test.ts` rejects
same-agent/verifier identities, unsafe images, and unsupported providers.
`http-host.test.ts` proves dispatch remains 503 and lifecycle state unchanged when no
adapters are configured, and dispatches through the real executor/verifier pair with a
clearly labelled test-only sandbox. It also covers authorized/denied cancellation, skipped
verification, cap rejection, and crash/restart reconciliation; see ADR-0021 for the exact
property-to-test mapping.
