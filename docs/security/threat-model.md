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
| Host session digests, lifecycle state, and configuration | Authenticate local callers; a leaked token is a full impersonation of that principal until expiry or revocation. |
| Secrets in the host environment (connector credentials) | Must never cross into a sandbox or an evidence record. |
| Obsidian vault | Founder Intelligence; read/propose only, never a sandbox workspace. |

## Trust boundaries

1. **Caller → host HTTP.** Authenticated by bearer token digest against durable session state;
   identity comes from the host session table, never from a request field. Sessions have a
   mandatory bounded expiry. Rotation retires the old digest, revocation is terminal, and a
   task/run/evidence-scoped token is checked against the actual route binding. Expired,
   rotated-away, revoked, replayed, and cross-scope tokens fail closed with structured 401
   reasons (ADR-0029). Every `Origin` is rejected; there is no UI.
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
  hash chain) or to replace a provider binary. The gVisor provider now checks a repository pin
  and hashes the actual runtime and rootfs; the pin and manifest are Ed25519-signed and
  verified against the external trust root. A same-UID host writer remains inside the host
  trust boundary and can still influence files before execution; that residual is explicit.

## Explicit non-goals / residual risk

- **Shared-kernel isolation.** bubblewrap and Docker do not survive a host-kernel exploit.
  gVisor is measured (ADR-0032) and its runtime/rootfs are digest-verified, but it is a
  user-space kernel, not a VM; a VM boundary is still not validated in this repository.
- **Sandbox supply chain.** The gVisor release archive is pinned by SHA-512 and the extracted
  `runsc` by SHA-256. The rootfs is built from a base image pinned by manifest-list digest, the
  fixed `snapshot.debian.org` timestamp `20261110T000000Z`, and exact package versions; CI
  requires two independent no-cache image builds to produce the same canonical rootfs digest
  and manifest. The pin and manifest are Ed25519-signed and checked against the external trust
  root; the base-image and Debian-snapshot inputs remain unsigned. The snapshot must remain
  available for a future rebuild. A malicious host writer or upstream compromise is outside
  the workload boundary.
- **System-call attack surface.** bubblewrap now installs a generated seccomp deny-list
  (ADR-0027) that kills ptrace, mount/namespace, keyring/module, bpf/perf, io_uring,
  userfaultfd, and related syscalls. It is a deny-list, not a complete allow-list: unlisted
  syscall families remain callable, and the filter does not make the shared kernel safe.
  Landlock is not active on the validation host; Docker and gVisor are measured
  (ADR-0031/ADR-0032), while Seatbelt and Apple Containerization remain unverified. A denied
  syscall is journaled as
  `sandbox_syscall_denied`; missing filter proof is `sandbox_filter_unavailable`.
- **Resource exhaustion.** bubblewrap now installs per-process `RLIMIT_AS` (1.25 GiB),
  `RLIMIT_CPU` (the run deadline rounded up to whole seconds), and `RLIMIT_NPROC` (128) with
  the trusted host `/usr/bin/prlimit` before exec. The fixed wrapper proves the exact
  `/proc/self/limits` values and `Seccomp: 2`; missing proof is journaled as
  `sandbox_resource_limit_unavailable` and the verifier rejects it (ADR-0028). This bounds a
  single memory bomb, but it is **per-process**, not cgroup aggregate: up to 128 descendants can
  each reserve the address-space cap, RLIMIT_AS is not RSS, and CPU limits are per-process.
  Deadlines, bounded output, a size-bounded `/tmp` (64 MiB), process-group kill, and
  one-command-per-task remain. The per-run workspace ceiling is sampled every 25 ms while the
  run is live, aborts and discards an over-cap workspace, and is journaled as
  `disk_quota_exceeded` (ADR-0026). It is **not a hard filesystem quota**: a fast writer can
  overshoot between samples, symlinks are skipped, hardlinks are counted per name, and writes
  outside `/workspace` (for example other tmpfs paths) are not attributed to the run. There is
  no unprivileged block/loop quota on this host. Docker has measured aggregate cgroup limits;
  gVisor uses Sentry-enforced OCI rlimits and has no host aggregate cgroup. Node/libuv probes
  `io_uring_setup` and is killed by the F-007 deny-list at startup; that compatibility residual
  is recorded in the findings ledger.
- **macOS.** `sandbox-exec` is deprecated; a supported macOS path requires Apple
  Containerization on macOS 26 / Apple silicon, which is not implemented or validated here.
- **Journal archives.** Compaction archives are integrity-checked but neither encrypted nor
  signed; an attacker who can rewrite the archive and its digest can forge history. Retention
  and custody remain operator responsibilities (ADR-0025).
- **Authorization-audit rollback.** `authorization-audit.jsonl` has a SHA-256 sequence chain
  and every record has detached provenance, but the chain is unkeyed and has no local
  monotonic checkpoint. A same-UID attacker who rewrites the file and recomputes the chain
  can remove a suffix, reorder/insert signed records, or roll back to an earlier consistent
  prefix. The host detects ordinary edits and out-of-sequence records; it cannot detect a
  rewritten valid prefix. External audit custody or a monotonic witness is required and is
  recorded as blocked (F-030, CL-006).
- **Identity and provenance lifecycle.** Host session tokens now have bounded expiry,
  rotation, revocation, and task/run/evidence scope binding (ADR-0029). Policies and
  authorization decisions carry detached local signatures verified against the pinned trust
  root (ADR-0034); policy verification requires the key to be currently valid, while
  historical decisions verify at signed time. Verifier decisions are bound to the durable
  execution attempt (ADR-0033 implementation). The host refuses to compose the policy key as
  a verifier key, but the trust root has no per-key purpose field, so a purpose-bound root is
  blocked. There is still no login, MFA, token-theft detection, rate limiting, or TLS on the
  loopback listener; production key custody, external audit custody, and revocation-time
  history semantics remain open. A rotation response is one-time; a lost token cannot be
  recovered from the journal. Retired digests are terminal and retained.
- **Observability is not audit.** Structured logs help diagnosis; only the append-only audit
  store is treated as an authorization record.
