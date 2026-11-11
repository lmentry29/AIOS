# AIOS — Live Project State

Last verified: 2026-11-11 in the Freebuff cloud worktree. This snapshot distinguishes local
evidence from observed CI. Latest measured security code head: `ef02f27` (repository-pinned
gVisor runtime and reproducible rootfs provenance, following `54344f1`); its documentation
checkpoint follows. The historical heads below
remain the last explicitly recorded CI evidence in this file; re-check the pushed head
instead of reusing them. Code head `4422229` (authorized runtime policy retirement) sits above
the previously verified merge head `8c950e6`, which merged `upstream/main` at `767f30e` and
passed the `ci` (run `42887224979`), `conformance` (run `42887225101`), and `schema-check`
(run `42887224921`) workflows with PR #1 mergeable/clean. The docs-only CI-record commit
`c1dfa71` also passed; the security-hardening commits are newer and are recorded in
`docs/security/validation-ledger.md`.

## Repository and active change

- Repository: https://github.com/lmentry29/AIOS
- Visibility: public; default branch: `main`
- Active implementation branch: `community/open-source-foundation`
- Active pull request: [#1 — Prepare AIOS for responsible community adoption](https://github.com/lmentry29/AIOS/pull/1)
- PR status: open, draft, **not merged**. Do not merge while implementation and audit work remain.
- Measured security code head: `ef02f27` (`feat(security): verify gVisor runtime and rootfs provenance`; repository pin, archive/binary/rootfs verification, deterministic CI rootfs manifest, fail-closed tamper/missing-pin probes, and provenance evidence).
- Prior security code head: `54344f1` (`feat(security): add explicit gVisor provider and measured sandbox matrix`; gVisor provider, OCI bundle, rootfs validation, fail-closed isolation errors, drill/CI integration, and Docker engine metadata).
- Prior security code head: `40438a5` (`fix(security): use Docker-valid bind mount syntax`; measured Docker provider work landed in `dbee5c7`, with the CLI repair in `75f7371`).
- Prior security code head: `29eb496` (`ci(security): remove temporary adversarial drill probe`; the drill landed in `8093095`)
- Prior security code head: `550d0e5` (`ci(security): remove the temporary operator drill probe`; the guard itself landed in `fb7090a`)
- Prior security code head: `27ab654` (`feat(host): add human-only operator session administration`)
- Prior security code head: `b067501` (`feat(host): add durable session rotation and revocation`)
- Documentation checkpoint for this pass: the branch tip after `ef02f27`; read
  `git log --oneline -3` for the exact docs SHA.
- Historical policy pass: `4422229` with docs commit `aa86a4e`.
- Merge head with `upstream/main` (`767f30e`): `8c950e6`; CI was green there and PR #1 was
  mergeable/clean.
- `4422229` and docs commit `aa86a4e` sit above that merge head. Both workflow sets
  succeeded on `aa86a4e`; see Validation evidence for run ids.
- Do not push `main`. The implementation branch may be pushed to
  `upstream community/open-source-foundation`.

## Security hardening (2026-11-10)

- Operational journal recovery: offline checkpoint compaction (`compact-journal`) and
  integrity-checked, idempotent restore (`restore-journal`) are implemented under ADR-0025.
  Execution attempts and verifier result digests survive compaction. Archives are
  digest-verified but unsigned and unencrypted; retention is an operator duty.
- Zod 4.6.7 plus explicit bounds close F-014 and F-015. The schema generator uses native
  `z.toJSONSchema` with draft-07 input semantics, inline reuse, fail-closed cycles, and
  recursive `additionalProperties:false`; generated schemas are committed and checked by
  `schema-check`. Every canonical array now has a finite `maxItems` (256 ordinary entries;
  1,024 lifecycle/history entries), enforced by a runtime regression, a recursive
  generated-contract test, and a 1,000,000-entry/64 MiB drill. `TaskEnvironment` caps the
  dynamic `execution.env` map at 64 entries before value inspection and publishes
  `maxProperties: 64`; the extended drill rejects 100,000 keys with one issue under a 64 MiB
  heap. The temporary audit exception is removed.
- Policy lifecycle audit events now carry a canonical SHA-256 of the exact policy, recomputed
  on registry load; substituted policy content is rejected even when the event hash chain still
  verifies. This is F-009 tamper evidence, not a signature: external key custody, rotation, and
  detached-signature verification remain blockers.
- The deprecated macOS Seatbelt adapter has an executable fail-closed regression for
  non-macOS hosts; the host never falls back to an unisolated process. Real Seatbelt and Apple
  Containerization execution remain unverified.
- Per-run bubblewrap resource limits: every run installs `RLIMIT_AS` 1.25 GiB,
  deadline-aligned `RLIMIT_CPU`, and `RLIMIT_NPROC` 128 with trusted `prlimit` inside the
  namespace (ADR-0028). The wrapper proves exact `/proc/self/limits` and `Seccomp: 2`; missing
  proof is `sandbox_resource_limit_unavailable` and verifier-bound. Live memory bomb: exit 1,
  `Out of memory!`, `timed_out:false`. This is per-process, not aggregate cgroup, enforcement.
- Host sessions now have mandatory bounded expiry, durable generations, explicit rotation and
  terminal revocation, and task/run/evidence scope binding (ADR-0029). The journal persists
  the active generation and retired-token digests before acknowledgement; restart and
  compaction preserve the denial. Expired, unknown, malformed, rotated-away, revoked, and
  cross-scope tokens fail closed with structured 401 reasons. In-flight work authorized
  before rotation continues. F-013 is fixed; the residual is pre-provisioned tokens without
  login/MFA/rate limiting, one-time rotation delivery, and unencrypted loopback HTTP.
- Operator session administration (ADR-0030): the exact human-only `administer_sessions`
  action adds a grant-filtered `GET /v1/admin/sessions` and rotate/revoke-by-id routes, plus
  `list-sessions`/`rotate-session`/`revoke-session` CLI commands. The CLI reads the bearer
  token from an owner-only file and never prints a token except the single rotation result;
  exit codes distinguish usage (`2`), denial (`3`), not-found (`4`), and retired/conflict
  (`5`). CLI revocation denies the target on its next request and after restart; repeat
  revocation is idempotent. No authentication, scope-binding, or verifier-identity rule was
  weakened: a scoped token cannot use the admin surface, and the bootstrap principal has no
  implicit grant. The operator grant is itself a high-value bearer credential with no
  step-up or approval quorum.
- The operator drill is a required step in the Security workflow's live-sandbox job, in the
  same plain `run:` pattern as the existing resource-limit drill. A deliberate non-zero probe
  failed the job (run `42934134785`); the real drill passed on `550d0e5` (run `42934563018`,
  step 11, 13/13 steps). No workflow permission, pinned action, or isolation rule changed.
- The 21-case adversarial drill (`tools/security/adversarial-drill.mjs`) runs as a required
  step in the same Security `sandbox-live` job. It exercises the real bubblewrap provider,
  executor, durable ledger, and verifier against host-file reads, path traversal, symlink and
  hardlink tricks, secret leakage, host-loopback and raw-socket network attempts,
  capability/chroot escalation, CPU/PID exhaustion, cancellation and timeout orphans, disk
  quota, instruction smuggling, and forged, self-issued, replayed, and tampered verification.
  All 21 cases were denied or contained. A temporary probe (`c5a4a44`) failed Security run
  `42936839536` at step 11 with exit 1; the real drill passed `29eb496` in run `42937205409`,
  step 11, with 21 attack records. No workflow permission or isolation rule changed.
- The explicit Docker provider (`provider: docker` plus a locally present image) now creates a
  named container, inspects its read-only root, `network=none`, capability drop,
  no-new-privileges, a non-default seccomp profile, cgroup memory/PID/CPU limits, CPU rlimit,
  non-root host UID/GID, and workspace-only mount before `start --attach`, then kills and
  removes it on every exit path. The same 21-case production drill passed **21/21** in CI at
  `40438a5` (Security run `42943242036`, live job `130269803337`, step 13), kernel
  `7.0.0-1017-azure`, filter SHA-256 `87ae93a78692f192bb8272a9398bafe21c864dce3cf8d79f2f96a0313a7a1214`.
  Linux `auto` remains bubblewrap; Docker is explicit and fails closed, with no fallback.
  See ADR-0031 and F-006.
- The real Linux boundary was executed, not simulated: bubblewrap 0.9.0 on kernel 6.1.102
  passed the original 9/9 adversarial boundary cases, then 12/12 boundary/limit cases after
  the resource work, covering host-file reads, workspace symlink escape, network interfaces,
  environment clearing, PID-namespace privacy, writes outside the workspace, effective
  capabilities, background-workload cleanup, and memory/limits. Docker was measured separately
  in CI at `54344f1` (21/21); gVisor was measured locally and in CI at the same head (21/21).
  Seatbelt and Apple Containerization remain unverified or unavailable and are labelled as such
  in `docs/security/sandbox-matrix.md`.
- Timeout and cancellation now kill the provider's whole process group (with a direct-child
  fallback), covered by real parent/grandchild tests.
- Living security documentation lives in `docs/security/`: threat model, provider matrix,
  findings ledger, and validation ledger. The CI `Security` workflow runs the live sandbox
  suite with `bubblewrap` installed, plus a tracked-file secret scan and a production
  dependency audit, under `contents: read`.
- Independent verification is bound to the durable attempt: the verifier requires a
  completed attempt, the recorded executor principal, and a matching result digest, and
  records the execution ID and attempt in its decision evidence. Forged, unattempted, and
  wrong-principal results are rejected before the verification command runs.

## gVisor and measured Docker engine (2026-11-11)

- Explicit `provider: gvisor` plus an absolute, real, non-symlink, non-`/` `rootfs` builds a
  generated OCI bundle and runs `runsc --rootless --network=none run`; it does not use
  `runsc do` or the host rootfs. The workload has a read-only rootfs, one workspace bind,
  private namespaces, empty capabilities, `noNewPrivileges`, and OCI `RLIMIT_AS` 512 MiB,
  deadline-aligned `RLIMIT_CPU`, `RLIMIT_NPROC` 128, and `RLIMIT_NOFILE` 1024 (ADR-0032).
- gVisor records a `gvisor-sentry` boundary and `gvisor-oci-rlimit` mechanism, not a fabricated
  seccomp object. Missing proof raises `SandboxIsolationUnavailableError`, journals
  `sandbox_isolation_unavailable`, and is rejected by the independent verifier. Cleanup runs
  `runsc kill --all` and `runsc delete --force` on every exit path.
- CI at `54344f1` (Security run `42946929104`, live job `130281855560`) passed Docker and gVisor
  **21/21**. Docker measured engine **28.0.4**, `rootless:false`, security options `name=apparmor`,
  `name=seccomp,profile=builtin`, `name=cgroupns`; gVisor measured
  `runsc release-20261102.0`, rootless `true`; kernel `7.0.0-1017-azure`. gVisor install/rootfs
  export/drill were steps 14–16; Docker image build/drill steps 12–13.
- Local checks at `54344f1`: full gate **46/46**, 0 cached; host **158 passed / 17 skipped**;
  bubblewrap live **17/17**; bubblewrap adversarial **21/21**; gVisor **21/21** against a local
  minimal ~67 MiB rootfs. The local Docker daemon remains unreachable; Docker is CI-measured.
- Residuals are explicit: the gVisor runtime is repository-pinned and the rootfs is
  reproducible with a canonical manifest, but the pin/manifest are unsigned, the Debian base
  tag/apt versions are not pinned, a host writer can replace the runtime/rootfs after hashing,
  and the manifest excludes ownership/timestamps. Rootless gVisor is single-UID, no
  netstack/save-restore, and has no host cgroup; disk remains the 25 ms sampler; CPU ended by
  deadline `SIGKILL`; gVisor is not a VM. Docker rootless mode, signed images, and a
  local/operator-controlled daemon remain unverified. Seatbelt/Apple Containerization remain
  unavailable/unverified. Bubblewrap remains the Linux default because it is the smallest
  unprivileged boundary and needs no daemon, image, or external runtime.

## gVisor runtime and rootfs provenance (2026-11-11)

- `tools/security/gvisor-runtime.pin.json` pins the gVisor release archive SHA-512, extracted
  `runsc` SHA-256, expected version, architecture, and HTTPS URL. The provider reads this
  repository-owned pin by default, verifies the actual executable and canonical rootfs on every
  check/run, and uses the verified absolute path. A missing, malformed, symlinked,
  architecture-mismatched, or digest-mismatched pin raises `SandboxIsolationUnavailableError`
  before a probe or drill; there is no fallback.
- `tools/security/gvisor-rootfs.json` and `tools/security/gvisor-provenance.mjs` build the drill
  rootfs from `aios-sandbox:local` via `docker create` → `docker export --output` → `tar -xf
  --no-same-owner`, export it twice, and require the same canonical digest. The manifest records
  the source image, image ID, Dockerfile SHA-256, package set, exclusions, and construction.
- CI at `ef02f27` (Security run `42950936794`, live job `130294805697`) passed: install step 14
  measured `runsc release-20261102.0`, binary
  `c5a5a7ba1209b605d08874fdd4429035f95afcb2d482bc95ed3fb13d31a25098`, archive
  `2e6671bb…`, pin `20c017d9…`; fail-closed step 15 observed the tampered-archive and
  missing-pin errors; rootfs step 16 measured `c7004df1…` (6,221 entries), image ID
  `3ee869b8…`, Dockerfile `b3bff352…`, manifest `b8115b66…`, with both exports identical; drill
  step 17 passed **21/21** with per-case provenance `ce8ac1c8…`. Local **21/21** used rootfs
  `2e7a3eba…` (2,693 entries) and the same pin/runtime. Full gate **46/46**, 0 cached; host
  **165 passed / 17 skipped**; bubblewrap **21/21**.
- F-017 is mitigated for accidental substitution but remains an accepted residual; F-018 records
  the unpinned base-image/apt and metadata-attestation gap.

## Current package and application maturity

Nine workspace packages contain domain implementations at different maturity levels.
`apps/host` is an application/composition root, not a tenth package.

| Component | Current state |
|---|---|
| `@aios/core` | Established Zod schemas and generated JSON Schema, including the fixed `local_command` Task execution/verification specs |
| `@aios/objects` | In-memory object store with lifecycle, relationship, immutability, mutation guards, and recovery-only `restore()` |
| `@aios/work-hierarchy` | Task and Objective stores; Mission remains a typed reference with no backing record |
| `@aios/containers` | Project store only; eight container concepts remain unpromoted by ADR-0011 |
| `@aios/agents` | Agent lifecycle/conformance runner; not a general tool-executing agent runtime |
| `@aios/tools` | Plugin lifecycle management; general adapter invocation remains deferred |
| `@aios/learning` | Knowledge records and evolution stages; permanent stages require a recorded human approval; in-memory default with a durable host journal |
| `@aios/founder` | Authorization-gated reads, human-only decision capture/review, default-deny policy with exact grant binding including human-only `administer_policy`/`revoke_policy`, atomic runtime replacement and retirement with per-resource fallback history, read-only vault/Gmail/Notion evidence adapters; live integrations unverified |
| `@aios/orchestration` | Authorized ordered dispatch, verifier identity/permission checks with verifier-attributed evidence binding, evidence artifacts, status/evidence reads, cancellation preflight/checks, authorized resume/retry orchestration, and read-only Task/Workflow attempt-chain inspection with all-or-nothing step authorization; execution is injected |
| `apps/host` | Loopback-only trusted host: owner-only config, bearer sessions, one policy evaluator, durable v2 policy registry/audit, exact-granted human-only runtime policy publication and retirement, durable journal, idempotent leased dispatch, fixed sandboxed `local.exec`, independent verifier, per-Task execution ledger with append-only attempts, authorized cancellation and resume/retry, all-or-nothing read-only attempt-history routes, verifier-bound evidence reads, approval-gated durable learning journal, durable allow/deny authorization audit with request correlation, strict concurrency cap, and recovery-to-suspended |

Not production-ready. There is no UI, no general capability/provider runtime, no secret
broker, no signed verifier provenance, no detached policy signature, no automatic
retry/backoff loop, and no live external-provider verification.

## Architecture decisions

- ADR-0013 — **Accepted (2026-11-08)**: resource-attached, exact-match, default-deny
  authorization; deny overrides allow; no wildcard or owner-implied grants; identity comes
  from the trusted host; policy lifecycle and decisions require durable append-only audit.
- ADR-0014 — **Accepted (2026-08-17)**: the Obsidian vault is the Founder Intelligence
  persistence substrate; no parallel Founder database; read-and-propose by default;
  permanent Memory requires explicit human review/authorization.
- ADR-0015 — **Accepted (2026-11-10)**: hash-chained, fsync'd append-only operational
  journal for Task/Workflow/Artifact/run/execution state, with idempotency, leases, tamper
  detection, and recovery-to-suspended. No compaction or migration framework yet.
- ADR-0016 — **Accepted (2026-11-10)**: `packages/*` are the platform domain; `apps/host`
  is the trusted local application; UI is an untrusted future client. The host rejects every
  `Origin` until a session/CSRF/cookie ADR exists.
- ADR-0017 — **Proposed (2026-11-10)**: Mission as a Canonical Object subtype. Blocked on a
  sourced field-level model; do not invent a sixth entity or merge Mission with containers.
- ADR-0018 — **Proposed (2026-11-10)**: infrastructure records as canonical objects with
  secret references only. No infrastructure store or secret broker exists.
- ADR-0019 — **Accepted (2026-11-10)**: fixed `local.exec`, fail-closed sandbox providers
  (Docker/bubblewrap/Seatbelt), bounded/hashed evidence, and an independently executed
  verifier command. Verification decisions name their verifier, the identity is persisted in
  evidence, and evidence reads fail closed on a missing or mismatched verifier; signing and
  key management remain open.
- ADR-0020 — **Accepted (2026-11-10)**: `@aios/*` remain private; distribution is an
  application artifact under named release profiles. No npm publication.
- ADR-0021 — **Accepted (2026-11-10)**: exact authorized `cancel`; durable per-Task
  execution ledger; process termination via `AbortSignal`/`SIGKILL`; strict
  `execution.max_concurrent_tasks` (1–32, default 1) with deterministic 429 rejection; startup
  reconciliation of interrupted executions without re-execution or duplicate terminal effects.
- ADR-0022 — **Accepted (2026-11-10)**: deliberate `resume` (interrupted) and `retry`
  (failed/cancelled/unverified completed) as new append-only execution attempts. Workflow and
  Task are both resume units; a cancelled record is never reopened. Authorization is exact and
  precedes lookup; resumed work re-enters the same cap and startup never auto-resumes.
  Attempts are not capped at two across repeated crashes; every generation links to its
  immediate predecessor. Repeated reconciliation over an already-interrupted attempt writes
  nothing, and concurrent duplicate resume/retry requests return typed 409 before a second
  attempt or sandbox start. A read-only attempt-history API returns the full chain with
  oldest-first predecessor links under exact `read_status`; it never transitions, appends,
  or executes. Workflow inspection is all-or-nothing: every declared step Task is authorized
  before any history is read, so one missing grant denies the whole request with no partial
  chain.
- ADR-0023 — **Accepted (2026-11-10)**: runtime policy administration. A human principal
  with an exact `administer_policy` grant on every target may publish and attach a new
  immutable policy through `POST /v1/policies`. The registry validates the artifact, version,
  and rule scope and commits the policy plus all attachments atomically. Every attempt is in
  the durable authorization decision journal; audit failure blocks mutation. A malformed,
  stale, or out-of-scope artifact leaves the prior policy effective. The offline
  `publish-policy` CLI remains the bootstrap path. There is no detached policy signature yet;
  authorized runtime retirement is added by ADR-0024.
- ADR-0024 — **Accepted (2026-11-10)**: authorized runtime policy retirement. `revoke_policy`
  is an exact, human-only action distinct from `administer_policy`. The human-only
  `POST /v1/policies/:policyId/revoke` requires the complete set of resources whose policy
  history references the version and an exact grant on every one of them. Retirement removes
  the version from every history, reattaches the newest remaining version, or leaves the
  resource with no policy and a fail-closed deny; the version is marked permanently retired
  and cannot be reattached. Registry state moves to v2 and a v1 file migrates without
  inventing a fallback. The offline `revoke-policy` CLI mirrors the route. There is still no
  detached policy signature, key rotation, external audit custody, or multi-host
  administration.
- ADR-0029/ADR-0030 — **Accepted (2026-11-11)**: durable host session lifecycle plus
  human-only operator administration. Sessions require bounded expiry, persist generations
  and retired digests in the operational journal, and carry optional task/run/evidence scope
  bindings. The exact human-only `administer_sessions` action adds a grant-filtered list and
  rotate/revoke-by-id routes; the CLI is a transport with owner-only token-file input and
  stable exit codes. Revocation is terminal and restart-durable; rotation delivers one new
  token to the operator. Login/MFA, TLS, rate limiting, and external audit custody remain
  open.
- ADR-0031/ADR-0032 — **Accepted (2026-11-11); ADR-0032 amended for provenance**: explicit
  Docker and gVisor providers over the same executor, durable ledger, managed port, and
  independent verifier. Docker adds aggregate cgroups and a read-only container rootfs but trusts
  a privileged daemon and measured rootful mode; gVisor adds a user-space Sentry boundary, OCI
  rlimits, a rootless runtime, a repository-pinned `runsc`, and a reproducible rootfs manifest,
  but has no host cgroup and its pin/manifest/base image are unsigned or unpinned. Both fail
  closed; Linux `auto` remains bubblewrap. Rootless Docker, signed artifacts/images, and
  local-daemon measurement remain open.
- ADR-0012 — **Proposed**: capability mediation remains the intended general model, but the
  first slice intentionally uses only fixed `local.exec`; provider selection is not exposed.

## Validation evidence

At code head `ef02f27` (2026-11-11): forced workspace gate **46/46**, **0 cached**; host
**165 passed / 17 skipped**; bubblewrap adversarial **21/21**; gVisor adversarial **21/21**
with the repository-pinned `runsc` and local rootfs `2e7a3eba…` (2,693 entries). The exact
Security run ids and per-case results are in `docs/security/validation-ledger.md`. All four
PR workflows (CI `42950936687`, Conformance `42950936691`, Schema Check `42950936700`, Security
`42950936794`) succeeded on `ef02f27`; the Release workflow is dispatch-only.

Local checks at code head `4422229` (Node 26.13.0, pnpm 11.11.0):

- `pnpm -r run build` — pass.
- `pnpm -r run typecheck` — pass.
- `pnpm -r run lint` — pass.
- `pnpm -r run test` — pass, **513 tests total**.
- Host: **106 tests** in 9 files, including 51 loopback HTTP tests, cancellation with a
  test-only sandbox stub, a real child-process SIGKILL test with a labelled
  `test-only-process` provider, cap enforcement/retry, late-result rejection, journal-level
  crash/restart reconciliation, authorized resume/retry over append-only attempts, a
  three-generation persisted resume chain, duplicate concurrent redrive suppression, a
  no-write second reconciliation over an already-interrupted attempt, read-only
  three-generation attempt inspection that leaves the operational journal byte-identical,
  all-or-nothing Workflow attempt inspection that denies a first- or later-step missing
  `read_status` grant before any ledger history read and leaves both persisted Task ledgers
  unchanged after reopen, verifier-attributed evidence that still reads after reopening
  with the original verifier but is rejected after a verifier swap or when identity is
  missing, a durable learning journal whose approved permanent Memory promotion and consumed
  approval survive close-and-reopen while unapproved and rejected approvals write no
  permanent entry, a durable authorization-audit journal whose allow/deny records survive
  restart in order with request correlation, and authorized runtime retirement that falls back
  to a retained version and then denies when none remains.
- Authorization audit: **6 store tests** plus host restart/grant cases, including five
  runtime policy-publication and four retirement cases. Allow and deny records include request id, principal,
  action, resource, policy/version, fixed reason, and the decisive rule; reopen preserves
  order and integrity, tamper and torn-tail handling are covered, and a failed append denies
  without recording a phantom decision.
- Learning: **28 tests**, including 13 approval tests. `memory-approval.test.ts` proves
  default denial, rejected/expired/pending approvals write nothing, human-only decisions,
  exact content/transition binding, one-time consumption, and unchanged draft promotions.
  `apps/host/tests/learning-store.test.ts` proves an approved promotion and its consumed
  approval survive close-and-reopen, and a rejected approval leaves no permanent entry.
- Core: **46**; conformance: **107**; integration: **43**; objects: 32; founder: 61;
  orchestration: 30; tools: 9; work-hierarchy: 24; containers: 21; learning: 28; agents: 6.
- `pnpm --filter @aios/core run generate:schemas` — pass; `git diff --exit-code
  schemas/generated` — clean.
- At hardening head `24d2791`: full workspace gate **46/46 tasks**; host **132 passed/17
  skipped**; core **47**; founder **62**; live bubblewrap **17/17**; resource-limit, quota,
  and seccomp drills all exit 0; production audit **0 triaged**; secret scan **272 tracked
  files, no findings**. The 17 skipped host tests are the live suites run separately with
  `AIOS_BWRAP_DIR` set.
- At F-013 head `b067501`: full workspace gate **46/46 tasks**; host **148 passed/17 skipped**
  (HTTP **57**, identity **9**, session lifecycle **6**); core **51**; live bubblewrap
  **17/17**; resource-limit, quota, seccomp, and collection drills all exit 0; production audit
  **0 triaged**; secret scan **273 tracked files, no findings**. The real HTTP expiry case and
  the restart/compaction rotation/revocation cases are included in the host count.
- At operator-administration head `27ab654`: full workspace gate **46/46 tasks** (forced, no
  cache); host **152 passed/17 skipped**; founder **63**; core **51**; live bubblewrap
  **17/17**; the operator drill ran **13 steps**; resource-limit, quota, seccomp, collection,
  and operator drills all exit 0; production audit **0 triaged**; secret scan **276 tracked
  files, no findings**.
- At adversarial head `29eb496`: full workspace gate **46/46 tasks** (forced, no cache); host
  **152 passed/17 skipped**; founder **63**; core **51**; live bubblewrap **17/17**; adversarial
  drill **21/21**; resource-limit, quota, seccomp, collection, operator, and journal drills exit
  0; audit **0 triaged**; secret scan **281 tracked files, no findings**. Security run
  `42937205409`, job `130250095076`, step 11 passed with 21 attack records; probe run
  `42936839536`, job `130248895128`, step 11 failed with exit 1.
- At CI-guard head `550d0e5`: full workspace gate **46/46 tasks** (forced, no cache); host
  **152 passed/17 skipped**; founder **63**; core **51**; live bubblewrap **17/17**; operator
  drill **13/13**; resource-limit, quota, seccomp, and collection drills exit 0; audit **0
  triaged**; secret scan **281 tracked files, no findings**. Security run `42934563018`
  passed step 11 `Run node tools/security/session-operator-drill.mjs` with all 13 steps in the
  log; probe run `42934134785` failed at that same step with exit 1.
- At Docker code head `40438a5`: full workspace gate **46/46 tasks** (forced, no cache); host
  **154 passed/17 skipped**; live bubblewrap **17/17**; bubblewrap adversarial **21/21**;
  Docker adversarial **21/21** in CI; resource-limit, workspace-quota, seccomp, collection,
  operator, and journal drills all exit 0; audit **0 triaged**; secret scan **283 tracked
  files, no findings**. Security run `42943242036` (live job `130269803337`) passed step 13 with
  the 21 Docker case records; `ci` run `42943242089`, `conformance` run `42943242041`,
  `schema-check` run `42943242116`, and the supply-chain job `130269803066` were green. The
  earlier Docker probes `dbee5c7` and `75f7371` failed closed on CLI-invalid `--ulimit as` and
  bare `rw` mount syntax respectively, then were repaired.
- CI on the exact pushed head `15bc7f8`: `ci` (run `42933005083`), `conformance` (run
  `42933005064`), `schema-check` (run `42933005025`), `security` (run `42933005020`), and the
  dispatched `release` build (run `42933109086`) all succeeded. PR #1 remained open, draft,
  and unmerged; `main` stayed at `767f30e`.
- GitHub Actions on `aa86a4e`: `ci` (run `42892775891`), `conformance` (run
  `42892776172`), and `schema-check` (run `42892775877`) all succeeded; PR #1 reported
  `mergeable: true`, `mergeable_state: unstable` while those runs were in flight. The
  docs-only CI-record commit after `aa86a4e` has its own runs; do not infer their result
  from this line.

The command and test results above are local, not CI. The real Docker provider was measured
in CI, not locally: `docker info` still cannot reach a daemon on this host (`permission denied
while trying to connect to the docker API at unix:///var/run/docker.sock`). Bubblewrap was
measured locally and in CI; `podman` and `sandbox-exec` are absent. The cancellation,
multi-generation resume/retry, and crash tests use clearly labelled test-only process/sandbox
doubles where a real isolation provider is unavailable; they do not claim container isolation.

## Production blockers — not optional

1. **Execution isolation proof.** Bubblewrap and the explicit Docker provider have measured
   adversarial matrices, including cancellation, container kill, mount/network denial, and
   CPU/PID limits. Bubblewrap has a generated seccomp deny-list and per-process RLIMIT
   enforcement (ADR-0027/ADR-0028) but no aggregate cgroup accounting, no active Landlock, and
   remains trusted-local only. Docker has measured aggregate cgroups but no per-process
   `RLIMIT_AS`; rootless Docker, Seatbelt, and Apple Containerization remain unverified, while
   gVisor is measured in ADR-0032 with a repository-pinned runtime and reproducible rootfs
   digest, but unsigned pin/base-image provenance, single-UID, and no-host-cgroup residuals
   remain.
   Node/libuv is currently killed by the seccomp io_uring denial at startup.
2. **Verifier provenance.** A distinct configured verifier plus an independently executed
   command is implemented, but there is no signed decision, key rotation, or protection from
   a compromised host process.
3. **Execution re-drive quality.** Resume/retry are deliberate, authorized, append-only
   operations (ADR-0022), and the cap still rejects rather than queues. There is no automatic
   retry, backoff loop, scheduler, or capacity queue. Multi-generation resume, duplicate
   suppression, and cancellation across generations are proven only against the labelled
   `stub-container` double, not a real Docker/bubblewrap/Seatbelt provider.
4. **Mission/infrastructure models.** ADR-0017 and ADR-0018 are proposed; no Mission store,
   infrastructure inventory, or secret broker exists.
5. **Identity/policy lifecycle.** Bearer sessions, a durable policy registry, exact-granted
   runtime publication and retirement, and a durable hash-chained decision audit exist, but
   there is no user-facing login, detached policy signature, policy recovery/key-rotation
   procedure, or independent external audit custody. Registry state is v2 and has no
   downgrade path. The offline `publish-policy` and `revoke-policy` CLIs remain the bootstrap
   paths. Session administration is exact-granted and human-only, but there is no step-up,
   approval quorum, or rate limiting for the operator grant.
6. **Founder Intelligence quality.** The vault adapter is read-only and collection-scoped;
   per-note authorization, retrieval/context assembly, contradiction detection, and reviewed
   Founder vault memory writes remain open. Organizational Learning Memory now has
   approval-gated permanent stages, but that does not authorize any vault mutation. Do not
   bulk-migrate or modify the vault.
7. **Live connectors.** Gmail/Notion/Obsidian++ need OAuth/token lifecycle, scopes, health,
   pagination, rate limits, retries, and live integration tests.
8. **UI.** No UI exists. The host rejects all browser origins by design (ADR-0016).
9. **Orchestration depth.** No dependencies, scheduler, parallelism, approval gates, or
   automatic resume of suspended work.
10. **Operations.** No journal compaction/migrations, automated backup/restore drill,
    metrics/tracing/alerting, threat model, incident runbook, or SLOs.
11. **Release.** No installer, signed update channel, or supported npm install path.

## Next work order

1. Exercise runtime policy publication and retirement in a production-like deployment with a
   real non-bootstrap operator, independent audit consumer, and restart/recovery drill; local
   tests are not operational deployment proof.
2. Test rootless Docker, Seatbelt, and Apple Containerization on capable hosts and record the
   actual results, including cancellation and the explicit Docker container kill. Re-run the
   measured Docker and gVisor CI matrices when the runner, image, runtime, rootfs, or engine
   changes.
3. Add verifier key provenance or explicitly retain and document the host-trust model.
4. Exercise multi-generation resume/retry against real sandbox providers, including repeated
   crashes, cancelling generation 2, and workspace reuse across generations.
5. Source/review the Mission field model before adding any Mission API/schema.
6. Build a secret broker before any provider credential is introduced.
7. Keep PR #1 draft; do not merge or push `main`.
8. Define detached policy signatures and a key-recovery/rotation procedure before treating
   runtime policy administration as production security. Revocation itself is implemented;
   what is missing is protection against a rewritten policy file and key compromise.

## Source-of-truth rules

- This file is a status snapshot, not architectural authority.
- `docs/architecture/` and accepted ADRs govern normative behavior.
- `docs/process/divergence-log.md` records unresolved differences.
- Update this file only from fresh repository and test/CI evidence; never copy an old status
  forward without re-verification.
