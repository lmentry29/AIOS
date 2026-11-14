# ADR-0039 — Bounded Agent Execution Plans over Fixed `local.exec`

## Status

**Accepted** (2026-11-14). This ADR amends ADR-0019's execution contract by allowing a
Task to declare a bounded sequence of fixed `local.exec` steps. It does not amend
ADR-0012, authorize model planning, provider selection, plugin discovery or general tool
mediation. It preserves ADR-0013 authorization, ADR-0015 persistence, ADR-0021/0022
execution lifecycle, ADR-0026 workspace quota, and ADR-0033 verifier binding.

## Context

ADR-0019 established one fixed `local_command` per Task, executed through a fail-closed
isolation provider, with an independently executed verification command. ADR-0021 added a
durable per-Task attempt ledger, cancellation and recovery; ADR-0022 added authorized
resume/retry. The host can therefore execute real commands, but the local adapter rejects a
Task with more than one declared Action because one command cannot independently support
several Action records.

That restriction left multi-step work with no honest representation short of creating
several Tasks and coordinating them externally. The repository has no accepted Agent
planning runtime and no model/provider contract. Adding one now would require capability
mediation, a model boundary, credential handling and a new sandbox/secret design that
ADR-0012 deliberately left open.

A narrower gap can be closed without changing the trust model: a requester can state a
bounded, fixed plan in the Task, and the configured Agent principal can execute that plan
through the existing `local.exec` provider. This is plan execution, not autonomous model
planning. The plan is data under the same exact-grant and sandbox rules as a single command.

## Decision

### 1. `local_plan` is the same fixed grant, repeated within a bound

A Task execution intent may be either the existing `local_command` or a `local_plan`.
`local_plan` contains one to eight ordered steps. Each step is the same fixed command shape:
an argument vector, workspace-relative `cwd`, bounded timeout, bounded output and allowlisted
environment. A plan-level `timeout_ms` bounds the whole plan; per-step timeouts may only
shorten a step. The executor still receives no shell string, provider choice, image, model,
plugin or verifier choice.

Every step runs through the host's existing isolation provider and its existing availability,
filter, resource-limit and boundary proofs. No second sandbox or execution ledger is added.

### 2. Actions and plan steps are a one-to-one contract

When a Task declares Actions, the plan must contain exactly one uniquely named step for each
Action, and no orphan steps. The referent is `action_id`; a step cannot silently stand in for
another Action.

The Task schema enforces this at intake. The executor re-validates it before starting because
persisted or caller-constructed objects may bypass the parser. The executor additionally
requires every Action to be `pending` and to name this Agent as its `executed_by` principal.
A plan over a Task with no Actions may not name Actions. An Agent therefore cannot replay a
terminal Action, complete work assigned to another Agent, or claim unnamed work.

### 3. One attempt, one workspace, sequential steps, one total deadline

A plan is one durable execution attempt and one execution nonce. Its steps run sequentially in
the same per-Task workspace, so later steps can inspect earlier artifacts and the independent
verifier can inspect the final workspace. Steps are not fanned out concurrently.

The plan deadline is enforced before each step and passed to the provider as the actual
per-step timeout. If fewer than 100 ms remain before another step could start, the plan fails
rather than launching an already-expired command. Cancellation aborts the active provider
invocation through the existing `AbortController`; later steps are never started.

### 4. Partial work is never completed work

Any step failure (non-zero exit, timeout, spawn failure, cancellation, quota stop, missing
filter/resource-limit/boundary proof or denied syscall) aborts the plan. The durable attempt is
failed or cancelled by the existing `ManagedExecutionPort`; the executor returns no
`completed_actions`. The independent verifier then sees no completed attempt and rejects.

The executor reports all declared Actions as `completed` only after every step succeeded. It
does not report a subset, does not write Action state directly, and does not mark the Task
complete. The Orchestration Kernel remains the only component that applies the Action set and
lifecycle transition, and only after the verifier accepts.

### 5. Evidence remains bounded and independent verification is unchanged

The executor adds a plan evidence version, step count, plan deadline, an Action-ID set digest
and one bounded line per step. Each step line records the provider, assurance, argv hash, cwd
hash, stdout/stderr hashes, exit code, duration, truncation flag and the provider's filter,
resource-limit and boundary claims. Raw stdout/stderr is never copied into evidence.

The verifier remains a distinct principal and still runs its own command in a fresh sandbox
invocation over the same workspace. It binds acceptance to the durable attempt, executor
principal and result digest under ADR-0021/0033. This ADR does not let the verifier trust plan
evidence as proof of work; the verification command's actual result remains the authority.

### 6. Lifecycle, persistence and recovery reuse the existing path

The plan is one attempt in the existing append-only execution ledger. Resume/retry append a
new attempt; a cancelled plan is never reopened. Startup reconciliation marks an interrupted
plan `interrupted` and suspends affected work exactly as for a single command. No new
automatic success path, duplicate suppression or recovery mechanism is introduced.

### 7. Scope boundary

This ADR authorizes a requester-authored, fixed plan. It does **not** authorize an Agent to
invent tools or commands, call a model, select a provider, discover a plugin, coordinate
multiple Agents, or claim that a lifecycle transition proves work. `@aios/agents`
`AgentRunner` remains a lifecycle/conformance harness; the production execution adapter is the
host's `LocalCommandExecutor` behind the existing `AgentExecutionPort`.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Let an LLM generate and run commands | No accepted model/capability contract; would bypass ADR-0012's unresolved mediation design and expand the trust boundary. |
| Run one shell string containing several commands | Loses argv-only execution and per-step evidence; a shell expands the attack surface. |
| Create several Tasks and coordinate them | Requires a coordination runtime the repository does not have and splits one verification boundary into several. |
| Run plan steps concurrently | Makes workspace state and evidence ordering non-deterministic and increases resource pressure. |
| Treat a successful first step as partial completion | The Task and verifier contract has no partial-success state; reporting it would manufacture completion. |
| Add a second execution ledger for plans | Duplicates ADR-0021 state and breaks cancellation/recovery invariants. |

## Consequences

- A single Task can now express and verify up to eight sequential local operations without
  weakening the existing sandbox or verifier boundary.
- Plan evidence is larger than single-command evidence but remains bounded: at most eight step
  lines, with output represented only by hashes. The host's result snapshot already caps
  evidence at 64 entries.
- The plan has no transactional rollback. A failed plan may leave partial files in the
  workspace, but it cannot claim completed Actions or Task completion; retry/recovery and the
  verifier treat that work as unverified.
- The total deadline bounds wall-clock execution, not aggregate CPU or memory across steps.
  Each step still receives the provider's per-run limits; cross-step aggregate accounting
  remains follow-up work.
- Requesters still choose the fixed steps. Autonomous planning, general tools, additional
  sandbox providers and model credentials remain out of scope and require separate ADRs.
- The Agent package's lifecycle harness is unchanged; no claim is made that `AgentRunner` is a
  production executor.

## Tests / evidence

- `packages/core/tests/schema.test.ts` accepts an Action-bound plan only with exactly one
  uniquely named step per Action, rejects orphan or missing step bindings, and bounds plans to
  eight steps.
- `packages/core/tests/json-schema-contract.test.ts` verifies both generated execution branches
  are strict and bounded, including the plan's `steps` array and step environment.
- `apps/host/tests/execution.test.ts` proves sequential execution in one workspace, per-step
  evidence, Action completion, rejection of mismatched/wrong-principal/terminal Actions,
  first-step failure without partial completion, total-deadline enforcement, and a real
  two-step file-producing plan accepted by the independently executed verifier.
- `apps/host/tests/http-host.test.ts` dispatches a two-Action plan through the authenticated
  host, durable attempt ledger and verifier, and reads back accepted evidence containing the
  plan-step records and completed Actions.
- `apps/host/tests/sandbox-live.test.ts` runs a two-step plan through the real bubblewrap
  provider (when `AIOS_BWRAP_DIR` is available), checks the per-step filter proof, and has the
  independent verifier read the resulting workspace files. It skips rather than passing when
  no real boundary is available.
- Existing managed-execution, verifier-binding, HTTP cancellation/resume/retry and journal
  recovery tests continue to cover the lifecycle this ADR reuses.
