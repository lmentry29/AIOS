#!/usr/bin/env node
/**
 * Reproducible gVisor runtime and OCI-rootfs provenance tooling.
 *
 * The runtime archive is fetched from the URL pinned in
 * tools/security/gvisor-runtime.pin.json and is accepted only when its SHA-512 matches
 * that repository pin and its extracted runsc matches the pinned SHA-256 and version.
 * No upstream checksum file is consulted.
 *
 * The rootfs is exported from the already-built aios-sandbox:local image using an
 * in-repo Dockerfile. Its canonical content digest is computed from paths, modes, file
 * bytes, and symlink targets; timestamps and ownership are excluded. `--verify-reproducible`
 * exports the image a second time and requires the same digest.
 *
 * This file imports the built host provenance module so CI does not maintain a second
 * hashing implementation. Run `pnpm turbo build` before invoking it.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  digestRootfs,
  hashFile,
  ProvenanceError,
  readGvisorRuntimePin,
  verifyPinnedArtifact,
} from '../../apps/host/dist/execution/provenance.js';

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new ProvenanceError(`Unexpected argument: ${argument}.`);
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function required(parsed, key) {
  const value = parsed[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProvenanceError(`--${key} is required.`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new ProvenanceError(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n')[0] || 'no output';
    throw new ProvenanceError(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function architecture() {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function assertArchitecture(pin) {
  if (pin.architecture !== architecture()) {
    throw new ProvenanceError(
      `The gVisor runtime pin is for ${pin.architecture}, but this host is ${architecture()}.`,
    );
  }
}

function readSource(sourcePath) {
  if (sourcePath === undefined) return {};
  const path = resolve(sourcePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ProvenanceError(`The gVisor rootfs source metadata is unreadable: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProvenanceError('The gVisor rootfs source metadata must be a JSON object.');
  }
  return parsed;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new ProvenanceError(`The pinned gVisor runtime download returned HTTP ${response.status}.`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function extractRuntime(archive, output) {
  if (existsSync(output)) {
    throw new ProvenanceError(`Refusing to overwrite an existing gVisor runtime directory: ${resolve(output)}.`);
  }
  mkdirSync(output, { mode: 0o700 });
  run('tar', ['-xjf', archive, '-C', output]);
  chmodSync(join(output, 'runsc'), 0o755);
  const bin = join(output, 'gvisor-bin');
  if (existsSync(bin)) {
    for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
  }
}

function verifyRuntime(output, pin) {
  const runsc = join(output, 'runsc');
  const actual = hashFile(runsc, 'sha256');
  if (actual !== pin.runsc.sha256) {
    throw new ProvenanceError(
      `The extracted gVisor runsc does not match the pinned SHA-256 (expected ${pin.runsc.sha256}, observed ${actual}).`,
    );
  }
  const versionOutput = run(runsc, ['--version']);
  const version = /^runsc version\s+(\S+)/m.exec(versionOutput)?.[1];
  if (version !== pin.runsc.version) {
    throw new ProvenanceError(
      `The extracted gVisor runsc version does not match the pin (expected ${pin.runsc.version}, observed ${version ?? 'unknown'}).`,
    );
  }
  return actual;
}

function manifestFor(rootfs, source, extra) {
  const digest = digestRootfs(rootfs);
  return {
    schema_version: 1,
    rootfs_sha256: digest.sha256,
    entries: digest.entries,
    source,
    ...extra,
  };
}

function writeManifest(path, manifest) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function exportRootfs(image, destination) {
  if (existsSync(destination)) {
    throw new ProvenanceError(`Refusing to overwrite an existing gVisor rootfs: ${resolve(destination)}.`);
  }
  const name = `aios-gvisor-rootfs-${randomUUID()}`;
  const archive = join(tmpdir(), `${name}.tar`);
  try {
    run('docker', ['create', '--name', name, image]);
    run('docker', ['export', '--output', archive, name]);
    mkdirSync(destination, { mode: 0o700 });
    run('tar', ['-xf', archive, '-C', destination, '--no-same-owner']);
  } finally {
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8' });
    rmSync(archive, { force: true });
  }
  return digestRootfs(destination);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = options(rest);

  if (command === 'verify-archive') {
    const pinPath = required(parsed, 'pin');
    const archive = resolve(required(parsed, 'archive'));
    const loaded = readGvisorRuntimePin(pinPath);
    assertArchitecture(loaded.pin);
    const sha512 = verifyPinnedArtifact(archive, loaded.pin.artifact.sha512);
    process.stdout.write(`${JSON.stringify({
      release: loaded.pin.release,
      artifact: archive,
      artifact_sha512: sha512,
      pin_sha256: loaded.pin_sha256,
    })}\n`);
    return;
  }

  if (command === 'fetch-runtime') {
    const pinPath = required(parsed, 'pin');
    const output = resolve(required(parsed, 'output'));
    const loaded = readGvisorRuntimePin(pinPath);
    assertArchitecture(loaded.pin);
    const archive = join(dirname(output), `gvisor-${randomUUID()}.tar.bz2`);
    try {
      await download(loaded.pin.artifact.url, archive);
      const sha512 = verifyPinnedArtifact(archive, loaded.pin.artifact.sha512);
      extractRuntime(archive, output);
      const binarySha256 = verifyRuntime(output, loaded.pin);
      process.stdout.write(`${JSON.stringify({
        release: loaded.pin.release,
        version: loaded.pin.runsc.version,
        artifact_sha512: sha512,
        binary_sha256: binarySha256,
        pin_sha256: loaded.pin_sha256,
        runsc: join(output, 'runsc'),
      })}\n`);
    } catch (error) {
      rmSync(output, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(archive, { force: true });
    }
    return;
  }

  if (command === 'digest-rootfs') {
    const rootfs = resolve(required(parsed, 'rootfs'));
    const source = readSource(parsed.source);
    const manifest = manifestFor(rootfs, source, {
      dockerfile_sha256: typeof source.dockerfile === 'string'
        ? hashFile(resolve(source.dockerfile), 'sha256')
        : undefined,
    });
    if (manifest.dockerfile_sha256 === undefined) delete manifest.dockerfile_sha256;
    if (typeof parsed.manifest === 'string') writeManifest(resolve(parsed.manifest), manifest);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }

  if (command === 'verify-rootfs') {
    const rootfs = resolve(required(parsed, 'rootfs'));
    const manifestPath = resolve(required(parsed, 'manifest'));
    const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const actual = digestRootfs(rootfs);
    if (actual.sha256 !== expected.rootfs_sha256 || actual.entries !== expected.entries) {
      throw new ProvenanceError(
        `The gVisor rootfs does not match its manifest (expected ${expected.rootfs_sha256}/${expected.entries} entries, observed ${actual.sha256}/${actual.entries}).`,
      );
    }
    process.stdout.write(`${JSON.stringify({ rootfs_sha256: actual.sha256, entries: actual.entries })}\n`);
    return;
  }

  if (command === 'build-rootfs') {
    const image = required(parsed, 'image');
    const sourcePath = required(parsed, 'source');
    const dockerfile = resolve(required(parsed, 'dockerfile'));
    const output = resolve(required(parsed, 'output'));
    const manifestPath = resolve(required(parsed, 'manifest'));
    const source = readSource(sourcePath);
    if (typeof source.dockerfile === 'string' && resolve(source.dockerfile) !== dockerfile) {
      throw new ProvenanceError(
        `The gVisor rootfs source metadata names ${source.dockerfile}, not ${dockerfile}.`,
      );
    }
    const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).trim();
    const first = exportRootfs(image, output);
    let reproducible = null;
    if (parsed['verify-reproducible'] === true) {
      const secondOutput = `${output}-reproducibility-${randomUUID()}`;
      try {
        const second = exportRootfs(image, secondOutput);
        if (second.sha256 !== first.sha256 || second.entries !== first.entries) {
          throw new ProvenanceError(
            `The gVisor rootfs export is not reproducible (first ${first.sha256}/${first.entries} entries, second ${second.sha256}/${second.entries}).`,
          );
        }
        reproducible = { sha256: second.sha256, entries: second.entries };
      } finally {
        rmSync(secondOutput, { recursive: true, force: true });
      }
    }
    const manifest = manifestFor(output, {
      ...source,
      image,
      image_id: imageId,
      dockerfile,
      dockerfile_sha256: hashFile(dockerfile, 'sha256'),
    }, {
      ...(reproducible === null ? {} : { reproducible }),
    });
    writeManifest(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify({
      rootfs_sha256: manifest.rootfs_sha256,
      entries: manifest.entries,
      image,
      image_id: imageId,
      reproducible,
      manifest: manifestPath,
    })}\n`);
    return;
  }

  throw new ProvenanceError('Usage: gvisor-provenance.mjs <verify-archive|fetch-runtime|digest-rootfs|verify-rootfs|build-rootfs> [options]');
}

main().catch((error) => {
  process.stderr.write(`gVisor provenance error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
