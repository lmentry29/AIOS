import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDestinationAbsent,
  assertMaterializedExecutableUnchanged,
  assertReproducibleRootfs,
  assertRootfsUnchanged,
  createOwnedStagingDirectory,
  digestRootfs,
  hashFile,
  materializeVerifiedExecutable,
  promoteOwnedDirectory,
  readGvisorRootfsBuildPin,
  readGvisorRuntimePin,
  removeOwnedDirectory,
  selectPlatformManifestDigest,
  verifyGvisorRootfsBuildInputs,
  verifyPinnedArtifact,
} from '../src/execution/provenance.js';

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('gVisor provenance', () => {
  it('hashes rootfs content and metadata canonically, attesting mtime separately', () => {
    const first = directory('aios-rootfs-a-');
    const second = directory('aios-rootfs-b-');
    mkdirSync(join(first, 'usr', 'bin'), { recursive: true });
    mkdirSync(join(second, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(first, 'usr', 'bin', 'tool'), 'same content\n', { mode: 0o755 });
    writeFileSync(join(second, 'usr', 'bin', 'tool'), 'same content\n', { mode: 0o755 });
    utimesSync(join(first, 'usr', 'bin', 'tool'), new Date(1), new Date(1));
    utimesSync(join(second, 'usr', 'bin', 'tool'), new Date(2), new Date(2));

    const firstDigest = digestRootfs(first);
    const secondDigest = digestRootfs(second);
    expect(firstDigest.sha256).toBe(secondDigest.sha256);
    expect(firstDigest.content_sha256).toBe(secondDigest.content_sha256);
    expect(firstDigest.metadata_sha256).toBe(secondDigest.metadata_sha256);
    expect(firstDigest.timestamps_sha256).not.toBe(secondDigest.timestamps_sha256);
    expect(firstDigest.manifest_version).toBe(2);
    expect(firstDigest.entries).toBe(3);
  });

  it('attests ownership and privilege bits in the metadata digest', () => {
    const rootfs = directory('aios-rootfs-metadata-');
    const file = join(rootfs, 'tool');
    writeFileSync(file, 'payload', { mode: 0o644 });
    const initial = digestRootfs(rootfs);
    chmodSync(file, 0o4755);
    const elevated = digestRootfs(rootfs);
    expect(elevated.metadata_sha256).not.toBe(initial.metadata_sha256);
    expect(elevated.sha256).not.toBe(initial.sha256);
    utimesSync(file, new Date(5_000), new Date(7_000));
    const retimed = digestRootfs(rootfs);
    expect(retimed.sha256).toBe(elevated.sha256);
    expect(retimed.metadata_sha256).toBe(elevated.metadata_sha256);
    expect(retimed.timestamps_sha256).not.toBe(elevated.timestamps_sha256);
  });

  it('records extended attributes as unavailable or fails closed when required', () => {
    const rootfs = directory('aios-rootfs-xattr-');
    writeFileSync(join(rootfs, 'file'), 'x', { mode: 0o600 });
    expect(digestRootfs(rootfs, { xattrs: 'skip' }).xattrs).toBe('unavailable');
    const probe = spawnSync('getfattr', ['--version'], { encoding: 'utf8' });
    const available = probe.error === undefined && probe.status === 0;
    expect(digestRootfs(rootfs).xattrs).toBe(available ? 'captured' : 'unavailable');
    if (available) {
      expect(digestRootfs(rootfs, { xattrs: 'required' }).xattrs).toBe('captured');
    } else {
      expect(() => digestRootfs(rootfs, { xattrs: 'required' })).toThrow(/extended attributes/);
    }
  });

  it('changes the rootfs digest when content or a symlink target changes', () => {
    const rootfs = directory('aios-rootfs-content-');
    writeFileSync(join(rootfs, 'file'), 'one', { mode: 0o644 });
    const initial = digestRootfs(rootfs).sha256;
    writeFileSync(join(rootfs, 'file'), 'two', { mode: 0o644 });
    expect(digestRootfs(rootfs).sha256).not.toBe(initial);

    const links = directory('aios-rootfs-links-');
    symlinkSync('/one', join(links, 'link'));
    const linked = digestRootfs(links).sha256;
    symlinkSync('/two', join(links, 'link-2'));
    expect(digestRootfs(links).sha256).not.toBe(linked);
  });

  it('rejects a missing pin and a malformed pin instead of treating provenance as optional', () => {
    expect(() => readGvisorRuntimePin(join(directory('aios-pin-'), 'missing.json')))
      .toThrow(/pin file does not exist/);

    const path = join(directory('aios-pin-invalid-'), 'pin.json');
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      provider: 'gvisor',
      release: 'test-release',
      architecture: 'x86_64',
      artifact: null,
      runsc: { version: 'release-test', sha256: 'b'.repeat(64) },
    }), { mode: 0o600 });
    expect(() => readGvisorRuntimePin(path)).toThrow(/artifact object/);
  });

  it('reads a complete pin and records its own digest', () => {
    const base = directory('aios-pin-valid-');
    const path = join(base, 'pin.json');
    const pin = {
      schema_version: 1,
      provider: 'gvisor',
      release: 'test-release',
      architecture: process.arch === 'x64' ? 'x86_64' : 'arm64',
      artifact: { url: 'https://example.invalid/gvisor.tar.bz2', sha512: 'a'.repeat(128) },
      runsc: { version: 'release-test', sha256: 'b'.repeat(64) },
    };
    writeFileSync(path, JSON.stringify(pin), { mode: 0o600 });
    const loaded = readGvisorRuntimePin(path);
    expect(loaded.pin.runsc).toEqual({ version: 'release-test', sha256: 'b'.repeat(64) });
    expect(loaded.pin_sha256).toBe(hashFile(path, 'sha256'));
  });

  it('fails closed with the observed mismatch on a tampered artifact', () => {
    const base = directory('aios-artifact-');
    const artifact = join(base, 'gvisor.tar.bz2');
    writeFileSync(artifact, 'not the pinned archive', { mode: 0o600 });
    expect(() => verifyPinnedArtifact(artifact, '0'.repeat(128)))
      .toThrow(/does not match the pinned SHA-512 \(expected 0{128}, observed [0-9a-f]{128}\)/);
    expect(hashFile(artifact, 'sha512')).toBe(
      createHash('sha512').update('not the pinned archive').digest('hex'),
    );
  });

  it('rejects a malformed or missing rootfs build pin', () => {
    const base = directory('aios-rootfs-pin-');
    expect(() => readGvisorRootfsBuildPin(join(base, 'missing.json')))
      .toThrow(/rootfs build pin file does not exist/);
    const path = join(base, 'pin.json');
    writeFileSync(path, JSON.stringify({
      ...rootfsPin(),
      base_image: { ...rootfsPin().base_image, digest: 'sha256:not-a-digest' },
    }), { mode: 0o600 });
    expect(() => readGvisorRootfsBuildPin(path)).toThrow(/base_image\.digest/);
  });

  it('accepts pinned build inputs and rejects base, snapshot and package drift', () => {
    const base = directory('aios-rootfs-inputs-');
    const pin = rootfsPin();
    const pinPath = join(base, 'pin.json');
    writeFileSync(pinPath, JSON.stringify(pin), { mode: 0o600 });
    const dockerfile = join(base, 'Dockerfile');
    writeFileSync(dockerfile, rootfsDockerfile(pin), { mode: 0o600 });

    const loaded = readGvisorRootfsBuildPin(pinPath);
    expect(() => verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile)).not.toThrow();

    writeFileSync(dockerfile, rootfsDockerfile(pin).replace(
      `${pin.base_image.reference}@${pin.base_image.platform_digest_amd64}`,
      pin.base_image.reference,
    ), { mode: 0o600 });
    expect(() => verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile))
      .toThrow(/pinned base image/);

    // The manifest-list digest is not an acceptable substitute for the platform manifest.
    writeFileSync(dockerfile, rootfsDockerfile(pin).replace(
      `${pin.base_image.reference}@${pin.base_image.platform_digest_amd64}`,
      `${pin.base_image.reference}@${pin.base_image.digest}`,
    ), { mode: 0o600 });
    expect(() => verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile))
      .toThrow(/pinned base image/);

    writeFileSync(dockerfile, rootfsDockerfile(pin).replace(
      pin.apt_snapshot.timestamp,
      '20261109T000000Z',
    ), { mode: 0o600 });
    expect(() => verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile))
      .toThrow(/snapshot/);

    writeFileSync(dockerfile, rootfsDockerfile(pin).replace(
      `coreutils=${pin.packages.coreutils}`,
      'coreutils=9.1-2',
    ), { mode: 0o600 });
    expect(() => verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile))
      .toThrow(/package coreutils/);
  });

  it('rejects a different canonical digest from two builds', () => {
    expect(() => assertReproducibleRootfs(
      { sha256: 'a'.repeat(64), entries: 10 },
      { sha256: 'b'.repeat(64), entries: 10 },
    )).toThrow(/not reproducible/);
  });

  it('asserts timestamps only when the comparison is timestamp-stable', () => {
    const first = { sha256: 'a'.repeat(64), entries: 1, timestamps_sha256: 'b'.repeat(64) };
    const second = { ...first, timestamps_sha256: 'c'.repeat(64) };
    expect(() => assertReproducibleRootfs(first, second)).not.toThrow();
    expect(() => assertReproducibleRootfs(first, second, '', { timestamps: true }))
      .toThrow(/not reproducible.*timestamps_sha256/);
  });

  it('rejects a rootfs that changed after it was measured', () => {
    const rootfs = directory('aios-rootfs-changed-');
    writeFileSync(join(rootfs, 'file'), 'before', { mode: 0o600 });
    const before = digestRootfs(rootfs);
    writeFileSync(join(rootfs, 'extra'), 'after', { mode: 0o600 });
    expect(() => assertRootfsUnchanged(before, digestRootfs(rootfs)))
      .toThrow(/changed while the sandbox was running/);
  });

  it('materializes the verified executable and rejects a replaced copy', () => {
    const parent = directory('aios-materialize-');
    const source = join(parent, 'runsc');
    writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const sha256 = hashFile(source, 'sha256');
    const stage = createOwnedStagingDirectory(parent, 'private-');
    const executable = materializeVerifiedExecutable(source, sha256, stage);
    expect(executable.path).not.toBe(source);
    expect(readFileSync(executable.path, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(() => assertMaterializedExecutableUnchanged(executable)).not.toThrow();

    chmodSync(executable.path, 0o700);
    writeFileSync(executable.path, 'tampered');
    expect(() => assertMaterializedExecutableUnchanged(executable))
      .toThrow(/replaced after verification|changed after verification/);
    removeOwnedDirectory(stage);

    const rejected = createOwnedStagingDirectory(parent, 'private-');
    expect(() => materializeVerifiedExecutable(source, '0'.repeat(64), rejected))
      .toThrow(/does not match the verified SHA-256/);
    removeOwnedDirectory(rejected);
  });

  it('selects exactly one amd64 manifest digest from a pinned image index', () => {
    const amd64 = `sha256:${'a'.repeat(64)}`;
    const index = {
      schemaVersion: 2,
      manifests: [
        { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
        { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
      ],
    };
    expect(selectPlatformManifestDigest(index, 'linux', 'amd64')).toBe(amd64);
    expect(() => selectPlatformManifestDigest(index, 'linux', 's390x'))
      .toThrow(/exactly one linux\/s390x/);
    expect(() => selectPlatformManifestDigest({
      manifests: [
        { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
        { digest: amd64, platform: { os: 'linux', architecture: 'amd64', variant: 'v2' } },
      ],
    }, 'linux', 'amd64')).toThrow(/exactly one/);
  });

  it('creates unique staging directories and removes only its own inode', () => {
    const parent = directory('aios-staging-unique-');
    const first = createOwnedStagingDirectory(parent, 'stage-');
    const second = createOwnedStagingDirectory(parent, 'stage-');
    expect(first.path).not.toBe(second.path);
    writeFileSync(join(first.path, 'partial'), 'partial extraction', { mode: 0o600 });
    removeOwnedDirectory(first);
    expect(existsSync(first.path)).toBe(false);
    removeOwnedDirectory(second);
    expect(existsSync(second.path)).toBe(false);
  });

  it('refuses an existing destination and preserves its contents', () => {
    const parent = directory('aios-staging-existing-');
    const destination = join(parent, 'rootfs');
    mkdirSync(destination);
    writeFileSync(join(destination, 'operator-owned'), 'keep me', { mode: 0o600 });
    const stage = createOwnedStagingDirectory(parent, 'stage-');
    expect(() => promoteOwnedDirectory(stage, destination)).toThrow(/existing gVisor output/);
    expect(readFileSync(join(destination, 'operator-owned'), 'utf8')).toBe('keep me');
    removeOwnedDirectory(stage);
    expect(() => assertDestinationAbsent(destination)).toThrow(/existing gVisor output/);
  });

  it('refuses a symlink destination without touching its target', () => {
    const parent = directory('aios-staging-symlink-');
    const target = join(parent, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'operator-owned'), 'keep me', { mode: 0o600 });
    const destination = join(parent, 'rootfs');
    symlinkSync(target, destination, 'dir');
    const stage = createOwnedStagingDirectory(parent, 'stage-');
    expect(() => promoteOwnedDirectory(stage, destination)).toThrow(/existing gVisor output/);
    expect(readFileSync(join(target, 'operator-owned'), 'utf8')).toBe('keep me');
    removeOwnedDirectory(stage);
  });

  it('allows only one concurrent promotion and preserves the winner', () => {
    const parent = directory('aios-staging-concurrent-');
    const destination = join(parent, 'rootfs');
    const first = createOwnedStagingDirectory(parent, 'stage-');
    const second = createOwnedStagingDirectory(parent, 'stage-');
    writeFileSync(join(first.path, 'winner'), 'first', { mode: 0o600 });
    writeFileSync(join(second.path, 'loser'), 'second', { mode: 0o600 });
    promoteOwnedDirectory(first, destination);
    expect(() => promoteOwnedDirectory(second, destination)).toThrow(/existing gVisor output/);
    expect(readFileSync(join(destination, 'winner'), 'utf8')).toBe('first');
    removeOwnedDirectory(second);
    expect(existsSync(second.path)).toBe(false);
  });

  it('does not clean a staging path replaced by a symlink', () => {
    const parent = directory('aios-staging-substitution-');
    const stage = createOwnedStagingDirectory(parent, 'stage-');
    const moved = join(parent, 'moved-owned');
    renameSync(stage.path, moved);
    symlinkSync(moved, stage.path, 'dir');
    writeFileSync(join(moved, 'operator-owned'), 'keep me', { mode: 0o600 });
    removeOwnedDirectory(stage);
    expect(readFileSync(join(moved, 'operator-owned'), 'utf8')).toBe('keep me');
    rmSync(stage.path, { force: true });
    rmSync(moved, { recursive: true, force: true });
  });

  it('rejects a symlinked staging parent before creating output', () => {
    const root = directory('aios-staging-parent-');
    const realParent = join(root, 'real');
    mkdirSync(realParent);
    const linkedParent = join(root, 'linked');
    symlinkSync(realParent, linkedParent, 'dir');
    expect(() => createOwnedStagingDirectory(linkedParent, 'stage-'))
      .toThrow(/real directory/);
  });
});

function rootfsPin() {
  return {
    schema_version: 1 as const,
    provider: 'gvisor' as const,
    base_image: {
      reference: 'debian:bookworm-slim',
      digest: `sha256:${'1'.repeat(64)}`,
      platform_digest_amd64: `sha256:${'2'.repeat(64)}`,
    },
    apt_snapshot: {
      base_url: 'http://snapshot.debian.org/archive' as const,
      timestamp: '20261110T000000Z',
      suites: {
        bookworm: 'debian' as const,
        'bookworm-updates': 'debian' as const,
        'bookworm-security': 'debian-security' as const,
      },
    },
    packages: {
      coreutils: '9.1-1',
      perl: '5.36.0-7+deb12u4',
      'util-linux': '2.38.1-5+deb12u3',
    },
    dockerfile: 'tools/security/docker-sandbox.Dockerfile',
    excluded_paths: ['/etc/shadow', '/etc/gshadow'],
    construction: 'test construction',
  };
}

function rootfsDockerfile(pin: ReturnType<typeof rootfsPin>): string {
  const timestamp = pin.apt_snapshot.timestamp;
  return `FROM ${pin.base_image.reference}@${pin.base_image.platform_digest_amd64}\nRUN apt-get -o Acquire::Check-Valid-Until=false update \\\n && apt-get install -y --no-install-recommends \\\n      coreutils=${pin.packages.coreutils} \\\n      perl=${pin.packages.perl} \\\n      util-linux=${pin.packages['util-linux']}; \\\n && rm -f /etc/shadow /etc/gshadow\n# ${pin.apt_snapshot.base_url}/debian/${timestamp} bookworm main\n# ${pin.apt_snapshot.base_url}/debian/${timestamp} bookworm-updates main\n# ${pin.apt_snapshot.base_url}/debian-security/${timestamp} bookworm-security main\n`;
}
