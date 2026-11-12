#!/usr/bin/env node
/**
 * Executable operator-session drill against the compiled host.
 *
 * Boots a real `aios-host serve` process, provisions a real durable policy and session set,
 * then drives `aios-host list-sessions|rotate-session|revoke-session` as a child process with
 * an owner-only token file. Proves the incident path end to end: CLI success and exit codes,
 * immediate live denial, idempotent revocation, terminal rotation conflict, restart recovery,
 * scoped-token denial, and no plaintext token in the operational journal or authorization
 * audit. Prints one JSON result per step and exits non-zero on any failure.
 *
 * Requires a completed build (`pnpm --filter @aios/host run build`).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTrustRoot,
  generateSigningKey,
} from "../../apps/host/dist/execution/artifact-signing.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const cliPath = join(repoRoot, "apps/host/dist/cli.js");
if (!existsSync(cliPath)) {
  console.error(
    JSON.stringify({
      drill: "session-operator",
      ok: false,
      error: "apps/host/dist/cli.js is missing; build @aios/host first",
    }),
  );
  process.exit(1);
}

const FOUNDER = "human:founder";
const OPERATOR = "human:operator";
const AGENT_ID = "00000000-0000-4000-8000-000000000301";
const FOUNDER_SESSION = "00000000-0000-4000-8000-000000000302";
const OPERATOR_SESSION = "00000000-0000-4000-8000-000000000303";
const AGENT_SESSION = "00000000-0000-4000-8000-000000000304";
const MISSING_SESSION = "00000000-0000-4000-8000-000000000399";
const DECISION_COLLECTION = "00000000-0000-4000-8000-000000000305";
const VAULT_RESOURCE = "00000000-0000-4000-8000-000000000306";

const founderToken = randomBytes(32).toString("base64url");
const operatorToken = randomBytes(32).toString("base64url");
const agentToken = randomBytes(32).toString("base64url");
const wrongToken = randomBytes(32).toString("base64url");
const knownPlaintextTokens = [founderToken, operatorToken, agentToken];

const directory = mkdtempSync(join(tmpdir(), "aios-session-operator-drill-"));
const configPath = join(directory, "host.json");
const policyStatePath = join(directory, "policy-state.json");
const provisioningPath = join(directory, "provisioning.json");
const operationalDirectory = join(directory, "operational");
const policyTrustRootPath = join(directory, "policy-trust-root.json");
const policySigningKeyPath = join(directory, "policy-signing-key.pem");
const policySigningKey = generateSigningKey();

const steps = [];
const cliOutputs = [];
let host;
let exitCode = 0;

function step(name, details) {
  steps.push({ step: name, ok: true, ...details });
  console.log(JSON.stringify({ step: name, ok: true, ...details }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(token) {
  return createHash("sha256").update(token).digest("hex");
}

function privateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env },
  });
  const record = {
    args,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  cliOutputs.push(record);
  return record;
}

function parseJson(text, label) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  assert(lines.length > 0, `${label} printed no JSON`);
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new Error(`${label} did not print valid JSON: ${lines.at(-1)}`);
  }
}

async function request(path, token, init = {}) {
  const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) };
}

function startHost() {
  const child = spawn(process.execPath, [cliPath, "serve", "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`host did not start within 20s: ${stderr}`)),
      20_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let index = stdout.indexOf("\n");
      while (index >= 0) {
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        index = stdout.indexOf("\n");
        if (line.trim().length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.event === "host_started") {
          clearTimeout(timer);
          resolve(parsed);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited before listening (code ${code}): ${stderr}`));
    });
  });
  return { child, started };
}

function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("host did not stop after SIGTERM"));
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function rewriteConfigPort(port) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.bind.port = port;
  privateFile(configPath, JSON.stringify(config));
}

try {
  const trustRootNow = Date.now();
  privateFile(
    policyTrustRootPath,
    `${JSON.stringify(
      createTrustRoot({
        key_id: policySigningKey.key_id,
        public_key_pem: policySigningKey.public_key_pem,
        not_before: new Date(trustRootNow - 60_000).toISOString(),
        not_after: new Date(trustRootNow + 24 * 60 * 60 * 1000).toISOString(),
      }),
      null,
      2,
    )}\n`,
  );
  privateFile(policySigningKeyPath, policySigningKey.private_key_pem);

  privateFile(
    configPath,
    JSON.stringify({
      schema_version: 1,
      bind: { host: "127.0.0.1", port: 0 },
      policy_file: policyStatePath,
      policy_provenance: {
        trust_root_file: policyTrustRootPath,
        signing_key_file: policySigningKeyPath,
        key_id: policySigningKey.key_id,
      },
      operational_store: { directory: operationalDirectory },
      dispatch_lease_ms: 5_000,
      decision_collection_id: DECISION_COLLECTION,
      resources: {
        vault: VAULT_RESOURCE,
        gmail: "00000000-0000-4000-8000-000000000307",
        notion: "00000000-0000-4000-8000-000000000308",
      },
      bootstrap_principal_id: FOUNDER,
      sessions: [
        {
          session_id: FOUNDER_SESSION,
          principal_id: FOUNDER,
          token_sha256: digest(founderToken),
          label: "founder incident laptop",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        {
          session_id: OPERATOR_SESSION,
          principal_id: OPERATOR,
          token_sha256: digest(operatorToken),
          label: "primary operator",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        {
          session_id: AGENT_SESSION,
          principal_id: AGENT_ID,
          token_sha256: digest(agentToken),
          label: "executor worker",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    }),
  );

  const policyId = randomUUID();
  privateFile(
    provisioningPath,
    JSON.stringify({
      policy: {
        policy_id: policyId,
        version: 1,
        rules: [
          {
            effect: "allow",
            subject_ids: [FOUNDER],
            actions: ["administer_sessions"],
            resource_ids: [FOUNDER_SESSION, OPERATOR_SESSION, AGENT_SESSION, MISSING_SESSION],
          },
        ],
      },
      attach_to: [FOUNDER_SESSION, OPERATOR_SESSION, AGENT_SESSION, MISSING_SESSION],
    }),
  );

  const published = runCli([
    "publish-policy",
    "--config",
    configPath,
    "--policy",
    provisioningPath,
  ]);
  assert(published.status === 0, `publish-policy exited ${published.status}: ${published.stderr}`);
  assert(
    parseJson(published.stdout, "publish-policy").event === "policy_published",
    "policy was not published",
  );
  step("provision", { ok: true, policy_id: policyId, sessions: 3 });

  host = startHost();
  const started = await host.started;
  host.port = started.port;
  rewriteConfigPort(started.port);
  step("host_started", { port: started.port, dispatch: false });

  const founderFile = privateFile(join(directory, "founder.token"), `${founderToken}\n`);
  const agentFile = privateFile(join(directory, "agent.token"), `${agentToken}\n`);
  const wrongFile = privateFile(join(directory, "wrong.token"), `${wrongToken}\n`);

  const listed = runCli(["list-sessions", "--config", configPath, "--token-file", founderFile]);
  const listBody = parseJson(listed.stdout, "list-sessions");
  assert(listed.status === 0, `list-sessions exited ${listed.status}: ${listed.stderr}`);
  assert(
    listBody.event === "session_listed" && listBody.total === 3,
    `unexpected list payload: ${listed.stdout}`,
  );
  assert(
    JSON.stringify(listBody.sessions.map((entry) => entry.session_id)) ===
      JSON.stringify([FOUNDER_SESSION, OPERATOR_SESSION, AGENT_SESSION]),
    "list omitted or reordered sessions",
  );
  assert(!/[a-f0-9]{64}/.test(listed.stdout), "list-sessions published a token digest");
  assert(
    !listBody.sessions.some((entry) => "token_sha256" in entry),
    "session record carried token_sha256",
  );
  step("list_sessions", { total: listBody.total, digests_exposed: false });

  const nonHuman = runCli(["list-sessions", "--config", configPath, "--token-file", agentFile]);
  assert(nonHuman.status === 3, `non-human list exited ${nonHuman.status}, expected 3`);
  assert(
    parseJson(nonHuman.stderr, "non-human list").error === "human_principal_required",
    "non-human denial reason missing",
  );
  step("denied_non_human", { exit_code: 3 });

  const unknown = runCli(["list-sessions", "--config", configPath, "--token-file", wrongFile]);
  assert(unknown.status === 3, `unknown-token list exited ${unknown.status}, expected 3`);
  assert(
    parseJson(unknown.stderr, "unknown-token list").reason === "unknown_token",
    "unknown-token denial reason missing",
  );
  step("denied_unknown_token", { exit_code: 3 });

  const unsafeFile = join(directory, "unsafe.token");
  writeFileSync(unsafeFile, `${founderToken}\n`);
  chmodSync(unsafeFile, 0o644);
  const unsafe = runCli(["list-sessions", "--config", configPath, "--token-file", unsafeFile]);
  assert(
    unsafe.status === 2,
    `group/world-readable token file exited ${unsafe.status}, expected 2`,
  );
  assert(unsafe.stdout.length === 0, "unsafe token file still produced stdout");
  step("rejects_unsafe_token_file", { exit_code: 2 });

  const missing = runCli([
    "rotate-session",
    "--config",
    configPath,
    "--token-file",
    founderFile,
    "--session-id",
    MISSING_SESSION,
  ]);
  assert(missing.status === 4, `missing session exited ${missing.status}, expected 4`);
  assert(
    parseJson(missing.stderr, "missing session").error === "session_not_found",
    "not-found reason missing",
  );
  step("not_found", { exit_code: 4 });

  const rotated = runCli([
    "rotate-session",
    "--config",
    configPath,
    "--token-file",
    founderFile,
    "--session-id",
    OPERATOR_SESSION,
  ]);
  const rotatedBody = parseJson(rotated.stdout, "rotate-session");
  assert(rotated.status === 0, `rotate-session exited ${rotated.status}: ${rotated.stderr}`);
  assert(
    rotatedBody.event === "session_rotated" && rotatedBody.generation === 2,
    `unexpected rotation payload: ${rotated.stdout}`,
  );
  const newOperatorToken = rotatedBody.token;
  assert(
    typeof newOperatorToken === "string" && newOperatorToken.length >= 32,
    "rotation did not return a token",
  );
  knownPlaintextTokens.push(newOperatorToken);
  assert(
    rotated.stdout.split(newOperatorToken).length === 2,
    "rotation token was printed more than once",
  );
  assert(rotated.stderr.length === 0, "rotation wrote to stderr");
  const oldLive = await request("/v1/session", operatorToken);
  assert(
    oldLive.status === 401 && oldLive.body.reason === "rotated_token",
    `old token still accepted: ${JSON.stringify(oldLive)}`,
  );
  const newLive = await request("/v1/session", newOperatorToken);
  assert(
    newLive.status === 200 && newLive.body.generation === 2,
    `new token not accepted: ${JSON.stringify(newLive)}`,
  );
  step("rotate_live", { generation: 2, old_reason: "rotated_token", new_status: 200 });

  const replay = await request("/v1/session/rotate", operatorToken, { method: "POST" });
  assert(
    replay.status === 401 && replay.body.reason === "rotated_token",
    `retired token replay was not denied: ${JSON.stringify(replay)}`,
  );
  const replayCli = runCli([
    "list-sessions",
    "--config",
    configPath,
    "--token-file",
    privateFile(join(directory, "retired.token"), `${operatorToken}\n`),
  ]);
  assert(replayCli.status === 3, `retired token CLI exited ${replayCli.status}, expected 3`);
  assert(
    parseJson(replayCli.stderr, "retired token CLI").reason === "rotated_token",
    "retired-token CLI reason missing",
  );
  step("rotation_replay_denied", { http_status: 401, exit_code: 3 });

  const revoked = runCli([
    "revoke-session",
    "--config",
    configPath,
    "--token-file",
    founderFile,
    "--session-id",
    AGENT_SESSION,
  ]);
  const revokedBody = parseJson(revoked.stdout, "revoke-session");
  assert(revoked.status === 0, `revoke-session exited ${revoked.status}: ${revoked.stderr}`);
  assert(revokedBody.already_revoked === false, "first revocation reported already_revoked");
  const agentLive = await request("/v1/session", agentToken);
  assert(
    agentLive.status === 401 && agentLive.body.reason === "revoked_token",
    `revoked token still accepted: ${JSON.stringify(agentLive)}`,
  );
  const repeated = runCli([
    "revoke-session",
    "--config",
    configPath,
    "--token-file",
    founderFile,
    "--session-id",
    AGENT_SESSION,
  ]);
  assert(repeated.status === 0, `repeat revocation exited ${repeated.status}`);
  assert(
    parseJson(repeated.stdout, "repeat revocation").already_revoked === true,
    "repeat revocation was not idempotent",
  );
  const rotateRevoked = runCli([
    "rotate-session",
    "--config",
    configPath,
    "--token-file",
    founderFile,
    "--session-id",
    AGENT_SESSION,
  ]);
  assert(
    rotateRevoked.status === 5,
    `rotating a revoked session exited ${rotateRevoked.status}, expected 5`,
  );
  assert(
    parseJson(rotateRevoked.stderr, "rotate revoked").error === "session_conflict",
    "conflict reason missing",
  );
  step("revoke_live", { idempotent: true, revoked_reason: "revoked_token", rotate_exit_code: 5 });

  const scopedResponse = await request("/v1/session/rotate", founderToken, {
    method: "POST",
    body: JSON.stringify({ scope: { task_id: randomUUID() } }),
  });
  assert(
    scopedResponse.status === 200 && typeof scopedResponse.body.token === "string",
    "scoped rotation failed",
  );
  const scopedFounderToken = scopedResponse.body.token;
  knownPlaintextTokens.push(scopedFounderToken);
  const scopedCli = runCli([
    "list-sessions",
    "--config",
    configPath,
    "--token-file",
    privateFile(join(directory, "scoped.token"), `${scopedFounderToken}\n`),
  ]);
  assert(scopedCli.status === 3, `scoped admin exited ${scopedCli.status}, expected 3`);
  assert(
    parseJson(scopedCli.stderr, "scoped admin").reason === "scope_binding_required",
    "scoped admin did not require a binding",
  );
  step("scoped_admin_denied", { exit_code: 3, reason: "scope_binding_required" });

  await stopHost(host.child);
  host = startHost();
  const restarted = await host.started;
  host.port = restarted.port;
  rewriteConfigPort(restarted.port);

  const afterRotate = await request("/v1/session", operatorToken);
  assert(
    afterRotate.status === 401 && afterRotate.body.reason === "rotated_token",
    "restart resurrected a rotated token",
  );
  const afterNew = await request("/v1/session", newOperatorToken);
  assert(
    afterNew.status === 200 && afterNew.body.generation === 2,
    "restart lost the rotated generation",
  );
  const afterRevoke = await request("/v1/session", agentToken);
  assert(
    afterRevoke.status === 401 && afterRevoke.body.reason === "revoked_token",
    "restart resurrected a revoked token",
  );
  const afterFounder = await request("/v1/session", founderToken);
  assert(
    afterFounder.status === 401 && afterFounder.body.reason === "rotated_token",
    "restart resurrected the pre-scope founder token",
  );
  const afterScoped = await request("/v1/session", scopedFounderToken);
  assert(afterScoped.status === 200, "restart lost the scoped generation");
  step("restart_recovery", { rotated_denied: true, revoked_denied: true, new_generation: 2 });

  const journal = readFileSync(join(operationalDirectory, "operational.jsonl"), "utf8");
  const audit = readFileSync(join(operationalDirectory, "authorization-audit.jsonl"), "utf8");
  for (const token of knownPlaintextTokens) {
    assert(!journal.includes(token), "plaintext token found in the operational journal");
    assert(!audit.includes(token), "plaintext token found in the authorization audit");
  }
  for (const record of cliOutputs) {
    for (const token of knownPlaintextTokens) {
      if (record.args.includes("rotate-session") && record.status === 0) continue;
      assert(!record.stdout.includes(token), "token found in CLI stdout");
      assert(!record.stderr.includes(token), "token found in CLI stderr");
    }
  }
  assert(journal.includes("session_rotated"), "journal has no session_rotated record");
  assert(journal.includes("session_revoked"), "journal has no session_revoked record");
  assert(
    audit.includes("administer_sessions"),
    "authorization audit has no administer_sessions decision",
  );
  step("no_token_leakage", { journal: "clean", audit: "clean", cli_outputs: cliOutputs.length });

  console.log(JSON.stringify({ drill: "session-operator", ok: true, steps: steps.length }));
} catch (error) {
  exitCode = 1;
  console.error(
    JSON.stringify({
      drill: "session-operator",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  if (host) {
    try {
      await stopHost(host.child);
    } catch {
      // The failure is already reported; do not mask it with cleanup.
    }
  }
}
process.exit(exitCode);
