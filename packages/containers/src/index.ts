// @aios/containers — Organizational Containers.
//
// ONLY Project is implemented (ADR-0011, COM §5.4). The other eight container types
// (program, release, milestone, epic, feature, roadmap, vision, workspace) have no
// field-level specification in the certified corpus, so they have no schema and no
// store here. runtime-interfaces.md §2.5's ContainerService is NOT implemented — see
// project-store.ts and docs/process/divergence-log.md conflict #2.
export * from './project-store.js';
