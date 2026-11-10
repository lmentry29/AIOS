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
  boundary: SharedAuthorizationBoundary;
  kernel: OrchestrationKernel;
  founder: FounderInterface;
  /** Durable operational repositories (ADR-0015). */
  operational: DurableOperationalStore;
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
 * one evaluator, one audit chain, shared by Founder and Orchestration; identity derived from
 * configuration-backed bearer sessions rather than caller-supplied actor strings.
 *
 * Deliberate non-claims:
 * - Tasks, Workflows, Artifacts, and dispatch runs are durable through the hash-chained
 *   operational journal (ADR-0015) with idempotency keys and leases. Founder Intelligence
 *   remains in the Obsidian vault (ADR-0014); this does not create a second Founder store.
 * - Learning records and the canonical object store used only for Founder queries remain
 *   in-memory. No execution or verification adapter is invented: missing adapters fail
 *   closed.
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
  try {
    const authorization = new AuthorizationService(
      policies,
      (resourceId) => policies.resolve(resourceId),
      policies,
    );
    const boundary = new SharedAuthorizationBoundary(authorization);
    const identity = new TrustedIdentityService(config.sessions);

    operational = new DurableOperationalStore({
      directory: config.operational_store.directory,
      leaseMs: config.dispatch_lease_ms,
    });
    const recovered = reconcileInterruptedWork(operational);
    const recoveredWorkflows = recovered.workflows;
    const recoveredExecutions = recovered.executions;
    const taskStore = operational.tasks;
    const workflowStore = operational.workflows;
    const artifactStore = operational.artifacts;
    const objectStore = new ObjectStore<CanonicalEntity>(CanonicalEntitySchema);
    const learning = new LearningService();

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
              fetch: options.fetch ?? globalThis.fetch,
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
              fetch: options.fetch ?? globalThis.fetch,
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
      boundary,
      kernel,
      founder,
      operational,
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
        operational?.close();
        policies.close();
      },
    };
  } catch (error) {
    operational?.close();
    policies.close();
    throw error;
  }
}
