# AIOS Threat Model (local host)

## Scope

This model covers the trusted local host (`apps/host`), its durable stores, and the fixed
`local.exec` execution path. It does not cover cloud deployment, multi-user hosting, or the
Founder Intelligence vault's own access controls.

## Assets

| Asset | Why it matters |
|---|---|
| Authorization policy and audit (`policies.json`, `authorization-audit.jsonl`) | Decides every protected action; the audit is the non-repudiation record. |
| Operational journal (`operational.jsonl`) | Authority for Task/Workflow/execution recovery. |
| Run workspaces | Contain untrusted agent output and possibly imported repository content. |
| Host session digests and configuration | Authenticate local callers; a leaked token is a full impersonation of that principal. |
| Secrets in the host environment (connector credentials) | Must never cross into a sandbox or an evidence record. |
| Obsidian vault | Founder Intelligence; read/propose only, never a sandbox workspace. |

## Trust boundaries

1. **Caller → host HTTP.** Authenticated by bearer token digest; identity comes from the host
   session table, never from a request field. Every `Origin` is rejected; there is no UI.
2. **Host → authorization service.** Exact-match, resource-attached, default-deny; denial and
   allow are both audited, and an audit append failure denies.
3. **Host → sandbox provider.** The task supplies an argv, never a shell string or a provider
   selection. The provider establishes the OS boundary before the workload starts.
4. **Sandbox → workspace.** Only the per-task workspace is writable; the host filesystem is
   read-only or absent; `/tmp` is a private, size-bounded tmpfs. Before exec, bubblewrap
   installs a generated seccomp deny-list with an architecture guard; the host refuses a run
   unless the kernel reports `Seccomp: 2` and the provider supplies matching filter evidence.
5. **Executor → verifier.** Separate principal and separate sandbox invocation. The verifier
   never accepts the executor's self-report; it runs its own command and records hashes.
6. **Host → durable stores.** Owner-only files, hash-chained, single-writer lock, fsync before
   acknowledgement.

## Attacker capabilities considered

- An agent that controls the command line it asks to run (within the fixed contract).
- Malicious repository content or tool output attempting prompt injection or data exfiltration.
- A compromised or buggy workload attempting filesystem escape, symlink escape, network
  access, credential reads, fork/exec floods, or leaving background processes behind.
- A caller without the exact grant attempting to read, mutate, cancel, or verify protected work.
- A local attacker able to modify journal files out of band (detected, not prevented, by the
  hash chain) or to replace a provider binary (out of scope without signed tooling).

## Explicit non-goals / residual risk

- **Shared-kernel isolation.** bubblewrap and Docker do not survive a host-kernel exploit.
  gVisor or a VM boundary is required for hostile multi-tenant workloads; neither is validated
  in this repository yet.
- **System-call attack surface.** bubblewrap now installs a generated seccomp deny-list
  (ADR-0027) that kills ptrace, mount/namespace, keyring/module, bpf/perf, io_uring,
  userfaultfd, and related syscalls. It is a deny-list, not a complete allow-list: unlisted
  syscall families remain callable, and the filter does not make the shared kernel safe.
  Landlock is not active on the validation host, and Docker/Seatbelt/gVisor/Apple
  Containerization remain unverified. A denied syscall is journaled as
  `sandbox_syscall_denied`; missing filter proof is `sandbox_filter_unavailable`.
- **Resource exhaustion.** bubblewrap has no cgroup CPU/memory controls. Deadlines, bounded
  output, a size-bounded `/tmp` (64 MiB), process-group kill, and one-command-per-task are the
  current controls; a memory bomb can still stress the host. The per-run workspace ceiling is
  sampled every 25 ms while the run is live, aborts and discards an over-cap workspace, and is
  journaled as `disk_quota_exceeded` (ADR-0026). It is **not a hard filesystem quota**: a fast
  writer can overshoot between samples, symlinks are skipped, hardlinks are counted per name,
  and writes outside `/workspace` (for example other tmpfs paths) are not attributed to the
  run. There is no unprivileged block/loop quota on this host. Docker provider has cgroup flags
  but was not executable on the validation host.
- **macOS.** `sandbox-exec` is deprecated; a supported macOS path requires Apple
  Containerization on macOS 26 / Apple silicon, which is not implemented or validated here.
- **Journal archives.** Compaction archives are integrity-checked but neither encrypted nor
  signed; an attacker who can rewrite the archive and its digest can forge history. Retention
  and custody remain operator responsibilities (ADR-0025).
- **Identity lifecycle.** No login, key rotation, detached policy signature, or external audit
  custody (recorded in ADR-0023/ADR-0024).
- **Observability is not audit.** Structured logs help diagnosis; only the append-only audit
  store is treated as an authorization record.
