# Autonomous Implementation Handoff

Single source of truth for cross-session continuation. Do not create competing progress
documents; update this one.

Last updated: 2026-11-11 (Freebuff Cloud session, pinned gVisor build inputs and independent-
image rootfs reproduction after the measured Docker/gVisor matrix). Latest measured security
code head: `378e7d6` (pinned base/snapshot/packages, independent no-cache rebuild comparison,
and path-level mismatch diagnostics), following `ef02f27`, `103b521`, `54344f1`,
`40438a5`, `29eb496`, `550d0e5`, `27ab654`, and `b067501`; its documentation checkpoint follows. Re-check this head rather than
older CI lines below. F-009's digest mitigation, F-005's fail-closed regression, the bounded
canonical collections, and the live bubblewrap controls remain in place from
`24d2791`/`43e2dd6`.

## Repository state

- Repository: `lmentry29/AIOS` (public)
- Branch: `community/open-source-foundation`
- Pull request: https://github.com/lmentry29/AIOS/pull/1 (open, draft, **not merged**)
- Measured security code head: `378e7d6` (`fix(security): normalize gVisor rootfs build state`; pinned base/snapshot/packages, independent no-cache rebuild comparison, and path-level mismatch diagnostics).
- Prior security code head: `ef02f27` (`feat(security): verify gVisor runtime and rootfs provenance`; repository pin, archive/binary/rootfs verification, deterministic rootfs manifest, fail-closed probes, and evidence plumbing).
- Pinned-input code commit: `103b521` (`feat(security): pin gVisor rootfs build inputs`; base digest, Debian snapshot, exact packages, pin guard, independent build, regressions).
- Prior security code head: `54344f1` (`feat(security): add explicit gVisor provider and measured sandbox matrix`; gVisor provider/OCI bundle/rootfs validation/fail-closed errors/drill/CI and Docker engine metadata).
- Prior security code head: `40438a5` (`fix(security): use Docker-valid bind mount syntax`; the Docker provider landed in `dbee5c7`; CLI repairs in `75f7371` and `40438a5`).
- Prior security code head: `29eb496` (`ci(security): remove temporary adversarial drill probe`; the drill landed in `8093095`)
- Prior security code head: `550d0e5` (`ci(security): remove the temporary operator drill probe`; the guard itself landed in `fb7090a`)
- Prior security code head: `27ab654` (`feat(host): add human-only operator session administration`)
- Prior security code head: `b067501` (`feat(host): add durable session rotation and revocation`)
- Documentation checkpoint for this pass: the branch tip after `378e7d6`; read
  `git log --oneline -3` for the exact docs SHA.
- Historical policy pass: `7103957` with docs commit `0a1ae66`.
- Merge head with `upstream/main` (`767f30e`): `8c950e6`; all three PR workflows passed and
  PR #1 is mergeable/clean.
- This handoff is the documentation checkpoint after the measured security head; read
  `git log --oneline -3` for the exact tip. Push only `community/open-source-foundation`;
  do not push `main` and do not merge PR #1.
- Prior commits in this session:
  - `7103957` — authorized runtime policy publication with atomic replacement
  - `15ff877` — durable authorization decision audit with request correlation
  - `503cefb` — human-approved, durable permanent Memory binding
  - `05769e1` — verifier-attributed, persisted evidence binding
  - `8cd427a` — all-or-nothing Workflow attempt inspection
  - `0b01cec` — read-only Task/Workflow attempt-chain inspection
  - `a816fe3` — multi-generation attempt chains, no-write reconciliation, duplicate redrive suppression
  - `ce876cf` — authorized resume/retry over append-only attempts
  - `eea8b2c` — verified Task execution lifecycle record
  - `21ccdb0` — authorized Task/Workflow list routes
  - `cb16610` — Docker isolation argv test
  - `2d68052` — workspace permissions and one-Action evidence fix
  - `70f07b4` — fixed local execution, sandbox providers, independent verifier
  - `b5dc5d9` — durable hash-chained operational journal
  - `a7d930a` — durable-persistence evidence and handoff
  - `27ab654` — human-only operator session administration and executable operator drill
  - `fb7090a` — operator drill added to the Security workflow, with a temporary failure probe
  - `550d0e5` — real drill restored; probe removed after the red run demonstrated exit propagation
  - `8093095` — 21-case adversarial sandbox and verifier drill, wired into the Security workflow
  - `c5a4a44` — temporary non-zero probe for adversarial drill failure propagation
  - `29eb496` — real adversarial drill restored; probe removed
  - `dbee5c7` — explicit Docker sandbox provider, custom seccomp, CI Docker image/drill, regressions
  - `75f7371` — remove Docker CLI-rejected `--ulimit as`; keep cgroup memory and CPU rlimit
  - `40438a5` — correct Docker bind mount syntax and pin the exact mount argument
  - `54344f1` — explicit gVisor provider, generated OCI bundle/rootfs validation, fail-closed Sentry evidence, 21-case Docker/gVisor CI matrix, and measured Docker engine/rootless metadata
  - `ef02f27` — repository-pinned gVisor runtime, canonical rootfs manifest/double export, fail-closed tampered/missing-pin probes, provenance evidence, and F-017 mitigation
  - `103b521` — pinned gVisor base digest, Debian snapshot, exact packages, input guard, independent image build, and drift regressions
  - `378e7d6` — normalized build caches/logs, path-level reproducibility diff, and independent-image digest agreement

## Environment notes

- Node `26.13.0`, pnpm `11.11.0`, Linux `6.1.102`.
- **pnpm may be missing after a VM restart.** Install locally if needed:
  `npm i -g --prefix "$HOME/.local" pnpm@11.11.0` (binary at `~/.local/bin/pnpm`), then
  `pnpm install --frozen-lockfile`.
- **Turborepo root quirk:** Turbo resolves `/workspace` and cannot create `/workspace/.turbo`
  in this worktree, so use `pnpm -r run <task>` locally. GitHub Actions is unaffected.
- Docker CLI is present but the daemon is not reachable to this user
  (`permission denied ... /var/run/docker.sock`); `podman` and `sandbox-exec` are absent.
  Docker was measured in GitHub Actions; bubblewrap was measured locally and in CI; gVisor was
  measured locally against a disposable `/tmp/aios-gvisor-rootfs-clean` and in CI from the
  Docker-exported rootfs. Seatbelt remains unavailable. Every provider fails closed when its
  probe fails.
- **gVisor local setup is disposable.** `runsc` lives at `/tmp/gvisor-install/runsc` and the
  minimal rootfs at `/tmp/aios-gvisor-rootfs-clean`; both may disappear after a VM restart.
  The runtime is checked against `tools/security/gvisor-runtime.pin.json`; the local rootfs
  manifest is `/tmp/aios-gvisor-rootfs-clean.local.manifest.json` and its source is intentionally
  empty because it is not the Docker recipe. CI reproduces the runtime from the pinned release
  and the rootfs from two independently built no-cache images. Recreate before re-running
  the gVisor drill rather than treating stale `/tmp` paths as evidence.
- GitHub Actions passed `ci` (run `42887224979`), `conformance` (run `42887225101`), and
  `schema-check` (run `42887224921`) at merge head `8c950e6`; PR #1 is mergeable/clean. Earlier
  heads `8cd427a`/`c64ba42` and docs tip `e65688e` also passed. The docs-only verification
  commit after `8c950e6` has its own checks; re-check it rather than treating this line as
  covering a later tree.

## Completed — gVisor provider and cross-provider selection (`54344f1`)

- `apps/host/src/execution/sandbox.ts` adds `GvisorSandbox`: an explicit `provider: gvisor`
  plus absolute, real, non-symlink, non-`/` `rootfs`, a generated OCI bundle, and
  `runsc --rootless --network=none run`. It never uses `runsc do`, never binds the host root,
  and never falls back from a failed probe.
- The OCI process has a read-only rootfs, one workspace bind, private PID/network/IPC/UTS/mount
  namespaces, PID 1, empty capabilities, `noNewPrivileges`, `RLIMIT_AS` 512 MiB,
  deadline-aligned `RLIMIT_CPU`, `RLIMIT_NPROC` 128, and `RLIMIT_NOFILE` 1024. The Sentry
  boundary is recorded as `gvisor-sentry`; limits as `gvisor-oci-rlimit`. A missing boundary is
  `sandbox_isolation_unavailable` and is verifier-rejected. Cleanup runs `runsc kill --all` and
  `runsc delete --force` on every exit path.
- The drill accepts `AIOS_SANDBOX_PROVIDER=gvisor` + `AIOS_GVISOR_ROOTFS`; the Security workflow
  installs pinned `runsc 20261102.0` (SHA-512 verified), exports a rootfs from the Docker image,
  and runs the drill as plain `run:`. Bubblewrap/Docker steps, assertions, pins, and timeouts are
  untouched.
- Measured at `54344f1`: Security run `42946929104`, live job `130281855560`; Docker and gVisor
  both **21/21**. Docker `28.0.4`, `rootless:false` (rootful; apparmor/builtin seccomp/cgroupns);
  gVisor `runsc release-20261102.0`, rootless true; kernel `7.0.0-1017-azure`. Local gVisor
  **21/21** against a minimal ~67 MiB rootfs; local gate **46/46**; host **158 passed / 17
  skipped**; bubblewrap live **17/17** and adversarial **21/21**.
- Residuals at this head (superseded by the provenance work below): operator-owned unsigned
  rootfs/runtime; rootless single-UID, no netstack/save-restore; no host cgroup; disk sampler;
  CPU deadline `SIGKILL`; not a VM. Docker rootless, signed images, and a local daemon remain
  unverified. ADR-0032 records the decision; F-006/F-007/F-016 were updated and F-017 was added.
  Bubblewrap remains the Linux default.

## Completed — pinned runtime and reproducible rootfs (`378e7d6`)

- `tools/security/gvisor-runtime.pin.json` pins release `20261102.0`, archive SHA-512
  `2e6671bb…`, extracted `runsc` SHA-256 `c5a5a7ba…`, expected version, architecture, and HTTPS
  URL. `apps/host/src/execution/provenance.ts` parses it, rejects missing/malformed/symlinked
  pins, hashes files, verifies pinned artifacts/rootfs, and resolves the actual executable.
- `GvisorSandbox` verifies the pin/runtime/rootfs before `check()` and `run()`, uses the verified
  absolute binary path, and returns provenance; executor and verifier evidence carry the pin,
  release, version, archive digest, binary digest, rootfs digest, and entry count. A failure
  raises `SandboxIsolationUnavailableError`; no fallback.
- `tools/security/docker-sandbox.Dockerfile` builds from the `linux/amd64` manifest digest
  `sha256:c67e92c8…` under the recorded index `734a72b3…`, reads the Debian snapshot at
  `20261110T000000Z`, and installs exact `coreutils`, `perl`, and `util-linux` versions.
  `tools/security/gvisor-rootfs.json` records those inputs and the pin SHA-256 `9fccac3e…`.
  `gvisor-provenance.mjs` adds `verify-rootfs-pin`, `verify-platform-digest` and
  `build-rootfs --compare-image`; the latter rejects same-image comparison and differing
  digests. Outputs are staged and promoted atomically; the manifest is v2 (ownership, permission
  bits, mtime and extended attributes); the runtime executes from a private measured copy and the
  rootfs executes from an invocation-owned copy that must measure identically.
- `tools/security/adversarial-drill.mjs` requires `AIOS_GVISOR_ROOTFS_MANIFEST`, compares the
  provider's rootfs digest/entries to it, records the manifest, and puts provenance digests on
  every case. Security workflow steps 12 and 15–19 validate the pin, rebuild the image
  independently, prove tampered/missing pins fail closed, build the rootfs, and run the drill.
  Bubblewrap/Docker steps and all existing assertions remain untouched.
- CI at `cc8c1df`: Security run `42963634931`, steps 12–21; platform digest `c67e92c8…`
  verified as the child of index `734a72b3…`; independent images `8702c6e9…`/`de61bccf…`
  both produced manifest-v2 rootfs `8d7514ae…` (6,195 entries; `content_sha256 6e1376d8…`,
  `metadata_sha256 bf8da6b6…`, xattrs captured); gVisor **21/21** with provenance `d0f27232…`;
  Docker **21/21**; bubblewrap **21/21**; CI `42963634937`, Conformance `42963635037`, Schema
  `42963634950` green.
- CI at `378e7d6`: Security run `42956393498`, live job `130312417881`; pin guard `9fccac3e…`;
  install measured `runsc release-20261102.0`, binary `c5a5a7ba…`, archive `2e6671bb…`, pin
  `20c017d9…`; independent run-scoped images `89eacf2a…` and `a8abdab0…` both produced rootfs `6e1376d8…`
  (6,195 entries), Dockerfile `5acad18a…`, manifest `845c9853…`; drill **21/21** with per-case
  provenance `8490ada2…`. Fail-closed observed errors are in the validation ledger. Local
  **21/21** used rootfs `2e7a3eba…` (2,693 entries) and the same pin/runtime; full gate **46/46**,
  host **168 passed / 17 skipped**, bubblewrap **21/21**.
- Residuals: pin/base/snapshot/manifest are unsigned; upstream is not Sigstore-verified; the
  Debian snapshot must remain available; a same-UID host writer remains inside the host trust
  boundary. F-017 is mitigated for accidental substitution; F-018 is fixed for deterministic
  build inputs and independent-image reproduction; F-019 is fixed for staged promotion,
  ownership-safe cleanup and verify-to-execute binding. Bubblewrap remains the Linux default.

## Completed — Task execution lifecycle (`d414cbe`)

The host now treats Task execution as a durable lifecycle rather than a fire-and-forget
call inside a dispatch.

### Durable execution ledger

- `apps/host/src/persistence/execution-ledger.ts` adds a per-Task `execution` journal record,
  separate from the dispatch `run` record. States are `running`, `completed`, `failed`,
  `cancelled`, and `interrupted`; terminal records are immutable.
- A record is appended before the sandbox starts. Success, failure, cancellation, and restart
  interruption each append exactly one terminal revision.
- Evidence is bounded to eight single-line strings of at most 300 characters. Result/evidence
  content is represented by SHA-256 digests; raw stdout/stderr and exception messages are not
  copied into the journal.
- `DurableOperationalStore` restores execution records on replay and rejects non-monotonic or
  post-terminal transitions.

### Authorized cancellation

- `cancel` is now an exact `AccessAction` in `@aios/founder` and the orchestration request
  union. The existing default-deny evaluator, resource attachment, deny-overrides, and
  append-only authorization audit are unchanged.
- `POST /v1/tasks/:id/cancel` authorizes before revealing Task existence. A matching allow is
  required; an intake-only policy receives 403 and no ledger record is written.
- The route accepts an optional bounded `reason`; only its SHA-256 digest is evidence. A
  repeated cancellation returns 200 idempotently. A terminal Task/execution returns 409.
- A queued (`created`) Task gets a terminal cancelled execution record but remains canonical
  `created`; a later dispatch is rejected by the kernel preflight. An active Task is moved to
  canonical `suspended`. **No `cancelled` lifecycle state was added**; ADR-0021 keeps
  cancellation in the execution ledger.
- The cancellation record is committed before aborting the executor. The managed executor
  wrapper rechecks the ledger after the sandbox returns, so a late success cannot overwrite
  cancellation.

### Real process termination

- `AbortSignal` is threaded through `SandboxRunSpec`, every provider, and
  `runCapturedProcess`. Aborting sends `SIGKILL` to the child.
- Docker runs with a unique `--name` and issues an explicit `docker kill` on abort; killing
  only the CLI would leave the container running.
- Bubblewrap already uses `--die-with-parent` and now receives the child abort; Seatbelt also
  receives it.
- `LocalCommandExecutor` owns one `AbortController` per active Task and exposes
  `cancelTask(taskId)`.
- The test-only process provider is explicitly labelled `test-only-process`: it uses the
  production process helper and proves a real child PID dies, but provides no isolation and
  is never selected by the host CLI.

### Verifier and completion ordering

- The kernel checks the execution ledger before dispatch lifecycle writes, before execution,
  immediately after execution, after verification, and before evidence/completion writes.
- If cancellation is observed before verification starts, the verifier is not called.
- If cancellation arrives while verification is already running, verification may finish, but
  the kernel cannot mark the Task complete and leaves it suspended.
- The managed executor wrapper also refuses to complete its record when the terminal state is
  no longer `running`.

### Bounded concurrency

- `execution.max_concurrent_tasks` is a strict host-config field: integer 1–32, default 1.
  Unknown fields, zero/negative/fractional/out-of-range/non-numeric values fail startup.
- The chosen policy is **non-blocking deterministic rejection**. A dispatch beyond the cap
  raises `ExecutionCapacityError` before the kernel's first lifecycle write and maps to HTTP
  429 `execution_capacity_exceeded`. The Workflow and Task remain `created` and can be
  retried when capacity is available.
- The managed executor enforces the same cap as a second line of defense; no more than the
  configured number execute concurrently.

### Restart reconciliation

- `DurableRunCoordinator` now also supports the terminal `cancelled` run state.
- At startup, before serving:
  - running dispatch runs become `interrupted`;
  - running Task executions become `interrupted` with `host_restarted`;
  - affected `active`/`monitored` Workflows and Tasks become `suspended` under the fixed host
    recovery actor.
- Recovery does not re-execute work, does not mark work completed, and does not append a
  second terminal execution record. A second fresh start is a no-op.
- The execution record is the authority for cancellation/recovery; canonical lifecycle stays
  within ADR-0003's existing state graph.

## Completed — deliberate resume and retry (`ce876cf`)

ADR-0022 resolves the previous "no resume" limitation without weakening terminal
cancellation or startup recovery.

### Append-only attempts

- `ExecutionRecord` now carries `attempt`, `attempt_kind` (`initial`/`resume`/`retry`), and
  `previous_execution_id`. `ExecutionLedger` keeps an ordered attempt chain per Task;
  `getForTask()` observes the latest attempt and `listForTask()` exposes immutable history.
- `start()` creates only attempt 1. `resume()` accepts only an `interrupted` predecessor;
  `retry()` accepts `failed`, `cancelled`, or unverified `completed` and rejects a running or
  interrupted predecessor. A cancelled record is never reopened or rewritten.
- Journal replay validates contiguous attempt numbers and matching predecessors. A
  pre-ADR-0022 single record replays as attempt 1/`initial`; ambiguous chains fail closed.

### Authorized routes

- `resume` and `retry` are new exact `AccessAction` values in `@aios/founder` and the
  orchestration authorization union. There is no owner/role/wildcard shortcut and no
  "resume implies retry".
- `POST /v1/workflows/:id/resume`, `POST /v1/tasks/:id/resume`, and
  `POST /v1/tasks/:id/retry` authorize before resource lookup, matching cancel. The kernel
  re-evaluates the same action on the authenticated actor.
- Workflow resume requires `resume` on the Workflow and on every interrupted Task it
  re-drives, plus `execute` for each Agent. Completed Tasks are skipped, interrupted Tasks get
  a new attempt, and remaining `created` Tasks execute. A `failed`, `cancelled`, or
  unverified-completed sibling blocks the resume with 409 until the Task is explicitly
  retried; a Workflow resume never silently retries a Task.
- Task-level resume/retry executes only that Task and leaves its Workflow lifecycle
  unchanged (normally `suspended`).

### Capacity, cancellation, and idempotency

- Resumed/retried work goes through the same `ManagedExecutionPort` and
  `execution.max_concurrent_tasks` gate; a full cap returns 429 before lifecycle or attempt
  writes and starts no sandbox.
- Cancellation still reaches the provider on a resumed attempt. The route commits the
  cancellation before aborting; the managed wrapper rechecks the new attempt's identity and
  state, so a late result cannot complete it.
- Repeating resume/retry after completion returns 200 with `resumed:false`/`retried:false`
  and creates no new attempt. Repeated work while active returns 409.
- Startup reconciliation is unchanged: it marks running attempts `interrupted` and suspends
  work, and never calls resume/retry. A second start remains a no-op.

## Completed — attempt-chain hardening (`a816fe3`)

The ADR-0022 slice handled one resume. This slice makes the chain safe across repeated
crashes and duplicate requests.

### Multi-generation chains

- Attempt numbers are not capped at two. `listForTask()` returns every generation; a chain
  can be `1 initial interrupted → 2 resume interrupted → 3 resume completed`.
- Every successor records its immediate predecessor, not attempt 1. Earlier terminal records
  are never rewritten when later generations append.
- Journal replay now refuses a successor whose predecessor is still `running`, refuses
  `resume` after anything but `interrupted`, and refuses `retry` after anything but `failed`,
  `cancelled`, or `completed`. Contiguity and predecessor identity were already checked.
- A test drives a three-generation chain through two real persisted restarts: generation 2 is
  created through the same durable ledger `resume` operation, interrupted by reconciliation,
  then generation 3 completes through `POST /v1/workflows/:id/resume`.

### Reconciliation and duplicate suppression

- Reconciliation only transitions `running` records. An already-interrupted latest attempt
  is left untouched; a second pass over the same journal appends no bytes.
- The kernel holds an in-process claim for the Workflow and every Task it will touch. Claims
  are checked and acquired atomically before the first lifecycle or attempt write and released
  in `finally`. A duplicate concurrent resume/retry that overlaps a claimed resource returns
  typed 409 `execution_conflict` without waiting and without a second sandbox start.
- The durable ledger independently refuses a `resume`/`retry` unless the latest attempt is
  terminal in the required state, so a direct concurrent call cannot fork the chain either.
- ADR-0022 now states the contract explicitly: non-blocking 409 while a redrive is in flight;
  200 idempotent no-op after completion.

### Failure and capacity across generations

- Cancelling generation 2 leaves generations 1 and 2 immutable; an explicit retry appends
  generation 3 and completes the Task. The Workflow stays suspended until explicitly resumed.
- The concurrency cap is tested on a generation-2 interrupted attempt: with the cap full, the
  later resume returns 429 before any lifecycle or attempt write; after release, generation 3
  completes.

## Completed — verifier-attributed evidence binding (`05769e1`)

Verification evidence now names the principal that produced it, and that identity is enforced
on both the acceptance and the read path.

- `TaskVerificationDecision` requires `verifier_id`. `verifyResult` rejects a decision whose
  identity is missing or differs from the host-configured verifier, before any evidence write
  or Task completion, using the existing `OrchestrationError`.
- `LocalCommandVerifier` returns its configured `verifier_id`; the kernel persists it with
  `verifier_accepted` in the durable evidence artifact.
- `getExecutionEvidence` re-reads the persisted record and fails closed unless it was accepted
  and its verifier identity equals the verifier this host currently trusts. HTTP maps the
  existing typed error to 409 `orchestration_rejected`; no route, error type, or mutation was
  added.

### Proof

- `http-host.test.ts` — `binds persisted verification evidence to the configured verifier
  across a reopen`: the configured verifier's evidence reads 200 with `verifier_id` and
  `verifier_accepted: true`; reopening the same persisted host with a different verifier
  rejects the record with 409 `orchestration_rejected`; reopening with the original verifier
  returns the unchanged artifact.
- `http-host.test.ts` — `rejects persisted evidence with no verifier identity and records no
  completion`: a durable artifact without `verifier_id` is rejected after reopen and its Task
  remains `created` with the same `audit_trail_ref`.
- `orchestration-kernel.test.ts` — `rejects a verification decision attributed to a different
  verifier` and `rejects a verification decision with no verifier identity`: both reject
  before evidence or completion, leaving the Task `suspended`.
- Existing verification, resume/retry, and attempt-inspection suites are unchanged and pass,
  including the 401/403/404 contracts and all-or-nothing Workflow inspection.
- Not cryptographic provenance. A compromised host process can still lie; signed decisions,
  key distribution/rotation, and remote attestation remain the open trust-model decision.

## Completed — all-or-nothing Workflow attempt inspection (`8cd427a`)

Workflow attempt inspection now fails closed as a single unit instead of authorizing and
reading each step in one pass.

- `getWorkflowAttempts` authorizes the Workflow before lookup, then authorizes every
  declared step Task, then resolves the steps, and only then reads history. A missing
  `read_status` on any step — first or later — returns the existing typed denial, not a
  partial payload, and the history port is never called.
- No new route, error type, or mutation. 401 on both attempt routes, 403 for denied grants,
  and 404 for a granted-but-unknown id are unchanged.
- Direct kernel callers get the same ordering: an unknown Workflow with no grant is a denial,
  not a not-found.

### Proof

- `orchestration-kernel.test.ts` — `denies Workflow attempt history before deriving any
  Task history when one step lacks read_status` covers both first-step and later-step
  denials, asserts zero history reads, and leaves every Task `created`.
- `http-host.test.ts` — `denies Workflow attempt inspection all-or-nothing when any step Task
  lacks read_status` drives both step orders over HTTP against a persisted ledger with real
  attempts on both Tasks: 403 `forbidden`, no tasks/attempts payload, byte-identical
  operational journal, unchanged attempt lists, and the same states after reopening the
  ledger.
- `http-host.test.ts` — `returns every step Task history when the whole Workflow is
  authorized` returns both per-Task chains in declared step order, with the three-generation
  chain unchanged.
- `http-host.test.ts` — the shared auth-contract test now covers 401 and 403 on both attempt
  routes as well as unknown-id 404.

## Completed — read-only attempt inspection (`0b01cec`)

Operators can audit the full chain without redriving it.

### Kernel projection

- `TaskExecutionStatePort` exposes `history(taskId)` alongside `latest()`. The host maps it
  directly to `ExecutionLedger.listForTask()`; there is no parallel attempt store.
- `getTaskAttempts(taskId, actor)` and `getWorkflowAttempts(workflowId, actor)` return every
  generation oldest-first with `execution_id`, `attempt`, `attempt_kind`, `state`,
  `previous_execution_id` when present, and an oldest-first
  `predecessor_execution_ids` chain ending at the immediate predecessor.
- The projection validates contiguity and every predecessor link, failing closed on a
  missing, mismatched, or cyclic chain. It never writes lifecycle state, appends an attempt,
  or invokes an executor/verifier.
- Workflow history requires `read_status` on the Workflow and on every step Task, in declared
  step order. Task history requires `read_status` on the Task. Authorization precedes lookup.

### HTTP surface

- `GET /v1/tasks/:id/attempts` returns `{ task_id, attempts }`.
- `GET /v1/workflows/:id/attempts` returns
  `{ workflow_id, tasks: [{ task_id, attempts }] }` in declared step order.
- Existing 401/403/404 contracts are reused; malformed UUIDs keep 400
  `invalid_identifier`.
- Like every authorized read, inspection records the authorization decision in the policy
  audit chain. That is separate from the operational journal, which is unchanged.

### Proof

- Both routes return a persisted three-generation chain with all generations, correct kinds,
  monotonic numbers, immediate links, and oldest-first predecessor chains.
- Single-attempt and failed-then-retried chains return correctly.
- The operational journal is byte-identical (SHA-256) before and after inspection, no attempt
  is appended, and every attempt state/revision survives reopening the persisted ledger.
- 401 for no token, 403 for missing `read_status`, and 404 for a granted-but-unknown Task or
  Workflow.

## Completed — human-only operator session administration (`27ab654`)

ADR-0030 turns the ADR-0029 lifecycle into an incident tool instead of a set of rules the
operator has to hand-call.

### Live administration path

- `administer_sessions` is a new exact `AccessAction`, human-only like
  `administer_policy`/`revoke_policy`, with no wildcard, ownership, or bootstrap implication.
  The durable decision audit and policy-registry allowlists accept it.
- `GET /v1/admin/sessions` filters to sessions the caller can administer, never returns
  `token_sha256`, and is bounded by the 32-session configuration limit.
- `POST /v1/admin/sessions/:sessionId/rotate|revoke` authorizes the exact target before
  lookup, then delegates to `DurableSessionStore.rotateById`/`revokeById`. Those plan against
  the same in-memory state the authenticator uses and append the same journal records, so the
  running host denies the retired token on its next request.
- Rotation returns exactly one new token and never broadens scope; revocation is terminal and
  idempotent (`already_revoked: true`); rotating a revoked or expired session is a 409
  conflict.
- A scoped token cannot use the admin surface because the route supplies no task/run binding,
  so it fails `scope_binding_required`. The independent verifier identity and authorization
  are untouched.

### CLI transport

- `aios-host list-sessions|rotate-session|revoke-session` reads the bearer token from an
  owner-only regular file (no symlink, mode `0600` or stricter, at most 4096 bytes), never
  argv. It opens no journal and takes no lock, so it works while the host is live.
- Exit codes: `0` success, `2` usage/local configuration, `3` denied, `4` not found, `5`
  retired/conflict, `6` transport/server. Failures are one bounded JSON object on stderr.
- `list-sessions` and `revoke-session` never emit token material; `rotate-session` emits the
  single new token.

### Proof

- `apps/host/tests/session-operator.test.ts` — 4 live HTTP tests: filtered digest-free list;
  rotate with old-token denial, new-token acceptance, and restart; revoke with live denial,
  restart, idempotent repeat, and 409 rotation; exit codes 3/4/2/5; non-human and scoped
  denials; no token in stdout/stderr/journal.
- `packages/founder/tests/authorization.test.ts` — exact human-only `administer_sessions`
  grant and rejection of a non-human subject.
- `tools/security/session-operator-drill.mjs` — 13 real steps against the compiled binary and
  a real host process, including a SIGTERM restart and a journal/audit token-leak scan.
- Validation ledger records: forced full gate 46/46, host 152 passed/17 skipped, founder 63,
  core 51, live bubblewrap 17/17, all drills exit 0, audit 0 triaged, secret scan 276 files.
- CI on the exact pushed head `15bc7f8`: `ci` (run `42933005083`), `conformance` (run
  `42933005064`), `schema-check` (run `42933005025`), `security` (run `42933005020`), and the
  dispatched `release` build (run `42933109086`) all succeeded. PR #1 stayed open, draft, and
  unmerged; `main` stayed at `767f30e`.
- CI guard at `550d0e5`: the Security workflow runs the operator drill as a required
  live-sandbox step. Probe run `42934134785` failed that step with exit 1; Security run
  `42934563018` passed it with all 13 drill lines in the step log. Local gate at `550d0e5`:
  forced 46/46, host 152 passed/17 skipped, founder 63, core 51, live 17/17, operator 13/13,
  every drill exit 0, audit 0, secret scan 281 files.

### Not claimed

- No step-up/MFA, approval quorum, rate limiting, or TLS was added. The operator token is a
  bearer credential; its owner-only file is the boundary.
- Rotation delivery is manual and one-time; restoring a revoked session requires configuration
  re-provisioning and a restart.
- The surface is single-host and single-process, like the rest of the journal.

### CI regression guard

- `.github/workflows/security.yml` runs `node tools/security/session-operator-drill.mjs` in
  the `sandbox-live` job after the resource-limit drill, using the same plain `run:` pattern
  and no new permissions, actions, or isolation changes. The job shell is `/usr/bin/bash -e`,
  so a non-zero drill exit fails the step and the job.
- Failure propagation was demonstrated in CI, not assumed: probe head `fb7090a` (Security run
  `42934134785`, job `130239870814`) failed step 11 with `intentional CI failure-propagation
  probe` and `Process completed with exit code 1.` The probe was removed in `550d0e5`.
- The real drill passed on `550d0e5` (Security run `42934563018`, job `130241299391`); the step
  log contains all 13 lines through `{"drill":"session-operator","ok":true,"steps":13}`.

## Verification actually executed at `7103957` and CI at `8c950e6`

Local at commit time; CI is observed after the push, not asserted from local results.

```sh
pnpm -r run build
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run test
pnpm --filter @aios/core run generate:schemas
git diff --exit-code schemas/generated
```

All six commands exited 0. Exact test results:

| Suite | Result |
|---|---|
| `@aios/host` | **99 passed** (9 files) |
| `@aios/core` | **46 passed** (4 files) |
| `tests/conformance` | **107 passed** (6 files) |
| `tests/integration` | **43 passed** (6 files) |
| `@aios/objects` | 32 passed |
| `@aios/founder` | 58 passed |
| `@aios/orchestration` | 30 passed |
| `@aios/tools` | 9 passed |
| `@aios/work-hierarchy` | 24 passed |
| `@aios/containers` | 21 passed |
| `@aios/learning` | 28 passed |
| `@aios/agents` | 6 passed |
| **Total** | **503 passed** |

Schema regeneration produced no diff.

GitHub Actions at merge head `8c950e6`: `ci`, `conformance`, and `schema-check` all
succeeded; PR #1 reported `mergeable: true`, `mergeable_state: clean`.

### What each new test pins

- `http-host.test.ts` — executing cancellation returns 202, aborts the sandbox stub, records a
  terminal cancelled execution and run, skips the verifier (exactly one sandbox call), moves
  active work to suspended, hashes the reason, and records the `cancel` allow in the shared
  audit chain.
- `http-host.test.ts` — queued cancellation returns 202 and a later dispatch is rejected with
  no sandbox call; intake-only policy denies cancel with 403 and no ledger record.
- `http-host.test.ts` — cap 1 rejects a second dispatch with 429 before lifecycle writes,
  leaves its Workflow/Task `created`, starts no second sandbox call, and retries successfully.
- `http-host.test.ts` — a journaled running run + execution followed by a fresh host start
  yields one `interrupted` execution and suspended work; a third start makes no change.
- `execution.test.ts` — cancelling the local executor SIGKILLs a real child process and
  rejects with `TaskCancelledError`, using the labelled `test-only-process` provider.
- `managed-execution.test.ts` — a late executor result cannot overwrite a cancelled terminal
  record; the cap rejects before creating a second execution.
- `config.test.ts` — rejects 0, 33, fractional, and string `max_concurrent_tasks` values.
- `http-host.test.ts` — crash-interrupted Workflow resume appends attempt 2 and leaves
  attempt 1 `interrupted`; a repeated resume is a 200 no-op with no third attempt.
- `http-host.test.ts` — a cancelled attempt rejects `resume` with 409 while an authorized
  `retry` appends attempt 2 and preserves the cancelled record; repeated retry is a 200 no-op.
- `http-host.test.ts` — a failed attempt blocks Workflow resume until the Task is explicitly
  retried; the later Workflow resume skips the completed Task and starts no sandbox.
- `http-host.test.ts` — `resume` (Workflow and Task), `retry`, and the retried Agent's
  `execute` each return 403 before lookup with no attempt or lifecycle write.
- `http-host.test.ts` — cap 1 rejects a later-generation (attempt 2) Workflow resume with
  429 before any attempt or lifecycle write, then succeeds after the competing execution
  releases capacity.
- `http-host.test.ts` — cancelling a resumed attempt aborts the sandbox and leaves attempts 1
  (`interrupted`) and 2 (`cancelled`) immutable; an explicit retry appends attempt 3 and
  completes the Task, and a later Workflow resume skips it.
- `http-host.test.ts` — a persisted three-generation chain survives two restarts with
  monotonic attempts, correct kinds, immediate-predecessor links, and unchanged earlier
  records, ending in a completed attempt 3.
- `http-host.test.ts` — concurrent duplicate Workflow resume, Task resume, and Task retry
  each return one 409 `execution_conflict`, one appended attempt, and one sandbox start;
  sequential repeats after completion are 200 no-ops.
- `persistence.test.ts` — attempt chains survive restart, terminal records stay immutable,
  `resume` only accepts `interrupted`, `retry` follows `failed`/`cancelled`, and a
  non-contiguous replay fails closed. A resumed attempt is interrupted once by reconciliation;
  a second pass creates no attempt and appends no journal bytes.
- `http-host.test.ts` — Task and Workflow attempt inspection returns a persisted
  three-generation chain in order with correct kinds, monotonic numbers, immediate links, and
  oldest-first predecessor chains; single-attempt and failed-then-retried histories also
  return correctly.
- `http-host.test.ts` — inspection leaves the operational journal byte-identical (SHA-256),
  appends no attempt, leaves every state/revision unchanged, and reopens to the same ledger.
- `http-host.test.ts` — both attempt routes reuse 401 for no session and 403 for a missing
  `read_status` grant, and 404 for a granted-but-unknown Task or Workflow.
- `orchestration-kernel.test.ts` — the kernel projection returns the full chain without
  executing or verifying and rejects an unknown Task after authorization.
- `orchestration-kernel.test.ts` — Workflow attempt inspection denies before any history
  read when a first or later step Task lacks `read_status`, covers unknown-id ordering under
  denial, and leaves every Task `created`.
- `http-host.test.ts` — Workflow attempt inspection denies all-or-nothing for first- and
  later-step missing grants, returns no payload, leaves the operational journal
  byte-identical, and reopens to unchanged attempt states for both Tasks.
- `http-host.test.ts` — a fully authorized multi-Task Workflow returns every step Task's
  history in declared order, including the unchanged three-generation chain.
- `http-host.test.ts` — configured-verifier evidence reads back across a reopen, a swapped
  verifier rejects it with 409 `orchestration_rejected`, and the original verifier restores
  the unchanged record.
- `http-host.test.ts` — a persisted artifact with no verifier identity is rejected and leaves
  its Task `created` with no completion.
- `orchestration-kernel.test.ts` — a decision from a different verifier or with no verifier
  identity is rejected before evidence write or Task completion.

### Security tests / evidence labels

- **Locally tested:** sandbox argv/no-shell, env filtering, hashed evidence, non-zero,
  timeout, unavailable provider, cwd escape, verifier independence, unexpected verifier
  exit, executor-result digest binding, host 503/422 behavior, composed HTTP dispatch,
  authorized/denied cancellation, resume/retry authorization and lifecycle, real child
  SIGKILL, cap rejection, and journal-level crash reconciliation.
- **Attempt-inspection evidence label:** inspection is read-only against the operational
  journal and execution ledger; the test asserts the operational journal is byte-identical.
  Authorization decisions still append to the separate policy audit chain under ADR-0013, so
  the test does not claim that no audit write occurs.
- **Resume/retry evidence label:** every resume/retry HTTP proof composes the real
  `LocalCommandExecutor`/`LocalCommandVerifier` around the labelled `stub-container` sandbox.
  It proves authorization-before-lookup, multi-generation attempt identity, no-write
  reconciliation, duplicate suppression, cap ordering, cancellation/abort handling, and
  verifier invocation. It is not container-isolation or real-provider evidence. A real-runtime
  proof would additionally cover per-generation container creation/teardown, killing the
  generation-2 container on cancel, workspace reuse across generations, image availability,
  and the same PID/memory/network limits on every generation.
- **Integration tested:** bubblewrap locally and in CI; Docker in CI on the GitHub-hosted
  runner. **Not tested here:** real Seatbelt execution. Docker's local daemon remains
  unreachable, so the Docker result is CI-only. The process test proves the shared child-process
  helper kills a direct child; it is not isolation evidence.
- **Not live-provider verified:** Obsidian++, Gmail, Notion, GitHub, or any model provider.
- **Not security tested:** independent penetration test, hostile-kernel escape, container
  escape, or verifier-key compromise. Bubblewrap now installs a generated seccomp deny-list
  with live denial drills (ADR-0027) and per-process RLIMIT enforcement (ADR-0028), but has no
  aggregate cgroup accounting, no active Landlock, and is labelled kernel-namespace/trusted-local
  only. Docker and gVisor are measured (ADR-0031/ADR-0032); Seatbelt remains unverified.
- **Not signed:** verifier decisions have no Ed25519/TUF provenance. The trust anchor is a
  host-configured distinct principal plus a separately executed command.

## Remaining engineering blockers, in priority order

1. **Remaining sandbox verification.** Run rootless Docker, Seatbelt, and Apple Containerization
   on capable hosts, including cancellation/container-kill behavior, mount permissions, network
   denial, PID/memory limits, and hostile command probes. Re-run the Docker and gVisor CI
   matrices when the runner, image, runtime, rootfs, or engine changes. For gVisor, rebuild from
   the fixed snapshot on a later date, sign the runtime pin and rootfs manifest, and retain
   snapshot provenance (F-017; F-018 is fixed).
2. **Verifier provenance.** Add key generation/distribution/rotation and kernel-side
   signature verification, or explicitly retain the current host-configured trust model.
3. **Execution re-drive quality.** Resume/retry are implemented and authorized per ADR-0022,
   with multi-generation and duplicate suppression, but there is still no automatic retry,
   backoff loop, scheduler, or capacity queue. Multi-generation resume/retry has not been
   exercised against real Docker/bubblewrap/Seatbelt providers.
4. **Mission model.** ADR-0017 is blocked on a sourced field model; do not invent a sixth
   entity or merge Mission into Organizational Containers.
5. **Secret broker.** Provider credentials must be brokered to authorized adapters only;
   never in prompts, logs, entities, or agent-visible state.
6. **Capability mediation (ADR-0012 Proposed).** Capability/provider contracts, discovery,
   health, selection, versioning, adapter lifecycle, audit. Requesters must not choose
   arbitrary providers.
7. **Founder Intelligence quality.** Per-note vault authorization (currently
   collection-level), retrieval/context assembly, contradiction detection, human-reviewed
   Memory writes. Never bulk-migrate vault notes.
8. **Gmail/Notion/Obsidian++.** OAuth/token lifecycle, secure storage, scopes, health,
   pagination, rate limits, retries, idempotency, integration tests.
9. **Founder experience.** No UI; the HTTP API is the only surface and it intentionally
   rejects every `Origin`.
10. **Operations.** Metrics/tracing/alerting, journal compaction and migrations, automated
    backup/restore drill, threat model, broader incident response (a session-compromise
    runbook now exists), deployment docs, SLOs.
11. **Policy administration assurance.** Runtime publication and retirement have no detached
    policy signature, key rotation, external audit custody, or production recovery/rotation
    procedure. Current authority is the authenticated session plus the exact grant; do not
    describe it as cryptographic policy provenance. Registry state is v2 and downgrade is
    unsupported.

## Architectural decisions made this session

- Fixed `local.exec` is the only execution capability; provider/image/verifier selection is
  host-owned (ADR-0019).
- A missing isolation provider is a supported 503 state, never a signal to use bare `spawn`.
- One command may complete at most one declared Action.
- Evidence is bounded and hashed; untrusted output is not copied into the journal.
- Cancellation is an exact authorized action, not an owner/role bypass (ADR-0021).
- Cancellation is terminal in the execution ledger; the canonical lifecycle has no
  `cancelled` state, and an active Task moves to `suspended`.
- Concurrency beyond the cap is rejected, not queued; default 1, maximum 32.
- Restart recovery marks interrupted work and suspends it; it never re-executes or completes.
- Resume and retry are distinct exact actions over append-only attempts; a cancelled attempt
  is never reopened, and a Workflow resume never silently retries a failed sibling (ADR-0022).
- A resumed/retried attempt re-enters the same concurrency cap, and startup still never
  re-drives work; a lease expiry remains an interrupted attempt requiring explicit authority.
- Attempt chains are not capped at two; every generation links to its immediate predecessor,
  repeated reconciliation is a no-op, and concurrent duplicate redrives return 409 without
  appending a second attempt or starting a second sandbox.
- Attempt history is a read-only projection of the execution ledger under exact `read_status`;
  it returns ordered generations with predecessor chains and never redrives.
- Verification decisions are attributed: the persisted evidence records the configured
  verifier and reads fail closed on a missing or swapped identity. This is principal
  attribution, not signing or cryptographic provenance.
- Mission and infrastructure remain proposed because the field-level models are unsourced.
- `@aios/*` packages remain private; no npm publication (ADR-0020).
- Operational state is the journal; Founder Intelligence remains in Obsidian (ADR-0014).
- Docker and gVisor are explicit providers over the same executor/ledger/verifier contract,
  with no fallback and no silent downgrade; Linux `auto` remains bubblewrap (ADR-0031/0032).
- Operator session administration is an exact human-only action over the live host; the CLI
  is a transport with owner-only token-file input and no journal access. Revocation is
  terminal and restart-durable, and the new token is delivered only to the invoking operator
  (ADR-0030).
- Permanent Memory stages require a recorded human approval bound to the record, transition,
  and content; the approval and promotion are committed as one durable journal record.
  This is organizational Learning Memory, not Founder Intelligence, and adds no vault write.
- Every authorization allow and deny is committed to `authorization-audit.jsonl` with the
  host request id, principal, action/resource, policy/version, decision, fixed reason, and
  decisive rule. An audit append failure denies, including an otherwise matching allow.
- Runtime policy administration is an exact `administer_policy` grant on every target, not
  a bootstrap or owner shortcut. It is human-only, atomically publishes policy plus
  attachments, and leaves the prior policy effective on any rejected artifact or audit
  failure (ADR-0023).

## Completed — permanent Memory approval binding (`503cefb`)

- `LearningService.promote()` to `published` or `institutional_standard` now requires an
  approval id. The approval is bound to the Memory Object id, source and target stages, and a
  SHA-256 over subject/content; missing, pending, rejected, expired, consumed, or mismatched
  approvals throw the typed `MemoryApprovalError` and write nothing.
- Only an authenticated `human:*` principal can decide an approval, and only through the
  injected default-deny boundary. The host reuses the protected decision collection's exact
  `intake` grant; no new authorization action or public HTTP route was added.
- `DurableLearningStore` keeps Memory Objects, knowledge records, approvals, and promotions
  in `learning.jsonl`. A promotion and its consumed approval are one journal record; reopen
  revalidates the binding and refuses mismatched or previously consumed approvals.
- Tests: `packages/learning/tests/memory-approval.test.ts` (13),
  `apps/host/tests/learning-store.test.ts` (3), and the host-boundary case in
  `apps/host/tests/http-host.test.ts` (39 HTTP total). Full workspace: **482 passed**.

## Completed — durable authorization decision audit (`15ff877`)

- `DurableAuthorizationAuditStore` appends every allow and deny to
  `authorization-audit.jsonl` through `AppendOnlyJournal`: fsync'd appends, SHA-256 hash
  chain, single-process lock, torn-tail recovery, and fail-closed corruption detection.
- Records capture request id, principal, action, resource, policy/version, decision, fixed
  reason, decisive rule index/effect, and timestamp. Unknown fields and non-fixed reasons are
  rejected, keeping tokens and raw error text out of the journal.
- HTTP operations propagate their request id through `SharedAuthorizationBoundary`, so every
  decision made during one request shares its correlation id, including Founder and
  Orchestration decisions. The audit read route is bootstrap-only and additionally requires
  the exact `read_evidence` grant on the protected decision collection.
- If the audit append fails, `AuthorizationService` returns deny even for an otherwise
  matching allow; no phantom decision is recorded. Tests:
  `apps/host/tests/authorization-audit-store.test.ts` (6),
  `packages/founder/tests/authorization.test.ts` (22 total), and the restart/grant cases in
  `apps/host/tests/http-host.test.ts` (41 HTTP total). Full workspace at that commit:
  **495 passed**.

## Completed — authorized runtime policy publication (`7103957`)

- `administer_policy` is a new exact `AccessAction`, and only human subjects may hold it.
  A policy rule that grants it to an Agent UUID is rejected at load and publication time.
- `POST /v1/policies` accepts `{ policy, attach_to }` under a verified bearer session. It
  requires an exact `administer_policy` allow on every target before any mutation; there is
  no wildcard, implicit admin, or bootstrap bypass. The test uses a non-bootstrap human to
  prove the route is not bootstrap-only.
- `FilePolicyRegistry.publishAndAttach()` validates the immutable policy, target list, rule
  scope, and monotonic version, then commits the new policy, all attachments, and lifecycle
  events as one fsync'd snapshot. Policy rules may reference only the published targets, and
  every target must be referenced.
- Invalid, stale, out-of-scope, or schema-invalid publications return typed 400/409 errors
  and leave the prior policy bytes and effective attachment unchanged. The offline
  `publish-policy` CLI still works and remains the bootstrap path.
- Every target authorization uses the durable decision journal. A failed audit append
  denies the request before `publishAndAttach`, so no mutation occurs. Every denial is
  recorded with the target, fixed reason, and decisive rule state.
- A replacement and its publish decision survive host close/reopen; the replacement decides
  later protected reads and the audit prefix reads back in order. Serialized policy and
  audit files contain no bearer token or `Bearer` text.
- Limits: no detached policy signature, key rotation, external audit custody, or policy
  rollback by reattaching an older version. Rollback is a new higher version with the restored
  rules. Runtime retirement is added under `4422229`. The registry remains single-process.

## Completed — authorized runtime policy retirement (`4422229`)

- `revoke_policy` is a new exact `AccessAction`, separate from `administer_policy` and never
  implied by it. Rules granting either action may name only human subjects; policy load and
  publication reject an Agent subject.
- `POST /v1/policies/:policyId/revoke` accepts exactly `{ "targets": [...] }`. `targets` must
  be the complete set of resources whose policy history references the version, including
  retained fallbacks, at most 256 distinct UUIDs. Every target is authorized for an exact
  `revoke_policy` grant before lookup; the principal must be human.
- `FilePolicyRegistry` state is schema v2 with `resource_policy_history` and
  `retired_policies`. `retirePolicy()` removes the version from every affected history,
  reattaches the newest remaining version, deletes the attachment when nothing remains,
  appends one `revoke` lifecycle event per resource, and marks the version retired in one
  fsync'd snapshot. A v1 file migrates to one history entry per attachment without inventing
  a fallback; a retired version cannot be reattached.
- Fallback is per resource: the newest remaining version in that resource's own history. With
  none left, the existing default deny `resource_policy_missing_or_invalid` applies.
- Typed rejections are `400 invalid_policy_id`/`invalid_targets`, `404 policy_not_found`, and
  `409 policy_not_attached`/`policy_already_revoked`/`target_scope_mismatch`. Every rejected
  attempt leaves policy bytes and effective attachments unchanged, and the authorization
  audit-failure case is proven separately.
- The offline `aios-host revoke-policy --config ... --revocation ...` path applies the same
  operation to a stopped host from an owner-only `{ policy_id, targets }` document.
- Tests: `packages/founder/tests/authorization.test.ts` adds the exact human-grant case,
  `packages/founder/tests/file-policy-registry.test.ts` adds fallback/deny and
  unchanged-state cases, `apps/host/tests/policy-admin.test.ts` adds the offline path, and
  `apps/host/tests/http-host.test.ts` adds four retirement tests (51 HTTP total). Full
  workspace: **513 passed**.

## Completed — durable host session lifecycle (`b067501`)

F-013 was the remaining Low finding: bearer digests had optional expiry and no rotation or
revocation endpoint. Sessions now require `expires_at` with a 30-day ceiling. The operational
journal persists active generations, task/run/evidence scopes, and terminal retired-token
digests before acknowledgement; replay and compaction reconstruct the same state. `POST
/v1/session/rotate` issues a one-time 32-byte random token and retires the predecessor;
`POST /v1/session/revoke` is terminal. The real HTTP path denies expired, unknown, malformed,
rotated-away, revoked, and cross-scope credentials with stable reasons (`expired_token`,
`rotated_token`, `revoked_token`, `task_scope_mismatch`, `run_scope_mismatch`,
`evidence_scope_mismatch`). A token bound to one task/run cannot authorize another; evidence
scope is checked against the recomputed artifact digest. Work already authorized before a
rotation completes normally. Snapshot restore refuses to reintroduce a session removed from
configuration.

Evidence at `b067501`: focused host/typecheck green; six durable lifecycle tests plus nine
identity and 57 HTTP tests; full gate **46/46 tasks**, host **148 passed/17 skipped**, core
**51**; live bwrap **17/17**; resource-limit, quota, seccomp, and collection drills exit 0;
audit **0 triaged**; secret scan **273 tracked files, no findings**. Six lifecycle tests cover
controlled-clock expiry, rotation replay, revocation replay, cross-task/run/evidence replay,
restart, compaction, and snapshot resurrection refusal; the HTTP suite includes restart
recovery and an in-flight run across rotation. Residual: pre-provisioned tokens only, no
login/MFA/rate limiting, one-time rotation delivery, and unencrypted loopback HTTP. See
ADR-0029, F-013, and the validation ledger.

## Completed — bubblewrap per-run resource limits (`f012df3`)

F-003 was selected as the highest-severity actionable open finding: F-005 requires unavailable
macOS/Apple silicon, F-009 requires external key custody, and F-013 is Low. The production
bubblewrap path now installs inherited `RLIMIT_AS` 1.25 GiB, deadline-aligned `RLIMIT_CPU`, and
`RLIMIT_NPROC` 128 with the trusted host `/usr/bin/prlimit` inside the existing namespace. A
fixed wrapper requires the exact `/proc/self/limits` values and `Seccomp: 2` before exec.
Missing proof raises `SandboxResourceLimitUnavailableError`, journals
`sandbox_resource_limit_unavailable`, and is rejected by the verifier; success evidence records
the limits. The seccomp filter, namespace boundary, disk quota, and verifier binding were not
weakened.

Evidence: full workspace gate **46/46 tasks**, host **131 passed/17 skipped**, live bwrap
**17/17** (12 boundary/limit, 3 seccomp, 2 quota). `tools/security/resource-limit-drill.mjs`
recorded a legitimate Perl run at exit 0 with `resource_limits_applied:true`, and a Perl memory
bomb at exit 1 with `Out of memory!`, `timed_out:false`, while the filter still reported
`Seccomp: 2`. Residual: per-process, not cgroup aggregate; up to 128 descendants can each
reserve 1.25 GiB; RLIMIT_AS is not RSS. Node/libuv probes `io_uring_setup` and is killed by the
F-007 filter at startup, so the drill uses Perl. Docker and gVisor are now measured
(ADR-0031/ADR-0032); Seatbelt/Apple Containerization remain unverified. See ADR-0028, F-003,
and the validation ledger.

## Completed — Zod advisory closure and blocked-finding mitigations (`24d2791`)

F-014 (High, `zod` GHSA-mrhx-c7xc-m3w5) was the highest-severity genuinely actionable open
finding: F-005 needs unavailable macOS/Apple hardware and F-009 needs external key custody.
The production packages now use `zod` 4.6.7. The schema generator was moved from the
Zod-4-incompatible `zod-to-json-schema` to native `z.toJSONSchema` (draft-07, input view,
inline reuse, fail-closed cycles), while restoring recursive `additionalProperties:false`.
The generated diff is 122 additions/0 deletions and retains every prior constraint. The
temporary audit exception is removed; `audit-policy` reports 0 triaged high/critical.

For F-009, every new policy lifecycle event records a canonical SHA-256 of the exact policy;
startup recomputes it and rejects substituted policy content even when the audit hash chain
still verifies. This is tamper evidence, not a signature. The blocker is the absence of
KMS/HSM/Sigstore key custody and signing material; unblock requires an external signing key
with rotation/audit custody and detached-signature verification drills. For F-005, the host
now has an executable regression proving the deprecated Seatbelt provider is unavailable off
macOS and never falls back to bare process execution; real macOS/Apple Containerization
validation remains blocked on hardware.

Evidence: full gate **46/46 tasks**; host **132 passed/17 skipped**; core **47**, founder
**62**; live bwrap **17/17**; resource-limit, quota, and seccomp drills all exit 0; secret scan
**272 tracked files, no findings**. At this checkpoint Docker, gVisor, Seatbelt, and Apple
Containerization remained unverified; Docker and gVisor are now measured (ADR-0031/ADR-0032),
while Seatbelt/Apple remain unavailable. See F-005/F-009/F-014, the validation ledger, and the
ADR-0009 amendment.

## Completed — bounded canonical collections (`8ca3e9c`)

The Zod 4.6.7 upgrade was necessary but not sufficient for F-014: 4.6.6+ only rejects an
oversized array before parsing elements when the array declares an upper bound, and 20
canonical arrays were unbounded. Every canonical array now has `.max(...)` on the array
itself: 256 entries for ordinary collections and 1,024 for lifecycle/history trails. The
generated output gained 53 `maxItems` keywords with no deletions. A runtime test rejects 257
relationships; a recursive contract test requires finite `maxItems` on every generated array;
`tools/security/collection-bound-drill.mjs` parses 1,000,000 invalid actions under a 64 MiB
heap and reports one issue in 12 ms.

Evidence at `43e2dd6`: core **51/51**, full gate **46/46 tasks**, host **132 passed/17 skipped**,
live bwrap **17/17**, resource-limit/quota/seccomp/collection drills all exit 0, audit **0
triaged**, secret scan **273 tracked files, no findings**. F-015 is closed: `TaskEnvironment`
rejects more than 64 entries before inspecting values; the generated contract carries
`maxProperties: 64`, and the extended drill rejects 100,000 keys under a 64 MiB heap with one
issue in about 100 ms. The host allowlist and 256 KiB default request-body cap remain defense
in depth.

Next action: the adversarial drill is recorded below; F-013 remains fixed at `b067501`. Continue with the concrete work below; do not claim
signed policy provenance, macOS isolation, Docker/gVisor execution, or aggregate cgroup
enforcement until their recorded blockers are cleared. Re-run the full gate and live suite on
the pushed documentation checkpoint before relying on its CI.

## Completed — adversarial sandbox and verifier drill (`29eb496`)

`tools/security/adversarial-drill.mjs` attempts 21 attacks against the production bubblewrap
provider, `LocalCommandExecutor`, `ManagedExecutionPort`, durable `ExecutionLedger`, and
`LocalCommandVerifier`. It uses no test double for the boundary or verification path.

### Covered attacks

- Filesystem: host `/etc/shadow` read, `../../` and `/proc/1/root` traversal, symlink chains,
  hardlink to a host file, cwd traversal/absolute cwd, and writes to `/etc`, `/usr`, `/root`.
- Secrets: a planted host environment variable is absent from `env` and
  `/proc/self/environ`; a host `/tmp` secret is unreachable through `..`, `/proc/1/root`, or
  the sandbox `/tmp`.
- Network: a real TCP connect to a host loopback listener fails with zero accepted
  connections; raw socket creation fails.
- Capabilities: `CapEff` is zero; the mount syscall is killed with SIGSYS (159); real
  `chroot` returns `Operation not permitted` (125).
- Resources: CPU burner terminated at the 3 s deadline under `RLIMIT_CPU=3`/`RLIMIT_NPROC=128`;
  fork loop creates at most 126 children with 128 namespaced processes and zero survivors;
  a 64 KiB workspace cap stops a writer and discards the workspace with zero survivors.
- Processes: cancellation and timeout each leave zero marked child processes.
- Instruction boundary: hostile Task name/description and an env value are stored/passed
  literally; the exact argv digest is recorded and hostile text is absent from evidence.
- Verification: forged executor result rejected by the durable digest; verifier identity equal
  to an executor rejected; artifact tampering makes the independent verifier exit 1; stale
  attempt-1 evidence rejected after attempt 2 while attempt 2 is accepted.

### Measured evidence

- Local at `29eb496`: **21/21** cases denied/contained; forced gate **46/46**; host **152
  passed/17 skipped**; live bubblewrap **17/17**; every existing drill exit 0; audit **0
  triaged**; secret scan **281 files, no findings**.
- Probe `c5a4a44`: Security run `42936839536`, job `130248895128`, step 11 failed with
  `##[error]Process completed with exit code 1.`; step 12 was skipped.
- Real drill `29eb496`: Security run `42937205409`, job `130250095076`, step 11 passed with 21
  attack records and `all adversarial cases denied or contained`; step 12 passed. The step is
  a plain `run:` in the existing live-sandbox job; no permission, action, or isolation change.

### Not claimed

- Docker and gVisor are measured (ADR-0031/ADR-0032); Seatbelt and Apple Containerization
  remain unverified/unavailable. Rootless Docker was not measured.
- The CPU case was stopped at the deadline, not by a distinct `RLIMIT_CPU` signal; the memory
  bomb remains covered by `resource-limit-drill.mjs`; disk enforcement is the 25 ms sampler,
  not a hard quota. The artifact case relies on the Task's independent verification command;
  there is no host artifact-ingestion API. Instruction smuggling is contained at the host
  boundary, while F-012's model-level prompt-injection risk remains accepted.
- F-016 records the coverage gap and its closure; no new code vulnerability was found.

## Next concrete work

1. Exercise runtime policy publication and retirement in a production-like deployment with a
   real non-bootstrap operator, independent audit consumer, and restart/recovery drill; push
   only `upstream community/open-source-foundation`.
2. Test Docker and bubblewrap cancellation on machines where they are available, including
   the explicit container-kill path.
3. Add verifier key provenance and a secret broker before claiming production execution
   security.
4. Exercise multi-generation resume/retry against real sandbox providers, including repeated
   crashes, cancelling generation 2, and workspace reuse across generations.
5. Source and review ADR-0017's Mission fields before adding any Mission API/schema.

## Completed — explicit Docker provider measured (`dbee5c7` → `40438a5`)

The Docker row is no longer "unverified". The production provider is selected with
`provider: docker` plus a locally present `image`; Linux `auto` still selects bubblewrap and
there is no fallback. `apps/host/src/execution/sandbox.ts` uses `docker create` → daemon
inspect → `docker start --attach` → `docker kill`/`rm --force`, not `docker run`. It requires
read-only root, `network=none`, `CapDrop=ALL`, no-new-privileges, a non-default custom seccomp
profile, cgroup memory/swap/CPU/PID limits, the deadline CPU rlimit, a workspace-only bind,
host UID/GID, and sanitized environment before start. Docker does not expose the client-side
seccomp path/digest in `HostConfig.SecurityOpt`; the generated profile digest is recorded
separately and the daemon's active-profile report is trusted. An attempted exact-path check
at `7daf4fd` failed closed and was reverted.

Measured at code head `40438a5`: Security run `42943242036`, live job `130269803337`, step 13
passed with all **21/21** Docker cases denied or contained, kernel `7.0.0-1017-azure`,
custom-seccomp SHA-256
`87ae93a78692f192bb8272a9398bafe21c864dce3cf8d79f2f96a0313a7a1214`, final result
`all adversarial cases denied or contained`. The CI image build (step 12) also passed. The
same head's `ci` (`42943242089`), `conformance` (`42943242041`), `schema-check`
(`42943242116`), and supply-chain (`130269803066`) checks were green. Earlier heads
`dbee5c7` and `75f7371` failed closed on Docker CLI-invalid `--ulimit as` and bare `rw`
mount syntax; both were repaired before the measured run.

Local evidence at `40438a5`: forced gate **46/46** (0 cached), host **154 passed/17 skipped**,
live bubblewrap **17/17**, bubblewrap adversarial **21/21**, all six other drills exit 0,
secret scan **283 files/no findings**, audit **0 untriaged high/critical**. Docker remains
unreachable locally (`permission denied ... /var/run/docker.sock`), so the Docker result is
CI-only. Rootless Docker was not measured. Docker has no `RLIMIT_AS`; its 512 MiB cgroup is the
aggregate memory boundary. The image is unsigned, `/etc/shadow` is removed from the drill
image, and disk enforcement remains the 25 ms sampler. See ADR-0031 and F-006.

Next action: keep the final documentation checkpoint on
`community/open-source-foundation`, re-run the exact-head workflows, dispatch `release`, and
verify PR #1 is open/draft/unmerged and `main` is still `767f30e`. Do not claim rootless
Docker, signed image provenance, or VM-class isolation.

## Signed provenance artifacts — 2026-11-11

`apps/host/src/execution/artifact-signing.ts` implements canonical-JSON Ed25519 statements
and fail-closed verification. `GvisorSandbox` verifies the pin and a signed rootfs manifest
before materialization; its evidence records key ids and signature/manifest digests.
`tools/security/sign-artifacts.mjs` generates keys, signs and verifies; the Security workflow
exercises it with a run-scoped key and the adversarial drill signs what it executes. The
checked-in trust root has no keys: provisioning a production key and committing its public
half is the next required operator action. CI identity and transparency logging are not
implemented.

## Signed-artifact v2 hardening — 2026-11-11

`artifact-signing.ts` now parses statements and trust roots with `parseStrictJson` (duplicate
and prototype keys, depth, size, trailing content and non-finite numbers rejected), requires
canonical 64-byte base64 signatures and exact fields, and rejects schema v1. Adversarial tests
live in `tests/artifact-signing-adversarial.test.ts`; the execution-binding invariant is in
`tests/gvisor.test.ts`. Re-sign any future v1 artifact. Still open: production trust root/key,
Sigstore identity, SLSA provenance, macOS/rootless Docker measurements.

## Executor/verifier evidence — 2026-11-11

`evidence.ts` provides canonical bounded snapshots, attempt-bound digests and strict evidence
parsing. `ManagedExecutionPort` records binding version, nonce and bound digest;
`LocalCommandVerifier` refuses acceptance without them and rejects prior-attempt nonces.
Reserved `AIOS_*` task environment names are filtered in `command-executor.ts`. Tests are in
`tests/evidence-binding.test.ts`. Legacy attempts fail closed; re-run before verifying.
Still open: cross-process attestation/audit custody, production trust root, Sigstore/SLSA,
macOS and rootless-Docker measurements.

## Portable evidence bundles — 2026-11-11

`evidence-bundle.ts` exports a strict, versioned, signed snapshot of the journal, Task/Artifact
projections and execution attempts. `tools/security/evidence-bundle.mjs verify` runs in a
separate process with only the bundle and an external trust root; it does not open the store
or network. Edited, deleted, reordered, spliced, replayed, truncated, forged, unknown-version,
absent/revoked/expired-key and post-hoc-mutated cases fail closed with distinct codes.
Completed Tasks require accepted verifier Artifacts and a completed latest execution. Replay
detection requires `--expect-head` from an external checkpoint. Docs: `docs/security/
evidence-bundle.md`. Still open: external audit custody/trusted timestamp, production key
custody, Sigstore identity, SLSA/in-toto conformance, macOS/rootless-Docker measurement.
