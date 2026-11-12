import { lstatSync, readFileSync, type Stats } from "node:fs";
import { loadHostConfig } from "./config.js";

export type OperatorSessionCommand = "list-sessions" | "rotate-session" | "revoke-session";

/** Stable process exit codes for operators and scripts. */
export const OPERATOR_SESSION_EXIT = Object.freeze({
  success: 0,
  usage: 2,
  denied: 3,
  not_found: 4,
  retired: 5,
  transport: 6,
});

const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TOKEN_FILE_BYTES = 4096;

export interface OperatorSessionOptions {
  configPath?: string;
  tokenFile?: string;
  sessionId?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

class OperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorUsageError";
  }
}

function readTokenFile(path: string | undefined): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new OperatorUsageError("The operator command requires --token-file.");
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new OperatorUsageError("The token file could not be read.");
  }
  if (!stat.isFile()) throw new OperatorUsageError("The token path must be a regular file.");
  if ((stat.mode & 0o077) !== 0) {
    throw new OperatorUsageError("The token file must be owner-only (mode 0600 or stricter).");
  }
  if (stat.size > MAX_TOKEN_FILE_BYTES) {
    throw new OperatorUsageError("The token file is too large.");
  }
  const token = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  if (!TOKEN.test(token) || /\s/.test(token)) {
    throw new OperatorUsageError("The token file does not contain one valid bearer token.");
  }
  return token;
}

function baseUrl(config: ReturnType<typeof loadHostConfig>): string {
  const { host, port } = config.bind;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OperatorUsageError("The configured host port must be a live TCP port, not 0.");
  }
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

function sessionIdOption(value: string | undefined): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new OperatorUsageError("The command requires --session-id with a valid UUID.");
  }
  return value;
}

function responseExitCode(status: number): number {
  if (status === 401 || status === 403) return OPERATOR_SESSION_EXIT.denied;
  if (status === 404) return OPERATOR_SESSION_EXIT.not_found;
  if (status === 409) return OPERATOR_SESSION_EXIT.retired;
  return OPERATOR_SESSION_EXIT.transport;
}

function safeErrorBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  return {
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.request_id === "string" ? { request_id: record.request_id } : {}),
  };
}

/**
 * Operator command implementation used by the checked-in `aios-host` binary.
 *
 * The bearer token is read from an owner-only file, never from argv, and is sent only in the
 * Authorization header. Successful rotation is the sole command that emits token material.
 * Everything else is structured JSON with no token digest or plaintext.
 */
export async function runOperatorSessionCommand(
  command: OperatorSessionCommand,
  options: OperatorSessionOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    if (typeof options.configPath !== "string" || options.configPath.length === 0) {
      throw new OperatorUsageError("The operator command requires --config.");
    }
    const config = loadHostConfig(options.configPath);
    const token = readTokenFile(options.tokenFile);
    const target = command === "list-sessions" ? undefined : sessionIdOption(options.sessionId);
    const path =
      command === "list-sessions"
        ? "/v1/admin/sessions"
        : `/v1/admin/sessions/${target}/${command === "rotate-session" ? "rotate" : "revoke"}`;

    let response: Response;
    try {
      response = await fetch(`${baseUrl(config)}${path}`, {
        method: command === "list-sessions" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      stderr(JSON.stringify({ event: "session_admin_failed", command, error: "transport_error" }));
      return OPERATOR_SESSION_EXIT.transport;
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      stderr(
        JSON.stringify({
          event: "session_admin_failed",
          command,
          status: response.status,
          error: "invalid_response",
        }),
      );
      return OPERATOR_SESSION_EXIT.transport;
    }

    if (!response.ok) {
      stderr(
        JSON.stringify({
          event: "session_admin_failed",
          command,
          status: response.status,
          ...safeErrorBody(body),
        }),
      );
      return responseExitCode(response.status);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      stderr(
        JSON.stringify({
          event: "session_admin_failed",
          command,
          status: response.status,
          error: "invalid_response",
        }),
      );
      return OPERATOR_SESSION_EXIT.transport;
    }

    const event =
      command === "list-sessions"
        ? "session_listed"
        : command === "rotate-session"
          ? "session_rotated"
          : "session_revoked";
    stdout(JSON.stringify({ event, ...(body as Record<string, unknown>) }));
    return OPERATOR_SESSION_EXIT.success;
  } catch (error) {
    stderr(
      JSON.stringify({
        event: "session_admin_failed",
        command,
        error: error instanceof Error ? error.message : "operator_command_failed",
      }),
    );
    return error instanceof OperatorUsageError
      ? OPERATOR_SESSION_EXIT.usage
      : OPERATOR_SESSION_EXIT.transport;
  }
}
