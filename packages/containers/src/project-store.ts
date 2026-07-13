import type {
  LifecycleState,
  ProjectEntity as ProjectEntityType,
  ProjectPhase,
  ProjectStatus,
} from '@aios/core';
import { ProjectEntity } from '@aios/core';
import { ObjectStore, type EntityPatch } from '@aios/objects';

/**
 * ProjectStore — the Organizational Container layer's only implemented container type,
 * per ADR-0011 (Accepted 2026-07-13) and COM §5.4.
 *
 * A thin, type-specific wrapper over @aios/objects' ObjectStore, constructed with the
 * full ProjectEntity schema — exactly mirroring how @aios/work-hierarchy's TaskStore
 * wraps ObjectStore<TaskEntity>. It requires NO new persistence machinery: identity
 * (COM §9), atomic version/modified_at writes (§11), append-only lifecycle_history
 * (§11), and Project DNA immutability (§5.4) are all reused from @aios/objects rather
 * than reimplemented here. Part XI Ch.8's "Project Registry" is this store, in the
 * corpus's own words.
 *
 * ONLY PROJECT IS IMPLEMENTED. The other eight Organizational Container types —
 * program, release, milestone, epic, feature, roadmap, vision, workspace — have NO
 * field-level specification anywhere in the certified corpus and therefore have no
 * schema, no store, and no handling here. This is deliberate (ADR-0011 §7): building
 * placeholders for them would mean inventing their fields, which is the unilateral
 * resolution the project's standing rule forbids.
 *
 * CONSEQUENTLY, `runtime-interfaces.md` §2.5's ContainerService IS NOT IMPLEMENTED, and
 * this package does not pretend otherwise. `createContainer(type, spec)` is
 * unimplementable for eight of its nine types, and `ContainerSpec` is referenced by that
 * contract while being defined nowhere in the corpus. `nestContainer` likewise has
 * nothing to nest for those eight. See docs/process/divergence-log.md conflict #2, which
 * ADR-0011 NARROWED but did not close.
 *
 * `organizational_containers[].entity_id` (COM §3.4) therefore dereferences through this
 * store only when `container_type` is 'project'. Callers MUST branch on container_type
 * and MUST NOT assume any container id is resolvable.
 *
 * DEPENDENCY NOTE: this package depends on @aios/objects, which `runtime-interfaces.md`
 * §3/§4 does not show (its graph has a core→containers edge and no objects→containers
 * edge). That graph was drawn when containers had no schema and no store — before
 * ADR-0011 existed. COM §5.4 (ADR-gated, and therefore higher authority than
 * runtime-interfaces per AGENTS.md rules 1–2) ratifies `ObjectStore<ProjectEntity>` as
 * Project's storage explicitly. The graph is stale, not the code; logged in
 * docs/process/divergence-log.md.
 */
export class ProjectStore {
  private readonly store: ObjectStore<ProjectEntityType>;

  constructor() {
    this.store = new ObjectStore<ProjectEntityType>(ProjectEntity);
  }

  createProject(project: ProjectEntityType): ProjectEntityType {
    return this.store.create(project);
  }

  getProject(projectId: string): ProjectEntityType | undefined {
    return this.store.get(projectId);
  }

  listProjects(): ProjectEntityType[] {
    // Project is a Canonical Object, an entity_type shared with memory_object,
    // artifact, and objective — so filter to the subtype, not just the type.
    return this.store
      .list({ entityType: 'canonical_object' })
      .filter((p) => p.entity_subtype === 'project');
  }

  /**
   * Updates non-immutable fields. Any attempt to change `project_dna` throws
   * ImmutableProjectFieldError from the persistence layer (COM §5.4; Part XI Ch.4 calls
   * DNA the project's "constitutional document").
   */
  updateProject(
    projectId: string,
    patch: EntityPatch<ProjectEntityType>
  ): ProjectEntityType {
    return this.store.update(projectId, patch);
  }

  /**
   * Sets `project_status` (Ch.7) and appends to the append-only project_status_history,
   * which Ch.7 requires: "State transitions are explicit and auditable."
   *
   * Writes ONLY the operational axis. It does not touch lifecycle_state or
   * project_phase — deriving or defaulting one axis from another is exactly the
   * aliasing COM §5.4 forbids (the three vocabularies collide in five places; 'archived'
   * means three different things). See the SHELVED_PROJECT fixture.
   */
  setProjectStatus(
    projectId: string,
    status: ProjectStatus,
    actor: string
  ): ProjectEntityType {
    const current = this.store.get(projectId);
    if (!current) {
      throw new Error(`No project found with entity_id "${projectId}".`);
    }

    return this.store.update(projectId, {
      project_status: status,
      project_status_history: [
        ...current.project_status_history,
        { status, entered_at: new Date().toISOString(), actor },
      ],
    } as EntityPatch<ProjectEntityType>);
  }

  /**
   * Sets `project_phase` (Ch.6). NOT monotonic — Ch.6: "Projects may revisit earlier
   * stages as new information emerges." A backward transition is legal and is not
   * rejected, unlike Objective promotion (ADR-0010).
   *
   * There is deliberately no phase history: Ch.6 states no auditability requirement, so
   * one would be unsourced (ADR-0011, Consequence 6).
   *
   * Writes ONLY the developmental axis. No aliasing with the other two.
   */
  setProjectPhase(projectId: string, phase: ProjectPhase): ProjectEntityType {
    return this.store.update(projectId, {
      project_phase: phase,
    } as EntityPatch<ProjectEntityType>);
  }

  /**
   * Advances the RECORD's ADR-0003 lifecycle. Distinct from both project_status and
   * project_phase; a Project's record can be 'active' while the project itself is
   * operationally 'archived' (see SHELVED_PROJECT).
   */
  transitionProjectLifecycle(
    projectId: string,
    newState: LifecycleState,
    actor: string,
    substate?: string
  ): ProjectEntityType {
    return this.store.transitionLifecycle(projectId, newState, actor, substate);
  }
}
