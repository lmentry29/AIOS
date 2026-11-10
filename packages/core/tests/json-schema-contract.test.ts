import { readFileSync } from 'node:fs';
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
