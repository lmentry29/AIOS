import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedFileSecretBroker } from "../src/security/secret-broker.js";

function brokerFixture(): {
  directory: string;
  storeFile: string;
  broker: EncryptedFileSecretBroker;
} {
  const directory = mkdtempSync(join(tmpdir(), "aios-broker-"));
  const keyFile = join(directory, "broker.key");
  const storeFile = join(directory, "secrets.enc.json");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  return {
    directory,
    storeFile,
    broker: new EncryptedFileSecretBroker({ store_file: storeFile, key_file: keyFile }),
  };
}

describe("encrypted file secret broker", () => {
  it("rolls back in-memory state when a durable write fails", () => {
    const fixture = brokerFixture();
    const entryId = fixture.broker.create("original-secret-value");
    expect(fixture.broker.resolve(entryId)).toBe("original-secret-value");

    // Simulate the owner directory becoming unsafe between writes. writeStore must refuse
    // before touching disk, and the broker must not expose a value that was never durable.
    chmodSync(fixture.directory, 0o755);
    expect(() => fixture.broker.rotate(entryId, "replacement-secret-value")).toThrow(/owner-only/);
    expect(fixture.broker.resolve(entryId)).toBe("original-secret-value");
    expect(() => fixture.broker.create("uncommitted-secret-value")).toThrow(/owner-only/);

    const onDisk = JSON.parse(readFileSync(fixture.storeFile, "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.entries)).toHaveLength(1);

    chmodSync(fixture.directory, 0o700);
    fixture.broker.rotate(entryId, "replacement-secret-value");
    expect(fixture.broker.resolve(entryId)).toBe("replacement-secret-value");
    expect(statSync(fixture.storeFile).mode & 0o077).toBe(0);
  });

  it("removes an unreferenced entry without exposing its value", () => {
    const { broker } = brokerFixture();
    const entryId = broker.create("orphan-secret-value");
    expect(broker.has(entryId)).toBe(true);
    broker.remove(entryId);
    expect(broker.has(entryId)).toBe(false);
    expect(() => broker.resolve(entryId)).toThrow(/not found/);
    expect(() => broker.rotate(entryId, "cannot-revive")).toThrow(/not found/);
    expect(() => broker.remove(randomUUID())).not.toThrow();
  });
});
