import { z } from 'zod';
import { CanonicalObjectEntity } from './canonical-object.js';

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

export const ArtifactEntity = CanonicalObjectEntity.extend({
  entity_subtype: z.literal('artifact'),
  artifact_kind: ArtifactKind,
});
export type ArtifactEntity = z.infer<typeof ArtifactEntity>;
