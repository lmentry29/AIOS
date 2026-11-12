import type { HostExecutionConfig } from "../config.js";
import { HostUnavailableError } from "../errors.js";
import { LocalCommandExecutor } from "./command-executor.js";
import { LocalCommandVerifier, type ExecutionLedgerRef } from "./command-verifier.js";
import { loadVerifierDecisionSigner } from "./verifier-decision.js";
import { createSandboxProvider, type SandboxProvider } from "./sandbox.js";
import { RunWorkspaceManager } from "./workspace.js";

export interface LocalExecutionAdapters {
  provider: SandboxProvider;
  workspaces: RunWorkspaceManager;
  execution: LocalCommandExecutor;
  verification: LocalCommandVerifier;
}

/**
 * Composes the production local execution pair.
 *
 * Availability is checked before the host advertises dispatch. If the selected
 * provider cannot establish its boundary, this throws; the CLI logs the reason and
 * starts the host with dispatch disabled rather than falling back to bare `spawn`.
 */
export async function createLocalExecutionAdapters(
  config: HostExecutionConfig,
  ledger?: ExecutionLedgerRef,
): Promise<LocalExecutionAdapters> {
  const provider = createSandboxProvider(config);
  const check = await provider.check();
  if (!check.available) {
    throw new HostUnavailableError(
      `Local execution provider "${provider.id}" is unavailable: ${check.reason}`,
    );
  }
  const workspaces = new RunWorkspaceManager(config.workspace_directory);
  const signer =
    config.verifier_signing_key_file !== undefined &&
    config.verifier_trust_root_file !== undefined &&
    config.verifier_key_id !== undefined
      ? loadVerifierDecisionSigner({
          private_key_file: config.verifier_signing_key_file,
          trust_root_file: config.verifier_trust_root_file,
          key_id: config.verifier_key_id,
        })
      : undefined;
  return {
    provider,
    workspaces,
    execution: new LocalCommandExecutor(config, provider, workspaces),
    verification: new LocalCommandVerifier(config, provider, workspaces, ledger, signer),
  };
}

export { LocalCommandExecutor } from "./command-executor.js";
export { LocalCommandVerifier } from "./command-verifier.js";
export { loadVerifierDecisionSigner, VerifierDecisionSigner } from "./verifier-decision.js";
export type { ExecutionLedgerRef } from "./command-verifier.js";
export { createSandboxProvider } from "./sandbox.js";
export type { SandboxProvider, SandboxResult, SandboxRunSpec } from "./sandbox.js";
export { RunWorkspaceManager } from "./workspace.js";
