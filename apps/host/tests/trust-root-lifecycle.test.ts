import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTrustRoot } from "../src/execution/artifact-signing.js";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "aios-trust-root-lifecycle-"));
}

function run(tool: string, args: string[]) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
}

function runAsync(
  tool: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function parsed(result: ReturnType<typeof run>): Record<string, unknown> {
  expect(result.stdout.length, result.stderr).toBeGreaterThan(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const trustRootTool = fileURLToPath(
  new URL("../../../tools/security/trust-root.mjs", import.meta.url),
);
const signTool = fileURLToPath(
  new URL("../../../tools/security/sign-artifacts.mjs", import.meta.url),
);

describe("trust-root lifecycle CLI", () => {
  it("provisions, rotates, revokes and verifies with the external root", () => {
    const root = directory();
    const oldPrivate = join(root, "old-key.pem");
    const oldPublic = join(root, "old-key.pub.pem");
    const newPrivate = join(root, "new-key.pem");
    const newPublic = join(root, "new-key.pub.pem");
    const trustRootPath = join(root, "trust-root.json");
    const pinPath = join(root, "gvisor-runtime.pin.json");
    const oldSignature = join(root, "old.sig.json");
    const newSignature = join(root, "new.sig.json");
    writeFileSync(
      pinPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          provider: "gvisor",
          release: "test-release",
          architecture: "x86_64",
          artifact: { url: "https://example.invalid/gvisor.tar.bz2", sha512: "a".repeat(128) },
          runsc: { version: "release-test", sha256: "b".repeat(64) },
        },
        null,
        2,
      )}\n`,
    );

    const oldKey = parsed(
      run(trustRootTool, ["keygen", "--private", oldPrivate, "--public", oldPublic]),
    );
    expect(statSync(oldPrivate).mode & 0o777).toBe(0o600);
    const oldKeyId = oldKey.key_id as string;
    expect(statSync(oldPublic).mode & 0o777).toBe(0o644);

    const initialized = parsed(
      run(trustRootTool, [
        "init",
        "--trust-root",
        trustRootPath,
        "--public-key",
        oldPublic,
        "--not-before",
        "2020-01-01T00:00:00.000Z",
        "--not-after",
        "2030-01-01T00:00:00.000Z",
      ]),
    );
    expect(initialized).toMatchObject({ ok: true, keys: 1, key_id: oldKeyId });
    expect(loadTrustRoot(trustRootPath).keys).toHaveLength(1);

    const signedOld = run(signTool, [
      "sign",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--key",
      oldPrivate,
      "--trust-root",
      trustRootPath,
      "--out",
      oldSignature,
    ]);
    expect(signedOld.status, signedOld.stderr).toBe(0);
    const verifiedOld = run(signTool, [
      "verify",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--signature",
      oldSignature,
      "--trust-root",
      trustRootPath,
      "--expect-key-id",
      oldKeyId,
    ]);
    expect(verifiedOld.status, verifiedOld.stderr).toBe(0);

    const newKey = parsed(
      run(trustRootTool, ["keygen", "--private", newPrivate, "--public", newPublic]),
    );
    const newKeyId = newKey.key_id as string;
    expect(newKeyId).not.toBe(oldKeyId);
    const rotated = parsed(
      run(trustRootTool, [
        "rotate",
        "--trust-root",
        trustRootPath,
        "--public-key",
        newPublic,
        "--not-before",
        "2025-01-01T00:00:00.000Z",
        "--not-after",
        "2035-01-01T00:00:00.000Z",
      ]),
    );
    expect(rotated).toMatchObject({ ok: true, keys: 2, key_id: newKeyId });
    expect(loadTrustRoot(trustRootPath).keys.map((key) => key.key_id)).toEqual([
      oldKeyId,
      newKeyId,
    ]);

    const oldDuringOverlap = run(signTool, [
      "verify",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--signature",
      oldSignature,
      "--trust-root",
      trustRootPath,
      "--expect-key-id",
      oldKeyId,
    ]);
    expect(oldDuringOverlap.status, oldDuringOverlap.stderr).toBe(0);
    const signedNew = run(signTool, [
      "sign",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--key",
      newPrivate,
      "--trust-root",
      trustRootPath,
      "--out",
      newSignature,
    ]);
    expect(signedNew.status, signedNew.stderr).toBe(0);
    const verifiedNew = run(signTool, [
      "verify",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--signature",
      newSignature,
      "--trust-root",
      trustRootPath,
      "--expect-key-id",
      newKeyId,
    ]);
    expect(verifiedNew.status, verifiedNew.stderr).toBe(0);

    const revoked = parsed(
      run(trustRootTool, ["revoke", "--trust-root", trustRootPath, "--key-id", oldKeyId]),
    );
    expect(revoked).toMatchObject({ ok: true, key_id: oldKeyId, status: "revoked" });
    expect(loadTrustRoot(trustRootPath).keys.find((key) => key.key_id === oldKeyId)?.status).toBe(
      "revoked",
    );
    const oldAfterRevocation = run(signTool, [
      "verify",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--signature",
      oldSignature,
      "--trust-root",
      trustRootPath,
      "--expect-key-id",
      oldKeyId,
    ]);
    expect(oldAfterRevocation.status).not.toBe(0);
    const newAfterRevocation = run(signTool, [
      "verify",
      "--kind",
      "runtime-pin",
      "--artifact",
      pinPath,
      "--signature",
      newSignature,
      "--trust-root",
      trustRootPath,
      "--expect-key-id",
      newKeyId,
    ]);
    expect(newAfterRevocation.status, newAfterRevocation.stderr).toBe(0);
  });

  it("never overwrites a root created concurrently", async () => {
    const root = directory();
    const privatePath = join(root, "key.pem");
    const publicPath = join(root, "key.pub.pem");
    const trustRootPath = join(root, "trust-root.json");
    parsed(run(trustRootTool, ["keygen", "--private", privatePath, "--public", publicPath]));
    const args = [
      "init",
      "--trust-root",
      trustRootPath,
      "--public-key",
      publicPath,
      "--not-before",
      "2020-01-01T00:00:00.000Z",
      "--not-after",
      "2030-01-01T00:00:00.000Z",
    ];
    const results = await Promise.all([
      runAsync(trustRootTool, args),
      runAsync(trustRootTool, args),
    ]);
    expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    expect(loadTrustRoot(trustRootPath).keys).toHaveLength(1);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses to overwrite an existing non-empty trust root", () => {
    const root = directory();
    const privatePath = join(root, "key.pem");
    const publicPath = join(root, "key.pub.pem");
    const trustRootPath = join(root, "trust-root.json");
    parsed(run(trustRootTool, ["keygen", "--private", privatePath, "--public", publicPath]));
    parsed(
      run(trustRootTool, [
        "init",
        "--trust-root",
        trustRootPath,
        "--public-key",
        publicPath,
        "--not-before",
        "2020-01-01T00:00:00.000Z",
        "--not-after",
        "2030-01-01T00:00:00.000Z",
      ]),
    );
    const before = readFileSync(trustRootPath, "utf8");
    const rejected = run(trustRootTool, [
      "init",
      "--trust-root",
      trustRootPath,
      "--public-key",
      publicPath,
      "--not-before",
      "2020-01-01T00:00:00.000Z",
      "--not-after",
      "2030-01-01T00:00:00.000Z",
    ]);
    expect(rejected.status).not.toBe(0);
    expect(readFileSync(trustRootPath, "utf8")).toBe(before);
  });
});
