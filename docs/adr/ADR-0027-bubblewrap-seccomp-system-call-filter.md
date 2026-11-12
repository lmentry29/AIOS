# ADR-0027 — Bubblewrap System-Call Filter

## Status

**Accepted** (2026-11-10). Amends ADR-0019's statement that the bubblewrap provider has no
seccomp profile. It does not amend the trust model: the shared kernel remains a non-goal for
hostile multi-tenant use, and it does not make Docker, Seatbelt, gVisor, or Apple
Containerization verified.

## Context

ADR-0019 established the fixed `local.exec` boundary through Docker, bubblewrap, and Seatbelt.
The bubblewrap path already used user, mount, PID, network, IPC, UTS, and cgroup namespaces,
a read-only host filesystem, a writable per-task workspace, a private `/tmp`, no effective
capabilities, a cleared environment, and process-group cleanup. It did not restrict the
workload's system-call surface, so a workload could invoke every syscall the kernel permitted
to the unprivileged user. F-007 recorded that gap.

On the validation host (`Linux 6.1.102 x86_64`, `bwrap 0.9.0`, unprivileged UID) bubblewrap
supports `--seccomp FD`. Landlock is not listed in `/sys/kernel/security/lsm`
(`capability,selinux`), and this environment has no usable rootless container daemon or
privileged block-device controls. A generated seccomp BPF program is therefore the strongest
mechanism available on this path.

## Decision

1. **Generate the filter in host code.** `apps/host/src/execution/seccomp.ts` builds a classic
   BPF program with a `seccomp_data.arch` guard (`AUDIT_ARCH_X86_64` or
   `AUDIT_ARCH_AARCH64`) and an ordered deny-list. A mismatched ABI and every listed syscall
   return `SECCOMP_RET_KILL_PROCESS`. Ordinary syscalls use `SECCOMP_RET_ALLOW`.
2. **Install it on every bubblewrap invocation.** The provider writes the filter to an
   owner-only temporary file, passes its fd as `--seccomp 3`, and keeps the existing
   `--unshare-all`, capability drop, read-only mounts, workspace bind, `/tmp` size limit, and
   process-group cleanup. The filter is inherited by the requested argv and its descendants.
3. **Prove installation before treating a run as filtered.** A fixed `/bin/sh` wrapper runs
   after bubblewrap has installed the filter. It reads `/proc/self/status`, writes `applied`
   on an inherited marker fd only when the kernel reports `Seccomp: 2`, closes the inherited
   descriptors, and then `exec`s the requested argv without constructing a shell string from
   it. The provider returns a filter profile id, filter SHA-256, and `applied` evidence.
4. **Fail closed.** Missing or failed marker evidence makes the executor raise
   `SandboxFilterUnavailableError`; the managed lifecycle journals
   `sandbox_filter_unavailable`. If bubblewrap reports a child wait status of 159 (SIGSYS),
   the executor raises `SandboxSyscallDeniedError` and journals `sandbox_syscall_denied`.
   The workspace is discarded in either case. Provider `check()` runs the same filtered
   probe; a filter-specific preflight failure is also mapped to `sandbox_filter_unavailable`.
5. **Bind verification to the actual run.** Successful executor and verifier evidence includes
   the filter profile and digest. The verifier checks the evidence from its own filtered
   invocation, and a failed durable attempt is rejected with its execution id, attempt number,
   failure reason, failure-evidence digest, and the failed filter digest when present. A
   caller cannot present an unfiltered or denied run as accepted.
6. **Keep the deny-list narrow and explicit.** Denied syscalls are `ptrace`, `mount`,
   `umount2`, `swapon/swapoff`, `reboot`, host/domain-name changes, module loading/unloading,
   `quotactl`, `kexec_load`/`kexec_file_load`, keyring operations, `unshare`, `setns`,
   `perf_event_open`, `process_vm_readv/writev`, `kcmp`, `bpf`, `userfaultfd`, io_uring,
   open-tree/move-mount/fsopen/fsmount filesystem APIs, `pidfd_getfd`, `process_madvise`, and
   `mount_setattr`.

## Consequences

- A forbidden syscall now terminates the workload instead of reaching the kernel handler.
  The live drill denied `unshare` with SIGSYS, recorded `SandboxSyscallDeniedError`, removed
  the partial workspace, and left no marked child process.
- This is a **deny-list**, not a complete allow-list. Unlisted syscall families remain
  callable, including many ordinary file, process, memory, socket, and scheduling syscalls.
  The workload still runs on the host kernel; a kernel vulnerability reachable through an
  allowed syscall remains out of scope. gVisor or a VM is the next boundary for hostile
  multi-tenant workloads.
- Landlock is unavailable on this host and no Landlock ruleset is installed. If a future
  kernel exposes Landlock, it should be added as an additional filesystem LSM layer rather
  than replacing the filter. Docker, Seatbelt, gVisor, and Apple Containerization use other
  mechanisms and remain **unverified**; this ADR makes no claim about them.
- The profile is generated for x86_64 and arm64. The arm64 table is implemented but was not
  live-tested on this x86_64 host. An unsupported architecture fails closed because the
  provider cannot generate a filter.
- The filter and its digest are not signed. A compromised host process can replace the
  generated bytes; the hash is evidence of the bytes used, not a supply-chain trust anchor.
  The filter file is owner-only and removed after the invocation.
- The filter is applied per invocation. A denied run does not alter the next run's filter,
  workspace, or process state; the live drill confirmed a subsequent normal run exited 0.
- The fixed wrapper requires `/bin/sh` and `/proc` inside the boundary. These are already
  part of the trusted system bind and are not controlled by the task.

## Verification

`apps/host/tests/seccomp.test.ts` covers deterministic profile generation, architecture
rejection, missing-filter proof, SIGSYS mapping and durable verifier binding, and preflight
filter failure. `apps/host/tests/seccomp-live.test.ts` uses real bubblewrap for `Seccomp: 2`,
a denied `unshare` with no surviving child, executor workspace discard, and a successful
subsequent run. `tools/security/seccomp-drill.mjs` records the same lifecycle against the
built host; its output is in `docs/security/validation-ledger.md`.
