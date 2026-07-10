# AIOS

AIOS is a specification and reference implementation for a persistent, AI-agent-driven
engineering organization — autonomous Agents executing Missions/Objectives/Tasks on behalf
of a human founder, coordinated across a ten-layer architecture, with institutional memory
that survives model and tool changes.

This repository is the canonical implementation. It is currently **pre-implementation**:
architecture and engineering-readiness planning are complete and certified; no package
contains runtime logic yet.

## Start here

- **New to this repository (human or AI agent)?** Read [`AGENTS.md`](AGENTS.md) first.
- **Implementing a package?** [`docs/engineering/implementation-playbook.md`](docs/engineering/implementation-playbook.md)
  is the primary entry point — strategy, build order, milestones, AI task allocation, and
  Definition of Done per phase, all in one place.
- **Why does the architecture look the way it does?** [`docs/adr/index.md`](docs/adr/index.md)
  — nine Architecture Decision Records, each resolving a specific documented conflict.

## Repository layout

```
docs/
├── adr/            Architecture Decision Records — change only via a new/amending ADR
├── architecture/   Certified corpus (Specification, Conformance Standard, Appendices) — rarely edited
├── engineering/     Living reference — Canonical Object Model, schemas, runtime interfaces,
│                    state machines, API contracts, developer reference, implementation
│                    roadmap, implementation playbook
├── process/         Decision + status record — changelog, certification report, AI dev plan
└── archive/         Superseded/historical material, kept for provenance

packages/           Nine @aios/* packages — see docs/engineering/implementation-playbook.md
schemas/generated/  Generated JSON Schema — never hand-edited
tests/              Cross-package integration and conformance tests
```

## Status

- Architecture Version 1: **Certified** (`docs/process/v1-final-certification-report.md`).
- Engineering readiness: **Ready with minor, named risks** (`docs/archive/engineering-readiness-report.md`).
- Implementation: **not started.** The recommended first step is the vertical slice defined
  in `docs/engineering/implementation-playbook.md`, not a full build of all nine packages.

## Toolchain

TypeScript/Node.js (ADR-0008) · pnpm workspaces + Turborepo · Biome · Vitest · Zod
(schema source, JSON Schema generated from it — ADR-0009). See
`docs/process/repository-design-specification.md` for full reasoning.
