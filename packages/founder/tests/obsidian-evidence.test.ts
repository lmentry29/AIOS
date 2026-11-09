import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizedVaultEvidenceReader,
  ObsidianVaultEvidenceAdapter,
  VaultEvidenceAuthorizationError,
  VaultEvidenceChangedError,
  VaultEvidenceError,
  vaultEvidenceSourceId,
} from '../src/obsidian-evidence.js';
import { FounderInterface } from '../src/index.js';

const vaultResourceId = randomUUID();
const password = 'a'.repeat(43);

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

describe('ObsidianVaultEvidenceAdapter', () => {
  it('accepts only authenticated explicit-port loopback URLs and strong local passwords', () => {
    expect(() => new ObsidianVaultEvidenceAdapter({
      baseUrl: 'https://example.com',
      password,
      vaultResourceId,
    })).toThrow(VaultEvidenceError);
    expect(() => new ObsidianVaultEvidenceAdapter({
      baseUrl: 'http://192.168.1.20:4444',
      password,
      vaultResourceId,
    })).toThrow(VaultEvidenceError);
    expect(() => new ObsidianVaultEvidenceAdapter({
      password: 'short',
      vaultResourceId,
    })).toThrow(VaultEvidenceError);
  });

  it('lists metadata and reads note bodies only through authenticated loopback GET requests', async () => {
    const note = '---\ntype: candidate-memory\n---\n# Founder memory evidence';
    const { fetcher, calls } = makeFetcher({ '11 AI Memory/founder.md': note });
    const adapter = new ObsidianVaultEvidenceAdapter({ password, vaultResourceId, fetch: fetcher });
    const inventory = await adapter.listEvidence();

    expect(inventory.total_files).toBe(1);
    expect(inventory.files[0]?.source_id).toBe(vaultEvidenceSourceId(vaultResourceId, '11 AI Memory/founder.md'));
    expect(inventory.files[0]?.frontmatter.type).toBe('candidate-memory');

    const record = await adapter.readEvidence(inventory.files[0]!);
    expect(record.content).toBe(note);
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

  it('rejects traversal paths, duplicate paths, and content that changed after inventory', async () => {
    const traversalFetcher = vi.fn(async () => response({
      files: [{ ...metadata('../outside.md', 'x') }],
      warnings: [],
      totalFiles: 1,
      lastUpdated: '2026-11-09T12:00:00.000Z',
    })) as unknown as typeof fetch;
    const traversalAdapter = new ObsidianVaultEvidenceAdapter({ password, vaultResourceId, fetch: traversalFetcher });
    await expect(traversalAdapter.listEvidence()).rejects.toThrow(VaultEvidenceError);

    const note = '# original';
    const { fetcher } = makeFetcher({ '00 Home/note.md': note });
    const adapter = new ObsidianVaultEvidenceAdapter({ password, vaultResourceId, fetch: fetcher });
    const inventory = await adapter.listEvidence();
    const tampered = { ...inventory.files[0]!, content_hash: '0'.repeat(64) };
    await expect(adapter.readEvidence(tampered)).rejects.toThrow(VaultEvidenceChangedError);
  });

  it('authorizes the vault collection before listing metadata or reading note bodies', async () => {
    const { fetcher, calls } = makeFetcher({ '11 AI Memory/founder.md': '# Founder memory' });
    const adapter = new ObsidianVaultEvidenceAdapter({ password, vaultResourceId, fetch: fetcher });
    const deniedAuthorization = { authorize: vi.fn().mockResolvedValue(false) };
    const deniedReader = new AuthorizedVaultEvidenceReader(adapter, deniedAuthorization);
    await expect(deniedReader.list('human:founder')).rejects.toThrow(VaultEvidenceAuthorizationError);
    expect(deniedAuthorization.authorize).toHaveBeenCalledWith({
      actor_id: 'human:founder',
      action: 'read_evidence',
      resource_id: vaultResourceId,
    });
    expect(calls).toHaveLength(0);

    const allowedAuthorization = { authorize: vi.fn().mockResolvedValue(true) };
    const allowedReader = new AuthorizedVaultEvidenceReader(adapter, allowedAuthorization);
    const inventory = await allowedReader.list('human:founder');
    expect(inventory.files).toHaveLength(1);
    expect(inventory.files[0]?.content).toBe('# Founder memory');
    expect(calls).toHaveLength(2);
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
