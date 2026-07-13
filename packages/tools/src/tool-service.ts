import { randomUUID } from 'node:crypto';
import type { PluginEntity as PluginEntityType, PluginInstallStatus } from '@aios/core';
import { PluginEntity } from '@aios/core';
import { PluginIdConflictError, PluginNotFoundError } from './errors.js';

/**
 * The spec a caller supplies to install(). Per runtime-interfaces.md §2.6:
 * `install(plugin: Omit<Plugin, "entity_id" | "lifecycle_history">)`.
 *
 * install_status is additionally omitted here. The contract does not exclude it,
 * but a method named install() that lets the caller pass install_status: 'removed'
 * and then honours it is incoherent — installing IS the act that sets that field.
 * The service therefore owns it. Per AGENTS.md ("optional-vs-defaulted fields are
 * ordinary engineering judgment calls"), this is a defaulting decision, not a
 * contract change: every field the contract requires a caller to provide is still
 * required, and install_status still exists on the returned Plugin.
 */
export type PluginInstallSpec = Omit<
  PluginEntityType,
  'entity_id' | 'lifecycle_history' | 'install_status'
>;

/**
 * ToolAbstractionService — Plugin install / enable / disable, per
 * docs/engineering/runtime-interfaces.md §2.6.
 *
 * DEPENDS ON @aios/core ONLY — deliberately not on @aios/objects, so Plugins are
 * held in this service's own registry rather than in the Object Store.
 *
 * That looks like duplication and is worth justifying. runtime-interfaces.md is the
 * authority for the dependency graph (per implementation-playbook.md §2, which names
 * it as such), and both §3 ("tools/ — depends on: core") and §4's graph (which has a
 * `core --> tools` edge and no `objects --> tools` edge) say core-only. The playbook's
 * own shorthand graph in §2 contradicts this by implying objects → tools; per the
 * playbook's stated rule ("if this playbook and a linked document ever disagree, the
 * linked document wins and this playbook has a bug — report it as one"),
 * runtime-interfaces wins. Logged in docs/process/divergence-log.md.
 *
 * The dependency also isn't needed on the merits: ObjectStore's value is lifecycle
 * machinery (COM §9/§11 — transitions, version bumps, append-only history), and this
 * service manages the install_status axis, which COM §4.4 states is *orthogonal to*
 * lifecycle_state. Plugin lifecycle is explicitly "not a full loop" (§1). Validation —
 * the part that must not be re-implemented — still comes from core's Zod schema.
 *
 * `invoke()` (§2.6's fourth method) IS NOT IMPLEMENTED HERE, deliberately. It must
 * resolve a plugin id to executable code, and the corpus provides no way to do that:
 * `Plugin.wraps_adapter` points at an Adapter concept with no schema, no store, and no
 * registry anywhere in the model. Implementing invoke() therefore requires inventing a
 * Plugin/Adapter execution model — an architectural decision, not an implementation
 * detail, on top of the single lowest-confidence entity in the corpus (COM §4.4,
 * AGENTS.md rule 7). Per the project's standing rule, that gap is left visible rather
 * than filled unilaterally. See docs/process/divergence-log.md, and
 * ./DRAFT-invoke-adapter-resolution.md for a proposed (NOT adopted) resolution.
 *
 * What remains below is fully specified by §2.6 and invents nothing.
 */
export class ToolAbstractionService {
  private readonly plugins = new Map<string, PluginEntityType>();

  async install(spec: PluginInstallSpec): Promise<PluginEntityType> {
    const candidate = {
      ...spec,
      entity_id: randomUUID(),
      lifecycle_history: [],
      install_status: 'installed' satisfies PluginInstallStatus,
    };

    // Validate through core's schema rather than trusting the caller's shape —
    // this is the one thing that must not be re-implemented per-package.
    const plugin = PluginEntity.parse(candidate);

    if (this.plugins.has(plugin.entity_id)) {
      throw new PluginIdConflictError(plugin.entity_id);
    }

    this.plugins.set(plugin.entity_id, plugin);
    return plugin;
  }

  async enable(pluginId: string): Promise<void> {
    this.setInstallStatus(pluginId, 'enabled');
  }

  async disable(pluginId: string): Promise<void> {
    this.setInstallStatus(pluginId, 'disabled');
  }

  get(pluginId: string): PluginEntityType | undefined {
    return this.plugins.get(pluginId);
  }

  list(): PluginEntityType[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Writes install_status and bumps version/modified_at together, mirroring COM §11's
   * atomic-write rule. lifecycle_state and lifecycle_history are deliberately never
   * touched here: this axis is orthogonal to the ADR-0003 lifecycle (COM §4.4).
   */
  private setInstallStatus(pluginId: string, status: PluginInstallStatus): PluginEntityType {
    const current = this.plugins.get(pluginId);
    if (!current) {
      throw new PluginNotFoundError(pluginId);
    }

    const updated = PluginEntity.parse({
      ...current,
      install_status: status,
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.plugins.set(pluginId, updated);
    return updated;
  }
}
