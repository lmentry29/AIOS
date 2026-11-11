import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxIsolationUnavailableError } from '../src/errors.js';
import { digestRootfs } from '../src/execution/provenance.js';
import { createSandboxProvider } from '../src/execution/sandbox.js';

interface FakeRunsc {
  directory: string;
  rootfs: string;
  capture: string;
  calls: string;
  pinPath: string;
  binarySha256: string;
}

function architecture(): string {
  return process.arch === 'x64' ? 'x86_64' : 'arm64';
}

/**
 * Reproducible provider tests do not need a live Sentry. The fake runsc only records the
 * exact argv and generated OCI config; the live boundary is exercised separately by the
 * adversarial drill. The fake also has a real repository-style pin so a missing or
 * mismatched pin is tested before any probe can run.
 */
function fakeRunsc(): FakeRunsc {
  const directory = mkdtempSync(join(tmpdir(), 'aios-fake-runsc-'));
  const rootfs = mkdtempSync(join(tmpdir(), 'aios-fake-rootfs-'));
  const capture = join(directory, 'capture.json');
  const calls = join(directory, 'calls.log');
  const executable = join(directory, 'runsc');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const capture = ${JSON.stringify(capture)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) {
  console.log('runsc version release-test');
  process.exit(0);
}
if (args.includes('run')) {
  const bundle = args[args.indexOf('--bundle') + 1];
  const config = JSON.parse(fs.readFileSync(path.join(bundle, 'config.json'), 'utf8'));
  fs.writeFileSync(capture, JSON.stringify({ args, config, executable: process.argv[1] }));
  if (config.process.env.includes('AIOS_FAKE_MUTATE=1')) {
    fs.writeFileSync(path.join(config.root.path, 'intruder'), 'mutation');
  }
  process.exit(0);
}
if (args.includes('kill') || args.includes('delete')) process.exit(0);
process.exit(0);
`);
  chmodSync(executable, 0o755);
  const binarySha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const pinPath = join(directory, 'gvisor-runtime.pin.json');
  writeFileSync(pinPath, `${JSON.stringify({
    schema_version: 1,
    provider: 'gvisor',
    release: 'test-release',
    architecture: architecture(),
    artifact: {
      url: 'https://example.invalid/gvisor.tar.bz2',
      sha512: 'a'.repeat(128),
    },
    runsc: {
      version: 'release-test',
      sha256: binarySha256,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { directory, rootfs, capture, calls, pinPath, binarySha256 };
}

function withPath<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${directory}${delimiter}${original ?? ''}`;
  return body().finally(() => {
    process.env.PATH = original;
  });
}

describe('gvisor provider', () => {
  it('requires an explicit rootfs and refuses the host root', () => {
    expect(() => createSandboxProvider({ provider: 'gvisor' })).toThrow(/rootfs/);
    const provider = createSandboxProvider({ provider: 'gvisor', rootfs: '/' });
    return expect(provider.check()).resolves.toMatchObject({ available: false });
  });

  it('generates a controlled rootless OCI bundle and records pinned provenance', async () => {
    const fake = fakeRunsc();
    try {
      await withPath(fake.directory, async () => {
        const provider = createSandboxProvider({
          provider: 'gvisor',
          rootfs: fake.rootfs,
          gvisorPinPath: fake.pinPath,
        });
        const check = await provider.check();
        expect(check).toMatchObject({
          available: true,
          engine: { name: 'runsc', version: 'release-test', rootless: true },
          provenance: {
            runtime: {
              release: 'test-release',
              version: 'release-test',
              binary_sha256: fake.binarySha256,
              artifact_sha512: 'a'.repeat(128),
            },
            rootfs: { sha256: digestRootfs(fake.rootfs).sha256, entries: 0 },
          },
        });
        expect(check.provenance?.runtime.pin_sha256).toMatch(/^[0-9a-f]{64}$/);

        const workspace = mkdtempSync(join(tmpdir(), 'aios-gvisor-workspace-'));
        const result = await provider.run({
          argv: ['/bin/echo', 'hello world'],
          workspaceDirectory: workspace,
          cwd: '.',
          timeoutMs: 3_000,
          maxOutputBytes: 4096,
          env: { LANG: 'C' },
        });
        expect(result).toMatchObject({
          provider: 'gvisor',
          assurance: 'gvisor-user-space-kernel',
          boundary: { mechanism: 'gvisor-sentry', applied: true, rootless: true },
          limits: { mechanism: 'gvisor-oci-rlimit', applied: true, processes: 128 },
          engine: { name: 'runsc', version: 'release-test', rootless: true },
          provenance: {
            runtime: { binary_sha256: fake.binarySha256 },
            rootfs: { sha256: digestRootfs(fake.rootfs).sha256, entries: 0 },
          },
        });

        const captured = JSON.parse(readFileSync(fake.capture, 'utf8')) as {
          args: string[];
          config: {
            process: {
              args: string[];
              cwd: string;
              env: string[];
              noNewPrivileges: boolean;
              capabilities: Record<string, string[]>;
              rlimits: Array<{ type: string; soft: number; hard: number }>;
            };
            root: { path: string; readonly: boolean };
            mounts: Array<{ destination: string; source: string; type: string }>;
            linux: { namespaces: Array<{ type: string }> };
          };
        };
        expect(captured.args).toContain('--rootless');
        expect(captured.args).toContain('--network=none');
        expect(captured.args).toContain('run');
        expect(captured.args).not.toContain('do');
        expect(captured.config.root).toEqual({ path: fake.rootfs, readonly: true });
        expect(captured.config.process.args).toEqual(['/bin/echo', 'hello world']);
        expect(captured.config.process.cwd).toBe('/workspace');
        expect(captured.config.process.noNewPrivileges).toBe(true);
        expect(captured.config.process.env).toContain('LANG=C');
        expect(captured.config.process.env).not.toContain('AWS_SECRET_ACCESS_KEY');
        expect(captured.config.process.capabilities.effective).toEqual([]);
        expect(captured.config.process.rlimits).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'RLIMIT_CPU', soft: 3 }),
          expect.objectContaining({ type: 'RLIMIT_AS', soft: 512 * 1024 * 1024 }),
          expect.objectContaining({ type: 'RLIMIT_NPROC', soft: 128 }),
        ]));
        expect(captured.config.mounts).toEqual(expect.arrayContaining([
          expect.objectContaining({ destination: '/workspace', source: workspace, type: 'bind' }),
          expect.objectContaining({ destination: '/proc', type: 'proc' }),
          expect.objectContaining({ destination: '/tmp', type: 'tmpfs' }),
        ]));
        expect(captured.config.linux.namespaces.map((entry) => entry.type)).toEqual(
          expect.arrayContaining(['pid', 'network', 'ipc', 'uts', 'mount']),
        );
      });
    } finally {
      // The fake runtime and rootfs are test-owned temporary state.
    }
  });

  it('executes a private copy of the measured runtime and removes it afterwards', async () => {
    const fake = fakeRunsc();
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: fake.pinPath,
      });
      const workspace = mkdtempSync(join(tmpdir(), 'aios-gvisor-private-'));
      await provider.run({
        argv: ['/bin/true'],
        workspaceDirectory: workspace,
        cwd: '.',
        timeoutMs: 3_000,
        maxOutputBytes: 1024,
        env: {},
      });
      const captured = JSON.parse(readFileSync(fake.capture, 'utf8')) as { executable: string };
      expect(captured.executable).not.toBe(join(fake.directory, 'runsc'));
      expect(captured.executable.startsWith(tmpdir())).toBe(true);
      // Ownership-safe cleanup: the measured copy is gone once the invocation completes.
      expect(existsSync(captured.executable)).toBe(false);
    });
  });

  it('rejects a rootfs that changes while the sandbox runs', async () => {
    const fake = fakeRunsc();
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: fake.pinPath,
      });
      const workspace = mkdtempSync(join(tmpdir(), 'aios-gvisor-mutation-'));
      await expect(provider.run({
        argv: ['/bin/true'],
        workspaceDirectory: workspace,
        cwd: '.',
        timeoutMs: 3_000,
        maxOutputBytes: 1024,
        env: { AIOS_FAKE_MUTATE: '1' },
      })).rejects.toThrow(/could not be re-verified after execution.*changed while the sandbox was running/);
    });
  });

  it('fails closed on a missing pin before invoking runsc', async () => {
    const fake = fakeRunsc();
    const missingPin = join(fake.directory, 'missing.pin.json');
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: missingPin,
      });
      const check = await provider.check();
      expect(check.available).toBe(false);
      expect(check.isolationFailure).toBe(true);
      expect(check.reason).toMatch(/runtime provenance failed closed.*pin file does not exist/i);
      expect(existsSync(fake.calls)).toBe(false);
      await expect(provider.run({
        argv: ['/bin/true'],
        workspaceDirectory: mkdtempSync(join(tmpdir(), 'aios-gvisor-missing-pin-')),
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
        env: {},
      })).rejects.toBeInstanceOf(SandboxIsolationUnavailableError);
      expect(existsSync(fake.calls)).toBe(false);
    });
  });

  it('fails closed when the runsc binary does not match the pinned SHA-256', async () => {
    const fake = fakeRunsc();
    const mismatchedPin = join(fake.directory, 'mismatched.pin.json');
    writeFileSync(mismatchedPin, `${JSON.stringify({
      schema_version: 1,
      provider: 'gvisor',
      release: 'test-release',
      architecture: architecture(),
      artifact: {
        url: 'https://example.invalid/gvisor.tar.bz2',
        sha512: 'a'.repeat(128),
      },
      runsc: {
        version: 'release-test',
        sha256: '0'.repeat(64),
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: mismatchedPin,
      });
      const check = await provider.check();
      expect(check.available).toBe(false);
      expect(check.isolationFailure).toBe(true);
      expect(check.reason).toMatch(/does not match the repository pin/i);
      expect(existsSync(fake.calls)).toBe(false);
    });
  });

  it('fails closed when runsc is absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'aios-no-runsc-'));
    const rootfs = mkdtempSync(join(tmpdir(), 'aios-empty-rootfs-'));
    await withPath(empty, async () => {
      const provider = createSandboxProvider({ provider: 'gvisor', rootfs });
      await expect(provider.check()).resolves.toMatchObject({
        available: false,
        reason: expect.stringMatching(/runsc|installed/i),
      });
      const executorConfig = {
        workspace_directory: mkdtempSync(join(tmpdir(), 'aios-gvisor-ws-')),
        agent_id: '11111111-1111-4111-8111-111111111111',
        verifier_id: '22222222-2222-4222-8222-222222222222',
        provider: 'gvisor' as const,
        rootfs,
        default_timeout_ms: 5_000,
        max_output_bytes: 16 * 1024,
        workspace_max_bytes: 1024 * 1024,
        max_concurrent_tasks: 1,
      };
      // The selected provider is never replaced by a bare process when unavailable.
      await expect(import('../src/execution/command-executor.js').then(async ({ LocalCommandExecutor }) => {
        const { RunWorkspaceManager } = await import('../src/execution/workspace.js');
        const executor = new LocalCommandExecutor(
          executorConfig,
          provider,
          new RunWorkspaceManager(executorConfig.workspace_directory),
        );
        return executor.validateAgent(executorConfig.agent_id);
      })).rejects.toBeInstanceOf(SandboxIsolationUnavailableError);
    });
  });
});
