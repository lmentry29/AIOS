/** Thrown when an operation references a plugin_id not present in the registry. */
export class PluginNotFoundError extends Error {
  constructor(pluginId: string) {
    super(`No plugin found with entity_id "${pluginId}".`);
    this.name = 'PluginNotFoundError';
  }
}

/**
 * Thrown when install() is called with an entity_id already in the registry.
 * Per COM §9, entity_id is never reused or reassigned — including after a
 * plugin is removed — so existence alone is grounds for rejection.
 */
export class PluginIdConflictError extends Error {
  constructor(pluginId: string) {
    super(
      `entity_id "${pluginId}" already exists in the plugin registry and cannot be reused (COM §9).`
    );
    this.name = 'PluginIdConflictError';
  }
}
