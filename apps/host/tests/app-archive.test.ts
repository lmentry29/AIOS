import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustRoot, generateSigningKey } from "../src/execution/artifact-signing.js";
import { createReleaseArchive, verifyReleaseArchive } from "../../tools/security/app-archive.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "aios-host";
const PROFILE = "local-secure";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aios-app-archive-"));
  mkdirSync(join(root, "apps/host/dist"), { recursive: true });
  mkdirSync(join(root, "packages/core/dist"), { recursive: true });
  writeFileSync(
    join(root, "apps/host/package.json"),
    `${JSON.stringify({ name: "@aios/host", version: "0.1.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(root, "apps/host/dist/cli.js"), "console.log('host');\n");
  writeFileSync(join(root, "apps/host/dist/index.js"), "export const host = true;\n");
  writeFileSync(join(root, "packages/core/dist/index.js"), "export const core = true;\n");
  writeFileSync(join(root, "package.json"), '{ "name": "aios", "private": true }\n');
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const key = generateSigningKey();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    purpose: "artifact",
    not_before: new Date(Date.now() - 60_000).toISOString(),
    not_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const trustRootPath = join(root, "trust-root.json");
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`, { mode: 0o600 });
  return { root, key, trustRoot, trustRootPath };
}

function create(options: {
  root: string;
  key: ReturnType<typeof generateSigningKey>;
  trustRoot: ReturnType<typeof createTrustRoot>;
}) {
  const archive = join(options.root, "aios-host.tar");
  const signature = join(options.root, "aios-host.tar.sig.json");
  return createReleaseArchive({
    root: options.root,
    archive,
    signature,
    commit: COMMIT,
    release: RELEASE,
    profile: PROFILE,
    version: "0.1.0",
    privateKeyPem: options.key.private_key_pem,
    keyId: options.key.key_id,
    trustRoot: options.trustRoot,
  });
}

function verify(
  created: ReturnType<typeof createReleaseArchive>,
  trustRootPath: string,
  overrides: Record<string, string> = {},
) {
  return verifyReleaseArchive({
    archive: created.archive,
    signature: created.signature,
    trustRootPath,
    release: RELEASE,
    version: "0.1.0",
    commit: COMMIT,
    profile: PROFILE,
    ...overrides,
  });
}

describe("signed application archive (ADR-0038)", () => {
  it("creates a deterministic archive with an inventory and verifies it offline", () => {
    const { root, key, trustRoot, trustRootPath } = fixture();
    const created = create({ root, key, trustRoot });
    expect(created.signed).toBe(true);
    expect(created.manifest.entrypoint).toBe("apps/host/dist/cli.js");
    expect(created.manifest.files.map((entry) => entry.path)).toContain("apps/host/dist/cli.js");
    const verified = verify(created, trustRootPath);
    expect(verified.key_id).toBe(key.key_id);
    expect(verified.manifest.commit).toBe(COMMIT);
    expect(verified.manifest.files.map((entry) => entry.path)).not.toContain(".env");
  });

  it("rejects an archive whose bytes changed after signing", () => {
    const { root, key, trustRoot, trustRootPath } = fixture();
    const created = create({ root, key, trustRoot });
    const tampered = join(root, "tampered.tar");
    const bytes = readFileSync(created.archive);
    bytes[bytes.length - 1024] = bytes[bytes.length - 1024] ^ 1;
    writeFileSync(tampered, bytes);
    expect(() =>
      verifyReleaseArchive({
        archive: tampered,
        signature: created.signature,
        trustRootPath,
        release: RELEASE,
        version: "0.1.0",
        commit: COMMIT,
        profile: PROFILE,
      }),
    ).toThrow(/not over this artifact/);
  });

  it("rejects a release identity mismatch", () => {
    const { root, key, trustRoot, trustRootPath } = fixture();
    const created = create({ root, key, trustRoot });
    expect(() => verify(created, trustRootPath, { commit: "f".repeat(40) })).toThrow(
      /does not match/,
    );
  });

  it("refuses to package a secret-bearing path", () => {
    const { root, key, trustRoot } = fixture();
    writeFileSync(join(root, "apps/host/dist/.env"), "TOKEN=not-a-real-secret\n");
    expect(() => create({ root, key, trustRoot })).toThrow(/secret-bearing/);
  });

  it("refuses to sign with a non-artifact-purpose key", () => {
    const { root, key } = fixture();
    const policyRoot = createTrustRoot({
      key_id: key.key_id,
      public_key_pem: key.public_key_pem,
      purpose: "policy",
      not_before: new Date(Date.now() - 60_000).toISOString(),
      not_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(() => create({ root, key, trustRoot: policyRoot })).toThrow(/artifact-purpose/);
  });
});
