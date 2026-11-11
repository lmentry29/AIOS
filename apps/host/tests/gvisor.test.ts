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
import { createTrustRoot, generateSigningKey, signArtifact } from '../src/execution/artifact-signing.js';
import { digestRootfs, hashFile } from '../src/execution/provenance.js';
import { createSandboxProvider } from '../src/execution/sandbox.js';

interface FakeRunsc {
  directory: string;
  rootfs: string;
  capture: string;
  calls: string;
  pinPath: string;
  binarySha256: string;
  trustRootPath: string;
  runtimeSignaturePath: string;
  rootfsManifestPath: string;
  rootfsSignaturePath: string;
  keyId: string;
  privateKeyPem: string;
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
  const key = generateSigningKey();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    not_after: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const trustRootPath = join(directory, 'trust-root.json');
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`, { mode: 0o600 });
  const pinBytes = readFileSync(pinPath);
  const pin = JSON.parse(pinBytes.toString('utf8')) as {
    release: string;
    artifact: { sha512: string };
    runsc: { version: string; sha256: string };
  };
  const runtimeSignature = signArtifact({
    artifact_kind: 'gvisor-runtime-pin',
    artifact_path: pinPath,
    key_id: key.key_id,
    private_key_pem: key.private_key_pem,
    trust_root: trustRoot,
    source: { repository: null, commit: null, workflow: null, run_id: null },
    subject: {
      release: pin.release,
      runsc_version: pin.runsc.version,
      runsc_sha256: pin.runsc.sha256,
      artifact_sha512: pin.artifact.sha512,
    },
  });
  const runtimeSignaturePath = `${pinPath}.sig.json`;
  writeFileSync(runtimeSignaturePath, `${JSON.stringify(runtimeSignature, null, 2)}\n`, { mode: 0o600 });
  const rootfsDigest = digestRootfs(rootfs);
  const rootfsManifestPath = join(directory, 'gvisor-rootfs.manifest.json');
  writeFileSync(rootfsManifestPath, `${JSON.stringify({
    schema_version: 2,
    rootfs_sha256: rootfsDigest.sha256,
    entries: rootfsDigest.entries,
  }, null, 2)}\n`, { mode: 0o600 });
  const rootfsSignature = signArtifact({
    artifact_kind: 'gvisor-rootfs-manifest',
    artifact_path: rootfsManifestPath,
    key_id: key.key_id,
    private_key_pem: key.private_key_pem,
    trust_root: trustRoot,
    source: { repository: null, commit: null, workflow: null, run_id: null },
    subject: { rootfs_sha256: rootfsDigest.sha256, entries: rootfsDigest.entries },
  });
  const rootfsSignaturePath = `${rootfsManifestPath}.sig.json`;
  writeFileSync(rootfsSignaturePath, `${JSON.stringify(rootfsSignature, null, 2)}\n`, { mode: 0o600 });
  return {
    directory,
    rootfs,
    capture,
    calls,
    pinPath,
    binarySha256,
    trustRootPath,
    runtimeSignaturePath,
    rootfsManifestPath,
    rootfsSignaturePath,
    keyId: key.key_id,
    privateKeyPem: key.private_key_pem,
  };
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
          gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
          gvisorRootfsManifestPath: fake.rootfsManifestPath,
          gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
          gvisorTrustRootPath: fake.trustRootPath,
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
        const manifest = JSON.parse(readFileSync(fake.rootfsManifestPath, 'utf8')) as {
          rootfs_sha256: string;
          entries: number;
        };
        // The signed manifest digest, the measured rootfs digest and the provider evidence
        // are the same value; materializeVerifiedRootfs re-checks that value on the copy.
        expect(check.provenance?.rootfs).toMatchObject({
          sha256: manifest.rootfs_sha256,
          entries: manifest.entries,
          manifest_sha256: hashFile(fake.rootfsManifestPath, 'sha256'),
        });
        expect(check.provenance?.rootfs.sha256).toBe(digestRootfs(fake.rootfs).sha256);

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
        expect(captured.config.root.readonly).toBe(true);
        expect(captured.config.root.path).not.toBe(fake.rootfs);
        expect(captured.config.root.path.startsWith(tmpdir())).toBe(true);
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
        gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
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

  it('executes an invocation-owned rootfs copy and leaves the operator tree untouched', async () => {
    const fake = fakeRunsc();
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: fake.pinPath,
        gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
      });
      const workspace = mkdtempSync(join(tmpdir(), 'aios-gvisor-rootfs-copy-'));
      const result = await provider.run({
        argv: ['/bin/true'],
        workspaceDirectory: workspace,
        cwd: '.',
        timeoutMs: 3_000,
        maxOutputBytes: 1024,
        env: { AIOS_FAKE_MUTATE: '1' },
      });
      expect(result.provenance?.rootfs.sha256).toBe(digestRootfs(fake.rootfs).sha256);
      const captured = JSON.parse(readFileSync(fake.capture, 'utf8')) as {
        config: { root: { path: string } };
      };
      expect(captured.config.root.path).not.toBe(fake.rootfs);
      expect(captured.config.root.path.startsWith(tmpdir())).toBe(true);
      // The runtime mutated only the per-invocation copy.
      expect(existsSync(join(fake.rootfs, 'intruder'))).toBe(false);
      expect(existsSync(captured.config.root.path)).toBe(false);
    });
  });

  it('fails closed when the rootfs changes after its manifest was signed', async () => {
    const fake = fakeRunsc();
    writeFileSync(join(fake.rootfs, 'planted-after-signing'), 'mutation');
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: fake.pinPath,
        gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
      });
      const check = await provider.check();
      expect(check.available).toBe(false);
      expect(check.isolationFailure).toBe(true);
      expect(check.reason).toMatch(/does not match the signed manifest/);
      expect(existsSync(fake.calls)).toBe(false);
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
        gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
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
    const mismatchedSignaturePath = `${mismatchedPin}.sig.json`;
    writeFileSync(mismatchedSignaturePath, `${JSON.stringify(signArtifact({
      artifact_kind: 'gvisor-runtime-pin',
      artifact_path: mismatchedPin,
      key_id: fake.keyId,
      private_key_pem: fake.privateKeyPem,
      source: { repository: null, commit: null, workflow: null, run_id: null },
      subject: {
        release: 'test-release',
        runsc_version: 'release-test',
        runsc_sha256: '0'.repeat(64),
        artifact_sha512: 'a'.repeat(128),
      },
    }), null, 2)}\n`);
    await withPath(fake.directory, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs: fake.rootfs,
        gvisorPinPath: mismatchedPin,
        gvisorRuntimeSignaturePath: mismatchedSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
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
    const fake = fakeRunsc();
    const rootfs = fake.rootfs;
    await withPath(empty, async () => {
      const provider = createSandboxProvider({
        provider: 'gvisor',
        rootfs,
        gvisorPinPath: fake.pinPath,
        gvisorRuntimeSignaturePath: fake.runtimeSignaturePath,
        gvisorRootfsManifestPath: fake.rootfsManifestPath,
        gvisorRootfsSignaturePath: fake.rootfsSignaturePath,
        gvisorTrustRootPath: fake.trustRootPath,
      });
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
