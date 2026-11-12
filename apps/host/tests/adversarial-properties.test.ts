import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStrictJson, SigningError } from "../src/execution/artifact-signing.js";
import { canonicalEvidenceJson } from "../src/execution/evidence-bundle.js";
import {
  createOwnedStagingDirectory,
  promoteOwnedDirectory,
  removeOwnedDirectory,
} from "../src/execution/provenance.js";
import { measureWorkspaceBytes } from "../src/execution/workspace.js";

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `aios-adversarial-${prefix}-`));
}

function mulberry32(seed: number): () => number {
  const state = seed;
  return () => {
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("adversarial properties", () => {
  it("strict JSON either rejects a seeded mutation or returns a canonical round-trippable document", () => {
    const original = JSON.stringify({
      schema_version: 1,
      nested: { list: [1, "two", true, null], object: { z: 1, a: 2 } },
      digest: "a".repeat(64),
    });
    const random = mulberry32(0x51a7);
    let rejected = 0;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const position = Math.floor(random() * original.length);
      const operation = Math.floor(random() * 3);
      const replacement = String.fromCharCode(32 + Math.floor(random() * 95));
      const mutated =
        operation === 0
          ? `${original.slice(0, position)}${replacement}${original.slice(position + 1)}`
          : operation === 1
            ? `${original.slice(0, position)}${original.slice(position + 2)}`
            : `${original.slice(0, position)}${original.slice(position, position + 2)}${original.slice(position)}`;
      try {
        const parsed = parseStrictJson(mutated, "property document");
        const canonical = canonicalEvidenceJson(parsed);
        expect(parseStrictJson(canonical, "canonical property document")).toEqual(parsed);
      } catch (error) {
        expect(error).toBeInstanceOf(SigningError);
        rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(250);
  });

  it("canonical hashing ignores key order but detects nested value changes", () => {
    const random = mulberry32(0xc0de);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const a = Math.floor(random() * 1_000_000);
      const b = `value-${Math.floor(random() * 1_000_000)}`;
      const first = { z: a, nested: { b, a }, list: [a, b] };
      const second = { list: [a, b], nested: { a, b }, z: a };
      expect(canonicalEvidenceJson(first)).toBe(canonicalEvidenceJson(second));
      expect(canonicalEvidenceJson({ ...first, z: a + 1 })).not.toBe(canonicalEvidenceJson(first));
      expect(canonicalEvidenceJson({ ...first, nested: { ...first.nested, b: `${b}!` } })).not.toBe(
        canonicalEvidenceJson(first),
      );
    }
  });

  it("does not follow seeded symlinks out of a workspace when accounting bytes", () => {
    const random = mulberry32(0x5a1);
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const root = directory(`workspace-${iteration}-`);
      const outside = directory(`outside-${iteration}-`);
      const secret = "outside-secret-".repeat(100);
      writeFileSync(join(outside, "secret"), secret, { mode: 0o600 });
      writeFileSync(join(root, "inside"), "inside", { mode: 0o600 });
      const name = `link-${Math.floor(random() * 1_000_000)}`;
      symlinkSync(join(outside, "secret"), join(root, name));
      symlinkSync(outside, join(root, `${name}-dir`), "dir");
      expect(measureWorkspaceBytes(root)).toBe(Buffer.byteLength("inside"));
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("fault-injects partial staging, replacement, symlink substitution and promotion", () => {
    const random = mulberry32(0xf001);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const parent = directory(`staging-${iteration}-`);
      const destination = join(parent, `output-${Math.floor(random() * 1_000_000)}`);
      const stage = createOwnedStagingDirectory(parent, "stage-");
      writeFileSync(join(stage.path, "partial"), "partial extraction", { mode: 0o600 });
      const fault = iteration % 4;
      if (fault === 0) {
        // Simulate interruption before promotion: cleanup removes only this invocation's inode.
        removeOwnedDirectory(stage);
        expect(existsSync(destination)).toBe(false);
        expect(existsSync(stage.path)).toBe(false);
      } else if (fault === 1) {
        // Destination substitution must never be replaced.
        mkdirSync(destination);
        writeFileSync(join(destination, "operator-owned"), "keep", { mode: 0o600 });
        expect(() => promoteOwnedDirectory(stage, destination)).toThrow(/existing gVisor output/);
        expect(readFileSync(join(destination, "operator-owned"), "utf8")).toBe("keep");
        removeOwnedDirectory(stage);
      } else if (fault === 2) {
        // Staging path replaced by a symlink: cleanup must not recurse through it.
        const moved = join(parent, "moved");
        renameSync(stage.path, moved);
        symlinkSync(moved, stage.path, "dir");
        removeOwnedDirectory(stage);
        expect(readFileSync(join(moved, "partial"), "utf8")).toBe("partial extraction");
        rmSync(stage.path, { force: true });
        rmSync(moved, { recursive: true, force: true });
      } else {
        // Successful promotion, then cleanup of the old staging path cannot touch the output.
        promoteOwnedDirectory(stage, destination);
        removeOwnedDirectory(stage);
        expect(readFileSync(join(destination, "partial"), "utf8")).toBe("partial extraction");
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
