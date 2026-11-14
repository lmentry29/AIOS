# Final Repository Audit — 2026-11-14

Status: **repository-maintenance closure complete; not production-ready.** This is an
internal audit of the default branch and its dependency/tooling state. It is not an
independent third-party certification, a penetration test, or a production-readiness claim.

**Audited closed-state commit:** `d0b3fb9ab19b1d932b1c167a5a19b408e1bd85fc`, the merge of
PR #11 on 2026-11-14T21:10:36Z.

**Hosted evidence for that commit:** `CI` run
[`43641406777`](https://github.com/lmentry29/AIOS/actions/runs/43641406777) and `Security`
run [`43641406757`](https://github.com/lmentry29/AIOS/actions/runs/43641406757). Both jobs
in the Security workflow passed: `Live sandbox boundary` and `Dependency and secret scan`.

This file is the post-merge audit record. The documentation-only addendum that carries it
does not change the audited code state; its own merge is not part of the audit scope. The
`d0b3fb9` runs above are the authoritative hosted evidence.

## Closure decisions

The repository owner chose the following scope for this closure:

- Finish repository hygiene and the final audit; leave owner-gated product capabilities
  explicitly blocked rather than relabeling them complete.
- Do not create a release, tag, npm publication, or signed distribution artifact. ADR-0020
  keeps every `@aios/*` package private.
- Accept the existing external-resource blockers and record them accurately: live
  Gmail/Notion/Obsidian access, production HSM/KMS and external WORM audit custody, macOS 26
  Apple silicon, and Sigstore identity.
- Prune only remote branches proven to be ancestors of `main`; leave unmerged and local
  branches untouched.
- Retain the early-stage / not-production-ready status in `README.md`.

## Dependency and tooling state

The maintenance queue landed through PR #10 and was closed by PR #11:

- PR #3 was closed as obsolete. Its removal of
  `docs/architecture/local-authorization-storage.md` conflicted with the delivered
  authorization integration.
- PRs #5, #6 and #7 updated `actions/upload-artifact`, `pnpm/action-setup` and
  `actions/setup-node`.
- PR #9 upgraded TypeScript 7, Vitest 5, Biome 2, Changesets 3 and Turbo 2.11. The repair
  commits added the required Node typings, migrated the Biome configuration to schema 2,
  and replaced the retired Vitest workspace file with the Vitest 5 project configuration in
  `vitest.config.ts`.
- PR #10 added pnpm 11 workspace overrides for patched `postcss`, `nanoid` and
  `source-map-js` releases. Before the overrides, the full audit reported five dev
  advisories (four high, one moderate); after them it reports zero at every severity.
- PR #11 added the full-tree dependency audit to the Security workflow and merged the
  closure record at `d0b3fb9`.

The full audit covers **160 dependencies** (1 production, 159 development; 88 optional
packages are included in that total) and reports **0 info, 0 low, 0 moderate, 0 high and 0
critical** advisories. The production `audit-policy` gate reports **0 untriaged high or
critical** advisories. The Security workflow also runs
`pnpm audit --audit-level=high` over the full tree, because the production-only policy gate
intentionally excludes dev/build dependencies.

## Local verification on merged `main`

Host: Linux cloud worktree, Node v26.13.0, pnpm 11.11.0. These commands were run locally on
the merged `main` commit `d0b3fb9ab19b1d932b1c167a5a19b408e1bd85fc`. The repository targets
Node `>=22.13`; hosted CI and Security use `.nvmrc` (Node 22.23.4).

| Check | Command | Observed result |
|---|---|---|
| Frozen install | `pnpm install --frozen-lockfile` | exit 0 |
| Forced workspace gate | `pnpm turbo lint typecheck test build --force` | **46/46 tasks**, 0 cached, exit 0 |
| Tests in the gate | same | **777 passed, 17 skipped**; the skips are live-provider host suites |
| Formatter | `pnpm format:check` | **209 files checked, 0 findings** |
| Integration | `pnpm exec vitest run --project integration` | **43/43** |
| Conformance | `pnpm exec vitest run --project conformance` | **107/107** |
| Schema generation | `pnpm --filter @aios/core run generate:schemas` | **12 files / 46 schemas** |
| Generated-schema drift | `git diff --exit-code schemas/generated` | no diff |
| Secret scan | `node tools/security/scan-secrets.mjs` | **358 tracked files, 0 findings** |
| Full audit gate | `pnpm audit --audit-level=high` | no known vulnerabilities |
| Production audit policy | `node tools/security/audit-policy.mjs` | 0 untriaged high/critical |
| Whitespace | `git diff --check` | exit 0 |

The local host suite accounts for **318 passed / 17 skipped** within the gate. The 17 skips
are the live bubblewrap, Docker and gVisor suites that require the hosted Linux runner; the
hosted Security job executes them and is the authoritative evidence for that platform.
Local macOS Seatbelt and Apple Containerization evidence remains unavailable and is recorded
as a blocker.

## Hosted verification on merged `main`

On `d0b3fb9ab19b1d932b1c167a5a19b408e1bd85fc`:

- `CI` run [`43641406777`](https://github.com/lmentry29/AIOS/actions/runs/43641406777)
  succeeded.
- `Security` run [`43641406757`](https://github.com/lmentry29/AIOS/actions/runs/43641406757)
  succeeded. Both the `Live sandbox boundary` and `Dependency and secret scan` jobs are
  recorded as successful. The live job exercises bubblewrap, Docker, gVisor, provenance and
  session-operator steps; the dependency job includes the full-tree audit.
- `Conformance` and `Schema Check` are path-filtered to package/schema changes. They did not
  run for the docs/tooling closure. Their equivalent projects ran locally: conformance
  **107/107**, schema generation **12 files / 46 schemas** with no drift. No hosted result
  is claimed for those two workflows.
- During closure, the live drill's chroot lookup was made provider-relative after the current
  runner stopped exposing `/usr/sbin/chroot`; `coreutils` is installed explicitly. That
  changed only the test harness, not authorization or sandbox-provider behavior, and the
  merged-main live job passed.

No release, tag, npm publication, signed installer or deployment was created.
The repository has only the historical checkpoint tags; there is no GitHub release.

## Residuals

The following remain open and are not marked `done` by this closure:

- **CL-006 / CL-021:** external audit custody, trusted timestamps and an independent
  restart/restore drill against production-like state.
- **CL-007:** production HSM/KMS key custody, recovery ceremony and compromise response.
- **CL-008:** Sigstore/Fulcio/Rekor identity and SLSA/in-toto conformance. Local detached
  Ed25519 provenance is implemented; no OIDC or external identity claim is made.
- **CL-009:** live Gmail, Notion and Obsidian credentials and integration tests.
- **CL-010 / CL-018:** macOS 26 Apple silicon Seatbelt/Apple Containerization and rootless
  Docker measurement.
- **CL-013 / CL-019:** UI origin/CSRF/cookie design and login, MFA, loopback TLS and rate
  limiting.
- **CL-020:** aggregate cgroup v2 accounting and Landlock for bubblewrap.
- **CL-015:** signed distribution artifact. The release workflow builds an unsigned review
  archive only; no operator artifact key exists in the repository.

The broader product limitations remain: no UI, no general agent/tool execution runtime, no
live external connectors, no production secret/custody service, no remote attestation, and
no release. The repository is usable as an experimental reference implementation, not as a
production control plane.

## Evidence

- [Completion ledger](../process/completion-ledger.md) — statuses and owner-gated residuals.
- [Validation ledger](validation-ledger.md) — exact commands and observed results.
- [Project state](../process/project-state.md) — current branch, capability maturity and
  remaining work.
- [Security documentation](README.md) — threat model, findings and validation rules.
