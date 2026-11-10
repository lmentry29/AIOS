import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessPolicy } from '@aios/founder';
import { FilePolicyRegistry, PolicyAdministrationService } from '@aios/founder';
import type { AgentExecutionPort, TaskVerificationPort } from '@aios/orchestration';
import type { TaskEntity, WorkflowEntity } from '@aios/core';
import { loadHostConfig } from '../src/config.js';
import { createHostRuntime, type HostRuntime } from '../src/runtime.js';
import { createHostServer, type HostHttpServer } from '../src/server.js';
import {
  AGENT_ID,
  AGENT_TOKEN,
  DECISION_COLLECTION_ID,
  FOUNDER,
  FOUNDER_TOKEN,
  GMAIL_RESOURCE_ID,
  NOTION_RESOURCE_ID,
  VAULT_RESOURCE_ID,
  VERIFIER_ID,
  makePolicy,
  makeTask,
  makeWorkflow,
} from './fixtures.js';

interface Harness {
  baseUrl: string;
  port: number;
  runtime: HostRuntime;
  server: HostHttpServer;
  policyPath: string;
  configPath: string;
}

interface JsonResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const execution: AgentExecutionPort = {
  validateAgent: async (agentId) => agentId === AGENT_ID,
  executeTask: async (_agentId, task) => ({
    summary: `Test executor completed "${task.name}".`,
    evidence: [`task:${task.entity_id}:executed`],
  }),
  coordinate: async () => {
    throw new Error('Coordination is not exercised by the host test suite.');
  },
};

const verification: TaskVerificationPort = {
  verifier_id: VERIFIER_ID,
  verify: async ({ task, execution_result }) => ({
    accepted: execution_result.evidence.includes(`task:${task.entity_id}:executed`),
    reason: 'Independent verifier matched the executor evidence to the Task identifier.',
    evidence: [`verified-task:${task.entity_id}`],
  }),
};

async function attachPolicy(policyPath: string, policy: AccessPolicy): Promise<void> {
  const registry = new FilePolicyRegistry({ filePath: policyPath });
  try {
    const administration = new PolicyAdministrationService(FOUNDER, registry, registry);
    await administration.publish(policy, FOUNDER);
    const resources = new Set(policy.rules.flatMap((rule) => [...rule.resource_ids]));
    for (const resourceId of resources) {
      await administration.attach(resourceId, policy.policy_id, FOUNDER);
    }
  } finally {
    registry.close();
  }
}

async function startHost(options: {
  policy?: AccessPolicy;
  withAdapters?: boolean;
  directory?: string;
} = {}): Promise<Harness> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'aios-host-http-'));
  const policyPath = join(directory, 'policy-state.json');
  const configPath = join(directory, 'host.json');
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    bind: { host: '127.0.0.1', port: 0 },
    policy_file: policyPath,
    operational_store: { directory: join(directory, 'operational') },
    dispatch_lease_ms: 5_000,
    decision_collection_id: DECISION_COLLECTION_ID,
    resources: { vault: VAULT_RESOURCE_ID, gmail: GMAIL_RESOURCE_ID, notion: NOTION_RESOURCE_ID },
    bootstrap_principal_id: FOUNDER,
    sessions: [
      { session_id: randomUUID(), principal_id: FOUNDER, token_sha256: sha256(FOUNDER_TOKEN), label: 'founder laptop' },
      { session_id: randomUUID(), principal_id: AGENT_ID, token_sha256: sha256(AGENT_TOKEN), label: 'agent worker' },
    ],
  }), { mode: 0o600 });

  if (options.policy) await attachPolicy(policyPath, options.policy);

  const config = loadHostConfig(configPath);
  const runtime = createHostRuntime({
    config,
    ...(options.withAdapters
      ? { execution, verification, resolveAgent: async () => AGENT_ID }
      : {}),
  });
  const server = createHostServer(runtime);
  const address = await server.listen();
  cleanups.push(async () => {
    await server.close();
    runtime.close();
  });
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    port: address.port,
    runtime,
    server,
    policyPath,
    configPath,
  };
}

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    rawBody?: string;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  else if (options.contentType !== undefined) headers['content-type'] = options.contentType;

  const response = await fetch(`${harness.baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsed as Record<string, unknown> | undefined,
  };
}

function rawGet(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', headers },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function intake(harness: Harness, kind: 'task' | 'workflow', entity: TaskEntity | WorkflowEntity) {
  return call(harness, 'POST', '/v1/intake', {
    token: FOUNDER_TOKEN,
    body: { kind, entity },
  });
}

function dispatch(harness: Harness, workflowId: string, idempotencyKey = randomUUID()) {
  return call(harness, 'POST', `/v1/workflows/${workflowId}/dispatch`, {
    token: FOUNDER_TOKEN,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

describe('trusted host HTTP surface', () => {
  it('serves health without authentication and exposes no local configuration', async () => {
    const harness = await startHost();
    const health = await call(harness, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body?.status).toBe('ok');
    expect(health.body?.capabilities).toEqual({ dispatch: false, evidence: false });
    const serialized = JSON.stringify(health.body);
    expect(serialized).not.toContain(harness.policyPath);
    expect(serialized).not.toContain(harness.configPath);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.headers.get('access-control-allow-origin')).toBeNull();

    const session = await call(harness, 'GET', '/v1/session', { token: FOUNDER_TOKEN });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ principal_id: FOUNDER, human: true, label: 'founder laptop' });
  });

  it('rejects every unauthenticated or malformed credential identically', async () => {
    const harness = await startHost();
    for (const options of [
      {},
      { token: 'wrong-token-0123456789abcdef' },
      { headers: { authorization: `Basic ${FOUNDER_TOKEN}` } },
      { headers: { authorization: `Bearer ${FOUNDER_TOKEN} extra` } },
    ]) {
      const response = await call(harness, 'GET', '/v1/session', options);
      expect(response.status).toBe(401);
      expect(response.body?.error).toBe('unauthenticated');
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(JSON.stringify(response.body)).not.toContain(FOUNDER_TOKEN);
    }
  });

  it('blocks DNS-rebinding host headers and browser cross-origin requests', async () => {
    const harness = await startHost();
    const rebound = await rawGet(harness.port, { host: 'attacker.example' });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body).error).toBe('invalid_host_header');

    const crossOrigin = await call(harness, 'GET', '/health', {
      headers: { origin: 'http://attacker.example' },
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body?.error).toBe('cross_origin_rejected');
  });

  it('rejects unknown routes, wrong methods, and any policy-administration endpoint', async () => {
    const harness = await startHost();
    expect((await call(harness, 'GET', '/v1/unknown')).status).toBe(404);

    const wrongMethod = await call(harness, 'DELETE', '/v1/session', { token: FOUNDER_TOKEN });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');

    // Policy administration is an offline CLI surface, never an HTTP route.
    expect((await call(harness, 'POST', '/v1/policies', { token: FOUNDER_TOKEN, body: {} })).status).toBe(404);
    expect((await call(harness, 'POST', '/v1/policy/attach', { token: FOUNDER_TOKEN, body: {} })).status).toBe(404);
  });

  it('defaults to deny: intake and dispatch fail closed before any policy is attached', async () => {
    const harness = await startHost({ withAdapters: true });
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);

    const deniedIntake = await intake(harness, 'task', task);
    expect(deniedIntake.status).toBe(403);
    expect(harness.runtime.taskStore.getTask(task.entity_id)).toBeUndefined();

    const deniedDispatch = await dispatch(harness, workflow.entity_id);
    expect(deniedDispatch.status).toBe(403);
    expect(harness.runtime.workflowStore.get(workflow.entity_id)).toBeUndefined();
  });

  it('derives the actor from the verified session and rejects body-supplied identities', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });

    const agentImpersonation = await call(harness, 'POST', '/v1/intake', {
      token: AGENT_TOKEN,
      body: { kind: 'task', entity: task },
    });
    expect(agentImpersonation.status).toBe(403);
    expect(agentImpersonation.body?.error).toBe('actor_mismatch');

    const spoofedFounder = await intake(harness, 'task', makeTask({ created_by: 'human:attacker', owner_id: 'human:attacker' }));
    expect(spoofedFounder.status).toBe(403);
    expect(spoofedFounder.body?.error).toBe('actor_mismatch');

    expect((await intake(harness, 'task', task)).status).toBe(201);
  });

  it('denies dispatch when the policy grants intake only', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id, { intakeOnly: true }),
      withAdapters: true,
    });

    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const denied = await dispatch(harness, workflow.entity_id);
    expect(denied.status).toBe(403);
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('created');
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('created');
  });

  it('executes, independently verifies, and exposes durable evidence over one shared authorization chain', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withAdapters: true,
    });

    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const dispatched = await dispatch(harness, workflow.entity_id);
    expect(dispatched.status).toBe(200);
    expect(dispatched.body?.lifecycle_state).toBe('completed');

    const storedTask = harness.runtime.taskStore.getTask(task.entity_id);
    expect(storedTask?.lifecycle_state).toBe('completed');
    expect(storedTask?.assigned_agent).toBe(AGENT_ID);
    expect(storedTask?.audit_trail_ref).toMatch(/^[0-9a-f-]{36}$/);

    const taskRead = await call(harness, 'GET', `/v1/tasks/${task.entity_id}`, { token: FOUNDER_TOKEN });
    expect(taskRead.status).toBe(200);

    const evidence = await call(
      harness,
      'GET',
      `/v1/tasks/${task.entity_id}/evidence/${storedTask?.audit_trail_ref}`,
      { token: FOUNDER_TOKEN },
    );
    expect(evidence.status).toBe(200);
    const artifact = evidence.body?.evidence as Record<string, unknown>;
    expect(artifact.artifact_kind).toBe('test_report');
    expect(artifact.description).toContain(VERIFIER_ID);

    const founderQuery = await call(harness, 'POST', '/v1/founder/query', {
      token: FOUNDER_TOKEN,
      body: { question: 'trusted host slice' },
    });
    expect(founderQuery.status).toBe(200);
    expect((founderQuery.body?.matching_entities as unknown[]).length).toBeGreaterThan(0);

    // One append-only chain proves Founder and Orchestration share one evaluator: the same
    // audit read contains the verifier, the executor, dispatch, and the Founder evidence read.
    const audit = await call(harness, 'GET', '/v1/audit/authorization?limit=500', { token: FOUNDER_TOKEN });
    expect(audit.status).toBe(200);
    const records = audit.body?.records as Array<Record<string, unknown>>;
    expect(records).toContainEqual(expect.objectContaining({ actor_id: VERIFIER_ID, action: 'read_evidence', decision: 'allow' }));
    expect(records).toContainEqual(expect.objectContaining({ actor_id: AGENT_ID, action: 'execute', decision: 'allow' }));
    expect(records).toContainEqual(expect.objectContaining({ actor_id: FOUNDER, action: 'dispatch', decision: 'allow' }));
    expect(records).toContainEqual(expect.objectContaining({ actor_id: FOUNDER, action: 'read_evidence', decision: 'allow' }));
    expect(records).toContainEqual(expect.objectContaining({ actor_id: FOUNDER, action: 'read_status', decision: 'allow' }));
  });

  it('refuses to dispatch when no execution or verification adapter is configured', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });

    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const disabled = await dispatch(harness, workflow.entity_id);
    expect(disabled.status).toBe(503);
    expect(disabled.body?.error).toBe('adapter_unavailable');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('created');
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('created');
  });

  it('replays a completed dispatch for the same idempotency key and rejects a different one', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withAdapters: true,
    });
    await intake(harness, 'task', task);
    await intake(harness, 'workflow', workflow);

    const first = await dispatch(harness, workflow.entity_id, 'replay-key-0001');
    expect(first.status).toBe(200);
    expect(first.body?.replayed).toBe(false);

    const replay = await dispatch(harness, workflow.entity_id, 'replay-key-0001');
    expect(replay.status).toBe(200);
    expect(replay.body?.replayed).toBe(true);
    expect(replay.body?.run_id).toBe(first.body?.run_id);
    expect(replay.body?.lifecycle_state).toBe('completed');

    const missingKey = await call(harness, 'POST', `/v1/workflows/${workflow.entity_id}/dispatch`, {
      token: FOUNDER_TOKEN,
    });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body?.error).toBe('idempotency_key_required');

    const second = await dispatch(harness, workflow.entity_id, 'replay-key-0002');
    expect(second.status).toBe(409);
    expect(second.body?.error).toBe('orchestration_rejected');
  });

  it('reserves Founder governance for human principals', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });

    const agentDecision = await call(harness, 'POST', '/v1/founder/decisions', {
      token: AGENT_TOKEN,
      body: { title: 'Agent governance', decision: 'Grant access', rationale: 'Not allowed.' },
    });
    expect(agentDecision.status).toBe(403);
    expect(agentDecision.body?.error).toBe('human_principal_required');

    expect((await call(harness, 'GET', '/v1/founder/queue', { token: AGENT_TOKEN })).status).toBe(403);

    const decision = await call(harness, 'POST', '/v1/founder/decisions', {
      token: FOUNDER_TOKEN,
      body: {
        title: 'Trusted host boundary',
        decision: 'Compose one shared authorization boundary',
        rationale: 'Two evaluators could diverge silently.',
        evidence: ['docs/adr/ADR-0013-default-deny-resource-authorization.md'],
      },
    });
    expect(decision.status).toBe(201);
    const decisionId = decision.body?.decision_id;
    expect(decisionId).toMatch(/^[0-9a-f-]{36}$/);

    const decisions = await call(harness, 'GET', '/v1/founder/decisions', { token: FOUNDER_TOKEN });
    expect(decisions.status).toBe(200);
    expect((decisions.body?.decisions as Array<Record<string, unknown>>).map((item) => item.entity_id))
      .toContain(decisionId);

    const spoofed = await call(harness, 'POST', '/v1/founder/decisions', {
      token: FOUNDER_TOKEN,
      body: { title: 'Spoof', decision: 'No', rationale: 'No', decided_by: 'human:other' },
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.body?.error).toBe('actor_mismatch');
  });

  it('restricts authorization-audit reads to the bootstrap principal', async () => {
    const harness = await startHost();
    const denied = await call(harness, 'GET', '/v1/audit/authorization', { token: AGENT_TOKEN });
    expect(denied.status).toBe(403);
    expect(denied.body?.error).toBe('bootstrap_principal_required');

    const allowed = await call(harness, 'GET', '/v1/audit/authorization', { token: FOUNDER_TOKEN });
    expect(allowed.status).toBe(200);
    expect(allowed.body?.total).toBe(0);

    expect((await call(harness, 'GET', '/v1/audit/authorization?limit=0', { token: FOUNDER_TOKEN })).status).toBe(400);
    expect((await call(harness, 'GET', '/v1/audit/policies', { token: FOUNDER_TOKEN })).status).toBe(200);
  });

  it('enforces media types, JSON validity, and the configured body limit', async () => {
    const harness = await startHost();
    expect((await call(harness, 'POST', '/v1/intake', {
      token: FOUNDER_TOKEN,
      rawBody: '{"kind":"task"}',
      contentType: 'text/plain',
    })).status).toBe(415);

    expect((await call(harness, 'POST', '/v1/intake', {
      token: FOUNDER_TOKEN,
      rawBody: '{',
    })).status).toBe(400);

    expect((await call(harness, 'POST', '/v1/intake', {
      token: FOUNDER_TOKEN,
      body: [1, 2, 3],
    })).status).toBe(400);

    const oversized = await call(harness, 'POST', '/v1/intake', {
      token: FOUNDER_TOKEN,
      body: { kind: 'task', padding: 'x'.repeat(300_000) },
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body?.error).toBe('payload_too_large');
  });

  it('releases the policy lock and re-verifies the audit chain after shutdown', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withAdapters: true,
    });
    await intake(harness, 'task', task);
    await intake(harness, 'workflow', workflow);
    await dispatch(harness, workflow.entity_id);

    await harness.server.close();
    harness.runtime.close();

    const registry = new FilePolicyRegistry({ filePath: harness.policyPath });
    try {
      expect(await registry.resolve(task.entity_id)).toBeTruthy();
      expect(registry.listAuthorizationAudit().length).toBeGreaterThan(0);
    } finally {
      registry.close();
    }
  });

  it('restores durable operational state and suspends interrupted work after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-restart-'));
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const ownedTask = { ...task, assigned_workflow: workflow.entity_id } as TaskEntity;

    const first = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withAdapters: true,
      directory,
    });
    expect((await intake(first, 'task', ownedTask)).status).toBe(201);
    expect((await intake(first, 'workflow', workflow)).status).toBe(201);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'active', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'validated', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'active', FOUNDER);
    first.runtime.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'interrupted-dispatch-0001',
    });

    // Simulate a host crash: the run is journaled as running, then the process stops
    // without completing it.
    await first.server.close();
    first.runtime.close();

    const second = await startHost({ directory });
    expect(second.runtime.recoveredWorkflows).toEqual([workflow.entity_id]);
    expect(second.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    expect(second.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(second.runtime.runs.list()[0]?.state).toBe('interrupted');

    const read = await call(second, 'GET', `/v1/tasks/${task.entity_id}`, { token: FOUNDER_TOKEN });
    expect(read.status).toBe(200);
    expect((read.body?.task as Record<string, unknown>).lifecycle_state).toBe('suspended');

    const health = await call(second, 'GET', '/health');
    expect(health.body?.storage).toBe('durable');
    expect(health.body?.recovered_workflows).toBe(1);
  });
});
