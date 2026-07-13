import { describe, expect, it } from 'vitest';
import { ProjectEntity } from '../src/index.js';
import { PAUSED_MID_IMPLEMENTATION, SHELVED_PROJECT, baseProject } from './fixtures.js';

/**
 * The no-aliasing guard for Project's three orthogonal status axes (COM §5.4,
 * ADR-0011 Consequence 4).
 *
 * The fixtures live in ./fixtures.ts rather than inline, because ADR-0011 requires
 * SHELVED_PROJECT to exist as a NAMED fixture and Biome forbids exports from test
 * files. Do not inline them — the name is the contract.
 */

describe('SHELVED_PROJECT — the canonical no-aliasing fixture (ADR-0011 Consequence 4)', () => {
  it('validates: all three axes hold independent values simultaneously', () => {
    expect(ProjectEntity.safeParse(SHELVED_PROJECT).success).toBe(true);
  });

  it('round-trips with all three values intact', () => {
    const parsed = ProjectEntity.parse(SHELVED_PROJECT);

    // If ANY axis were derived from, defaulted from, or aliased to another, at least
    // one of these three would come back wrong.
    expect(parsed.project_status).toBe('archived');
    expect(parsed.lifecycle_state).toBe('active');
    expect(parsed.project_phase).toBe('operation');
  });

  it('holds three distinct meanings of "archive" without collapsing them', () => {
    const parsed = ProjectEntity.parse(SHELVED_PROJECT);

    // project_status 'archived' (operationally shelved) must NOT imply lifecycle_state
    // 'archived' (a lifecycle terminus). The record is still live and readable.
    expect(parsed.project_status).toBe('archived');
    expect(parsed.lifecycle_state).not.toBe('archived');

    // Nor may it imply project_phase 'archive' (the final developmental stage). It
    // shipped and was in operation when it got shelved.
    expect(parsed.project_phase).not.toBe('archive');
  });

  it('does not let project_status imply lifecycle_state', () => {
    // The specific derivation an aliasing implementation would make.
    expect(ProjectEntity.parse(SHELVED_PROJECT).lifecycle_state).toBe('active');
  });
});

describe('PAUSED_MID_IMPLEMENTATION — secondary case (ADR-0011 Consequence 4)', () => {
  it('validates: paused work, half-built, record live', () => {
    const parsed = ProjectEntity.parse(PAUSED_MID_IMPLEMENTATION);
    expect(parsed.project_status).toBe('paused');
    expect(parsed.project_phase).toBe('implementation');
    expect(parsed.lifecycle_state).toBe('active');
  });
});

describe('no-aliasing — the axes are independent across their full cross-product', () => {
  it('accepts every (project_status × project_phase) combination', () => {
    // 9 × 11 = 99 combinations. If any pair were constrained against the other — a
    // lookup table, a guard, a shared enum — some combination here would fail.
    const statuses = ProjectEntity._def.schema.shape.project_status.options;
    const phases = ProjectEntity._def.schema.shape.project_phase.options;

    const rejected: string[] = [];
    for (const project_status of statuses) {
      for (const project_phase of phases) {
        const result = ProjectEntity.safeParse(
          baseProject({ project_status, project_phase, lifecycle_state: 'active' }),
        );
        if (!result.success) rejected.push(`${project_status} × ${project_phase}`);
      }
    }

    expect(statuses).toHaveLength(9);
    expect(phases).toHaveLength(11);
    expect(rejected).toEqual([]);
  });
});
