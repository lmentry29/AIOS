# ADR-0028 — Bubblewrap Per-Run Resource Limits

## Status

**Accepted** (2026-11-10). Closes F-003's unbounded-memory gap on the bubblewrap path. It
does not add cgroup aggregate accounting, and it does not make Docker, Seatbelt, gVisor, or
Apple Containerization verified.

## Context

ADR-0027 added a generated seccomp deny-list to every bubblewrap invocation. The boundary
still had no CPU, memory, or process-count ceiling: the run deadline and process-group kill
bound wall-clock time, but a workload could allocate memory or fork children as fast as the
host allowed until that deadline. F-003 recorded this as a Medium risk for local
single-operator use.

On the validation host (`Linux 6.1.102 x86_64`, `bwrap 0.9.0`, unprivileged UID), bubblewrap
has no `--rlimit` option, and unprivileged cgroup v2 delegation is not available. The host
does have util-linux `prlimit` 2.39.3 at `/usr/bin/prlimit`, which can install limits before
exec and is already inside the read-only `/usr` bind. A shell `ulimit` was rejected because
`/bin/sh` is dash here and its `ulimit` has no process-count (`-u`) option.

## Decision

1. **Install limits before the task argv.** The bubblewrap invocation now starts:
   `/usr/bin/prlimit --as=1342177280 --cpu=<ceil(timeout_ms/1000)> --nproc=128 -- /bin/sh -c <fixed wrapper> ...`.
   `prlimit` is a trusted host binary, runs inside the same namespace and seccomp filter, and
   execs the fixed wrapper only after all three limits are installed. The task argv is still
   executed with `exec "$@"`, never interpolated into a shell string.
2. **Use per-process kernel limits, not a test-only helper.** `RLIMIT_AS` is 1.25 GiB
   (`1342177280` bytes), `RLIMIT_CPU` is the run deadline rounded up to whole seconds with a
   one-second minimum, and `RLIMIT_NPROC` is 128. A 1 GiB address-space ceiling was rejected
   because a bare Node/V8 process could not initialize under it on this host; the cap preserves
   that observed headroom. (The full bubblewrap path independently blocks Node's io_uring probe;
   see the compatibility residual below.)
3. **Prove installation before exec.** After `prlimit` succeeds, the fixed wrapper reads
   `/proc/self/limits` and requires the exact `Max address space`, `Max cpu time`, and `Max
   processes` values, and still requires `Seccomp: 2`. It writes
   `seccomp=applied limits=applied` to the inherited marker fd, closes the inherited
   descriptors, and only then execs the task. A missing or mismatched proof denies the run.
4. **Fail closed with a distinct reason.** `BubblewrapSandbox.check()` preflights
   `/usr/bin/prlimit`; a missing binary or failed limit proof is a resource-limit failure.
   The executor raises `SandboxResourceLimitUnavailableError`, the managed lifecycle journals
   `sandbox_resource_limit_unavailable`, and the verifier rejects both that durable failed
   attempt and any verification run without its own limit proof. Successful executor and
   verifier evidence records `resource_limit_memory_bytes`, `resource_limit_cpu_seconds`,
   `resource_limit_processes`, and `resource_limits_applied:true`.
5. **Preserve the existing guarantees.** The same invocation keeps `--unshare-all`,
   `--cap-drop ALL`, the read-only system binds, the per-run workspace bind, the 64 MiB
   `/tmp` tmpfs, `--clearenv`, the seccomp filter and its proof, process-group cleanup, the
   live workspace quota sampler, and independent verification. None of those controls is
   replaced by `prlimit`.

## Consequences

- A workload that tries to allocate without bound now receives an allocation failure
  (`perl` reports `Out of memory!`, exit 1) instead of consuming host memory until the run
  deadline. The recorded drill observed exit 1 with `timed_out:false`, while the ordinary
  interpreter run and the existing seccomp and quota suites still passed.
- This is **per-process**, not cgroup aggregate, enforcement. Every descendant inherits the
  same limits, but N descendants can each use up to 1.25 GiB of address space and the sum is
  not capped; `RLIMIT_NPROC` bounds the process count to 128. CPU limits are similarly
  per-process, so a multi-process workload can consume more aggregate CPU than the deadline
  alone suggests. A cgroup v2 implementation remains the correct next layer for hostile
  multi-tenant use and is not available unprivileged on this host.
- `RLIMIT_AS` limits virtual address space, not resident memory. A process can reserve address
  space without touching all of it; the cap still bounds the virtual allocation that a memory
  bomb can obtain, but it is not an RSS or memory-pressure control.
- The bubblewrap path now depends on `/usr/bin/prlimit` and a readable `/proc/self/limits`
  inside the trusted system bind. If either is absent, the provider fails closed with a
  resource-limit error rather than running without limits.
- **Known compatibility residual (F-007):** the existing seccomp profile kills
  `io_uring_setup` with `SIGSYS`. Node/libuv probes io_uring at startup and is therefore
  killed with bwrap status 159 before it can run a task. This drill uses Perl, which does not
  probe io_uring. The filter was not weakened in this change; a future filter policy should
  decide deliberately between `ENOSYS` for io_uring (to allow libuv fallback while still
  denying the interface) and the current `KILL_PROCESS` behavior.
- Docker's cgroup flags remain **unverified** because no daemon was reachable; gVisor,
  Seatbelt, and Apple Containerization remain **unverified/unavailable**.

## Verification

`apps/host/tests/sandbox-live.test.ts` now records the exact kernel limits and Seccomp mode,
runs an ordinary Perl process, and drives a Perl memory bomb under real bubblewrap;
`apps/host/tests/seccomp.test.ts` covers the distinct missing-limit executor/verifier
rejections. `tools/security/resource-limit-drill.mjs` records the provider evidence and drill
output in `docs/security/validation-ledger.md`. The 21-case
`tools/security/adversarial-drill.mjs` additionally exercises CPU/PID exhaustion, orphan
cleanup under cancellation and timeout, and the surrounding filesystem/network/capability
boundary; it is a required step in the Security workflow, and a non-zero probe failed that
job before the real drill passed. The pre-existing 9-case boundary suite, the 3 seccomp
cases, and the 2 quota cases are run in the same live suite.
