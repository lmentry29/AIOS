# ADR-0032 — gVisor Provider and Cross-Provider Selection

## Status

**Accepted** (2026-11-11). This ADR adds an explicit, measured gVisor `runsc` provider and
records the cross-provider selection rule for bubblewrap, Docker, and gVisor. It supersedes
the "gVisor unverified" clauses of ADR-0019, ADR-0027, ADR-0028, and ADR-0031 for the measured
path. Bubblewrap remains the Linux default. It does not make gVisor a VM boundary, does not
make the operator-supplied rootfs a signed image, and does not change any bubblewrap or Docker
assertion, flag, permission, action pin, timeout, or severity.

## Context

The sandbox matrix previously listed gVisor as "not integrated": no adapter, no measured
`runsc` configuration, and no CI path. The host already had three real providers with one
contract: the selected provider must prove its boundary before workload execution, fail closed
when its probe fails, and run through the same executor, durable execution ledger, managed
port, and independent verifier as every other provider. Adding a separate "gVisor path" that
merely launched a process would not satisfy that contract.

gVisor's boundary is materially different from bubblewrap and Docker. `runsc` runs the
application against a user-space kernel (the Sentry) rather than the host kernel. That reduces
the workload's direct host syscall surface, but it adds an operator-supplied runtime binary and
OCI rootfs, and it does not make the sandbox a virtual machine. Rootless gVisor also has
documented limitations: the built-in `--rootless` path is mainly for `runsc do`, uses a single
UID mapping, does not support netstack, and does not support save/restore. `runsc do` mounts
the host rootfs read-only and is explicitly a test convenience, so it is not an acceptable
production boundary.

## Decision

1. **Selection is explicit and operator-owned.** The host accepts `provider: gvisor` only with
   an absolute, real, non-symlink `rootfs` directory. `provider: docker` requires `image`.
   Linux `provider: auto` continues to select bubblewrap; it never silently selects Docker or
   gVisor. A requested provider whose binary, rootfs, or probe fails makes local execution
   unavailable. There is no bare-process or alternative-provider fallback.

2. **The gVisor boundary is a generated OCI bundle, not `runsc do`.** For every invocation the
   provider:
   - writes a unique `config.json` with a read-only configured rootfs;
   - runs `runsc --root=<private-state> --rootless --network=none run --bundle ...`;
   - exposes exactly one writable host bind at `/workspace`, with a relative cwd validated to
     stay inside it;
   - uses private PID, network, IPC, UTS, and mount namespaces; the workload has PID 1;
   - sets empty bounding/effective/inheritable/permitted/ambient capability sets and
     `noNewPrivileges: true`;
   - installs OCI `RLIMIT_AS` 512 MiB, deadline-aligned `RLIMIT_CPU`, `RLIMIT_NPROC` 128, and
     `RLIMIT_NOFILE` 1024;
   - provides only `PATH`, `HOME`, `TMPDIR`, and the Task's allowlisted environment; host
     environment values are not inherited;
   - uses private `/proc`, `/dev`, `/tmp`, and read-only `/sys` mounts, with standard masked
     and read-only proc/sys paths.

3. **The proof is distinguishable from a seccomp claim.** gVisor is a user-space kernel, not a
   host seccomp filter. The provider records a `gvisor-sentry` boundary with the runtime
   version, rootless mode, and applied flag only after `runsc` successfully starts the sandbox.
   It does not fabricate a `filter` object or reuse bubblewrap/Docker filter evidence. The
   executor and verifier require `boundary.applied` for gVisor; missing proof raises
   `SandboxIsolationUnavailableError`, journals `sandbox_isolation_unavailable`, and is rejected
   by the independent verifier. Bubblewrap and Docker continue to require their existing
   filter and limit evidence. Resource limits use the separate `gvisor-oci-rlimit` mechanism.

4. **Cleanup covers every exit path.** The provider uses a private `runsc --root` state
   directory and a unique container name. Normal exit, timeout, cancellation, quota abort, and
   provider error all attempt `runsc kill --all` followed by `runsc delete --force` in `finally`,
   then remove the generated bundle and state. A killed `runsc` client is not treated as proof
   that the Sentry or workload died.

5. **The same production drill is measured.** `tools/security/adversarial-drill.mjs` accepts
   `AIOS_SANDBOX_PROVIDER=gvisor` and `AIOS_GVISOR_ROOTFS`, and uses the real
   `createSandboxProvider`, `LocalCommandExecutor`, `ManagedExecutionPort`, durable
   `ExecutionLedger`, and `LocalCommandVerifier`. The Security workflow installs a
   checksum-verified, pinned gVisor release, exports a controlled Debian rootfs from the same
   Docker image used by the Docker drill, and runs the drill as a plain `run:` step. A failing
   case fails the job. The bubblewrap and Docker steps, assertions, pins, and timeouts remain
   untouched.

6. **The Docker engine claim is now measured too.** Docker's availability probe reads
   `docker info --format '{{json .}}'` and records `ServerVersion`, the daemon
   `SecurityOptions`, and a rootless/rootful classification (`name=rootless` when present;
   unknown if the daemon exposes no options). The measured CI daemon was Docker `28.0.4`,
   **rootful** (`rootless:false`; `name=apparmor`, `name=seccomp,profile=builtin`,
   `name=cgroupns`). Rootless Docker remains unmeasured.

## Threat-model delta

gVisor moves the application's syscall interface into the Sentry instead of executing it on the
host kernel. A successful workload compromise is therefore not directly a host-kernel
compromise; it is a Sentry compromise plus whatever host syscalls the Sentry/gofer make. This is
a smaller host-kernel attack surface than bubblewrap or Docker, but it is not a VM boundary:
the Sentry runs on the host kernel, and a gVisor or host-kernel vulnerability may cross the
boundary. The operator must trust `runsc` and the supplied rootfs at least as much as the Docker
daemon/image in the Docker provider.

The gVisor boundary also has different operational costs: a runtime binary and sidecar
`gvisor-bin/` directory, a separately built and maintained rootfs, rootless single-UID
constraints, no netstack in the measured `--network=none` configuration, and no host cgroup
accounting for the workload. Resource limits are OCI rlimits enforced by the Sentry, not a host
cgroup; disk remains the executor's 25 ms workspace sampler. Rootfs provenance is operator-owned
and is not signed or digest-attested in this pass.

## Measured evidence

### CI

- Code head `54344f1`; Security run `42946929104`, live job `130281855560`:
  - Docker image build step 12, Docker drill step 13: **success**; provider `docker`, engine
    `28.0.4`, rootless `false`, kernel `7.0.0-1017-azure`, **21/21** cases denied or contained.
  - Pinned gVisor install step 14, controlled OCI rootfs export step 15, gVisor drill step 16:
    **success**; provider `gvisor`, `runsc release-20261102.0`, rootless `true`, same kernel,
    **21/21** cases denied or contained.
  - Bubblewrap live tests, resource-limit drill, and bubblewrap adversarial drill steps 9–11
    also passed on the same head.
- The same head's CI run `42946929409`, Conformance run `42946929289`, and Schema Check run
  `42946929280` were green.

### Local

- Uncached workspace gate: **46/46** tasks, **0 cached**; host tests **158 passed / 17 skipped**
  (the skips are live suites without a provider environment).
- Bubblewrap live suite **17/17**; bubblewrap adversarial **21/21**; resource-limit drill exit
  **0**; bubblewrap filter SHA-256
  `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`.
- gVisor adversarial **21/21** against a local minimal, controlled 67 MiB rootfs with
  `/etc/shadow` absent and no host-root bind. The local and CI rootfs differ in provenance
  (local selected host binaries/libraries; CI Debian image export), but both exercise the same
  production provider and drill.
- The local Docker daemon remains unreachable
  (`permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`);
  Docker remains CI-measured only.

### Per-case gVisor observations (CI)

| # | Case | Observed denial/containment |
|---|---|---|
| 1 | Host file read | exit 1; no shadow content; controlled OCI rootfs, no host bind |
| 2 | Path traversal | exit 1; no shadow content |
| 3 | Symlink chain | exit 1; `stderr_sha256 f4519b2c…` |
| 4 | Hardlink to host file | `rc=1`; no host-file link |
| 5 | cwd traversal | rejected before spawn |
| 6 | Writes outside workspace | exit 2; no `wrote:` marker; paths absent |
| 7 | Host environment secret | absent from env and `/proc/self/environ`; only `LANG=C` |
| 8 | Host `/tmp` secret | secret absent through all path tricks |
| 9 | Host loopback TCP | exit 1; listener saw 0 connections |
| 10 | Raw socket | exit 2; no success output |
| 11 | Capabilities/mount/chroot | `CapEff: 0`; mount probe exit 1 (EPERM, no survivor); chroot exit 125, `Operation not permitted` |
| 12 | CPU exhaustion | `timedOut:true`, `SIGKILL`, 3,007 ms; CPU 3 s, PID 128 |
| 13 | PID exhaustion | 127 children, 128 namespaced processes, 0 survivors |
| 14 | Cancellation orphan | `cancelled:true`; 0 marked survivors |
| 15 | Timeout orphan | `timedOut:true`; 0 marked survivors |
| 16 | Disk exhaustion (64 KiB) | quota error; 0 workspace entries; 0 survivors |
| 17 | Instruction smuggling | exact argv digest; 89-byte env literal; `safe`; hostile text absent |
| 18 | Forged executor result | rejected by durable evidence digest |
| 19 | Self-issued verification | rejected before running |
| 20 | Artifact tampering | verifier exit 1; rejected |
| 21 | Stale replay | stale attempt rejected; latest accepted |

The mount case needed a gVisor-specific probe correction: gVisor's Sentry denies `mount(2)` with
`EPERM` rather than killing the process, so the original probe printed `mount-survived`
unconditionally even though the syscall returned `-1/EPERM`. The gVisor branch now checks the
return value, exits 1 on denial, and still prints the marker only on a successful mount. No
bubblewrap or Docker probe/assertion was changed, and no case was relaxed to accept a successful
mount.

## Residual differences and operational cost

| Difference | Consequence |
|---|---|
| Rootless single UID | `runsc --rootless` maps only the caller's UID; multi-UID image contents and the full Docker/Podman rootless stack are not measured. |
| No netstack | The measured configuration uses `--network=none`; external networking is intentionally absent. |
| OCI rlimits, no host cgroup | The Sentry enforces `RLIMIT_AS`, CPU, NPROC, and NOFILE; there is no aggregate host cgroup for the workload, and the executor still samples workspace usage every 25 ms rather than using a hard quota. |
| No custom seccomp claim | The gVisor boundary is the Sentry/OCI configuration. The provider does not claim a host seccomp filter; `mount` was observed denied with `EPERM`, and the gVisor OCI seccomp action tested for process-kill was rejected by `runsc` as unsupported. |
| Runtime/rootfs supply chain | `runsc` is downloaded from a pinned release with a SHA-512 check; the rootfs is operator-supplied from a local minimal build or a Debian image export. Neither is signed or digest-attested by this repository. |
| Shared host kernel | gVisor is not a VM. The Sentry and gofer make host syscalls; a Sentry or host-kernel vulnerability remains in scope. |
| CPU termination | The burner ended by the provider deadline (`SIGKILL`), not a distinct `SIGXCPU`; the OCI CPU rlimit value was separately probed. |
| Case 1 image detail | The rootfs removes `/etc/shadow`; case 1 proves the controlled rootfs lacks that credential file, not that a hostile operator-supplied rootfs is trustworthy. |
| Legacy/macOS | Seatbelt remains deprecated and unverified; Apple Containerization remains unavailable and unverified. |

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Use `runsc do` | It mounts the host rootfs read-only and is explicitly a test convenience; it does not satisfy the filesystem threat model. |
| Run gVisor rootful | It would make the runtime root and weaken the measured unprivileged claim; the host can run rootless here. |
| Treat gVisor as a host seccomp provider | gVisor is a user-space kernel; borrowing bubblewrap/Docker filter evidence would be fabricated coverage. |
| Make gVisor the Linux default | Adds a runtime binary, rootfs supply chain, rootless constraints, and compatibility/performance costs; bubblewrap remains the smallest unprivileged default. |
| Fall back to bubblewrap when gVisor fails | Silently changes the selected boundary; the provider contract requires fail-closed behavior. |
| Claim Docker rootless or image provenance from this run | The measured daemon was rootful `28.0.4`; rootless Docker and signed/digest-pinned images remain unverified. |

## Consequences

- gVisor is a first-class explicit provider with a measured 21-case production path, per-case
  evidence, fail-closed selection, and cleanup.
- The Docker row now states the measured engine (`28.0.4`) and daemon mode (**rootful**); the
  earlier unstated-daemon residual is closed, while rootless Docker remains open.
- Bubblewrap remains the Linux default because it is the simplest unprivileged boundary here,
  with no daemon, image, or external runtime/rootfs. Docker is the aggregate-cgroup/container
  option. gVisor is the opt-in user-space-kernel option for operators who accept its runtime and
  rootfs cost.
- The gVisor CI step is part of the security maintenance surface: `runsc` release updates,
  rootfs rebuilds, Sentry behavior, and GitHub-runner kernel changes must be re-drilled.
