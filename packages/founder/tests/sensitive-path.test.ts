import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SensitivePathError,
  assertNotSensitivePath,
  classifySensitivePath,
  resolveContainedPath,
} from "../src/security/sensitive-path.js";

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sensitive path protection", () => {
  it("detects credential files without flagging documented templates", () => {
    expect(classifySensitivePath(".env")).toMatchObject({ kind: "environment_file" });
    expect(classifySensitivePath("config/.env.production")).toMatchObject({
      kind: "environment_file",
    });
    expect(classifySensitivePath("home/.ssh/id_ed25519")).toMatchObject({
      kind: "credential_store",
    });
    expect(classifySensitivePath("certs/server.pem")).toMatchObject({ kind: "private_key" });
    expect(classifySensitivePath("keys/service-account-prod.json")).toMatchObject({
      kind: "credential_store",
    });
    expect(
      classifySensitivePath("home/.config/gcloud/application_default_credentials.json"),
    ).toMatchObject({ kind: "credential_store" });
    expect(classifySensitivePath(".env.example")).toBeUndefined();
    expect(classifySensitivePath(".env.sample")).toBeUndefined();
    expect(classifySensitivePath(".env.template")).toBeUndefined();
    expect(classifySensitivePath("notes/2026-plan.md")).toBeUndefined();
  });

  it("throws a typed denial for protected locations", () => {
    expect(() => assertNotSensitivePath("notes/.env", "note")).toThrow(SensitivePathError);
    expect(() => assertNotSensitivePath("notes/plan.md", "note")).not.toThrow();
  });

  it("contains relative paths and rejects traversal before touching outside files", () => {
    const root = directory("aios-paths-");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "inside.md"), "inside", { mode: 0o600 });
    expect(resolveContainedPath(root, "notes/inside.md")).toBe(join(root, "notes", "inside.md"));
    expect(() => resolveContainedPath(root, "../outside")).toThrow(SensitivePathError);
    expect(() => resolveContainedPath(root, "/etc/passwd")).toThrow(SensitivePathError);
  });

  it("rejects symlink chains by default and permits only contained targets when requested", () => {
    const root = directory("aios-paths-links-");
    const outside = directory("aios-paths-outside-");
    writeFileSync(join(outside, "secret"), "secret", { mode: 0o600 });
    writeFileSync(join(root, "inside"), "inside", { mode: 0o600 });
    symlinkSync(join(root, "inside"), join(root, "inside-link"));
    symlinkSync(join(outside, "secret"), join(root, "escape-link"));
    expect(() => resolveContainedPath(root, "inside-link")).toThrow(/symlink/);
    expect(resolveContainedPath(root, "inside-link", { symlinks: "follow-contained" })).toBe(
      join(root, "inside-link"),
    );
    expect(() =>
      resolveContainedPath(root, "escape-link", { symlinks: "follow-contained" }),
    ).toThrow(/escapes/);
  });

  it("allows only an absent leaf when the caller explicitly opts in", () => {
    const root = directory("aios-paths-missing-");
    expect(() => resolveContainedPath(root, "new")).toThrow(/does not exist/);
    expect(resolveContainedPath(root, "new", { allowMissingLeaf: true })).toBe(join(root, "new"));
    mkdirSync(join(root, "existing"));
    expect(resolveContainedPath(root, "existing/output", { allowMissingLeaf: true })).toBe(
      join(root, "existing", "output"),
    );
    expect(() => resolveContainedPath(root, "absent/output", { allowMissingLeaf: true })).toThrow(
      /does not exist/,
    );
  });

  it("seeded traversal mutations never escape or resolve outside the root", () => {
    const root = directory("aios-paths-property-");
    const outside = join(root, "..", "outside-secret");
    let state = 0xbadc0de;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state;
    };
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const depth = 1 + (next() % 4);
      const segments = ["notes"];
      for (let index = 0; index < depth; index += 1) {
        segments.push(next() % 2 === 0 ? ".." : `segment-${next() % 50}`);
      }
      const candidate = segments.join("/");
      try {
        const resolved = resolveContainedPath(root, candidate, { allowMissingLeaf: true });
        const contained = relative(root, resolved);
        expect(
          contained === "" || (!contained.startsWith("..") && !contained.startsWith("/")),
        ).toBe(true);
        expect(resolved).not.toBe(outside);
      } catch (error) {
        expect(error).toBeInstanceOf(SensitivePathError);
      }
    }
  });

  it("refuses a symlinked or non-directory containment root", () => {
    const root = directory("aios-paths-root-");
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link, "dir");
    expect(() => resolveContainedPath(link, "file")).toThrow(/real directory/);
    writeFileSync(join(root, "file"), "x", { mode: 0o600 });
    expect(() => resolveContainedPath(join(root, "file"), "file")).toThrow(/real directory/);
  });
});
