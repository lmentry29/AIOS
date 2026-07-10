# ADR-0008 — Canonical Implementation Language

## Status
**Accepted** (2026-07-10)

## Context
Architecture Version 1 (ADR-0001 through ADR-0007) specifies AIOS's structure — layers, execution loops, lifecycle, work hierarchy, and the Canonical Object Model — without committing to an implementation language or runtime. Repository initialization requires that commitment before any package scaffolding, tooling selection, or schema-generation pipeline can be built.

## Decision
**TypeScript, running on Node.js, is the canonical implementation language for AIOS.**

This does not preclude future SDKs or language bindings in other languages — a Python or Go client against AIOS's eventual API surface remains an option — but the runtime, the nine `packages/*` implementations, and the canonical schema source (`packages/core/src/schema/*.ts`, per ADR-0009 §1.10) are TypeScript-first, not multi-language from v1.

## Rationale
- The Canonical Object Model's serialization decision (`docs/engineering/canonical-object-model.md` §10) already commits to JSON as the wire format specifically because it requires no additional tooling for either Claude-based or Ollama-based implementation agents — TypeScript is the natural implementation counterpart to that choice, since `z.infer<>` (Zod) gives a single schema definition that is simultaneously the runtime type, the validator, and the JSON Schema generator (ADR-0009 §1.10), with no cross-language translation step.
- A single canonical language matters specifically because multiple AI models (Claude and local Ollama models, per `docs/process/ai-development-plan.md`) write code across these nine packages — a single language and a strict dependency-resolution tool (pnpm, ADR-0009) catches accidental cross-package coupling that a looser, multi-language setup would not.
- TypeScript/Node.js has mature tooling across every layer this project needs immediately: schema validation (Zod), monorepo orchestration (Turborepo), testing (Vitest), linting (Biome) — reducing the number of independent technology decisions this repository initialization has to make correctly on day one.

## Consequences
- All nine packages (`@aios/core` through `@aios/founder`) are implemented in TypeScript.
- `packages/core/src/schema/*.ts` is the canonical, hand-edited schema source; `schemas/generated/*.json` is generated from it and never hand-edited (ADR-0009 §1.10).
- Future language bindings, if pursued, are additive SDKs against a stable API surface, not a rewrite of core packages — this ADR does not need to be revisited to add them, only amended if AIOS's canonical runtime itself needs to change language.

## Superseded Decisions
None. This ADR resolves a previously-unstated implementation-language question; it does not overturn a prior decision.
