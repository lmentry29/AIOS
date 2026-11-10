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
