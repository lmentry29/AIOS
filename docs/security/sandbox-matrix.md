# Sandbox Provider Matrix

Primary sources checked 2026-11-10. Versions are the latest published at that date. The
"AIOS evidence" column is deliberately separate from the vendor claims. The Docker row was
measured on 2026-11-11 in the Security workflow.

| Provider | Boundary | Shares host kernel | Unprivileged operation | Resource limits | Network isolation | AIOS evidence |
|---|---|---|---|---|---|---|
| bubblewrap 0.13.1 | Namespaces + mounts + capability drop + generated seccomp deny-list; policy is caller-defined | Yes | Yes, user namespaces; setuid mode removed in 0.12.0 | Per-process `RLIMIT_AS` 1.25 GiB, `RLIMIT_CPU` aligned to the deadline, `RLIMIT_NPROC` 128 via `prlimit`; seccomp BPF deny-list; no cgroup aggregate/CPU/memory flags; `--size` bounds only the next tmpfs | `--unshare-net` / `--unshare-all` give loopback-only netns | **Validated** on Linux 6.1.102 with bwrap 0.9.0: 12/12 boundary/limit cases, 3/3 seccomp cases, 2/2 quota drills, the resource-limit drill, and 21/21 adversarial drill cases covering filesystem, secrets, network, capabilities, CPU/PID, orphans, quota, instruction smuggling, and forged/replayed verification (see validation ledger) |
| Docker Engine (GitHub-hosted runner; rootless mode not measured) | Container: namespaces, cgroups, custom seccomp, read-only rootfs, dropped capabilities, no-new-privileges | Yes | Opt-in daemon container; workload runs as host UID/GID (non-root); daemon access is an operator prerequisite | cgroup v2 `--memory` 512 MiB (equal `--memory-swap`), `--cpus` 1, `--pids-limit` 128; deadline-aligned `--ulimit cpu`; **no `RLIMIT_AS`**, because Docker's CLI rejects `--ulimit as` | `--network=none`; container loopback only | **Validated** in CI at `40438a5` (Security run `42943242036`, live job `130269803337`, step 13): 21/21 adversarial cases denied/contained through provider → executor → managed port → durable ledger → independent verifier; custom-seccomp SHA-256 `87ae93a7…a7a1214`; kernel `7.0.0-1017-azure`. Local daemon remains blocked by socket permission |
| gVisor 20261102.0 (`runsc`) | User-space application kernel (Sentry); second kernel | No guest kernel; minimal host syscalls | Partial: `--rootless` is single-UID, no netstack/create/save-restore | Host cgroups; in-sandbox cgroups do not enforce between processes | netstack; `--network=none` | **Not integrated**: no adapter, no runsc on the host |
| Apple Containerization 1.7.1 | Per-container VM via Virtualization.framework | No | Per-user CLI after admin install; not Linux-userns rootless | Per-VM `--cpus` / `--memory` (defaults 4 CPU / 1 GB) | vmnet; isolated per-network on macOS 26+ | **Unavailable**: macOS 26 / Apple silicon required |
| macOS Seatbelt (`sandbox-exec`) | Sandbox profile applied by the kernel | Yes | Yes | None | `(deny network*)` in profile | **Unavailable and deprecated**: Apple ships but deprecates `sandbox-exec`; no removal date or CLI replacement published. The host fails closed when the probe is unavailable, covered by `apps/host/tests/execution.test.ts`; real macOS execution is unverified |

## Decision

- Linux default remains **bubblewrap** because it is the smallest boundary that runs
  unprivileged here, needs no daemon or image, is actively maintained, and its exact flags
  are auditable. It is a shared-kernel boundary, so it is labelled `kernel-namespace`, not
  `container`.
- **Docker** is the explicit opt-in container provider when a daemon and a locally present
  image are available (`provider: docker` plus `image`). The host never pulls an image
  implicitly and never selects Docker from Linux `auto`. Docker's daemon is a privileged
  trust anchor and the image is an operational dependency; that cost is why it is not the
  default.
- Docker uses `create` → inspect → `start --attach` → cleanup, not `docker run`, so the
  daemon's reported controls are checked before execution and the named container is killed
  and removed on every exit path. The daemon's non-default seccomp report and the generated
  profile digest are recorded as separate evidence.
- The host **fails closed**: if the selected provider's probe fails, dispatch stays disabled.
  There is no bare-process or alternative-provider fallback.
- **Seatbelt is deprecated.** It stays only as a best-effort macOS adapter and is labelled
  `seatbelt`; a supported macOS path requires Apple Containerization, which is future work and
  currently `unverified`.
- **gVisor is the recommended next step** for untrusted multi-tenant workloads, but it is not
  integrated because the repository has no validated `runsc` configuration, image pipeline, or
  platform matrix.

## Flags actually passed by the bubblewrap provider

`--die-with-parent --new-session --unshare-all --cap-drop ALL --seccomp 3`, read-only binds
of `/usr`, `/bin`, `/lib`, `/lib64`, `/etc`, `--proc /proc`, `--dev /dev`,
`--size 67108864 --tmpfs /tmp`, a writable bind of only the run workspace, `--clearenv`,
`HOME=/tmp`, a fixed `PATH`, then `/usr/bin/prlimit --as=1342177280 --cpu=<ceil(deadline/1000)> --nproc=128 --`,
a fixed `/bin/sh` wrapper, and then the task argv.

The filter is a generated classic-BPF deny-list with an x86_64/arm64 architecture guard and
`KILL_PROCESS` for the listed syscalls. The wrapper records the kernel's `Seccomp: 2` state and
the exact `/proc/self/limits` values on an inherited marker fd before it execs the task; a
missing or mismatched marker denies the run. The verifier runs its own filtered command and
records its own filter and limit evidence rather than trusting the executor. See ADR-0027 and
ADR-0028.

## Flags actually passed by the Docker provider

`--init --network=none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop=ALL
--security-opt=no-new-privileges --security-opt seccomp=<generated profile path>
--pids-limit 128 --memory 536870912 --memory-swap 536870912 --cpus 1 --ulimit cpu=<ceil(deadline/1000)>
--mount type=bind,src=<run workspace>,dst=/workspace --workdir /workspace[/relative-cwd]
--user <host uid>:<host gid> --env PATH=/usr/local/bin:/usr/bin:/bin --env HOME=/tmp
--env TMPDIR=/tmp <allowlisted task env> --entrypoint <argv[0]> <local image> <argv[1..]>`.

Before `start`, the provider reads the daemon's `HostConfig`/`Mounts`/`Config` and requires:
read-only root, `NetworkMode=none`, `CapDrop=ALL`, `no-new-privileges`, a non-default seccomp
profile, the expected PID/memory/swap/CPU values, the CPU rlimit, the exact workspace bind with
`RW:true`, and the host UID/GID. Missing or mismatched evidence is a typed failure, not a
warning. Docker does not expose the client-side seccomp source path or its digest in
`HostConfig.SecurityOpt`; the daemon's active-profile report is trusted, and the generated
profile digest is recorded separately. Docker's CLI rejects `--ulimit as`, so no per-process
address-space limit is claimed; the cgroup memory ceiling is the measured memory boundary.

## Known gaps and residual differences

- **bubblewrap:** the filter is a deny-list, not an allow-list, so unlisted syscall families
  remain callable; Landlock is not present in the active LSM list; there is no aggregate
  cgroup CPU/memory accounting. Resource limits are per-process (1.25 GiB address space,
  deadline-aligned CPU, 128 processes), so many descendants can aggregate above the
  individual caps; `RLIMIT_AS` is not an RSS limit (ADR-0028).
- **Docker:** the measured run used the GitHub-hosted runner's daemon; rootless Docker,
  subuid/subgid mapping, and rootless cgroup delegation were **not** measured. The daemon is
  a privileged trust anchor, not part of the workload boundary. The local
  `aios-sandbox:local` image is built from `debian:bookworm-slim` and is not signed or pinned
  by digest. The image removes `/etc/shadow`, so adversarial case 1 proves the container
  rootfs lacks that host credential file; it does not prove a host `/etc` bind is absent.
  Docker shares the host kernel and is not a VM or gVisor-class boundary.
- Docker has no `RLIMIT_AS`; bubblewrap has one. Docker has aggregate cgroup memory/CPU/PID
  limits; bubblewrap has per-process rlimits and no aggregate accounting.
- Both providers rely on the host executor's 25 ms workspace sampler for disk enforcement;
  it is not a hard filesystem quota and can overshoot.
- Node/libuv probes `io_uring_setup` and is killed by the deny-list at startup (F-007).
- The 21-case adversarial drill runs as a required step against bubblewrap and against
  Docker in the Security workflow; each failing case fails the job. The Docker image build
  and drill are separate steps in the same live-sandbox job.
- The Docker CPU burner was terminated by the provider deadline (`SIGKILL`, 3,004 ms), not a
  distinct `SIGXCPU`; the exact `--ulimit cpu` value is separately probed.
- Real macOS Seatbelt, Apple Containerization, and gVisor remain unverified or unavailable.

The Docker run is recorded in `docs/security/validation-ledger.md` with the exact CI run and
per-case observations. No bubblewrap assertion, flag, permission, job condition, action pin,
timeout, or severity was changed for the Docker run.

## Sources

- Docker Engine security: <https://docs.docker.com/engine/security/> · rootless: <https://docs.docker.com/engine/security/rootless/> · seccomp: <https://docs.docker.com/engine/security/seccomp/>
- bubblewrap: <https://github.com/containers/bubblewrap> · man page: <https://github.com/containers/bubblewrap/blob/main/bwrap.xml>
- gVisor security model: <https://gvisor.dev/docs/architecture_guide/security/> · rootless: <https://gvisor.dev/docs/user_guide/rootless/> · platforms: <https://gvisor.dev/docs/architecture_guide/platforms/>
- Apple Containerization: <https://github.com/apple/containerization> · technical overview: <https://github.com/apple/container/blob/main/docs/technical-overview.md>
- Apple App Sandbox: <https://developer.apple.com/documentation/security/app-sandbox>
