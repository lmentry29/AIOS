import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessPolicy } from '@aios/founder';
import { FilePolicyRegistry, PolicyAdministrationService } from '@aios/founder';
import { loadHostConfig } from '../src/config.js';
import { runOperatorSessionCommand, type OperatorSessionCommand } from '../src/operator-session.js';
import { createHostRuntime, type HostRuntime } from '../src/runtime.js';
import { createHostServer, type HostHttpServer } from '../src/server.js';
import { createPolicyAuthority } from './policy-provenance-fixture.js';
import {
  AGENT_ID,
  AGENT_TOKEN,
  DECISION_COLLECTION_ID,
  FOUNDER,
  FOUNDER_TOKEN,
  GMAIL_RESOURCE_ID,
  NOTION_RESOURCE_ID,
  OPERATOR,
  OPERATOR_TOKEN,
  VAULT_RESOURCE_ID,
  sessionExpiresAt,
} from './fixtures.js';

const FOUNDER_SESSION_ID = '00000000-0000-4000-8000-000000000101';
const OPERATOR_SESSION_ID = '00000000-0000-4000-8000-000000000102';
const AGENT_SESSION_ID = '00000000-0000-4000-8000-000000000103';
const MISSING_SESSION_ID = '00000000-0000-4000-8000-000000000199';
const WRONG_TOKEN = 'wrong-token-0123456789abcdef';

interface Harness {
  configPath: string;
  operationalDirectory: string;
  port: number;
  runtime: HostRuntime;
  server: HostHttpServer;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function startHost(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'aios-session-operator-'));
  const configPath = join(directory, 'host.json');
  const policyPath = join(directory, 'policy-state.json');
  const operationalDirectory = join(directory, 'operational');
  const policyAuthority = createPolicyAuthority(directory);
  writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    bind: { host: '127.0.0.1', port: 0 },
    policy_file: policyPath,
    policy_provenance: policyAuthority.config,
    operational_store: { directory: operationalDirectory },
    dispatch_lease_ms: 5_000,
    decision_collection_id: DECISION_COLLECTION_ID,
    resources: { vault: VAULT_RESOURCE_ID, gmail: GMAIL_RESOURCE_ID, notion: NOTION_RESOURCE_ID },
    bootstrap_principal_id: FOUNDER,
    sessions: [
      { session_id: FOUNDER_SESSION_ID, principal_id: FOUNDER, token_sha256: digest(FOUNDER_TOKEN), label: 'founder laptop', expires_at: sessionExpiresAt() },
      { session_id: OPERATOR_SESSION_ID, principal_id: OPERATOR, token_sha256: digest(OPERATOR_TOKEN), label: 'operator', expires_at: sessionExpiresAt() },
      { session_id: AGENT_SESSION_ID, principal_id: AGENT_ID, token_sha256: digest(AGENT_TOKEN), label: 'agent worker', expires_at: sessionExpiresAt() },
    ],
  }), { mode: 0o600 });

  const policy: AccessPolicy = {
    policy_id: randomUUID(),
    version: 1,
    rules: [{
      effect: 'allow',
      subject_ids: [FOUNDER],
      actions: ['administer_sessions'],
      resource_ids: [FOUNDER_SESSION_ID, OPERATOR_SESSION_ID, AGENT_SESSION_ID, MISSING_SESSION_ID],
    }],
  };
  const registry = new FilePolicyRegistry({ filePath: policyPath });
  try {
    const administration = new PolicyAdministrationService(FOUNDER, registry, registry);
    const signed = await policyAuthority.authority.signPolicy(policy);
    await administration.publish(signed, FOUNDER);
    for (const resourceId of new Set(policy.rules.flatMap((rule) => [...rule.resource_ids]))) {
      await administration.attach(resourceId, signed.policy_id, FOUNDER);
    }
  } finally {
    registry.close();
  }

  const runtime = createHostRuntime({ config: loadHostConfig(configPath) });
  const server = createHostServer(runtime);
  const address = await server.listen();
  // The CLI reads the config; replace the ephemeral listener port with the real one.
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { bind: { port: number } };
  raw.bind.port = address.port;
  writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });

  const harness: Harness = { configPath, operationalDirectory, port: address.port, runtime, server };
  cleanups.push(async () => {
    await harness.server.close();
    harness.runtime.close();
  });
  return harness;
}

async function restart(harness: Harness): Promise<void> {
  await harness.server.close();
  harness.runtime.close();
  // Bind a fresh ephemeral port so an undici keep-alive socket from the prior server
  // cannot be mistaken for the restarted process in this test harness.
  const before = JSON.parse(readFileSync(harness.configPath, 'utf8')) as { bind: { port: number } };
  before.bind.port = 0;
  writeFileSync(harness.configPath, JSON.stringify(before), { mode: 0o600 });
  harness.runtime = createHostRuntime({ config: loadHostConfig(harness.configPath) });
  harness.server = createHostServer(harness.runtime);
  const address = await harness.server.listen();
  harness.port = address.port;
  const after = JSON.parse(readFileSync(harness.configPath, 'utf8')) as { bind: { port: number } };
  after.bind.port = address.port;
  writeFileSync(harness.configPath, JSON.stringify(after), { mode: 0o600 });
}

function tokenFile(directory: string, name: string, token: string): string {
  const path = join(directory, `${name}.token`);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}

async function cli(
  harness: Harness,
  command: OperatorSessionCommand,
  tokenPath: string,
  sessionId?: string,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runOperatorSessionCommand(command, {
    configPath: harness.configPath,
    tokenFile: tokenPath,
    ...(sessionId === undefined ? {} : { sessionId }),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  const output = stdout.join('\n');
  const errors = stderr.join('\n');
  const structured = output.length === 0 ? errors : output;
  return {
    code,
    stdout: output,
    stderr: errors,
    ...(structured.length === 0 ? {} : { json: JSON.parse(structured) as Record<string, unknown> }),
  };
}

async function session(harness: Harness, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://${harness.runtime.config.bind.host}:${harness.port}/v1/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('operator session administration', () => {
  it('lists live sessions without digests and rotates a target through the live host', async () => {
    const harness = await startHost();
    const founderToken = tokenFile(harness.operationalDirectory, 'founder', FOUNDER_TOKEN);
    const listed = await cli(harness, 'list-sessions', founderToken);
    expect(listed.code).toBe(0);
    expect(listed.json?.event).toBe('session_listed');
    expect(listed.json?.total).toBe(3);
    const sessions = listed.json?.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((entry) => entry.session_id)).toEqual([
      FOUNDER_SESSION_ID,
      OPERATOR_SESSION_ID,
      AGENT_SESSION_ID,
    ]);
    expect(listed.stdout).not.toMatch(/[a-f0-9]{64}/);

    const rotated = await cli(harness, 'rotate-session', founderToken, OPERATOR_SESSION_ID);
    expect(rotated.code).toBe(0);
    const newToken = rotated.json?.token;
    expect(typeof newToken).toBe('string');
    expect(rotated.json?.generation).toBe(2);
    expect(rotated.stdout.split(newToken as string)).toHaveLength(2);
    expect(rotated.stderr).not.toContain(OPERATOR_TOKEN);
    expect(rotated.stderr).not.toContain(newToken as string);
    expect(rotated.stdout).not.toContain(OPERATOR_TOKEN);

    const journal = readFileSync(join(harness.operationalDirectory, 'operational.jsonl'), 'utf8');
    expect(journal).not.toContain(newToken as string);
    expect(journal).not.toContain(OPERATOR_TOKEN);

    const old = await session(harness, OPERATOR_TOKEN);
    expect(old.status).toBe(401);
    expect(old.body.reason).toBe('rotated_token');
    const current = await session(harness, newToken as string);
    expect(current.status).toBe(200);
    expect(current.body.generation).toBe(2);

    await restart(harness);
    expect((await session(harness, OPERATOR_TOKEN)).body.reason).toBe('rotated_token');
    expect((await session(harness, newToken as string)).status).toBe(200);
  });

  it('revokes through the live host, survives restart, and is idempotent', async () => {
    const harness = await startHost();
    const founderToken = tokenFile(harness.operationalDirectory, 'founder-revoke', FOUNDER_TOKEN);
    const revoked = await cli(harness, 'revoke-session', founderToken, AGENT_SESSION_ID);
    expect(revoked.code).toBe(0);
    expect(revoked.json?.event).toBe('session_revoked');
    expect(revoked.json?.already_revoked).toBe(false);
    const denied = await session(harness, AGENT_TOKEN);
    expect(denied.status).toBe(401);
    expect(denied.body.reason).toBe('revoked_token');

    await restart(harness);
    expect((await session(harness, AGENT_TOKEN)).body.reason).toBe('revoked_token');

    const repeated = await cli(harness, 'revoke-session', founderToken, AGENT_SESSION_ID);
    expect(repeated.code).toBe(0);
    expect(repeated.json?.already_revoked).toBe(true);
    const rotateRevoked = await cli(harness, 'rotate-session', founderToken, AGENT_SESSION_ID);
    expect(rotateRevoked.code).toBe(5);
    expect(rotateRevoked.json?.error).toBe('session_conflict');
    expect(rotateRevoked.stderr).not.toContain(AGENT_TOKEN);
  });

  it('uses distinct denied, not-found, retired, and usage exit codes', async () => {
    const harness = await startHost();
    const founderToken = tokenFile(harness.operationalDirectory, 'founder-codes', FOUNDER_TOKEN);
    const wrongToken = tokenFile(harness.operationalDirectory, 'wrong', WRONG_TOKEN);
    const agentToken = tokenFile(harness.operationalDirectory, 'agent', AGENT_TOKEN);

    const denied = await cli(harness, 'list-sessions', wrongToken);
    expect(denied.code).toBe(3);
    expect(denied.json?.reason).toBe('unknown_token');
    const unauthorized = await cli(harness, 'list-sessions', agentToken);
    expect(unauthorized.code).toBe(3);
    expect(unauthorized.json?.error).toBe('human_principal_required');

    const missing = await cli(harness, 'revoke-session', founderToken, MISSING_SESSION_ID);
    expect(missing.code).toBe(4);
    expect(missing.json?.error).toBe('session_not_found');

    const malformed = await cli(harness, 'rotate-session', founderToken, 'not-a-uuid');
    expect(malformed.code).toBe(2);
    expect(malformed.json?.error).toMatch(/session-id/);
  });

  it('does not let a scoped token use the admin surface', async () => {
    const harness = await startHost();
    const founderToken = tokenFile(harness.operationalDirectory, 'founder-scope', FOUNDER_TOKEN);
    const scopedResponse = await fetch(`http://${harness.runtime.config.bind.host}:${harness.port}/v1/session/rotate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${FOUNDER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ scope: { task_id: randomUUID() } }),
    });
    expect(scopedResponse.status).toBe(200);
    const scoped = await scopedResponse.json() as { token: string };
    const scopedToken = tokenFile(harness.operationalDirectory, 'scoped', scoped.token);

    const denied = await cli(harness, 'list-sessions', scopedToken);
    expect(denied.code).toBe(3);
    expect(denied.json?.reason).toBe('scope_binding_required');
  });
});
