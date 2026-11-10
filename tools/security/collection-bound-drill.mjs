#!/usr/bin/env node
/**
 * Reproducible adversarial drill for CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5.
 *
 * Build first, then run:
 *   node tools/security/collection-bound-drill.mjs
 *
 * The production Task schema is parsed in a child process capped at a 64 MiB V8 heap.
 * The payload carries one million invalid Action entries. With an unbounded container,
 * Zod accumulates an issue per element and the child dies (or emits a million issues).
 * The bounded production schema rejects the collection before parsing its elements, so
 * the child stays alive and reports one bounded issue.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const coreEntry = new URL('../../packages/core/dist/index.js', import.meta.url).href;
const itemCount = 1_000_000;
const childSource = `
  import { TaskEntity } from ${JSON.stringify(coreEntry)};
  const now = new Date().toISOString();
  const entityId = crypto.randomUUID();
  const started = performance.now();
  const result = TaskEntity.safeParse({
    entity_id: entityId,
    entity_type: 'task',
    name: 'collection-bound-drill',
    lifecycle_state: 'created',
    lifecycle_history: [],
    created_at: now,
    created_by: 'human:founder',
    modified_at: now,
    version: 1,
    owner_id: 'human:founder',
    owner_type: 'human',
    work_hierarchy_parent: { entity_id: crypto.randomUUID(), level: 'objective' },
    actions: new Array(${itemCount}).fill(null),
  });
  console.log(JSON.stringify({
    success: result.success,
    issue_count: result.success ? 0 : result.error.issues.length,
    elapsed_ms: Math.round(performance.now() - started),
  }));
`;

const child = spawnSync(
  process.execPath,
  ['--max-old-space-size=64', '--input-type=module', '--eval', childSource],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
);

assert.equal(
  child.signal,
  null,
  `bounded validation was killed by ${child.signal}; stderr: ${child.stderr}`,
);
assert.equal(
  child.status,
  0,
  `bounded validation exited ${child.status}; stderr: ${child.stderr}`,
);

const lines = child.stdout.trim().split('\n');
const observed = JSON.parse(lines.at(-1));
assert.equal(observed.success, false, 'oversized action collection was accepted');
assert.ok(
  observed.issue_count <= 4,
  `validation emitted ${observed.issue_count} issues; the collection bound did not short-circuit`,
);
assert.ok(
  observed.elapsed_ms < 5_000,
  `bounded rejection took ${observed.elapsed_ms}ms; the collection bound did not short-circuit`,
);

process.stdout.write(`${JSON.stringify({
  drill: 'zod-collection-bound',
  advisory: 'CVE-2023-54404',
  heap_limit_mb: 64,
  submitted_actions: itemCount,
  observed,
  result: 'oversized collection rejected before element parsing',
})}\n`);
