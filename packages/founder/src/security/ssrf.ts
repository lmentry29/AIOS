import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * SSRF-safe outbound HTTP boundary.
 *
 * URL validation, DNS classification, redirect rejection and connection pinning are one
 * operation. Every DNS answer is classified; if any answer is non-public the request is
 * refused, so a resolver cannot smuggle a private address alongside a public one. The
 * validated address is then used as the connection target rather than re-resolving the
 * hostname, which removes the verification-to-connect DNS-rebinding window. TLS still uses
 * the original hostname for SNI and certificate verification.
 */
export type SsrfFailure =
  | "invalid_url"
  | "blocked_protocol"
  | "blocked_port"
  | "blocked_host"
  | "blocked_address"
  | "dns_failure"
  | "dns_empty"
  | "redirect_rejected"
  | "response_too_large"
  | "request_too_large"
  | "timeout"
  | "aborted"
  | "network_error";

export class SsrfError extends Error {
  constructor(
    readonly code: SsrfFailure,
    message: string,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SsrfPolicy {
  /** Exact hostnames (lowercase, no trailing dot) or IP literals. Omit for public hosts. */
  readonly allowedHosts?: readonly string[];
  /** Exact ports. Defaults to 80 and 443. */
  readonly allowedPorts?: readonly number[];
  /** Defaults to HTTPS only. */
  readonly allowedProtocols?: readonly ("http:" | "https:")[];
  /** Loopback is denied unless this is explicitly enabled by the caller. */
  readonly allowLoopback?: boolean;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeUrlResolution {
  url: URL;
  hostname: string;
  addresses: readonly ResolvedAddress[];
}

export interface SafeHttpRequestOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  policy?: SsrfPolicy;
  resolver?: HostResolver;
  signal?: AbortSignal;
}

export interface SafeHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: string;
}

export type IpAddressClass =
  | "public"
  | "loopback"
  | "unspecified"
  | "private"
  | "link_local"
  | "multicast"
  | "documentation"
  | "reserved"
  | "translation";

const DEFAULT_PORTS = Object.freeze([80, 443]);
const DEFAULT_PROTOCOLS = Object.freeze(["https:"] as const);
const MAX_DNS_ANSWERS = 32;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 8192;
const MAX_HEADER_COUNT = 64;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

function fail(code: SsrfFailure, message: string): never {
  throw new SsrfError(code, message);
}

function ipv4Bytes(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return [octets[0] as number, octets[1] as number, octets[2] as number, octets[3] as number];
}

function classifyIpv4(address: string): IpAddressClass {
  const bytes = ipv4Bytes(address);
  if (bytes === undefined) return "reserved";
  const [a, b, c] = bytes;
  if (a === 0) return "unspecified";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "documentation";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 255) return "reserved";
  if (a >= 224) return "multicast";
  return "public";
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (address.includes("%")) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (text: string): number[] | undefined => {
    if (text.length === 0) return [];
    const groups: number[] = [];
    for (const group of text.split(":")) {
      if (group.length === 0) return undefined;
      if (group.includes(".")) {
        const bytes = ipv4Bytes(group);
        if (bytes === undefined) return undefined;
        groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? "");
  const right = parseGroups(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const total = left.length + right.length;
  if (halves.length === 1 && total !== 8) return undefined;
  if (halves.length === 2 && total >= 8) return undefined;
  const groups = [...left, ...new Array<number>(8 - total).fill(0), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function matchesPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function embeddedIpv4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function classifyIpv6(address: string): IpAddressClass {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return "reserved";
  if (bytes.every((byte) => byte === 0)) return "unspecified";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback";
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return "private";
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) return "link_local";
  if (bytes[0] === 0xff) return "multicast";
  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible range.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyIpv4(embeddedIpv4(bytes, 12));
  }
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return classifyIpv4(embeddedIpv4(bytes, 12));
  }
  // 6to4, Teredo, documentation, benchmarking, ORCHID and NAT64.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return classifyIpv4(embeddedIpv4(bytes, 2));
  }
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x00])) return "translation";
  if (matchesPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return "documentation";
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x02])) return "reserved";
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x10])) return "reserved";
  if (
    matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  ) {
    return classifyIpv4(embeddedIpv4(bytes, 12));
  }
  if (matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return "translation";
  if (((bytes[0] as number) & 0xe0) !== 0x20) return "reserved";
  return "public";
}

/** Classifies an IPv4 or IPv6 literal. Invalid input is treated as reserved. */
export function classifyIpAddress(address: string): IpAddressClass {
  if (typeof address !== "string" || isIP(address) === 0) return "reserved";
  return isIP(address) === 4 ? classifyIpv4(address) : classifyIpv6(address);
}

export function isPublicAddress(address: string): boolean {
  return classifyIpAddress(address) === "public";
}

function normalizeHostname(url: URL): string {
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname.length === 0 || hostname.includes("%")) {
    fail("invalid_url", "The URL has no usable hostname.");
  }
  return hostname;
}

function assertAddressAllowed(address: string, policy: SsrfPolicy): void {
  const classification = classifyIpAddress(address);
  if (classification === "public") return;
  if (classification === "loopback" && policy.allowLoopback === true) return;
  fail(
    "blocked_address",
    `The outbound request resolved to a ${classification} address, which is not permitted.`,
  );
}

const defaultResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

function validateResolverAnswers(answers: readonly ResolvedAddress[]): ResolvedAddress[] {
  if (!Array.isArray(answers) || answers.length === 0) {
    fail("dns_empty", "The hostname did not resolve to any address.");
  }
  if (answers.length > MAX_DNS_ANSWERS) {
    fail("dns_failure", `The hostname resolved to more than ${MAX_DNS_ANSWERS} addresses.`);
  }
  const unique = new Map<string, ResolvedAddress>();
  for (const answer of answers) {
    if (
      !answer ||
      typeof answer.address !== "string" ||
      (answer.family !== 4 && answer.family !== 6)
    ) {
      fail("dns_failure", "The resolver returned a malformed address.");
    }
    const parsedFamily = isIP(answer.address);
    if (parsedFamily === 0) {
      fail("dns_failure", "The resolver returned a malformed address.");
    }
    const family: 4 | 6 = parsedFamily === 6 ? 6 : 4;
    if (family !== answer.family) {
      fail("dns_failure", "The resolver returned an address for the wrong family.");
    }
    unique.set(`${family}:${answer.address}`, { address: answer.address, family });
  }
  return [...unique.values()];
}

/**
 * Validates a URL and resolves every address before any connection is attempted.
 * The returned addresses are the exact candidates a caller may connect to.
 */
export async function resolveSafeHttpUrl(
  input: string | URL,
  policy: SsrfPolicy = {},
  resolver: HostResolver = defaultResolver,
): Promise<SafeUrlResolution> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    fail("invalid_url", "The outbound URL is not a valid absolute URL.");
  }
  const protocols = policy.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(url.protocol as "http:" | "https:")) {
    fail("blocked_protocol", `The outbound URL protocol "${url.protocol}" is not permitted.`);
  }
  if (url.username || url.password) {
    fail("invalid_url", "Outbound URLs must not contain credentials.");
  }
  if (url.hash) fail("invalid_url", "Outbound URLs must not contain a fragment.");
  const hostname = normalizeHostname(url);
  if (policy.allowedHosts !== undefined) {
    const allowed = policy.allowedHosts.map((host) => host.toLowerCase().replace(/\.$/, ""));
    if (!allowed.includes(hostname)) {
      fail("blocked_host", `The outbound host "${hostname}" is not in the exact allow-list.`);
    }
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const ports = policy.allowedPorts ?? DEFAULT_PORTS;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !ports.includes(port)) {
    fail("blocked_port", `The outbound port ${String(port)} is not permitted.`);
  }

  let answers: ResolvedAddress[];
  if (isIP(hostname) !== 0) {
    answers = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
  } else {
    try {
      answers = validateResolverAnswers(await resolver(hostname));
    } catch (error) {
      if (error instanceof SsrfError) throw error;
      fail("dns_failure", `The outbound host could not be resolved: ${hostname}.`);
    }
  }
  for (const answer of answers) assertAddressAllowed(answer.address, policy);
  return { url, hostname, addresses: Object.freeze(answers.map((answer) => ({ ...answer }))) };
}

function validateHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADER_COUNT) {
    fail("invalid_url", `Outbound requests may contain at most ${MAX_HEADER_COUNT} headers.`);
  }
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      typeof name !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      name.length > MAX_HEADER_NAME
    ) {
      fail("invalid_url", "An outbound header name is invalid.");
    }
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) {
      fail("invalid_url", "An outbound header value is invalid.");
    }
    if (name.toLowerCase() === "host" || name.toLowerCase() === "content-length") {
      fail("invalid_url", "The outbound request may not override host or content-length.");
    }
    validated[name.toLowerCase()] = value;
  }
  return validated;
}

function errorForNetworkFailure(error: unknown): SsrfError {
  if (error instanceof SsrfError) return error;
  const code =
    typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ABORT_ERR") return new SsrfError("aborted", "The outbound request was aborted.");
  if (code === "ETIMEDOUT") return new SsrfError("timeout", "The outbound request timed out.");
  return new SsrfError(
    "network_error",
    "The outbound request failed before a valid response was received.",
  );
}

/** Executes one request with pinned DNS, no redirect following and bounded response bytes. */
export async function safeHttpRequest(
  input: string | URL,
  options: SafeHttpRequestOptions = {},
): Promise<SafeHttpResponse> {
  const resolution = await resolveSafeHttpUrl(input, options.policy, options.resolver);
  const { url, hostname, addresses } = resolution;
  const target = addresses[0];
  if (target === undefined) fail("dns_empty", "No validated address is available for the request.");
  const method = options.method ?? "GET";
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    fail("invalid_url", "The outbound request method is not supported.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    fail("invalid_url", "The outbound timeout is outside the supported range.");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1
  ) {
    fail("invalid_url", "The outbound byte limit is outside the supported range.");
  }
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? Buffer.from(options.body, "utf8")
        : Buffer.from(options.body);
  if (body !== undefined && body.byteLength > maxRequestBytes) {
    fail("request_too_large", "The outbound request body exceeds its configured limit.");
  }
  if (body !== undefined && (method === "GET" || method === "HEAD")) {
    fail("invalid_url", "GET and HEAD requests must not contain a body.");
  }
  const headers = validateHeaders(options.headers);
  headers.host = url.host;
  headers["user-agent"] = headers["user-agent"] ?? "aios-safe-http/1";
  if (body !== undefined) headers["content-length"] = String(body.byteLength);

  const requestOptions: RequestOptions = {
    hostname: target.address,
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    agent: false,
    timeout: timeoutMs,
    ...(url.protocol === "https:" ? { servername: hostname, rejectUnauthorized: true } : {}),
  };

  return await new Promise<SafeHttpResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(overallTimer);
      options.signal?.removeEventListener("abort", abort);
      return true;
    };
    const reject = (error: SsrfError): void => {
      if (finish()) rejectPromise(error);
    };
    const resolve = (value: SafeHttpResponse): void => {
      if (finish()) resolvePromise(value);
    };
    const abort = (): void => {
      request.destroy(new SsrfError("aborted", "The outbound request was aborted."));
      reject(new SsrfError("aborted", "The outbound request was aborted."));
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      requestOptions,
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new SsrfError("redirect_rejected", "Outbound redirects are not followed."));
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          response.destroy();
          reject(
            new SsrfError("response_too_large", "The outbound response exceeds its byte limit."),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > maxResponseBytes) {
            response.destroy();
            reject(
              new SsrfError("response_too_large", "The outbound response exceeds its byte limit."),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", (error) => reject(errorForNetworkFailure(error)));
        response.on("end", () => {
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks, bytes),
            url: url.toString(),
          });
        });
      },
    );
    const overallTimer = setTimeout(() => {
      request.destroy(new SsrfError("timeout", "The outbound request timed out."));
      reject(new SsrfError("timeout", "The outbound request timed out."));
    }, timeoutMs);
    overallTimer.unref();
    request.on("timeout", () => {
      request.destroy(new SsrfError("timeout", "The outbound request timed out."));
      reject(new SsrfError("timeout", "The outbound request timed out."));
    });
    request.on("error", (error) => reject(errorForNetworkFailure(error)));
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    }
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * Production fetch adapter for a constructor-validated loopback connector. The URL origin
 * is already fixed by the caller; this adapter still applies the SSRF checks and rejects
 * every redirect, so a provider response cannot redirect the client away from that origin.
 */
export function createLoopbackFetcher(
  baseUrl: URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): typeof globalThis.fetch {
  if (
    !(baseUrl instanceof URL) ||
    baseUrl.protocol !== "http:" ||
    baseUrl.port === "" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new SsrfError("invalid_url", "The loopback connector URL is not a fixed HTTP origin.");
  }
  const connectorHostname = baseUrl.hostname.replace(/^\[|\]$/g, "");
  const policy: SsrfPolicy = {
    allowedHosts: [connectorHostname],
    allowedPorts: [Number(baseUrl.port)],
    allowedProtocols: ["http:"],
    allowLoopback: true,
  };
  return (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    if (url.origin !== baseUrl.origin) {
      throw new SsrfError(
        "blocked_host",
        "The connector request escaped its configured loopback origin.",
      );
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new SsrfError(
        "invalid_url",
        "The loopback connector only supports read-only requests.",
      );
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    let body: string | Uint8Array | undefined;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) body = init.body;
    else if (init?.body !== undefined && init.body !== null) {
      throw new SsrfError(
        "invalid_url",
        "The loopback connector request body type is unsupported.",
      );
    }
    const response = await safeHttpRequest(url, {
      method: method === "HEAD" ? "HEAD" : "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      timeoutMs,
      maxResponseBytes: 8 * 1024 * 1024,
      policy,
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === "string") responseHeaders.set(name, value);
      else if (Array.isArray(value)) {
        for (const entry of value) responseHeaders.append(name, entry);
      }
    }
    const responseBody =
      response.status === 204 || response.status === 205 || response.status === 304
        ? null
        : response.body;
    return new Response(responseBody, { status: response.status, headers: responseHeaders });
  }) as typeof globalThis.fetch;
}
