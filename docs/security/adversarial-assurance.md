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
| Unauthorized delegation / excessive agency | unmeasured | AIOS has no connector/tool execution loop or agent-to-agent delegation path in this runtime. Residual risk becomes active when such a surface is added; it must reuse exact authorization and verifier separation. |
| Connector/tool poisoning | unmeasured | No connector or tool adapter executes in this runtime. Connector output must never be treated as authorization. |
| Memory/context poisoning affecting a privileged decision | unmeasured | Founder memory has human-approved writes and no privileged decision path; the agent/LLM memory loop does not exist here. |
| Prompt injection reaching a privileged or destructive path | unmeasured | Executor output is untrusted and cannot self-attest; there is no LLM/tool loop that can invoke privileged host actions. `adversarial-drill.mjs` covers malformed agent output reaching verification, not a live LLM. |

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
- Connector, tool, memory/context-poisoning and prompt-injection classes are unmeasured because
  the corresponding privileged runtime does not exist; adding one requires a new adversarial
  review before it can be trusted.
- Archive handling relies on Docker/OCI export and re-measurement rather than parsing arbitrary
  tar streams in the host.
