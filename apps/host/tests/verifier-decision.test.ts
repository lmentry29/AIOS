import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskEntity } from "@aios/core";
import { generateSigningKey, createTrustRoot } from "../src/execution/artifact-signing.js";
import { LocalCommandExecutor } from "../src/execution/command-executor.js";
import { LocalCommandVerifier } from "../src/execution/command-verifier.js";
import {
  loadVerifierDecisionSigner,
  VerifierDecisionError,
  type VerifierDecisionBody,
} from "../src/execution/verifier-decision.js";
import { ManagedExecutionPort } from "../src/execution/managed-execution.js";
import { RunWorkspaceManager } from "../src/execution/workspace.js";
import { DurableOperationalStore } from "../src/persistence/operational-store.js";
import { AGENT_ID, makeTask } from "./fixtures.js";
import { StubSandbox, makeExecutionConfig } from "./sandbox-fixture.js";

function keyFixture(): {
  directory: string;
  signer: ReturnType<typeof loadVerifierDecisionSigner>;
  keyId: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "aios-verifier-signing-"));
  const generated = generateSigningKey();
  const now = Date.now();
  const trustRoot = createTrustRoot({
    key_id: generated.key_id,
    public_key_pem: generated.public_key_pem,
    not_before: new Date(now - 60_000).toISOString(),
    not_after: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const keyPath = join(directory, "verifier.pem");
  const trustRootPath = join(directory, "trust-root.json");
  writeFileSync(keyPath, generated.private_key_pem, { mode: 0o600 });
  writeFileSync(trustRootPath, JSON.stringify(trustRoot), { mode: 0o600 });
  return {
    directory,
    signer: loadVerifierDecisionSigner({
      private_key_file: keyPath,
      trust_root_file: trustRootPath,
      key_id: generated.key_id,
    }),
    keyId: generated.key_id,
  };
}

function boundTask(): TaskEntity {
  return makeTask({
    execution: { kind: "local_command", argv: ["/bin/echo", "ok"] },
    verification: { kind: "local_command", argv: ["/bin/true"] },
  });
}

function body(overrides: Partial<VerifierDecisionBody> = {}): VerifierDecisionBody {
  return {
    schema_version: 1,
    task_id: "11111111-1111-4111-8111-111111111111",
    execution_id: "22222222-2222-4222-8222-222222222222",
    attempt: 1,
    bound_result_sha256: "a".repeat(64),
    verifier_id: "33333333-3333-4333-8333-333333333333",
    accepted: true,
    reason: "Verification command exited with the expected code 0.",
    evidence: [
      "verifier:33333333-3333-4333-8333-333333333333",
      "execution_id:22222222-2222-4222-8222-222222222222",
    ],
    ...overrides,
  };
}

describe("signed verifier decisions", () => {
  it("signs the exact decision and rejects a tampered reason or evidence", () => {
    const fixture = keyFixture();
    const decision = body();
    const provenance = fixture.signer.sign(decision);
    expect(provenance.key_id).toBe(fixture.keyId);
    expect(provenance.signature).toHaveLength(88);
    fixture.signer.verify(provenance, {
      task_id: decision.task_id,
      verifier_id: decision.verifier_id,
      accepted: decision.accepted,
      reason: decision.reason,
      evidence: decision.evidence,
    });

    expect(() =>
      fixture.signer.verify(
        { ...provenance, schema_version: 2 },
        {
          task_id: decision.task_id,
          verifier_id: decision.verifier_id,
          accepted: decision.accepted,
          reason: decision.reason,
          evidence: decision.evidence,
        },
      ),
    ).toThrow(VerifierDecisionError);
    expect(() =>
      fixture.signer.verify(provenance, {
        task_id: decision.task_id,
        verifier_id: decision.verifier_id,
        accepted: decision.accepted,
        reason: "tampered reason",
        evidence: decision.evidence,
      }),
    ).toThrow(VerifierDecisionError);
    expect(() =>
      fixture.signer.verify(
        { ...provenance, payload_sha256: "b".repeat(64) },
        {
          task_id: decision.task_id,
          verifier_id: decision.verifier_id,
          accepted: decision.accepted,
          reason: decision.reason,
          evidence: decision.evidence,
        },
      ),
    ).toThrow(VerifierDecisionError);
  });

  it("rejects a signed decision replayed against another execution attempt", () => {
    const fixture = keyFixture();
    const decision = body();
    const provenance = fixture.signer.sign(decision);
    const expected = {
      task_id: decision.task_id,
      verifier_id: decision.verifier_id,
      accepted: decision.accepted,
      reason: decision.reason,
      evidence: decision.evidence,
    };
    expect(() => fixture.signer.verify(provenance, {
      ...expected,
      execution_id: decision.execution_id,
      attempt: decision.attempt,
    })).not.toThrow();
    expect(() => fixture.signer.verify(provenance, {
      ...expected,
      execution_id: "44444444-4444-4444-8444-444444444444",
    })).toThrow(/different execution attempt/);
    expect(() => fixture.signer.verify(provenance, {
      ...expected,
      attempt: 2,
    })).toThrow(/different attempt number/);

    const record = {
      task_id: decision.task_id,
      verifier_id: decision.verifier_id,
      verifier_accepted: decision.accepted,
      verifier_reason: decision.reason,
      verifier_evidence: decision.evidence,
      verifier_provenance: provenance,
      execution_id: decision.execution_id,
      attempt: decision.attempt,
    };
    expect(() => fixture.signer.verifyRecord(record)).not.toThrow();
    expect(() => fixture.signer.verifyRecord({
      ...record,
      execution_id: undefined,
      expected_execution_id: "44444444-4444-4444-8444-444444444444",
    })).toThrow(/different execution attempt/);
    expect(() => fixture.signer.verifyRecord({
      ...record,
      expected_execution_id: "44444444-4444-4444-8444-444444444444",
    })).toThrow(/does not match the durable attempt/);
    expect(() => fixture.signer.verifyRecord({
      ...record,
      execution_id: "44444444-4444-4444-8444-444444444444",
      expected_execution_id: decision.execution_id,
    })).toThrow(/does not match the durable attempt/);
    expect(() => fixture.signer.verifyRecord({
      ...record,
      execution_id: "44444444-4444-4444-8444-444444444444",
    })).toThrow(/different execution attempt/);
  });

  it("refuses an unknown or revoked key and a private key that is not owner-only", () => {
    const fixture = keyFixture();
    const generated = generateSigningKey();
    const now = Date.now();
    const revoked = createTrustRoot({
      key_id: generated.key_id,
      public_key_pem: generated.public_key_pem,
      not_before: new Date(now - 60_000).toISOString(),
      not_after: new Date(now + 60_000).toISOString(),
      status: "revoked",
    });
    expect(() =>
      loadVerifierDecisionSigner({
        private_key_file: join(fixture.directory, "verifier.pem"),
        trust_root_file: (() => {
          const path = join(fixture.directory, "revoked.json");
          writeFileSync(path, JSON.stringify(revoked), { mode: 0o600 });
          return path;
        })(),
        key_id: generated.key_id,
      }),
    ).toThrow(VerifierDecisionError);

    const keyPath = join(fixture.directory, "world-readable.pem");
    writeFileSync(keyPath, generateSigningKey().private_key_pem, { mode: 0o644 });
    expect(() =>
      loadVerifierDecisionSigner({
        private_key_file: keyPath,
        trust_root_file: join(fixture.directory, "trust-root.json"),
        key_id: fixture.keyId,
      }),
    ).toThrow(/owner-only/);
  });

  it("attaches provenance to the real verifier decision and fails closed when the record changes", async () => {
    const store = new DurableOperationalStore({
      directory: mkdtempSync(join(tmpdir(), "aios-verifier-record-")),
    });
    try {
      const config = makeExecutionConfig();
      const sandbox = new StubSandbox();
      const workspaces = new RunWorkspaceManager(config.workspace_directory);
      const managed = new ManagedExecutionPort(
        new LocalCommandExecutor(config, sandbox, workspaces),
        store.executions,
        1,
      );
      const fixture = keyFixture();
      const verifier = new LocalCommandVerifier(
        config,
        sandbox,
        workspaces,
        { current: store.executions },
        fixture.signer,
      );
      const task = boundTask();
      const result = await managed.executeTask(AGENT_ID, task);
      const decision = await verifier.verify({
        task,
        agent_ids: [AGENT_ID],
        execution_result: result,
      });
      expect(decision.accepted).toBe(true);
      expect(decision.provenance?.key_id).toBe(fixture.keyId);

      const record: Record<string, unknown> = {
        task_id: task.entity_id,
        verifier_id: decision.verifier_id,
        verifier_accepted: decision.accepted,
        verifier_reason: decision.reason,
        verifier_evidence: decision.evidence,
        verifier_provenance: decision.provenance,
      };
      await expect(verifier.verifyProvenance(record)).resolves.toBe(true);
      await expect(
        verifier.verifyProvenance({ ...record, verifier_reason: "tampered" }),
      ).resolves.toBe(false);
      await expect(
        verifier.verifyProvenance({ ...record, verifier_provenance: undefined }),
      ).resolves.toBe(false);
    } finally {
      store.close();
    }
  });
});
