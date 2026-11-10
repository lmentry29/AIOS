#!/usr/bin/env node
/**
 * Reproducible adversarial drill for CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5.
 *
 * Build first, then run:
 *   node tools/security/collection-bound-drill.mjs
 *
 * Each payload is parsed in a child process capped at a 64 MiB V8 heap. An unbounded
 * array or record accumulates an issue per element and exhausts memory; the bounded
 * production schemas reject the container before examining its entries, so each child
 * stays alive and reports one bounded issue.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const coreEntry = new URL('../../packages/core/dist/index.js', import.meta.url).href;
const actionCount = 1_000_000;
const environmentCount = 100_000;

function runChild(label, source) {
  const child = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(
    child.signal,
    null,
    `${label} validation was killed by ${child.signal}; stderr: ${child.stderr}`,
  );
  assert.equal(
    child.status,
    0,
    `${label} validation exited ${child.status}; stderr: ${child.stderr}`,
  );
  const lines = child.stdout.trim().split('\n');
  const observed = JSON.parse(lines.at(-1));
  assert.equal(observed.success, false, `${label} was accepted`);
  assert.ok(
    observed.issue_count <= 4,
    `${label} emitted ${observed.issue_count} issues; the bound did not short-circuit`,
  );
  assert.ok(
    observed.elapsed_ms < 5_000,
    `${label} rejection took ${observed.elapsed_ms}ms; the bound did not short-circuit`,
  );
  return observed;
}

const actions = runChild('oversized action collection', `
  import { TaskEntity } from ${JSON.stringify(coreEntry)};
  const now = new Date().toISOString();
  const started = performance.now();
  const result = TaskEntity.safeParse({
    entity_id: crypto.randomUUID(),
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
    actions: new Array(${actionCount}).fill(null),
  });
  console.log(JSON.stringify({
    success: result.success,
    issue_count: result.success ? 0 : result.error.issues.length,
    elapsed_ms: Math.round(performance.now() - started),
  }));
`);

const environment = runChild('oversized environment record', `
  import { TaskEnvironment } from ${JSON.stringify(coreEntry)};
  const started = performance.now();
  const env = Object.fromEntries(
    Array.from({ length: ${environmentCount} }, (_, index) => ['K' + index, 'value']),
  );
  const result = TaskEnvironment.safeParse(env);
  console.log(JSON.stringify({
    success: result.success,
    issue_count: result.success ? 0 : result.error.issues.length,
    elapsed_ms: Math.round(performance.now() - started),
  }));
`);

process.stdout.write(`${JSON.stringify({
  drill: 'zod-collection-bound',
  advisory: 'CVE-2023-54404',
  heap_limit_mb: 64,
  actions: { submitted: actionCount, ...actions },
  environment: { submitted: environmentCount, ...environment },
  result: 'oversized containers rejected before entry parsing',
})}\n`);
