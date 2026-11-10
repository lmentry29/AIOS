# Validation Ledger

Every entry records what actually ran. Dates are UTC. A result is only entered after the
command's exit status was observed; skipped or unavailable checks are recorded as such.

## 2026-11-10 — sandbox boundary validation

Host: Linux `freestyle-vm` 6.1.102 x86_64 (cloud VM), Node v26.13.0, pnpm 11.11.0.
User: unprivileged UID with an empty effective capability set (`CapEff: 0000000000000000`).

| Check | Command | Observed result |
|---|---|---|
| Unprivileged user namespaces | `unshare -Ur true` | exit 0 |
| User + network namespace | `unshare -Urn true` | exit 0 |
| Full namespace set | `unshare -Urmpf --mount-proc true` | exit 0 |
| Docker daemon | `docker info --format '{{.ServerVersion}}'` | permission denied on `/var/run/docker.sock` — **container boundary unverified** |
| bubblewrap availability | extract `bubblewrap_0.9.0-1ubuntu0.3_amd64.deb`; `bwrap --version` | `bubblewrap 0.9.0` |
| macOS Seatbelt | platform check | not macOS — **unverified** |
| gVisor / Apple Containerization | not installed | **not integrated / unverified** |

Live provider suite: `AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run tests/sandbox-live.test.ts` → **9 passed**.

Cases and observed behaviour:

1. Provider probe passes (`bwrap --unshare-all` on this kernel).
2. `cat /etc/shadow` fails and prints no credential material.
3. A workspace symlink to `/etc/shadow` is not readable.
4. `/proc/net/dev` shows only `lo:`; no `eth0`.
5. Host environment is cleared; only `LANG=C` from the run spec is visible; a planted host variable does not appear.
6. `echo $$` is ≤ 3, confirming a private PID namespace.
7. `touch /usr/escape` fails (`rc=1`) while `/workspace/inside` is writable.
8. `CapEff` is all zeros inside the sandbox.
9. A 120-second background workload ends with the boundary as a timeout; `--die-with-parent` prevents survival.

Process cleanup tests: `vitest run tests/process.test.ts tests/execution.test.ts` → **10 passed**, including a real parent+grandchild killed on timeout and a real child killed on abort.

Full host suite: `pnpm --filter @aios/host test` → **109 passed, 9 skipped** (the 9 skips are the live suite when `AIOS_BWRAP_DIR` is unset; this run is recorded above with it set).

## What these results do not establish

- No container escape, kernel exploit, or privilege-escalation research was attempted.
- bubblewrap is a shared-kernel boundary; the results do not transfer to Docker, gVisor, Seatbelt, or Apple Containerization.
- The Docker adapter's isolation flags were inspected and unit-tested for argv shape, not executed against a daemon.
- No resource-exhaustion benchmark (CPU/memory/disk) was run; the cgroup gap remains open.

## 2026-11-10 — CI live boundary

On `ubuntu-24.04` GitHub runners, `bwrap` installed from `noble-updates` (0.9.0-1ubuntu0.3)
but the provider probe failed before any case ran: Ubuntu 24.04 restricts unprivileged user
namespaces through AppArmor. The Security workflow now sets
`kernel.apparmor_restrict_unprivileged_userns=0` (falling back to
`kernel.unprivileged_userns_clone=1`) for the job before running the suite. This is a
runner-level test prerequisite, not a production hardening step: a host that ships with the
restriction keeps it, and the provider still fails closed when it cannot create a namespace.

## 2026-11-10 — journal compaction and recovery drill

Host: Linux 6.1.102, Node 26.13.0, pnpm 11.11.0. Commands actually run:

```sh
pnpm --filter @aios/host run build
node tools/security/journal-drill.mjs
pnpm --filter @aios/host test
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run tests/sandbox-live.test.ts
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
```

Drill output (verbatim, exit 0):

```json
{"step":"size_limit","ok":true,"appended":11,"journal_bytes":3820}
{"step":"compact","ok":true,"records_archived":11,"bytes_before":3820,"bytes_after":456,"archive_sha256":"46b927e19f75b737e524e108e79713dddc8104c65675592f0f93b6372328e327","append_after_compaction":true}
{"step":"corruption_detected","ok":true,"corrupted_offset":340}
{"step":"restore","ok":true,"records":11,"head_hash":"4bf92106b92a7f8ef63a958fb9cb060d65aa247c38376279caed2223d8429b2d","backup_created":true}
{"step":"restore_idempotent","ok":true,"unchanged":true}
{"step":"tampered_archive_rejected","ok":true}
{"step":"known_good_state","ok":true,"kinds":["probe"]}
{"drill":"journal-recovery","ok":true,"steps":7}
```

- Journal recovery regressions: **5 passed** (`journal-recovery.test.ts`): size-limit compaction and continued appends, byte-corruption detection with restore and backup, tampered-archive rejection with the target byte-identical, restore idempotency plus refusal to overwrite a different valid journal, and verifier acceptance of the true result with rejection of a forged result after compact-and-reopen.
- Host suite after the change: **117 passed, 9 skipped**; the 9 skips are the live suite when `AIOS_BWRAP_DIR` is unset. The same live suite passed **9/9** with the real binary.
- Full workspace gate (`build`, `typecheck`, `lint`, `test`) exited 0.

Limits of this evidence: the archive is not signed or encrypted, restore is offline only, and no multi-host or concurrent-restore drill was attempted (the journal lock refuses a live host).

## 2026-11-10 — live per-run workspace disk quota (F-004)

Host: Linux 6.1.102 x86_64, Node 26.13.0, pnpm 11.11.0, unprivileged UID. `bwrap` 0.9.0 at
`/tmp/bwrap-root/usr/bin`. Commands actually run, in this order:

```sh
pnpm --filter @aios/host run build
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/workspace-quota.test.ts tests/workspace-quota-live.test.ts tests/config.test.ts \
  tests/execution.test.ts tests/verifier-binding.test.ts tests/managed-execution.test.ts
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
node tools/security/scan-secrets.mjs
node tools/security/audit-policy.mjs
```

Focused quota/config/execution/verifier suites: **32 passed** (5 new quota regressions, 2 of
them live-drill regressions in the live run below). Full workspace gate: **46/46 tasks
successful**, host **122 passed, 11 skipped** (the 11 skips are the live suites without
`AIOS_BWRAP_DIR`). Live boundary plus quota suites with the real binary: **11 passed** (9
existing boundary cases and 2 new quota drills).

Drill output (verbatim, exit 0):

```json
{"drill":"workspace-quota","cap_bytes":1048576,"over_cap":{"error":"WorkspaceQuotaExceededError","message":"Workspace exceeded its 1048576-byte limit; the run was stopped.","workspace_entries":0,"matching_processes":0},"under_cap":{"provider":"bubblewrap","exit_code":"0","workspace_entries":1,"workspace_bytes":65536},"sequential":{"provider":"bubblewrap","workspace_entries":2,"workspace_bytes":[65536,32768]}}
```

Observed properties:

- The over-cap task ran a continuously appending writer under real bubblewrap. It was stopped
  while live, raised `WorkspaceQuotaExceededError`, left **0** workspace entries (discarded),
  and left **0** processes matching its unique command marker. It was never reported as a
  success.
- The under-cap task completed under bubblewrap with exit code 0 and exactly 65,536 bytes in
  its own workspace. A second sequential task completed independently at 32,768 bytes; the
  first run's ceiling did not affect it. The existing 9-case live boundary suite still passed.
- The managed lifecycle test journals `state: failed` with `reason_code:
  disk_quota_exceeded`; the verifier rejects that attempt with its execution ID, attempt, and
  `failure_evidence_sha256`, rather than accepting a caller-supplied result. The verifier's own
  over-cap command is also rejected and its workspace discarded.
- `secret-scan: no findings across 261 tracked files`; `audit-policy: no untriaged high or
  critical advisories (1 triaged)` (zod GHSA-mrhx-c7xc-m3w5).

Limits of this evidence: this is host-side **sampling enforcement**, not a filesystem or block
quota. The 25 ms interval allows a fast writer to overshoot before abort; the final sample and
discard bound retained state, not the transient write. Symlinks are skipped, hardlinks are
counted per name, and writes outside `/workspace` are not attributed to the run (`/tmp` is a
separate 64 MiB tmpfs, other tmpfs paths are not). Docker, gVisor, Seatbelt, and Apple
Containerization remain unverified. See ADR-0026 and F-004.

## 2026-11-10 — bubblewrap seccomp system-call filter (F-007)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. Active LSM list read from `/sys/kernel/security/lsm`:
`capability,selinux` — **no Landlock**. `bwrap --help` advertises `--seccomp FD` and
`--add-seccomp-fd FD`; a manual probe with a generated filter reported `Seccomp: 2` and
`Seccomp_filters: 1` inside the namespace. Commands actually run:

```sh
pnpm --filter @aios/host run build
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
node tools/security/scan-secrets.mjs
node tools/security/audit-policy.mjs
```

Full workspace gate: **46/46 tasks successful**; host **129 passed, 14 skipped** (the 14 skips
are the live suites without `AIOS_BWRAP_DIR`). Live suites with the real binary: **14 passed**
(9 existing boundary cases, 3 new seccomp cases, 2 existing quota cases). The CI live job was
updated to run all three live files, not only the original boundary file.

Drill output (verbatim, exit 0):

```json
{"drill":"seccomp-filter","kernel":"6.1.102","provider":"bubblewrap","filter":{"profile":"aios-seccomp-deny-v1-x64","sha256":"12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac","applied":true,"seccomp_mode":"2"},"denied":{"error":"SandboxSyscallDeniedError","message":"The sandboxed command was killed by the system-call filter for using a denied syscall.","filter_sha256":"12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac","workspace_entries":0,"matching_processes":0},"legitimate":{"provider":"bubblewrap","exit_code":"0","filter_applied":"true"},"next":{"exit_code":"0","workspace_entries":2}}
```

Observed properties:

- The ordinary probe and legitimate run both report `Seccomp: 2` and filter SHA-256
  `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`; the executor records
  `syscall_filter`, `syscall_filter_sha256`, and `syscall_filter_applied:true` in successful
  evidence.
- A run that executed `/usr/bin/unshare -U true` was killed with bwrap status 159 (SIGSYS) and
  mapped to `SandboxSyscallDeniedError`. The managed lifecycle test records
  `sandbox_syscall_denied`; the verifier rejects the failed attempt with its execution id,
  attempt, `failure_evidence_sha256`, and `failed_sandbox_filter_sha256` instead of accepting
  a caller-supplied result.
- The denied run left **0** workspace entries after discard and **0** processes matching its
  unique marker. It was never reported as success.
- The legitimate run exited 0 and the following run exited 0 in its own workspace (2 retained
  workspaces), proving the denial is per-run and does not poison later execution.
- Filter preflight failure is separately mapped to `sandbox_filter_unavailable`; a missing
  per-run marker or failed verifier filter proof is rejected, not accepted.The filters are installed through `--seccomp 3` on the same `bwrap` invocation that already applies the
  filesystem, PID, network, capability, and `/tmp` controls.
- `secret-scan: no findings across 265 tracked files`; `audit-policy: no untriaged high or
  critical advisories (1 triaged)` (zod GHSA-mrhx-c7xc-m3w5).

Limits of this evidence: the filter is a **deny-list**, so unlisted syscalls remain available;
Landlock is not active on this kernel; the arm64 profile table was generated but not live-run
on this x86_64 host; Docker, Seatbelt, gVisor, and Apple Containerization remain unverified;
the shared host kernel remains in scope; there is no cgroup CPU/memory accounting or hard disk
quota. See ADR-0027 and F-007.
