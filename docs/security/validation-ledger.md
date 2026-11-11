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
| gVisor / Apple Containerization | not installed at the first pass | gVisor measured later (ADR-0032); Apple Containerization unavailable |

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
- The original boundary pass did not run a resource-exhaustion benchmark; the later F-003 section records the real memory/CPU/process-limit drill. Aggregate cgroup accounting remains open.

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
on this x86_64 host; at this checkpoint Docker, Seatbelt, gVisor, and Apple Containerization were
unverified; Docker and gVisor are now measured (ADR-0031/ADR-0032), while Seatbelt/Apple remain
unavailable. The shared host kernel remains in scope; there is no aggregate cgroup CPU/memory
accounting or hard disk quota. See ADR-0027 and F-007.

## 2026-11-10 — bubblewrap per-run resource limits (F-003)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`, util-linux `prlimit` 2.39.3 at `/usr/bin/prlimit`. A manual probe
confirmed `bwrap --help` has no `--rlimit` option and that `prlimit --as/--cpu/--nproc` applies
the limits inside the user namespace while `Seccomp: 2` remains active. Commands actually run:

```sh
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
node tools/security/scan-secrets.mjs
node tools/security/audit-policy.mjs
```

Full workspace gate: **46/46 tasks successful**; host **131 passed, 17 skipped** (the 17 skips
are the live suites without `AIOS_BWRAP_DIR`). Live suites with the real binary: **17 passed**
(12 boundary/limit cases, 3 seccomp cases, 2 quota cases). The 12 boundary/limit cases include
the exact-limit report, the ordinary Perl run, and the memory bomb below. Secret scan: **no
findings across 270 tracked files**; audit policy: **no untriaged high or critical advisories
(1 triaged)** (zod GHSA-mrhx-c7xc-m3w5).

Drill output (verbatim, exit 0):

```json
{"drill":"bubblewrap-resource-limits","kernel":"6.1.102","provider":"bubblewrap","limits":{"memory_bytes":1342177280,"cpu_seconds":5,"processes":128,"applied":true},"limits_report":["v=1310720 t=5","Max processes             128                  128                  processes ","Seccomp:\t2","Seccomp_filters:\t1"],"filter":{"profile":"aios-seccomp-deny-v1-x64","sha256":"12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac","applied":true,"seccomp_mode":"2"},"legitimate":{"exit_code":"0","resource_limits_applied":"true"},"memory_bomb":{"exit_code":1,"timed_out":false,"stderr":"Out of memory!"},"host_mem_available_kb":{"before":15878684,"after":15875512}}
```

Observed properties:

- The production invocation is `/usr/bin/prlimit --as=1342177280 --cpu=<ceil(deadline/1000)>
  --nproc=128 -- /bin/sh -c <fixed wrapper> ...argv` inside the existing
  `--unshare-all`/`--seccomp 3`/capability-drop/read-only-bound boundary. No test-only
  helper installs the limits.
- The wrapper observed `v=1310720` KiB, `t=5`, `Max processes 128 128 processes`, and
  `Seccomp: 2` / `Seccomp_filters: 1`, then reported `limits.applied:true` and
  `filter.applied:true`. Both proofs are written on the inherited fd before exec; missing or
  mismatched values deny the run.
- The ordinary Perl run completed with exit 0 and executor evidence
  `resource_limits_applied:true`, `resource_limit_memory_bytes:1342177280`,
  `resource_limit_cpu_seconds:15`, and `resource_limit_processes:128` while retaining
  `syscall_filter_applied:true`.
- The Perl memory bomb exited 1 with `Out of memory!` and `timed_out:false` — it was stopped
  by `RLIMIT_AS`, not the deadline. `MemAvailable` remained in the same range (15,878,684 to
  15,875,512 KiB); that observation is illustrative, not a memory-pressure proof.
- Regression tests: `tests/seccomp.test.ts` adds two cases for missing limit proof (executor
  journals `sandbox_resource_limit_unavailable` and verifier rejects the failed attempt;
  verifier rejects its own missing proof). `tests/sandbox-live.test.ts` adds three real
  bwrap cases. `tools/security/resource-limit-drill.mjs` records the same provider path.

Limits of this evidence: these are **per-process** kernel limits, not cgroup aggregate
accounting. Up to 128 descendants can each reserve the 1.25 GiB address-space cap, RLIMIT_AS
is not RSS, and CPU limits are per-process. The existing F-007 deny-list still kills Node/libuv
at startup because libuv probes `io_uring_setup`; the drill uses Perl, which does not probe
io_uring. At this checkpoint Docker, gVisor, Seatbelt, and Apple Containerization were unverified
or unavailable; Docker and gVisor are now measured (ADR-0031/ADR-0032), while Seatbelt/Apple
remain unavailable. The shared kernel remains in scope. See ADR-0028 and F-003.

## 2026-11-10 — Zod advisory closure and blocked-finding mitigations (`24d2791`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. F-014 was selected as the highest-severity genuinely actionable
open finding; F-005 needs macOS/Apple hardware and F-009 needs external key custody.

Commands actually run, in this order:

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm --filter @aios/core run generate:schemas
pnpm --filter @aios/core test
pnpm --filter @aios/objects test
pnpm --filter @aios/founder test
pnpm --filter @aios/founder typecheck
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
```

Observed results at code head `24d2791`:

- Schema generation wrote 10 files/40 schemas. The committed generated diff is **122 additions,
  0 deletions**: UUID/date-time `pattern` keywords, safe-integer `maximum`, and record
  `propertyNames`. It is not a reference-only or empty output, and `additionalProperties:false`
  remains on every object. `json-schema-contract.test.ts` is 5/5.
- Core **47 passed**; objects **32 passed**; founder **62 passed**, including the new policy
  artifact-digest substitution rejection. Host focused execution tests **8 passed**, including
  the non-macOS Seatbelt fail-closed case. Full workspace gate: **46/46 tasks successful**;
  host **132 passed, 17 skipped** (the 17 skips are the live suites without `AIOS_BWRAP_DIR`).
- Real bubblewrap suite with `AIOS_BWRAP_DIR` set: **17/17 passed** (12 boundary/limit, 3
  seccomp, 2 quota). Resource-limit drill: legitimate Perl exit 0 with
  `resource_limits_applied:true`; memory bomb exit 1, `Out of memory!`, `timed_out:false`;
  filter `Seccomp: 2`, profile SHA-256
  `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`.
- Quota drill: over-cap run stopped/discarded with 0 workspace entries and 0 matching
  processes; under-cap 65,536 bytes; sequential 65,536 and 32,768 bytes. Seccomp drill: denied
  run stopped with 0 workspace entries/0 processes; legitimate and next runs exit 0.
- `audit-policy: no untriaged high or critical advisories (0 triaged)` — the temporary
  GHSA-mrhx-c7xc-m3w5 exception is gone. `secret-scan: no findings across 272 tracked files`.

What is verified versus not:

- **Verified on this host:** the zod 4.6.7 upgrade, native draft-07 generation, schema
  constraints, policy-event digest binding, Seatbelt non-macOS fail-closed behavior,
  bubblewrap boundary/seccomp/quota/resource limits, process cleanup, and verifier binding.
- **Not verified:** real Seatbelt profile enforcement (no macOS host), Apple Containerization,
  Docker/rootless cgroup behavior, gVisor, Landlock, aggregate cgroup memory/CPU accounting,
  a hard filesystem quota, and external policy signing/key custody. F-005 and F-009 remain
  accepted with the exact blockers recorded in the findings ledger; F-006 remains unverified.

## 2026-11-10 — Bounded collection re-verification (`8ca3e9c`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This is a second F-014 pass: the Zod 4.6.7 upgrade alone was
insufficient because 4.6.6+ only short-circuits an oversized array when the schema declares
an upper bound, and 20 canonical arrays were still unbounded.

Commands actually run, in this order:

```sh
pnpm --filter @aios/core run generate:schemas
pnpm --filter @aios/core exec vitest run tests/schema.test.ts tests/json-schema-contract.test.ts
node tools/security/collection-bound-drill.mjs
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed results at code head `8ca3e9c`:

- Generation wrote 10 files/40 schemas. The generated diff is **53 additions, 0 deletions**:
  every previously unbounded array now emits `maxItems`. Ordinary collections use 256;
  `lifecycle_history` and `project_status_history` use 1,024. `json-schema-contract.test.ts`
  recursively requires a finite `maxItems` on every generated array and checks Task `actions`
  at 256; the runtime schema test accepts 256 relationships and rejects 257.
- Collection drill: 1,000,000 invalid Action entries under `--max-old-space-size=64` produced
  `success:false`, `issue_count:1`, `elapsed_ms:12`; the collection bound rejected the array
  before parsing elements instead of accumulating a million issues.
- Core **49 passed**; full workspace gate **46/46 tasks successful**; host **132 passed, 17
  skipped** without `AIOS_BWRAP_DIR`; live bwrap suite **17/17 passed**; resource-limit, quota,
  and seccomp drills all exit 0 with the same limit/filter evidence recorded above.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 272 tracked files`.

What is verified versus not:

- **Verified:** the dependency upgrade, native draft-07 generation with `maxItems`, runtime
  rejection of an oversized array, the generated-contract invariant, and the bounded-memory
  collection drill. The bubblewrap/seccomp/quota/resource guarantees from the prior pass are
  unchanged and were re-run.
- **Not verified at this head:** F-015 remained open. `TaskExecutionSpec.env` was a
  `z.record`; Zod 4.6.7 has no record `.max()`, and a direct 100,000-key invalid parse emitted
  100,000 issues in 626 ms. External `/v1/intake` was capped by `request_body_limit_bytes`
  (default 256 KiB, maximum 1 MiB), which limited but did not remove the amplification. This
  was the state at `8ca3e9c`; F-015 is closed by the follow-up below. Docker/gVisor/Seatbelt/Apple Containerization,
  Landlock, aggregate cgroups, hard disk quotas, and external policy signing remain unverified.

## 2026-11-10 — Task environment bound closure (`43e2dd6`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This closes F-015, the record residual found after the array-bound
pass.

Commands actually run, in this order:

```sh
pnpm --filter @aios/core run generate:schemas
pnpm --filter @aios/core test
node tools/security/collection-bound-drill.mjs
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed results at code head `43e2dd6`:

- Generation wrote 10 files/**41 schemas** (the new `TaskEnvironment` definition is included).
  `TaskExecutionSpec.env` and `TaskEnvironment` both emit `maxProperties: 64`, key
  `propertyNames.maxLength: 64`, and `additionalProperties.maxLength: 256`. An unknown custom
  type still fails generation; the generator only accepts the explicit description-bound
  contract.
- Runtime test: 64 environment entries are accepted; the 65th is rejected. The custom
  validator counts with an early exit, so it does not allocate an entry array or inspect
  values after the limit.
- Extended collection drill, both cases under `--max-old-space-size=64`: 1,000,000 invalid
  Actions produced `issue_count:1`, `elapsed_ms:17`; 100,000 environment keys produced
  `issue_count:1`, `elapsed_ms:105`. No child was killed and no per-entry issue accumulation
  occurred.
- Core **51 passed**; full workspace gate **46/46 tasks successful**; live bwrap suite
  **17/17 passed**; resource-limit, quota, and seccomp drills all exit 0 with the same
  limit/filter evidence recorded above.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 273 tracked files`.

What is verified versus not:

- **Verified:** F-015 is schema-bounded at 64 entries, with an explicit generated cross-runtime
  contract and a bounded-memory attack drill. The array bounds and bubblewrap/seccomp/quota/
  resource guarantees from the prior passes were re-run unchanged.
- **Not verified:** Docker/gVisor/Seatbelt/Apple Containerization, Landlock, aggregate cgroups,
  hard disk quotas, and external policy signing remain unverified. The host allowlist and
  256 KiB default request-body cap remain defense in depth, not substitutes for the schema
  bound.

## 2026-11-11 — Durable host session lifecycle (F-013 closure)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This pass tested the production identity path, not a test shim:
configuration parsing, the durable operational journal, HTTP authorization, route bindings,
restart recovery, compaction, and the live sandbox/security suites were all exercised.

Commands actually run, in this order:

```sh
pnpm --filter @aios/host typecheck
pnpm --filter @aios/host exec vitest run tests/session-lifecycle.test.ts tests/identity.test.ts \
  tests/persistence.test.ts tests/journal-recovery.test.ts
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/collection-bound-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed results at the F-013 implementation commit:

- Focused host typecheck passed. `session-lifecycle.test.ts` **6 passed**, `identity.test.ts`
  **9 passed**, `persistence.test.ts` **13 passed**, `journal-recovery.test.ts` **5 passed**.
  The lifecycle cases cover controlled-clock expiry, rotation-then-replay, revocation-then-
  replay, cross-task/run/evidence binding, rotation with an in-flight authorized run, restart
  recovery, compaction, and refusal to reintroduce a session removed from configuration.
- Full workspace gate: **46/46 tasks successful**; host **148 passed, 17 skipped** (the 17
  live cases are skipped without `AIOS_BWRAP_DIR`); host includes `http-host.test.ts` **57
  passed** and `identity.test.ts` **9 passed**; core **51 passed**.
- Live bubblewrap suite with `AIOS_BWRAP_DIR`: **17/17 passed** (12 boundary/limit, 3 seccomp,
  2 quota). Resource-limit drill: legitimate Perl exit 0 with `resource_limits_applied:true`;
  memory bomb exit 1, `Out of memory!`, `timed_out:false`; filter `Seccomp: 2`, profile
  SHA-256 `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`.
- Quota drill: over-cap run stopped/discarded with 0 workspace entries and 0 matching
  processes; under-cap 65,536 bytes; sequential 65,536 and 32,768 bytes. Seccomp drill:
  denied run stopped with 0 workspace entries/processes; legitimate and next runs exit 0.
  Collection drill: 1,000,000 invalid Actions rejected before entry parsing under a 64 MiB
  heap (`issue_count:1`, 17 ms); 100,000 environment keys rejected in 140 ms.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 273 tracked files`.

What is verified versus not:

- **Verified:** expired, unknown, malformed, rotated-away, revoked, and cross-scope tokens are
  denied in the real HTTP authorization path with distinguishable reasons; rotation and
  revocation state is journaled before acknowledgement and reconstructed after restart and
  compaction; rotation cannot broaden scope; an already-authorized in-flight run completes;
  evidence scope is checked against the recomputed digest. Existing bubblewrap/seccomp/quota/
  resource and independent-verifier controls were re-run unchanged.
- **Not verified:** login/MFA, token-theft detection, rate limiting, TLS on loopback,
  multi-process or multi-host session replication, detached journal signatures, real
  Seatbelt/Apple Containerization, Docker/gVisor, Landlock, aggregate cgroups, hard disk
  quotas, and external policy signing. These remain recorded residuals, not silently
  downgraded controls.

## 2026-11-11 — Human-only operator session administration (`27ab654`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This pass tested the operator incident path through the compiled
`aios-host` binary and a real host process, not a unit-level shim. The drill boots the real
server, provisions a real durable policy, and drives the CLI as a child process.

Commands actually run, in this order:

```sh
pnpm --filter @aios/host run build
node tools/security/session-operator-drill.mjs
pnpm --filter @aios/host exec vitest run tests/session-operator.test.ts \
  tests/session-lifecycle.test.ts tests/identity.test.ts
pnpm --filter @aios/founder exec vitest run tests/authorization.test.ts
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
node tools/security/collection-bound-drill.mjs
node tools/security/session-operator-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed results at code head `27ab654`:

- Operator drill: **13 steps, exit 0**. Verbatim from the first full run; the second run in
  the drill sweep reproduced the same steps with a fresh policy id and port:

```json
{"step":"provision","ok":true,"policy_id":"3367e0c6-253f-4363-b75c-54e117f18dff","sessions":3}
{"step":"host_started","ok":true,"port":34845,"dispatch":false}
{"step":"list_sessions","ok":true,"total":3,"digests_exposed":false}
{"step":"denied_non_human","ok":true,"exit_code":3}
{"step":"denied_unknown_token","ok":true,"exit_code":3}
{"step":"rejects_unsafe_token_file","ok":true,"exit_code":2}
{"step":"not_found","ok":true,"exit_code":4}
{"step":"rotate_live","ok":true,"generation":2,"old_reason":"rotated_token","new_status":200}
{"step":"rotation_replay_denied","ok":true,"http_status":401,"exit_code":3}
{"step":"revoke_live","ok":true,"idempotent":true,"revoked_reason":"revoked_token","rotate_exit_code":5}
{"step":"scoped_admin_denied","ok":true,"exit_code":3,"reason":"scope_binding_required"}
{"step":"restart_recovery","ok":true,"rotated_denied":true,"revoked_denied":true,"new_generation":2}
{"step":"no_token_leakage","ok":true,"journal":"clean","audit":"clean","cli_outputs":12}
{"drill":"session-operator","ok":true,"steps":13}
```

- Focused host suites: **19 passed** (`session-operator` 4, `session-lifecycle` 6,
  `identity` 9); founder `authorization.test.ts` **25 passed**.
- Full workspace gate, forced with no cache: **46/46 tasks successful**; host **152 passed,
  17 skipped** (169 total; the 17 skips are the live suites without `AIOS_BWRAP_DIR`);
  founder **63**; core **51**; conformance **107**; integration **43**; objects **32**;
  orchestration **30**; tools **9**; work-hierarchy **24**; containers **21**; learning **28**;
  agents **6**.
- Live bubblewrap suite: **17/17 passed**. Resource-limit drill: legitimate Perl exit 0 with
  `resource_limits_applied:true`; memory bomb exit 1, `Out of memory!`, `timed_out:false`;
  `Seccomp: 2`, filter SHA-256
  `12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`. Quota drill:
  over-cap run stopped/discarded with 0 workspace entries and 0 matching processes;
  under-cap 65,536 bytes; sequential 65,536 and 32,768 bytes. Seccomp drill: denied run
  stopped with 0 workspace entries/processes; legitimate and next runs exit 0. Collection
  drill: 1,000,000 invalid Actions produced one issue in 16 ms; 100,000 environment keys
  produced one issue in 116 ms, both under a 64 MiB heap.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 276 tracked files`.

Observed operator properties:

- `list-sessions` returned exactly the three granted sessions in order, total 3, with no
  `token_sha256` field and no 64-hex string. A non-human agent session and an unknown token
  were both exit `3` (`human_principal_required`, `unknown_token`); a group/world-readable
  token file was exit `2` before any request; an ungranted missing UUID was exit `4` only
  after authorization on that UUID.
- Rotation through the compiled CLI returned one token and generation 2. The old token was
  denied as `rotated_token` on the live path and through the CLI (exit `3`), while the new
  token authenticated. Rotating the revoked executor session was exit `5`
  `session_conflict`.
- Revocation denied the executor on its next request (`revoked_token`), the repeat returned
  `already_revoked:true` with exit `0`, and both denials survived a real SIGTERM and restart
  of the host process, where the new generation still authenticated.
- A scoped founder token could not use the admin surface (exit `3`
  `scope_binding_required`), so session administration cannot be reached through a narrowed
  token.
- The operational journal contained `session_rotated` and `session_revoked` records, and the
  authorization audit contained `administer_sessions` decisions; neither contained any
  plaintext token from the drill. No CLI stdout/stderr other than the rotation result
  contained one, and no CLI command line carried a token.

What is verified versus not:

- **Verified:** the documented CLI works against a live host; operator actions are
  exact-granted and human-only; the list is filtered and digest-free; mutation commits before
  acknowledgement through the same durable store the authenticator uses; refusal is
  distinguishable by exit code; retired tokens stay retired across restart; and no token
  material reached argv, logs, the operational journal, or the authorization audit.
- **Not verified:** step-up/MFA or quorum for the operator grant, TLS or rate limiting on
  loopback, multi-host session replication, external audit custody, and the existing sandbox
  matrix gaps (Docker/gVisor/Seatbelt/Apple Containerization, Landlock, aggregate cgroups,
  hard disk quotas, external policy signing). The operator token is a bearer credential: an
  attacker who can read its owner-only file has the same authority. See ADR-0030, F-013, and
  `docs/security/session-operator-runbook.md`.

CI on the exact pushed head `15bc7f8`: `ci` run `42933005083` — success; `conformance` run
`42933005064` — success; `schema-check` run `42933005025` — success; `security` run
`42933005020` — success (both live-boundary and supply-chain jobs); `release` run
`42933109086` — success (`workflow_dispatch` on the branch head, since the workflow has no
push trigger). PR #1 remained open, draft, and unmerged; `main` stayed at `767f30e`.

## 2026-11-11 — CI guard for operator session administration (`550d0e5`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This pass makes the operator drill a required CI step in the
Security workflow and demonstrates both directions: a non-zero drill exit fails the job, and
the real drill passes in the actual run.

Workflow change: `.github/workflows/security.yml` adds, after the existing resource-limit
drill in the `sandbox-live` job, in the same plain `run:` pattern and with no permission,
action, or isolation change:

```yaml
      # Operator CLI against a real host process: list/rotate/revoke, live denial, restart.
      - run: node tools/security/session-operator-drill.mjs
```

The step inherits the job's `/usr/bin/bash -e {0}` shell, so a non-zero drill exit fails the
step and the job. That was not assumed: a temporary probe commit (`fb7090a`) made the drill
exit 1, and the actual run demonstrated the failure. The probe was removed in `550d0e5`; the
branch retains both commits so the demonstration is auditable.

Commands actually run locally, in this order:

```sh
git show 6dfdbf0:tools/security/session-operator-drill.mjs > tools/security/session-operator-drill.mjs
node tools/security/session-operator-drill.mjs
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
node tools/security/collection-bound-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed at final code head `550d0e5`:

- Operator drill: **13/13 steps, exit 0** (`no_token_leakage`, `steps:13`).
- Full workspace gate, forced with no cache: **46/46 tasks successful**; host **152 passed,
  17 skipped**; founder **63**; core **51**; conformance **107**; integration **43**; objects
  **32**; orchestration **30**; tools **9**; work-hierarchy **24**; containers **21**;
  learning **28**; agents **6**. Counts are unchanged from `27ab654`; no test or assertion was
  removed or weakened.
- Live bubblewrap suite: **17/17 passed**. Resource-limit, workspace-quota, seccomp, and
  collection drills all exit 0.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 281 tracked files`.

CI evidence, read from the run jobs and step logs rather than inferred from the conclusion:

- **Failure propagation, probe head `fb7090a`:** Security run `42934134785`, job
  `130239870814` (`Live sandbox boundary`) concluded `failure`; step 11
  `Run node tools/security/session-operator-drill.mjs` concluded `failure`, with
  `{"drill":"session-operator","ok":false,"error":"intentional CI failure-propagation probe"}`
  and `##[error]Process completed with exit code 1.`
- **Real drill, final code head `550d0e5`:** Security run `42934563018`, job `130241299391`
  concluded `success`; step 11 concluded `success`. The step log recorded all 13 drill lines:
  `list_sessions` (total 3, no digests), exit codes `3`/`2`/`4`, `rotate_live` generation 2
  with `rotated_token`, `rotation_replay_denied`, idempotent `revoke_live` with
  `revoked_token`, `scoped_admin_denied` (`scope_binding_required`), `restart_recovery`,
  `no_token_leakage`, and `{"drill":"session-operator","ok":true,"steps":13}`.

The workflow gained no permission, action, or unpinned dependency. The probe commit exists
only to prove exit propagation; the final tree is the real drill.

What is verified versus not:

- **Verified:** the Security workflow executes the operator drill on every pull request; the
  step fails the job on a non-zero drill exit; the real drill passes in CI with all 13 steps;
  local counts, live suite, and every security drill are unchanged.
- **Not changed:** no sandbox, authentication, scope, verifier, policy, or journal behavior was
  modified by this pass. The operator-surface residuals in ADR-0030 (bearer operator token
  without step-up/MFA, loopback HTTP, one-time rotation delivery, single-process state) remain.

## 2026-11-11 — Adversarial sandbox and verifier drill (`29eb496`)

Host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0, `bwrap 0.9.0` at
`/tmp/bwrap-root/usr/bin`. This pass adds `tools/security/adversarial-drill.mjs`, which
attempts hostile operations against the production provider, executor, durable execution
ledger, and verifier. No attack uses a test double: every boundary case calls
`createSandboxProvider({ provider: 'bubblewrap' })`; the verification cases use
`ManagedExecutionPort`, `DurableOperationalStore`, the durable `ExecutionLedger`, and
`LocalCommandVerifier`.

Commands actually run, in this order:

```sh
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
for d in resource-limit workspace-quota seccomp collection-bound session-operator journal; do
  AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/$d-drill.mjs
done
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/adversarial-drill.mjs
node tools/security/audit-policy.mjs
node tools/security/scan-secrets.mjs
```

Observed at `29eb496`: **21/21 cases `denied:true`**, final result
`all adversarial cases denied or contained`.

| # | Attack | Measured denial or containment |
|---|---|---|
| 1 | Host file read (`/etc/shadow`) | exit 1; no `root:` bytes; filter SHA-256 `12e5ae01…1fbaac` applied |
| 2 | Path traversal (`../../etc/shadow`, `/workspace/../etc/shadow`, `/proc/1/root/etc/shadow`) | exit 1; no shadow content |
| 3 | Symlink chain to `/etc/shadow` | exit 1; no shadow content |
| 4 | Hardlink `/etc/shadow` into `/workspace` | `rc=1`; no host-file link created |
| 5 | Task cwd `../../etc` and absolute cwd | `HostExecutionError` before spawn; no marker file |
| 6 | Writes to `/etc`, `/usr`, `/root` | no `wrote:` line; all host paths unchanged |
| 7 | Host environment secret | absent from `/usr/bin/env` and `/proc/self/environ`; only `LANG=C` declared |
| 8 | Host `/tmp` secret via `..`, `/proc/1/root`, and `/tmp` | secret bytes absent |
| 9 | TCP connect to a real host loopback listener | exit 1; listener accepted 0 connections |
| 10 | Raw socket without capabilities | exit 2; no raw-socket-open output |
| 11 | Capability/privilege escalation | `CapEff: 0`; mount syscall exit 159/SIGSYS; real `chroot` exit 125, `Operation not permitted` |
| 12 | CPU exhaustion | run with `RLIMIT_CPU` 3 s and `RLIMIT_NPROC` 128; burner stopped at 3,005 ms (`timedOut`, SIGKILL) |
| 13 | Fork/PID exhaustion | 126 children created, 128 namespaced processes, 0 marked survivors |
| 14 | Cancellation orphan cleanup | `cancelled:true`; 0 marked survivors after 300 ms |
| 15 | Timeout orphan cleanup | `timedOut:true`; 0 marked survivors after 300 ms |
| 16 | Disk exhaustion (64 KiB cap) | `WorkspaceQuotaExceededError`; 0 workspace entries; 0 marked survivors |
| 17 | Instruction smuggling in Task name/description/env | exact `argv_sha256`; env value stored literally (89 bytes); output `safe`; hostile text absent from evidence |
| 18 | Forged executor result | rejected: `The executor result does not match the durable attempt evidence.` |
| 19 | Self-issued verification | rejected before running: verifier must be independent from every executor |
| 20 | Artifact tampering after execution | independent verifier exited 1 instead of 0; `accepted:false` |
| 21 | Stale attempt-1 evidence after attempt 2 | attempt 1 rejected by the latest-attempt digest; attempt 2 accepted |

The drill’s CPU case proves the deadline/limit terminates the workload; the separate
`ulimit -t` probe and `resource_limit_cpu_seconds:3` evidence prove the exact limit was
installed. The memory-exhaustion case remains covered by `resource-limit-drill.mjs`.

- Full workspace gate, forced with no cache: **46/46 tasks successful**; host **152 passed,
  17 skipped**; founder **63**; core **51**; conformance **107**; integration **43**; objects
  **32**; orchestration **30**; tools **9**; work-hierarchy **24**; containers **21**;
  learning **28**; agents **6**. Counts are unchanged from `550d0e5`; no assertion was removed.
- Live bubblewrap suite: **17/17 passed**. Resource-limit, workspace-quota, seccomp,
  collection-bound, session-operator, and journal drills all exit **0**; adversarial drill
  **21/21**, exit **0**.
- `audit-policy: no untriaged high or critical advisories (0 triaged)`; `secret-scan: no
  findings across 281 tracked files`.

CI evidence, read from the actual jobs and step logs:

- **Failure propagation, probe head `c5a4a44`:** Security run `42936839536`, job
  `130248895128` (`Live sandbox boundary`) concluded `failure`; step 11
  `Run AIOS_BWRAP_DIR=... node tools/security/adversarial-drill.mjs` concluded `failure`, and
  the step log ended with `##[error]Process completed with exit code 1.` Step 12 (operator
  drill) was skipped. The probe was removed in `29eb496`.
- **Real drill, final code head `29eb496`:** Security run `42937205409`, job `130250095076`
  concluded `success`; step 11 concluded `success`. The step log contains 21 `"attack"`
  records and the final `"result":"all adversarial cases denied or contained"`; step 12 also
  passed. The drill step was added in the existing `sandbox-live` job in the same plain
  `run:` pattern, with no workflow permission, action, or isolation change.

What is verified versus not:

- **Verified:** the listed filesystem, secret, network, capability, resource, orphan,
  instruction-boundary, and verification attacks were denied or contained by the real
  production path; the CI step fails the job on a non-zero drill exit and passes the real
  21-case drill on the final head.
- **Not claimed / local-only:** Docker, Seatbelt, gVisor, and Apple Containerization remain
  unverified or unavailable; the CPU case was terminated at the deadline rather than by a
  distinct `RLIMIT_CPU` signal; the memory bomb is covered by the existing resource-limit
  drill, not repeated; disk enforcement is the 25 ms sampler, not a hard quota; the artifact
  case relies on the Task's independent verification command because there is no host
  artifact-ingestion API; and the instruction-smuggling case proves Task metadata/env are data
  at the host boundary, not that a model cannot be influenced by hostile content (F-012
  remains accepted). See F-016 for the coverage-gap closure.

## 2026-11-11 — Explicit Docker sandbox provider (F-006 closure)

Local host: Linux `6.1.102` x86_64, unprivileged UID, Node 26.13.0, pnpm 11.11.0,
`bwrap 0.9.0` at `/tmp/bwrap-root/usr/bin`. Docker CLI is installed but the daemon is not
reachable to this user:

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

The measured Docker run was therefore executed by GitHub Actions, not locally. The drill
reported the runner kernel `7.0.0-1017-azure`; that job did not separately print the Docker
engine version or assert whether its daemon was rootful or rootless. The later `54344f1` run
closes that metadata gap: engine `28.0.4`, `rootless:false` (see the gVisor/engine section
below).

Commands actually run locally at code head `40438a5`:

```sh
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/adversarial-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/workspace-quota-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/seccomp-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/collection-bound-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/session-operator-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/journal-drill.mjs
node tools/security/scan-secrets.mjs
node tools/security/audit-policy.mjs
```

Observed locally: full workspace gate **46/46 tasks successful**, **0 cached**; host **154
passed / 17 skipped** (the 17 skips are the live suites without `AIOS_BWRAP_DIR`); live
bubblewrap **17/17**; bubblewrap adversarial **21/21**; resource-limit, quota, seccomp,
collection, operator, and journal drills exit **0**; `secret-scan: no findings across 283
tracked files`; `audit-policy: no untriaged high or critical advisories (0 triaged)`.
Bubblewrap's filter/limit evidence is unchanged (profile SHA-256
`12e5ae012d8d9bee997b0530b92e9f8b8271b0c2cf5fca2290e655f7921fbaac`).

CI measurement at `40438a5`: Security run `42943242036`, live job `130269803337`. The job
built `aios-sandbox:local` from `tools/security/docker-sandbox.Dockerfile` (step 12) and ran
the Docker drill (step 13); both steps succeeded. The drill used the real
`createSandboxProvider({ provider: 'docker' })`, `LocalCommandExecutor`,
`ManagedExecutionPort`, durable `ExecutionLedger`, and `LocalCommandVerifier`; no test double
stood in for sandboxing or verification. The provider reported kernel
`7.0.0-1017-azure`, availability `Docker passed its container, seccomp and resource-limit
probe.`, and filter SHA-256
`87ae93a78692f192bb8272a9398bafe21c864dce3cf8d79f2f96a0313a7a1214`. All **21/21** cases were
denied or contained; the final JSON result was `all adversarial cases denied or contained`.

Per-case Docker observations from the CI step log:

| # | Attack | Observed result |
|---|---|---|
| 1 | Host file read (`/etc/shadow`) | exit 1; no `root:` bytes; `host_system_mount: none`; filter SHA-256 `87ae93a7…a7a1214` |
| 2 | Path traversal (`../../etc/shadow`, `/workspace/../etc/shadow`, `/proc/1/root/etc/shadow`) | exit 1; no shadow content |
| 3 | Symlink chain to `/etc/shadow` | exit 1; no shadow content |
| 4 | Hardlink `/etc/shadow` into `/workspace` | `rc=1`; no host-file link created |
| 5 | Task cwd `../../etc` and absolute cwd | `HostExecutionError` before spawn; no marker file |
| 6 | Writes to `/etc`, `/usr`, `/root` | exit 2; no `wrote:` line; host paths unchanged |
| 7 | Host environment secret | absent from `/usr/bin/env` and `/proc/self/environ`; only declared `LANG=C` |
| 8 | Host `/tmp` secret via `..`, `/proc/1/root`, and `/tmp` | secret bytes absent |
| 9 | TCP connect to a real host loopback listener | exit 1; listener accepted 0 connections |
| 10 | Raw socket without capabilities | exit 2; no success output |
| 11 | Capability/privilege escalation | `CapEff: 0`; mount exit 159; chroot exit 125, `Operation not permitted` |
| 12 | CPU exhaustion | deadline termination, `SIGKILL`, `timedOut:true`, 3,004 ms; CPU limit 3 s, PID limit 128 |
| 13 | Fork/PID exhaustion | 126 children, 128 namespaced processes, 0 marked survivors |
| 14 | Cancellation orphan cleanup | `cancelled:true`, 0 marked survivors |
| 15 | Timeout orphan cleanup | `timedOut:true`, 0 marked survivors |
| 16 | Disk exhaustion (64 KiB cap) | `WorkspaceQuotaExceededError`; 0 workspace entries; 0 marked survivors |
| 17 | Instruction smuggling | exact argv SHA-256; 89-byte env value literal; output `safe`; hostile text absent from evidence |
| 18 | Forged executor result | rejected: `The executor result does not match the durable attempt evidence.` |
| 19 | Self-issued verification | rejected before running: verifier must be independent |
| 20 | Artifact tampering | verifier exit 1; `accepted:false` |
| 21 | Stale attempt-1 evidence after attempt 2 | stale rejected; latest attempt accepted |

The same exact head's other checks were green: `ci` run `42943242089`, `conformance` run
`42943242041`, `schema-check` run `42943242116`, and the Security supply-chain job
`130269803066`. The earlier Docker probes `dbee5c7` (Security run `42942578684`, job
`130267664888`) and `75f7371` (Security run `42943011442`, job `130269052728`) failed closed
on Docker CLI-invalid `--ulimit as` and bare `rw` mount syntax respectively; they were repaired
before the measured run.

Docker evidence details: the daemon-reported controls were read-only root, `NetworkMode=none`,
`CapDrop=ALL`, no-new-privileges, a non-default seccomp profile, cgroup memory 536,870,912
bytes with equal memory-swap, `NanoCpus=1,000,000,000`, `PidsLimit=128`, the deadline-aligned
CPU rlimit, the workspace-only bind with `RW:true`, and the host UID/GID. Docker does not
expose the client-side seccomp path or digest in `HostConfig.SecurityOpt`; an attempted
exact-path check at `7daf4fd` failed closed and was reverted. The generated profile digest is
recorded separately; the daemon is trusted for its active-profile report.

What this does not establish:

- Rootless Docker, subuid/subgid mapping, or rootless cgroup delegation. The measured daemon at
  `54344f1` was rootful, so rootless mode is not established. The local host remains
  Docker-unavailable.
- A per-process `RLIMIT_AS` for Docker. The CLI rejects `--ulimit as`; the measured memory
  control is the aggregate 512 MiB cgroup, not bubblewrap's 1.25 GiB address-space rlimit.
- Signed or digest-pinned image provenance. The CI image is a local `debian:bookworm-slim`
  build; the provider never pulls implicitly but the image supply chain is operator-owned.
- A host `/etc` bind test: the drill image removes `/etc/shadow`, so case 1 proves the
  container rootfs lacks the host credential file, not that a host `/etc` bind is absent.
- Hard disk quota: the workspace remains governed by the host executor's 25 ms sampler, with
  the same overshoot and attribution limits as bubblewrap.
- VM-class isolation: Docker shares the host kernel. A daemon compromise, kernel exploit, or
  malicious daemon is outside this evidence.
- A distinct `SIGXCPU`: case 12 ended by the provider deadline (`SIGKILL`); the exact CPU rlimit
  value was separately probed.

## Checkpoint — explicit Docker provider measured

The production Docker provider, its custom seccomp profile, the CI image, the 21-case Docker
drill, and the provider-selection/unavailable/misconfiguration regressions are present. ADR-0031
records the selection and threat-model delta; F-006 is fixed for the measured CI path. The
remaining Docker work is rootless-mode measurement, image signing/pinning, and a run on an
operator-controlled daemon. `main` must remain untouched, PR #1 must remain draft/unmerged,
and only `community/open-source-foundation` may be pushed.

## 2026-11-11 — gVisor provider and measured Docker engine (`54344f1`)

The gVisor adapter is now a real explicit provider: `provider: gvisor` plus an absolute,
non-symlink, non-`/` `rootfs` builds a generated OCI bundle and runs
`runsc --rootless --network=none run`. It does not use `runsc do`, which would expose the host
rootfs read-only. The workload gets a read-only controlled rootfs, one writable workspace bind,
private PID/network/IPC/UTS/mount namespaces, empty capabilities, `noNewPrivileges`, and OCI
`RLIMIT_AS=536870912`, deadline-aligned `RLIMIT_CPU`, `RLIMIT_NPROC=128`, and
`RLIMIT_NOFILE=1024`. The provider records a `gvisor-sentry` boundary and a
`gvisor-oci-rlimit` mechanism, not a fake seccomp object. Missing boundary evidence raises
`SandboxIsolationUnavailableError`, journals `sandbox_isolation_unavailable`, and is rejected by
the independent verifier. Cleanup attempts `runsc kill --all` and `runsc delete --force` on every
path. Selection is explicit: Linux `auto` remains bubblewrap, Docker still requires `image`, and
gVisor still requires `rootfs`; no failure falls back to another provider. See ADR-0032.

### CI measurement

CI at `54344f1`: Security run `42946929104`, live job `130281855560`, kernel
`7.0.0-1017-azure`. The job's Docker image build and drill were steps 12 and 13; gVisor install,
rootfs export, and drill were steps 14–16. All were successful. The Docker drill reported:

```json
{"name":"docker","version":"28.0.4","rootless":false,"security_options":["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]}
```

The gVisor drill reported:

```json
{"name":"runsc","version":"release-20261102.0","rootless":true}
```

Both drills produced **21/21** cases and the result `all adversarial cases denied or contained`.
The Docker result supersedes the earlier 40438a5 evidence for engine metadata; it does not
supersede the Docker 21-case assertions. The measured Docker daemon was **rootful**; rootless
Docker, subuid/subgid mapping, and rootless cgroup delegation remain unmeasured. The local host
still cannot reach `/var/run/docker.sock`.

### Per-case gVisor results from CI

| # | Attack | Observed result |
|---|---|---|
| 1 | Host file read (`/etc/shadow`) | exit 1; no shadow content; `controlled OCI rootfs (no host bind)` |
| 2 | Path traversal (`../../etc/shadow`, `/workspace/../etc/shadow`, `/proc/1/root/etc/shadow`) | exit 1; no shadow content |
| 3 | Symlink chain to `/etc/shadow` | exit 1; no shadow content; `stderr_sha256 f4519b2c…` |
| 4 | Hardlink `/etc/shadow` into `/workspace` | `rc=1`; no host-file link created |
| 5 | Task cwd `../../etc` and absolute cwd | rejected before spawn; no marker file |
| 6 | Writes to `/etc`, `/usr`, `/root` | exit 2; no `wrote:` marker; host paths unchanged |
| 7 | Host environment secret | absent from `/usr/bin/env` and `/proc/self/environ`; only `LANG=C` |
| 8 | Host `/tmp` secret via `..`, `/proc/1/root`, and `/tmp` | secret bytes absent |
| 9 | TCP connect to a real host loopback listener | exit 1; listener accepted 0 connections |
| 10 | Raw socket without capabilities | exit 2; no success output |
| 11 | Capability/mount/chroot escalation | `CapEff: 0`; mount exit 1 (`EPERM`, no survivor); chroot exit 125, `Operation not permitted` |
| 12 | CPU exhaustion | deadline termination, `SIGKILL`, `timedOut:true`, 3,007 ms; CPU limit 3 s, PID limit 128 |
| 13 | Fork/PID exhaustion | 127 children, 128 namespaced processes, 0 marked survivors |
| 14 | Cancellation orphan cleanup | `cancelled:true`; 0 marked survivors |
| 15 | Timeout orphan cleanup | `timedOut:true`; 0 marked survivors |
| 16 | Disk exhaustion (64 KiB cap) | quota error; 0 workspace entries; 0 marked survivors |
| 17 | Instruction smuggling | exact argv SHA-256; 89-byte env literal; output `safe`; hostile text absent |
| 18 | Forged executor result | rejected: `The executor result does not match the durable attempt evidence.` |
| 19 | Self-issued verification | rejected before running; verifier must be independent |
| 20 | Artifact tampering | verifier exit 1; `accepted:false` |
| 21 | Stale attempt-1 evidence after attempt 2 | stale rejected; latest attempt accepted |

The gVisor mount case required a provider-specific probe correction: gVisor's Sentry returns
`EPERM` for `mount(2)` instead of killing the process. The original probe printed
`mount-survived` unconditionally after the syscall, which was misleading even though the syscall
was denied. The gVisor branch now checks the return value and exits 1 with the denial; a
successful mount still prints the marker and fails the case. No bubblewrap or Docker assertion
was changed, and no case was relaxed to accept a successful mount.

### Local checks at the same tree

Commands actually run locally at code head `54344f1`:

```sh
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin pnpm --filter @aios/host exec vitest run \
  tests/sandbox-live.test.ts tests/seccomp-live.test.ts tests/workspace-quota-live.test.ts
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/adversarial-drill.mjs
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/resource-limit-drill.mjs
AIOS_GVISOR_ROOTFS=/tmp/aios-gvisor-rootfs-clean PATH="/tmp/gvisor-install:$PATH" \
  AIOS_SANDBOX_PROVIDER=gvisor node tools/security/adversarial-drill.mjs
```

Observed: full workspace gate **46/46** tasks, **0 cached**; host **158 passed / 17 skipped**
(the 17 are live suites without `AIOS_BWRAP_DIR`); live bubblewrap **17/17**; bubblewrap
adversarial **21/21**; resource-limit drill exit **0**; gVisor adversarial **21/21** with
`runsc release-20261102.0`, rootless true. The local gVisor rootfs was a disposable, minimal
~67 MiB controlled rootfs with `/etc/shadow` absent and no host-root bind; CI exported its rootfs
from the same Debian Docker image used for the Docker drill. Both exercised the production
provider, executor, managed port, durable ledger, and verifier; no test double stood in for
sandboxing or verification.

### What the gVisor run does not establish

- Rootless gVisor uses a single-UID mapping; multi-UID image contents, rootless Docker-style
  subuid/subgid, and netstack are not measured. The measured network mode is `--network=none`.
- The OCI rlimits are enforced by the Sentry; there is no host cgroup aggregate for the
  workload. The workspace disk control remains the executor's 25 ms sampler, not a hard quota.
- `runsc` is pinned and SHA-512/SHA-256-verified in CI, and the rootfs is reproducible from the
  in-repo Docker recipe with a canonical manifest. At this head neither the pin nor the manifest
  was Sigstore signed, the base image tag/apt versions were not yet pinned, and manifest
  metadata excluded ownership/timestamps. The base/apt gap was subsequently fixed by F-018.
- gVisor is a user-space kernel, not a VM; the Sentry/gofer still use the host kernel. A
  Sentry or host-kernel vulnerability remains in scope.
- The CPU burner ended by deadline `SIGKILL`, not a distinct `SIGXCPU`; the OCI CPU rlimit was
  separately probed.
- Case 1 proves the controlled rootfs lacks `/etc/shadow`; it does not prove an arbitrary
  operator-supplied rootfs is trustworthy or that a hostile host `/etc` bind is absent.
- Seatbelt and Apple Containerization remain unavailable/unverified. Docker rootless mode and
  signed/digest-pinned Docker images remain unverified.

## 2026-11-11 — pinned gVisor build inputs and reproducible rootfs (`378e7d6`)

Code head `378e7d6` (`fix(security): normalize gVisor rootfs build state`) closes F-018. The
first pinned-input commit `103b521` proved the Dockerfile and Debian snapshot resolved, but its
independent image builds produced equal 6,212-entry trees with different canonical digests. The
repair removed build-generated caches/logs and added a path-level diff; it did not relax the
digest comparison. The measured tree now has 6,195 entries.

### Build inputs and guard

- `tools/security/docker-sandbox.Dockerfile` uses
  `debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`,
  apt sources under `http://snapshot.debian.org/archive` at `20261110T000000Z`, and exact
  packages `coreutils=9.1-1`, `perl=5.36.0-7+deb12u4`, `util-linux=2.38.1-5+deb12u3`. It
  removes apt/dpkg/ldconfig caches, logs, locks, `/tmp`, `/var/tmp`, `/etc/shadow`, and
  `/etc/gshadow`.
- `tools/security/gvisor-rootfs.json` records the base index and amd64 platform digests, snapshot
  suites, exact packages, Dockerfile, exclusions, and pin SHA-256
  `9fccac3eac4bb9e5c0adde39816dc7b858c3ea1b5105d3e79b91046c15c6174d`.
- `gvisor-provenance.mjs verify-rootfs-pin` validates the pin and Dockerfile. Local output:
  `debian:bookworm-slim@sha256:734a72b3…`, snapshot `20261110T000000Z`, the three exact
  packages, and `pin_sha256 9fccac3e…`; exit 0.
- `apps/host/tests/gvisor-provenance.test.ts` covers missing/malformed pins, base/snapshot/package
  drift, digest mismatch, and canonical rootfs behavior. Focused suite: **13/13**.

### CI runtime and rootfs measurements

Security run `42956393498`, live job `130312417881`, kernel `7.0.0-1017-azure`.

- Step 12, pin guard. Observed the pinned base/snapshot/packages and build pin above.
- Step 13, Docker image build; step 14, Docker drill. **21/21**, engine `28.0.4`, rootful.
- Step 15, independent `docker build --no-cache` image. Step 16 installed and verified
  `runsc release-20261102.0`:

```json
{"release":"20261102.0","version":"release-20261102.0","artifact_sha512":"2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05","binary_sha256":"c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098","pin_sha256":"20c017d90727d32cffa931219f68a336d639f97ac234087190984312a5b9bd2c"}
```

- Step 17, required fail-closed probe. Both checks were rejected; a successful verification
  would have exited 1:

```text
 gVisor provenance error: The gVisor runtime archive does not match the pinned SHA-512 (expected 2e6671bb2d033b871c5811ab57e16ac570988b0e0054c525f911cfaf191bab3ca4efb08e0a98daa4b9e7d248f9e5776ef2ef2f8a6b82d829646a42924c98bb05, observed aa46d5d28e34d6cc14e574cbbc35b2d5485e2b481bb79e4d33fdb85c58cd7389f097be0a2d77df46eb1e13de47cf3012db24c4c5dd1d908ce79c86a295991780).
 gVisor provenance error: The gVisor runtime pin file does not exist: /home/runner/work/_temp/missing-gvisor.pin.json.
 observed fail-closed provenance errors
```

- Step 18, independent rootfs comparison. Observed:

```json
{"rootfs_sha256":"6e1376d8ee022a239e7dc38a068498729a88632639559ccc41a0174d788f20d7","entries":6195,"image":"aios-sandbox:local","image_id":"sha256:89eacf2ae4ed6aa99b5be877d12656c6968ccac812777f4f1da7167b7e1ff8e5","rebuild_image_id":"sha256:a8abdab0a7949941cf9afbea740065ede56047a39880e29649fd7e89f75a0ba7","reproducible":{"sha256":"6e1376d8ee022a239e7dc38a068498729a88632639559ccc41a0174d788f20d7","entries":6195,"method":"independent-image-build","image":"aios-sandbox:local-rebuild","image_id":"sha256:a8abdab0a7949941cf9afbea740065ede56047a39880e29649fd7e89f75a0ba7"},"manifest":"/home/runner/work/_temp/gvisor-rootfs.manifest.json"}
```

The manifest digest is `845c98537b568983f70644d4ef5fc9582303c3aa09893cca39d6e5bf5b5bab3f`. Its
source records the base index digest, amd64 platform digest, snapshot, exact packages,
Dockerfile SHA-256 `5acad18ae243c42ba3e5f4cc8cd30557beafe9aaad95b025d9e64d7f6fb8fe2c`,
exclusions, both image IDs, and `rootfs_build_pin_sha256 9fccac3e…`. No path differed.

- Step 19, gVisor drill. Result `all adversarial cases denied or contained`; runtime
  `release-20261102.0`, rootless `true`; every case carried runtime
  `c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098`, rootfs
  `6e1376d8ee022a239e7dc38a068498729a88632639559ccc41a0174d788f20d7`, and provenance digest
  `8490ada2b7adb15bad155212fcde4b7c3187ad12ae6b989319b0bfa62052007b`.
- Step 20, session-operator drill. Bubblewrap live/resource/adversarial steps 9–11 also passed.

### Per-case gVisor results from `378e7d6`

| # | Attack | Observed result |
|---|---|---|
| 1 | `filesystem_host_file_read` | denied; exit 1; controlled OCI rootfs, no host bind |
| 2 | `filesystem_path_traversal` | denied; exit 1; no shadow content |
| 3 | `filesystem_symlink_chain` | denied; exit 1; `stderr_sha256 f4519b2c…` |
| 4 | `filesystem_hardlink_denied` | denied; `rc=1`; no host-file link |
| 5 | `filesystem_cwd_traversal` | denied; rejected before spawn |
| 6 | `filesystem_write_outside` | denied; exit 2; no `wrote:` marker |
| 7 | `secrets_host_environment` | denied; only `LANG=C`; host value absent |
| 8 | `secrets_host_file_unmounted` | denied; host secret bytes absent |
| 9 | `network_host_loopback_connect` | denied; exit 1; listener accepted 0 connections |
| 10 | `network_raw_socket_denied` | denied; exit 2; no success output |
| 11 | `capabilities_privilege_escalation` | denied; `CapEff: 0`; mount EPERM/exit 1; chroot exit 125, `Operation not permitted` |
| 12 | `resource_cpu_exhaustion` | contained; `SIGKILL`, timed out at 3,009 ms |
| 13 | `resource_pid_exhaustion` | contained; 127 children, 128 namespaced, 0 marked survivors |
| 14 | `process_orphan_cancel` | contained; cancelled, 0 marked survivors |
| 15 | `process_orphan_timeout` | contained; timed out, 0 marked survivors |
| 16 | `resource_disk_exhaustion` | contained; 0 workspace entries, 0 survivors |
| 17 | `injection_task_metadata` | contained; exact argv digest, 89-byte env literal, output `safe` |
| 18 | `verification_forged_executor_result` | rejected: `The executor result does not match the durable attempt evidence.` |
| 19 | `verification_self_issued` | rejected before running; verifier must be independent |
| 20 | `verification_artifact_tampering` | rejected; verifier exit 1, `accepted:false` |
| 21 | `verification_stale_replay` | stale attempt rejected; latest attempt accepted |

### Local checks at the same tree

```sh
pnpm turbo lint typecheck test build --cache-dir=/tmp/turbo-cache --force
AIOS_BWRAP_DIR=/tmp/bwrap-root/usr/bin node tools/security/adversarial-drill.mjs
PATH="/tmp/gvisor-install:$PATH" AIOS_SANDBOX_PROVIDER=gvisor \
  AIOS_GVISOR_ROOTFS=/tmp/aios-gvisor-rootfs-clean \
  AIOS_GVISOR_ROOTFS_MANIFEST=/tmp/aios-gvisor-rootfs-clean.local.manifest.json \
  node tools/security/adversarial-drill.mjs
node tools/security/gvisor-provenance.mjs verify-rootfs-pin --source tools/security/gvisor-rootfs.json --dockerfile tools/security/docker-sandbox.Dockerfile
```

Observed: full workspace gate **46/46**, **0 cached**; host **168 passed / 17 skipped**;
bubblewrap adversarial **21/21**; gVisor adversarial **21/21** with rootfs
`2e7a3eba09cfbba65babc0566e10c70c5b9dd028f64d951a63483bb3a9f9caca` (2,693 entries) and the
same pin/runtime as CI; pin guard exit 0 with `9fccac3e…`. The local rootfs is a disposable
minimal build, not the Docker recipe. The local Docker daemon remains unreachable
(`permission denied ... /var/run/docker.sock`), so the independent-image build is CI-only.

### What this run does not establish

- The pin, base/snapshot inputs, manifest, and rootfs are not Sigstore-signed. A host writer can
  replace the pin, runtime, or rootfs before or after hashing; the repository pin is an unsigned
  trust anchor.
- F-018 is fixed for pinned inputs and same-date independent-image reproduction, not for
  snapshot permanence: a future rebuild depends on `snapshot.debian.org` retaining
  `20261110T000000Z`. No later-date rebuild has been run.
- The canonical manifest covers path, type, mode, size, file SHA-256, and symlink target, not
  uid/gid, timestamps, xattrs, or host mount provenance.
- Rootless gVisor remains single-UID, no netstack, and no save/restore; there is no host cgroup
  aggregate, disk remains the 25 ms sampler, and the CPU burner ended by deadline `SIGKILL`. It
  is not a VM.
- Docker rootless mode, signed Docker images, Seatbelt, and Apple Containerization remain
  unverified or unavailable.

At the same code head, `ci` run `42956393497`, `conformance` run `42956393507`, and
`schema-check` run `42956393513` were green; Security run `42956393498` passed both jobs. The
Release workflow is `workflow_dispatch`-only and is run on the final documentation head. The
documentation checkpoint follows this code head; read `git log --oneline -3` for the exact tip.
