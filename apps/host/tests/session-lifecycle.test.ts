import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TrustedIdentityService } from "../src/identity.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { SessionState } from "../src/persistence/session-store.js";
import { FOUNDER, sessionExpiresAt } from "./fixtures.js";

const TOKEN = "founder-token-0123456789abcdef";

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionEntry(expiresAt: string = sessionExpiresAt()) {
  return {
    session_id: randomUUID(),
    principal_id: FOUNDER,
    token_sha256: digest(TOKEN),
    label: "founder laptop",
    expires_at: expiresAt,
  };
}

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "aios-session-lifecycle-"));
}

describe("durable host session lifecycle", () => {
  it("survives rotation across restart and refuses the retired token", () => {
    const directory = stateDirectory();
    const sessions = [sessionEntry()];
    const first = new DurableOperationalStore({ directory, sessions });
    const identity = new TrustedIdentityService(first.sessions);
    const rotated = identity.rotate(`Bearer ${TOKEN}`);
    expect(rotated.generation).toBe(2);
    expect(identity.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "rotated_token",
    });
    const current = identity.authenticate(`Bearer ${rotated.token}`);
    expect(current.ok).toBe(true);
    first.close();

    const second = new DurableOperationalStore({ directory, sessions });
    const restored = new TrustedIdentityService(second.sessions);
    expect(restored.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "rotated_token",
    });
    const afterRestart = restored.authenticate(`Bearer ${rotated.token}`);
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) throw new Error("expected rotated session");
    expect(afterRestart.session.generation).toBe(2);
    second.close();
  });

  it("survives revocation across restart and refuses the revoked token", () => {
    const directory = stateDirectory();
    const sessions = [sessionEntry()];
    const first = new DurableOperationalStore({ directory, sessions });
    const identity = new TrustedIdentityService(first.sessions);
    const rotated = identity.rotate(`Bearer ${TOKEN}`);
    identity.revoke(`Bearer ${rotated.token}`);
    expect(identity.authenticate(`Bearer ${rotated.token}`)).toEqual({
      ok: false,
      reason: "revoked_token",
    });
    first.close();

    const second = new DurableOperationalStore({ directory, sessions });
    const restored = new TrustedIdentityService(second.sessions);
    expect(restored.authenticate(`Bearer ${rotated.token}`)).toEqual({
      ok: false,
      reason: "revoked_token",
    });
    expect(restored.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "rotated_token",
    });
    second.close();
  });

  it("enforces expiry at the authorization boundary with a controlled clock", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const identity = new TrustedIdentityService(
      new SessionState([sessionEntry(new Date(now + 60_000).toISOString())], now),
    );
    expect(identity.authenticate(`Bearer ${TOKEN}`, now + 59_999).ok).toBe(true);
    expect(identity.authenticate(`Bearer ${TOKEN}`, now + 60_000)).toEqual({
      ok: false,
      reason: "expired_token",
    });
  });

  it("binds one task, run, and evidence digest and rejects cross-binding replay", () => {
    const identity = new TrustedIdentityService(new SessionState([sessionEntry()]));
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const evidence = "a".repeat(64);
    const otherEvidence = "b".repeat(64);
    const rotated = identity.rotate(`Bearer ${TOKEN}`, {
      task_id: taskId,
      run_id: runId,
      evidence_sha256: evidence,
    });

    expect(
      identity.authenticate(`Bearer ${rotated.token}`, Date.now(), {
        task_id: otherTaskId,
        run_id: runId,
        evidence_sha256: evidence,
      }),
    ).toEqual({ ok: false, reason: "task_scope_mismatch" });
    expect(
      identity.authenticate(`Bearer ${rotated.token}`, Date.now(), {
        task_id: taskId,
        run_id: otherRunId,
        evidence_sha256: evidence,
      }),
    ).toEqual({ ok: false, reason: "run_scope_mismatch" });
    expect(
      identity.authenticate(`Bearer ${rotated.token}`, Date.now(), {
        task_id: taskId,
        run_id: runId,
        evidence_sha256: otherEvidence,
      }),
    ).toEqual({ ok: false, reason: "evidence_scope_mismatch" });
    expect(
      identity.authenticate(`Bearer ${rotated.token}`, Date.now(), {
        task_id: taskId,
        run_id: runId,
        evidence_sha256: evidence,
      }).ok,
    ).toBe(true);
  });

  it("does not let a snapshot reintroduce a session removed from configuration", () => {
    const identityState = new SessionState([sessionEntry()]);
    const snapshot = identityState.snapshot();
    const existing = snapshot.sessions[0];
    if (!existing) throw new Error("missing session seed");
    snapshot.sessions.push({
      ...existing,
      session_id: randomUUID(),
      token_sha256: "c".repeat(64),
    });
    expect(() => identityState.restoreSnapshot(snapshot)).toThrow(/no longer provisions/);
  });

  it("preserves the retired-token set across journal compaction", () => {
    const directory = stateDirectory();
    const sessions = [sessionEntry()];
    const first = new DurableOperationalStore({ directory, sessions });
    const identity = new TrustedIdentityService(first.sessions);
    const rotated = identity.rotate(`Bearer ${TOKEN}`);
    first.compact(join(directory, "session-compaction.json"));
    first.close();

    const second = new DurableOperationalStore({ directory, sessions });
    const restored = new TrustedIdentityService(second.sessions);
    expect(restored.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "rotated_token",
    });
    expect(restored.authenticate(`Bearer ${rotated.token}`).ok).toBe(true);
    second.close();
  });
});
