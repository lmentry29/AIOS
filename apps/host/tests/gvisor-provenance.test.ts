import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReproducibleRootfs,
  digestRootfs,
  hashFile,
  readGvisorRootfsBuildPin,
  readGvisorRuntimePin,
  verifyGvisorRootfsBuildInputs,
  verifyPinnedArtifact,
} from '../src/execution/provenance.js';

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('gVisor provenance', () => {
  it('hashes rootfs content canonically without timestamps or traversal order', () => {
    const first = directory('aios-rootfs-a-');
    const second = directory('aios-rootfs-b-');
    mkdirSync(join(first, 'usr', 'bin'), { recursive: true });
    mkdirSync(join(second, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(first, 'usr', 'bin', 'tool'), 'same content\n', { mode: 0o755 });
    writeFileSync(join(second, 'usr', 'bin', 'tool'), 'same content\n', { mode: 0o755 });
    utimesSync(join(first, 'usr', 'bin', 'tool'), new Date(1), new Date(1));
    utimesSync(join(second, 'usr', 'bin', 'tool'), new Date(2), new Date(2));

    expect(digestRootfs(first)).toEqual(digestRootfs(second));
    expect(digestRootfs(first).entries).toBe(3);
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
      `${pin.base_image.reference}@${pin.base_image.digest}`,
      pin.base_image.reference,
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
  return `FROM ${pin.base_image.reference}@${pin.base_image.digest}\nRUN apt-get -o Acquire::Check-Valid-Until=false update \\\n && apt-get install -y --no-install-recommends \\\n      coreutils=${pin.packages.coreutils} \\\n      perl=${pin.packages.perl} \\\n      util-linux=${pin.packages['util-linux']}; \\\n && rm -f /etc/shadow /etc/gshadow\n# ${pin.apt_snapshot.base_url}/debian/${timestamp} bookworm main\n# ${pin.apt_snapshot.base_url}/debian/${timestamp} bookworm-updates main\n# ${pin.apt_snapshot.base_url}/debian-security/${timestamp} bookworm-security main\n`;
}
