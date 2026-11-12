import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildAttestationError, measureBuildArtifact } from "../src/execution/build-provenance.js";
import { FileIntegrityError, readBoundedRegularFile } from "../src/security/file-integrity.js";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "aios-file-integrity-"));
}

describe("host file-integrity boundary", () => {
  it("reads a bounded regular file through a no-follow descriptor", () => {
    const root = directory();
    const path = join(root, "artifact.bin");
    writeFileSync(path, "payload", { mode: 0o600 });
    const contents = readBoundedRegularFile(path, "artifact", 1024);
    expect(contents.toString("utf8")).toBe("payload");
    expect(createHash("sha256").update(contents).digest("hex")).toBe(
      createHash("sha256").update("payload").digest("hex"),
    );
  });

  it("rejects a symlink instead of hashing its target", () => {
    const root = directory();
    const target = join(root, "target");
    writeFileSync(target, "outside", { mode: 0o600 });
    const link = join(root, "link");
    symlinkSync(target, link);
    try {
      readBoundedRegularFile(link, "artifact", 1024);
      throw new Error("expected the no-follow read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FileIntegrityError);
      expect((error as FileIntegrityError).code).toBe("not_regular");
      expect((error as Error).message).toContain("not a symlink");
    }
  });

  it("rejects an oversized file before allocating the whole payload", () => {
    const root = directory();
    const path = join(root, "large.bin");
    writeFileSync(path, Buffer.alloc(2048), { mode: 0o600 });
    expect(() => readBoundedRegularFile(path, "artifact", 1024)).toThrow(
      /exceeds the 1024-byte limit/,
    );
  });

  it("refuses a safe-looking symlink to a protected credential file", () => {
    const root = directory();
    const secret = join(root, ".env");
    writeFileSync(secret, "SECRET=value", { mode: 0o600 });
    const link = join(root, "artifact.bin");
    symlinkSync(secret, link);
    expect(() => measureBuildArtifact("artifact-b", link)).toThrow(/regular file|symlink/);
  });

  it("refuses to measure a protected credential artifact", () => {
    const root = directory();
    const path = join(root, ".env");
    writeFileSync(path, "SECRET=value", { mode: 0o600 });
    expect(() => measureBuildArtifact("artifact-a", path)).toThrow(BuildAttestationError);
    expect(() => measureBuildArtifact(".env", path)).toThrow(BuildAttestationError);
  });
});
