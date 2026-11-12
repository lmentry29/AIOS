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
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const srcSchemaDir = join(pkgRoot, "src", "schema");
const distSchemaDir = join(pkgRoot, "dist", "schema");
const outDir = join(pkgRoot, "..", "..", "schemas", "generated");

// index.ts is a re-export barrel — every export it has is a duplicate of one of the
// modules below, so emitting it would write every schema twice.
const BARREL = "index";
const INTERNAL_SCHEMA_EXPORTS = new Set(["CanonicalObjectEntityShape"]);

const isZodSchema = (v) => v instanceof z.ZodType;

// Zod refinements are not representable in JSON Schema by zod-to-json-schema.
// Keep the cross-runtime contract explicit here so generated schemas enforce the same
// lifecycle/substate rules as the runtime Zod schemas. These are draft-07 conditionals.
const JSON_SCHEMA_THEN = "then";

// Zod custom types have no JSON Schema equivalent. The one production custom type
// (TaskEnvironment) publishes its contract here; an unknown custom type still fails
// generation instead of silently becoming an unconstrained schema.
const EXPLICIT_CUSTOM_SCHEMAS = new Map([
  [
    "AIOS task environment: at most 64 string entries",
    {
      type: "object",
      maxProperties: 64,
      propertyNames: { type: "string", maxLength: 64 },
      additionalProperties: { type: "string", maxLength: 256 },
    },
  ],
]);
// The converter invokes the handler twice for a custom schema; the second clone
// drops the description but shares the Zod definition object. Cache by that definition
// so the explicit contract is used for both calls. Unknown custom types still fail.
const explicitByDefinition = new WeakMap();

const lifecycleContracts = {
  "agent.AgentEntity": { substateModule: "agent", substateEnum: "AgentSubstate" },
  "task.TaskEntity": {},
  "workflow.WorkflowEntity": {},
  "plugin.PluginEntity": {},
  "canonical-object.CanonicalObjectEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
  "memory-object.MemoryObjectEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
  "artifact.ArtifactEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
  "objective.ObjectiveEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
  "project.ProjectEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
  "mission.MissionEntity": {
    substateModule: "canonical-object",
    substateEnum: "CanonicalObjectSubstate",
  },
};

const applyLifecycleContract = (moduleName, exportName, schema, mod, sharedModules) => {
  const contract = lifecycleContracts[`${moduleName}.${exportName}`];
  if (!contract) return schema;

  const sourceModule =
    contract.substateModule === moduleName ? mod : sharedModules[contract.substateModule];
  const substates = contract.substateEnum ? sourceModule[contract.substateEnum].options : [];

  const constraints =
    substates.length === 0
      ? [
          { not: { required: ["lifecycle_substate"] } },
          {
            not: {
              properties: {
                lifecycle_history: {
                  contains: { required: ["substate"] },
                },
              },
            },
          },
        ]
      : [
          {
            if: { required: ["lifecycle_substate"] },
            [JSON_SCHEMA_THEN]: {
              properties: {
                lifecycle_state: { const: "active" },
                lifecycle_substate: { enum: substates },
              },
            },
          },
          {
            properties: {
              lifecycle_history: {
                items: {
                  if: { required: ["substate"] },
                  [JSON_SCHEMA_THEN]: {
                    properties: {
                      state: { const: "active" },
                      substate: { enum: substates },
                    },
                  },
                },
              },
            },
          },
        ];

  return { ...schema, allOf: [...(schema.allOf ?? []), ...constraints] };
};

// Zod objects strip unknown keys at runtime, and the previous generated contract
// rejected them. Zod 4's input view omits `additionalProperties` for objects, so
// restore that explicit boundary rather than silently widening the published schema.
// Record schemas already carry an `additionalProperties` value schema and are left alone.
const rejectUnknownProperties = (value) => {
  if (Array.isArray(value)) return value.map(rejectUnknownProperties);
  if (value === null || typeof value !== "object") return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rejectUnknownProperties(entry)]),
  );
  if (result.type === "object" && result.additionalProperties === undefined) {
    result.additionalProperties = false;
  }
  return result;
};

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

const sharedModules = {
  "canonical-object": await import(pathToFileURL(join(distSchemaDir, "canonical-object.js")).href),
};

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
    if (!isZodSchema(value) || INTERNAL_SCHEMA_EXPORTS.has(exportName)) continue;
    // Zod 4's native converter is the supported replacement for
    // zod-to-json-schema, which returns an empty schema for Zod 4 inputs. Keep every
    // definition self-contained: `reused: "inline"` prevents sibling references and
    // `cycles: "throw"` fails generation rather than emitting an unvalidated cycle.
    const { $schema, ...schema } = z.toJSONSchema(value, {
      target: "draft-7",
      // The JSON Schema is the cross-runtime input contract. Use Zod's input view so
      // fields with defaults stay optional, matching what the runtime validator
      // actually accepts; the output view would mark every defaulted field required.
      io: "input",
      reused: "inline",
      cycles: "throw",
      unrepresentable: ({ zodSchema, message }) => {
        const definition = zodSchema._zod?.def;
        const explicit =
          (zodSchema.description
            ? EXPLICIT_CUSTOM_SCHEMAS.get(zodSchema.description)
            : undefined) ?? (definition ? explicitByDefinition.get(definition) : undefined);
        if (explicit === undefined) throw new Error(message);
        if (definition) explicitByDefinition.set(definition, explicit);
        return explicit;
      },
    });
    definitions[exportName] = sortDeep(
      rejectUnknownProperties(
        applyLifecycleContract(moduleName, exportName, schema, mod, sharedModules),
      ),
    );
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
