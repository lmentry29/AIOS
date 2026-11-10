# Security Documentation

This directory is living security reference. It is **not** a certification, a penetration
test, or a production-readiness claim. Every claim here names its evidence, and anything
that was not exercised on a host is labelled `unverified`.

- [`threat-model.md`](threat-model.md) — assets, trust boundaries, attacker capabilities, non-goals.
- [`sandbox-matrix.md`](sandbox-matrix.md) — isolation providers compared from primary sources, with the evidence status of each adapter.
- [`findings-ledger.md`](findings-ledger.md) — open, fixed, and accepted security findings.
- [`validation-ledger.md`](validation-ledger.md) — exact commands, host facts, and observed results for every validation run.

Rules for this directory:

1. A finding is closed only with a test, a command transcript, or a documented compensating
   control. "Looks correct" is not evidence.
2. A provider that was not executed on its platform is `unverified`, never `passed`.
3. Do not weaken a boundary to make a test pass. If a platform is unavailable, implement the
   adapter and mark it unverified.
4. Changes to authorization or architecture semantics still require an ADR
   (`docs/adr/`); these documents describe implementation and evidence, not policy.
