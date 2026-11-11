# ADR-0032 — gVisor Provider and Cross-Provider Selection

## Status

**Accepted** (2026-11-11; amended 2026-11-11 for runtime/rootfs provenance). This ADR adds an
explicit, measured gVisor `runsc` provider and records the cross-provider selection rule for
bubblewrap, Docker, and gVisor. It supersedes the "gVisor unverified" clauses of ADR-0019,
ADR-0027, ADR-0028, and ADR-0031 for the measured path. Bubblewrap remains the Linux default. It
does not make gVisor a VM boundary, does not make the operator-supplied rootfs a signed image,
and does not change any bubblewrap or Docker assertion, flag, permission, action pin, timeout,
or severity.

## Amendment — runtime and rootfs provenance (2026-11-11)

The original decision recorded gVisor's runtime and rootfs as operator-owned and unattested.
That was a real gap: a different `runsc` or rootfs could have executed while the provider still
reported the same Sentry boundary. This amendment closes the accidental-substitution path and
makes the remaining trust assumptions explicit; it does not claim a signed supply chain.

- `tools/security/gvisor-runtime.pin.json` holds the gVisor release, architecture, HTTPS
  release-archive URL, archive SHA-512, extracted `runsc` SHA-256, and expected `runsc` version.
  The provider reads the repository-owned pin by default; a missing, malformed, symlinked, or
  architecture-mismatched pin is an error, never an "unverified but continue" state.
- `GvisorSandbox.check()` and `run()` resolve the actual executable, hash it, hash the canonical
  rootfs, and use the verified absolute runtime path. They do not trust `PATH` or a cached
  check. The pin file digest, release, version, archive digest, binary digest, rootfs digest,
  and entry count are recorded in availability, result, executor, and verifier evidence.
- `tools/security/gvisor-provenance.mjs` fetches the pinned release, verifies the archive before
  extraction, verifies the extracted binary and version, and exports the rootfs from the local
  Docker image with `docker create` + `docker export` + `tar -xf --no-same-owner`.
- `tools/security/gvisor-rootfs.json` records the source image, Dockerfile, packages,
  exclusions, and construction. `build-rootfs --verify-reproducible` exports twice and requires
  the same canonical content digest. The drill requires `AIOS_GVISOR_ROOTFS_MANIFEST` and
  compares the provider's measured rootfs digest and entry count to it before accepting cases.
- The canonical manifest covers relative path, entry type, mode, size, file SHA-256, and symlink
  target; timestamps, uid/gid, xattrs, and traversal order are excluded. This is content
  attestation, not ownership attestation.
- CI has a required negative step: a tampered archive must fail the pinned SHA-512 check and a
  missing pin must fail before any drill. A successful verification of either is a job failure.
  There is no fallback provider or bare-process path.

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
   `AIOS_SANDBOX_PROVIDER=gvisor`, `AIOS_GVISOR_ROOTFS`, and the required
   `AIOS_GVISOR_ROOTFS_MANIFEST`, and uses the real `createSandboxProvider`,
   `LocalCommandExecutor`, `ManagedExecutionPort`, durable `ExecutionLedger`, and
   `LocalCommandVerifier`. The Security workflow fetches the repository-pinned gVisor release,
   verifies it, exports a controlled Debian rootfs from the same Docker image used by the
   Docker drill, verifies a reproducible manifest, and runs the drill as a plain `run:` step.
   A failed case, missing pin, or digest mismatch fails the job. The bubblewrap and Docker steps,
   assertions, pins, and timeouts remain untouched.

6. **The Docker engine claim is now measured too.** Docker's availability probe reads
   `docker info --format '{{json .}}'` and records `ServerVersion`, the daemon
   `SecurityOptions`, and a rootless/rootful classification (`name=rootless` when present;
   unknown if the daemon exposes no options). The measured CI daemon was Docker `28.0.4`,
   **rootful** (`rootless:false`; `name=apparmor`, `name=seccomp,profile=builtin`,
   `name=cgroupns`). Rootless Docker remains unmeasured.

7. **Runtime and rootfs are provenance-checked, not silently substitutable.** The provider
   verifies the repository pin and the actual `runsc`/rootfs on every check and run. The CI
   drill requires the rootfs manifest and fails before any case if the measured rootfs differs.
   The remaining trust anchor is the unsigned repository pin plus the operator-controlled
   runtime/rootfs directory; the amendment above records that limit rather than hiding it.

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
cgroup; disk remains the executor's 25 ms workspace sampler.

The provenance amendment reduces the accidental-substitution risk but does not make the supply
chain signed or self-authenticating. The release archive and extracted binary are checked
against repository data; the rootfs is built from a base image pinned by manifest-list digest, a
fixed Debian snapshot, and exact package versions, then checked against a canonical manifest
every run. However, the pin file, base/snapshot inputs, and manifest are unsigned repository
trust anchors, the snapshot service must remain available for a future rebuild, the manifest
excludes ownership/timestamps, and a host writer can replace the runtime or rootfs after
hashing. A Sigstore-signed release and immutable runtime mount remain future work.

## Measured evidence

### CI at `378e7d6`

- Code head `378e7d63ad7f747833eb09ae6dc73eef649bfffe`; Security run `42956393498`, live job
  `130312417881`:
  - Step 12, pin guard. Observed `debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`,
    Debian snapshot `20261110T000000Z` (`bookworm`, `bookworm-updates`, `bookworm-security`),
    exact packages `coreutils=9.1-1`, `perl=5.36.0-7+deb12u4`, and
    `util-linux=2.38.1-5+deb12u3`; pin SHA-256
    `9fccac3eac4bb9e5c0adde39816dc7b858c3ea1b5105d3e79b91046c15c6174d`.
  - Step 13 built the Docker image; step 14 ran the Docker drill **21/21** (engine `28.0.4`,
    rootful, kernel `7.0.0-1017-azure`).
  - Step 15 rebuilt the image independently with `docker build --no-cache`; step 16 installed
    and verified `runsc release-20261102.0`, binary
    `c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098`, archive
    `2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05`,
    pin `20c017d90727d32cffa931219f68a336d639f97ac234087190984312a5b9bd2c`.
  - Step 17 observed the tampered-archive SHA-512 mismatch and missing-pin error, then
    completed because both were rejected. A successful verification would have exited 1.
  - Step 18 exported the first image and the independently built image. Image IDs
    `sha256:89eacf2ae4ed6aa99b5be877d12656c6968ccac812777f4f1da7167b7e1ff8e5` and
    `sha256:a8abdab0a7949941cf9afbea740065ede56047a39880e29649fd7e89f75a0ba7`; Dockerfile
    SHA-256 `5acad18ae243c42ba3e5f4cc8cd30557beafe9aaad95b025d9e64d7f6fb8fe2c`; both produced
    rootfs `6e1376d8ee022a239e7dc38a068498729a88632639559ccc41a0174d788f20d7` with 6,195
    entries; manifest SHA-256
    `845c98537b568983f70644d4ef5fc9582303c3aa09893cca39d6e5bf5b5bab3f`; comparison method
    `independent-image-build`. Image IDs and the manifest SHA-256 identify this run only; Docker
    image config is not reproducible, so later builds can produce different image IDs and a
    different manifest hash. The reproduction invariant is the rootfs digest and entry count.
  - Step 19 ran the gVisor drill **21/21**; every case carried provenance digest
    `8490ada2b7adb15bad155212fcde4b7c3187ad12ae6b989319b0bfa62052007b`, runtime `c5a5a7ba…`,
    and rootfs `6e1376d8…`; result `all adversarial cases denied or contained`.
  - Step 20 ran the session-operator drill. Bubblewrap live tests, resource-limit drill, and
    bubblewrap adversarial drill steps 9–11 also passed.
- The same head's CI run `42956393497`, Conformance run `42956393507`, and Schema Check run
  `42956393513` were green. The Release workflow is `workflow_dispatch`-only and is dispatched
  separately on the final documentation head.

### Amendment 2026-11-11 — platform digest, metadata manifest and verify-to-execute binding

- The build is bound to the `linux/amd64` manifest digest
  `sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018`; the recorded
  manifest-list digest `sha256:734a72b3…` is verified in CI to contain that platform manifest
  (`verify-platform-digest`). A tag or the index digest in `FROM` is rejected.
- The rootfs manifest is v2: `sha256` covers path, type, permission bits (including
  setuid/setgid/sticky), uid/gid, size, file SHA-256, symlink target and extended attributes;
  `timestamps_sha256` attests mtime separately because independent Docker builds do not produce
  identical directory times. `content_sha256` keeps the v1 algorithm comparable. The Security
  workflow installs `attr` and requires xattr capture, so the published evidence cannot silently
  omit them. Rationale and omissions: `docs/security/rootfs-metadata-attestation.md`.
- Runtime and rootfs outputs are prepared in unique staging directories and promoted
  atomically only after verification. Pre-existing destinations, including symlinks, are
  refused, and cleanup is restricted to the staging inode the invocation created.
- The pinned `runsc` is executed from a private copy of the measured runtime tree (binary plus
  `gvisor-bin` Sentry sidecars, with symlinks/special files rejected) and re-checked immediately
  before spawn. The rootfs is copied into an invocation-owned directory and the copy must
  measure identically before execution, so runtime scratch writes cannot mutate the operator
  rootfs. This does not defend against a same-UID host writer, which remains inside the host
  trust boundary.
- Local verification at the amendment head: host build exit 0; focused provenance/provider
  tests **28/28**; full host suite **183 passed / 17 skipped**; tool syntax check exit 0. The
  Docker-based independent-image and platform-index checks remain CI-only because no local
  Docker daemon is available. The extended-attribute reader is invoked as `getfattr -R -h -d`;
  `-h` prevents symlink dereference into the host, and `Operation not supported` is the only
  tolerated reader error (empty set for symlinks) while other errors abort.
- CI at `cc8c1df` (Security run `42963634931`, 2m15s) passed steps 1–21: platform-index check
  `734a72b3…` → `c67e92c8…`; independent images `8702c6e9…`/`de61bccf…` both produced
  manifest-v2 rootfs `8d7514ae…` (6,195 entries; `content_sha256 6e1376d8…`, `metadata_sha256
  bf8da6b6…`, xattrs captured); gVisor drill **21/21** with provenance `d0f27232…`; Docker
  **21/21**; bubblewrap **21/21**; session-operator drill passed. Same-head CI, Conformance
  and Schema Check were green. Four earlier Security runs (`42961763395`, `42962192528`,
  `42962683783`, `42963299015`) each exposed a concrete defect in this change (getfattr
  pattern, missing Sentry sidecars, runtime rootfs writes, copy mode preservation); each was
  fixed and re-run, not waived.

### Earlier CI at `54344f1`

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

- Uncached workspace gate: **46/46** tasks, **0 cached**; host tests **168 passed / 17 skipped**
  (the skips are live suites without a provider environment).
- Bubblewrap live suite **17/17**; bubblewrap adversarial **21/21**; resource-limit drill exit
  **0**; bubblewrap filter SHA-256
  `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`.
- gVisor adversarial **21/21** against a local minimal, controlled 67 MiB rootfs with
  `/etc/shadow` absent and no host-root bind. The measured rootfs was
  `2e7a3eba09cfbba65babc0566e10c70c5b9dd028f64d951a63483bb3a9f9caca` (2,693 entries), and the
  provider required `runsc` binary `c5a5a7…` and pin `20c017…`. The local and CI rootfs differ in
  provenance (local selected host binaries/libraries; CI Debian image export), but both exercise
  the same production provider and drill.
- The local Docker daemon remains unreachable
  (`permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`);
  Docker remains CI-measured only.

### Per-case gVisor observations (CI)

At `378e7d6`, every case carried `provenance_sha256`
`8490ada2b7adb15bad155212fcde4b7c3187ad12ae6b989319b0bfa62052007b`, runtime
`c5a5a7ba…`, and rootfs `6e1376d8…`; the 21 cases below are the individual observations.

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
| 12 | CPU exhaustion | `timedOut:true`, `SIGKILL`, 3,009 ms; CPU 3 s, PID 128 |
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
| Runtime/rootfs supply chain | `runsc` is fetched from the pinned release and checked against archive SHA-512, extracted SHA-256, and expected version on every invocation. The rootfs is built from a base image pinned by manifest-list digest, the fixed `snapshot.debian.org` timestamp, and exact package versions; CI builds two independent no-cache images and requires the same canonical digest, and the drill requires the manifest. Neither artifact is Sigstore-signed; the pin, base/snapshot inputs, and manifest are unsigned repository trust anchors, the snapshot must remain available, and the manifest excludes ownership/timestamps. |
| Shared host kernel | gVisor is not a VM. The Sentry and gofer make host syscalls; a Sentry or host-kernel vulnerability remains in scope. |
| CPU termination | The burner ended by the provider deadline (`SIGKILL`), not a distinct `SIGXCPU`; the OCI CPU rlimit value was separately probed. |
| Case 1 image detail | The rootfs removes `/etc/shadow`; case 1 proves the controlled rootfs lacks that credential file, not that a hostile operator-supplied rootfs is trustworthy. |
| Legacy/macOS | Seatbelt remains deprecated and unverified; Apple Containerization remains unavailable and unverified. |

### Operational cost

Each gVisor CI job performs one release download, archive verification, extraction, binary
verification, two independent no-cache image builds, two container exports, and two canonical
rootfs hashes; each provider check/run rehashes the resolved runtime and all 6,195 rootfs
entries. Updating gVisor requires changing the release, archive SHA-512, `runsc` SHA-256, and
expected version together, then re-running the full 21-case drill. Refreshing the Debian base or
apt snapshot requires updating the base digest, snapshot timestamp, exact package versions, and
Dockerfile together, rebuilding twice, and updating the recorded image/Dockerfile/rootfs
digests. The pin file is a repository trust anchor and must be reviewed like code. This is more
maintenance than bubblewrap, which needs no fetched runtime or rootfs, and is why bubblewrap
remains the Linux default.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Use `runsc do` | It mounts the host rootfs read-only and is explicitly a test convenience; it does not satisfy the filesystem threat model. |
| Run gVisor rootful | It would make the runtime root and weaken the measured unprivileged claim; the host can run rootless here. |
| Treat gVisor as a host seccomp provider | gVisor is a user-space kernel; borrowing bubblewrap/Docker filter evidence would be fabricated coverage. |
| Make gVisor the Linux default | Adds a runtime binary, rootfs supply chain, rootless constraints, and compatibility/performance costs; bubblewrap remains the smallest unprivileged default. |
| Fall back to bubblewrap when gVisor fails | Silently changes the selected boundary; the provider contract requires fail-closed behavior. |
| Claim Docker rootless or signed image provenance from this run | The measured daemon was rootful `28.0.4`; rootless Docker and signed images remain unverified. |

## Consequences

- gVisor is a first-class explicit provider with a measured 21-case production path, per-case
  evidence, fail-closed selection, cleanup, and repository-pinned runtime/rootfs provenance.
- The runtime/rootfs provenance is content attestation, not a signed release. The unsigned pin
  and manifest, Debian snapshot availability, metadata exclusion, and host-writer trust remain
  explicit residuals (F-017); F-018 is closed because the base image, apt snapshot, and package
  versions are pinned and independent image builds agree. gVisor is still not the Linux default.
- The Docker row now states the measured engine (`28.0.4`) and daemon mode (**rootful**); the
  earlier unstated-daemon residual is closed, while rootless Docker remains open.
- Bubblewrap remains the Linux default because it is the simplest unprivileged boundary here,
  with no daemon, image, or external runtime/rootfs. Docker is the aggregate-cgroup/container
  option. gVisor is the opt-in user-space-kernel option for operators who accept its runtime and
  rootfs cost.
- The gVisor CI step is part of the security maintenance surface: `runsc` release updates,
  rootfs rebuilds, Sentry behavior, and GitHub-runner kernel changes must be re-drilled.

## Amendment — signed pin and rootfs manifest (2026-11-11)

The pin and rootfs manifest are now authenticated with detached Ed25519 statements verified
against `tools/security/trust-root.json`; a public key shipped beside an artifact is never
trusted. The provider requires the signed manifest's `rootfs_sha256`/`entries` to equal the
measured rootfs, and that measurement is the one materialized and re-checked for execution.
The checked-in trust root is empty until provisioned, so the provider fails closed by
default. Sigstore keyless verification was evaluated and rejected as the primary path because
it requires network access to Fulcio/Rekor; no Sigstore or SLSA conformance is claimed.
