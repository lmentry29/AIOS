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
on this x86_64 host; Docker, Seatbelt, gVisor, and Apple Containerization remain unverified;
the shared host kernel remains in scope; there is no aggregate cgroup CPU/memory accounting or
hard disk quota. See ADR-0027 and F-007.

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
io_uring. Docker, gVisor, Seatbelt, and Apple Containerization remain unverified or
unavailable; the shared kernel remains in scope. See ADR-0028 and F-003.

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
