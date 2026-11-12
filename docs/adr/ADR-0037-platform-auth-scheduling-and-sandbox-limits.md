# ADR-0037 — Platform, Session Authentication, Scheduling, and Bubblewrap Limits

## Status

**Accepted** (2026-11-12). This ADR records the owner's completion decisions for CL-010,
CL-013, CL-014, CL-018, CL-019 and CL-020. It authorizes implementation but does not claim
macOS, UI, scheduler, cgroup, or Landlock evidence until those checks run.

## Context

The host supports loopback bearer sessions, rejects every browser `Origin`, and has no login,
MFA, TLS, or rate-limit design. The orchestrator rejects work above its concurrency cap rather
than queueing it. The supported platform matrix is Linux-only in practice; macOS Seatbelt and
Apple Containerization are unverified. Bubblewrap has per-process rlimits but no aggregate
cgroup quota or Landlock.

The owner selected the target model below.

## Decision

### 1. Platform and live-test matrix

Supported platforms are Linux and macOS 26 on Apple silicon.

- Linux: bubblewrap remains the default; Docker and gVisor remain explicit opt-in providers.
- macOS: Seatbelt and Apple Containerization must be implemented and measured before they are
  called supported. A macOS CI runner or operator-owned macOS 26 Apple silicon host is required.
- The 17 currently skipped live host suites must run on the supported platform matrix. A skip is
  not passing evidence; CI-only Linux proof does not establish macOS isolation.

The repository must continue to fail closed on a platform whose provider is unavailable. No
fallback to an unisolated child process is allowed.

### 2. Same-origin local UI and authenticated sessions

The UI is an untrusted same-origin client of the host. The host accepts an `Origin` only when it
matches the configured UI origin and the request otherwise satisfies the CSRF and DNS-rebinding
checks.

Sessions use:

- `HttpOnly`, `Secure` (including loopback), `SameSite=Strict` cookies with `__Host-` semantics;
- a per-session CSRF token bound to the cookie and required on mutations;
- loopback TLS with an operator-enrolled local certificate;
- WebAuthn/passkey authentication with a human principal and a tested recovery/enrollment path;
- bounded login, session, and mutation rate limits with structured audit reasons.

Bearer tokens remain supported for the CLI and automated operator paths. A bearer token in
browser storage is not an acceptable UI mechanism.

### 3. Durable scheduling and approval quorum

The orchestrator gains a durable dependency DAG and a fair queue with bounded parallelism. A
Task's declared dependencies must be terminal and successful before it becomes eligible.
Capacity exhaustion queues eligible work rather than rejecting it; the queue is durable across
restart and preserves the exact authorization decision that admitted each item.

Approval quorum is an explicit, durable policy input for the operations the owner designates.
An automatic-resume policy must be opt-in, bounded, and recorded; startup reconciliation must
not silently re-drive interrupted work. Every automatic attempt links to its predecessor and
obeys the same exact grants as a manual resume/retry.

The existing strict cap, cancellation, attempt-chain, and no-startup-execution guarantees are
not weakened. A queue is not a bypass around `execute`/`resume`/`retry` authorization.

### 4. Bubblewrap aggregate limits and Landlock

Bubblewrap runs require:

- cgroup v2 delegation with a hard aggregate memory/CPU/PID limit for the run;
- a Landlock ruleset restricting filesystem access to the declared workspace and required
  read-only runtime paths;
- the existing per-process `RLIMIT_AS`, `RLIMIT_CPU`, and `RLIMIT_NPROC` controls as
  defense-in-depth;
- fail-closed behavior when cgroup delegation or Landlock is unavailable; no claim of aggregate
  isolation from the per-process rlimits.

Docker's measured cgroup limits remain a separate provider. gVisor remains a separate measured
provider; none of these boundaries may be silently substituted for another.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Linux-only forever | The owner selected macOS support; leaving it unverified would exclude the target platform. |
| Bearer tokens in browser storage | Exposes a high-value credential to script compromise and violates the UI trust boundary. |
| Keep reject-only capacity | Makes durable workflows operationally unusable and provides no fairness. |
| Enable automatic resume by default | Reintroduces crash-loop and startup-execution hazards. |
| Claim aggregate limits from rlimits | Per-process limits do not bound the sum of processes. |

## Consequences

- UI, auth, scheduler, cgroup/Landlock, and macOS work are substantial implementation phases;
  none is marked done until its live check runs on the claimed platform.
- The host remains loopback-only and fails closed while the UI/auth implementation is absent.
- Queue durability, quorum semantics, and automatic-resume policy require new journal record
  types and migration tests.
- A macOS runner or Apple silicon operator host and a cgroup v2-capable Linux host are required
  for the corresponding live evidence.

## Scheduler implementation amendment (2026-11-12)

CL-014's durable scheduling substrate is implemented in
`apps/host/src/scheduler/dag-scheduler.ts` and composed into `DurableOperationalStore`:

- Graphs carry a Mission, topologically ordered nodes, task dependencies, per-graph
  parallelism, an opt-in `auto_resume` flag, timestamps, and a monotonic revision. Every
  mutation is journalled as `scheduler_graph`; compaction snapshots carry `scheduler_graphs`.
- Creation rejects duplicate Tasks, unknown/dangling dependencies, self-dependencies and
  cycles, then stores a stable topological order. A node is eligible only when every
  dependency is `completed`.
- Claims are fair across missions (fewest starts in the current round, then least-recently
  started graph), respect both per-graph and host-wide parallelism, and leave excess eligible
  work pending rather than failing it.
- A gated node starts in `awaiting_approval` and cannot be claimed until distinct human
  approvals meet its 1-5 quorum. No approval is implied by a role or ownership.
- Startup recovery marks running nodes interrupted. Only graphs with `auto_resume: true`
  return them to pending; all others require an explicit resume call. A resumed gated node
  with insufficient approvals returns to `awaiting_approval`.

Scheduling state is not execution authority: a claim names a Task, and execution still goes
through the Orchestration Kernel's exact `execute` grant and independent verifier. No
scheduler path auto-executes a Task. The host-wide execution cap and the existing kernel
capacity behavior remain unchanged.

Tests: `apps/host/tests/dag-scheduler.test.ts` (cycle/self/duplicate/unknown dependency
rejection, topological ordering, readiness, quorum, fairness, per-graph and host-wide
bounds, restart recovery, opt-in auto-resume, explicit resume, compaction).

## Tests required

- Cross-origin, DNS-rebinding, missing-CSRF, wrong-cookie, expired-session, and rate-limit
  denials over real loopback TLS.
- Passkey enrollment, authentication, recovery, and human-only administration.
- DAG ordering, fairness, bounded parallelism, restart recovery, and duplicate-delivery
  suppression for queued work.
- Quorum denial before mutation; automatic resume opt-in and exact-grant enforcement.
- Real cgroup aggregate memory/PID/CPU enforcement and Landlock filesystem denials; missing
  delegation fails closed.
- Real Seatbelt and Apple Containerization drills on macOS 26 Apple silicon.
