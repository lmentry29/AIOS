import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizedVaultEvidenceReader,
  VaultEvidenceAuthorizationError,
  VaultEvidenceChangedError,
  VaultEvidenceError,
  vaultEvidenceSourceId,
} from '../src/obsidian-evidence.js';
import { FounderInterface } from '../src/index.js';

const vaultResourceId = randomUUID();
const password = 'a'.repeat(43);
const authorization = { authorize: vi.fn().mockResolvedValue(true) };

function metadata(path: string, content: string) {
  return {
    path,
    name: path.split('/').at(-1)!.replace(/\.md$/i, ''),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
    frontmatter: { type: 'candidate-memory', tags: ['founder'] },
    frontmatterValid: true,
    frontmatterError: null,
    lastModified: '2026-11-09T12:00:00.000Z',
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    contentBytes: Buffer.byteLength(content, 'utf8'),
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetcher(contentByPath: Record<string, string>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    calls.push({ url, init: init ?? {} });
    if (url.pathname === '/api/vault/evidence') {
      const files = Object.entries(contentByPath).map(([path, content]) => metadata(path, content));
      return response({ files, warnings: [], totalFiles: files.length, lastUpdated: '2026-11-09T12:00:00.000Z' });
    }
    if (url.pathname === '/api/vault/file') {
      const path = url.searchParams.get('path') ?? '';
      const content = contentByPath[path];
      return content === undefined ? response({ error: 'not found' }, 404) : response({ path, content });
    }
    return response({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('AuthorizedVaultEvidenceReader', () => {
  it('accepts only authenticated explicit-port loopback URLs and strong local passwords', () => {
    expect(() => new AuthorizedVaultEvidenceReader({
      baseUrl: 'https://example.com',
      password,
      vaultResourceId,
    }, authorization)).toThrow(VaultEvidenceError);
    expect(() => new AuthorizedVaultEvidenceReader({
      baseUrl: 'http://192.168.1.20:4444',
      password,
      vaultResourceId,
    }, authorization)).toThrow(VaultEvidenceError);
    expect(() => new AuthorizedVaultEvidenceReader({
      baseUrl: 'http://localhost:4444',
      password,
      vaultResourceId,
    }, authorization)).toThrow(VaultEvidenceError);
    expect(() => new AuthorizedVaultEvidenceReader({
      password: 'short',
      vaultResourceId,
    }, authorization)).toThrow(VaultEvidenceError);
  });

  it('authorizes the vault collection before listing metadata or reading note bodies', async () => {
    const { fetcher, calls } = makeFetcher({ '11 AI Memory/founder.md': '# Founder memory' });
    const deniedAuthorization = { authorize: vi.fn().mockResolvedValue(false) };
    const deniedReader = new AuthorizedVaultEvidenceReader({ password, vaultResourceId, fetch: fetcher }, deniedAuthorization);
    await expect(deniedReader.list('human:founder')).rejects.toThrow(VaultEvidenceAuthorizationError);
    expect(deniedAuthorization.authorize).toHaveBeenCalledWith({
      actor_id: 'human:founder',
      action: 'read_evidence',
      resource_id: vaultResourceId,
    });
    expect(calls).toHaveLength(0);

    const allowedAuthorization = { authorize: vi.fn().mockResolvedValue(true) };
    const allowedReader = new AuthorizedVaultEvidenceReader({ password, vaultResourceId, fetch: fetcher }, allowedAuthorization);
    const inventory = await allowedReader.list('human:founder');
    expect(inventory.files).toHaveLength(1);
    expect(inventory.files[0]?.content).toBe('# Founder memory');
    expect(inventory.files[0]?.source_id).toBe(vaultEvidenceSourceId(vaultResourceId, '11 AI Memory/founder.md'));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url.origin).toBe('http://127.0.0.1:4444');
      expect(call.init.method).toBe('GET');
      expect(call.init.redirect).toBe('error');
      expect(call.init.cache).toBe('no-store');
      expect((call.init.headers as Record<string, string>).authorization)
        .toBe(`Basic ${Buffer.from(`local:${password}`).toString('base64')}`);
    }
  });

  it('rejects traversal paths and detects notes changed after the metadata snapshot', async () => {
    const traversalFetcher = vi.fn(async () => response({
      files: [metadata('../outside.md', 'x')],
      warnings: [],
      totalFiles: 1,
      lastUpdated: '2026-11-09T12:00:00.000Z',
    })) as unknown as typeof fetch;
    const traversalReader = new AuthorizedVaultEvidenceReader({ password, vaultResourceId, fetch: traversalFetcher }, authorization);
    await expect(traversalReader.list('human:founder')).rejects.toThrow(VaultEvidenceError);

    const original = '# original';
    const changedFetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof URL ? input.toString() : String(input));
      if (url.pathname === '/api/vault/evidence') {
        const files = [metadata('00 Home/note.md', original)];
        return response({ files, warnings: [], totalFiles: 1, lastUpdated: '2026-11-09T12:00:00.000Z' });
      }
      return response({ path: '00 Home/note.md', content: '# changed' });
    }) as typeof fetch;
    const changedReader = new AuthorizedVaultEvidenceReader({ password, vaultResourceId, fetch: changedFetcher }, authorization);
    await expect(changedReader.list('human:founder')).rejects.toThrow(VaultEvidenceChangedError);
  });

  it('rejects duplicate paths in an evidence inventory', async () => {
    const note = '# duplicate';
    const duplicateFetcher = vi.fn(async () => response({
      files: [metadata('00 Home/note.md', note), metadata('00 Home/note.md', note)],
      warnings: [],
      totalFiles: 2,
      lastUpdated: '2026-11-09T12:00:00.000Z',
    })) as unknown as typeof fetch;
    const reader = new AuthorizedVaultEvidenceReader({ password, vaultResourceId, fetch: duplicateFetcher }, authorization);
    await expect(reader.list('human:founder')).rejects.toThrow(/duplicate path/i);
  });
});

describe('FounderInterface.queryEvidence', () => {
  it('returns all-term matches and warnings without promoting or writing Memory', async () => {
    const evidence = {
      list: vi.fn().mockResolvedValue({
        vault_resource_id: vaultResourceId,
        files: [
          {
            source_id: vaultEvidenceSourceId(vaultResourceId, '11 AI Memory/founder.md'),
            path: '11 AI Memory/founder.md',
            name: 'founder',
            folder: '11 AI Memory',
            frontmatter: { type: 'candidate-memory' },
            frontmatter_valid: true,
            frontmatter_error: null,
            last_modified: '2026-11-09T12:00:00.000Z',
            content_hash: 'a'.repeat(64),
            content_bytes: 30,
            content: 'The founder approved Obsidian persistence.',
          },
          {
            source_id: vaultEvidenceSourceId(vaultResourceId, '00 Home/other.md'),
            path: '00 Home/other.md',
            name: 'other',
            folder: '00 Home',
            frontmatter: {},
            frontmatter_valid: true,
            frontmatter_error: null,
            last_modified: '2026-11-09T12:00:00.000Z',
            content_hash: 'b'.repeat(64),
            content_bytes: 20,
            content: 'Unrelated note.',
          },
        ],
        warnings: [{ path: '11 AI Memory/bad.md', code: 'invalid_frontmatter', message: 'Frontmatter is invalid.' }],
        total_files: 2,
        last_updated: '2026-11-09T12:00:00.000Z',
      }),
    };
    const founder = new FounderInterface(
      { list: () => [] },
      { listByStage: () => [] },
      { authorize: vi.fn().mockResolvedValue(false) },
      { decisionCollectionId: randomUUID() },
      undefined,
      evidence,
    );

    const result = await founder.queryEvidence('founder Obsidian', 'human:founder');
    expect(result.matching_evidence).toHaveLength(1);
    expect(result.matching_evidence[0]?.path).toBe('11 AI Memory/founder.md');
    expect(result.warnings).toHaveLength(1);
    expect(evidence.list).toHaveBeenCalledWith('human:founder');
  });
});
