# AIOS — Live Project State

Last verified: 2026-11-09 via GitHub repository, pull-request, commit, tree, and Actions APIs. This snapshot describes the public repository and the active implementation branch; it does not claim local-machine verification.

## Repository and active change

- Repository: https://github.com/lmentry29/AIOS
- Visibility: public; default branch: `main`
- Active implementation branch: `community/open-source-foundation`
- Active pull request: [#1 — Prepare AIOS for responsible community adoption](https://github.com/lmentry29/AIOS/pull/1)
- PR status: open, draft, not merged. Do not merge while implementation and audit work remain.
- Latest implementation head at snapshot: `c0afc36dfbce74c2231ef503fa8b39b47c169336`
- The PR adds an MIT license and contributor/community files on its branch. The default branch's GitHub repository metadata still reports no recognized license until that change is merged.
- No external adoption is claimed. Repository metadata at the last live read showed 1 star, 0 forks, 0 network forks, and 0 subscribers. Those are point-in-time counts, not measures of downstream impact.

## Current package maturity

Nine planned workspace packages have source implementations, at different maturity levels:

| Package | Current state |
|---|---|
| `@aios/core` | Established schemas and canonical types |
| `@aios/objects` | Established in-memory object store with lifecycle, relationship, immutability, and mutation guards |
| `@aios/work-hierarchy` | Task and Objective stores |
| `@aios/containers` | Project store only; eight container concepts remain unpromoted by ADR-0011 |
| `@aios/agents` | Agent lifecycle/conformance runner; not a real tool-executing agent runtime |
| `@aios/tools` | Plugin lifecycle management; adapter invocation remains deferred |
| `@aios/learning` | Knowledge records and evolution stages |
| `@aios/founder` | Early runtime: authorization-gated canonical/memory reads, human-only decision capture and review queue, collection-scoped decision artifacts, default-deny authorization, human-only policy administration |
| `@aios/orchestration` | Early runtime: authorized intake, ordered dispatch, multi-agent coordination, distinct host-configured verifier identity with explicit evidence-read permission, evidence artifacts, status/evidence reads |

Founder and Orchestration are not production-complete. Their interfaces are adapter-driven; in-memory implementations are for tests/development only.

## Authorization and architecture decisions

- ADR-0013 — **Accepted (2026-11-08)**: resource-attached, exact-match, default-deny authorization; deny overrides allow; no wildcard or owner-implied grants; identity must come from a trusted host; policy lifecycle and decision auditing must be durable and append-only.
- ADR-0014 — **Accepted (2026-08-17)**: Obsidian vault is the persistence substrate for Founder Intelligence; AIOS schemas validate managed records; no separate database for Founder Intelligence; AIOS reads and proposes by default; permanent Memory requires explicit human review and authorization.
- ADR-0012 — **Proposed (2026-07-14)**: extends capability mediation to end-users and supersedes the plugin-ID-centric invocation shape. It remains unaccepted; the new capability-mediated runtime contract and Capability Registry schema are follow-on engineering work.
- Organizational Containers — ADR-0011 promotes Project only. Eight other container types remain references because the certified source corpus does not define their fields. Do not invent schemas to make a checklist appear complete.
- Plugin/Adapter execution — explicitly deferred until a real adapter integration exists.
- Lifecycle conformance — the prior known Task-substate mismatch was addressed in the latest implementation branch by keeping Agent execution substates on Agent records and removing the Agent-only Task substate dependency.

## Validation evidence

At commit `c0afc36dfbce74c2231ef503fa8b39b47c169336`, GitHub Actions reported:
- CI: passed (`pnpm turbo lint typecheck test build`)
- Conformance: passed
- Schema Check: passed

The verified suite includes a cross-package Founder → authorization → orchestration integration test using the real in-memory policy registry and authorization service, plus regression tests for human-only policy administration, immutable policy snapshots, policy identity matching, Founder collection isolation, and distinct authorized verifier identity. Conformance reports 107 passing tests across six files. Entity-specific lifecycle rules are covered: Agent substates are restricted to active; Task, Workflow, and Plugin substates are rejected where no vocabulary is ratified. No known conformance test remains deliberately failing.

These are GitHub Actions results; no local-machine execution or production deployment is claimed.

## Production blockers — not optional

1. **Founder Intelligence persistence:** The accepted source of truth is the Obsidian vault, not a separate database. A read-only vault evidence adapter/VaultObjectStore is not yet implemented in AIOS. The completed read-only reconciliation found no notes explicitly managed as Founder canonical objects; none were hydrated or migrated, and proposed classifications remain pending human review. Do not bulk-migrate, reclassify, or write to the vault. The local Obsidian API must pass its separate authentication, loopback, path-containment, and dependency audit before AIOS connects. **Operational task/run state** (TaskStore, Workflow state, execution evidence, policy registry, authorization audit) remains in-memory; its durable storage contract is unresolved and must not be conflated with Founder Intelligence persistence.
2. **Identity:** No authenticated identity/session subsystem exists. Actor IDs passed into the kernel are identifiers, not proof of identity. A production host must derive them from validated sessions/tokens and enforce authorization at every entry point.
3. **Policy lifecycle:** ADR-0013 defines the semantics, but durable policy publication, attachment, replacement, revocation, trusted bootstrap, and atomic audit persistence have no production adapter.
4. **Execution:** Orchestration has ports, not production model/tool adapters, sandbox isolation, secret brokering, execution quotas, or safe tool allowlists. The verifier now has a distinct host-configured identity and must be authorized to read evidence; a distinct identifier alone does not prove independent provider/process isolation.
5. **Verification:** The verifier is injected. There is no production-grade independent verifier or evidence provenance chain; an executor must never be able to self-attest.
6. **Reliability:** No durable run journal, idempotency keys, leases, retry policy, compensation, crash recovery, or distributed concurrency control.
7. **Capability mediation:** ADR-0012 is Proposed; the registry, capability model, provider selection, health/cost policy, and capability execution contract are not implemented.
8. **Platform boundary:** AIOS-as-personal-OS versus applications-on-AIOS, multi-tenancy, per-user isolation, and deployment architecture remain unratified.
9. **Security operations:** No completed threat model, penetration test, SLOs, operational monitoring/alerting, incident response runbook, or disaster-recovery validation.
10. **Operational proof:** The repository has test coverage and a deterministic test harness, but no verified continuously running deployment or real external provider integration.

## Next work order

1. Keep the PR draft and work on the implementation branch; do not claim production readiness.
2. Verify the new founder→authorization→orchestration integration test and lockfile changes through CI.
3. Resolve the founder decisions called out in ADR-0012 and the open container-model conflict without inventing source material.
4. Implement the read-only Obsidian vault evidence adapter first. Preserve source provenance, validate only explicitly AIOS-managed records, and surface classifications as reviewable proposals. Do not add a separate Founder Intelligence database or write to the vault.
5. Add a trusted host identity boundary and a durable policy/audit adapter for operational execution state, with transactional append-only behavior.
6. Add a real sandboxed execution adapter and an independently operated verifier.
7. Add run journaling, idempotency, recovery, observability, security review, and deployment/restore validation.
8. Re-run a clean independent audit against the certified architecture and the actual deployed runtime.

## Source-of-truth rules

- This file is a status snapshot, not architectural authority.
- `docs/architecture/` and accepted ADRs govern normative behavior.
- `docs/process/divergence-log.md` records unresolved differences and deferred decisions.
- Update this file only from fresh repository and CI evidence. Never copy an old status snapshot forward without re-verification.
