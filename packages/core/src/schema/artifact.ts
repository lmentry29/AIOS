import { z } from 'zod';
import { CanonicalObjectEntity, withCanonicalObjectLifecycle } from './canonical-object.js';

// §5.2 Artifact — thin Canonical Object subtype. No further field-level
// detail exists in the certified corpus (deliberately not expanded).

export const ArtifactKind = z.enum([
  'documentation',
  'source_code',
  'architecture_diagram',
  'research_report',
  'adr',
  'benchmark',
  'test_report',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

const ArtifactEntityShape = CanonicalObjectEntity.extend({
  entity_subtype: z.literal('artifact'),
  artifact_kind: ArtifactKind,

});
export const ArtifactEntity = withCanonicalObjectLifecycle(ArtifactEntityShape);
export type ArtifactEntity = z.infer<typeof ArtifactEntity>;
