import { z } from 'zod';

// --- 3.1 Identity ---

export const EntityType = z.enum([
  'agent',
  'task',
  'workflow',
  'plugin',
  'canonical_object',
]);
export type EntityType = z.infer<typeof EntityType>;

// --- 3.2 Lifecycle (ADR-0003) ---

export const LifecycleState = z.enum([
  'created',
  'validated',
  'active',
  'monitored',
  'suspended', // optional per ADR-0003 — entities may skip this stage
  'completed',
  'archived',
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

// §9: entity_id / actor identity scheme — UUIDv4 or "human:<founder_id>",
// never reused/reassigned, never identified by `name` alone.
export const ActorRef = z.string().refine(
  (val) => z.string().uuid().safeParse(val).success || /^human:.+$/.test(val),
  { message: 'actor must be a UUID (entity_id) or "human:<founder_id>"' }
);

export const LifecycleHistoryEntry = z.object({
  state: LifecycleState,
  substate: z.string().optional(),
  entered_at: z.string().datetime(), // §10: ISO 8601 UTC, not epoch
  actor: ActorRef,
});
export type LifecycleHistoryEntry = z.infer<typeof LifecycleHistoryEntry>;

// --- 3.4 Hierarchy and container references ---
// NEVER merge work_hierarchy_parent and organizational_containers — that
// merge was the exact defect ADR-0004 Amendment A corrected.

export const WorkHierarchyLevel = z.enum(['mission', 'objective', 'task']);
export type WorkHierarchyLevel = z.infer<typeof WorkHierarchyLevel>;

export const WorkHierarchyParent = z.object({
  entity_id: z.string().uuid(),
  level: WorkHierarchyLevel,
});
export type WorkHierarchyParent = z.infer<typeof WorkHierarchyParent>;

export const ContainerType = z.enum([
  'project',
  'program',
  'release',
  'milestone',
  'epic',
  'feature',
  'roadmap',
  'vision',
  'workspace',
]);
export type ContainerType = z.infer<typeof ContainerType>;

export const OrganizationalContainerRef = z.object({
  entity_id: z.string().uuid(),
  container_type: ContainerType,
});
export type OrganizationalContainerRef = z.infer<typeof OrganizationalContainerRef>;

// --- 7. Ownership model ---

export const OwnerType = z.enum(['agent', 'human']);
export type OwnerType = z.infer<typeof OwnerType>;

// --- 8. Relationship model ---
// Floor, not ceiling (§6 item 5) — open vocabulary beyond this minimum set.

export const RelationshipType = z.enum([
  'supersedes',
  'superseded_by',
  'assigned_to',
  'depends_on',
  'blocks',
  'derived_from',
  'contains',
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const RelationshipDirection = z.enum(['outbound', 'inbound']);
export type RelationshipDirection = z.infer<typeof RelationshipDirection>;

export const Relationship = z.object({
  target_entity_id: z.string().uuid(),
  target_entity_type: EntityType,
  // string, not RelationshipType, because the vocabulary is explicitly open
  // beyond the minimum set (§6 item 5) — the enum documents the floor,
  // it doesn't constrain the field.
  relationship_type: z.string(),
  direction: RelationshipDirection,
});
export type Relationship = z.infer<typeof Relationship>;

// --- 3. Base schema: Canonical Entity ---

export const CanonicalEntity = z.object({
  // 3.1 Identity
  entity_id: z.string().uuid(),
  entity_type: EntityType,
  entity_subtype: z.string().optional(), // open vocabulary by design
  name: z.string(),
  description: z.string().optional(),

  // 3.2 Lifecycle
  lifecycle_state: LifecycleState,
  lifecycle_substate: z.string().optional(),
  lifecycle_history: z.array(LifecycleHistoryEntry),

  // 3.3 Provenance
  created_at: z.string().datetime(),
  created_by: ActorRef,
  modified_at: z.string().datetime(),
  version: z.number().int().positive(),

  // 3.4 Hierarchy and container references
  // Conditional per type — base leaves optional; §4 extensions tighten
  // per entity type (e.g. Task requires work_hierarchy_parent at 'objective').
  work_hierarchy_parent: WorkHierarchyParent.optional(),
  organizational_containers: z.array(OrganizationalContainerRef).default([]),

  // 3.5 Access and audit
  access_policy: z.string().uuid().optional(), // placeholder — unratified governance model (§6 item 1)
  audit_trail_ref: z.string().uuid().optional(),

  // §7 Ownership — distinct from created_by (never changes) and
  // assigned_agent/assigned_workflow (execution, not accountability)
  owner_id: ActorRef,
  owner_type: OwnerType,

  // §8 Relationships — base schema, not just Canonical Object
  relationships: z.array(Relationship).default([]),
});
export type CanonicalEntity = z.infer<typeof CanonicalEntity>;
