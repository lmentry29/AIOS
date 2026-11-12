import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationDecisionAudit } from "@aios/founder";
import { DurableAuthorizationAuditStore } from "../src/persistence/authorization-audit-store.js";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-authorization-audit-"));
}

function allow(overrides: Partial<AuthorizationDecisionAudit> = {}): AuthorizationDecisionAudit {
  return {
    request_id: randomUUID(),
    actor_id: "human:founder",
    action: "read_evidence",
    resource_id: randomUUID(),
    policy_id: randomUUID(),
    policy_version: 1,
    decision: "allow",
    reason: "matching_allow",
    matched_rule_index: 0,
    matched_rule_effect: "allow",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function deny(overrides: Partial<AuthorizationDecisionAudit> = {}): AuthorizationDecisionAudit {
  return {
    request_id: randomUUID(),
    actor_id: "human:other",
    action: "read_evidence",
    resource_id: randomUUID(),
    policy_id: randomUUID(),
    policy_version: 1,
    decision: "deny",
    reason: "no_matching_allow",
    matched_rule_index: null,
    matched_rule_effect: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const AUDIT_HEAD = "authorization-audit.head.json";
const ZERO_HASH = "0".repeat(64);

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
      .map(([key, json]) => `${JSON.stringify(key)}:${json}`);
    return `{${entries.join(",")}}`;
  }
  if (value === undefined) return undefined;
  return JSON.stringify(value) as string;
}

function journalRecordHash(record: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(record) ?? "")
    .digest("hex");
}

function readJournal(directory: string): Array<Record<string, unknown>> {
  return readFileSync(join(directory, "authorization-audit.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rehashJournal(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let previousHash = ZERO_HASH;
  records.forEach((record, index) => {
    record.sequence = index + 1;
    record.previous_hash = previousHash;
    const { hash: _hash, ...unsigned } = record;
    record.hash = journalRecordHash(unsigned);
    previousHash = record.hash as string;
  });
  return records;
}

function writeJournal(directory: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(directory, "authorization-audit.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

describe("DurableAuthorizationAuditStore", () => {
  it("records allow and deny decisions in order and preserves them across reopen", async () => {
    const directory = stateDirectory();
    const first = new DurableAuthorizationAuditStore({ directory });
    const allowed = allow();
    const denied = deny();
    await first.append(allowed);
    await first.append(denied);
    expect(first.list().map((record) => record.decision)).toEqual(["allow", "deny"]);
    first.close();

    const second = new DurableAuthorizationAuditStore({ directory });
    expect(second.list()).toEqual([allowed, denied]);
    expect(second.recoveredTornTail).toBe(false);
    second.close();
  });

  it("rejects unknown fields and invalid reason codes without writing a record", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await expect(store.append({ ...allow(), token: "secret-token" } as never)).rejects.toThrow(
      /unsupported field/,
    );
    await expect(store.append(allow({ reason: "raw error with secret-token" }))).rejects.toThrow(
      /invalid/,
    );
    expect(store.list()).toEqual([]);
    store.close();
  });

  it("detects an out-of-band edit to a complete record on reopen", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    store.close();

    const path = join(directory, "authorization-audit.jsonl");
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain('"timestamp":"2');
    writeFileSync(path, contents.replace('"timestamp":"2', '"timestamp":"1'), { mode: 0o600 });
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/hash-chain/);
  });

  it("recovers an interrupted trailing append and keeps complete records", async () => {
    const directory = stateDirectory();
    const first = new DurableAuthorizationAuditStore({ directory });
    await first.append(allow());
    first.close();

    appendFileSync(join(directory, "authorization-audit.jsonl"), '{"sequence":2');
    const second = new DurableAuthorizationAuditStore({ directory });
    expect(second.recoveredTornTail).toBe(true);
    expect(second.list()).toHaveLength(1);
    await second.append(deny());
    second.close();

    const third = new DurableAuthorizationAuditStore({ directory });
    expect(third.list().map((record) => record.decision)).toEqual(["allow", "deny"]);
    third.close();
  });

  it("fails the append and does not record a phantom decision at the size limit", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory, maxBytes: 4096 });
    let appended = 0;
    let failed = false;
    for (let index = 0; index < 20; index += 1) {
      try {
        await store.append(allow());
        appended += 1;
      } catch {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(store.list()).toHaveLength(appended);
    store.close();

    const reopened = new DurableAuthorizationAuditStore({ directory, maxBytes: 4096 });
    expect(reopened.list()).toHaveLength(appended);
    reopened.close();
  });

  it("rejects removal of trailing records against the durable high-water mark", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    await store.append(deny());
    store.close();

    writeJournal(directory, readJournal(directory).slice(0, 1));
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/record count/);
  });

  it("rejects rollback to an older internally consistent prefix", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    await store.append(deny());
    const prefix = readJournal(directory);
    await store.append(allow());
    store.close();

    writeJournal(directory, prefix);
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/record count/);
  });

  it("rejects an appended record that is absent from the high-water mark", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    await store.append(deny());
    store.close();

    const records = readJournal(directory);
    const inserted = { ...records[0], sequence: 3, previous_hash: records[1]?.hash };
    writeJournal(directory, rehashJournal([...records, inserted]));
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/record count/);
  });

  it("rejects a reordered journal whose chain was recomputed but whose head differs", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    await store.append(deny());
    store.close();

    const records = readJournal(directory);
    writeJournal(
      directory,
      rehashJournal([records[1] as Record<string, unknown>, records[0] as Record<string, unknown>]),
    );
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/head hash/);
  });

  it("rejects a non-empty journal with no durable head anchor", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    store.close();

    rmSync(join(directory, AUDIT_HEAD));
    expect(() => new DurableAuthorizationAuditStore({ directory })).toThrow(/head is missing/);
  });

  it("keeps raw credentials out of the serialized journal", async () => {
    const directory = stateDirectory();
    const store = new DurableAuthorizationAuditStore({ directory });
    await store.append(allow());
    store.close();

    const contents = readFileSync(join(directory, "authorization-audit.jsonl"), "utf8");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain("Bearer");
    expect(contents).not.toContain("founder-token");
  });
});
