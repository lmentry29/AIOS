#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadHostConfig } from './config.js';
import { AppendOnlyJournal } from './persistence/journal.js';
import { DurableOperationalStore } from './persistence/operational-store.js';
import { createLocalExecutionAdapters, type ExecutionLedgerRef } from './execution/index.js';
import { provisionPolicies, revokePolicies } from './policy-admin.js';
import { runOperatorSessionCommand } from './operator-session.js';
import { createHostRuntime } from './runtime.js';
import { createHostServer } from './server.js';

/**
 * Local host CLI.
 *
 * `serve` starts the trusted local API. When `execution` is configured, the CLI
 * composes a real fixed-command executor and a distinct independent verifier through
 * one of the supported isolation providers. If the provider cannot establish its
 * boundary, the host still starts but reports dispatch disabled and refuses dispatch
 * with 503; it never falls back to an unsandboxed process.
 *
 * `publish-policy` and `revoke-policy` are the human-only offline bootstrap paths. They
 * must run with the host stopped, because the durable registry holds a single-process lock.
 */
const USAGE = `Usage:
  aios-host serve --config <absolute-config-path>
  aios-host publish-policy --config <absolute-config-path> --policy <absolute-policy-path>
  aios-host revoke-policy --config <absolute-config-path> --revocation <absolute-revocation-path>
  aios-host compact-journal --config <absolute-config-path> --archive <absolute-archive-path>
  aios-host restore-journal --config <absolute-config-path> --archive <absolute-archive-path>
  aios-host list-sessions --config <absolute-config-path> --token-file <owner-only-token-file>
  aios-host rotate-session --config <absolute-config-path> --token-file <owner-only-token-file> --session-id <uuid>
  aios-host revoke-session --config <absolute-config-path> --token-file <owner-only-token-file> --session-id <uuid>
`;

function writeStartupFailure(message: string): void {
  process.stderr.write(`${JSON.stringify({ event: 'host_start_failed', error: message })}\n`);
}

async function serve(configPath: string): Promise<void> {
  const config = loadHostConfig(configPath);
  const obsidianPassword = process.env.AIOS_OBSIDIAN_PASSWORD;
  if (config.obsidian && (obsidianPassword === undefined || Buffer.byteLength(obsidianPassword) < 32)) {
    throw new Error('AIOS_OBSIDIAN_PASSWORD must contain at least 32 bytes when evidence readers are configured.');
  }

  let adapters: Awaited<ReturnType<typeof createLocalExecutionAdapters>> | undefined;
  // The verifier must bind to the runtime's durable ledger, but the ledger is created
  // inside the runtime after the sandbox adapters. A late-bound reference keeps the
  // dependency acyclic without weakening the binding: it is populated before listen().
  const executionLedger: ExecutionLedgerRef = {};
  if (config.execution) {
    try {
      adapters = await createLocalExecutionAdapters(config.execution, executionLedger);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: 'execution_unavailable',
        reason: error instanceof Error ? error.message : 'Local execution provider could not be initialized.',
      })}\n`);
    }
  }

  const runtime = createHostRuntime({
    config,
    ...(obsidianPassword === undefined ? {} : { obsidianPassword }),
    ...(adapters === undefined
      ? {}
      : {
          execution: adapters.execution,
          verification: adapters.verification,
          resolveAgent: async () => config.execution?.agent_id ?? '',
        }),
  });
  executionLedger.current = runtime.executions;
  const server = createHostServer(runtime);
  try {
    const address = await server.listen();
    process.stdout.write(`${JSON.stringify({
      event: 'host_started',
      host: address.host,
      port: address.port,
      authorization: 'shared',
      dispatch: runtime.executionConfigured && runtime.verificationConfigured,
      execution_provider: adapters?.provider.id ?? null,
      evidence: runtime.evidenceConfigured,
    })}\n`);
  } catch (error) {
    runtime.close();
    throw error;
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ event: 'host_stopping', signal })}\n`);
    try {
      await server.close();
    } finally {
      runtime.close();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      policy: { type: 'string' },
      revocation: { type: 'string' },
      archive: { type: 'string' },
      'token-file': { type: 'string' },
      'session-id': { type: 'string' },
    },
  });
  const command = parsed.positionals[0];
  if (command === 'serve') {
    if (!parsed.values.config) throw new Error('serve requires --config.');
    await serve(parsed.values.config);
    return;
  }
  if (command === 'publish-policy') {
    if (!parsed.values.config || !parsed.values.policy) {
      throw new Error('publish-policy requires --config and --policy.');
    }
    const result = await provisionPolicies({
      configPath: parsed.values.config,
      provisioningPath: parsed.values.policy,
    });
    process.stdout.write(`${JSON.stringify({ event: 'policy_published', ...result })}\n`);
    return;
  }
  if (command === 'compact-journal') {
    if (!parsed.values.config || !parsed.values.archive) {
      throw new Error('compact-journal requires --config and --archive.');
    }
    const config = loadHostConfig(parsed.values.config);
    // Must run with the host stopped: the journal holds a single-process lock.
    const store = new DurableOperationalStore({
      directory: config.operational_store.directory,
      sessions: config.sessions,
    });
    try {
      const result = store.compact(parsed.values.archive);
      process.stdout.write(`${JSON.stringify({ event: 'journal_compacted', ...result })}\n`);
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'restore-journal') {
    if (!parsed.values.config || !parsed.values.archive) {
      throw new Error('restore-journal requires --config and --archive.');
    }
    const config = loadHostConfig(parsed.values.config);
    const result = AppendOnlyJournal.restore({
      filePath: join(config.operational_store.directory, 'operational.jsonl'),
      archivePath: parsed.values.archive,
    });
    process.stdout.write(`${JSON.stringify({ event: 'journal_restored', ...result })}\n`);
    return;
  }
  if (command === 'revoke-policy') {
    if (!parsed.values.config || !parsed.values.revocation) {
      throw new Error('revoke-policy requires --config and --revocation.');
    }
    const result = await revokePolicies({
      configPath: parsed.values.config,
      revocationPath: parsed.values.revocation,
    });
    process.stdout.write(`${JSON.stringify({ event: 'policy_revoked', ...result })}\n`);
    return;
  }
  if (command === 'list-sessions' || command === 'rotate-session' || command === 'revoke-session') {
    process.exitCode = await runOperatorSessionCommand(command, {
      ...(parsed.values.config === undefined ? {} : { configPath: parsed.values.config }),
      ...(parsed.values['token-file'] === undefined ? {} : { tokenFile: parsed.values['token-file'] }),
      ...(parsed.values['session-id'] === undefined ? {} : { sessionId: parsed.values['session-id'] }),
    });
    return;
  }
  process.stdout.write(USAGE);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  writeStartupFailure(error instanceof Error ? error.message : 'Unknown startup error.');
  process.exitCode = 1;
});
