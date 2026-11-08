import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type JsonSchema = {
  allOf?: Array<Record<string, unknown>>;
};

function jsonSchemaIfThen(ifSchema: unknown, thenSchema: unknown): Record<string, unknown> {
  return Object.fromEntries([['if', ifSchema], ['then', thenSchema]]);
}

function generatedSchema(moduleName: string, exportName: string): JsonSchema {
  const url = new URL(`../../../schemas/generated/${moduleName}.json`, import.meta.url);
  const document = JSON.parse(readFileSync(url, 'utf8')) as {
    definitions: Record<string, JsonSchema>;
  };
  const schema = document.definitions[exportName];
  if (!schema) throw new Error(`Missing generated schema ${moduleName}.${exportName}`);
  return schema;
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
      expect.objectContaining({
        if: { required: ['lifecycle_substate'] },
        ["then"]: {
          properties: {
            lifecycle_state: { const: 'active' },
            lifecycle_substate: { enum: ['planning', 'reasoning', 'executing', 'monitoring'] },
          },
        },
      }),
    ]));
    expect(rules.some((rule) => {
      const properties = rule.properties as Record<string, unknown> | undefined;
      const history = properties?.lifecycle_history as { items?: { if?: unknown; then?: unknown } } | undefined;
      return history?.items?.if !== undefined && history.items.then !== undefined;
    })).toBe(true);
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
        expect.objectContaining({
          if: { required: ['lifecycle_substate'] },
          ["then"]: {
            properties: {
              lifecycle_state: { const: 'active' },
              lifecycle_substate: { enum: expected },
            },
          },
        }),
      ]));
    }
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
