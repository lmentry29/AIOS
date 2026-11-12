import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostExecutionConfig } from "../src/config.js";
import type {
  SandboxCheck,
  SandboxProvider,
  SandboxResult,
  SandboxRunSpec,
} from "../src/execution/sandbox.js";
import { AGENT_ID, VERIFIER_ID } from "./fixtures.js";

interface HeldRun {
  started: Promise<void>;
  release: () => void;
}

interface HeldRunState {
  started: Promise<void>;
  markStarted: () => void;
  released: Promise<void>;
  release: () => void;
}

/**
 * Test-only sandbox. It does not isolate anything and must never be composed by the
 * host CLI. It exists to verify adapter wiring/evidence/cancellation logic without a
 * Docker daemon, bubblewrap, or macOS Seatbelt on the test machine. Aborting its signal
 * makes it return the provider's `cancelled` result; it is not a real process boundary.
 */
export class StubSandbox implements SandboxProvider {
  readonly id = "stub-container";
  readonly assurance = "container" as const;
  calls: SandboxRunSpec[] = [];
  checkResult: SandboxCheck = { available: true, reason: "stub is available" };
  result: Partial<SandboxResult> = {};
  aborted = false;
  private held: HeldRunState | undefined;

  async check(): Promise<SandboxCheck> {
    return this.checkResult;
  }

  /** Holds the next invocation until `release()` is called or its signal aborts. */
  holdNextRun(): HeldRun {
    let release!: () => void;
    let markStarted!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held: HeldRunState = { started, markStarted, released, release };
    this.held = held;
    return {
      started,
      release: () => {
        if (this.held === held) this.held = undefined;
        held.release();
      },
    };
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    this.calls.push(spec);
    const held = this.held;
    this.held = undefined;
    if (held) {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        onAbort = () => {
          this.aborted = true;
          resolve();
        };
        if (spec.signal?.aborted) onAbort();
        else spec.signal?.addEventListener("abort", onAbort, { once: true });
      });
      held.markStarted();
      await Promise.race([held.released, aborted]);
      if (onAbort) spec.signal?.removeEventListener("abort", onAbort);
      if (spec.signal?.aborted) return this.cancelledResult();
    }
    if (spec.signal?.aborted) {
      this.aborted = true;
      return this.cancelledResult();
    }
    return {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("ok\n"),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 7,
      provider: this.id,
      assurance: this.assurance,
      ...this.result,
    };
  }

  private cancelledResult(): SandboxResult {
    return {
      exitCode: null,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: true,
      truncated: false,
      durationMs: 1,
      provider: this.id,
      assurance: this.assurance,
      ...this.result,
    };
  }
}

export function makeExecutionConfig(
  directory?: string,
  overrides: Partial<HostExecutionConfig> = {},
): HostExecutionConfig {
  return {
    workspace_directory: directory ?? mkdtempSync(join(tmpdir(), "aios-execution-")),
    agent_id: AGENT_ID,
    verifier_id: VERIFIER_ID,
    provider: "docker",
    image: "node:22-alpine",
    default_timeout_ms: 5_000,
    max_output_bytes: 16 * 1024,
    workspace_max_bytes: 16 * 1024 * 1024,
    max_concurrent_tasks: 1,
    ...overrides,
  };
}
