import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  digestRootfs,
  hashFile,
  readGvisorRuntimePin,
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
});
