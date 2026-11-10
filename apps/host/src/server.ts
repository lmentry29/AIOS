import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FounderAuthorizationError, FounderInputError, PolicyPublicationError } from '@aios/founder';
import {
  ExecutionAttemptConflictError,
  ExecutionCapacityError,
  OrchestrationError,
  TaskCancelledError,
} from '@aios/orchestration';
import type { HostConfig } from './config.js';
import { HostExecutionError, HostHttpError, HostUnavailableError } from './errors.js';
import type { AuthenticatedSession } from './identity.js';
import { isHumanPrincipal } from './identity.js';
import { parseRuntimePolicyPublication } from './policy-admin.js';
import { ExecutionConflictError } from './persistence/execution-ledger.js';
import { DispatchConflictError, type StartedRun } from './persistence/operational-store.js';
import { withRequestId } from './request-context.js';
import type { HostRuntime } from './runtime.js';

const SERVICE = 'aios-host';
const VERSION = '0.1.0';
const JSON_TYPE = /^application\/json\s*(;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

interface RouteResponse {
  status: number;
  body: unknown;
}

interface RequestContext {
  runtime: HostRuntime;
  req: IncomingMessage;
  url: URL;
  session: AuthenticatedSession;
  readJson: () => Promise<Record<string, unknown> | undefined>;
}

type RouteHandler = (context: RequestContext, params: RegExpExecArray) => Promise<RouteResponse>;

interface Route {
  pattern: RegExp;
  allow: string[];
  public?: boolean;
  handle: RouteHandler;
}

function jsonBody(value: unknown): Record<string, unknown> {
  if (value === undefined) throw new HostHttpError(400, 'body_required', 'A JSON object body is required.');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostHttpError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireStringField(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HostHttpError(400, 'invalid_field', `Field "${field}" must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new HostHttpError(400, 'invalid_field', `Field "${field}" exceeds ${maxLength} characters.`);
  }
  return value;
}

function uuidParam(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new HostHttpError(400, 'invalid_identifier', `Path parameter "${name}" must be a UUID.`);
  }
  return value;
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (typeof host !== 'string') return false;
  return /^127\.0\.0\.1(:\d{1,5})?$/.test(host) || /^\[::1\](:\d{1,5})?$/.test(host);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !JSON_TYPE.test(contentType)) {
    throw new HostHttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && Number(declared) > limit) {
    throw new HostHttpError(413, 'payload_too_large', 'The request body exceeds the configured limit.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) {
      overflowed = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (overflowed) {
    throw new HostHttpError(413, 'payload_too_large', 'The request body exceeds the configured limit.');
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HostHttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function dispatchFailureCode(error: unknown): string {
  if (error instanceof TaskCancelledError) return 'task_cancelled';
  if (error instanceof ExecutionCapacityError) return 'execution_capacity_exceeded';
  if (error instanceof HostUnavailableError) return 'adapter_unavailable';
  if (error instanceof HostExecutionError) return 'execution_failed';
  if (error instanceof OrchestrationError) return 'orchestration_rejected';
  return 'dispatch_failed';
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HostHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof HostUnavailableError) {
    return { status: 503, code: 'adapter_unavailable', message: error.message };
  }
  if (error instanceof HostExecutionError) {
    return { status: 422, code: 'execution_failed', message: error.message };
  }
  if (error instanceof FounderAuthorizationError) {
    return { status: 403, code: 'forbidden', message: 'Authorization policy denied this operation.' };
  }
  if (error instanceof FounderInputError) {
    return { status: 400, code: 'invalid_request', message: error.message };
  }
  if (error instanceof TaskCancelledError) {
    return { status: 409, code: 'task_cancelled', message: error.message };
  }
  if (error instanceof ExecutionCapacityError) {
    return { status: 429, code: 'execution_capacity_exceeded', message: error.message };
  }
  if (error instanceof ExecutionAttemptConflictError) {
    return { status: 409, code: 'execution_conflict', message: error.message };
  }
  if (error instanceof ExecutionConflictError) {
    return { status: 409, code: 'execution_conflict', message: error.message };
  }
  if (error instanceof OrchestrationError) {
    const denied = /denied|not authorized/i.test(error.message);
    return {
      status: denied ? 403 : 409,
      code: denied ? 'forbidden' : 'orchestration_rejected',
      message: error.message,
    };
  }
  return { status: 500, code: 'internal_error', message: 'The request could not be completed.' };
}

function logFailure(requestId: string, path: string, mapped: { status: number; code: string }): void {
  process.stderr.write(`${JSON.stringify({
    event: 'request_failed',
    request_id: requestId,
    path,
    status: mapped.status,
    code: mapped.code,
  })}\n`);
}

/**
 * Trusted local HTTP host.
 *
 * Security properties enforced here, independent of authorization policy:
 * - The socket only ever listens on a literal loopback address (validated in config).
 * - A `Host` header that is not loopback is rejected, which blocks DNS-rebinding attempts.
 * - Any request carrying an `Origin` header is rejected: no browser cross-origin client is
 *   supported yet, so there is no CORS surface to get wrong.
 * - Every authenticated route derives its actor from the verified session. A request body
 *   may never name its own actor.
 * - Runtime policy administration is a human-only `POST /v1/policies` path requiring an
 *   exact `administer_policy` grant on every target. The offline bootstrap CLI remains.
 * - Response bodies are `no-store`, and error responses never include stack traces or
 *   caller-supplied payloads.
 */
export class HostHttpServer {
  private readonly server: Server;
  private readonly routes: Route[];
  private closed = false;

  constructor(private readonly runtime: HostRuntime) {
    this.routes = buildRoutes(runtime);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
  }

  async listen(): Promise<{ host: string; port: number }> {
    const { host, port } = this.runtime.config.bind;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
    const address = this.server.address() as AddressInfo | null;
    if (!address) throw new Error('Host server has no listening address.');
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    requestId: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload, 'utf8'),
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      ...extraHeaders,
    });
    res.end(payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const path = req.url ?? '/';
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        this.send(res, 403, { error: 'invalid_host_header', request_id: requestId }, requestId);
        return;
      }
      if (req.headers.origin !== undefined) {
        this.send(res, 403, { error: 'cross_origin_rejected', request_id: requestId }, requestId);
        return;
      }

      const url = new URL(path, 'http://127.0.0.1');
      const route = this.routes.find((candidate) => candidate.pattern.test(url.pathname));
      if (!route) {
        this.send(res, 404, { error: 'not_found', request_id: requestId }, requestId);
        return;
      }
      const match = route.pattern.exec(url.pathname);
      if (!match) {
        this.send(res, 404, { error: 'not_found', request_id: requestId }, requestId);
        return;
      }
      const method = req.method ?? '';
      if (!route.allow.includes(method)) {
        this.send(
          res,
          405,
          { error: 'method_not_allowed', request_id: requestId },
          requestId,
          { allow: route.allow.join(', ') },
        );
        return;
      }

      let session: AuthenticatedSession | undefined;
      if (!route.public) {
        session = this.runtime.identity.authenticate(req.headers.authorization);
        if (!session) {
          process.stderr.write(`${JSON.stringify({
            event: 'authentication_failed',
            request_id: requestId,
            path: url.pathname,
          })}\n`);
          this.send(
            res,
            401,
            { error: 'unauthenticated', request_id: requestId },
            requestId,
            { 'www-authenticate': 'Bearer' },
          );
          return;
        }
      }

      const context: RequestContext = {
        runtime: this.runtime,
        req,
        url,
        session: session ?? {
          session_id: 'public',
          principal_id: 'public',
          label: 'public',
        },
        readJson: async () => {
          const parsed = await readJsonBody(req, this.runtime.config.request_body_limit_bytes);
          return parsed === undefined ? undefined : jsonBody(parsed);
        },
      };
      // Keep the request id in scope for every authorization decision made by this
      // operation, including decisions inside orchestration and Founder calls.
      const response = await withRequestId(requestId, () => route.handle(context, match));
      this.send(res, response.status, response.body, requestId);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.status >= 500 || mapped.status === 409) logFailure(requestId, path, mapped);
      this.send(
        res,
        mapped.status,
        { error: mapped.code, message: mapped.message, request_id: requestId },
        requestId,
      );
    }
  }
}

async function requireAllowed(
  runtime: HostRuntime,
  session: AuthenticatedSession,
  action: 'read_status' | 'read_evidence' | 'cancel' | 'resume' | 'retry' | 'administer_policy',
  resourceId: string,
): Promise<void> {
  const allowed = await runtime.boundary.authorize({
    actor_id: session.principal_id,
    action,
    resource_id: resourceId,
  });
  if (!allowed) throw new HostHttpError(403, 'forbidden', 'Authorization policy denied this operation.');
}

async function requirePolicyAdministration(
  runtime: HostRuntime,
  session: AuthenticatedSession,
  resourceIds: readonly string[],
): Promise<void> {
  for (const resourceId of resourceIds) {
    const allowed = await runtime.boundary.authorize({
      actor_id: session.principal_id,
      action: 'administer_policy',
      resource_id: resourceId,
    });
    if (!allowed) {
      throw new HostHttpError(
        403,
        'policy_admin_denied',
        'An exact administer_policy grant is required on every target resource.',
      );
    }
  }
  requireHuman(session);
}

function requireHuman(session: AuthenticatedSession): void {
  if (!isHumanPrincipal(session.principal_id)) {
    throw new HostHttpError(403, 'human_principal_required', 'This operation requires a human principal.');
  }
}

function requireBootstrap(session: AuthenticatedSession, config: HostConfig): void {
  if (session.principal_id !== config.bootstrap_principal_id) {
    throw new HostHttpError(403, 'bootstrap_principal_required', 'Authorization audit reads require the bootstrap principal.');
  }
}

function auditLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new HostHttpError(400, 'invalid_limit', 'Query parameter "limit" must be an integer between 1 and 500.');
  }
  return value;
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new HostHttpError(400, 'invalid_limit', 'Query parameter "limit" must be an integer between 1 and 200.');
  }
  return value;
}

function buildRoutes(runtime: HostRuntime): Route[] {
  const dispatchEnabled = runtime.executionConfigured && runtime.verificationConfigured;

  return [
    {
      pattern: /^\/health$/,
      allow: ['GET'],
      public: true,
      handle: async () => ({
        status: 200,
        body: {
          status: 'ok',
          service: SERVICE,
          version: VERSION,
          capabilities: {
            dispatch: dispatchEnabled,
            evidence: runtime.evidenceConfigured,
          },
          storage: 'durable',
          recovered_workflows: runtime.recoveredWorkflows.length,
          recovered_executions: runtime.recoveredExecutions.length,
          max_concurrent_tasks: runtime.config.execution?.max_concurrent_tasks ?? 1,
        },
      }),
    },
    {
      pattern: /^\/v1\/session$/,
      allow: ['GET'],
      handle: async ({ session }) => ({
        status: 200,
        body: {
          principal_id: session.principal_id,
          session_id: session.session_id,
          label: session.label,
          human: isHumanPrincipal(session.principal_id),
        },
      }),
    },
    {
      pattern: /^\/v1\/policies$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, readJson }) => {
        const document = parseRuntimePolicyPublication(jsonBody(await readJson()));
        // All targets are authorized before any mutation. The registry then validates the
        // policy, monotonic version, and rule scope and commits policy plus attachments as
        // one atomic snapshot. An audit-append failure on any decision denies the request.
        await requirePolicyAdministration(host, session, document.attach_to);
        try {
          await host.policies.publishAndAttach(
            document.policy,
            document.attach_to,
            session.principal_id,
          );
        } catch (error) {
          if (error instanceof PolicyPublicationError) {
            const status = error.code === 'version_conflict' || error.code === 'policy_exists'
              ? 409
              : 400;
            throw new HostHttpError(status, error.code, error.message);
          }
          throw error;
        }
        return {
          status: 201,
          body: {
            policy_id: document.policy.policy_id,
            version: document.policy.version,
            attached: document.attach_to,
          },
        };
      },
    },
    {
      pattern: /^\/v1\/tasks$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session, url }) => {
        const limit = pageLimit(url);
        const tasks = [];
        for (const task of host.taskStore.listTasks()) {
          if (await host.authorization.authorize({
            actor_id: session.principal_id,
            action: 'read_status',
            resource_id: task.entity_id,
          })) {
            tasks.push(task);
          }
        }
        return { status: 200, body: { tasks: tasks.slice(0, limit), total: tasks.length } };
      },
    },
    {
      pattern: /^\/v1\/workflows$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session, url }) => {
        const limit = pageLimit(url);
        const workflows = [];
        for (const workflow of host.workflowStore.list()) {
          if (await host.authorization.authorize({
            actor_id: session.principal_id,
            action: 'read_status',
            resource_id: workflow.entity_id,
          })) {
            workflows.push(workflow);
          }
        }
        return { status: 200, body: { workflows: workflows.slice(0, limit), total: workflows.length } };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        await requireAllowed(host, session, 'read_status', taskId);
        const task = host.taskStore.getTask(taskId);
        if (!task) throw new HostHttpError(404, 'not_found', 'Task was not found.');
        return { status: 200, body: { task } };
      },
    },
    {
      pattern: /^\/v1\/workflows\/([^/]+)$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }, params) => {
        const workflowId = uuidParam(params[1], 'workflowId');
        await requireAllowed(host, session, 'read_status', workflowId);
        const workflow = await host.kernel.getWorkflow(workflowId, session.principal_id);
        return { status: 200, body: { workflow } };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)\/attempts$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        // Authorization precedes existence lookup, matching every other read route.
        await requireAllowed(host, session, 'read_status', taskId);
        const task = host.taskStore.getTask(taskId);
        if (!task) throw new HostHttpError(404, 'not_found', 'Task was not found.');
        return { status: 200, body: await host.kernel.getTaskAttempts(taskId, session.principal_id) };
      },
    },
    {
      pattern: /^\/v1\/workflows\/([^/]+)\/attempts$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }, params) => {
        const workflowId = uuidParam(params[1], 'workflowId');
        await requireAllowed(host, session, 'read_status', workflowId);
        const workflow = host.workflowStore.get(workflowId);
        if (!workflow) throw new HostHttpError(404, 'not_found', 'Workflow was not found.');
        return { status: 200, body: await host.kernel.getWorkflowAttempts(workflowId, session.principal_id) };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)\/cancel$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, req, readJson }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        // Authorize the exact cancel action before revealing whether the Task exists.
        await requireAllowed(host, session, 'cancel', taskId);
        // The reason is optional. Do not require a JSON media type when the caller sends
        // no body at all (for example an idempotent retry).
        const declaredLength = req.headers['content-length'];
        const hasBody = req.headers['content-type'] !== undefined
          || req.headers['transfer-encoding'] !== undefined
          || (typeof declaredLength === 'string' && Number(declaredLength) > 0);
        const body = hasBody ? ((await readJson()) ?? {}) : {};
        const requestedReason = body.reason;
        if (requestedReason !== undefined && (typeof requestedReason !== 'string'
          || requestedReason.trim().length === 0 || requestedReason.length > 500)) {
          throw new HostHttpError(
            400,
            'invalid_field',
            'Field "reason" must be a bounded non-empty string.',
          );
        }
        const task = host.taskStore.getTask(taskId);
        if (!task) throw new HostHttpError(404, 'not_found', 'Task was not found.');
        if (task.lifecycle_state === 'completed' || task.lifecycle_state === 'archived') {
          throw new HostHttpError(409, 'task_terminal', 'A terminal Task cannot be cancelled.');
        }

        const existing = host.executions.getForTask(taskId);
        if (existing && existing.state !== 'running' && existing.state !== 'cancelled') {
          throw new HostHttpError(409, 'execution_terminal', 'The Task execution is already terminal.');
        }
        if (existing?.state === 'cancelled') {
          return {
            status: 200,
            body: {
              task_id: taskId,
              execution_id: existing.execution_id,
              state: 'cancelled',
              already_cancelled: true,
            },
          };
        }

        // Persist the terminal cancellation before aborting. The executor wrapper checks this
        // record after the sandbox returns, so a late success can never overwrite it.
        const cancelled = host.executions.cancel({
          task_id: taskId,
          ...(task.assigned_workflow === undefined ? {} : { workflow_id: task.assigned_workflow }),
          actor_id: session.principal_id,
          reason_code: 'cancelled_by_request',
          evidence: [`reason_sha256:${createHash('sha256').update(requestedReason ?? 'cancelled_by_request').digest('hex')}`],
        });

        let runId: string | undefined;
        if (task.assigned_workflow) {
          const run = host.runs.listForWorkflow(task.assigned_workflow).find((candidate) => candidate.state === 'running');
          if (run) {
            host.runs.cancel(run.run_id, 'cancelled_by_request');
            runId = run.run_id;
          }
        }
        if (task.lifecycle_state === 'active' || task.lifecycle_state === 'monitored') {
          host.taskStore.transitionTaskLifecycle(
            taskId,
            'suspended',
            task.assigned_agent ?? session.principal_id,
          );
        }
        // Abort after the ledger and run are terminal. The local executor kills the sandbox
        // process; a wrapper around any other executor rechecks the ledger before completion.
        host.executionControl.cancelTask(taskId);

        return {
          status: 202,
          body: {
            task_id: taskId,
            execution_id: cancelled.record.execution_id,
            state: 'cancelled',
            ...(runId === undefined ? {} : { run_id: runId }),
          },
        };
      },
    },
    {
      pattern: /^\/v1\/workflows\/([^/]+)\/resume$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session }, params) => {
        const workflowId = uuidParam(params[1], 'workflowId');
        if (!host.executionConfigured || !host.verificationConfigured) {
          throw new HostUnavailableError(
            'Workflow resume requires a configured execution adapter and an independent verifier.',
          );
        }
        // Authorize the exact resume action before revealing whether the Workflow exists.
        // The kernel re-evaluates the same action and each Task/Agent grant before writes.
        await requireAllowed(host, session, 'resume', workflowId);
        const result = await host.kernel.resumeWorkflow(workflowId, session.principal_id);
        return { status: 200, body: result };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)\/resume$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        if (!host.executionConfigured || !host.verificationConfigured) {
          throw new HostUnavailableError(
            'Task resume requires a configured execution adapter and an independent verifier.',
          );
        }
        await requireAllowed(host, session, 'resume', taskId);
        const result = await host.kernel.resumeTask(taskId, session.principal_id);
        return { status: 200, body: result };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)\/retry$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        if (!host.executionConfigured || !host.verificationConfigured) {
          throw new HostUnavailableError(
            'Task retry requires a configured execution adapter and an independent verifier.',
          );
        }
        await requireAllowed(host, session, 'retry', taskId);
        const result = await host.kernel.retryTask(taskId, session.principal_id);
        return { status: 200, body: result };
      },
    },
    {
      pattern: /^\/v1\/tasks\/([^/]+)\/evidence\/([^/]+)$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }, params) => {
        const taskId = uuidParam(params[1], 'taskId');
        const evidenceId = uuidParam(params[2], 'evidenceId');
        const evidence = await host.kernel.getExecutionEvidence(
          evidenceId,
          taskId,
          session.principal_id,
        );
        return { status: 200, body: { evidence } };
      },
    },
    {
      pattern: /^\/v1\/intake$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, readJson }) => {
        const body = jsonBody(await readJson());
        const kind = body.kind;
        if (kind !== 'task' && kind !== 'workflow') {
          throw new HostHttpError(400, 'invalid_kind', 'Field "kind" must be "task" or "workflow".');
        }
        const entity = body.entity;
        if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
          throw new HostHttpError(400, 'invalid_entity', 'Field "entity" must be an object.');
        }
        const record = entity as Record<string, unknown>;
        if (record.created_by !== session.principal_id || record.owner_id !== session.principal_id) {
          throw new HostHttpError(
            403,
            'actor_mismatch',
            'Entity provenance and ownership must match the authenticated principal.',
          );
        }
        if (kind === 'task') {
          const task = await host.kernel.intake(
            { kind: 'task', task: entity as never },
            session.principal_id,
          );
          return {
            status: 201,
            body: { kind, entity_id: task.entity_id, lifecycle_state: task.lifecycle_state },
          };
        }
        const workflow = await host.kernel.intake(
          { kind: 'workflow', workflow: entity as never },
          session.principal_id,
        );
        return {
          status: 201,
          body: { kind, entity_id: workflow.entity_id, lifecycle_state: workflow.lifecycle_state },
        };
      },
    },
    {
      pattern: /^\/v1\/workflows\/([^/]+)\/dispatch$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, req }, params) => {
        const workflowId = uuidParam(params[1], 'workflowId');
        if (!host.executionConfigured || !host.verificationConfigured) {
          throw new HostUnavailableError(
            'Dispatch requires a configured execution adapter and an independent verifier.',
          );
        }
        // Authorize before revealing whether the Workflow exists, so a caller with a valid
        // session but no dispatch grant cannot enumerate workflow identifiers.
        await requireAllowed(host, session, 'read_status', workflowId);
        const workflow = host.workflowStore.get(workflowId);
        if (!workflow) throw new HostHttpError(404, 'not_found', 'Workflow was not found.');

        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
          throw new HostHttpError(
            400,
            'idempotency_key_required',
            'Dispatch requires an Idempotency-Key header of 8-200 characters from [A-Za-z0-9._:-].',
          );
        }

        let started: StartedRun;
        try {
          started = host.runs.start({
            workflow_id: workflowId,
            actor_id: session.principal_id,
            idempotency_key: idempotencyKey,
            lease_ms: host.config.dispatch_lease_ms,
          });
        } catch (error) {
          if (error instanceof DispatchConflictError) {
            throw new HostHttpError(409, 'dispatch_conflict', error.message);
          }
          throw error;
        }

        if (started.replayed) {
          const current = host.workflowStore.get(workflowId);
          return {
            status: 200,
            body: {
              workflow_id: workflowId,
              lifecycle_state: current?.lifecycle_state ?? 'unknown',
              replayed: true,
              run_id: started.run.run_id,
            },
          };
        }

        const stopHeartbeat = host.runs.heartbeat(started.run.run_id);
        try {
          const handle = await host.kernel.dispatch(workflow, session.principal_id);
          const run = host.runs.get(started.run.run_id);
          if (run?.state === 'running') host.runs.complete(started.run.run_id);
          else if (run?.state === 'cancelled') throw new TaskCancelledError(workflowId);
          const current = host.workflowStore.get(handle.workflow_id);
          return {
            status: 200,
            body: {
              workflow_id: handle.workflow_id,
              lifecycle_state: current?.lifecycle_state ?? 'unknown',
              replayed: false,
              run_id: started.run.run_id,
            },
          };
        } catch (error) {
          // A rejected or failed dispatch is journaled before the error is returned, so a
          // restart cannot re-run it or mistake it for completed work. Cancellation already
          // wrote its terminal run state; never overwrite it with a generic failure.
          if (host.runs.get(started.run.run_id)?.state === 'running') {
            host.runs.fail(started.run.run_id, dispatchFailureCode(error));
          }
          throw error;
        } finally {
          stopHeartbeat();
        }
      },
    },
    {
      pattern: /^\/v1\/founder\/query$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, readJson }) => {
        const body = jsonBody(await readJson());
        const question = requireStringField(body, 'question', 2000);
        return { status: 200, body: await host.founder.query(question, session.principal_id) };
      },
    },
    {
      pattern: /^\/v1\/founder\/evidence-query$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, readJson }) => {
        if (!host.evidenceConfigured) {
          throw new HostUnavailableError('The Obsidian vault evidence reader is not configured.');
        }
        const body = jsonBody(await readJson());
        const question = requireStringField(body, 'question', 2000);
        return { status: 200, body: await host.founder.queryEvidence(question, session.principal_id) };
      },
    },
    {
      pattern: /^\/v1\/founder\/gmail\/search$/,
      allow: ['POST'],
      handle: async ({ runtime: host, session, readJson }) => {
        if (!host.evidenceConfigured) {
          throw new HostUnavailableError('The Gmail evidence reader is not configured.');
        }
        const body = jsonBody(await readJson());
        const query = requireStringField(body, 'query', 500);
        return { status: 200, body: { messages: await host.founder.searchGmail(query, session.principal_id) } };
      },
    },
    {
      pattern: /^\/v1\/founder\/notion\/applications$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }) => {
        if (!host.evidenceConfigured) {
          throw new HostUnavailableError('The Notion evidence reader is not configured.');
        }
        return {
          status: 200,
          body: { applications: await host.founder.listNotionApplications(session.principal_id) },
        };
      },
    },
    {
      pattern: /^\/v1\/founder\/decisions$/,
      allow: ['GET', 'POST'],
      handle: async ({ runtime: host, session, req, readJson }) => {
        if (req.method === 'GET') {
          const decisions = await host.founder.listDecisions(session.principal_id);
          return { status: 200, body: { decisions } };
        }
        requireHuman(session);
        const body = jsonBody(await readJson());
        const title = requireStringField(body, 'title', 200);
        const decision = requireStringField(body, 'decision', 20000);
        const rationale = requireStringField(body, 'rationale', 20000);
        if (body.decided_by !== undefined && body.decided_by !== session.principal_id) {
          throw new HostHttpError(400, 'actor_mismatch', 'Field "decided_by" must match the authenticated principal.');
        }
        const evidence = body.evidence;
        if (evidence !== undefined && (!Array.isArray(evidence)
          || evidence.some((item) => typeof item !== 'string'))) {
          throw new HostHttpError(400, 'invalid_field', 'Field "evidence" must be an array of strings.');
        }
        const decisionId = await host.founder.recordDecision(
          {
            title,
            decision,
            rationale,
            decided_by: session.principal_id,
            ...(evidence === undefined ? {} : { evidence: evidence as string[] }),
          },
          session.principal_id,
        );
        return { status: 201, body: { decision_id: decisionId } };
      },
    },
    {
      pattern: /^\/v1\/founder\/queue$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }) => {
        requireHuman(session);
        return { status: 200, body: { entities: await host.founder.reviewQueue(session.principal_id) } };
      },
    },
    {
      pattern: /^\/v1\/audit\/policies$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session }) => {
        requireBootstrap(session, host.config);
        return { status: 200, body: { events: host.policies.listPolicyAudit() } };
      },
    },
    {
      pattern: /^\/v1\/audit\/authorization$/,
      allow: ['GET'],
      handle: async ({ runtime: host, session, url }) => {
        requireBootstrap(session, host.config);
        // A second, policy-based condition: the bootstrap principal still needs the exact
        // read_evidence grant on the protected decision collection. No unauthenticated or
        // bootstrap-implied read path exists.
        await requireAllowed(host, session, 'read_evidence', host.config.decision_collection_id);
        const limit = auditLimit(url);
        const records = host.authorizationAudit.list();
        return { status: 200, body: { records: records.slice(-limit), total: records.length } };
      },
    },
  ];
}

export function createHostServer(runtime: HostRuntime): HostHttpServer {
  return new HostHttpServer(runtime);
}
