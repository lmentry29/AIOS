# Adversarial assurance matrix

Status: 2026-11-11. Each class is either covered by a deterministic, non-skipped test or
explicitly unmeasured. Tests marked covered run in the full gate; live-only tests run in the
Security workflow with real binaries.

| Class | State | Evidence |
| --- | --- | --- |
| Malformed, duplicate-key and adversarially shaped JSON | covered | `artifact-signing-adversarial.test.ts`, `evidence-bundle.test.ts`, `build-provenance.test.ts`; strict parser + 300 seeded parser mutations in `adversarial-properties.test.ts`; 200 byte mutations per signed verifier |
| Canonical hashing and digest substitution | covered | `artifact-signing-adversarial.test.ts`, `adversarial-properties.test.ts`, `evidence-bundle.test.ts`, `build-provenance.test.ts` |
| Hostile archives / path traversal / reserved names during rootfs export | covered for materialization surfaces | `gvisor-provenance.test.ts` (staging, promotion, symlinks, metadata), Docker rootfs build pin checks and adversarial drill; arbitrary tar extraction is not a host surface (Docker/OCI export is re-measured before use) |
| Symlink / hardlink substitution between verification and execution | covered | `gvisor-provenance.test.ts`, `gvisor.test.ts`, `sandbox-live.test.ts`; 30 seeded symlink-accounting cases in `adversarial-properties.test.ts` |
| Partial extraction, interruption, replacement and atomic promotion | covered | `gvisor-provenance.test.ts`; 24 fault-injected staging/promotion cases in `adversarial-properties.test.ts`; journal torn-tail recovery in `journal-recovery.test.ts` |
| Replay against a stale checkpoint | covered | `evidence-binding.test.ts`, `evidence-bundle.test.ts`, `build-provenance.test.ts` (`REPLAY`) |
| Forged verification evidence | covered | `evidence-binding.test.ts`, `verifier-binding.test.ts`, `managed-execution.test.ts`; verifier cannot accept without a durable bound attempt |
| Credential / identity leakage across executor and verifier | covered | reserved `AIOS_*` environment filtering in `command-executor.ts`; executor/verifier binding tests; env-injection tests in `evidence-binding.test.ts` |
| Privilege escalation across sandbox/executor boundary | measured on Linux only | `sandbox-live.test.ts`, `seccomp-live.test.ts`, `workspace-quota-live.test.ts`, `adversarial-drill.mjs` (bubblewrap, rootful Docker, gVisor) |
| Unauthorized delegation / excessive agency | covered at the existing boundary; no delegation surface | `orchestration-kernel.test.ts` requires exact `execute`/`coordinate` grants before execution; `agent-runner.ts` is lifecycle-only and `tool-service.ts` has no `invoke`; `tool-service.test.ts` asserts the absence of an invocation method. No sub-agent spawn exists. |
| Connector/tool poisoning | covered for read-only connector evidence; tool execution absent | `local-connectors.test.ts` denies before fetch on authorization failure, rejects malformed/oversized results and now proves provider-supplied `source_id` cannot choose provenance (prompt-like text remains data). `tool-service.test.ts` proves installed Plugin metadata cannot execute. |
| Memory/context poisoning affecting a privileged decision | covered for writes; no privileged decision consumer | `memory-approval.test.ts` covers missing, unknown, expired, replayed and altered-content approvals; `local-runtime.ts` does not feed LearningService memory into authorization or lifecycle decisions. |
| Prompt injection reaching a privileged or destructive path | covered at host boundary; model-level path absent | `adversarial-drill.mjs` case 17 proves hostile Task metadata is data with an exact argv digest and does not reach evidence; there is no LLM/tool loop in the runtime. Model-level prompt injection is unmeasured. |

See [privileged-surface-inventory.md](privileged-surface-inventory.md) for the searches and modules
behind the connector, tool, delegation, memory and prompt conclusions.

## Running the suites

```
TURBO_CACHE_DIR=/tmp/aios-turbo pnpm turbo build lint typecheck test --force
AIOS_BWRAP_DIR="$(dirname "$(command -v bwrap)")" node tools/security/adversarial-drill.mjs
```

Fuzz/property suites are deterministic and seeded; they run in the host test task, not a
separate optional target. Seeded mutation counts: 250 signed statements and 150 trust roots
(existing), 200 evidence bundles, 200 build attestations, 300 strict-JSON documents, 100
canonical-hash permutations, 30 symlink workspaces and 24 promotion fault cases.

## Demonstrated discriminating power

Temporarily removing the evidence-bundle and build-attestation signature checks made the
targeted forged-signature tests fail (1 failed, 15/8 skipped respectively); restoring the
checks made the full gate pass with 247 host tests. This confirms those assertions exercise
the controls rather than passing vacuously.

## Residual risk

- macOS and rootless Docker are not measured. Linux results are not extrapolated.
- Connector and tool metadata surfaces exist but are read-only/non-executing; the connector
  evidence path and the absence of plugin invocation are directly tested. A future execution
  adapter or model consumer must repeat the adversarial review.
- Memory writes are approval-gated but memory content is not a privileged decision input today;
  model-level prompt injection and memory poisoning remain unmeasured until such a consumer exists.
- Linux live results are not extrapolated to macOS or rootless Docker.
- Archive handling relies on Docker/OCI export and re-measurement rather than parsing arbitrary
  tar streams in the host.
