import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  SsrfError,
  classifyIpAddress,
  createLoopbackFetcher,
  isPublicAddress,
  resolveSafeHttpUrl,
  safeHttpRequest,
  type ResolvedAddress,
  type SsrfPolicy,
} from '../src/security/ssrf.js';

interface TestServer {
  origin: URL;
  port: number;
  close(): Promise<void>;
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<TestServer> {
  const instance = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => resolve());
  });
  const address = instance.address() as AddressInfo;
  return {
    origin: new URL(`http://127.0.0.1:${address.port}`),
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    },
  };
}

function loopbackPolicy(port: number, host = '127.0.0.1'): SsrfPolicy {
  return {
    allowedHosts: [host],
    allowedPorts: [port],
    allowedProtocols: ['http:'],
    allowLoopback: true,
  };
}

describe('SSRF address policy', () => {
  it('classifies private, loopback, mapped, translated and documentation ranges as non-public', () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '2002:7f00:1::',
      '2002:0a00:1::',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '2001:db8::1',
      '2001:2::1',
      '2001:10::1',
      '64:ff9b::7f00:1',
      '100::1',
      'not-an-address',
    ];
    for (const address of blocked) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    expect(classifyIpAddress('::ffff:8.8.8.8')).toBe('public');
  });

  it('rejects credentials, fragments, non-HTTP schemes, unapproved ports and hosts', async () => {
    await expect(resolveSafeHttpUrl('http://example.com')).rejects.toMatchObject({ code: 'blocked_protocol' });
    await expect(resolveSafeHttpUrl('https://user:pass@example.com')).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(resolveSafeHttpUrl('https://example.com/#fragment')).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(resolveSafeHttpUrl('https://example.com:22')).rejects.toMatchObject({ code: 'blocked_port' });
    await expect(resolveSafeHttpUrl('https://example.com', {
      allowedHosts: ['other.example'],
    })).rejects.toMatchObject({ code: 'blocked_host' });
    await expect(resolveSafeHttpUrl('not a url')).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects every DNS answer if any one answer is non-public', async () => {
    const resolver = async (): Promise<ResolvedAddress[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ];
    await expect(resolveSafeHttpUrl('https://public.example', {}, resolver))
      .rejects.toMatchObject({ code: 'blocked_address' });
    await expect(resolveSafeHttpUrl('https://public.example', {}, async () => []))
      .rejects.toMatchObject({ code: 'dns_empty' });
    await expect(resolveSafeHttpUrl('https://public.example', {}, async () => {
      throw new Error('resolver down');
    })).rejects.toMatchObject({ code: 'dns_failure' });
    await expect(resolveSafeHttpUrl('https://public.example', {}, async () => [
      { address: 'not-an-ip', family: 4 },
    ])).rejects.toMatchObject({ code: 'dns_failure' });
  });

  it('pins the validated DNS answer for the connection and never re-resolves', async () => {
    let requests = 0;
    const target = await server((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('pinned');
    });
    let resolutions = 0;
    const resolver = async (): Promise<ResolvedAddress[]> => {
      resolutions += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    try {
      const result = await safeHttpRequest(`http://rebind.test:${target.port}/ok`, {
        policy: loopbackPolicy(target.port, 'rebind.test'),
        resolver,
      });
      expect(result.status).toBe(200);
      expect(result.body.toString('utf8')).toBe('pinned');
      expect(requests).toBe(1);
      expect(resolutions).toBe(1);
    } finally {
      await target.close();
    }
  });

  it('rejects redirects without following them or leaking the request twice', async () => {
    let hits = 0;
    const target = await server((_request, response) => {
      hits += 1;
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });
    try {
      await expect(safeHttpRequest(`${target.origin.origin}/redirect`, {
        policy: loopbackPolicy(target.port),
      })).rejects.toMatchObject({ code: 'redirect_rejected' });
      expect(hits).toBe(1);
    } finally {
      await target.close();
    }
  });

  it('enforces response and request byte limits', async () => {
    const target = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(2048));
    });
    try {
      await expect(safeHttpRequest(`${target.origin.origin}/large`, {
        policy: loopbackPolicy(target.port),
        maxResponseBytes: 64,
      })).rejects.toMatchObject({ code: 'response_too_large' });
      await expect(safeHttpRequest(`${target.origin.origin}/large`, {
        policy: loopbackPolicy(target.port),
        method: 'POST',
        body: 'x'.repeat(2048),
        maxRequestBytes: 64,
      })).rejects.toMatchObject({ code: 'request_too_large' });
      await expect(safeHttpRequest(`${target.origin.origin}/large`, {
        policy: loopbackPolicy(target.port),
        method: 'GET',
        body: 'not allowed',
      })).rejects.toMatchObject({ code: 'invalid_url' });
    } finally {
      await target.close();
    }
  });

  it('rejects a request that exceeds its deadline', async () => {
    const target = await server((_request, response) => {
      response.writeHead(200);
      response.write('partial');
      // Never end: the client's deadline must terminate the request.
    });
    try {
      await expect(safeHttpRequest(`${target.origin.origin}/slow`, {
        policy: loopbackPolicy(target.port),
        timeoutMs: 150,
      })).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await target.close();
    }
  });

  it('builds a loopback-only fetch adapter that rejects origin escapes', async () => {
    const target = await server((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    try {
      const fetcher = createLoopbackFetcher(target.origin, 1000);
      const response = await fetcher(new URL('/api', target.origin));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await expect(fetcher('http://127.0.0.1:1/api')).rejects.toBeInstanceOf(SsrfError);
      await expect(fetcher(new URL('/api', target.origin), { method: 'POST' }))
        .rejects.toMatchObject({ code: 'invalid_url' });
    } finally {
      await target.close();
    }
  });

  it('seeded non-public address generation never becomes public', () => {
    let state = 0x51a7c0de;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let index = 0; index < 500; index += 1) {
      const kind = next() % 7;
      const a = next() % 256;
      const b = next() % 256;
      const address = kind === 0
        ? `10.${a}.${b}.${next() % 256}`
        : kind === 1
          ? `172.${16 + (a % 16)}.${b}.${next() % 256}`
          : kind === 2
            ? `192.168.${a}.${next() % 256}`
            : kind === 3
              ? `127.${a}.${b}.${next() % 256}`
              : kind === 4
                ? `169.254.${a}.${next() % 256}`
                : kind === 5
                  ? `100.${64 + (a % 64)}.${b}.${next() % 256}`
                  : `0.${a}.${b}.${next() % 256}`;
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (let index = 0; index < 100; index += 1) {
      const address = [8, 8, 8, 8].join('.');
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});
