import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessAction, AccessPolicy } from "@aios/founder";
import { FilePolicyRegistry, PolicyAdministrationService } from "@aios/founder";
import { InfrastructureEntity as InfrastructureSchema } from "@aios/core";
import type { InfrastructureEntity } from "@aios/core";
import { loadHostConfig } from "../src/config.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { createHostRuntime, type HostRuntime } from "../src/runtime.js";
import { createHostServer, type HostHttpServer } from "../src/server.js";
import {
  AGENT_ID,
  AGENT_TOKEN,
  DECISION_COLLECTION_ID,
  FOUNDER,
  FOUNDER_TOKEN,
  GMAIL_RESOURCE_ID,
  NOTION_RESOURCE_ID,
  VAULT_RESOURCE_ID,
  sessionExpiresAt,
} from "./fixtures.js";
import { createPolicyAuthority, type PolicyAuthorityFixture } from "./policy-provenance-fixture.js";

interface Harness {
  baseUrl: string;
  runtime: HostRuntime;
  server: HostHttpServer;
  directory: string;
  configPath: string;
  policyPath: string;
  policyAuthority: PolicyAuthorityFixture;
  infrastructureId: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeInfrastructure(overrides: Record<string, unknown> = {}): InfrastructureEntity {
  const now = new Date().toISOString();
  return {
    entity_id: randomUUID(),
    entity_type: "canonical_object",
    entity_subtype: "infrastructure_host",
    name: "Primary local host",
    description: "The trusted local execution host.",
    lifecycle_state: "created",
    lifecycle_history: [],
    created_at: now,
    created_by: FOUNDER,
    modified_at: now,
    version: 1,
    organizational_containers: [],
    owner_id: FOUNDER,
    owner_type: "human",
    relationships: [],
    health: "unknown",
    adapter: "local",
    ...overrides,
  } as unknown as InfrastructureEntity;
}

function policyFor(infrastructureId: string): AccessPolicy {
  const actions: AccessAction[] = ["intake", "read_status", "execute"];
  return {
    policy_id: randomUUID(),
    version: 1,
    rules: [
      {
        effect: "allow",
        subject_ids: [FOUNDER],
        actions,
        resource_ids: [infrastructureId],
      },
      {
        // The agent has every relevant grant on the record. It still may not mutate it:
        // the route independently requires a human principal.
        effect: "allow",
        subject_ids: [AGENT_ID],
        actions,
        resource_ids: [infrastructureId],
      },
    ],
  };
}

async function attachPolicy(
  policyPath: string,
  policy: AccessPolicy,
  authority: PolicyAuthorityFixture,
): Promise<void> {
  const registry = new FilePolicyRegistry({ filePath: policyPath });
  try {
    const administration = new PolicyAdministrationService(FOUNDER, registry, registry);
    const signed = await authority.authority.signPolicy(policy);
    await administration.publish(signed, FOUNDER);
    for (const resourceId of new Set(signed.rules.flatMap((rule) => [...rule.resource_ids]))) {
      await administration.attach(resourceId, signed.policy_id, FOUNDER);
    }
  } finally {
    registry.close();
  }
}

async function startHarness(options: { withBroker?: boolean } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "aios-infrastructure-"));
  const policyPath = join(directory, "policy-state.json");
  const configPath = join(directory, "host.json");
  const policyAuthority = createPolicyAuthority(directory);
  const infrastructure = makeInfrastructure();
  await attachPolicy(policyPath, policyFor(infrastructure.entity_id), policyAuthority);

  const secretBroker =
    options.withBroker === false
      ? undefined
      : {
          store_file: join(directory, "secrets.enc.json"),
          key_file: (() => {
            const path = join(directory, "broker.key");
            writeFileSync(path, randomBytes(32), { mode: 0o600 });
            return path;
          })(),
        };
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      bind: { host: "127.0.0.1", port: 0 },
      policy_file: policyPath,
      policy_provenance: policyAuthority.config,
      operational_store: { directory: join(directory, "operational") },
      dispatch_lease_ms: 5_000,
      decision_collection_id: DECISION_COLLECTION_ID,
      resources: { vault: VAULT_RESOURCE_ID, gmail: GMAIL_RESOURCE_ID, notion: NOTION_RESOURCE_ID },
      bootstrap_principal_id: FOUNDER,
      sessions: [
        {
          session_id: randomUUID(),
          principal_id: FOUNDER,
          token_sha256: sha256(FOUNDER_TOKEN),
          expires_at: sessionExpiresAt(),
        },
        {
          session_id: randomUUID(),
          principal_id: AGENT_ID,
          token_sha256: sha256(AGENT_TOKEN),
          expires_at: sessionExpiresAt(),
        },
      ],
      ...(secretBroker === undefined ? {} : { secret_broker: secretBroker }),
    }),
    { mode: 0o600 },
  );

  const config = loadHostConfig(configPath);
  const runtime = createHostRuntime({ config });
  const server = createHostServer(runtime);
  const address = await server.listen();
  const harness: Harness = {
    baseUrl: `http://${address.host}:${address.port}`,
    runtime,
    server,
    directory,
    configPath,
    policyPath,
    policyAuthority,
    infrastructureId: infrastructure.entity_id,
  };
  cleanups.push(async () => {
    await server.close();
    runtime.close();
  });
  return harness;
}

async function call(
  harness: Harness,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; body?: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${harness.baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, ...(parsed === undefined ? {} : { body: parsed }) };
}

function persistedText(directory: string): string {
  return [
    readFileSync(join(directory, "operational", "operational.jsonl"), "utf8"),
    readFileSync(join(directory, "secrets.enc.json"), "utf8"),
  ].join("\n");
}

describe("canonical infrastructure records", () => {
  it("rejects unknown and secret-shaped fields instead of stripping them", () => {
    const entity = makeInfrastructure();
    expect(
      InfrastructureSchema.safeParse({ ...entity, password: "must-not-be-stored" }).success,
    ).toBe(false);
    expect(
      InfrastructureSchema.safeParse({ ...entity, name: "token=super-secret-value" }).success,
    ).toBe(false);
    expect(
      InfrastructureSchema.safeParse({
        ...entity,
        endpoint: "https://user:pass@example.com:8443",
      }).success,
    ).toBe(false);
    expect(InfrastructureSchema.safeParse({ ...entity, endpoint: "127.0.0.1:8443" }).success).toBe(
      true,
    );
    // Canonical base fields are open-vocabulary strings; a secret pasted into one must not
    // bypass the infrastructure-specific SafeText fields.
    expect(
      InfrastructureSchema.safeParse({
        ...entity,
        relationships: [
          {
            target_entity_id: randomUUID(),
            target_entity_type: "canonical_object",
            relationship_type: "token=smuggled-through-relationship",
            direction: "outbound",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("stores only a broker reference, redacts secrets on disk and responses, and survives restart", async () => {
    const first = await startHarness();
    const entity = makeInfrastructure({ entity_id: first.infrastructureId });
    const firstSecret = "first-secret-material-5f0b9d6c";

    const created = await call(first, "POST", "/v1/infrastructure", {
      token: FOUNDER_TOKEN,
      body: { entity, secret: firstSecret },
    });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(firstSecret);
    const secretRef = created.body?.secret_ref as { entry_id: string } | undefined;
    expect(secretRef?.entry_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.runtime.secretBroker.resolve(secretRef?.entry_id ?? "")).toBe(firstSecret);
    expect(JSON.stringify(first.runtime.authorizationAudit.list())).not.toContain(firstSecret);

    const read = await call(first, "GET", `/v1/infrastructure/${entity.entity_id}`, {
      token: FOUNDER_TOKEN,
    });
    expect(read.status).toBe(200);
    expect(read.text).not.toContain(firstSecret);
    expect(read.text).toContain(secretRef?.entry_id ?? "");

    const policy = await call(first, "GET", `/v1/infrastructure/${entity.entity_id}/policy`, {
      token: FOUNDER_TOKEN,
    });
    expect(policy.status).toBe(200);
    expect((policy.body?.policy as { policy_id?: string }).policy_id).toMatch(/^[0-9a-f-]{36}$/);

    // A duplicate entity id is rejected after the broker stores a candidate credential.
    // The route must remove that unreferenced entry instead of leaving an orphan secret.
    const duplicate = await call(first, "POST", "/v1/infrastructure", {
      token: FOUNDER_TOKEN,
      body: { entity, secret: "duplicate-create-secret-3c4e5f6a" },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.text).not.toContain("duplicate-create-secret-3c4e5f6a");
    const brokerState = JSON.parse(
      readFileSync(join(first.directory, "secrets.enc.json"), "utf8"),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(brokerState.entries)).toHaveLength(1);
    expect(statSync(join(first.directory, "secrets.enc.json")).mode & 0o077).toBe(0);
    expect(statSync(first.directory).mode & 0o077).toBe(0);

    // A caller cannot retarget a record to another credential reference, including through
    // a replay/update path. The reference is assigned once by the host.
    expect(() =>
      first.runtime.infrastructure.updateInfrastructure(entity.entity_id, {
        secret_ref: { entry_id: randomUUID(), broker: "host_encrypted_file" },
      }),
    ).toThrow(/host-assigned and immutable/);

    const agentCreate = await call(first, "POST", "/v1/infrastructure", {
      token: AGENT_TOKEN,
      body: { entity: makeInfrastructure() },
    });
    expect(agentCreate.status).toBe(403);
    expect(agentCreate.body?.error).toBe("human_principal_required");

    const agentRotate = await call(first, "POST", `/v1/infrastructure/${entity.entity_id}/rotate`, {
      token: AGENT_TOKEN,
      body: { secret: "agent-cannot-rotate" },
    });
    expect(agentRotate.status).toBe(403);
    expect(agentRotate.body?.error).toBe("human_principal_required");

    expect(persistedText(first.directory)).not.toContain(firstSecret);
    await first.server.close();
    first.runtime.close();

    const secondConfig = loadHostConfig(first.configPath);
    const second = createHostRuntime({ config: secondConfig });
    const secondServer = createHostServer(second);
    const address = await secondServer.listen();
    cleanups.push(async () => {
      await secondServer.close();
      second.close();
    });
    const secondHarness: Harness = {
      ...first,
      runtime: second,
      server: secondServer,
      baseUrl: `http://${address.host}:${address.port}`,
    };

    expect(second.infrastructure.getInfrastructure(entity.entity_id)?.secret_ref).toEqual(
      secretRef,
    );
    expect(second.secretBroker.resolve(secretRef?.entry_id ?? "")).toBe(firstSecret);

    const secondSecret = "second-secret-material-8a7c1e2d";
    const rotated = await call(
      secondHarness,
      "POST",
      `/v1/infrastructure/${entity.entity_id}/rotate`,
      { token: FOUNDER_TOKEN, body: { secret: secondSecret } },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.text).not.toContain(secondSecret);
    expect(second.secretBroker.resolve(secretRef?.entry_id ?? "")).toBe(secondSecret);
    expect(persistedText(first.directory)).not.toContain(secondSecret);

    const archive = join(first.directory, "operational", "infrastructure-archive.json");
    second.operational.compact(archive);
    expect(second.infrastructure.getInfrastructure(entity.entity_id)?.secret_ref).toEqual(
      secretRef,
    );
    expect(
      readFileSync(join(first.directory, "operational", "operational.jsonl"), "utf8"),
    ).not.toContain(firstSecret);
    expect(
      readFileSync(join(first.directory, "operational", "operational.jsonl"), "utf8"),
    ).not.toContain(secondSecret);
    expect(readFileSync(archive, "utf8")).not.toContain(firstSecret);
    expect(readFileSync(archive, "utf8")).not.toContain(secondSecret);
  });

  it("rejects replayed infrastructure records that retarget their broker reference", () => {
    const directory = mkdtempSync(join(tmpdir(), "aios-infrastructure-replay-"));
    const entity = makeInfrastructure({
      secret_ref: { entry_id: randomUUID(), broker: "host_encrypted_file" },
    });
    const store = new DurableOperationalStore({ directory });
    store.infrastructure.createInfrastructure(entity);
    store.close();

    const reopened = new DurableOperationalStore({ directory });
    const current = reopened.infrastructure.getInfrastructure(entity.entity_id);
    if (!current) throw new Error("infrastructure record missing");
    const retargeted = {
      ...current,
      secret_ref: { entry_id: randomUUID(), broker: "host_encrypted_file" as const },
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    };
    reopened.journal.append("entity", { collection: "infrastructure", entity: retargeted });
    reopened.close();

    expect(() => new DurableOperationalStore({ directory })).toThrow(
      /immutable infrastructure identity or credential reference/,
    );
  });

  it("fails closed when no broker is configured and rejects a caller-supplied broker reference", async () => {
    const harness = await startHarness({ withBroker: false });
    const entity = makeInfrastructure({ entity_id: harness.infrastructureId });
    const created = await call(harness, "POST", "/v1/infrastructure", {
      token: FOUNDER_TOKEN,
      body: { entity, secret: "unavailable-broker-secret" },
    });
    expect(created.status).toBe(503);
    expect(created.body?.error).toBe("adapter_unavailable");
    expect(harness.runtime.secretBroker.available).toBe(false);

    const suppliedRef = await call(harness, "POST", "/v1/infrastructure", {
      token: FOUNDER_TOKEN,
      body: {
        entity: {
          ...entity,
          secret_ref: { entry_id: randomUUID(), broker: "host_encrypted_file" },
        },
      },
    });
    expect(suppliedRef.status).toBe(400);
    expect(suppliedRef.body?.error).toBe("broker_reference_reserved");

    const unlisted = await call(harness, "POST", "/v1/infrastructure", {
      token: FOUNDER_TOKEN,
      body: { entity: makeInfrastructure() },
    });
    expect(unlisted.status).toBe(403);
    expect(unlisted.body?.error).toBe("forbidden");
  });
});
