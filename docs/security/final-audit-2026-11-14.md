# Final Repository Audit — 2026-11-14

Status: **repository-maintenance closure complete; not production-ready.** This is an
internal audit of the default branch and its dependency/tooling state. It is not an
independent third-party certification, a penetration test, or a production-readiness claim.

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

The dependency-maintenance work landed before this record on `main` at
`941ce01b457f26cff3f8b58a89d860b434c9ce9e`:

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

The full audit covers **160 dependencies** (1 production, 159 development, 88 optional) and
reports **0 info, 0 low, 0 moderate, 0 high and 0 critical** advisories. The production
`audit-policy` gate reports **0 untriaged high or critical** advisories. The Security
workflow now also runs `pnpm audit --audit-level=high` over the full tree, because the
production-only policy gate intentionally excludes dev/build dependencies.

## Local verification

Host: Linux cloud worktree, Node v26.13.0, pnpm 11.11.0. The repository targets Node
`>=22.13`; hosted CI and Security use `.nvmrc` (Node 22.23.4).

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

The local host suite reports **318 passed / 17 skipped** because bubblewrap, Docker and
gVisor live tests require the hosted Linux runner. The hosted Security `Live sandbox
boundary` job executes those live suites and the bubblewrap, Docker and gVisor adversarial
drills; it is the authoritative evidence for that platform. Local macOS Seatbelt and Apple
Containerization evidence remains unavailable and is recorded as a blocker.

## Hosted verification

The closure pull request's path filters ran `CI` and `Security`; `Conformance` and
`Schema Check` are filtered to package/schema changes, so they were run locally
(**107/107** and **12 files / 46 schemas**, respectively). Security includes the
dependency/secret scan plus the full live sandbox job described above. Final closure head
`37c3f494ea8dd7ef5b89b1d7fc447a6c6251c8c2` passed `CI` in run
[`43640791568`](https://github.com/lmentry29/AIOS/actions/runs/43640791568) and `Security` in
run [`43640791561`](https://github.com/lmentry29/AIOS/actions/runs/43640791561); the live
job completed in 2m13s. The post-merge `main` runs are reported in the closing summary and
are visible in the repository's Actions history.

The first two Security attempts on this closure found a real portability defect in the
live drill, not in the sandbox: the current `ubuntu-latest` image no longer exposed
`/usr/sbin/chroot`, and passing the host path into Docker then failed because the container
exposes it at a different location. The drill now resolves `/usr/sbin/chroot` or
`/usr/bin/chroot` inside the provider and fails closed if neither exists; `coreutils` is
installed explicitly. Runs [`43640440411`](https://github.com/lmentry29/AIOS/actions/runs/43640440411)
and [`43640626465`](https://github.com/lmentry29/AIOS/actions/runs/43640626465) failed before
that fix, and the final run above passed. This did not change any authorization or sandbox
provider behavior.

One earlier main Security run on `b87eb43` failed because the hosted Docker daemon was
unreachable during the live drill. The same workflow passed on the final dependency
maintenance head `941ce01`; no code or policy change was made to bypass the drill.

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
