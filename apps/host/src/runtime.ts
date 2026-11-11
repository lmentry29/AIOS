import type { ArtifactEntity, CanonicalEntity, TaskEntity, WorkflowEntity } from '@aios/core';
import { CanonicalEntity as CanonicalEntitySchema } from '@aios/core';
import {
  AuthorizationService,
  AuthorizedLocalConnectorEvidenceReader,
  AuthorizedVaultEvidenceReader,
  FilePolicyRegistry,
  FounderInterface,
} from '@aios/founder';
import { LearningService } from '@aios/learning';
import { ObjectStore } from '@aios/objects';
import {
  OrchestrationKernel,
  type AgentExecutionPort,
  type TaskExecutionResult,
  type TaskVerificationDecision,
  type TaskVerificationPort,
} from '@aios/orchestration';
import { SharedAuthorizationBoundary } from './authorization.js';
import type { HostConfig } from './config.js';
import { HostUnavailableError } from './errors.js';
import { TrustedIdentityService } from './identity.js';
import { ManagedExecutionPort, type CancellableExecutionPort } from './execution/managed-execution.js';
import type { ExecutionLedger } from './persistence/execution-ledger.js';
import { DurableAuthorizationAuditStore } from './persistence/authorization-audit-store.js';
import { DurableLearningStore } from './persistence/learning-store.js';
import {
  DurableOperationalStore,
  type DurableCollection,
  type DurableRunCoordinator,
  type DurableTaskRepository,
} from './persistence/operational-store.js';

const UNCONFIGURED_VERIFIER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Actor recorded for host-initiated crash recovery.
 *
 * `ActorRef` admits only a UUID or `human:<id>`. Recording the founder would fabricate
 * human attribution for a transition the host made on its own, so recovery is attributed
 * to this stable system actor instead. It is not a registered Agent and holds no
 * capability; it exists only to label recovery entries in append-only lifecycle history.
 */
const HOST_RECOVERY_ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';

/**
 * Refuses execution until a real adapter is supplied.
 *
 * AGENTS.md rule 11 and the orchestration contract both forbid treating a lifecycle write
 * as proof of work. A host that invented a "successful" executor to make dispatch pass
 * would be exactly the failure mode this project is built to prevent, so the unconfigured
 * port throws instead. The kernel calls it during preflight, before any lifecycle write.
 */
class UnconfiguredExecutionPort implements AgentExecutionPort {
  async validateAgent(): Promise<boolean> {
    throw new HostUnavailableError('No Agent execution adapter is configured; dispatch is disabled.');
  }

  async executeTask(): Promise<TaskExecutionResult> {
    throw new HostUnavailableError('No Agent execution adapter is configured; dispatch is disabled.');
  }

  async coordinate(): Promise<TaskExecutionResult> {
    throw new HostUnavailableError('No Agent execution adapter is configured; coordination is disabled.');
  }
}

class UnconfiguredVerificationPort implements TaskVerificationPort {
  readonly verifier_id = UNCONFIGURED_VERIFIER_ID;

  async verify(): Promise<TaskVerificationDecision> {
    throw new HostUnavailableError('No independent verifier is configured; dispatch is disabled.');
  }
}

export interface HostRuntimeOptions {
  config: HostConfig;
  /** Owner-only Obsidian++ password from the environment; required only with `config.obsidian`. */
  obsidianPassword?: string;
  execution?: AgentExecutionPort;
  verification?: TaskVerificationPort;
  resolveAgent?: (task: TaskEntity) => Promise<string>;
  fetch?: typeof globalThis.fetch;
}

export interface HostRuntime {
  config: HostConfig;
  policies: FilePolicyRegistry;
  identity: TrustedIdentityService;
  /** The single evaluator shared by every surface. */
  authorization: AuthorizationService;
  /** Durable allow/deny decisions, correlated to the guarded host operation. */
  authorizationAudit: DurableAuthorizationAuditStore;
  boundary: SharedAuthorizationBoundary;
  kernel: OrchestrationKernel;
  founder: FounderInterface;
  /** Durable operational repositories (ADR-0015). */
  operational: DurableOperationalStore;
  /** Durable session authority shared by authentication and operator administration. */
  sessions: DurableOperationalStore['sessions'];
  /** Approval-gated Learning System state, durable in learning.jsonl. */
  learning: LearningService;
  runs: DurableRunCoordinator;
  taskStore: DurableTaskRepository;
  workflowStore: DurableCollection<WorkflowEntity>;
  artifactStore: DurableCollection<ArtifactEntity>;
  /** Workflows whose interrupted dispatch/execution was recovered at startup. */
  recoveredWorkflows: string[];
  /** Task executions interrupted by a previous process and reconciled at startup. */
  recoveredExecutions: string[];
  /** Per-Task execution lifecycle journal. */
  executions: ExecutionLedger;
  /** Host-owned cancellation handle; it carries no authorization itself. */
  executionControl: CancellableExecutionPort;
  executionConfigured: boolean;
  verificationConfigured: boolean;
  evidenceConfigured: boolean;
  close(): void;
}

/**
 * Refuses to leave recovered Workflows looking active.
 *
 * A run or Task execution journaled by a previous host boot cannot still be executing.
 * Marking it interrupted is not enough on its own: the Workflow and its active Tasks would
 * otherwise stay `active` with no owner, and a later reader would mistake interrupted work
 * for in-flight work. `active`/`monitored` can reach `suspended` in the canonical graph;
 * `suspended` can be resumed deliberately, which is exactly the operator decision this
 * creates. Reconciliation never re-executes and never appends a second terminal record.
 */
function reconcileInterruptedWork(store: DurableOperationalStore): {
  workflows: string[];
  executions: string[];
} {
  const affected = new Set(store.runs.recover());
  const interruptedExecutions = store.executions.reconcile();
  const directTasks = new Set<string>();
  for (const execution of interruptedExecutions) {
    if (execution.workflow_id) {
      affected.add(execution.workflow_id);
      continue;
    }
    const task = store.tasks.getTask(execution.task_id);
    if (task?.assigned_workflow) affected.add(task.assigned_workflow);
    else directTasks.add(execution.task_id);
  }

  for (const workflowId of affected) {
    const workflow = store.workflows.get(workflowId);
    if (workflow && (workflow.lifecycle_state === 'active' || workflow.lifecycle_state === 'monitored')) {
      store.workflows.transitionLifecycle(workflowId, 'suspended', HOST_RECOVERY_ACTOR_ID);
    }
    for (const task of store.tasks.listTasks()) {
      if (task.assigned_workflow !== workflowId) continue;
      if (task.lifecycle_state !== 'active' && task.lifecycle_state !== 'monitored') continue;
      store.tasks.transitionTaskLifecycle(task.entity_id, 'suspended', HOST_RECOVERY_ACTOR_ID);
    }
  }
  for (const taskId of directTasks) {
    const task = store.tasks.getTask(taskId);
    if (task && (task.lifecycle_state === 'active' || task.lifecycle_state === 'monitored')) {
      store.tasks.transitionTaskLifecycle(taskId, 'suspended', HOST_RECOVERY_ACTOR_ID);
    }
  }
  return { workflows: [...affected], executions: interruptedExecutions.map((record) => record.execution_id) };
}

function resolveAgentUnlessConfigured(
  resolver: ((task: TaskEntity) => Promise<string>) | undefined,
): (task: TaskEntity) => Promise<string> {
  if (resolver) return resolver;
  return async () => {
    throw new HostUnavailableError('No Agent resolver is configured; dispatch is disabled.');
  };
}

/**
 * Composes the trusted local host.
 *
 * This is the composition root blocker in the PR description: one durable policy registry,
 * one evaluator, one dedicated decision-audit journal, shared by Founder and Orchestration;
 * identity derived from configuration-backed bearer sessions rather than caller-supplied
 * actor strings. Policy lifecycle events remain atomically committed with policy state.
 *
 * Deliberate non-claims:
 * - Tasks, Workflows, Artifacts, and dispatch runs are durable through the hash-chained
 *   operational journal (ADR-0015) with idempotency keys and leases. Founder Intelligence
 *   remains in the Obsidian vault (ADR-0014); this does not create a second Founder store.
 * - Learning records are durable in a separate hash-chained journal, and permanent Memory
 *   promotions require a recorded human approval. The canonical object store used only for
 *   Founder queries remains in-memory. No execution or verification adapter is invented:
 *   missing adapters fail closed.
 * - The vault/Gmail/Notion readers are composed against the shared evaluator but are only
 *   live once the local Obsidian++ service and credentials exist.
 */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  const { config } = options;

  if (options.obsidianPassword !== undefined && Buffer.byteLength(options.obsidianPassword) < 32) {
    throw new Error('Obsidian++ local password must contain at least 32 bytes.');
  }
  if (config.obsidian && options.obsidianPassword === undefined) {
    throw new Error('Evidence readers are configured but no Obsidian++ password was supplied.');
  }

  const policies = new FilePolicyRegistry({ filePath: config.policy_file });
  let operational: DurableOperationalStore | undefined;
  let learningStore: DurableLearningStore | undefined;
  let authorizationAudit: DurableAuthorizationAuditStore | undefined;
  try {
    const auditStore = new DurableAuthorizationAuditStore({
      directory: config.operational_store.directory,
    });
    authorizationAudit = auditStore;
    const authorization = new AuthorizationService(
      policies,
      (resourceId) => policies.resolve(resourceId),
      auditStore,
    );
    const boundary = new SharedAuthorizationBoundary(authorization);

    operational = new DurableOperationalStore({
      directory: config.operational_store.directory,
      leaseMs: config.dispatch_lease_ms,
      sessions: config.sessions,
    });
    // The durable session authority must exist before identity is composed: a rotated or
    // revoked token from a previous process is denied at startup, not merely overwritten by
    // the configuration's generation-1 digest.
    const identity = new TrustedIdentityService(operational.sessions);
    learningStore = new DurableLearningStore({ directory: config.operational_store.directory });
    const recovered = reconcileInterruptedWork(operational);
    const recoveredWorkflows = recovered.workflows;
    const recoveredExecutions = recovered.executions;
    const taskStore = operational.tasks;
    const workflowStore = operational.workflows;
    const artifactStore = operational.artifacts;
    const objectStore = new ObjectStore<CanonicalEntity>(CanonicalEntitySchema);
    const learning = new LearningService(
      learningStore.memoryRepository,
      learningStore.knowledgeRepository,
      learningStore.approvalRepository,
      {
        // An approval is a human governance action. Reuse the protected Founder decision
        // collection and its existing exact `intake` grant rather than inventing a new
        // authorization action; the evaluator still denies by default.
        authorize: async (actorId) => boundary.authorize({
          actor_id: actorId,
          action: 'intake',
          resource_id: config.decision_collection_id,
        }),
      },
    );

    const execution = new ManagedExecutionPort(
      options.execution ?? new UnconfiguredExecutionPort(),
      operational.executions,
      config.execution?.max_concurrent_tasks ?? 1,
    );
    const verification = options.verification ?? new UnconfiguredVerificationPort();

    const kernel = new OrchestrationKernel(
      taskStore,
      {
        authorization: boundary,
        execution,
        verification,
        resolveAgent: resolveAgentUnlessConfigured(options.resolveAgent),
        cancellation: {
          isCancelled: async (taskId) => operational?.executions.isCancelled(taskId) ?? false,
        },
        executionState: {
          latest: async (taskId) => operational?.executions.getForTask(taskId),
          history: async (taskId) => operational?.executions.listForTask(taskId) ?? [],
        },
      },
      workflowStore,
      artifactStore,
    );

    const founder = new FounderInterface(
      {
        list: () => [...objectStore.list(), ...taskStore.listTasks(), ...workflowStore.list()],
      },
      learning,
      boundary,
      { decisionCollectionId: config.decision_collection_id },
      artifactStore,
      config.obsidian
        ? new AuthorizedVaultEvidenceReader(
            {
              baseUrl: config.obsidian.base_url,
              password: options.obsidianPassword ?? '',
              vaultResourceId: config.resources.vault,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            },
            boundary,
          )
        : undefined,
      config.obsidian
        ? new AuthorizedLocalConnectorEvidenceReader(
            {
              baseUrl: config.obsidian.base_url,
              password: options.obsidianPassword ?? '',
              gmailResourceId: config.resources.gmail,
              notionResourceId: config.resources.notion,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            },
            boundary,
          )
        : undefined,
    );

    return {
      config,
      policies,
      identity,
      authorization,
      authorizationAudit: auditStore,
      boundary,
      kernel,
      founder,
      operational,
      sessions: operational.sessions,
      learning,
      runs: operational.runs,
      taskStore,
      workflowStore,
      artifactStore,
      recoveredWorkflows,
      recoveredExecutions,
      executions: operational.executions,
      executionControl: execution,
      executionConfigured: options.execution !== undefined,
      verificationConfigured: options.verification !== undefined,
      evidenceConfigured: config.obsidian !== undefined,
      close: () => {
        authorizationAudit?.close();
        learningStore?.close();
        operational?.close();
        policies.close();
      },
    };
  } catch (error) {
    authorizationAudit?.close();
    learningStore?.close();
    operational?.close();
    policies.close();
    throw error;
  }
}
