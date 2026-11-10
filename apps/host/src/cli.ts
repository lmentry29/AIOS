#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadHostConfig } from './config.js';
import { provisionPolicies } from './policy-admin.js';
import { createHostRuntime } from './runtime.js';
import { createHostServer } from './server.js';

/**
 * Local host CLI.
 *
 * `serve` starts the trusted local API. Execution and verification adapters are not
 * configured by the CLI because no production adapter exists yet: dispatch is reported as
 * disabled in `/health` and refused with 503, rather than simulated.
 *
 * `publish-policy` is the human-only offline bootstrap path. It must run with the host
 * stopped, because the durable registry holds a single-process lock.
 */
const USAGE = `Usage:
  aios-host serve --config <absolute-config-path>
  aios-host publish-policy --config <absolute-config-path> --policy <absolute-policy-path>
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

  const runtime = createHostRuntime({
    config,
    ...(obsidianPassword === undefined ? {} : { obsidianPassword }),
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
  process.stdout.write(USAGE);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  writeStartupFailure(error instanceof Error ? error.message : 'Unknown startup error.');
  process.exitCode = 1;
});
