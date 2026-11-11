# Executor/verifier evidence binding

## Trust boundary

The executor's `TaskExecutionResult` and verification evidence are attacker-controlled. The
verifier must never accept because the executor reported success, and it must not trust a
result merely because its JSON looks familiar. Acceptance requires all of the following:

1. The verifier is bound to the host's durable `ExecutionLedger`; without it the command may
   run for diagnostics but acceptance is denied.
2. The latest attempt for the Task is `completed`, belongs to the Task, and was executed by a
   principal listed in the verification request.
3. The attempt evidence is parsed strictly (`key:value`, no duplicate keys, no newlines,
   bounded length) and contains `execution_binding:attempt-v2`.
4. The executor result is a bounded plain-data snapshot: no accessors, class instances,
   symbol keys, prototype keys, cycles, BigInt, non-finite numbers, unknown fields or
   oversized values.
5. A canonical SHA-256 digest over the result **and** the durable identity
   (`execution_id`, `task_id`, `agent_id`, `attempt`) equals `bound_result_sha256`.
6. The result's per-invocation `execution_nonce` equals the nonce recorded for the current
   attempt and does not appear in any earlier attempt of the Task. This distinguishes a
   replayed result object even when two runs produce byte-identical content.
7. The verifier then runs its own command in a fresh sandbox invocation; only that command's
   actual exit status can authorize acceptance.

## Defects found and fixed

- **Acceptance without a ledger.** The ledger was optional, so a verifier constructed without
  it skipped binding and could accept on the command alone. Acceptance now requires the
  durable attempt; an unbound verifier runs for diagnostics and always denies.
- **Non-canonical result digest.** `JSON.stringify` made key order significant and invoked
  `toJSON`/getters on attacker-controlled objects. Evidence now uses a recursive canonical
  serializer with plain-object, accessor and bounds checks.
- **Attempt-independent digest.** A retry with identical content produced the same digest,
  so a previous result validated against the new attempt. The digest now includes the durable
  attempt identity, and the nonce history rejects exact replay.
- **Permissive evidence parsing.** `find(entry.startsWith(...))` accepted duplicate keys and
  newline-injected lines. Durable attempt evidence is parsed into a strict map with duplicate
  and format rejection. Opaque executor result evidence is bounded, hashed as data and never
  parsed as lines; only its `execution_nonce` entry is extracted strictly.
- **Reserved environment injection.** A Task could declare `AIOS_VERIFIER_ID`,
  `AIOS_TRUST_ROOT`, `AIOS_SIGNING_*`, `AIOS_GVISOR_*` or `AIOS_ARTIFACT_*` variables.
  `AIOS_VERIFIER_ID`, trust-root, signing, gVisor and artifact configuration names are now
  filtered from Task environments; only host code sets them.

## Coverage

`apps/host/tests/evidence-binding.test.ts` (9 tests) covers accessors, class instances,
prototype keys, cycles, BigInt/NaN/oversized values, unknown fields, multi-line opaque
result evidence, forged nonce entries, duplicate evidence keys, identity/field sensitivity,
replay across attempts, cross-Task
replay, legacy evidence, post-hoc removal and duplication of the bound digest, unbound
verifiers, and reserved-environment filtering. Replay and cross-Task cases assert the
verification command is not run when binding fails.

Measured locally: full uncached gate 46/46 tasks, 0 cached; host 218 passed / 17 skipped;
integration 43; conformance 107. No existing test or check was weakened.

## Remaining open

- The ledger and verification decision are host-process state; there is no cross-process
  attestation or external audit custody for them. The operational journal is hash-chained
  (ADR-0015) but not independently witnessed.
- Production gVisor trust-root/key provisioning is blocked on an operator-held secret.
- Sigstore/Fulcio/Rekor identity and SLSA provenance are not implemented or claimed.
- macOS and rootless-Docker measurements remain separate, unmeasured platforms.
