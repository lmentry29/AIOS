#!/usr/bin/env node
/**
 * Provision, rotate, revoke and inspect the external Ed25519 trust root.
 *
 * Private keys are written only to an operator-supplied runtime path with mode 0600.
 * The trust root contains public keys only and is the same document consumed by
 * artifact-signing.ts, build-provenance.ts and evidence-bundle.ts. The checked-in root
 * remains an empty fail-closed placeholder until an operator deliberately provisions it.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  createTrustRoot,
  createTrustRootFromKeys,
  generateSigningKey,
  keyIdForPublicKey,
  loadTrustRoot,
  parseStrictJson,
} from "../../apps/host/dist/execution/artifact-signing.js";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function flag(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (required) fail(`--${name} is required`);
    return undefined;
  }
  return value;
}

function regularFile(path, label) {
  const resolved = resolve(path);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink() || !stats.isFile())
    fail(`${label} must be a regular file: ${resolved}`);
  return resolved;
}

function writeNewFileAtomic(path, contents, mode) {
  const target = resolve(path);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    linkSync(temporary, target);
    try {
      unlinkSync(temporary);
    } catch {
      // The complete target exists; leave only an invocation-owned temporary file.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of the invocation-owned temporary file only.
    }
    throw error;
  }
}

/** Atomic replace; creation uses link(2) so a concurrent target is never overwritten. */
function writeAtomic(path, value, replace = true) {
  const target = resolve(path);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o644);
    if (replace) {
      renameSync(temporary, target);
    } else {
      linkSync(temporary, target);
      try {
        unlinkSync(temporary);
      } catch {
        // The complete target exists; leave only an invocation-owned temporary file.
      }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of the invocation-owned temporary file only.
    }
    throw error;
  }
}

function publicKey(path) {
  const pem = readFileSync(regularFile(path, "public key"), "utf8");
  return { public_key_pem: pem, key_id: keyIdForPublicKey(pem) };
}

function isEmptyTrustRoot(path) {
  let parsed;
  try {
    parsed = parseStrictJson(readFileSync(path, "utf8"), "trust root");
  } catch (error) {
    fail(
      `the existing trust root is not strict JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    parsed.schema_version === 1 &&
    Array.isArray(parsed.keys) &&
    parsed.keys.length === 0
  );
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === "keygen") {
    const privatePath = resolve(flag("private"));
    const publicPath = resolve(flag("public"));
    const key = generateSigningKey();
    writeNewFileAtomic(privatePath, key.private_key_pem, 0o600);
    writeNewFileAtomic(publicPath, key.public_key_pem, 0o644);
    output({ key_id: key.key_id, private_key: privatePath, public_key: publicPath });
    return;
  }
  if (command === "init") {
    const rootPath = resolve(flag("trust-root"));
    const key = publicKey(flag("public-key"));
    const root = createTrustRoot({
      key_id: key.key_id,
      public_key_pem: key.public_key_pem,
      not_before: flag("not-before"),
      not_after: flag("not-after"),
    });
    let exists = false;
    try {
      lstatSync(rootPath);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) {
      if (!process.argv.includes("--replace-empty")) {
        fail(
          `trust root already exists: ${rootPath}; use --replace-empty only to replace an empty root`,
        );
      }
      if (!isEmptyTrustRoot(rootPath))
        fail(`refusing to replace a non-empty trust root: ${rootPath}`);
    }
    writeAtomic(rootPath, root, exists);
    output({
      ok: true,
      command: "init",
      trust_root: rootPath,
      key_id: key.key_id,
      keys: root.keys.length,
    });
    return;
  }
  if (command === "rotate") {
    const rootPath = resolve(flag("trust-root"));
    const existing = loadTrustRoot(rootPath);
    const key = publicKey(flag("public-key"));
    const root = createTrustRootFromKeys([
      ...existing.keys,
      {
        key_id: key.key_id,
        public_key_pem: key.public_key_pem,
        not_before: flag("not-before"),
        not_after: flag("not-after"),
      },
    ]);
    writeAtomic(rootPath, root);
    output({
      ok: true,
      command: "rotate",
      trust_root: rootPath,
      key_id: key.key_id,
      keys: root.keys.length,
    });
    return;
  }
  if (command === "revoke") {
    const rootPath = resolve(flag("trust-root"));
    const keyId = flag("key-id");
    const existing = loadTrustRoot(rootPath);
    let found = false;
    const root = createTrustRootFromKeys(
      existing.keys.map((key) => {
        if (key.key_id !== keyId) return key;
        found = true;
        return { ...key, status: "revoked" };
      }),
    );
    if (!found) fail(`key ${keyId} is not present in ${rootPath}`);
    writeAtomic(rootPath, root);
    output({ ok: true, command: "revoke", trust_root: rootPath, key_id: keyId, status: "revoked" });
    return;
  }
  if (command === "list" || command === "validate") {
    const rootPath = resolve(flag("trust-root"));
    const root = loadTrustRoot(rootPath);
    output({
      ok: true,
      command,
      trust_root: rootPath,
      keys: root.keys.map((key) => ({
        key_id: key.key_id,
        status: key.status,
        not_before: key.not_before,
        not_after: key.not_after,
      })),
    });
    return;
  }
  fail("usage: trust-root.mjs keygen|init|rotate|revoke|list|validate ...");
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown trust-root lifecycle error");
}
