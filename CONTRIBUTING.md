# Contributing to AIOS

Thank you for considering a contribution. AIOS is an early-stage reference implementation of an AI-agent-driven engineering organization. The code and interfaces are evolving; review the current implementation and open issues before building against an assumed contract.

## Before you start

1. Read [README.md](README.md) for the current scope and maturity.
2. Read [AGENTS.md](AGENTS.md) for repository invariants and agent-specific instructions.
3. Read the [implementation playbook](docs/engineering/implementation-playbook.md) and the relevant architecture decision records.
4. Search existing issues and pull requests. For substantial work, open an issue first so the intended behavior and architectural impact can be discussed.

## Development

The repository currently targets Node.js >=22.13 and pnpm 11.11.0. Install the pinned package manager with Corepack if needed, then:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

These commands describe the intended workspace checks. If a command fails on the current default branch, report the exact command, runtime versions, and complete relevant error. Do not claim a check passed unless you ran it.

## Change expectations

- Keep changes focused and explain the user problem they solve.
- Add or update tests for behavior changes.
- Update user-facing documentation when setup, behavior, or limitations change.
- Preserve append-only lifecycle history and relationship records.
- Do not invent authorization semantics: the access-policy model is explicitly deferred.
- Do not edit generated schemas by hand.
- Architecture and ADR changes require an explicit decision record; do not silently contradict them.
- Use Conventional Commits. AI-authored commits should include the attribution trailer required by AGENTS.md.
- Never include secrets, credentials, customer data, or private production traces.

## Pull requests

A useful PR includes:
- The problem and who experiences it.
- The proposed behavior and alternatives considered.
- Tests actually run, with results.
- Documentation updates and known limitations.
- Any schema, compatibility, migration, or security implications.

Small, reviewable PRs are preferred. Maintainers may request changes or decline work that expands scope without evidence.
