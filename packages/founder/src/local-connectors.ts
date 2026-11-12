import { Buffer } from "node:buffer";
import type { FounderAuthorizationPort } from "./index.js";
import { vaultEvidenceSourceId } from "./obsidian-evidence.js";
import { createLoopbackFetcher } from "./security/ssrf.js";
import type { TaintLabel } from "./security/taint.js";

export interface LocalConnectorEvidenceOptions {
  /** Explicit-port IPv4 loopback URL for the authenticated local Obsidian++ API. */
  baseUrl?: string;
  /** Owner-only local Obsidian++ password; never pass a ChatGPT connector token here. */
  password: string;
  /** Separate resource IDs allow independent Gmail and Notion read grants. */
  gmailResourceId: string;
  notionResourceId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GmailEvidenceRecord {
  source_id: string;
  source_type: "gmail";
  provider_id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  taint?: readonly TaintLabel[];
}

export interface NotionApplicationEvidenceRecord {
  source_id: string;
  source_type: "notion";
  provider_id: string;
  position: string;
  company: string;
  status: string;
  date_applied: string | null;
  interview_stage: string;
  interview_date: string | null;
  contact: string;
  notes: string;
  taint?: readonly TaintLabel[];
}

export interface FounderConnectorEvidenceReadPort {
  searchGmail(query: string, actorId: string): Promise<GmailEvidenceRecord[]>;
  listNotionApplications(actorId: string): Promise<NotionApplicationEvidenceRecord[]>;
}

export class LocalConnectorEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConnectorEvidenceError";
  }
}

export class LocalConnectorAuthorizationError extends LocalConnectorEvidenceError {
  constructor(source: "gmail" | "notion") {
    super(`Read access denied for the local ${source} connector.`);
    this.name = "LocalConnectorAuthorizationError";
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isActorReference(value: string): boolean {
  return /^human:[^\s:*]+$/.test(value) || isUuid(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new LocalConnectorEvidenceError(`Local connector returned invalid ${field}.`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  const text = requiredText(value, field, 64);
  if (text && !Number.isFinite(Date.parse(text))) {
    throw new LocalConnectorEvidenceError(`Local connector returned an invalid ${field}.`);
  }
  return text || null;
}

function stableSourceId(resourceId: string, source: string): string {
  return vaultEvidenceSourceId(resourceId, source);
}

/**
 * Read-only bridge to Obsidian++ Gmail and Notion routes. It performs a separate
 * resource authorization before each provider-backed request. It never writes to
 * Gmail, Notion, or the vault.
 */
const MAX_GMAIL_RESPONSE_BYTES = 256 * 1024;
const MAX_NOTION_RESPONSE_BYTES = 5 * 1024 * 1024;

export class AuthorizedLocalConnectorEvidenceReader implements FounderConnectorEvidenceReadPort {
  private readonly baseUrl: URL;
  private readonly authorizationHeader: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    options: LocalConnectorEvidenceOptions,
    private readonly authorization: FounderAuthorizationPort,
  ) {
    this.baseUrl = this.validateBaseUrl(options.baseUrl ?? "http://127.0.0.1:4444");
    if (typeof options.password !== "string" || Buffer.byteLength(options.password) < 32) {
      throw new LocalConnectorEvidenceError(
        "Obsidian++ local password must contain at least 32 bytes.",
      );
    }
    if (
      !isUuid(options.gmailResourceId) ||
      !isUuid(options.notionResourceId) ||
      options.gmailResourceId === options.notionResourceId
    ) {
      throw new LocalConnectorEvidenceError(
        "Gmail and Notion require distinct valid resource UUIDs.",
      );
    }
    this.gmailResourceId = options.gmailResourceId;
    this.notionResourceId = options.notionResourceId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new LocalConnectorEvidenceError(
        "Local connector timeout is outside the supported range.",
      );
    }
    this.fetcher = options.fetch ?? createLoopbackFetcher(this.baseUrl, this.timeoutMs);
    if (typeof this.fetcher !== "function")
      throw new LocalConnectorEvidenceError("Fetch implementation is unavailable.");
    this.authorizationHeader = `Basic ${Buffer.from(`local:${options.password}`).toString("base64")}`;
  }

  readonly gmailResourceId: string;
  readonly notionResourceId: string;

  async searchGmail(query: string, actorId: string): Promise<GmailEvidenceRecord[]> {
    if (!isActorReference(actorId))
      throw new LocalConnectorEvidenceError(
        "Gmail reads require a valid authenticated actor identifier.",
      );
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.length > 500 ||
      /[\r\n\0]/.test(query)
    ) {
      throw new LocalConnectorEvidenceError(
        "Gmail query must be a string of at most 500 characters without control characters.",
      );
    }
    await this.authorize(actorId, "gmail");
    const url = new URL("/api/connectors/gmail/search", this.baseUrl);
    url.searchParams.set("query", query);
    const payload = await this.getJson(url, MAX_GMAIL_RESPONSE_BYTES);
    if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > 5) {
      throw new LocalConnectorEvidenceError(
        "Gmail connector returned an invalid result collection.",
      );
    }
    return payload.results.map((item): GmailEvidenceRecord => {
      if (!isRecord(item))
        throw new LocalConnectorEvidenceError("Gmail connector returned an invalid message.");
      const providerId = requiredText(item.id, "message ID", 512);
      if (!providerId)
        throw new LocalConnectorEvidenceError("Gmail connector returned an empty message ID.");
      return Object.freeze({
        source_id: stableSourceId(this.gmailResourceId, `gmail/${providerId}`),
        source_type: "gmail",
        provider_id: providerId,
        subject: requiredText(item.subject, "subject", 998),
        from: requiredText(item.from, "sender", 998),
        date: requiredText(item.date, "date", 128),
        snippet: requiredText(item.snippet, "snippet", 8192),
        taint: ["external_untrusted", "prompt_injection_risk", "connector_poisoning_risk"] as const,
      });
    });
  }

  async listNotionApplications(actorId: string): Promise<NotionApplicationEvidenceRecord[]> {
    if (!isActorReference(actorId))
      throw new LocalConnectorEvidenceError(
        "Notion reads require a valid authenticated actor identifier.",
      );
    await this.authorize(actorId, "notion");
    const payload = await this.getJson(
      new URL("/api/connectors/notion/applications", this.baseUrl),
      MAX_NOTION_RESPONSE_BYTES,
    );
    if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > 500) {
      throw new LocalConnectorEvidenceError(
        "Notion connector returned an invalid result collection.",
      );
    }
    return payload.results.map((item): NotionApplicationEvidenceRecord => {
      if (!isRecord(item))
        throw new LocalConnectorEvidenceError(
          "Notion connector returned an invalid application record.",
        );
      return Object.freeze({
        source_id: stableSourceId(
          this.notionResourceId,
          `notion/application/${requiredText(item.id, "page ID", 64)}`,
        ),
        source_type: "notion",
        provider_id: requiredText(item.id, "page ID", 64),
        position: requiredText(item.position, "position", 500),
        company: requiredText(item.company, "company", 500),
        status: requiredText(item.status, "status", 128),
        date_applied: nullableDate(item.dateApplied, "date applied"),
        interview_stage: requiredText(item.interviewStage, "interview stage", 256),
        interview_date: nullableDate(item.interviewDate, "interview date"),
        contact: requiredText(item.contact, "contact", 500),
        notes: requiredText(item.notes, "notes", 8192),
        taint: ["external_untrusted", "prompt_injection_risk", "connector_poisoning_risk"] as const,
      });
    });
  }

  private async authorize(actorId: string, source: "gmail" | "notion"): Promise<void> {
    const resourceId = source === "gmail" ? this.gmailResourceId : this.notionResourceId;
    let allowed = false;
    try {
      allowed = await this.authorization.authorize({
        actor_id: actorId,
        action: "read_evidence",
        resource_id: resourceId,
      });
    } catch {
      allowed = false;
    }
    if (!allowed) throw new LocalConnectorAuthorizationError(source);
  }

  private async getJson(url: URL, maxBytes: number): Promise<unknown> {
    if (url.origin !== this.baseUrl.origin)
      throw new LocalConnectorEvidenceError("Local connector request escaped the loopback origin.");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { authorization: this.authorizationHeader, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LocalConnectorEvidenceError(
        "Local Obsidian++ connector request failed or timed out.",
      );
    }
    if (!response.ok)
      throw new LocalConnectorEvidenceError(
        `Local Obsidian++ connector returned HTTP ${response.status}.`,
      );
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        /* Best-effort cancellation. */
      }
      throw new LocalConnectorEvidenceError(
        "Local Obsidian++ connector response exceeded its size limit.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new LocalConnectorEvidenceError(
        "Local Obsidian++ connector response body is unavailable.",
      );
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new LocalConnectorEvidenceError(
            "Local Obsidian++ connector response exceeded its size limit.",
          );
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        /* Best-effort cancellation. */
      }
      if (error instanceof LocalConnectorEvidenceError) throw error;
      throw new LocalConnectorEvidenceError(
        "Local Obsidian++ connector response could not be read.",
      );
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new LocalConnectorEvidenceError("Local Obsidian++ connector returned invalid JSON.");
    }
  }

  private validateBaseUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new LocalConnectorEvidenceError("Obsidian++ base URL must be a valid URL.");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new LocalConnectorEvidenceError(
        "Obsidian++ connector API must use an explicit-port HTTP loopback URL.",
      );
    }
    return url;
  }
}
