#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadHostConfig } from './config.js';
import { createLocalExecutionAdapters } from './execution/index.js';
import { provisionPolicies, revokePolicies } from './policy-admin.js';
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
  if (config.execution) {
    try {
      adapters = await createLocalExecutionAdapters(config.execution);
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
  process.stdout.write(USAGE);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  writeStartupFailure(error instanceof Error ? error.message : 'Unknown startup error.');
  process.exitCode = 1;
});
