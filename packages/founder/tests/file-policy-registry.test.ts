import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "../src/authorization.js";
import {
  AuthorizationService,
  PolicyAdministrationService,
  policyArtifactSha256,
} from "../src/authorization.js";
import { FilePolicyRegistry, FilePolicyRegistryError } from "../src/file-policy-registry.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "aios-policy-registry-"));
  const filePath = join(directory, "state", "policies.json");
  const resourceId = randomUUID();
  const policy: AccessPolicy = {
    policy_id: randomUUID(),
    version: 1,
    rules: [
      {
        effect: "allow",
        subject_ids: ["human:founder"],
        actions: ["read_evidence"],
        resource_ids: [resourceId],
      },
    ],
  };
  return { directory, filePath, resourceId, policy };
}

describe("FilePolicyRegistry", () => {
  it("persists immutable policies, resource attachments, and authorization decisions atomically", async () => {
    const h = setup();
    let registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      await registry.publish(h.policy, "human:founder");
      await registry.attach(h.resourceId, h.policy.policy_id, "human:founder");
      const authorization = new AuthorizationService(
        registry,
        (resourceId) => registry.resolve(resourceId),
        registry,
      );

      expect(
        await authorization.authorize({
          actor_id: "human:founder",
          action: "read_evidence",
          resource_id: h.resourceId,
        }),
      ).toBe(true);
      expect(
        await authorization.authorize({
          actor_id: "human:other",
          action: "read_evidence",
          resource_id: h.resourceId,
        }),
      ).toBe(false);
      expect(registry.listPolicyAudit()).toHaveLength(2);
      expect(registry.listAuthorizationAudit().map((event) => event.decision)).toEqual([
        "allow",
        "deny",
      ]);
      expect(statSync(h.filePath).mode & 0o777).toBe(0o600);

      registry.close();
      registry = new FilePolicyRegistry({ filePath: h.filePath });
      expect(await registry.get(h.policy.policy_id)).toEqual(h.policy);
      expect(await registry.resolve(h.resourceId)).toBe(h.policy.policy_id);
      expect(registry.listPolicyAudit()).toHaveLength(2);
      expect(registry.listAuthorizationAudit()).toHaveLength(2);

      await registry.revoke(h.resourceId, "human:founder");
      expect(await registry.resolve(h.resourceId)).toBeUndefined();
      expect(registry.listPolicyAudit()).toHaveLength(3);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("binds lifecycle events to the exact policy artifact and rejects a substituted policy", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    await registry.publish(h.policy, "human:founder");
    const publishEvent = registry.listPolicyAudit()[0];
    expect(publishEvent?.artifact_sha256).toBe(policyArtifactSha256(h.policy));
    registry.close();

    const state = JSON.parse(readFileSync(h.filePath, "utf8")) as {
      policies: Record<string, { version: number }>;
    };
    const stored = state.policies[h.policy.policy_id];
    if (!stored) throw new Error("Expected the published policy in state.");
    // Change policy content without recomputing the hash-chained audit event. The
    // event hash still verifies; only the artifact digest binding catches this.
    stored.version = 2;
    writeFileSync(h.filePath, JSON.stringify(state), { mode: 0o600 });
    expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(/artifact digest/);
    rmSync(h.directory, { recursive: true, force: true });
  });

  it("rejects policy mutation and unauthorized administration", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      const admin = new PolicyAdministrationService("human:founder", registry, registry);
      await expect(admin.publish(h.policy, "human:attacker")).rejects.toThrow(
        /bootstrap principal/,
      );
      await admin.publish(h.policy, "human:founder");
      await expect(admin.publish(h.policy, "human:founder")).rejects.toThrow(/immutable/);
      await expect(admin.attach(h.resourceId, randomUUID(), "human:founder")).rejects.toThrow(
        /missing, mismatched, or invalid/,
      );
      await expect(admin.revoke(h.resourceId, "human:founder")).rejects.toThrow(
        /no attached policy/,
      );
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("atomically publishes and attaches a higher-version replacement", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      await registry.publishAndAttach(h.policy, [h.resourceId], "human:founder");
      const replacement: AccessPolicy = {
        policy_id: randomUUID(),
        version: 2,
        rules: [
          {
            effect: "allow",
            subject_ids: ["human:founder"],
            actions: ["read_evidence"],
            resource_ids: [h.resourceId],
          },
        ],
      };
      await registry.publishAndAttach(replacement, [h.resourceId], "human:founder");
      expect(await registry.resolve(h.resourceId)).toBe(replacement.policy_id);
      expect(registry.listPolicyAudit().map((event) => event.operation)).toEqual([
        "publish",
        "attach",
        "publish",
        "attach",
      ]);
      expect(registry.listPolicyAudit()[3]?.previous_policy_id).toBe(h.policy.policy_id);

      registry.close();
      const reopened = new FilePolicyRegistry({ filePath: h.filePath });
      try {
        expect(await reopened.resolve(h.resourceId)).toBe(replacement.policy_id);
      } finally {
        reopened.close();
      }
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid or stale atomic publications without touching policy state", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      await registry.publishAndAttach(h.policy, [h.resourceId], "human:founder");
      const before = readFileSync(h.filePath, "utf8");

      const stale: AccessPolicy = { ...h.policy, policy_id: randomUUID(), version: 1 };
      await expect(
        registry.publishAndAttach(stale, [h.resourceId], "human:founder"),
      ).rejects.toMatchObject({ code: "version_conflict" });

      const baseRule = h.policy.rules[0];
      if (!baseRule) throw new Error("Policy fixture rule missing.");
      const invalid = {
        ...h.policy,
        policy_id: randomUUID(),
        version: 2,
        rules: [{ ...baseRule, actions: ["not_an_action"] }],
      } as unknown as AccessPolicy;
      await expect(
        registry.publishAndAttach(invalid, [h.resourceId], "human:founder"),
      ).rejects.toMatchObject({ code: "invalid_policy" });

      expect(readFileSync(h.filePath, "utf8")).toBe(before);
      expect(await registry.resolve(h.resourceId)).toBe(h.policy.policy_id);
      expect(registry.listPolicyAudit()).toHaveLength(2);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("retires a version with fallback and denies when no version remains", async () => {
    const h = setup();
    let registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      const replacement: AccessPolicy = { ...h.policy, policy_id: randomUUID(), version: 2 };
      await registry.publishAndAttach(h.policy, [h.resourceId], "human:founder");
      await registry.publishAndAttach(replacement, [h.resourceId], "human:founder");
      await registry.retirePolicy(replacement.policy_id, [h.resourceId], "human:founder");
      expect(await registry.resolve(h.resourceId)).toBe(h.policy.policy_id);
      expect(registry.listPolicyAudit().map((event) => event.operation)).toEqual([
        "publish",
        "attach",
        "publish",
        "attach",
        "revoke",
      ]);
      await expect(
        registry.attach(h.resourceId, replacement.policy_id, "human:founder"),
      ).rejects.toThrow(/retired/);

      const auth = new AuthorizationService(
        registry,
        (resourceId) => registry.resolve(resourceId),
        registry,
      );
      expect(
        await auth.authorize({
          actor_id: "human:founder",
          action: "read_evidence",
          resource_id: h.resourceId,
        }),
      ).toBe(true);

      await registry.retirePolicy(h.policy.policy_id, [h.resourceId], "human:founder");
      expect(await registry.resolve(h.resourceId)).toBeUndefined();
      expect(
        await auth.authorize({
          actor_id: "human:founder",
          action: "read_evidence",
          resource_id: h.resourceId,
        }),
      ).toBe(false);
      expect(registry.listAuthorizationAudit().at(-1)).toMatchObject({
        decision: "deny",
        reason: "resource_policy_missing_or_invalid",
      });

      registry.close();
      registry = new FilePolicyRegistry({ filePath: h.filePath });
      expect(await registry.resolve(h.resourceId)).toBeUndefined();
      expect(registry.listPolicyAudit()).toHaveLength(6);
      await expect(
        registry.retirePolicy(h.policy.policy_id, [], "human:founder"),
      ).rejects.toMatchObject({ code: "policy_already_revoked" });
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid, unattached, mismatched, and repeated retirements without touching state", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      const unreferenced: AccessPolicy = { ...h.policy, policy_id: randomUUID(), version: 1 };
      await registry.publishAndAttach(h.policy, [h.resourceId], "human:founder");
      await registry.publish(unreferenced, "human:founder");
      const before = readFileSync(h.filePath, "utf8");

      await expect(
        registry.retirePolicy(randomUUID(), [h.resourceId], "human:founder"),
      ).rejects.toMatchObject({ code: "policy_not_found" });
      await expect(
        registry.retirePolicy(unreferenced.policy_id, [], "human:founder"),
      ).rejects.toMatchObject({ code: "policy_not_attached" });
      await expect(
        registry.retirePolicy(h.policy.policy_id, [randomUUID()], "human:founder"),
      ).rejects.toMatchObject({ code: "target_scope_mismatch" });
      await expect(
        registry.retirePolicy(h.policy.policy_id, ["not-a-uuid"], "human:founder"),
      ).rejects.toMatchObject({ code: "invalid_targets" });
      expect(readFileSync(h.filePath, "utf8")).toBe(before);

      await registry.retirePolicy(h.policy.policy_id, [h.resourceId], "human:founder");
      const after = readFileSync(h.filePath, "utf8");
      await expect(
        registry.retirePolicy(h.policy.policy_id, [h.resourceId], "human:founder"),
      ).rejects.toMatchObject({ code: "policy_already_revoked" });
      expect(readFileSync(h.filePath, "utf8")).toBe(after);
      expect(await registry.resolve(h.resourceId)).toBeUndefined();
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("verifies the audit hash chain on reopen and rejects out-of-band edits", async () => {
    const h = setup();
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    await registry.publish(h.policy, "human:founder");
    registry.close();

    const state = JSON.parse(readFileSync(h.filePath, "utf8")) as {
      audit_events: Array<{ payload: { actor_id?: string } }>;
    };
    const firstEvent = state.audit_events[0];
    if (!firstEvent) throw new Error("Expected a persisted audit event.");
    firstEvent.payload.actor_id = "human:tampered";
    writeFileSync(h.filePath, JSON.stringify(state), { mode: 0o600 });
    expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(
      /hash chain verification failed/,
    );
    rmSync(h.directory, { recursive: true, force: true });
  });

  it("does not delete an existing process lock when a second instance fails to open", () => {
    const h = setup();
    const first = new FilePolicyRegistry({ filePath: h.filePath });
    const lockPath = `${h.filePath}.lock`;
    try {
      expect(existsSync(lockPath)).toBe(true);
      expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(
        FilePolicyRegistryError,
      );
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      first.close();
      expect(existsSync(lockPath)).toBe(false);
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale lock only when its recorded process no longer exists", () => {
    const h = setup();
    mkdirSync(join(h.directory, "state"), { recursive: true });
    const lockPath = `${h.filePath}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, created_at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const registry = new FilePolicyRegistry({ filePath: h.filePath });
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(lock.pid).toBe(process.pid);
    } finally {
      registry.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it("rejects non-absolute paths and invalid state files", () => {
    expect(() => new FilePolicyRegistry({ filePath: "relative/policies.json" })).toThrow(
      /absolute file path/,
    );
    const h = setup();
    mkdirSync(join(h.directory, "state"), { recursive: true });
    writeFileSync(h.filePath, "{not-json", { flag: "w", mode: 0o600 });
    expect(() => new FilePolicyRegistry({ filePath: h.filePath })).toThrow(/invalid JSON/);
    rmSync(h.directory, { recursive: true, force: true });
  });
});
