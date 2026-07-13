#!/usr/bin/env node
// Generates schemas/generated/*.json from @aios/core's Zod definitions
// (docs/process/repository-design-specification.md §1.10, ADR-0009 — Zod is the
// single source of truth; JSON Schema is derived, never hand-edited).
//
// One output file per source module: src/schema/task.ts -> schemas/generated/task.json,
// containing every Zod schema that module exports, keyed by export name under
// `definitions`.
//
// DETERMINISM IS LOAD-BEARING. schema-check.yml regenerates and then runs
// `git diff --exit-code schemas/generated` — any run-to-run instability (unsorted
// keys, an unstable file set, a missing trailing newline) surfaces as a spurious CI
// failure on an unrelated PR. Hence: sorted module list, sorted export names, sorted
// object keys, stale files pruned, trailing newline.
//
// Reads from dist/, not src/ — this is plain Node with no TS loader, so the package
// must be built first. The `generate:schemas` npm script chains the build, because
// schema-check.yml invokes that script directly and runs no build step of its own.

import { readdirSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const srcSchemaDir = join(pkgRoot, "src", "schema");
const distSchemaDir = join(pkgRoot, "dist", "schema");
const outDir = join(pkgRoot, "..", "..", "schemas", "generated");

// index.ts is a re-export barrel — every export it has is a duplicate of one of the
// modules below, so emitting it would write every schema twice.
const BARREL = "index";

const isZodSchema = (v) =>
  v !== null && typeof v === "object" && "_def" in v && typeof v.safeParse === "function";

// Recursively sort object keys so output byte-order is stable across runs.
const sortDeep = (value) => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
};

const modules = readdirSync(srcSchemaDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => basename(f, ".ts"))
  .filter((m) => m !== BARREL)
  .sort();

if (modules.length === 0) {
  console.error(`generate:schemas — no Zod schema modules found in ${srcSchemaDir}`);
  process.exit(1);
}

if (!existsSync(distSchemaDir)) {
  console.error(
    `generate:schemas — ${distSchemaDir} does not exist. This script reads compiled output, so the package must be built first. Run \`pnpm --filter @aios/core run build\`, or use the \`generate:schemas\` npm script, which chains the build for you.`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// Prune stale output first, so a deleted or renamed source module can never leave an
// orphaned JSON file behind to drift silently. README.md and .gitkeep are not generated
// and are left alone.
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".json")) rmSync(join(outDir, f));
}

let totalSchemas = 0;
const written = [];

for (const moduleName of modules) {
  const mod = await import(pathToFileURL(join(distSchemaDir, `${moduleName}.js`)).href);

  const definitions = {};
  for (const exportName of Object.keys(mod).sort()) {
    const value = mod[exportName];
    // Type-only exports don't exist at runtime, so this skips them for free.
    if (!isZodSchema(value)) continue;
    // No `name` option: passing one makes zodToJsonSchema wrap the result in its own
    // {$ref, definitions} envelope, which would nest redundantly inside the envelope
    // this script already builds. $refStrategy "none" keeps each definition
    // self-contained and inlined rather than cross-referencing sibling files.
    const { $schema, ...schema } = zodToJsonSchema(value, { $refStrategy: "none" });
    definitions[exportName] = sortDeep(schema);
  }

  const count = Object.keys(definitions).length;
  if (count === 0) continue;

  const doc = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: moduleName,
    definitions,
  };

  writeFileSync(join(outDir, `${moduleName}.json`), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  written.push(`${moduleName}.json (${count})`);
  totalSchemas += count;
}

console.log(
  `generate:schemas — wrote ${written.length} file(s), ${totalSchemas} schema(s):\n  ${written.join("\n  ")}`,
);
