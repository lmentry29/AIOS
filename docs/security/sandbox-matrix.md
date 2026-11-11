# Sandbox Provider Matrix

Primary sources checked 2026-11-11. Versions are the latest published at that date. The
“AIOS evidence” column is deliberately separate from vendor claims. Bubblewrap is validated
locally; Docker and gVisor were measured in the Security workflow at `ef02f27`, including the
repository-pinned gVisor runtime and a reproducible rootfs digest.

| Provider | Boundary | Shares host kernel | Unprivileged operation | Resource limits | Network isolation | AIOS evidence |
|---|---|---|---|---|---|---|
| bubblewrap 0.13.1 | Namespaces + mounts + capability drop + generated seccomp deny-list; policy is caller-defined | Yes | Yes, user namespaces; setuid mode removed in 0.12.0 | Per-process `RLIMIT_AS` 1.25 GiB, `RLIMIT_CPU` aligned to the deadline, `RLIMIT_NPROC` 128 via `prlimit`; seccomp BPF deny-list; no cgroup aggregate/CPU/memory flags; `--size` bounds only the next tmpfs | `--unshare-net` / `--unshare-all` give loopback-only netns | **Validated** on Linux 6.1.102 with bwrap 0.9.0: 12/12 boundary/limit cases, 3/3 seccomp cases, 2/2 quota drills, the resource-limit drill, and 21/21 adversarial drill cases covering filesystem, secrets, network, capabilities, CPU/PID, orphans, quota, instruction smuggling, and forged/replayed verification (see validation ledger) |
| Docker Engine 28.0.4 (GitHub-hosted runner; **rootful** daemon measured) | Container: namespaces, cgroups, custom seccomp, read-only rootfs, dropped capabilities, no-new-privileges | Yes | Opt-in daemon container; workload runs as host UID/GID (non-root); daemon access is an operator prerequisite | cgroup v2 `--memory` 512 MiB (equal `--memory-swap`), `--cpus` 1, `--pids-limit` 128; deadline-aligned `--ulimit cpu`; **no `RLIMIT_AS`**, because Docker's CLI rejects `--ulimit as` | `--network=none`; container loopback only | **Validated** in CI at `378e7d6` (Security run `42956393498`, live job `130312417881`, Docker build step 13 and drill step 14): 21/21 adversarial cases; engine `28.0.4`, `rootless:false`, daemon security options `name=apparmor`, `name=seccomp,profile=builtin`, `name=cgroupns`; kernel `7.0.0-1017-azure`. Local daemon remains blocked by socket permission; rootless Docker not measured |
| gVisor 20261102.0 (`runsc`) | User-space application kernel (Sentry) + gofer; OCI rootfs; no workload on host kernel syscall path | No guest kernel; the Sentry/gofer still use the host kernel | Partial: `--rootless` single-UID, no netstack; no save/restore; repository-pinned runtime and build inputs, reproducible rootfs | OCI `RLIMIT_AS` 512 MiB, deadline-aligned `RLIMIT_CPU`, `RLIMIT_NPROC` 128, `RLIMIT_NOFILE` 1024, enforced by the Sentry; no host cgroup; workspace disk is the 25 ms sampler | `--network=none`; private network namespace; no netstack in this mode | **Validated** in CI at `cc8c1df` with manifest v2 (Security run `42963634931`, steps 12–21): platform digest `sha256:c67e92c8…` proven as the child of index `sha256:734a72b3…`; independent images `sha256:8702c6e9…` and `sha256:de61bccf…` both produced rootfs `8d7514ae…` (6,195 entries; `content_sha256 6e1376d8…`, `metadata_sha256 bf8da6b6…`, xattrs captured); gVisor drill **21/21** with provenance `d0f27232…`. Earlier validation at `378e7d6` (Security run `42956393498`, live job `130312417881`, steps 12 and 15–19): `runsc release-20261102.0`, binary SHA-256 `c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098`, archive SHA-512 `2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05`, runtime pin `20c017d9…`; base pinned by `linux/amd64` digest `sha256:c67e92c8…` under index `sha256:734a72b3…` (the workflow proves the child relationship), snapshot `20261110T000000Z`, exact packages, build pin `9fccac3e…`; rootfs `6e1376d8ee022a239e7dc38a068498729a88632639559ccc41a0174d788f20d7` (6,195 entries, run-scoped manifest `845c98537b568983f70644d4ef5fc9582303c3aa09893cca39d6e5bf5b5bab3f`, image IDs `sha256:89eacf2a…` and `sha256:a8abdab0…`, Dockerfile SHA-256 `5acad18a…`, independent image builds identical; manifest v2 attests uid/gid, mode, mtime and xattrs, the runtime executes from a private measured copy, and the rootfs executes from an invocation-owned copy that must measure identically), **21/21** adversarial cases through provider → executor → managed port → durable ledger → verifier, kernel `7.0.0-1017-azure`. Controlled rootfs, PID 1, `CapEff=0`, no host bind; local minimal-rootfs drill also 21/21 (rootfs `2e7a3eba…`, 2,693 entries). A tampered archive and missing pin both failed closed before any drill case ran |
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
  default. The measured daemon was rootful; rootless Docker remains unmeasured.
- **gVisor** is the explicit opt-in user-space-kernel provider (`provider: gvisor` plus an
  absolute `rootfs`). It uses a generated OCI bundle and `runsc --rootless --network=none`,
  never the host-root-mounting `runsc do` convenience. It has no host cgroup for the workload;
  its OCI rlimits are enforced inside the Sentry. gVisor is not the default because it adds a
  runtime binary, a separately maintained rootfs, rootless single-UID constraints, and
  compatibility/performance cost. The runtime and build inputs are now repository-pinned: the
  base image is referenced by manifest-list digest, apt reads the fixed `snapshot.debian.org`
  timestamp, and package versions are exact. CI builds two independent no-cache images and
  requires the same canonical rootfs digest; neither artifact is signed.
- Docker uses `create` → inspect → `start --attach` → cleanup, not `docker run`, so the
  daemon's reported controls are checked before execution and the named container is killed
  and removed on every exit path. The daemon's non-default seccomp report and the generated
  profile digest are recorded as separate evidence.
- The host **fails closed**: if the selected provider's probe fails, dispatch stays disabled.
  There is no bare-process or alternative-provider fallback.
- **Seatbelt is deprecated.** It stays only as a best-effort macOS adapter and is labelled
  `seatbelt`; a supported macOS path requires Apple Containerization, which is future work and
  currently `unverified`.

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

## Flags and OCI controls actually used by Docker

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
The availability probe now records `ServerVersion` and `SecurityOptions` from
`docker info --format '{{json .}}'`; the measured CI daemon was `28.0.4`, rootful.

## gVisor OCI controls actually used

`runsc --root=<private state> --rootless --network=none run --bundle <generated bundle>
<unique container id>`, with a read-only configured rootfs and exactly one writable bind of the
run workspace at `/workspace`. The generated OCI process has empty capability sets,
`noNewPrivileges:true`, `RLIMIT_AS=536870912`, `RLIMIT_CPU=<ceil(deadline/1000)>`,
`RLIMIT_NPROC=128`, and `RLIMIT_NOFILE=1024`; it uses private PID/network/IPC/UTS/mount
namespaces, private `/proc`, `/dev`, and `/tmp`, read-only `/sys`, and standard masked/read-only
proc paths. The environment contains only `PATH`, `HOME`, `TMPDIR`, and allowlisted Task values.
The provider records a `gvisor-sentry` boundary and `gvisor-oci-rlimit` mechanism; it does not
borrow bubblewrap/Docker seccomp evidence. Cleanup attempts `runsc kill --all` and
`runsc delete --force` on every exit path. The mount probe was corrected only for gVisor because
the Sentry returns `EPERM` instead of killing the process; a successful mount still prints the
marker and fails the case.

## Known gaps and residual differences

- **bubblewrap:** the filter is a deny-list, not an allow-list, so unlisted syscall families
  remain callable; Landlock is not present in the active LSM list; there is no aggregate
  cgroup CPU/memory accounting. Resource limits are per-process (1.25 GiB address space,
  deadline-aligned CPU, 128 processes), so many descendants can aggregate above the
  individual caps; `RLIMIT_AS` is not an RSS limit (ADR-0028).
- **Docker:** the measured daemon was Docker `28.0.4`, **rootful**; rootless Docker,
  subuid/subgid mapping, and rootless cgroup delegation were **not** measured. The daemon is
  a privileged trust anchor, not part of the workload boundary. The local
  `aios-sandbox:local` image is built from `debian:bookworm-slim@sha256:734a72b3…` with the
  fixed `20261110T000000Z` apt snapshot and exact package versions; it is not signed, and an
  operator-supplied image remains operator-owned. The image removes `/etc/shadow`, so
  adversarial case 1 proves the container
  rootfs lacks that host credential file; it does not prove a host `/etc` bind is absent.
  Docker shares the host kernel and is not a VM or gVisor-class boundary.
- **gVisor:** rootless single-UID mapping, no netstack, and no save/restore are measured
  constraints. `runsc` is fetched from the release URL pinned by the repository and checked
  against the pinned SHA-512 and extracted SHA-256 before use; the provider also hashes the
  actual executable and canonical rootfs on every check/run. CI builds the rootfs twice from
  `aios-sandbox:local` and requires identical content digests, and the drill requires the
  manifest to match. Neither the pin nor the rootfs is Sigstore-signed; the pin, base/snapshot
  inputs, and manifest are unsigned repository trust anchors, the Debian snapshot must remain
  available for a future rebuild, and a host writer can replace the runtime/rootfs after
  hashing.
  There is no host cgroup for the workload; OCI rlimits are enforced by the Sentry. gVisor is a
  user-space kernel, not a VM, and shares the host kernel through the Sentry/gofer. The measured
  CPU burner ended with `SIGKILL` at the deadline, not `SIGXCPU`; case 1 proves the rootfs lacks
  `/etc/shadow`, not that an arbitrary operator rootfs is trustworthy.
- Docker has no `RLIMIT_AS`; bubblewrap has one. Docker has aggregate cgroup memory/CPU/PID
  limits; bubblewrap has per-process rlimits and no aggregate accounting. gVisor has Sentry
  OCI rlimits and no host aggregate.
- All providers rely on the host executor's 25 ms workspace sampler for disk enforcement;
  it is not a hard filesystem quota and can overshoot.
- Node/libuv probes `io_uring_setup` and is killed by the bubblewrap deny-list at startup
  (F-007). This is a bubblewrap policy detail, not a gVisor claim.
- The 21-case adversarial drill runs as a required step against bubblewrap, Docker, and gVisor
  in the Security workflow; each failing case fails the job. The Docker image build and gVisor
  install/rootfs export are separate setup steps in the same live-sandbox job. The required
  fail-closed step deliberately tampers with an archive and omits the pin; either acceptance
  would fail the job.
- Real macOS Seatbelt, Apple Containerization remain unverified or unavailable; gVisor is
  measured only on Linux (CI kernel `7.0.0-1017-azure` and local `6.1.102`).

The gVisor and Docker runs are recorded in `docs/security/validation-ledger.md` with the exact
CI run and per-case observations. No bubblewrap assertion, flag, permission, job condition,
action pin, timeout, or severity was changed for the gVisor run.

## Sources

- Docker Engine security: <https://docs.docker.com/engine/security/> · rootless: <https://docs.docker.com/engine/security/rootless/> · seccomp: <https://docs.docker.com/engine/security/seccomp/>
- bubblewrap: <https://github.com/containers/bubblewrap> · man page: <https://github.com/containers/bubblewrap/blob/main/bwrap.xml>
- gVisor security model: <https://gvisor.dev/docs/architecture_guide/security/> · rootless: <https://gvisor.dev/docs/user_guide/rootless/> · platforms: <https://gvisor.dev/docs/architecture_guide/platforms/> · install: <https://gvisor.dev/docs/user_guide/install/>
- Apple Containerization: <https://github.com/apple/containerization> · technical overview: <https://github.com/apple/container/blob/main/docs/technical-overview.md>
- Apple App Sandbox: <https://developer.apple.com/documentation/security/app-sandbox>

## Signed artifacts (2026-11-11)

gVisor, all platforms: the runtime pin and rootfs manifest must verify against the configured
trust root before use, and the signed rootfs digest must equal the measured and executed
rootfs. With the repository's unprovisioned (empty) trust root the provider is unavailable;
CI and drills supply a run-scoped trust root to exercise the offline chain. This row does not
imply keyless identity or SLSA provenance.

Statement v2 additionally requires strict, bounded JSON: duplicate/prototype keys, unknown
fields, oversized/deep documents and non-canonical signatures fail closed before any trust
decision. Version 1 statements are rejected.

## Executor/verifier evidence (2026-11-11)

Verification acceptance requires durable attempt evidence with canonical result binding and a
per-invocation nonce; replayed, cross-Task, legacy, malformed, duplicated or tampered
evidence fails closed before the verification command runs. An unbound verifier can run a
command for diagnostics but cannot accept. This applies to every provider and does not
change platform isolation claims.
