import type { ArtifactEntity, CanonicalEntity, TaskEntity, WorkflowEntity } from '@aios/core';
import { ArtifactEntity as ArtifactSchema, CanonicalEntity as CanonicalEntitySchema, WorkflowEntity as WorkflowSchema } from '@aios/core';
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
import { TaskStore } from '@aios/work-hierarchy';
import { SharedAuthorizationBoundary } from './authorization.js';
import type { HostConfig } from './config.js';
import { HostUnavailableError } from './errors.js';
import { TrustedIdentityService } from './identity.js';

const UNCONFIGURED_VERIFIER_ID = '00000000-0000-4000-8000-000000000000';

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
  taskStore: TaskStore;
  workflowStore: ObjectStore<WorkflowEntity>;
  artifactStore: ObjectStore<ArtifactEntity>;
  executionConfigured: boolean;
  verificationConfigured: boolean;
  evidenceConfigured: boolean;
  close(): void;
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
 * - Operational stores (Tasks, Workflows, Artifacts, learning records) are still the
 *   in-memory adapters. Durable operational persistence, leases, retries, and crash recovery
 *   remain open; this factory does not pretend otherwise.
 * - No execution or verification adapter is invented. Missing adapters fail closed.
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
  try {
    const authorization = new AuthorizationService(
      policies,
      (resourceId) => policies.resolve(resourceId),
      policies,
    );
    const boundary = new SharedAuthorizationBoundary(authorization);
    const identity = new TrustedIdentityService(config.sessions);

    const taskStore = new TaskStore();
    const workflowStore = new ObjectStore<WorkflowEntity>(WorkflowSchema);
    const artifactStore = new ObjectStore<ArtifactEntity>(ArtifactSchema);
    const objectStore = new ObjectStore<CanonicalEntity>(CanonicalEntitySchema);
    const learning = new LearningService();

    const execution = options.execution ?? new UnconfiguredExecutionPort();
    const verification = options.verification ?? new UnconfiguredVerificationPort();

    const kernel = new OrchestrationKernel(
      taskStore,
      {
        authorization: boundary,
        execution,
        verification,
        resolveAgent: resolveAgentUnlessConfigured(options.resolveAgent),
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
      taskStore,
      workflowStore,
      artifactStore,
      executionConfigured: options.execution !== undefined,
      verificationConfigured: options.verification !== undefined,
      evidenceConfigured: config.obsidian !== undefined,
      close: () => policies.close(),
    };
  } catch (error) {
    policies.close();
    throw error;
  }
}
