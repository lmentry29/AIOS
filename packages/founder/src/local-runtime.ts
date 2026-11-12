import { AuthorizationService } from "./authorization.js";
import { FilePolicyRegistry } from "./file-policy-registry.js";
import { AuthorizedLocalConnectorEvidenceReader } from "./local-connectors.js";
import { AuthorizedVaultEvidenceReader } from "./obsidian-evidence.js";

export interface LocalEvidenceRuntimeOptions {
  /** Absolute path to the local policy/audit file in a dedicated owner-only directory. */
  policyFilePath: string;
  /** Resource IDs must be separately provisioned and explicitly attached to policies. */
  vaultResourceId: string;
  gmailResourceId: string;
  notionResourceId: string;
  obsidianBaseUrl?: string;
  obsidianPassword: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface LocalEvidenceRuntime {
  policies: FilePolicyRegistry;
  authorization: AuthorizationService;
  vault: AuthorizedVaultEvidenceReader;
  connectors: AuthorizedLocalConnectorEvidenceReader;
  close(): void;
}

/**
 * Composes durable default-deny authorization with the three local read-only evidence
 * sources. It intentionally does not create or attach policies; the trusted host must
 * provision explicit resource grants through PolicyAdministrationService.
 */
export function createLocalEvidenceRuntime(
  options: LocalEvidenceRuntimeOptions,
): LocalEvidenceRuntime {
  if (
    new Set([options.vaultResourceId, options.gmailResourceId, options.notionResourceId]).size !== 3
  ) {
    throw new Error("Vault, Gmail, and Notion must use three distinct resource UUIDs.");
  }
  const policies = new FilePolicyRegistry({ filePath: options.policyFilePath });
  try {
    const authorization = new AuthorizationService(
      policies,
      (resourceId) => policies.resolve(resourceId),
      policies,
    );
    const vault = new AuthorizedVaultEvidenceReader(
      {
        baseUrl: options.obsidianBaseUrl ?? "http://127.0.0.1:4444",
        password: options.obsidianPassword,
        vaultResourceId: options.vaultResourceId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        timeoutMs: options.timeoutMs ?? 10_000,
      },
      authorization,
    );
    const connectors = new AuthorizedLocalConnectorEvidenceReader(
      {
        baseUrl: options.obsidianBaseUrl ?? "http://127.0.0.1:4444",
        password: options.obsidianPassword,
        gmailResourceId: options.gmailResourceId,
        notionResourceId: options.notionResourceId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        timeoutMs: options.timeoutMs ?? 10_000,
      },
      authorization,
    );
    return {
      policies,
      authorization,
      vault,
      connectors,
      close: () => policies.close(),
    };
  } catch (error) {
    policies.close();
    throw error;
  }
}
