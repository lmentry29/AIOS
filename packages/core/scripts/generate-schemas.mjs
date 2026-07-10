#!/usr/bin/env node
// Generates schemas/generated/*.json from @aios/core's Zod definitions
// (docs/process/repository-design-specification.md §1.10 — Zod is the single
// source of truth; JSON Schema is derived, never hand-edited).
//
// PLACEHOLDER — added 2026-07-10 as part of closing a CI forward-reference
// found during senior architecture review: `schema-check.yml` already called
// this script and depended on zod-to-json-schema before either existed.
// This stub exists so the workflow has something real to run and exits
// cleanly rather than failing with "command not found." Real generation
// logic is day-1 work for whoever implements packages/core/src/schema/
// (the first step of the vertical slice per docs/engineering/implementation-playbook.md).
//
// Expected real implementation: glob `src/schema/*.ts`, import each Zod
// schema, run it through `zodToJsonSchema` (from zod-to-json-schema, already
// declared as a devDependency), and write the result to
// `../../schemas/generated/<name>.json`.

import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(__dirname, "..", "src", "schema");

if (!existsSync(schemaDir) || readdirSync(schemaDir).length === 0) {
  console.log(
    "generate:schemas — no Zod schema files found in src/schema/ yet. " +
      "Nothing to generate. This is expected pre-implementation; see the " +
      "comment at the top of this file for what real logic belongs here.",
  );
  process.exit(0);
}

console.error(
  "generate:schemas — src/schema/ has files but this script is still the " +
    "placeholder from repository initialization. Implement real generation " +
    "logic (see comment at top of this file) before relying on schema-check.yml.",
);
process.exit(1);
