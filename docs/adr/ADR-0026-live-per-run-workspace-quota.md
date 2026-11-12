# ADR-0026 — Live Per-Run Workspace Quota Enforcement

## Status

**Accepted** (2026-11-10). Adds a host-enforced per-run workspace ceiling to the execution
lifecycle. It does not change the authorization model or claim a filesystem-level hard quota.

## Context

The execution boundary isolated the filesystem, network, PID namespace, and capabilities, but
a workload could write unbounded data into its writable run workspace and exhaust the host
filesystem before its deadline. A post-run size check detects the damage after it happens; it
does not protect the host. F-004 required enforcement while the run is live.

A true disk quota needs a block device or filesystem with project/user quotas, a loop device,
or a mount the host controls. This environment runs unprivileged without `CAP_SYS_ADMIN`, loop
devices, or a usable container daemon, and bubblewrap exposes no `--size` for a bind-mounted
workspace. The strongest available unprivileged control is therefore host-side measurement of
the real workspace while the sandbox is running, coupled with the existing process-group kill.

## Decision

1. **Live sampling in the real execution path.** `LocalCommandExecutor` wraps the provider
   invocation with `WorkspaceQuotaGuard`. It measures the actual per-task workspace every
   25 ms and once more after the provider returns. It never relies on a test-only helper.
2. **Abort, not a post-run report.** Crossing `execution.workspace_max_bytes` aborts the
   provider's signal. The provider kills the whole sandbox process group, then the executor
   raises `WorkspaceQuotaExceededError`. A measurement failure also aborts and fails closed;
   an unmeasured run is never treated as capped.
3. **Discard the oversized workspace.** The manager removes the failed task workspace after an
   over-cap or unmeasurable run, so oversized or partial output is neither retained nor
   available for later ingestion.
4. **Durable, distinct failure.** `ManagedExecutionPort` maps the error to the reason code
   `disk_quota_exceeded` in the hash-chained execution ledger. The verifier binds a rejection
   to the exact failed execution ID, attempt, and evidence digest; a failed quota run can never
   be presented as a completed or accepted result.
5. **The verifier is capped too.** `LocalCommandVerifier` applies the same guard to its own
   command. Over-cap verification output is stopped, its workspace discarded, and the decision
   is rejected without accepting or ingesting artifacts.
6. **Bound the other writable path.** The bubblewrap `/tmp` tmpfs is capped at 64 MiB with
   `--size 67108864`; it is not part of the workspace measurement.
7. **Configuration.** `execution.workspace_max_bytes` defaults to 256 MiB and is constrained
   to an integer between 1 KiB and 8 GiB. The ceiling is per run/task; separate runs receive
   separate workspaces and are measured independently.

## Consequences

- The host now stops a continuously writing workload during execution rather than after the
  timeout, and journals a non-forgeable quota failure. The live drill observed the over-cap
  run stopped, its workspace removed, and zero matching sandbox processes.
- This is **sampling enforcement**, not a kernel hard quota. A writer that produces data faster
  than the 25 ms measurement interval can overshoot the limit before the abort takes effect;
  the final sample and discard bound the retained state but do not undo that transient write.
  The documented ceiling is the enforcement threshold, not a guarantee that no byte beyond it
  was ever written.
- The walk uses `lstat` and skips symlinks; hardlinks are counted once per name (conservative),
  and files outside `/workspace` are not attributed to the run. `/tmp` is separately bounded
  at 64 MiB, but other tmpfs paths remain outside this accounting.
- A per-run cap does not bound aggregate host usage across concurrent runs; the managed
  concurrency limit bounds the number of simultaneous workspaces.
- Docker's workspace bind has the same host-side guard, but the Docker adapter itself remains
  unverified on this host. A future privileged deployment can replace sampling with a real
  filesystem/block quota without changing the durable reason or verifier binding.

## Verification

- `apps/host/tests/workspace-quota.test.ts` covers measurement without symlink traversal,
  live over-cap abort and discard, under-cap and per-run independence, the durable
  `disk_quota_exceeded` reason with verifier binding, and verifier rejection of over-cap
  output.
- `apps/host/tests/workspace-quota-live.test.ts` runs against real bubblewrap: an over-cap
  continuously-writing run is stopped with no leaked marked process and no retained workspace;
  under-cap and sequential runs complete in independent workspaces.
- `tools/security/workspace-quota-drill.mjs` executed the same lifecycle against the built
  host and is recorded verbatim in `docs/security/validation-ledger.md`.
