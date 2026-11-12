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
 * in-repo Dockerfile. Its manifest v2 digest covers paths, entry types, permission bits,
 * owner uid/gid, file bytes, symlink targets and extended attributes; mtime is attested
 * separately because independent Docker builds do not produce identical directory times.
 * `--require-xattrs` makes an absent extended-attribute reader a hard failure.
 * `verify-platform-digest` proves the pinned amd64 manifest is a child of the pinned index.
 *
 * This file imports the built host provenance module so CI does not maintain a second
 * hashing implementation. Run `pnpm turbo build` before invoking it.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertDestinationAbsent,
  assertReproducibleRootfs,
  createOwnedStagingDirectory,
  digestRootfs,
  hashFile,
  promoteOwnedDirectory,
  ProvenanceError,
  readGvisorRootfsBuildPin,
  readGvisorRuntimePin,
  removeOwnedDirectory,
  selectPlatformManifestDigest,
  verifyGvisorRootfsBuildInputs,
  verifyPinnedArtifact,
} from "../../apps/host/dist/execution/provenance.js";

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new ProvenanceError(`Unexpected argument: ${argument}.`);
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
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
  if (typeof value !== "string" || value.length === 0) {
    throw new ProvenanceError(`--${key} is required.`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new ProvenanceError(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n")[0] || "no output";
    throw new ProvenanceError(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function architecture() {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "arm64";
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
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ProvenanceError(
      `The gVisor rootfs source metadata is unreadable: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProvenanceError("The gVisor rootfs source metadata must be a JSON object.");
  }
  return parsed;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new ProvenanceError(
      `The pinned gVisor runtime download returned HTTP ${response.status}.`,
    );
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function extractRuntime(archive, output) {
  const stats = lstatSync(output);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ProvenanceError(
      `The runtime staging path is not a real directory: ${resolve(output)}.`,
    );
  }
  // The staging directory is empty and owned by this invocation; extraction cannot
  // overwrite operator state. Ownership is normalized because the drill runs unprivileged.
  run("tar", ["-xjf", archive, "-C", output, "--no-same-owner"]);
  const runsc = join(output, "runsc");
  const runscStats = lstatSync(runsc);
  if (runscStats.isSymbolicLink() || !runscStats.isFile()) {
    throw new ProvenanceError(
      `The gVisor runtime archive did not contain a regular runsc file: ${runsc}.`,
    );
  }
  chmodSync(runsc, 0o755);
  const bin = join(output, "gvisor-bin");
  if (existsSync(bin)) {
    const binStats = lstatSync(bin);
    if (binStats.isSymbolicLink() || !binStats.isDirectory()) {
      throw new ProvenanceError(
        `The gVisor runtime archive has an unexpected gvisor-bin entry: ${bin}.`,
      );
    }
    for (const name of readdirSync(bin)) {
      const candidate = join(bin, name);
      // Never chmod through a symlink a hostile archive could contain.
      if (!lstatSync(candidate).isFile()) continue;
      chmodSync(candidate, 0o755);
    }
  }
}

function verifyRuntime(output, pin) {
  const runsc = join(output, "runsc");
  const stats = lstatSync(runsc);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProvenanceError(
      `The verified gVisor runsc must be a regular file, not a symlink: ${runsc}.`,
    );
  }
  const actual = hashFile(runsc, "sha256");
  if (actual !== pin.runsc.sha256) {
    throw new ProvenanceError(
      `The extracted gVisor runsc does not match the pinned SHA-256 (expected ${pin.runsc.sha256}, observed ${actual}).`,
    );
  }
  const versionOutput = run(runsc, ["--version"]);
  const version = /^runsc version\s+(\S+)/m.exec(versionOutput)?.[1];
  if (version !== pin.runsc.version) {
    throw new ProvenanceError(
      `The extracted gVisor runsc version does not match the pin (expected ${pin.runsc.version}, observed ${version ?? "unknown"}).`,
    );
  }
  return actual;
}

function digestOptions(parsed) {
  return { xattrs: parsed["require-xattrs"] === true ? "required" : "auto" };
}

function manifestFor(rootfs, source, extra, options) {
  const digest = digestRootfs(rootfs, options);
  return {
    schema_version: 2,
    rootfs_sha256: digest.sha256,
    content_sha256: digest.content_sha256,
    metadata_sha256: digest.metadata_sha256,
    timestamps_sha256: digest.timestamps_sha256,
    xattrs: digest.xattrs,
    entries: digest.entries,
    source,
    ...extra,
  };
}

function assertManifestMatches(expected, actual) {
  const mismatched = [];
  const compare = (name, expectedValue, actualValue) => {
    if (expectedValue !== undefined && expectedValue !== actualValue) {
      mismatched.push(`${name} expected ${String(expectedValue)}, observed ${String(actualValue)}`);
    }
  };
  compare("rootfs_sha256", expected.rootfs_sha256, actual.sha256);
  compare("entries", expected.entries, actual.entries);
  compare("content_sha256", expected.content_sha256, actual.content_sha256);
  compare("metadata_sha256", expected.metadata_sha256, actual.metadata_sha256);
  compare("timestamps_sha256", expected.timestamps_sha256, actual.timestamps_sha256);
  compare("xattrs", expected.xattrs, actual.xattrs);
  if (mismatched.length > 0) {
    throw new ProvenanceError(
      `The gVisor rootfs does not match its manifest (${mismatched.join("; ")}).`,
    );
  }
}

function writeManifest(path, manifest) {
  // Publish the manifest atomically so a crash cannot leave a truncated JSON file that a
  // later verification might misread.
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function describeRootfsDifference(first, second) {
  const result = spawnSync("diff", ["-rq", first, second], { encoding: "utf8" });
  const detail = (result.stdout || result.stderr || "").trim().split("\n").slice(0, 12).join(" | ");
  return detail.length === 0 ? "" : ` Differing paths: ${detail}`;
}

function stageRootfs(image, destination, options) {
  assertDestinationAbsent(destination);
  const parent = dirname(resolve(destination));
  const staging = createOwnedStagingDirectory(parent, `.gvisor-rootfs-${randomUUID()}-`);
  const dockerWorkspace = createOwnedStagingDirectory(tmpdir(), "aios-gvisor-export-");
  const archive = join(dockerWorkspace.path, "rootfs.tar");
  const name = `aios-gvisor-rootfs-${randomUUID()}`;
  let created = false;
  try {
    created = true;
    run("docker", ["create", "--name", name, image]);
    run("docker", ["export", "--output", archive, name]);
    // Ownership is normalized at extraction so an unprivileged drill never receives
    // root-owned setuid files. The manifest therefore attests the uid/gid of the tree the
    // runtime is actually handed, plus the preserved permission bits (including setuid).
    run("tar", ["-xf", archive, "-C", staging.path, "--no-same-owner"]);
    return { staging, digest: digestRootfs(staging.path, options) };
  } catch (error) {
    removeOwnedDirectory(staging);
    throw error;
  } finally {
    if (created) spawnSync("docker", ["rm", "--force", name], { encoding: "utf8" });
    rmSync(archive, { force: true });
    removeOwnedDirectory(dockerWorkspace);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = options(rest);

  if (command === "verify-archive") {
    const pinPath = required(parsed, "pin");
    const archive = resolve(required(parsed, "archive"));
    const loaded = readGvisorRuntimePin(pinPath);
    assertArchitecture(loaded.pin);
    const sha512 = verifyPinnedArtifact(archive, loaded.pin.artifact.sha512);
    process.stdout.write(
      `${JSON.stringify({
        release: loaded.pin.release,
        artifact: archive,
        artifact_sha512: sha512,
        pin_sha256: loaded.pin_sha256,
      })}\n`,
    );
    return;
  }

  if (command === "fetch-runtime") {
    const pinPath = required(parsed, "pin");
    const output = resolve(required(parsed, "output"));
    assertDestinationAbsent(output);
    const loaded = readGvisorRuntimePin(pinPath);
    assertArchitecture(loaded.pin);
    const staging = createOwnedStagingDirectory(
      dirname(output),
      `.gvisor-runtime-${randomUUID()}-`,
    );
    const downloadWorkspace = createOwnedStagingDirectory(tmpdir(), "aios-gvisor-download-");
    const archive = join(downloadWorkspace.path, "gvisor.tar.bz2");
    try {
      await download(loaded.pin.artifact.url, archive);
      const sha512 = verifyPinnedArtifact(archive, loaded.pin.artifact.sha512);
      extractRuntime(archive, staging.path);
      const binarySha256 = verifyRuntime(staging.path, loaded.pin);
      promoteOwnedDirectory(staging, output);
      process.stdout.write(
        `${JSON.stringify({
          release: loaded.pin.release,
          version: loaded.pin.runsc.version,
          artifact_sha512: sha512,
          binary_sha256: binarySha256,
          pin_sha256: loaded.pin_sha256,
          runsc: join(output, "runsc"),
        })}\n`,
      );
    } finally {
      removeOwnedDirectory(staging);
      removeOwnedDirectory(downloadWorkspace);
    }
    return;
  }

  if (command === "digest-rootfs") {
    const rootfs = resolve(required(parsed, "rootfs"));
    const source = readSource(parsed.source);
    const manifest = manifestFor(
      rootfs,
      source,
      {
        dockerfile_sha256:
          typeof source.dockerfile === "string"
            ? hashFile(resolve(source.dockerfile), "sha256")
            : undefined,
      },
      digestOptions(parsed),
    );
    if (manifest.dockerfile_sha256 === undefined) delete manifest.dockerfile_sha256;
    if (typeof parsed.manifest === "string") writeManifest(resolve(parsed.manifest), manifest);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }

  if (command === "verify-rootfs") {
    const rootfs = resolve(required(parsed, "rootfs"));
    const manifestPath = resolve(required(parsed, "manifest"));
    const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actual = digestRootfs(rootfs, digestOptions(parsed));
    assertManifestMatches(expected, actual);
    process.stdout.write(
      `${JSON.stringify({
        rootfs_sha256: actual.sha256,
        metadata_sha256: actual.metadata_sha256,
        entries: actual.entries,
        xattrs: actual.xattrs,
      })}\n`,
    );
    return;
  }

  if (command === "verify-rootfs-pin") {
    const sourcePath = resolve(required(parsed, "source"));
    const dockerfile = resolve(required(parsed, "dockerfile"));
    const loaded = readGvisorRootfsBuildPin(sourcePath);
    if (resolve(loaded.pin.dockerfile) !== dockerfile) {
      throw new ProvenanceError(
        `The gVisor rootfs build pin names ${loaded.pin.dockerfile}, not ${dockerfile}.`,
      );
    }
    verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile);
    process.stdout.write(
      `${JSON.stringify({
        base_image: `${loaded.pin.base_image.reference}@${loaded.pin.base_image.platform_digest_amd64}`,
        base_index_digest: loaded.pin.base_image.digest,
        apt_snapshot: loaded.pin.apt_snapshot,
        packages: loaded.pin.packages,
        pin_sha256: loaded.pin_sha256,
      })}\n`,
    );
    return;
  }

  if (command === "verify-platform-digest") {
    const sourcePath = resolve(required(parsed, "source"));
    const indexPath = resolve(required(parsed, "index"));
    const loaded = readGvisorRootfsBuildPin(sourcePath);
    let index;
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch (error) {
      throw new ProvenanceError(
        `The OCI image index is unreadable: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
    const selected = selectPlatformManifestDigest(index, "linux", "amd64");
    const pinned = loaded.pin.base_image.platform_digest_amd64;
    if (selected !== pinned) {
      throw new ProvenanceError(
        `The pinned platform digest is not the amd64 manifest of the pinned index (expected ${pinned}, index contains ${selected}).`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        reference: loaded.pin.base_image.reference,
        index_digest: loaded.pin.base_image.digest,
        platform_digest: selected,
        pin_sha256: loaded.pin_sha256,
      })}\n`,
    );
    return;
  }

  if (command === "build-rootfs") {
    const image = required(parsed, "image");
    const sourcePath = resolve(required(parsed, "source"));
    const dockerfile = resolve(required(parsed, "dockerfile"));
    const output = resolve(required(parsed, "output"));
    const manifestPath = resolve(required(parsed, "manifest"));
    const compareImage =
      typeof parsed["compare-image"] === "string" ? parsed["compare-image"] : undefined;
    if (parsed["compare-image"] !== undefined && compareImage === undefined) {
      throw new ProvenanceError("--compare-image requires an image name.");
    }
    if (compareImage === image) {
      throw new ProvenanceError("--compare-image must name a separate image build.");
    }
    assertDestinationAbsent(output);
    const loaded = readGvisorRootfsBuildPin(sourcePath);
    if (resolve(loaded.pin.dockerfile) !== dockerfile) {
      throw new ProvenanceError(
        `The gVisor rootfs build pin names ${loaded.pin.dockerfile}, not ${dockerfile}.`,
      );
    }
    verifyGvisorRootfsBuildInputs(loaded.pin, dockerfile);
    const source = { ...loaded.pin, rootfs_build_pin_sha256: loaded.pin_sha256 };
    const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", image]).trim();
    const xattrMode = digestOptions(parsed);
    const first = stageRootfs(image, output, xattrMode);
    const secondary = [];
    let reproducible = null;
    let rebuildImageId = null;
    try {
      if (parsed["verify-reproducible"] === true) {
        const second = stageRootfs(image, output, xattrMode);
        secondary.push(second.staging);
        // Two exports of one image are timestamp-stable, so mtime is asserted here too.
        assertReproducibleRootfs(
          first.digest,
          second.digest,
          describeRootfsDifference(first.staging.path, second.staging.path),
          { timestamps: true },
        );
        reproducible = {
          sha256: second.digest.sha256,
          entries: second.digest.entries,
          method: "same-image-second-export",
        };
      }
      if (compareImage !== undefined) {
        const second = stageRootfs(compareImage, output, xattrMode);
        secondary.push(second.staging);
        assertReproducibleRootfs(
          first.digest,
          second.digest,
          describeRootfsDifference(first.staging.path, second.staging.path),
        );
        rebuildImageId = run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          compareImage,
        ]).trim();
        reproducible = {
          sha256: second.digest.sha256,
          entries: second.digest.entries,
          method: "independent-image-build",
          image: compareImage,
          image_id: rebuildImageId,
        };
      }
      promoteOwnedDirectory(first.staging, output);
      const manifest = manifestFor(
        output,
        {
          ...source,
          image,
          image_id: imageId,
          rebuild_image: compareImage ?? null,
          rebuild_image_id: rebuildImageId,
          dockerfile,
          dockerfile_sha256: hashFile(dockerfile, "sha256"),
        },
        {
          ...(reproducible === null ? {} : { reproducible }),
        },
        xattrMode,
      );
      writeManifest(manifestPath, manifest);
      process.stdout.write(
        `${JSON.stringify({
          rootfs_sha256: manifest.rootfs_sha256,
          entries: manifest.entries,
          image,
          image_id: imageId,
          rebuild_image_id: rebuildImageId,
          reproducible,
          manifest: manifestPath,
        })}\n`,
      );
      return;
    } finally {
      for (const staging of secondary) removeOwnedDirectory(staging);
      removeOwnedDirectory(first.staging);
    }
  }

  throw new ProvenanceError(
    "Usage: gvisor-provenance.mjs <verify-archive|fetch-runtime|digest-rootfs|verify-rootfs|verify-rootfs-pin|verify-platform-digest|build-rootfs> [options]",
  );
}

main().catch((error) => {
  process.stderr.write(
    `gVisor provenance error: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
