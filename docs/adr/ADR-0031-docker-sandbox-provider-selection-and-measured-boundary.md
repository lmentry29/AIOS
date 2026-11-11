# ADR-0031 — Docker Sandbox Provider Selection and Measured Boundary

## Status

**Accepted** (2026-11-11). This ADR adds an explicit, measured Docker container provider. It
supersedes the "Docker unverified" clauses of ADR-0019, ADR-0027, and ADR-0028 for the
measured path. It does not make Docker a VM boundary, does not make rootless Docker measured,
and does not change bubblewrap's status as the default Linux provider.

## Context

ADR-0019 accepted Docker as a production provider shape but required a daemon and a locally
present image. The adapter had only argv-construction tests: the validation host could not
reach `/var/run/docker.sock`, so the sandbox matrix and F-006 correctly said **unverified**.
That left the strongest aggregate-resource path unmeasured and made "Docker is supported"
an unsupported claim.

The operating contract now requires a selected provider to prove its boundary before the
workload starts, to fail closed if the daemon or controls are unavailable, and to use the
same executor, durable execution ledger, and independent verifier as bubblewrap. A separate
code path that merely launched `docker run` would not satisfy that contract: the daemon's
actual controls must be inspected before execution.

## Decision

1. **Selection is explicit and operator-owned.** The host config may select `provider:
   docker` together with a locally present `image`. Linux `provider: auto` continues to
   select bubblewrap; it does not silently prefer an installed Docker daemon. A requested
   Docker provider with no image is a configuration error, and a requested provider whose
   daemon, image, or probe fails makes local execution unavailable. There is no bare-process
   or bubblewrap fallback after a Docker failure.

2. **The daemon, not the image, supplies the proof.** The provider creates a named container
   with `docker create`, inspects the daemon's reported `HostConfig`/`Mounts`/`Config`,
   and starts it with `docker start --attach` only after the required controls and a
   non-default seccomp profile are present. `docker run` is not used. This makes the evidence
   available before the workload executes and leaves the container name available for
   deterministic cleanup. Docker does not expose the client-side seccomp source path or its
   digest in `HostConfig.SecurityOpt`; the daemon is trusted for the active-profile report,
   and the generated profile digest is bound in the recorded filter evidence.

3. **The enforced boundary is:**
   - read-only container root filesystem;
   - one writable bind of the per-run workspace at `/workspace`, with a relative workdir
     that cannot escape it;
   - `--network=none` with no host network namespace;
   - `--cap-drop=ALL` and `--security-opt=no-new-privileges`;
   - a generated custom seccomp profile installed by path, using the same syscall
     deny-list and architecture guard as bubblewrap, with `SCMP_ACT_KILL` for denied calls;
   - cgroup v2 `--memory=512 MiB` with `--memory-swap=512 MiB`, `--cpus=1`, and
     `--pids-limit=128`;
   - a deadline-aligned `--ulimit cpu=<ceil(timeout_ms/1000)>`;
   - the host UID/GID as the container user, a sanitized `PATH`/`HOME`/`TMPDIR`, and only
     the Task's allowlisted environment entries;
   - a size-bounded `/tmp` tmpfs and no other writable host path.

4. **Unsupported controls are not faked.** Docker's CLI rejects `--ulimit as`, so this
   provider does **not** claim a per-process `RLIMIT_AS`. The cgroup memory limit is the
   measured aggregate memory boundary. `--ulimit cpu` remains the deadline-aligned
   per-process CPU control. This is an honest difference from bubblewrap's `RLIMIT_AS`.

5. **Evidence is a precondition, not a log line.** `LocalCommandExecutor` and
   `LocalCommandVerifier` require both `filter.applied` and `limits.applied` for Docker,
   exactly as they do for bubblewrap. Missing seccomp evidence raises
   `SandboxFilterUnavailableError`; missing/mismatched limits raise
   `SandboxResourceLimitUnavailableError`. The verifier records its own provider evidence and
   rejects its own failed proof instead of accepting executor prose.

6. **Cleanup covers every exit path.** A unique container name is created before execution.
   Normal exit, timeout, cancellation, quota abort, and provider errors all issue
   `docker kill` and `docker rm --force` in `finally`. A CLI death is not treated as proof
   that the container died.

7. **The same production path is measured.** The existing 21-case
   `tools/security/adversarial-drill.mjs` accepts `AIOS_SANDBOX_PROVIDER=docker` and
   `AIOS_DOCKER_IMAGE`. It uses the real `createSandboxProvider`, `LocalCommandExecutor`,
   `ManagedExecutionPort`, durable `ExecutionLedger`, and `LocalCommandVerifier`; no test
   double substitutes for sandboxing or verification. The Security workflow builds the
   reproducible image and runs this drill as a required plain `run:` step. A failing case
   fails the job.

## Threat-model delta

Docker adds an aggregate cgroup boundary and a read-only container root filesystem that
bubblewrap does not provide. It also adds a privileged daemon and an image as trusted
operational dependencies. The daemon is outside the workload boundary and is a higher-value
compromise target than a single sandboxed process. The container still shares the host
kernel; Docker is a container boundary, not a VM or a gVisor-class isolation layer.

Bubblewrap remains the Linux default because it needs no daemon, no image pull, and no
privileged service, and it runs unprivileged with user namespaces. Docker is the opt-in
choice when aggregate cgroup accounting and a container rootfs are required and the operator
accepts the daemon/image cost. The host never silently downgrades from one to the other.

## Measured evidence

- Code head `40438a5`; Security run `42943242036`, live job `130269803337`, Docker step 13:
  **success**, provider `docker`, kernel `7.0.0-1017-azure`, custom-seccomp SHA-256
  `87ae93a78692f192bb8272a9398bafe21c864dce3cf8d79f2f96a0313a7a1214`,
  **21/21 cases denied or contained**, final result `all adversarial cases denied or
  contained`.
- The same head's `ci` (run `42943242089`), `conformance` (run `42943242041`), `schema-check`
  (run `42943242116`), and supply-chain job `130269803066` were green.
- Two earlier CI heads failed closed at the Docker probe and were repaired: `dbee5c7`
  rejected `--ulimit as` with `invalid ulimit type: as`; `75f7371` rejected the bare `rw`
  mount field with `invalid field 'rw' must be a key=value pair`.
- The local validation host still cannot reach a Docker daemon:
  `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`.
  The measured result is CI-only; it is not a local success.

## Residual differences and operational cost

| Difference | Consequence |
|---|---|
| Rootless Docker was not measured | The CI runner's daemon mode was not separately asserted. Rootless daemon installation, subuid/subgid mapping, and rootless cgroup delegation remain unverified. |
| Docker CLI has no `RLIMIT_AS` | Bubblewrap retains a per-process 1.25 GiB address-space cap. Docker relies on the 512 MiB aggregate memory cgroup; a process can use more virtual address space when the cgroup has room. |
| Rootful/rootless daemon trust | A daemon compromise or malicious daemon can lie about inspected controls. Docker does not expose the client-side seccomp source path or digest in `HostConfig.SecurityOpt`; the daemon's active-profile report and the generated digest are separate evidence. The daemon must be treated as a trusted host component, not as part of the workload boundary. |
| Image supply chain | The CI builds a local `aios-sandbox:local` image from `debian:bookworm-slim`; it is not signed, attested, or pinned by digest in this pass. Operators must build and pin their own trusted image. |
| Shared kernel | Docker is not a VM boundary. Kernel exploits and host cgroup/namespace bugs remain in scope. |
| Case 1 image detail | The drill image removes `/etc/shadow`; case 1 therefore proves the container rootfs has no host credential file, not that a host `/etc` bind is inaccessible. The workspace bind is still the only host data mount. |
| Disk quota | The per-run workspace limit remains the host executor's 25 ms sampler, not a hard filesystem quota. Docker does not change that. |
| CPU termination | The burner is terminated by the deadline (`SIGKILL` in the measured run), not necessarily by a distinct `SIGXCPU`; the exact `--ulimit cpu` value is separately probed. |
| Image build/pull | The provider never pulls implicitly; an operator must build or pull the image and accept the maintenance and update cost. |

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `docker run` directly | No pre-execution inspection of the daemon's actual controls, and no named handle for deterministic cleanup. |
| Treat argv tests as Docker validation | F-006's exact fake-success failure; it proves syntax only, not isolation. |
| Use Docker as Linux `auto` default | Adds a daemon, image, and privileged service requirement to every host; bubblewrap is smaller and unprivileged. |
| Fall back to bubblewrap when Docker fails | Silently changes the selected boundary; the contract requires fail-closed behavior. |
| Claim `--ulimit as` support | Docker rejects it; claiming the flag would be fabricated coverage. |
| Treat a custom seccomp option as sufficient | The evidence now matches the exact generated profile path reported by the daemon. |

## Consequences

- Docker is a first-class, explicitly selectable provider with measured filesystem, secret,
  network, capability, resource, cleanup, and verifier cases.
- F-006 is closed for the measured CI path; rootless Docker, image provenance, rootful daemon
  trust, and VM-class isolation remain open or explicitly accepted.
- Bubblewrap remains the default and its assertions, limits, and drill are unchanged.
- The Docker image and CI job are now part of the security maintenance surface: Docker engine
  updates, image rebuilds, cgroup behavior, and runner changes must be re-drilled.
