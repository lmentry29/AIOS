# Sandbox Provider Matrix

Primary sources checked 2026-11-10. Versions are the latest published at that date. The
"AIOS evidence" column is deliberately separate from the vendor claims.

| Provider | Boundary | Shares host kernel | Unprivileged operation | Resource limits | Network isolation | AIOS evidence |
|---|---|---|---|---|---|---|
| bubblewrap 0.13.1 | Namespaces + mounts + capability drop + generated seccomp deny-list; policy is caller-defined | Yes | Yes, user namespaces; setuid mode removed in 0.12.0 | Per-process `RLIMIT_AS` 1.25 GiB, `RLIMIT_CPU` aligned to the deadline, `RLIMIT_NPROC` 128 via `prlimit`; seccomp BPF deny-list; no cgroup aggregate/CPU/memory flags; `--size` bounds only the next tmpfs | `--unshare-net` / `--unshare-all` give loopback-only netns | **Validated** on Linux 6.1.102 with bwrap 0.9.0: 12/12 boundary/limit cases, 3/3 seccomp cases, 2/2 quota drills, and the resource-limit drill (see validation ledger) |
| Docker Engine 29.9.3 (rootless) | Container: namespaces, cgroups, seccomp, LSMs | Yes | Rootless daemon + userns; needs subuid/subgid mapping | cgroup v2 via `--memory`, `--cpus`, `--pids-limit`; ignored without cgroup v2 + systemd | netns per container; `--network=none` | **Unverified**: CLI present, daemon socket permission denied on the validation host. Adapter tests cover argument construction only |
| gVisor 20261102.0 (`runsc`) | User-space application kernel (Sentry); second kernel | No guest kernel; minimal host syscalls | Partial: `--rootless` is single-UID, no netstack/create/save-restore | Host cgroups; in-sandbox cgroups do not enforce between processes | netstack; `--network=none` | **Not integrated**: no adapter, no runsc on the host |
| Apple Containerization 1.7.1 | Per-container VM via Virtualization.framework | No | Per-user CLI after admin install; not Linux-userns rootless | Per-VM `--cpus` / `--memory` (defaults 4 CPU / 1 GB) | vmnet; isolated per-network on macOS 26+ | **Unavailable**: macOS 26 / Apple silicon required |
| macOS Seatbelt (`sandbox-exec`) | Sandbox profile applied by the kernel | Yes | Yes | None | `(deny network*)` in profile | **Unavailable and deprecated**: Apple ships but deprecates `sandbox-exec`; no removal date or CLI replacement published |

## Decision

- Linux default remains **bubblewrap** because it is the smallest boundary that runs
  unprivileged here, is actively maintained, and its exact flags are auditable. It is a
  shared-kernel boundary, so it is labelled `kernel-namespace`, not `container`.
- **Docker** remains the opt-in container provider when a daemon and a locally present image
  are available. The host never pulls an image implicitly.
- **Seatbelt is deprecated.** It stays only as a best-effort macOS adapter and is labelled
  `seatbelt`; a supported macOS path requires Apple Containerization, which is future work and
  currently `unverified`.
- **gVisor is the recommended next step** for untrusted multi-tenant workloads, but it is not
  integrated because the repository has no validated `runsc` configuration, image pipeline, or
  platform matrix.
- The host **fails closed**: if the selected provider's probe fails, dispatch stays disabled.
  There is no bare-process fallback.

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

Known gaps: this is a deny-list, not an allow-list, so unlisted syscall families remain
callable; Landlock is not present in the active LSM list; Docker's adapter remains unverified;
and there is no aggregate cgroup CPU/memory accounting. Resource limits are per-process
(1.25 GiB address space, deadline-aligned CPU, 128 processes), so many descendants can
aggregate above the individual caps; RLIMIT_AS is not an RSS limit (ADR-0028). Node/libuv
probes `io_uring_setup` and is killed by the filter at startup (F-007). The per-run workspace
ceiling is enforced live by the host executor's 25 ms sampler, not by the kernel or the
provider flags; it is not a hard quota and a fast writer can overshoot between samples
(ADR-0026). The sandbox `/tmp` is size-bounded to 64 MiB, and the only other writable host
path is the run workspace.

## Sources

- Docker Engine security: <https://docs.docker.com/engine/security/> · rootless: <https://docs.docker.com/engine/security/rootless/> · seccomp: <https://docs.docker.com/engine/security/seccomp/>
- bubblewrap: <https://github.com/containers/bubblewrap> · man page: <https://github.com/containers/bubblewrap/blob/main/bwrap.xml>
- gVisor security model: <https://gvisor.dev/docs/architecture_guide/security/> · rootless: <https://gvisor.dev/docs/user_guide/rootless/> · platforms: <https://gvisor.dev/docs/architecture_guide/platforms/>
- Apple Containerization: <https://github.com/apple/containerization> · technical overview: <https://github.com/apple/container/blob/main/docs/technical-overview.md>
- Apple App Sandbox: <https://developer.apple.com/documentation/security/app-sandbox>
