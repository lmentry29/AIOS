# Generated schemas — do not hand-edit

This directory is populated by `pnpm generate:schemas`, run against `@aios/core`'s Zod
definitions (`packages/core/src/schema/*.ts`) once they exist. Until then it is empty.

See `docs/process/repository-design-specification.md` §1.10 and ADR-0009 for why this
directory is generated rather than hand-maintained: it replaces the old hand-written
JSON Schema + TypeScript pair (`docs/archive/object-schemas-superseded.md`), which could
silently drift against each other. `schema-check.yml` fails CI if this directory's
committed content doesn't match what regeneration produces.

Writing the Zod definitions that generate this directory is implementation work — out of
scope for repository initialization. See `docs/engineering/implementation-playbook.md`.
