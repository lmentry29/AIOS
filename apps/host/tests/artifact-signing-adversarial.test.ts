import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrustRoot,
  generateSigningKey,
  parseSignedStatement,
  parseStrictJson,
  signArtifact,
  SigningError,
  verifyArtifactSignature,
  type SignatureSubject,
  type TrustRoot,
} from "../src/execution/artifact-signing.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.length = 0;
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "aios-signing-adversarial-"));
  temporaryDirectories.push(path);
  return path;
}

const now = Date.now();
const runtimePin = {
  schema_version: 1,
  provider: "gvisor",
  release: "test-release",
  architecture: "x86_64",
  artifact: { url: "https://example.invalid/gvisor.tar.bz2", sha512: "a".repeat(128) },
  runsc: { version: "release-test", sha256: "b".repeat(64) },
};
const runtimeSubject: SignatureSubject = {
  release: "test-release",
  runsc_version: "release-test",
  runsc_sha256: "b".repeat(64),
  artifact_sha512: "a".repeat(128),
};

interface Fixture {
  artifactPath: string;
  signaturePath: string;
  trustRootPath: string;
  statement: Record<string, unknown>;
  trustRoot: TrustRoot;
  keyId: string;
}

function fixture(): Fixture {
  const key = generateSigningKey();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: new Date(now - 60 * 60 * 1000).toISOString(),
    not_after: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const root = directory();
  const artifactPath = join(root, "pin.json");
  writeFileSync(artifactPath, `${JSON.stringify(runtimePin, null, 2)}\n`);
  const statement = signArtifact({
    artifact_kind: "gvisor-runtime-pin",
    artifact_path: artifactPath,
    key_id: key.key_id,
    private_key_pem: key.private_key_pem,
    trust_root: trustRoot,
    source: { repository: null, commit: null, workflow: null, run_id: null },
    subject: runtimeSubject,
  });
  const signaturePath = join(root, "pin.sig.json");
  writeFileSync(signaturePath, `${JSON.stringify(statement, null, 2)}\n`);
  const trustRootPath = join(root, "trust-root.json");
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`);
  return {
    artifactPath,
    signaturePath,
    trustRootPath,
    statement: statement as unknown as Record<string, unknown>,
    trustRoot,
    keyId: key.key_id,
  };
}

function verify(
  fixtureValue: Fixture,
  overrides: { kind?: "gvisor-runtime-pin" | "gvisor-rootfs-manifest" } = {},
) {
  return verifyArtifactSignature({
    artifact_kind: overrides.kind ?? "gvisor-runtime-pin",
    artifact_path: fixtureValue.artifactPath,
    signature_path: fixtureValue.signaturePath,
    trust_root_path: fixtureValue.trustRootPath,
    expected_subject: runtimeSubject,
  });
}

describe("strict statement parsing", () => {
  it("rejects duplicate keys instead of silently taking the last value", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}', "test")).toThrow(/duplicate key "a"/);
    expect(() => parseStrictJson('{"schema_version":2,"schema_version":1}', "test")).toThrow(
      /duplicate key/,
    );
  });

  it("rejects prototype-mutating and reserved keys at every level", () => {
    expect(() => parseStrictJson('{"__proto__":{"polluted":true}}', "test")).toThrow(
      /key "__proto__" is not allowed/,
    );
    expect(() => parseStrictJson('{"constructor":{}}', "test")).toThrow(
      /key "constructor" is not allowed/,
    );
    expect(() => parseStrictJson('{"a":{"prototype":{}}}', "test")).toThrow(
      /key "prototype" is not allowed/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects excessive nesting and trailing content", () => {
    const nested = `${"[".repeat(40)}0${"]".repeat(40)}`;
    expect(() => parseStrictJson(nested, "test")).toThrow(/nesting exceeds 32 levels/);
    expect(() => parseStrictJson('{"a":1} trailing', "test")).toThrow(/trailing content/);
  });

  it("rejects unterminated strings, control characters and non-finite numbers", () => {
    expect(() => parseStrictJson('{"a":"unterminated}', "test")).toThrow(/unterminated string/);
    expect(() => parseStrictJson('{"a":"line\nbreak"}', "test")).toThrow(/control character/);
    expect(() => parseStrictJson('{"a":1e9999}', "test")).toThrow(/number is not finite/);
  });

  it("rejects oversized statements before parsing", () => {
    const oversized = `{"padding":"${"a".repeat(1024 * 1024 + 1)}"}`;
    expect(() => parseSignedStatement(oversized)).toThrow(/exceeds the 1048576-byte limit/);
  });

  it("rejects schema_version 1 rather than accepting weaker parsing", () => {
    const value = fixture();
    const legacy = { ...value.statement, schema_version: 1 };
    expect(() => parseSignedStatement(JSON.stringify(legacy))).toThrow(
      /re-sign the artifact with schema_version 2/,
    );
  });

  it("rejects unknown fields, wrong subject types and malformed signatures", () => {
    const value = fixture();
    expect(() =>
      parseSignedStatement(JSON.stringify({ ...value.statement, extra: "field" })),
    ).toThrow(/unknown field "extra"/);
    expect(() =>
      parseSignedStatement(
        JSON.stringify({ ...value.statement, subject: { ...runtimeSubject, entries: 1.5 } }),
      ),
    ).toThrow(/must be a string or a safe integer/);
    expect(() =>
      parseSignedStatement(
        JSON.stringify({ ...value.statement, subject: { ...runtimeSubject, nested: { a: 1 } } }),
      ),
    ).toThrow(/must be a string or a safe integer/);
    expect(() =>
      parseSignedStatement(
        JSON.stringify({ ...value.statement, signature: Buffer.alloc(63).toString("base64") }),
      ),
    ).toThrow(/canonical 64-byte base64/);
    const zeroBytes = Buffer.alloc(64).toString("base64");
    const nonCanonical = `${zeroBytes.slice(0, -3)}B==`;
    expect(() =>
      parseSignedStatement(JSON.stringify({ ...value.statement, signature: nonCanonical })),
    ).toThrow(/canonical 64-byte base64/);
  });

  it("rejects a signature presented under the other artifact kind", () => {
    const value = fixture();
    expect(() => verify(value, { kind: "gvisor-rootfs-manifest" })).toThrow(
      /signature is for gvisor-runtime-pin/,
    );
  });

  it("ignores a public key supplied beside the artifact", () => {
    const value = fixture();
    const attacker = generateSigningKey();
    writeFileSync(join(value.signaturePath, "..", "attacker-public.pem"), attacker.public_key_pem);
    const attackerStatement = signArtifact({
      artifact_kind: "gvisor-runtime-pin",
      artifact_path: value.artifactPath,
      key_id: attacker.key_id,
      private_key_pem: attacker.private_key_pem,
      source: { repository: null, commit: null, workflow: null, run_id: null },
      subject: runtimeSubject,
    });
    writeFileSync(value.signaturePath, JSON.stringify(attackerStatement));
    expect(() => verify(value)).toThrow(/not present in the trust root/);
  });

  it("rejects duplicate, unknown and dangerous trust-root entries", () => {
    const value = fixture();
    const duplicate = {
      schema_version: 2,
      keys: [...value.trustRoot.keys, ...value.trustRoot.keys],
    };
    writeFileSync(value.trustRootPath, JSON.stringify(duplicate));
    expect(() => verify(value)).toThrow(/duplicate key id/);

    const unknown = {
      schema_version: 2,
      keys: [{ ...value.trustRoot.keys[0], extra: true }],
    };
    writeFileSync(value.trustRootPath, JSON.stringify(unknown));
    expect(() => verify(value)).toThrow(/unknown field "extra"/);

    writeFileSync(value.trustRootPath, '{"schema_version":1,"__proto__":{"keys":[]}}');
    expect(() => verify(value)).toThrow(/key "__proto__" is not allowed/);
  });
});

/** Deterministic mutator: same seed, same cases, no network and no wall-clock dependence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("mutation fuzzing", () => {
  it("never authorizes a different digest or key from a mutated statement", () => {
    const value = fixture();
    const original = readFileSync(value.signaturePath, "utf8");
    const random = mulberry32(0x5eed);
    let rejected = 0;
    for (let iteration = 0; iteration < 250; iteration += 1) {
      let mutated = original;
      const operation = Math.floor(random() * 4);
      const position = Math.floor(random() * mutated.length);
      if (operation === 0) {
        mutated = `${mutated.slice(0, position)}${String.fromCharCode(32 + Math.floor(random() * 95))}${mutated.slice(position + 1)}`;
      } else if (operation === 1) {
        mutated = `${mutated.slice(0, position)}${mutated.slice(position + 2)}`;
      } else if (operation === 2) {
        mutated = `${mutated.slice(0, position)}"x"${mutated.slice(position)}`;
      } else {
        mutated = `${mutated.slice(0, position)}${mutated.slice(position, position + 3)}${mutated.slice(position)}`;
      }
      writeFileSync(value.signaturePath, mutated);
      try {
        const verified = verify(value);
        // The only mutations that may still verify are formatting changes outside signed
        // fields; authorization fields must be byte-for-byte identical to the original.
        expect(verified.key_id).toBe(value.keyId);
        expect(verified.artifact_sha256).toBe(value.statement.artifact_sha256);
        expect(verified.subject).toEqual(runtimeSubject);
        expect(verified.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
      } catch (error) {
        expect(error).toBeInstanceOf(SigningError);
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(200);
  });

  it("never returns a non-strict or prototype-mutated trust root", () => {
    const value = fixture();
    const original = readFileSync(value.trustRootPath, "utf8");
    const random = mulberry32(0x1234);
    for (let iteration = 0; iteration < 150; iteration += 1) {
      const position = Math.floor(random() * original.length);
      const mutated = `${original.slice(0, position)}${String.fromCharCode(32 + Math.floor(random() * 95))}${original.slice(position + 1)}`;
      writeFileSync(value.trustRootPath, mutated);
      try {
        verify(value);
      } catch (error) {
        expect(error).toBeInstanceOf(SigningError);
      }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
