import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostExecutionConfig } from '../src/config.js';
import type {
  SandboxCheck,
  SandboxProvider,
  SandboxResult,
  SandboxRunSpec,
} from '../src/execution/sandbox.js';
import { AGENT_ID, VERIFIER_ID } from './fixtures.js';

/**
 * Test-only sandbox. It does not isolate anything and must never be composed by the
 * host CLI. It exists to verify adapter wiring/evidence logic without a Docker daemon,
 * bubblewrap, or macOS Seatbelt on the test machine.
 */
export class StubSandbox implements SandboxProvider {
  readonly id = 'stub-container';
  readonly assurance = 'container' as const;
  calls: SandboxRunSpec[] = [];
  checkResult: SandboxCheck = { available: true, reason: 'stub is available' };
  result: Partial<SandboxResult> = {};

  async check(): Promise<SandboxCheck> {
    return this.checkResult;
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    this.calls.push(spec);
    return {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from('ok\n'),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
      durationMs: 7,
      provider: this.id,
      assurance: this.assurance,
      ...this.result,
    };
  }
}

export function makeExecutionConfig(directory?: string): HostExecutionConfig {
  return {
    workspace_directory: directory ?? mkdtempSync(join(tmpdir(), 'aios-execution-')),
    agent_id: AGENT_ID,
    verifier_id: VERIFIER_ID,
    provider: 'docker',
    image: 'node:22-alpine',
    default_timeout_ms: 5_000,
    max_output_bytes: 16 * 1024,
  };
}
