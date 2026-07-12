import { z } from 'zod';
import { CanonicalEntity } from './base.js';

// §4.4 Plugin — extends base. FLAGGED LOW-CONFIDENCE per COM §1.6/§6 item 4:
// modeled from Tooling Ecosystem's Adapter/Tool concepts, not from a
// dedicated Plugin spec (none exists in the certified corpus). Do not
// treat this file as more settled than the doc itself claims it is.

export const PluginInstallStatus = z.enum([
  'available',
  'installed',
  'enabled',
  'disabled',
  'removed',
]);
export type PluginInstallStatus = z.infer<typeof PluginInstallStatus>;

export const PluginEntity = CanonicalEntity.extend({
  entity_type: z.literal('plugin'),
  governing_layer: z.literal('tool_abstraction_layer'),
  wraps_adapter: z.string().uuid().optional(),
  // Orthogonal to lifecycle_state by design (§4.4) — do not conflate
  // install_status with lifecycle_state in downstream logic.
  install_status: PluginInstallStatus,
});
export type PluginEntity = z.infer<typeof PluginEntity>;
