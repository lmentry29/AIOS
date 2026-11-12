import { z } from 'zod';
import { CanonicalObjectEntityShape, withCanonicalObjectLifecycle } from './canonical-object.js';

// §5.2 Mission — Canonical Object subtype, added by ADR-0017 (amending ADR-0007's
// reference-only treatment of Mission). Mission is the top rung of the Work Hierarchy,
// but it is NOT a sixth entity type and it is NOT an Organizational Container.
//
// The accepted field model is deliberately minimal and sourced by ADR-0017:
//   name          -> base CanonicalEntity.name
//   purpose       -> prose string added here
//   status        -> base CanonicalEntity.lifecycle_state (ADR-0003)
//   owner_id      -> base CanonicalEntity.owner_id / owner_type
//   lifecycle     -> base lifecycle_state / lifecycle_history
//
// No schedule, budget, department, or container fields are added. Mission must not carry
// a work_hierarchy_parent because it is the hierarchy root; a Project must never be its
// parent. It may be referenced by an Objective's work_hierarchy_parent at level 'mission'.
const MissionEntityShape = CanonicalObjectEntityShape.extend({
  entity_subtype: z.literal('mission'),
  purpose: z.string().min(1),
});

const MissionEntityWithoutParent = MissionEntityShape.refine(
  (mission: z.infer<typeof MissionEntityShape>) => mission.work_hierarchy_parent === undefined,
  {
    message:
      'A Mission is the top of the Work Hierarchy and must not carry work_hierarchy_parent (ADR-0017)',
  },
);

export const MissionEntity = withCanonicalObjectLifecycle(MissionEntityWithoutParent);
export type MissionEntity = z.infer<typeof MissionEntity>;
