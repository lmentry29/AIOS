import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostConfigError } from '../src/errors.js';
import { loadHostConfig, parseHostConfig } from '../src/config.js';
import {
  DECISION_COLLECTION_ID,
  FOUNDER,
  GMAIL_RESOURCE_ID,
  NOTION_RESOURCE_ID,
  VAULT_RESOURCE_ID,
  sessionExpiresAt,
} from './fixtures.js';

const TOKEN_HASH = createHash('sha256').update('founder-token-0123456789abcdef').digest('hex');

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'aios-host-config-'));
  return {
    schema_version: 1,
    bind: { host: '127.0.0.1', port: 0 },
    policy_file: join(directory, 'policy-state.json'),
    policy_provenance: {
      trust_root_file: join(directory, 'policy-trust-root.json'),
      signing_key_file: join(directory, 'policy-signing-key.pem'),
      key_id: 'a'.repeat(64),
    },
    operational_store: { directory: join(directory, 'operational') },
    decision_collection_id: DECISION_COLLECTION_ID,
    resources: {
      vault: VAULT_RESOURCE_ID,
      gmail: GMAIL_RESOURCE_ID,
      notion: NOTION_RESOURCE_ID,
    },
    bootstrap_principal_id: FOUNDER,
    sessions: [
      {
        session_id: randomUUID(),
        principal_id: FOUNDER,
        token_sha256: TOKEN_HASH,
        label: 'founder laptop',
        expires_at: sessionExpiresAt(),
      },
    ],
    ...overrides,
  };
}

function writeRawConfig(contents: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'aios-host-load-'));
  const path = join(directory, 'host.json');
  writeFileSync(path, contents, { mode });
  return path;
}

function writeConfig(document: unknown, mode = 0o600): string {
  return writeRawConfig(JSON.stringify(document), mode);
}

describe('host configuration', () => {
  it('accepts a loopback, owner-only document and applies safe defaults', () => {
    const parsed = parseHostConfig(validConfig());
    expect(parsed.bind).toEqual({ host: '127.0.0.1', port: 0 });
    expect(parsed.request_body_limit_bytes).toBe(256 * 1024);
    expect(parsed.dispatch_lease_ms).toBe(5 * 60 * 1000);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.principal_id).toBe(FOUNDER);
  });

  it('normalizes a loopback Obsidian++ URL and rejects any other shape', () => {
    expect(parseHostConfig(validConfig({ obsidian: { base_url: 'http://127.0.0.1:4444' } })).obsidian)
      .toEqual({ base_url: 'http://127.0.0.1:4444' });
    expect(() => parseHostConfig(validConfig({ obsidian: { base_url: 'http://example.com:4444' } })))
      .toThrow(HostConfigError);
    expect(() => parseHostConfig(validConfig({ obsidian: { base_url: 'https://127.0.0.1:4444' } })))
      .toThrow(HostConfigError);
    expect(() => parseHostConfig(validConfig({ obsidian: { base_url: 'http://127.0.0.1:4444/vault' } })))
      .toThrow(HostConfigError);
  });

  it('parses a fixed local execution and verification pair without allowing provider injection', () => {
    const parsed = parseHostConfig(validConfig({
      execution: {
        workspace_directory: join(tmpdir(), 'aios-workspaces'),
        agent_id: '11111111-1111-4111-8111-111111111111',
        verifier_id: '22222222-2222-4222-8222-222222222222',
        provider: 'docker',
        image: 'node:22-alpine',
      },
    }));
    expect(parsed.execution).toMatchObject({
      provider: 'docker',
      image: 'node:22-alpine',
      default_timeout_ms: 60_000,
      max_output_bytes: 64 * 1024,
      workspace_max_bytes: 256 * 1024 * 1024,
      max_concurrent_tasks: 1,
    });
    expect(parseHostConfig(validConfig({
      execution: {
        workspace_directory: join(tmpdir(), 'aios-workspaces'),
        agent_id: '11111111-1111-4111-8111-111111111111',
        verifier_id: '22222222-2222-4222-8222-222222222222',
        provider: 'bubblewrap',
        max_concurrent_tasks: 4,
      },
    })).execution?.max_concurrent_tasks).toBe(4);
  });

  it('requires complete verifier signing configuration and validates its key id', () => {
    const execution = {
      workspace_directory: join(tmpdir(), 'aios-workspaces'),
      agent_id: '11111111-1111-4111-8111-111111111111',
      verifier_id: '22222222-2222-4222-8222-222222222222',
      provider: 'bubblewrap',
      verifier_signing_key_file: '/tmp/verifier.pem',
      verifier_trust_root_file: '/tmp/trust-root.json',
      verifier_key_id: 'a'.repeat(64),
    };
    expect(parseHostConfig(validConfig({ execution })).execution).toMatchObject({
      verifier_signing_key_file: '/tmp/verifier.pem',
      verifier_trust_root_file: '/tmp/trust-root.json',
      verifier_key_id: 'a'.repeat(64),
    });
    expect(() => parseHostConfig(validConfig({
      execution: { ...execution, verifier_key_id: undefined },
    }))).toThrow(HostConfigError);
    expect(() => parseHostConfig(validConfig({
      execution: { ...execution, verifier_key_id: 'not-a-digest' },
    }))).toThrow(HostConfigError);
  });

  it('parses explicit gVisor provider wiring and rejects ambiguous rootfs selection', () => {
    const base = {
      workspace_directory: join(tmpdir(), 'aios-workspaces'),
      agent_id: '11111111-1111-4111-8111-111111111111',
      verifier_id: '22222222-2222-4222-8222-222222222222',
    };
    expect(parseHostConfig(validConfig({
      execution: { ...base, provider: 'gvisor', rootfs: '/tmp/aios-gvisor-rootfs' },
    })).execution).toMatchObject({
      provider: 'gvisor',
      rootfs: '/tmp/aios-gvisor-rootfs',
    });
    expect(() => parseHostConfig(validConfig({ execution: { ...base, provider: 'gvisor' } })))
      .toThrow(/rootfs/);
    expect(() => parseHostConfig(validConfig({
      execution: { ...base, provider: 'docker', image: 'node:22-alpine', rootfs: '/tmp/rootfs' },
    }))).toThrow(/rootfs/);
    expect(() => parseHostConfig(validConfig({
      execution: { ...base, provider: 'bubblewrap', rootfs: '/tmp/rootfs' },
    }))).toThrow(/rootfs/);
  });

  it('rejects an execution verifier that is also the executor and unsafe provider wiring', () => {
    const base = {
      workspace_directory: join(tmpdir(), 'aios-workspaces'),
      agent_id: '11111111-1111-4111-8111-111111111111',
      verifier_id: '22222222-2222-4222-8222-222222222222',
      provider: 'docker',
      image: 'node:22-alpine',
    };
    expect(() => parseHostConfig(validConfig({ execution: { ...base, verifier_id: base.agent_id } })))
      .toThrow(/must differ/);
    expect(() => parseHostConfig(validConfig({ execution: { ...base, image: undefined } })))
      .toThrow(/image/);
    expect(() => parseHostConfig(validConfig({ execution: { ...base, image: 'node:22-alpine; rm -rf /' } })))
      .toThrow(/image/);
    expect(() => parseHostConfig(validConfig({ execution: { ...base, provider: 'process' } })))
      .toThrow(/provider/);
    for (const invalid of [0, 33, 1.5, '2']) {
      expect(() => parseHostConfig(validConfig({ execution: { ...base, max_concurrent_tasks: invalid } })))
        .toThrow(/max_concurrent_tasks/);
    }
    expect(parseHostConfig(validConfig({ execution: { ...base, workspace_max_bytes: 1024 } }))
      .execution?.workspace_max_bytes).toBe(1024);
    for (const invalid of [0, 1023, 8 * 1024 * 1024 * 1024 + 1, 1.5, '1024']) {
      expect(() => parseHostConfig(validConfig({ execution: { ...base, workspace_max_bytes: invalid } })))
        .toThrow(/workspace_max_bytes/);
    }
    expect(() => parseHostConfig(validConfig({ execution: { ...base, image: undefined, provider: 'bubblewrap' } })))
      .not.toThrow();
  });

  it('refuses to bind anything other than a literal loopback address', () => {
    expect(() => parseHostConfig(validConfig({ bind: { host: '0.0.0.0', port: 4780 } })))
      .toThrow(/loopback/);
    expect(() => parseHostConfig(validConfig({ bind: { host: 'localhost', port: 4780 } })))
      .toThrow(/loopback/);
    expect(() => parseHostConfig(validConfig({ bind: { host: '::', port: 4780 } })))
      .toThrow(/loopback/);
  });

  it('rejects a plaintext token field instead of ignoring it', () => {
    const sessions = [{
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token: 'founder-token-0123456789abcdef',
    }];
    // The unknown field is rejected outright, so a plaintext token can never be ignored
    // in favour of a missing digest.
    expect(() => parseHostConfig(validConfig({ sessions }))).toThrow(/unsupported field "token"/);
  });

  it('rejects duplicate session digests and duplicate session identifiers', () => {
    const session = {
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: TOKEN_HASH,
      expires_at: sessionExpiresAt(),
    };
    expect(() => parseHostConfig(validConfig({ sessions: [session, { ...session, session_id: randomUUID() }] })))
      .toThrow(/duplicates another session/);
    expect(() => parseHostConfig(validConfig({ sessions: [session, { ...session, token_sha256: 'a'.repeat(64) }] })))
      .toThrow(/duplicates another session/);
  });

  it('requires a human bootstrap principal with a configured session', () => {
    expect(() => parseHostConfig(validConfig({ bootstrap_principal_id: randomUUID() })))
      .toThrow(/human principal/);
    expect(() => parseHostConfig(validConfig({ bootstrap_principal_id: 'human:other' })))
      .toThrow(/bootstrap_principal_id/);
  });

  it('requires three distinct evidence resource UUIDs and an absolute policy path', () => {
    expect(() => parseHostConfig(validConfig({
      resources: { vault: VAULT_RESOURCE_ID, gmail: VAULT_RESOURCE_ID, notion: NOTION_RESOURCE_ID },
    }))).toThrow(/distinct/);
    expect(() => parseHostConfig(validConfig({ policy_file: 'relative/policy.json' })))
      .toThrow(/absolute/);
  });

  it('requires an absolute operational-store directory and a bounded dispatch lease', () => {
    expect(() => parseHostConfig(validConfig({ operational_store: { directory: 'relative/state' } })))
      .toThrow(/operational_store.directory/);
    expect(() => parseHostConfig(validConfig({ operational_store: {} })))
      .toThrow(/operational_store.directory/);
    expect(() => parseHostConfig(validConfig({ operational_store: { directory: '/tmp/x', extra: true } })))
      .toThrow(/unsupported field/);
    expect(() => parseHostConfig(validConfig({ dispatch_lease_ms: 1_000 })))
      .toThrow(/dispatch_lease_ms/);
    expect(() => parseHostConfig(validConfig({ dispatch_lease_ms: 60 * 60 * 1000 + 1 })))
      .toThrow(/dispatch_lease_ms/);
  });

  it('rejects an expired-session timestamp it cannot parse', () => {
    const sessions = [{
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: TOKEN_HASH,
      expires_at: 'tomorrow-ish',
    }];
    expect(() => parseHostConfig(validConfig({ sessions }))).toThrow(/ISO-8601/);
  });

  it('requires every session to expire inside the bounded thirty-day lifetime', () => {
    const now = Date.parse('2026-11-11T00:00:00.000Z');
    const base = {
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: TOKEN_HASH,
    };
    expect(() => parseHostConfig(validConfig({ sessions: [base] }), now)).toThrow(/expires_at/);
    expect(() => parseHostConfig({
      ...validConfig({
        sessions: [{ ...base, expires_at: new Date(now + 31 * 24 * 60 * 60 * 1000).toISOString() }],
      }),
    }, now)).toThrow(/milliseconds/);
    // A past seed expiry is accepted so a later rotated generation can outlive it; the
    // seed itself is rejected by authentication once expired.
    expect(parseHostConfig(validConfig({
      sessions: [{ ...base, expires_at: new Date(now - 1).toISOString() }],
    }), now).sessions[0]?.expires_at).toBe(new Date(now - 1).toISOString());
  });

  it('loads a 0600 regular file and refuses a readable-by-others file', () => {
    expect(loadHostConfig(writeConfig(validConfig(), 0o600)).bootstrap_principal_id).toBe(FOUNDER);
    expect(() => loadHostConfig(writeConfig(validConfig(), 0o644))).toThrow(/owner-only/);
  });

  it('refuses a symlinked or non-JSON configuration file', () => {
    const target = writeConfig(validConfig(), 0o600);
    const directory = mkdtempSync(join(tmpdir(), 'aios-host-link-'));
    const link = join(directory, 'host.json');
    symlinkSync(target, link);
    expect(() => loadHostConfig(link)).toThrow(/symlink/);
    expect(() => loadHostConfig(writeRawConfig('{ not json', 0o600))).toThrow(/valid JSON/);
  });
});
