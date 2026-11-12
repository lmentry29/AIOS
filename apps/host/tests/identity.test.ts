import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isHumanPrincipal, TrustedIdentityService } from "../src/identity.js";
import { AGENT_ID, FOUNDER, sessionExpiresAt } from "./fixtures.js";

const TOKEN = "founder-token-0123456789abcdef";
const OTHER_TOKEN = "other-token-0123456789abcdefgh";

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function service(expiresAt: string = sessionExpiresAt()): TrustedIdentityService {
  return new TrustedIdentityService([
    {
      session_id: randomUUID(),
      principal_id: FOUNDER,
      token_sha256: digest(TOKEN),
      label: "founder laptop",
      expires_at: expiresAt,
    },
    {
      session_id: randomUUID(),
      principal_id: AGENT_ID,
      token_sha256: digest(OTHER_TOKEN),
      expires_at: sessionExpiresAt(),
    },
  ]);
}

describe("TrustedIdentityService", () => {
  it("binds a valid bearer token to its configured principal", () => {
    const result = service().authenticate(`Bearer ${TOKEN}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected authentication");
    expect(result.session.principal_id).toBe(FOUNDER);
    expect(result.session.label).toBe("founder laptop");
    expect(result.session.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.session.generation).toBe(1);
  });

  it("denies every invalid credential shape with a structured reason", () => {
    const identity = service();
    const cases: Array<[string | undefined, string]> = [
      [undefined, "missing_credential"],
      ["", "malformed_credential"],
      [TOKEN, "malformed_credential"],
      [`Basic ${TOKEN}`, "malformed_credential"],
      ["Bearer ", "malformed_credential"],
      [`Bearer ${TOKEN} extra`, "malformed_credential"],
      [`Bearer ${TOKEN} `, "malformed_credential"],
      ["Bearer short", "malformed_credential"],
      [`Bearer ${"a".repeat(600)}`, "malformed_credential"],
      [`Bearer ${"x".repeat(32)}`, "unknown_token"],
    ];
    for (const [header, reason] of cases) {
      const result = identity.authenticate(header);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected denial");
      expect(result.reason).toBe(reason);
    }
  });

  it("refuses an expired session even when the digest matches", () => {
    const identity = service("2026-01-01T00:00:00.000Z");
    const expired = identity.authenticate(
      `Bearer ${TOKEN}`,
      Date.parse("2026-06-01T00:00:00.000Z"),
    );
    expect(expired).toEqual({ ok: false, reason: "expired_token" });
    const valid = identity.authenticate(`Bearer ${TOKEN}`, Date.parse("2025-06-01T00:00:00.000Z"));
    expect(valid.ok).toBe(true);
  });

  it("rotates to a new generation and retires the previous token", () => {
    const identity = service();
    const rotated = identity.rotate(
      `Bearer ${TOKEN}`,
      undefined,
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    expect(rotated.generation).toBe(2);
    expect(rotated.token).not.toBe(TOKEN);
    expect(
      identity.authenticate(`Bearer ${TOKEN}`, Date.parse("2026-01-02T00:00:00.000Z")),
    ).toEqual({ ok: false, reason: "rotated_token" });
    const current = identity.authenticate(
      `Bearer ${rotated.token}`,
      Date.parse("2026-01-02T00:00:00.000Z"),
    );
    expect(current.ok).toBe(true);
  });

  it("revokes the current token and never restores it", () => {
    const identity = service();
    const rotated = identity.rotate(`Bearer ${TOKEN}`);
    const revoked = identity.revoke(`Bearer ${rotated.token}`);
    expect(revoked.generation).toBe(2);
    expect(identity.authenticate(`Bearer ${rotated.token}`)).toEqual({
      ok: false,
      reason: "revoked_token",
    });
    expect(identity.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "rotated_token",
    });
  });

  it("binds a rotated token to one task and rejects another task binding", () => {
    const identity = service();
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const rotated = identity.rotate(`Bearer ${TOKEN}`, { task_id: taskId });
    expect(identity.authenticate(`Bearer ${rotated.token}`)).toEqual({
      ok: false,
      reason: "scope_binding_required",
    });
    expect(
      identity.authenticate(`Bearer ${rotated.token}`, Date.now(), { task_id: otherTaskId }),
    ).toEqual({ ok: false, reason: "task_scope_mismatch" });
    const bound = identity.authenticate(`Bearer ${rotated.token}`, Date.now(), { task_id: taskId });
    expect(bound.ok).toBe(true);
  });

  it("cannot broaden a scoped token through rotation", () => {
    const identity = service();
    const taskId = randomUUID();
    const rotated = identity.rotate(`Bearer ${TOKEN}`, { task_id: taskId });
    expect(() => identity.rotate(`Bearer ${rotated.token}`, { run_id: randomUUID() })).toThrow(
      /scope/,
    );
    expect(() => identity.rotate(`Bearer ${rotated.token}`, { task_id: randomUUID() })).toThrow(
      /scope/,
    );
  });

  it("requires at least one configured session", () => {
    expect(() => new TrustedIdentityService([])).toThrow(/at least one/);
  });

  it("distinguishes human principals from Agent identifiers", () => {
    expect(isHumanPrincipal("human:founder")).toBe(true);
    expect(isHumanPrincipal("human:")).toBe(false);
    expect(isHumanPrincipal("human:founder:extra")).toBe(false);
    expect(isHumanPrincipal(AGENT_ID)).toBe(false);
    expect(isHumanPrincipal(AGENT_ID.toUpperCase())).toBe(false);
  });
});
