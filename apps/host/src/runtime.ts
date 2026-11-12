import type { ArtifactEntity, CanonicalEntity, TaskEntity, WorkflowEntity } from "@aios/core";
import { CanonicalEntity as CanonicalEntitySchema } from "@aios/core";
import {
  AuthorizationService,
  AuthorizedLocalConnectorEvidenceReader,
  AuthorizedVaultEvidenceReader,
  FilePolicyRegistry,
  FounderInterface,
} from "@aios/founder";
import { LearningService } from "@aios/learning";
import { ObjectStore } from "@aios/objects";
import {
  OrchestrationKernel,
  type AgentExecutionPort,
  type TaskExecutionResult,
  type TaskVerificationDecision,
  type TaskVerificationPort,
} from "@aios/orchestration";
import { SharedAuthorizationBoundary } from "./authorization.js";
import type { HostConfig } from "./config.js";
import { loadTrustRoot } from "./execution/artifact-signing.js";
import { PolicyProvenanceAuthority } from "./policy-provenance.js";
import { HostUnavailableError } from "./errors.js";
import { TrustedIdentityService } from "./identity.js";
import {
  ManagedExecutionPort,
  type CancellableExecutionPort,
} from "./execution/managed-execution.js";
import type { ExecutionLedger } from "./persistence/execution-ledger.js";
import { DurableAuthorizationAuditStore } from "./persistence/authorization-audit-store.js";
import { DurableLearningStore } from "./persistence/learning-store.js";
import {
  EncryptedFileSecretBroker,
  UnavailableSecretBroker,
  type SecretBrokerPort,
} from "./security/secret-broker.js";
import {
  DurableOperationalStore,
  type DurableCollection,
  type DurableInfrastructureRepository,
  type DurableMissionRepository,
  type DurableRunCoordinator,
  type DurableTaskRepository,
} from "./persistence/operational-store.js";
import type { DurableDagScheduler } from "./scheduler/dag-scheduler.js";

const UNCONFIGURED_VERIFIER_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Actor recorded for host-initiated crash recovery.
 *
 * `ActorRef` admits only a UUID or `human:<id>`. Recording the founder would fabricate
 * human attribution for a transition the host made on its own, so recovery is attributed
 * to this stable system actor instead. It is not a registered Agent and holds no
 * capability; it exists only to label recovery entries in append-only lifecycle history.
 */
const HOST_RECOVERY_ACTOR_ID = "00000000-0000-4000-8000-0000000000a1";

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
    throw new HostUnavailableError(
      "No Agent execution adapter is configured; dispatch is disabled.",
    );
  }

  async executeTask(): Promise<TaskExecutionResult> {
    throw new HostUnavailableError(
      "No Agent execution adapter is configured; dispatch is disabled.",
    );
  }

  async coordinate(): Promise<TaskExecutionResult> {
    throw new HostUnavailableError(
      "No Agent execution adapter is configured; coordination is disabled.",
    );
  }
}

class UnconfiguredVerificationPort implements TaskVerificationPort {
  readonly verifier_id = UNCONFIGURED_VERIFIER_ID;

  async verify(): Promise<TaskVerificationDecision> {
    throw new HostUnavailableError("No independent verifier is configured; dispatch is disabled.");
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
  /** Policy bundle and decision signing/verification against the pinned trust root. */
  policyProvenance: PolicyProvenanceAuthority;
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
  sessions: DurableOperationalStore["sessions"];
  /** Approval-gated Learning System state, durable in learning.jsonl. */
  learning: LearningService;
  runs: DurableRunCoordinator;
  taskStore: DurableTaskRepository;
  missionStore: DurableMissionRepository;
  infrastructure: DurableInfrastructureRepository;
  /** Host-owned credential resolution; unavailable unless the operator configures custody. */
  secretBroker: SecretBrokerPort;
  /** Durable dependency-DAG scheduling records; execution stays in the kernel. */
  scheduler: DurableDagScheduler;
  workflowStore: DurableCollection<WorkflowEntity>;
  artifactStore: DurableCollection<ArtifactEntity>;
  /** Workflows whose interrupted dispatch/execution was recovered at startup. */
  recoveredWorkflows: string[];
  /** Task executions interrupted by a previous process and reconciled at startup. */
  recoveredExecutions: string[];
  /** Scheduler graphs whose running nodes were reconciled at startup. */
  recoveredSchedulerGraphs: string[];
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
  schedulerGraphs: string[];
} {
  const affected = new Set(store.runs.recover());
  const interruptedExecutions = store.executions.reconcile();
  // A running node whose process is gone cannot still be executing. Auto-resume is opt-in
  // inside the scheduler; every other graph stays interrupted for an explicit decision.
  const recoveredSchedulerGraphs = store.scheduler.recover();
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
    if (
      workflow &&
      (workflow.lifecycle_state === "active" || workflow.lifecycle_state === "monitored")
    ) {
      store.workflows.transitionLifecycle(workflowId, "suspended", HOST_RECOVERY_ACTOR_ID);
    }
    for (const task of store.tasks.listTasks()) {
      if (task.assigned_workflow !== workflowId) continue;
      if (task.lifecycle_state !== "active" && task.lifecycle_state !== "monitored") continue;
      store.tasks.transitionTaskLifecycle(task.entity_id, "suspended", HOST_RECOVERY_ACTOR_ID);
    }
  }
  for (const taskId of directTasks) {
    const task = store.tasks.getTask(taskId);
    if (task && (task.lifecycle_state === "active" || task.lifecycle_state === "monitored")) {
      store.tasks.transitionTaskLifecycle(taskId, "suspended", HOST_RECOVERY_ACTOR_ID);
    }
  }
  return {
    workflows: [...affected],
    executions: interruptedExecutions.map((record) => record.execution_id),
    schedulerGraphs: recoveredSchedulerGraphs,
  };
}

function resolveAgentUnlessConfigured(
  resolver: ((task: TaskEntity) => Promise<string>) | undefined,
): (task: TaskEntity) => Promise<string> {
  if (resolver) return resolver;
  return async () => {
    throw new HostUnavailableError("No Agent resolver is configured; dispatch is disabled.");
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
/**
 * Refuses to compose the host when the policy signer is also trusted as a verifier key.
 *
 * ADR-0035 now gives every trust-root key exactly one purpose. This composition check is
 * retained as defense-in-depth so a misconfigured policy key id cannot reach the verifier
 * root even if a future root contains mixed purposes. HSM/KMS custody remains an
 * operator-supplied requirement, not a claim of this check.
 */
export function assertSeparatePolicyAndVerifierKeys(
  config: Pick<HostConfig, "policy_provenance" | "execution">,
): void {
  const execution = config.execution;
  if (execution?.verifier_key_id === undefined || execution.verifier_trust_root_file === undefined)
    return;
  if (execution.verifier_key_id === config.policy_provenance.key_id) {
    throw new Error(
      "The policy signing key id must not be the configured verifier signing key id.",
    );
  }
  const verifierRoot = loadTrustRoot(execution.verifier_trust_root_file, "verifier");
  if (verifierRoot.keys.some((key) => key.key_id === config.policy_provenance.key_id)) {
    throw new Error(
      "The configured policy signing key must not be present in the verifier trust root.",
    );
  }
}

export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  const { config } = options;
  assertSeparatePolicyAndVerifierKeys(config);

  if (options.obsidianPassword !== undefined && Buffer.byteLength(options.obsidianPassword) < 32) {
    throw new Error("Obsidian++ local password must contain at least 32 bytes.");
  }
  if (config.obsidian && options.obsidianPassword === undefined) {
    throw new Error("Evidence readers are configured but no Obsidian++ password was supplied.");
  }

  const policyProvenance = PolicyProvenanceAuthority.fromFiles({
    trust_root_file: config.policy_provenance.trust_root_file,
    private_key_file: config.policy_provenance.signing_key_file,
    key_id: config.policy_provenance.key_id,
  });
  const policies = new FilePolicyRegistry({ filePath: config.policy_file });
  let operational: DurableOperationalStore | undefined;
  let learningStore: DurableLearningStore | undefined;
  let authorizationAudit: DurableAuthorizationAuditStore | undefined;
  try {
    const auditStore = new DurableAuthorizationAuditStore({
      directory: config.operational_store.directory,
      headSigner: policyProvenance,
    });
    authorizationAudit = auditStore;
    const authorization = new AuthorizationService(
      policies,
      (resourceId) => policies.resolve(resourceId),
      auditStore,
      policyProvenance,
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
    const recoveredSchedulerGraphs = recovered.schedulerGraphs;
    const taskStore = operational.tasks;
    const missionStore = operational.missions;
    const infrastructure = operational.infrastructure;
    const scheduler = operational.scheduler;
    const secretBroker: SecretBrokerPort = config.secret_broker
      ? new EncryptedFileSecretBroker(config.secret_broker)
      : new UnavailableSecretBroker();
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
        authorize: async (actorId) =>
          boundary.authorize({
            actor_id: actorId,
            action: "intake",
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
        list: () => [
          ...objectStore.list(),
          ...missionStore.listMissions(),
          ...taskStore.listTasks(),
          ...workflowStore.list(),
        ],
      },
      learning,
      boundary,
      { decisionCollectionId: config.decision_collection_id },
      artifactStore,
      config.obsidian
        ? new AuthorizedVaultEvidenceReader(
            {
              baseUrl: config.obsidian.base_url,
              password: options.obsidianPassword ?? "",
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
              password: options.obsidianPassword ?? "",
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
      policyProvenance,
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
      missionStore,
      infrastructure,
      secretBroker,
      scheduler,
      workflowStore,
      artifactStore,
      recoveredWorkflows,
      recoveredExecutions,
      recoveredSchedulerGraphs,
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
