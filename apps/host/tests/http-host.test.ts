import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessAction, AccessPolicy } from '@aios/founder';
import { FilePolicyRegistry, PolicyAdministrationService } from '@aios/founder';
import type { AgentExecutionPort, TaskVerificationPort } from '@aios/orchestration';
import { ArtifactEntity } from '@aios/core';
import type { TaskEntity, WorkflowEntity } from '@aios/core';
import { loadHostConfig } from '../src/config.js';
import { LocalCommandExecutor } from '../src/execution/command-executor.js';
import { LocalCommandVerifier } from '../src/execution/command-verifier.js';
import { RunWorkspaceManager } from '../src/execution/workspace.js';
import { DurableAuthorizationAuditStore } from '../src/persistence/authorization-audit-store.js';
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
import { StubSandbox, makeExecutionConfig } from './sandbox-fixture.js';

interface Harness {
  baseUrl: string;
  port: number;
  runtime: HostRuntime;
  server: HostHttpServer;
  policyPath: string;
  configPath: string;
  sandbox?: StubSandbox;
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
    verifier_id: VERIFIER_ID,
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
  withLocalAdapters?: boolean;
  verification?: TaskVerificationPort;
  directory?: string;
  maxConcurrentTasks?: number;
} = {}): Promise<Harness> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'aios-host-http-'));
  const policyPath = join(directory, 'policy-state.json');
  const configPath = join(directory, 'host.json');
  const localExecutionConfig = options.withLocalAdapters
    ? {
        ...makeExecutionConfig(join(directory, 'workspaces')),
        max_concurrent_tasks: options.maxConcurrentTasks ?? 1,
      }
    : undefined;
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
    ...(localExecutionConfig === undefined ? {} : { execution: localExecutionConfig }),
  }), { mode: 0o600 });

  if (options.policy) await attachPolicy(policyPath, options.policy);

  const config = loadHostConfig(configPath);
  let sandbox: StubSandbox | undefined;
  let localAdapters: { execution: LocalCommandExecutor; verification: LocalCommandVerifier } | undefined;
  if (localExecutionConfig) {
    sandbox = new StubSandbox();
    const executionConfig = localExecutionConfig;
    const workspaces = new RunWorkspaceManager(executionConfig.workspace_directory);
    localAdapters = {
      execution: new LocalCommandExecutor(executionConfig, sandbox, workspaces),
      verification: new LocalCommandVerifier(executionConfig, sandbox, workspaces),
    };
  }
  const runtime = createHostRuntime({
    config,
    ...(options.withAdapters
      ? { execution, verification, resolveAgent: async () => AGENT_ID }
      : {}),
    ...(localAdapters === undefined
      ? {}
      : { ...localAdapters, resolveAgent: async () => AGENT_ID }),
    ...(options.verification === undefined ? {} : { verification: options.verification }),
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
    ...(sandbox === undefined ? {} : { sandbox }),
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

function resumeWorkflowRequest(harness: Harness, workflowId: string) {
  return call(harness, 'POST', `/v1/workflows/${workflowId}/resume`, { token: FOUNDER_TOKEN });
}

function resumeTaskRequest(harness: Harness, taskId: string) {
  return call(harness, 'POST', `/v1/tasks/${taskId}/resume`, { token: FOUNDER_TOKEN });
}

function retryTaskRequest(harness: Harness, taskId: string) {
  return call(harness, 'POST', `/v1/tasks/${taskId}/retry`, { token: FOUNDER_TOKEN });
}

function taskAttemptsRequest(harness: Harness, taskId: string) {
  return call(harness, 'GET', `/v1/tasks/${taskId}/attempts`, { token: FOUNDER_TOKEN });
}

function workflowAttemptsRequest(harness: Harness, workflowId: string) {
  return call(harness, 'GET', `/v1/workflows/${workflowId}/attempts`, { token: FOUNDER_TOKEN });
}

function withoutActions(policy: AccessPolicy, removed: readonly AccessAction[]): AccessPolicy {
  return {
    policy_id: policy.policy_id,
    version: policy.version,
    rules: policy.rules.map((rule) => ({
      ...rule,
      actions: rule.actions.filter((action) => !removed.includes(action)),
    })).filter((rule) => rule.actions.length > 0),
  };
}

function suspendWorkflow(harness: Harness, workflowId: string): void {
  harness.runtime.workflowStore.transitionLifecycle(workflowId, 'validated', FOUNDER);
  harness.runtime.workflowStore.transitionLifecycle(workflowId, 'active', FOUNDER);
  harness.runtime.workflowStore.transitionLifecycle(workflowId, 'suspended', FOUNDER);
}

function suspendTask(harness: Harness, taskId: string): void {
  harness.runtime.taskStore.transitionTaskLifecycle(taskId, 'validated', FOUNDER);
  harness.runtime.taskStore.transitionTaskLifecycle(taskId, 'active', FOUNDER);
  harness.runtime.taskStore.transitionTaskLifecycle(taskId, 'suspended', FOUNDER);
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

  it('binds persisted verification evidence to the configured verifier across a reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-verifier-binding-'));
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'verified'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
      directory,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    expect((await dispatch(harness, workflow.entity_id)).status).toBe(200);

    const storedTask = harness.runtime.taskStore.getTask(task.entity_id);
    const evidencePath = `/v1/tasks/${task.entity_id}/evidence/${storedTask?.audit_trail_ref}`;
    const accepted = await call(harness, 'GET', evidencePath, { token: FOUNDER_TOKEN });
    expect(accepted.status).toBe(200);
    const artifact = accepted.body?.evidence as Record<string, unknown>;
    const description = JSON.parse(String(artifact.description)) as Record<string, unknown>;
    expect(description.verifier_id).toBe(VERIFIER_ID);
    expect(description.verifier_accepted).toBe(true);

    // Reopen with another verifier configured: the old record must not read as verified.
    await harness.server.close();
    harness.runtime.close();
    const swapped = await startHost({
      directory,
      verification: {
        verifier_id: randomUUID(),
        verify: async () => { throw new Error('A read must never invoke the verifier.'); },
      },
    });
    const rejected = await call(swapped, 'GET', evidencePath, { token: FOUNDER_TOKEN });
    expect(rejected.status).toBe(409);
    expect(rejected.body?.error).toBe('orchestration_rejected');
    expect(String(rejected.body?.message)).toMatch(/verifier identity/);

    // Reopening with the original verifier restores the same durable record unchanged.
    await swapped.server.close();
    swapped.runtime.close();
    const rematched = await startHost({ directory, withAdapters: true });
    const reread = await call(rematched, 'GET', evidencePath, { token: FOUNDER_TOKEN });
    expect(reread.status).toBe(200);
    const rereadArtifact = reread.body?.evidence as Record<string, unknown>;
    expect(rereadArtifact.entity_id).toBe(storedTask?.audit_trail_ref);
    expect(rereadArtifact.description).toBe(artifact.description);
  });

  it('rejects persisted evidence with no verifier identity and records no completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-unattributed-evidence-'));
    const task = makeTask();
    const harness = await startHost({
      policy: makePolicy(task.entity_id, randomUUID()),
      directory,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);

    const now = new Date().toISOString();
    const forged = harness.runtime.artifactStore.create(ArtifactEntity.parse({
      entity_id: randomUUID(),
      entity_type: 'canonical_object',
      entity_subtype: 'artifact',
      artifact_kind: 'test_report',
      name: 'Unattributed execution evidence',
      description: JSON.stringify({
        task_id: task.entity_id,
        agent_ids: [AGENT_ID],
        summary: 'forged',
        evidence: ['forged'],
        verifier_accepted: true,
        verifier_reason: 'forged',
        verifier_evidence: ['forged'],
        recorded_at: now,
      }),
      lifecycle_state: 'created',
      lifecycle_history: [],
      created_at: now,
      created_by: AGENT_ID,
      modified_at: now,
      version: 1,
      organizational_containers: [],
      owner_id: AGENT_ID,
      owner_type: 'agent',
      relationships: [],
    }));
    harness.runtime.artifactStore.transitionLifecycle(forged.entity_id, 'validated', AGENT_ID);
    harness.runtime.artifactStore.transitionLifecycle(forged.entity_id, 'active', AGENT_ID);
    harness.runtime.artifactStore.transitionLifecycle(forged.entity_id, 'completed', AGENT_ID);
    harness.runtime.taskStore.updateTask(task.entity_id, { audit_trail_ref: forged.entity_id });

    await harness.server.close();
    harness.runtime.close();
    const reopened = await startHost({ directory, withAdapters: true });
    const read = await call(
      reopened,
      'GET',
      `/v1/tasks/${task.entity_id}/evidence/${forged.entity_id}`,
      { token: FOUNDER_TOKEN },
    );
    expect(read.status).toBe(409);
    expect(read.body?.error).toBe('orchestration_rejected');
    expect(String(read.body?.message)).toMatch(/verifier identity/);
    expect(reopened.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('created');
    expect(reopened.runtime.taskStore.getTask(task.entity_id)?.audit_trail_ref).toBe(forged.entity_id);
  });

  it('dispatches through the real fixed executor and independent verifier adapters', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'composed'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });

    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    const dispatched = await dispatch(harness, workflow.entity_id);
    expect(dispatched.status).toBe(200);
    expect(dispatched.body?.lifecycle_state).toBe('completed');
    expect(harness.sandbox?.calls).toHaveLength(2);
    expect(harness.sandbox?.calls[0]?.argv).toEqual(['/bin/echo', 'composed']);
    expect(harness.sandbox?.calls[1]?.argv).toEqual(['/bin/true']);
    expect(harness.sandbox?.calls[1]?.workspaceDirectory).toBe(harness.sandbox?.calls[0]?.workspaceDirectory);

    const stored = harness.runtime.taskStore.getTask(task.entity_id);
    expect(stored?.lifecycle_state).toBe('completed');
    expect(stored?.audit_trail_ref).toBeTruthy();
  });

  it('lists only the Tasks and Workflows the authenticated principal may read', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const founderTasks = await call(harness, 'GET', '/v1/tasks', { token: FOUNDER_TOKEN });
    expect(founderTasks.status).toBe(200);
    expect(founderTasks.body).toMatchObject({ total: 1 });
    expect((founderTasks.body?.tasks as Array<Record<string, unknown>>)[0]?.entity_id).toBe(task.entity_id);

    const agentTasks = await call(harness, 'GET', '/v1/tasks', { token: AGENT_TOKEN });
    expect(agentTasks.status).toBe(200);
    expect(agentTasks.body).toEqual({ tasks: [], total: 0 });

    const founderWorkflows = await call(harness, 'GET', '/v1/workflows', { token: FOUNDER_TOKEN });
    expect(founderWorkflows.status).toBe(200);
    expect(founderWorkflows.body).toMatchObject({ total: 1 });
    const agentWorkflows = await call(harness, 'GET', '/v1/workflows', { token: AGENT_TOKEN });
    expect(agentWorkflows.body).toEqual({ workflows: [], total: 0 });

    expect((await call(harness, 'GET', '/v1/tasks?limit=0', { token: FOUNDER_TOKEN })).status).toBe(400);
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

  it('restricts authorization-audit reads to the bootstrap principal with an exact grant', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });
    const denied = await call(harness, 'GET', '/v1/audit/authorization', { token: AGENT_TOKEN });
    expect(denied.status).toBe(403);
    expect(denied.body?.error).toBe('bootstrap_principal_required');

    const allowed = await call(harness, 'GET', '/v1/audit/authorization', { token: FOUNDER_TOKEN });
    expect(allowed.status).toBe(200);
    expect(allowed.body?.total).toBeGreaterThan(0);
    const records = allowed.body?.records as Array<Record<string, unknown>>;
    expect(records).toContainEqual(expect.objectContaining({
      actor_id: FOUNDER,
      action: 'read_evidence',
      resource_id: DECISION_COLLECTION_ID,
      decision: 'allow',
      reason: 'matching_allow',
      matched_rule_effect: 'allow',
    }));
    expect(JSON.stringify(records)).not.toContain(FOUNDER_TOKEN);

    expect((await call(harness, 'GET', '/v1/audit/authorization?limit=0', { token: FOUNDER_TOKEN })).status).toBe(400);
    expect((await call(harness, 'GET', '/v1/audit/policies', { token: FOUNDER_TOKEN })).status).toBe(200);
  });

  it('denies authorization-audit reads without the exact read_evidence grant', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);

    const noPolicy = await startHost();
    const noPolicyDenied = await call(noPolicy, 'GET', '/v1/audit/authorization', { token: FOUNDER_TOKEN });
    expect(noPolicyDenied.status).toBe(403);
    expect(noPolicy.runtime.authorizationAudit.list()).toContainEqual(expect.objectContaining({
      request_id: noPolicyDenied.headers.get('x-request-id'),
      actor_id: FOUNDER,
      action: 'read_evidence',
      resource_id: DECISION_COLLECTION_ID,
      decision: 'deny',
      reason: 'resource_policy_missing_or_invalid',
      matched_rule_index: null,
      matched_rule_effect: null,
    }));

    const narrowed = await startHost({
      policy: withoutActions(makePolicy(task.entity_id, workflow.entity_id), ['read_evidence']),
    });
    const denied = await call(narrowed, 'GET', '/v1/audit/authorization', { token: FOUNDER_TOKEN });
    expect(denied.status).toBe(403);
    expect(denied.body?.error).toBe('forbidden');
    expect(narrowed.runtime.authorizationAudit.list()).toContainEqual(expect.objectContaining({
      request_id: denied.headers.get('x-request-id'),
      actor_id: FOUNDER,
      action: 'read_evidence',
      resource_id: DECISION_COLLECTION_ID,
      decision: 'deny',
      reason: 'no_matching_allow',
      matched_rule_index: null,
      matched_rule_effect: null,
    }));
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
      expect(registry.listPolicyAudit().length).toBeGreaterThan(0);
    } finally {
      registry.close();
    }

    const audit = new DurableAuthorizationAuditStore({
      directory: harness.runtime.config.operational_store.directory,
    });
    try {
      expect(audit.list().length).toBeGreaterThan(0);
      expect(audit.list().map((record) => record.decision)).toContain('allow');
    } finally {
      audit.close();
    }
  });

  it('keeps authorization decisions readable, ordered, and correlated across a host restart', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withAdapters: true,
    });
    const intakeResponse = await intake(harness, 'task', task);
    expect(intakeResponse.status).toBe(201);
    const requestId = intakeResponse.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    expect((await dispatch(harness, workflow.entity_id)).status).toBe(200);

    const before = harness.runtime.authorizationAudit.list();
    expect(before.length).toBeGreaterThan(0);
    expect(before).toContainEqual(expect.objectContaining({
      request_id: requestId,
      actor_id: FOUNDER,
      action: 'intake',
      decision: 'allow',
      reason: 'matching_allow',
      matched_rule_effect: 'allow',
    }));
    expect(JSON.stringify(before)).not.toContain(FOUNDER_TOKEN);

    await harness.server.close();
    harness.runtime.close();

    const restarted = createHostRuntime({ config: loadHostConfig(harness.configPath) });
    const server = createHostServer(restarted);
    const address = await server.listen();
    cleanups.push(async () => {
      await server.close();
      restarted.close();
    });
    const audit = await call(
      { ...harness, baseUrl: `http://${address.host}:${address.port}` },
      'GET',
      '/v1/audit/authorization?limit=500',
      { token: FOUNDER_TOKEN },
    );
    expect(audit.status).toBe(200);
    const records = audit.body?.records as Array<Record<string, unknown>>;
    expect(records.slice(0, before.length)).toEqual(before);
    expect(records.length).toBeGreaterThan(before.length);
  });

  it('cancels an executing Task, kills its sandbox invocation, and skips the verifier', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'cancel me'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const held = harness.sandbox?.holdNextRun();
    expect(held).toBeDefined();
    const running = dispatch(harness, workflow.entity_id);
    await held?.started;
    expect(harness.runtime.executions.getForTask(task.entity_id)?.state).toBe('running');

    const cancelled = await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'operator requested cancellation' },
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toMatchObject({ task_id: task.entity_id, state: 'cancelled' });
    expect(harness.sandbox?.aborted).toBe(true);

    const dispatchResult = await running;
    expect(dispatchResult.status).toBe(409);
    expect(dispatchResult.body?.error).toBe('task_cancelled');
    // The verifier never ran: exactly one sandbox call, the cancelled execution.
    expect(harness.sandbox?.calls).toHaveLength(1);
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      state: 'cancelled',
      reason_code: 'cancelled_by_request',
    });
    expect(harness.runtime.executions.getForTask(task.entity_id)?.finished_at).toBeTruthy();
    expect(harness.runtime.runs.list().find((run) => run.workflow_id === workflow.entity_id)?.state)
      .toBe('cancelled');
    expect(JSON.stringify(harness.runtime.executions.getForTask(task.entity_id)))
      .not.toContain('operator requested cancellation');

    const repeated = await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body?.already_cancelled).toBe(true);

    const audit = await call(harness, 'GET', '/v1/audit/authorization?limit=500', { token: FOUNDER_TOKEN });
    expect(audit.status).toBe(200);
    expect(audit.body?.records).toContainEqual(expect.objectContaining({
      actor_id: FOUNDER,
      action: 'cancel',
      decision: 'allow',
      resource_id: task.entity_id,
    }));
  });

  it('cancels a queued Task and prevents it from ever executing', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'must not run'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const cancelled = await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'cancel while queued' },
    });
    expect(cancelled.status).toBe(202);
    expect(harness.runtime.executions.getForTask(task.entity_id)?.state).toBe('cancelled');

    const deniedExecution = await dispatch(harness, workflow.entity_id);
    expect(deniedExecution.status).toBe(409);
    expect(deniedExecution.body?.error).toBe('task_cancelled');
    expect(harness.sandbox?.calls).toHaveLength(0);
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('created');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('created');
  });

  it('requires explicit cancel authorization and records no cancellation when denied', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id, { intakeOnly: true }),
      withAdapters: true,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const denied = await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'not granted' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body?.error).toBe('forbidden');
    expect(harness.runtime.executions.getForTask(task.entity_id)).toBeUndefined();
  });

  it('rejects a dispatch beyond the configured concurrency cap without starting it', async () => {
    const firstTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'first'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const secondTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'second'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const firstWorkflow = makeWorkflow([firstTask.entity_id]);
    const secondWorkflow = makeWorkflow([secondTask.entity_id]);
    const firstPolicy = makePolicy(firstTask.entity_id, firstWorkflow.entity_id);
    const secondPolicy = makePolicy(secondTask.entity_id, secondWorkflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [...firstPolicy.rules, ...secondPolicy.rules],
    };
    const harness = await startHost({
      policy,
      withLocalAdapters: true,
      maxConcurrentTasks: 1,
    });
    for (const item of [firstTask, secondTask]) {
      expect((await intake(harness, 'task', item)).status).toBe(201);
    }
    expect((await intake(harness, 'workflow', firstWorkflow)).status).toBe(201);
    expect((await intake(harness, 'workflow', secondWorkflow)).status).toBe(201);

    const held = harness.sandbox?.holdNextRun();
    expect(held).toBeDefined();
    const active = dispatch(harness, firstWorkflow.entity_id);
    await held?.started;

    const rejected = await dispatch(harness, secondWorkflow.entity_id);
    expect(rejected.status).toBe(429);
    expect(rejected.body?.error).toBe('execution_capacity_exceeded');
    expect(harness.sandbox?.calls).toHaveLength(1);
    // The kernel rejected before its first lifecycle write, so the Workflow remains
    // retryable instead of being left active or suspended with no execution.
    expect(harness.runtime.workflowStore.get(secondWorkflow.entity_id)?.lifecycle_state).toBe('created');
    expect(harness.runtime.taskStore.getTask(secondTask.entity_id)?.lifecycle_state).toBe('created');

    held?.release();
    expect((await active).status).toBe(200);
    const retried = await dispatch(harness, secondWorkflow.entity_id, 'capacity-retry-0001');
    expect(retried.status).toBe(200);
    expect(retried.body?.lifecycle_state).toBe('completed');
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
    const started = first.runtime.runs.start({
      workflow_id: workflow.entity_id,
      actor_id: FOUNDER,
      idempotency_key: 'interrupted-dispatch-0001',
    });
    first.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });

    // Simulate a host crash: run and Task execution are journaled as running, then the
    // process stops without completing either.
    await first.server.close();
    first.runtime.close();

    const second = await startHost({ directory });
    expect(second.runtime.recoveredWorkflows).toEqual([workflow.entity_id]);
    expect(second.runtime.recoveredExecutions).toHaveLength(1);
    expect(second.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    expect(second.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(second.runtime.runs.get(started.run.run_id)?.state).toBe('interrupted');
    expect(second.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      state: 'interrupted',
      reason_code: 'host_restarted',
    });
    expect(second.runtime.executions.list()).toHaveLength(1);

    const read = await call(second, 'GET', `/v1/tasks/${task.entity_id}`, { token: FOUNDER_TOKEN });
    expect(read.status).toBe(200);
    expect((read.body?.task as Record<string, unknown>).lifecycle_state).toBe('suspended');

    const health = await call(second, 'GET', '/health');
    expect(health.body?.storage).toBe('durable');
    expect(health.body?.recovered_workflows).toBe(1);
    expect(health.body?.recovered_executions).toBe(1);

    // A second fresh start sees only terminal records: reconciliation is a no-op and does
    // not duplicate the terminal transition or create another execution.
    await second.server.close();
    second.runtime.close();
    const third = await startHost({ directory });
    expect(third.runtime.recoveredWorkflows).toEqual([]);
    expect(third.runtime.recoveredExecutions).toEqual([]);
    expect(third.runtime.executions.getForTask(task.entity_id)?.state).toBe('interrupted');
    expect(third.runtime.executions.list()).toHaveLength(1);
  });

  it('resumes a crash-interrupted Workflow with a distinct attempt and no third attempt on repeat', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-resume-'));
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'resumed'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const ownedTask = { ...task, assigned_workflow: workflow.entity_id } as TaskEntity;

    const first = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
      directory,
    });
    expect((await intake(first, 'task', ownedTask)).status).toBe(201);
    expect((await intake(first, 'workflow', workflow)).status).toBe(201);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'active', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'validated', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'active', FOUNDER);
    const crashed = first.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });

    // Crash: the execution is journaled as running and the process stops without completing.
    await first.server.close();
    first.runtime.close();

    const second = await startHost({ directory, withLocalAdapters: true });
    expect(second.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      execution_id: crashed.execution_id,
      state: 'interrupted',
      reason_code: 'host_restarted',
      attempt: 1,
      attempt_kind: 'initial',
    });
    expect(second.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');

    const resumed = await resumeWorkflowRequest(second, workflow.entity_id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      workflow_id: workflow.entity_id,
      lifecycle_state: 'completed',
      resumed: true,
    });
    const summaries = resumed.body?.attempts as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      task_id: task.entity_id,
      attempt: 2,
      attempt_kind: 'resume',
      state: 'completed',
    });
    expect(summaries[0]?.execution_id).not.toBe(crashed.execution_id);

    const attempts = second.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(2);
    // The interrupted record is immutable history; the resumed attempt chains to it.
    expect(attempts[0]).toMatchObject({
      execution_id: crashed.execution_id,
      state: 'interrupted',
      attempt: 1,
      attempt_kind: 'initial',
    });
    expect(attempts[1]).toMatchObject({
      state: 'completed',
      attempt: 2,
      attempt_kind: 'resume',
      previous_execution_id: crashed.execution_id,
    });
    expect(second.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('completed');
    // The resumed command and its independent verifier ran; the interrupted attempt never did.
    expect(second.sandbox?.calls).toHaveLength(2);

    // Repeating the authorized resume is an idempotent no-op, not a third attempt.
    const repeated = await resumeWorkflowRequest(second, workflow.entity_id);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ resumed: false, lifecycle_state: 'completed' });
    expect(second.runtime.executions.listForTask(task.entity_id)).toHaveLength(2);
  });

  it('refuses to resume a cancelled execution while an authorized retry starts a distinct attempt', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'retried'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const held = harness.sandbox?.holdNextRun();
    const running = dispatch(harness, workflow.entity_id);
    await held?.started;
    expect((await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'operator cancelled the attempt' },
    })).status).toBe(202);
    expect((await running).status).toBe(409);

    const cancelled = harness.runtime.executions.getForTask(task.entity_id);
    expect(cancelled).toMatchObject({ state: 'cancelled', attempt: 1, attempt_kind: 'initial' });

    // A resume must not reopen a cancellation; the terminal record is not erased.
    const refused = await resumeTaskRequest(harness, task.entity_id);
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toBe('execution_conflict');
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(1);
    expect(harness.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      execution_id: cancelled?.execution_id,
      state: 'cancelled',
    });

    const retried = await retryTaskRequest(harness, task.entity_id);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ task_id: task.entity_id, retried: true, lifecycle_state: 'completed' });
    expect(retried.body?.execution).toMatchObject({ attempt: 2, attempt_kind: 'retry', state: 'completed' });

    const attempts = harness.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      execution_id: cancelled?.execution_id,
      state: 'cancelled',
      attempt: 1,
      attempt_kind: 'initial',
    });
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      attempt_kind: 'retry',
      state: 'completed',
      previous_execution_id: cancelled?.execution_id,
    });
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('completed');
    // A Task-level retry leaves its Workflow suspended for an explicit Workflow resume.
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    // One cancelled invocation plus the retried command and its verifier.
    expect(harness.sandbox?.calls).toHaveLength(3);

    const repeated = await retryTaskRequest(harness, task.entity_id);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ retried: false, lifecycle_state: 'completed' });
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(2);
  });

  it('retries a failed execution, then resumes the Workflow without re-running completed work', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/false'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    // The labelled test double does not execute argv, so its result is set explicitly.
    if (harness.sandbox) harness.sandbox.result = { exitCode: 1 };
    const failed = await dispatch(harness, workflow.entity_id);
    expect(failed.status).toBe(422);
    expect(harness.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      state: 'failed',
      attempt: 1,
      attempt_kind: 'initial',
    });
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');

    // A Workflow resume is blocked by a failed sibling and never silently retries it.
    const blocked = await resumeWorkflowRequest(harness, workflow.entity_id);
    expect(blocked.status).toBe(409);
    expect(blocked.body?.error).toBe('execution_conflict');
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(1);
    expect(harness.sandbox?.calls).toHaveLength(1);

    // Repair the command and deliberately retry only the Task.
    if (harness.sandbox) harness.sandbox.result = {};
    harness.runtime.taskStore.updateTask(task.entity_id, {
      execution: { kind: 'local_command', argv: ['/bin/echo', 'repaired'] },
    });
    const retried = await retryTaskRequest(harness, task.entity_id);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ retried: true, lifecycle_state: 'completed' });
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    const attempts = harness.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: 'failed', attempt: 1, attempt_kind: 'initial' });
    expect(attempts[1]).toMatchObject({
      state: 'completed',
      attempt: 2,
      attempt_kind: 'retry',
      previous_execution_id: attempts[0]?.execution_id,
    });

    const callsBeforeResume = harness.sandbox?.calls.length ?? 0;
    const resumed = await resumeWorkflowRequest(harness, workflow.entity_id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ resumed: true, lifecycle_state: 'completed', attempts: [] });
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('completed');
    expect(harness.sandbox?.calls).toHaveLength(callsBeforeResume);
  });

  it('requires explicit resume and retry authorization before lookup and writes nothing when denied', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/false'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const policy = withoutActions(
      makePolicy(task.entity_id, workflow.entity_id),
      ['resume', 'retry'],
    );
    const harness = await startHost({ policy, withLocalAdapters: true });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    if (harness.sandbox) harness.sandbox.result = { exitCode: 1 };
    expect((await dispatch(harness, workflow.entity_id)).status).toBe(422);

    const taskState = harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state;
    const workflowState = harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state;
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(1);

    for (const denied of [
      await resumeWorkflowRequest(harness, workflow.entity_id),
      await resumeTaskRequest(harness, task.entity_id),
      await retryTaskRequest(harness, task.entity_id),
    ]) {
      expect(denied.status).toBe(403);
      expect(denied.body?.error).toBe('forbidden');
    }

    // An unknown identifier is denied identically: authorization precedes resource lookup.
    const unknown = randomUUID();
    for (const denied of [
      await resumeWorkflowRequest(harness, unknown),
      await resumeTaskRequest(harness, unknown),
      await retryTaskRequest(harness, unknown),
    ]) {
      expect(denied.status).toBe(403);
    }

    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe(taskState);
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe(workflowState);
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(1);
    expect(harness.sandbox?.calls).toHaveLength(1);
  });

  it('requires the Agent execute grant for a retried attempt', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'granted?'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const full = makePolicy(task.entity_id, workflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: full.policy_id,
      version: full.version,
      rules: full.rules
        .map((rule) => (rule.subject_ids.includes(AGENT_ID)
          ? { ...rule, actions: rule.actions.filter((action) => action !== 'execute') }
          : rule))
        .filter((rule) => rule.actions.length > 0),
    };
    const harness = await startHost({ policy, withLocalAdapters: true });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'cancel while queued' },
    })).status).toBe(202);

    const denied = await retryTaskRequest(harness, task.entity_id);
    expect(denied.status).toBe(403);
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(1);
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('created');
    expect(harness.sandbox?.calls).toHaveLength(0);
  });

  it('enforces the concurrency cap on a later-generation resume before any lifecycle or attempt write', async () => {
    const firstTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'first'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const secondTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'second'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const firstWorkflow = makeWorkflow([firstTask.entity_id]);
    const secondWorkflow = makeWorkflow([secondTask.entity_id]);
    const firstPolicy = makePolicy(firstTask.entity_id, firstWorkflow.entity_id);
    const secondPolicy = makePolicy(secondTask.entity_id, secondWorkflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [...firstPolicy.rules, ...secondPolicy.rules],
    };
    const harness = await startHost({ policy, withLocalAdapters: true, maxConcurrentTasks: 1 });
    for (const item of [firstTask, secondTask]) {
      expect((await intake(harness, 'task', item)).status).toBe(201);
    }
    for (const item of [firstWorkflow, secondWorkflow]) {
      expect((await intake(harness, 'workflow', item)).status).toBe(201);
    }

    // Prepare a crash-interrupted attempt on the first Workflow/Task pair.
    const ownedTask = harness.runtime.taskStore.updateTask(firstTask.entity_id, {
      assigned_workflow: firstWorkflow.entity_id,
    });
    expect(ownedTask.assigned_workflow).toBe(firstWorkflow.entity_id);
    suspendTask(harness, firstTask.entity_id);
    suspendWorkflow(harness, firstWorkflow.entity_id);
    const interrupted = harness.runtime.executions.start({
      task_id: firstTask.entity_id,
      workflow_id: firstWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();
    // Generation 2 was itself interrupted by a second crash before the cap is tested.
    const secondGeneration = harness.runtime.executions.resume({
      task_id: firstTask.entity_id,
      workflow_id: firstWorkflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: interrupted.execution_id,
    });
    harness.runtime.executions.reconcile();
    expect(harness.runtime.executions.getForTask(firstTask.entity_id)).toMatchObject({
      execution_id: secondGeneration.execution_id,
      state: 'interrupted',
      attempt: 2,
      attempt_kind: 'resume',
      previous_execution_id: interrupted.execution_id,
    });
    const secondGenerationRevision = secondGeneration.revision + 1;

    const held = harness.sandbox?.holdNextRun();
    const active = dispatch(harness, secondWorkflow.entity_id);
    await held?.started;

    const rejected = await resumeWorkflowRequest(harness, firstWorkflow.entity_id);
    expect(rejected.status).toBe(429);
    expect(rejected.body?.error).toBe('execution_capacity_exceeded');
    expect(harness.runtime.workflowStore.get(firstWorkflow.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.taskStore.getTask(firstTask.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.executions.listForTask(firstTask.entity_id)).toHaveLength(2);
    expect(harness.runtime.executions.getForTask(firstTask.entity_id)).toMatchObject({
      execution_id: secondGeneration.execution_id,
      state: 'interrupted',
      attempt: 2,
      revision: secondGenerationRevision,
    });
    expect(harness.sandbox?.calls).toHaveLength(1);

    held?.release();
    expect((await active).status).toBe(200);

    const resumed = await resumeWorkflowRequest(harness, firstWorkflow.entity_id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ resumed: true, lifecycle_state: 'completed' });
    const attempts = harness.runtime.executions.listForTask(firstTask.entity_id);
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({
      execution_id: interrupted.execution_id,
      state: 'interrupted',
      attempt: 1,
    });
    expect(attempts[1]).toMatchObject({
      execution_id: secondGeneration.execution_id,
      state: 'interrupted',
      attempt: 2,
      attempt_kind: 'resume',
      revision: secondGenerationRevision,
    });
    expect(attempts[2]).toMatchObject({
      state: 'completed',
      attempt: 3,
      attempt_kind: 'resume',
      previous_execution_id: secondGeneration.execution_id,
    });
  });

  it('cancels a resumed attempt, kills its sandbox, and cannot be overwritten by a late result', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'resume then cancel'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', { ...task, assigned_workflow: workflow.entity_id } as TaskEntity)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    suspendTask(harness, task.entity_id);
    suspendWorkflow(harness, workflow.entity_id);
    const interrupted = harness.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const held = harness.sandbox?.holdNextRun();
    const resumed = resumeWorkflowRequest(harness, workflow.entity_id);
    await held?.started;
    expect(harness.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      state: 'running',
      attempt: 2,
      attempt_kind: 'resume',
    });

    const cancelled = await call(harness, 'POST', `/v1/tasks/${task.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'cancel the resumed attempt' },
    });
    expect(cancelled.status).toBe(202);
    expect(harness.sandbox?.aborted).toBe(true);
    const result = await resumed;
    expect(result.status).toBe(409);
    expect(result.body?.error).toBe('task_cancelled');

    const attempts = harness.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      execution_id: interrupted.execution_id,
      state: 'interrupted',
      attempt: 1,
    });
    expect(attempts[1]).toMatchObject({ state: 'cancelled', attempt: 2, attempt_kind: 'resume' });
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');
    // Only the resumed execution reached the sandbox and it was aborted; the verifier never ran.
    expect(harness.sandbox?.calls).toHaveLength(1);

    // A subsequent resume is refused; the cancelled attempt is never reopened in place.
    const refused = await resumeTaskRequest(harness, task.entity_id);
    expect(refused.status).toBe(409);
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(2);

    // An explicit retry appends generation 3 and leaves generations 1 and 2 byte-for-byte
    // unchanged in the durable history.
    const retried = await retryTaskRequest(harness, task.entity_id);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      task_id: task.entity_id,
      lifecycle_state: 'completed',
      retried: true,
    });
    expect(retried.body?.execution).toMatchObject({
      attempt: 3,
      attempt_kind: 'retry',
      state: 'completed',
    });
    const afterRetry = harness.runtime.executions.listForTask(task.entity_id);
    expect(afterRetry).toHaveLength(3);
    expect(afterRetry.map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'cancelled'],
      [3, 'retry', 'completed'],
    ]);
    expect(afterRetry[0]).toEqual(attempts[0]);
    expect(afterRetry[1]).toEqual(attempts[1]);
    expect(afterRetry[1]?.previous_execution_id).toBe(interrupted.execution_id);
    expect(afterRetry[2]?.previous_execution_id).toBe(attempts[1]?.execution_id);
    expect(harness.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('completed');
    expect(harness.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');

    // The Workflow resume now skips the completed Task and finishes without another run.
    const workflowResumed = await resumeWorkflowRequest(harness, workflow.entity_id);
    expect(workflowResumed.status).toBe(200);
    expect(workflowResumed.body).toMatchObject({
      resumed: true,
      lifecycle_state: 'completed',
      attempts: [],
    });
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(3);
    expect(harness.sandbox?.calls).toHaveLength(3);
  });

  it('resumes a persisted three-generation chain across crashes without mutating predecessors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-multigen-'));
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'third generation'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const ownedTask = { ...task, assigned_workflow: workflow.entity_id } as TaskEntity;

    const first = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
      directory,
    });
    expect((await intake(first, 'task', ownedTask)).status).toBe(201);
    expect((await intake(first, 'workflow', workflow)).status).toBe(201);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'validated', FOUNDER);
    first.runtime.taskStore.transitionTaskLifecycle(task.entity_id, 'active', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'validated', FOUNDER);
    first.runtime.workflowStore.transitionLifecycle(workflow.entity_id, 'active', FOUNDER);
    const attempt1 = first.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    await first.server.close();
    first.runtime.close();

    // First restart: reconciliation interrupts generation 1. Generation 2 is started through
    // the same persisted resume operation the kernel uses, then the host crashes again.
    const second = await startHost({ directory, withLocalAdapters: true });
    expect(second.runtime.executions.getForTask(task.entity_id)).toMatchObject({
      execution_id: attempt1.execution_id,
      state: 'interrupted',
      attempt: 1,
      attempt_kind: 'initial',
    });
    const attempt2 = second.runtime.executions.resume({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: attempt1.execution_id,
    });
    expect(attempt2).toMatchObject({
      state: 'running',
      attempt: 2,
      attempt_kind: 'resume',
      previous_execution_id: attempt1.execution_id,
    });
    second.runtime.executions.reconcile();
    const beforeThirdStart = second.runtime.executions.listForTask(task.entity_id);
    expect(beforeThirdStart.map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
    ]);
    await second.server.close();
    second.runtime.close();

    // Second restart over an already-interrupted latest attempt: reconciliation creates no
    // new attempt and cannot rewrite either predecessor.
    const third = await startHost({ directory, withLocalAdapters: true });
    expect(third.runtime.recoveredExecutions).toEqual([]);
    expect(third.runtime.executions.listForTask(task.entity_id)).toEqual(beforeThirdStart);
    expect(third.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('suspended');
    expect(third.runtime.workflowStore.get(workflow.entity_id)?.lifecycle_state).toBe('suspended');

    // The authorized Workflow resume drives generation 3 to completion.
    const resumed = await resumeWorkflowRequest(third, workflow.entity_id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ resumed: true, lifecycle_state: 'completed' });
    const summaries = resumed.body?.attempts as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      task_id: task.entity_id,
      attempt: 3,
      attempt_kind: 'resume',
      state: 'completed',
    });

    const attempts = third.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
      [3, 'resume', 'completed'],
    ]);
    expect(attempts[1]?.previous_execution_id).toBe(attempt1.execution_id);
    expect(attempts[2]?.previous_execution_id).toBe(attempt2.execution_id);
    expect(attempts[0]).toEqual(beforeThirdStart[0]);
    expect(attempts[1]).toEqual(beforeThirdStart[1]);
    expect(third.runtime.taskStore.getTask(task.entity_id)?.lifecycle_state).toBe('completed');
    expect(third.sandbox?.calls).toHaveLength(2);
  });

  it('returns one typed conflict for a concurrent duplicate Workflow resume', async () => {
    const task = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'duplicate workflow resume'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      withLocalAdapters: true,
    });
    expect((await intake(harness, 'task', { ...task, assigned_workflow: workflow.entity_id } as TaskEntity)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);
    suspendTask(harness, task.entity_id);
    suspendWorkflow(harness, workflow.entity_id);
    const interrupted = harness.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const held = harness.sandbox?.holdNextRun();
    const first = resumeWorkflowRequest(harness, workflow.entity_id);
    await held?.started;
    const duplicate = await resumeWorkflowRequest(harness, workflow.entity_id);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body?.error).toBe('execution_conflict');
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(2);
    expect(harness.sandbox?.calls).toHaveLength(1);

    held?.release();
    expect((await first).status).toBe(200);
    const attempts = harness.runtime.executions.listForTask(task.entity_id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ execution_id: interrupted.execution_id, attempt: 1, state: 'interrupted' });
    expect(attempts[1]).toMatchObject({ attempt: 2, attempt_kind: 'resume', state: 'completed' });

    const repeated = await resumeWorkflowRequest(harness, workflow.entity_id);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ resumed: false, lifecycle_state: 'completed' });
    expect(harness.runtime.executions.listForTask(task.entity_id)).toHaveLength(2);
  });

  it('returns one typed conflict for concurrent duplicate Task resume and Task retry', async () => {
    const resumeTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'duplicate task resume'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const retryTask = makeTask({
      execution: { kind: 'local_command', argv: ['/bin/echo', 'duplicate task retry'] },
      verification: { kind: 'local_command', argv: ['/bin/true'] },
    });
    const resumeWorkflow = makeWorkflow([resumeTask.entity_id]);
    const retryWorkflow = makeWorkflow([retryTask.entity_id]);
    const resumePolicy = makePolicy(resumeTask.entity_id, resumeWorkflow.entity_id);
    const retryPolicy = makePolicy(retryTask.entity_id, retryWorkflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [...resumePolicy.rules, ...retryPolicy.rules],
    };
    const harness = await startHost({ policy, withLocalAdapters: true });
    expect((await intake(harness, 'task', {
      ...resumeTask,
      assigned_workflow: resumeWorkflow.entity_id,
    } as TaskEntity)).status).toBe(201);
    expect((await intake(harness, 'workflow', resumeWorkflow)).status).toBe(201);
    expect((await intake(harness, 'task', retryTask)).status).toBe(201);

    suspendTask(harness, resumeTask.entity_id);
    suspendWorkflow(harness, resumeWorkflow.entity_id);
    const interrupted = harness.runtime.executions.start({
      task_id: resumeTask.entity_id,
      workflow_id: resumeWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const resumeHeld = harness.sandbox?.holdNextRun();
    const firstResume = resumeTaskRequest(harness, resumeTask.entity_id);
    await resumeHeld?.started;
    const duplicateResume = await resumeTaskRequest(harness, resumeTask.entity_id);
    expect(duplicateResume.status).toBe(409);
    expect(duplicateResume.body?.error).toBe('execution_conflict');
    expect(harness.runtime.executions.listForTask(resumeTask.entity_id)).toHaveLength(2);
    expect(harness.sandbox?.calls).toHaveLength(1);
    resumeHeld?.release();
    expect((await firstResume).status).toBe(200);
    expect(harness.runtime.executions.listForTask(resumeTask.entity_id)).toHaveLength(2);
    expect(harness.runtime.executions.getForTask(resumeTask.entity_id)).toMatchObject({
      attempt: 2,
      attempt_kind: 'resume',
      state: 'completed',
      previous_execution_id: interrupted.execution_id,
    });

    // A queued Task is cancelled before it ever runs, then retried concurrently.
    expect((await call(harness, 'POST', `/v1/tasks/${retryTask.entity_id}/cancel`, {
      token: FOUNDER_TOKEN,
      body: { reason: 'cancel before the duplicate retry' },
    })).status).toBe(202);
    expect(harness.runtime.executions.listForTask(retryTask.entity_id)).toHaveLength(1);
    const retryHeld = harness.sandbox?.holdNextRun();
    const firstRetry = retryTaskRequest(harness, retryTask.entity_id);
    await retryHeld?.started;
    const duplicateRetry = await retryTaskRequest(harness, retryTask.entity_id);
    expect(duplicateRetry.status).toBe(409);
    expect(duplicateRetry.body?.error).toBe('execution_conflict');
    expect(harness.runtime.executions.listForTask(retryTask.entity_id)).toHaveLength(2);
    expect(harness.sandbox?.calls).toHaveLength(3);
    retryHeld?.release();
    expect((await firstRetry).status).toBe(200);
    const retryAttempts = harness.runtime.executions.listForTask(retryTask.entity_id);
    expect(retryAttempts).toHaveLength(2);
    expect(retryAttempts[1]).toMatchObject({ attempt: 2, attempt_kind: 'retry', state: 'completed' });

    const repeatedRetry = await retryTaskRequest(harness, retryTask.entity_id);
    expect(repeatedRetry.status).toBe(200);
    expect(repeatedRetry.body).toMatchObject({ retried: false, lifecycle_state: 'completed' });
    expect(harness.runtime.executions.listForTask(retryTask.entity_id)).toHaveLength(2);
  });

  it('inspects a three-generation attempt chain without mutating the durable journal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-attempt-history-'));
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({
      policy: makePolicy(task.entity_id, workflow.entity_id),
      directory,
    });
    expect((await intake(harness, 'task', {
      ...task,
      assigned_workflow: workflow.entity_id,
    } as TaskEntity)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const first = harness.runtime.executions.start({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();
    const second = harness.runtime.executions.resume({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: first.execution_id,
    });
    harness.runtime.executions.reconcile();
    const third = harness.runtime.executions.resume({
      task_id: task.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: second.execution_id,
    });
    harness.runtime.executions.complete(third.execution_id, [`result_sha256:${'a'.repeat(64)}`]);

    const journalPath = join(directory, 'operational', 'operational.jsonl');
    const journalBefore = readFileSync(journalPath);
    const journalHashBefore = createHash('sha256').update(journalBefore).digest('hex');
    const attemptsBefore = harness.runtime.executions.listForTask(task.entity_id);

    const read = await taskAttemptsRequest(harness, task.entity_id);
    expect(read.status).toBe(200);
    expect(read.body?.task_id).toBe(task.entity_id);
    const attempts = read.body?.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(3);
    expect(attempts.map((item) => [item.attempt, item.attempt_kind, item.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
      [3, 'resume', 'completed'],
    ]);
    expect(attempts.map((item) => item.execution_id)).toEqual([
      first.execution_id,
      second.execution_id,
      third.execution_id,
    ]);
    expect(attempts[0]?.previous_execution_id).toBeUndefined();
    expect(attempts[1]?.previous_execution_id).toBe(first.execution_id);
    expect(attempts[2]?.previous_execution_id).toBe(second.execution_id);
    expect(attempts.map((item) => item.predecessor_execution_ids)).toEqual([
      [],
      [first.execution_id],
      [first.execution_id, second.execution_id],
    ]);

    const workflowRead = await workflowAttemptsRequest(harness, workflow.entity_id);
    expect(workflowRead.status).toBe(200);
    expect(workflowRead.body).toEqual({
      workflow_id: workflow.entity_id,
      tasks: [{ task_id: task.entity_id, attempts }],
    });

    const journalAfter = readFileSync(journalPath);
    expect(journalAfter.equals(journalBefore)).toBe(true);
    expect(createHash('sha256').update(journalAfter).digest('hex')).toBe(journalHashBefore);
    expect(harness.runtime.executions.listForTask(task.entity_id)).toEqual(attemptsBefore);

    await harness.server.close();
    harness.runtime.close();
    const reopened = await startHost({ directory });
    expect(reopened.runtime.executions.listForTask(task.entity_id)).toEqual(attemptsBefore);
    expect(reopened.runtime.executions.listForTask(task.entity_id)
      .map((record) => [record.attempt, record.attempt_kind, record.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
      [3, 'resume', 'completed'],
    ]);
  });

  it('denies Workflow attempt inspection all-or-nothing when any step Task lacks read_status', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-attempt-all-or-nothing-'));
    const readable = makeTask();
    const restricted = makeTask();
    const laterWorkflow = makeWorkflow([readable.entity_id, restricted.entity_id]);
    const firstWorkflow = makeWorkflow([restricted.entity_id, readable.entity_id]);
    const base = makePolicy(readable.entity_id, laterWorkflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [
        ...base.rules,
        {
          effect: 'allow',
          subject_ids: [FOUNDER],
          actions: ['intake'],
          resource_ids: [restricted.entity_id, firstWorkflow.entity_id],
        },
      ],
    };
    const harness = await startHost({ policy, directory });
    expect((await intake(harness, 'task', readable)).status).toBe(201);
    expect((await intake(harness, 'task', restricted)).status).toBe(201);
    expect((await intake(harness, 'workflow', laterWorkflow)).status).toBe(201);
    expect((await intake(harness, 'workflow', firstWorkflow)).status).toBe(201);

    // Both Tasks carry real durable attempts, so a partial payload would be observable.
    const firstAttempt = harness.runtime.executions.start({
      task_id: readable.entity_id,
      workflow_id: laterWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();
    const secondAttempt = harness.runtime.executions.resume({
      task_id: readable.entity_id,
      workflow_id: laterWorkflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: firstAttempt.execution_id,
    });
    harness.runtime.executions.complete(secondAttempt.execution_id, [`result_sha256:${'c'.repeat(64)}`]);
    harness.runtime.executions.start({
      task_id: restricted.entity_id,
      workflow_id: laterWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const journalPath = join(directory, 'operational', 'operational.jsonl');
    const journalBefore = readFileSync(journalPath);
    const journalHashBefore = createHash('sha256').update(journalBefore).digest('hex');
    const readableAttempts = harness.runtime.executions.listForTask(readable.entity_id);
    const restrictedAttempts = harness.runtime.executions.listForTask(restricted.entity_id);
    expect(readableAttempts.map((record) => [record.attempt, record.state])).toEqual([
      [1, 'interrupted'],
      [2, 'completed'],
    ]);
    expect(restrictedAttempts).toHaveLength(1);

    // The ungranted step is first in one Workflow and later in the other; both deny whole.
    for (const workflowId of [laterWorkflow.entity_id, firstWorkflow.entity_id]) {
      const denied = await workflowAttemptsRequest(harness, workflowId);
      expect(denied.status).toBe(403);
      expect(denied.body?.error).toBe('forbidden');
      expect(denied.body).not.toHaveProperty('tasks');
      expect(denied.body).not.toHaveProperty('attempts');
      expect(JSON.stringify(denied.body)).not.toContain(readable.entity_id);
      expect(JSON.stringify(denied.body)).not.toContain('predecessor_execution_ids');
    }

    const journalAfter = readFileSync(journalPath);
    expect(journalAfter.equals(journalBefore)).toBe(true);
    expect(createHash('sha256').update(journalAfter).digest('hex')).toBe(journalHashBefore);
    expect(harness.runtime.executions.listForTask(readable.entity_id)).toEqual(readableAttempts);
    expect(harness.runtime.executions.listForTask(restricted.entity_id)).toEqual(restrictedAttempts);

    await harness.server.close();
    harness.runtime.close();
    const reopened = await startHost({ directory });
    expect(reopened.runtime.executions.listForTask(readable.entity_id)).toEqual(readableAttempts);
    expect(reopened.runtime.executions.listForTask(restricted.entity_id)).toEqual(restrictedAttempts);
  });

  it('returns every step Task history when the whole Workflow is authorized', async () => {
    const first = makeTask();
    const second = makeTask();
    const workflow = makeWorkflow([first.entity_id, second.entity_id]);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [
        {
          effect: 'allow',
          subject_ids: [FOUNDER],
          actions: ['intake', 'read_status'],
          resource_ids: [first.entity_id, second.entity_id, workflow.entity_id],
        },
      ],
    };
    const harness = await startHost({ policy });
    expect((await intake(harness, 'task', first)).status).toBe(201);
    expect((await intake(harness, 'task', second)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const firstInitial = harness.runtime.executions.start({
      task_id: first.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();
    const firstResume = harness.runtime.executions.resume({
      task_id: first.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: firstInitial.execution_id,
    });
    harness.runtime.executions.reconcile();
    const firstFinal = harness.runtime.executions.resume({
      task_id: first.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: firstResume.execution_id,
    });
    harness.runtime.executions.complete(firstFinal.execution_id, [`result_sha256:${'d'.repeat(64)}`]);
    harness.runtime.executions.start({
      task_id: second.entity_id,
      workflow_id: workflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const firstRead = await taskAttemptsRequest(harness, first.entity_id);
    const secondRead = await taskAttemptsRequest(harness, second.entity_id);
    expect(firstRead.status).toBe(200);
    expect(secondRead.status).toBe(200);
    const firstAttempts = firstRead.body?.attempts as Array<Record<string, unknown>>;
    expect(firstAttempts.map((item) => [item.attempt, item.attempt_kind, item.state])).toEqual([
      [1, 'initial', 'interrupted'],
      [2, 'resume', 'interrupted'],
      [3, 'resume', 'completed'],
    ]);
    expect(firstAttempts.map((item) => item.execution_id)).toEqual([
      firstInitial.execution_id,
      firstResume.execution_id,
      firstFinal.execution_id,
    ]);
    expect(firstAttempts.map((item) => item.predecessor_execution_ids)).toEqual([
      [],
      [firstInitial.execution_id],
      [firstInitial.execution_id, firstResume.execution_id],
    ]);

    const workflowRead = await workflowAttemptsRequest(harness, workflow.entity_id);
    expect(workflowRead.status).toBe(200);
    expect(workflowRead.body).toEqual({
      workflow_id: workflow.entity_id,
      tasks: [
        { task_id: first.entity_id, attempts: firstAttempts },
        { task_id: second.entity_id, attempts: secondRead.body?.attempts },
      ],
    });
  });

  it('inspects single-attempt and failed-then-retried histories', async () => {
    const singleTask = makeTask();
    const failedTask = makeTask();
    const singleWorkflow = makeWorkflow([singleTask.entity_id]);
    const failedWorkflow = makeWorkflow([failedTask.entity_id]);
    const singlePolicy = makePolicy(singleTask.entity_id, singleWorkflow.entity_id);
    const failedPolicy = makePolicy(failedTask.entity_id, failedWorkflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [...singlePolicy.rules, ...failedPolicy.rules],
    };
    const harness = await startHost({ policy });
    expect((await intake(harness, 'task', singleTask)).status).toBe(201);
    expect((await intake(harness, 'task', failedTask)).status).toBe(201);

    const singleAttempt = harness.runtime.executions.start({
      task_id: singleTask.entity_id,
      workflow_id: singleWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.reconcile();

    const failedAttempt = harness.runtime.executions.start({
      task_id: failedTask.entity_id,
      workflow_id: failedWorkflow.entity_id,
      agent_id: AGENT_ID,
    });
    harness.runtime.executions.fail(failedAttempt.execution_id, 'execution_failed');
    const retriedAttempt = harness.runtime.executions.retry({
      task_id: failedTask.entity_id,
      workflow_id: failedWorkflow.entity_id,
      agent_id: AGENT_ID,
      previous_execution_id: failedAttempt.execution_id,
    });
    harness.runtime.executions.complete(retriedAttempt.execution_id, [`result_sha256:${'b'.repeat(64)}`]);

    const singleRead = await taskAttemptsRequest(harness, singleTask.entity_id);
    expect(singleRead.status).toBe(200);
    const singleAttempts = singleRead.body?.attempts as Array<Record<string, unknown>>;
    expect(singleAttempts).toHaveLength(1);
    expect(singleAttempts[0]).toMatchObject({
      execution_id: singleAttempt.execution_id,
      attempt: 1,
      attempt_kind: 'initial',
      state: 'interrupted',
      predecessor_execution_ids: [],
    });
    expect(singleAttempts[0]?.previous_execution_id).toBeUndefined();

    const failedRead = await taskAttemptsRequest(harness, failedTask.entity_id);
    expect(failedRead.status).toBe(200);
    const failedAttempts = failedRead.body?.attempts as Array<Record<string, unknown>>;
    expect(failedAttempts).toHaveLength(2);
    expect(failedAttempts.map((item) => [item.attempt, item.attempt_kind, item.state])).toEqual([
      [1, 'initial', 'failed'],
      [2, 'retry', 'completed'],
    ]);
    expect(failedAttempts[0]?.predecessor_execution_ids).toEqual([]);
    expect(failedAttempts[1]?.previous_execution_id).toBe(failedAttempt.execution_id);
    expect(failedAttempts[1]?.predecessor_execution_ids).toEqual([failedAttempt.execution_id]);
  });

  it('reuses authentication, authorization, and not-found contracts for attempt inspection', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const unknownTaskId = randomUUID();
    const unknownWorkflowId = randomUUID();
    const base = makePolicy(task.entity_id, workflow.entity_id);
    const policy: AccessPolicy = {
      policy_id: base.policy_id,
      version: base.version,
      rules: [
        ...base.rules,
        {
          effect: 'allow',
          subject_ids: [FOUNDER],
          actions: ['read_status'],
          resource_ids: [unknownTaskId, unknownWorkflowId],
        },
      ],
    };
    const harness = await startHost({ policy });
    expect((await intake(harness, 'task', task)).status).toBe(201);
    expect((await intake(harness, 'workflow', workflow)).status).toBe(201);

    const unauthenticated = await call(harness, 'GET', `/v1/tasks/${task.entity_id}/attempts`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body?.error).toBe('unauthenticated');
    const unauthenticatedWorkflow = await call(harness, 'GET', `/v1/workflows/${workflow.entity_id}/attempts`);
    expect(unauthenticatedWorkflow.status).toBe(401);
    expect(unauthenticatedWorkflow.body?.error).toBe('unauthenticated');

    const unauthorized = await call(harness, 'GET', `/v1/tasks/${task.entity_id}/attempts`, {
      token: AGENT_TOKEN,
    });
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body?.error).toBe('forbidden');
    const unauthorizedWorkflow = await call(harness, 'GET', `/v1/workflows/${workflow.entity_id}/attempts`, {
      token: AGENT_TOKEN,
    });
    expect(unauthorizedWorkflow.status).toBe(403);
    expect(unauthorizedWorkflow.body?.error).toBe('forbidden');

    const unknownTask = await taskAttemptsRequest(harness, unknownTaskId);
    expect(unknownTask.status).toBe(404);
    expect(unknownTask.body?.error).toBe('not_found');
    const unknownWorkflow = await workflowAttemptsRequest(harness, unknownWorkflowId);
    expect(unknownWorkflow.status).toBe(404);
    expect(unknownWorkflow.body?.error).toBe('not_found');

    const empty = await taskAttemptsRequest(harness, task.entity_id);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ task_id: task.entity_id, attempts: [] });
  });
});

describe('permanent Memory approvals through the trusted host boundary', () => {
  it('requires an authorized human approval and leaves the stage at observation otherwise', async () => {
    const task = makeTask();
    const workflow = makeWorkflow([task.entity_id]);
    const harness = await startHost({ policy: makePolicy(task.entity_id, workflow.entity_id) });
    const learning = harness.runtime.learning;
    const id = await learning.recordObservation('Approval-gated finding', { value: 1 });

    await expect(learning.promote(id, 'published')).rejects.toThrow(/requires an explicit approval/);
    expect(learning.getKnowledge(id)?.stage).toBe('observation');

    const approval = await learning.requestPermanentPromotion(id, 'published', FOUNDER);
    // A human principal with no grant on the protected decision collection is denied.
    await expect(
      learning.decidePermanentPromotion(approval.approval_id, 'approved', 'human:intruder'),
    ).rejects.toThrow(/denied/);
    expect(learning.getMemoryApproval(approval.approval_id)?.status).toBe('pending');
    await expect(learning.promote(id, 'published', approval.approval_id))
      .rejects.toThrow(/pending/);
    expect(learning.getKnowledge(id)?.stage).toBe('observation');

    await learning.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER);
    await learning.promote(id, 'published', approval.approval_id);
    expect(learning.getKnowledge(id)?.stage).toBe('published');
    expect(learning.getMemoryApproval(approval.approval_id)?.status).toBe('consumed');
  });
});
