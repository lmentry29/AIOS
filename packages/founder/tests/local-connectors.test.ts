import { describe, expect, it, vi } from 'vitest';
import type { FounderAuthorizationPort } from '../src/index.js';
import {
  AuthorizedLocalConnectorEvidenceReader,
  LocalConnectorAuthorizationError,
  LocalConnectorEvidenceError,
} from '../src/local-connectors.js';

const options = {
  baseUrl: 'http://127.0.0.1:4444',
  password: 'local-secret-value-that-is-longer-than-32-bytes',
  gmailResourceId: '11111111-2222-4333-8444-555555555555',
  notionResourceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function reader(fetcher: typeof fetch, authorize: (resourceId: string) => Promise<boolean> = async () => true) {
  const authorization: FounderAuthorizationPort = {
    authorize: vi.fn(async (request) => authorize(request.resource_id)),
  };
  return {
    instance: new AuthorizedLocalConnectorEvidenceReader({ ...options, fetch: fetcher }, authorization),
    authorization,
  };
}

describe('AuthorizedLocalConnectorEvidenceReader', () => {
  it('authorizes Gmail before requesting read-only message metadata', async () => {
    const fetcher = vi.fn(async () => response({
      results: [{
        id: 'gmail-message-1',
        subject: 'Interview schedule',
        from: 'recruiter@example.com',
        date: 'Mon, 09 Nov 2026 10:00:00 +0000',
        snippet: 'Please confirm your interview time.',
      }],
    })) as unknown as typeof fetch;
    const h = reader(fetcher);
    const results = await h.instance.searchGmail('subject:interview', 'human:founder');

    expect(h.authorization.authorize).toHaveBeenCalledWith({
      actor_id: 'human:founder',
      action: 'read_evidence',
      resource_id: options.gmailResourceId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/connectors/gmail/search?query=subject%3Ainterview');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>).authorization).toContain('Basic ');
    expect(results[0]?.source_type).toBe('gmail');
    expect(results[0]?.source_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(results[0]?.snippet).toContain('interview');
  });

  it('denies Gmail and Notion before any HTTP request when resource authorization fails', async () => {
    const fetcher = vi.fn(async () => response({ results: [] })) as unknown as typeof fetch;
    const h = reader(fetcher, async () => false);

    await expect(h.instance.searchGmail('from:recruiter', 'human:founder'))
      .rejects.toBeInstanceOf(LocalConnectorAuthorizationError);
    await expect(h.instance.listNotionApplications('human:founder'))
      .rejects.toBeInstanceOf(LocalConnectorAuthorizationError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.authorization.authorize).toHaveBeenCalledTimes(2);
  });

  it('reads Notion applications with a distinct resource grant and stable page provenance', async () => {
    const pageId = '12345678-1234-4234-8234-123456789abc';
    const fetcher = vi.fn(async () => response({
      results: [{
        id: pageId,
        position: 'Sales Development Representative',
        company: 'Example Co',
        status: 'Interviewing',
        dateApplied: '2026-11-01',
        interviewStage: 'Hiring Manager',
        interviewDate: '2026-11-12',
        contact: 'Recruiter',
        notes: 'Prepare pipeline examples.',
      }],
    })) as unknown as typeof fetch;
    const h = reader(fetcher);
    const results = await h.instance.listNotionApplications('human:founder');

    expect(h.authorization.authorize).toHaveBeenCalledWith({
      actor_id: 'human:founder',
      action: 'read_evidence',
      resource_id: options.notionResourceId,
    });
    expect(results[0]?.provider_id).toBe(pageId);
    expect(results[0]?.source_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(results[0]?.position).toBe('Sales Development Representative');
    expect(results[0]?.date_applied).toBe('2026-11-01');
  });

  it('rejects invalid actors, unsafe base URLs, duplicate resources, and invalid query input', async () => {
    const fetcher = vi.fn(async () => response({ results: [] })) as unknown as typeof fetch;
    expect(() => new AuthorizedLocalConnectorEvidenceReader({ ...options, baseUrl: 'http://example.com:4444', fetch: fetcher }, { authorize: async () => true }))
      .toThrow(/loopback URL/);
    expect(() => new AuthorizedLocalConnectorEvidenceReader({ ...options, notionResourceId: options.gmailResourceId, fetch: fetcher }, { authorize: async () => true }))
      .toThrow(/distinct valid resource UUIDs/);
    const h = reader(fetcher);
    await expect(h.instance.searchGmail('bad\nquery', 'human:founder')).rejects.toBeInstanceOf(LocalConnectorEvidenceError);
    await expect(h.instance.searchGmail('   ', 'human:founder')).rejects.toBeInstanceOf(LocalConnectorEvidenceError);
    await expect(h.instance.searchGmail('test', 'untrusted actor')).rejects.toBeInstanceOf(LocalConnectorEvidenceError);
    expect(fetcher).not.toHaveBeenCalled();
  });


  it('rejects local connector responses that exceed the per-source byte limits', async () => {
    const oversizedBody = 'x'.repeat(300_000);
    const fetcher = vi.fn(async () => new Response(oversizedBody, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const h = reader(fetcher);
    await expect(h.instance.searchGmail('subject:invoice', 'human:founder'))
      .rejects.toThrow(/response exceeded its size limit/);
  });

  it('rejects malformed provider responses and oversized result collections', async () => {
    const malformed = reader(vi.fn(async () => response({ results: [{ id: 'x' }] })) as unknown as typeof fetch);
    await expect(malformed.instance.searchGmail('test', 'human:founder')).rejects.toThrow(/subject/);

    const oversized = reader(vi.fn(async () => response({ results: Array.from({ length: 6 }, () => ({})) })) as unknown as typeof fetch);
    await expect(oversized.instance.searchGmail('test', 'human:founder')).rejects.toThrow(/invalid result collection/);
  });
});