import { describe, expect, it } from 'vitest';
import { ToolAbstractionService, type PluginInstallSpec } from '../src/tool-service.js';
import { PluginNotFoundError } from '../src/errors.js';

function pluginSpec(overrides: Partial<PluginInstallSpec> = {}): PluginInstallSpec {
  const now = new Date().toISOString();
  return {
    entity_type: 'plugin',
    name: 'test plugin',
    governing_layer: 'tool_abstraction_layer',
    lifecycle_state: 'created',
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: 'human:founder',
    owner_type: 'human',
    relationships: [],
    ...overrides,
  } as PluginInstallSpec;
}

describe('ToolAbstractionService — install (runtime-interfaces §2.6)', () => {
  it('mints an entity_id and returns a valid Plugin', async () => {
    const svc = new ToolAbstractionService();
    const plugin = await svc.install(pluginSpec());

    expect(plugin.entity_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(plugin.entity_type).toBe('plugin');
    expect(plugin.lifecycle_history).toEqual([]);
    expect(svc.get(plugin.entity_id)).toEqual(plugin);
  });

  it('sets install_status to installed — installing is what sets that field', async () => {
    const svc = new ToolAbstractionService();
    const plugin = await svc.install(pluginSpec());
    expect(plugin.install_status).toBe('installed');
  });

  it('rejects a spec that fails core’s Plugin schema', async () => {
    const svc = new ToolAbstractionService();
    // governing_layer is a literal in the schema; anything else must not validate.
    const bad = pluginSpec({ governing_layer: 'memory_engine' } as Partial<PluginInstallSpec>);
    await expect(svc.install(bad)).rejects.toThrow();
  });

  it('gives each install a distinct entity_id (COM §9 — never reused)', async () => {
    const svc = new ToolAbstractionService();
    const a = await svc.install(pluginSpec());
    const b = await svc.install(pluginSpec());
    expect(a.entity_id).not.toBe(b.entity_id);
    expect(svc.list()).toHaveLength(2);
  });
});

describe('ToolAbstractionService — enable / disable', () => {
  it('moves install_status through installed → enabled → disabled', async () => {
    const svc = new ToolAbstractionService();
    const { entity_id } = await svc.install(pluginSpec());

    expect(svc.get(entity_id)?.install_status).toBe('installed');
    await svc.enable(entity_id);
    expect(svc.get(entity_id)?.install_status).toBe('enabled');
    await svc.disable(entity_id);
    expect(svc.get(entity_id)?.install_status).toBe('disabled');
  });

  it('bumps version on every install_status write (COM §11 — atomic writes)', async () => {
    const svc = new ToolAbstractionService();
    const installed = await svc.install(pluginSpec());
    expect(installed.version).toBe(1);

    await svc.enable(installed.entity_id);
    expect(svc.get(installed.entity_id)?.version).toBe(2);
  });

  it('never touches lifecycle_state or lifecycle_history — install_status is a separate axis (COM §4.4)', async () => {
    const svc = new ToolAbstractionService();
    const { entity_id } = await svc.install(pluginSpec({ lifecycle_state: 'active' }));

    await svc.enable(entity_id);
    await svc.disable(entity_id);

    const plugin = svc.get(entity_id);
    // Conflating these two axes is exactly what COM §4.4 and plugin.ts warn against.
    expect(plugin?.lifecycle_state).toBe('active');
    expect(plugin?.lifecycle_history).toEqual([]);
    expect(plugin?.install_status).toBe('disabled');
  });

  it('throws PluginNotFoundError for an unknown id', async () => {
    const svc = new ToolAbstractionService();
    await expect(svc.enable(crypto.randomUUID())).rejects.toThrow(PluginNotFoundError);
  });
});
