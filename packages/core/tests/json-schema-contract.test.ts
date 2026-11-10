import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type JsonSchema = {
  allOf?: Array<Record<string, unknown>>;
};

function generatedSchema(moduleName: string, exportName: string): JsonSchema {
  const url = new URL(`../../../schemas/generated/${moduleName}.json`, import.meta.url);
  const document = JSON.parse(readFileSync(url, 'utf8')) as {
    definitions: Record<string, JsonSchema>;
  };
  const schema = document.definitions[exportName];
  if (!schema) throw new Error(`Missing generated schema ${moduleName}.${exportName}`);
  return schema;
}

// Build the draft-07 conditional programmatically: Biome treats a literal "then"
// property as suspicious JavaScript, although it is a required JSON Schema keyword.
function conditional(ifSchema: unknown, thenSchema: unknown): Record<string, unknown> {
  return Object.fromEntries([['if', ifSchema], ['then', thenSchema]]);
}

function collectArraySchemas(node: unknown, found: Array<Record<string, unknown>> = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectArraySchemas(child, found);
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.type === 'array') found.push(record);
    for (const child of Object.values(record)) collectArraySchemas(child, found);
  }
  return found;
}

describe('generated JSON Schema lifecycle contracts', () => {
  it('rejects Task substates at the entity and history levels', () => {
    const rules = generatedSchema('task', 'TaskEntity').allOf ?? [];
    expect(rules).toEqual(expect.arrayContaining([
      { not: { required: ['lifecycle_substate'] } },
      { not: { properties: { lifecycle_history: { contains: { required: ['substate'] } } } } },
    ]));
  });

  it('restricts Agent substates to the four named values under active', () => {
    const rules = generatedSchema('agent', 'AgentEntity').allOf ?? [];
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining(conditional(
        { required: ['lifecycle_substate'] },
        {
          properties: {
            lifecycle_state: { const: 'active' },
            lifecycle_substate: { enum: ['planning', 'reasoning', 'executing', 'monitoring'] },
          },
        },
      )),
    ]));
    const historyRule = rules.find((rule) => {
      const properties = rule.properties as Record<string, unknown> | undefined;
      return properties?.lifecycle_history !== undefined;
    });
    expect(historyRule).toBeDefined();
    const properties = historyRule?.properties as Record<string, unknown>;
    const history = properties.lifecycle_history as { items?: Record<string, unknown> };
    expect(history.items).toBeDefined();
    expect(history.items?.if).toEqual({ required: ['substate'] });
    expect(history.items?.then).toEqual({
      properties: {
        state: { const: 'active' },
        substate: { enum: ['planning', 'reasoning', 'executing', 'monitoring'] },
      },
    });
  });

  it('uses the Canonical Object lifecycle vocabulary for every concrete subtype', () => {
    const expected = ['mutating', 'persisting', 'synchronizing'];
    for (const [moduleName, exportName] of [
      ['canonical-object', 'CanonicalObjectEntity'],
      ['memory-object', 'MemoryObjectEntity'],
      ['artifact', 'ArtifactEntity'],
      ['objective', 'ObjectiveEntity'],
      ['project', 'ProjectEntity'],
    ]) {
      const rules = generatedSchema(moduleName, exportName).allOf ?? [];
      expect(rules).toEqual(expect.arrayContaining([
        expect.objectContaining(conditional(
          { required: ['lifecycle_substate'] },
          {
            properties: {
              lifecycle_state: { const: 'active' },
              lifecycle_substate: { enum: expected },
            },
          },
        )),
      ]));
    }
  });

  it('bounds every generated array schema before element parsing (CVE-2023-54404)', () => {
    const directory = new URL('../../../schemas/generated/', import.meta.url);
    let arrayCount = 0;
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
      const document = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as {
        definitions: Record<string, unknown>;
      };
      for (const [definitionName, schema] of Object.entries(document.definitions)) {
        for (const arraySchema of collectArraySchemas(schema)) {
          arrayCount += 1;
          expect(
            arraySchema.maxItems,
            `${file}:${definitionName} array lacks an explicit maxItems bound`,
          ).toBeTypeOf('number');
        }
      }
    }
    expect(arrayCount).toBeGreaterThan(0);
  });

  it('publishes the bounded Task environment contract', () => {
    const spec = generatedSchema('task', 'TaskExecutionSpec') as {
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(spec.properties?.env).toMatchObject({
      additionalProperties: { maxLength: 256, type: 'string' },
      maxProperties: 64,
      propertyNames: { maxLength: 64, type: 'string' },
      type: 'object',
    });
  });

  it('keeps the executable Task contract strict and bounded', () => {
    const entity = generatedSchema('task', 'TaskEntity') as {
      properties?: Record<string, {
        additionalProperties?: unknown;
        properties?: Record<string, Record<string, unknown>>;
      }>;
    };
    const execution = entity.properties?.execution;
    expect(execution?.additionalProperties).toBe(false);
    expect(execution?.properties?.argv).toMatchObject({ minItems: 1, maxItems: 64 });
    expect(execution?.properties?.env?.additionalProperties).toEqual({
      maxLength: 256,
      type: 'string',
    });
    expect(entity.properties?.actions).toMatchObject({ maxItems: 256, type: 'array' });
    // A converter that cannot understand the Zod version must fail generation, not
    // emit an empty or reference-only schema that silently drops every constraint.
    expect(JSON.stringify(entity)).not.toContain('"$ref"');
  });

  it('rejects unratified Workflow and Plugin substates', () => {
    for (const [moduleName, exportName] of [
      ['workflow', 'WorkflowEntity'],
      ['plugin', 'PluginEntity'],
    ]) {
      const rules = generatedSchema(moduleName, exportName).allOf ?? [];
      expect(rules).toEqual(expect.arrayContaining([
        { not: { required: ['lifecycle_substate'] } },
        { not: { properties: { lifecycle_history: { contains: { required: ['substate'] } } } } },
      ]));
    }
  });
});
