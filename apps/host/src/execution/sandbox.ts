import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxProviderKind } from '../config.js';
import {
  HostUnavailableError,
  SandboxFilterUnavailableError,
  SandboxIsolationUnavailableError,
  SandboxResourceLimitUnavailableError,
} from '../errors.js';
import {
  assertMaterializedExecutableUnchanged,
  assertRootfsUnchanged,
  createOwnedStagingDirectory,
  digestRootfs,
  hashFile,
  materializeVerifiedRuntime,
  ProvenanceError,
  readGvisorRuntimePin,
  removeOwnedDirectory,
  resolveExecutable,
  type MaterializedExecutable,
  type OwnedDirectory,
} from './provenance.js';
import { runCapturedProcess, type CapturedProcessResult } from './process.js';
import {
  buildDockerSeccompProfile,
  buildSeccompProfile,
  type DockerSeccompProfile,
  type SeccompProfile,
} from './seccomp.js';

export type SandboxAssurance = 'container' | 'gvisor-user-space-kernel' | 'kernel-namespace' | 'seatbelt' | 'test-only-process';

/** Runtime identity measured before the boundary is advertised as available. */
export interface SandboxEngineEvidence {
  name: 'docker' | 'runsc';
  version: string;
  /** Null when the runtime did not expose enough information to classify the daemon. */
  rootless: boolean | null;
  /** Docker daemon security options, retained as the basis for the rootless classification. */
  security_options?: string[];
}

export interface SandboxProvenanceEvidence {
  runtime: {
    release: string;
    version: string;
    binary_sha256: string;
    artifact_sha512: string;
    pin_sha256: string;
  };
  rootfs: {
    sha256: string;
    entries: number;
    /** Manifest v2 ownership/mode/xattr digest. */
    metadata_sha256?: string;
    content_sha256?: string;
    timestamps_sha256?: string;
    xattrs?: 'captured' | 'unavailable';
    /** True only after the rootfs was re-measured identically following execution. */
    reverified_after_run?: boolean;
  };
}

export interface SandboxCheck {
  available: boolean;
  reason: string;
  /** True when the failure is specifically the system-call filter, not the namespace. */
  filterFailure?: boolean;
  /** True when the failure is specifically the resource limits. */
  resourceLimitFailure?: boolean;
  /** True when the selected boundary itself (for example the gVisor Sentry) is unavailable. */
  isolationFailure?: boolean;
  /** Measured runtime identity, present when the runtime could be queried. */
  engine?: SandboxEngineEvidence;
  /** Actual pinned runtime and measured rootfs identity, present only after verification. */
  provenance?: SandboxProvenanceEvidence;
}

export interface SandboxRunSpec {
  argv: string[];
  /** Absolute host path to the per-run workspace. */
  workspaceDirectory: string;
  /** Relative working directory inside the workspace, or undefined for its root. */
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
  /** Aborts the sandboxed work. Providers must kill the actual boundary process. */
  signal?: AbortSignal;
}

export interface SandboxFilterEvidence {
  profile: string;
  sha256: string;
  applied: boolean;
  reason?: string;
}

export interface SandboxResourceLimitEvidence {
  memory_bytes: number;
  cpu_seconds: number;
  processes: number;
  applied: boolean;
  /** The enforcement mechanism actually proven by the provider. */
  mechanism?: 'rlimit' | 'docker-cgroup' | 'gvisor-oci-rlimit';
  reason?: string;
}

/** Proof that the provider's actual isolation boundary, rather than a bare process, ran. */
export interface SandboxBoundaryEvidence {
  mechanism: 'gvisor-sentry';
  applied: boolean;
  version: string;
  rootless: boolean;
  reason?: string;
}

/** RLIMIT_AS applied to each sandboxed process; this is not an aggregate cgroup limit. */
export const BWRAP_MEMORY_MAX_BYTES = 1280 * 1024 * 1024;
/** RLIMIT_NPROC applied to the sandboxed UID. */
export const BWRAP_MAX_PROCESSES = 128;

/**
 * Docker's aggregate memory ceiling, with swap disabled by an equal memory-swap value.
 * The Docker CLI has no RLIMIT_AS (`--ulimit as` is rejected), so this cgroup limit is
 * the enforced memory boundary; bubblewrap retains its per-process RLIMIT_AS.
 */
export const DOCKER_MEMORY_BYTES = 512 * 1024 * 1024;
/** Docker's aggregate PID ceiling; the container cgroup counts every process. */
export const DOCKER_MAX_PROCESSES = 128;
/** Docker's aggregate CPU quota. The deadline-aligned RLIMIT_CPU is installed too. */
export const DOCKER_CPU_LIMIT = 1;
export const DOCKER_NANO_CPUS = DOCKER_CPU_LIMIT * 1_000_000_000;

/**
 * gVisor's OCI rlimits. The Sentry enforces these inside the sandbox; unlike Docker there
 * is no host cgroup for the workload, so the provider records the OCI mechanism separately.
 */
export const GVISOR_MEMORY_BYTES = 512 * 1024 * 1024;
export const GVISOR_MAX_PROCESSES = 128;

/** Repository-owned pin; a missing file makes the gVisor provider unavailable. */
const GVISOR_RUNTIME_PIN_PATH = fileURLToPath(
  new URL('../../../../tools/security/gvisor-runtime.pin.json', import.meta.url),
);

/** RLIMIT_CPU is aligned to the run's own deadline, in whole seconds. */
export function bubblewrapCpuSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

export interface SandboxResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
  provider: string;
  assurance: SandboxAssurance;
  /** Proof produced by the provider that its system-call filter was active before exec. */
  filter?: SandboxFilterEvidence;
  /** Proof that the per-run memory/CPU/process limits were installed before exec. */
  limits?: SandboxResourceLimitEvidence;
  /** Proof that the gVisor Sentry boundary was active, when gVisor is selected. */
  boundary?: SandboxBoundaryEvidence;
  /** Runtime version and rootless classification measured by the provider. */
  engine?: SandboxEngineEvidence;
  /** Pinned runtime and measured rootfs identity for this invocation. */
  provenance?: SandboxProvenanceEvidence;
}

/**
 * An isolation boundary for one command invocation.
 *
 * A provider is not a generic process runner: every implementation must establish
 * its boundary before spawning the requested argv, and `check()` must fail closed
 * when the host tooling or kernel support is missing.
 */
export interface SandboxProvider {
  readonly id: string;
  readonly assurance: SandboxAssurance;
  check(): Promise<SandboxCheck>;
  run(spec: SandboxRunSpec): Promise<SandboxResult>;
}

interface ProviderRunOptions {
  id: string;
  assurance: SandboxAssurance;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  extraFds?: number[];
}

async function spawnProvider(
  command: string,
  args: string[],
  options: ProviderRunOptions,
): Promise<SandboxResult> {
  const result = await runCapturedProcess(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...options.env },
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.extraFds === undefined ? {} : { extraFds: options.extraFds }),
  });
  return { ...result, provider: options.id, assurance: options.assurance };
}

function assertWorkspace(workspaceDirectory: string): string {
  if (!isAbsolute(workspaceDirectory)) {
    throw new HostUnavailableError('A sandbox workspace must be an absolute path.');
  }
  return resolve(workspaceDirectory);
}

interface DockerInspect {
  Config?: { User?: string };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    NetworkMode?: string;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number | null;
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    Ulimits?: Array<{ Name?: string; Soft?: number; Hard?: number }>;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  State?: { ExitCode?: number; Running?: boolean };
}

function gvisorWorkdir(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return '/workspace';
  if (isAbsolute(cwd) || cwd.includes('\0') || cwd.includes('\\')) {
    throw new HostUnavailableError('gVisor cwd must be a relative POSIX path inside the workspace.');
  }
  if (cwd.split('/').includes('..')) {
    throw new HostUnavailableError('gVisor cwd must stay inside the run workspace.');
  }
  return `/workspace/${cwd}`;
}

function dockerWorkdir(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return '/workspace';
  if (isAbsolute(cwd) || cwd.includes('\0') || cwd.includes('\\')) {
    throw new HostUnavailableError('Docker cwd must be a relative POSIX path inside the workspace.');
  }
  if (cwd.split('/').includes('..')) {
    throw new HostUnavailableError('Docker cwd must stay inside the run workspace.');
  }
  return `/workspace/${cwd}`;
}

class DockerSandbox implements SandboxProvider {
  readonly id = 'docker';
  readonly assurance = 'container' as const;
  private engine: SandboxEngineEvidence | undefined;

  constructor(private readonly image: string) {}

  async check(): Promise<SandboxCheck> {
    const info = await this.docker(['info', '--format', '{{json .}}'], 5_000, 64 * 1024);
    if (info.spawnError) {
      return { available: false, reason: 'The Docker CLI is not installed or not on PATH.' };
    }
    if (info.exitCode !== 0) {
      return {
        available: false,
        reason: `The Docker daemon is not reachable: ${DockerSandbox.detail(info)}`,
      };
    }
    let daemon: { ServerVersion?: unknown; SecurityOptions?: unknown };
    try {
      daemon = JSON.parse(info.stdout.toString('utf8')) as { ServerVersion?: unknown; SecurityOptions?: unknown };
    } catch {
      return { available: false, reason: 'The Docker daemon did not return parseable runtime information.' };
    }
    const version = typeof daemon.ServerVersion === 'string' && daemon.ServerVersion.length > 0
      ? daemon.ServerVersion
      : undefined;
    if (version === undefined) {
      return { available: false, reason: 'The Docker daemon did not report its server version.' };
    }
    const securityOptions = Array.isArray(daemon.SecurityOptions)
      ? daemon.SecurityOptions.filter((entry): entry is string => typeof entry === 'string')
      : [];
    this.engine = {
      name: 'docker',
      version,
      // Docker reports `name=rootless` in SecurityOptions for a rootless daemon. If the
      // list is absent, do not guess a mode; report unknown rather than claiming rootful.
      rootless: securityOptions.length === 0
        ? null
        : securityOptions.some((entry) => /rootless/i.test(entry)),
      security_options: securityOptions,
    };
    const inspected = await this.docker(
      ['image', 'inspect', this.image, '--format', '{{.Id}}'],
      10_000,
      1024,
    );
    if (inspected.spawnError || inspected.exitCode !== 0) {
      return {
        available: false,
        reason: `The configured sandbox image "${this.image}" is not present locally; the host does not pull images implicitly.`,
      };
    }

    // Daemon and image presence are not enough: cgroup, seccomp, mount, or namespace
    // support may still be missing. Start the same boundary once with a harmless probe.
    const directory = mkdtempSync(join(tmpdir(), 'aios-docker-probe-'));
    try {
      const probe = await this.run({
        argv: ['/bin/true'],
        workspaceDirectory: directory,
        cwd: '.',
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
        env: {},
      });
      if (probe.spawnError !== undefined || probe.exitCode !== 0) {
        return { available: false, reason: 'The Docker sandbox probe did not complete successfully.' };
      }
      if (probe.filter?.applied !== true) {
        return {
          available: false,
          filterFailure: true,
          reason: `The custom seccomp profile was not proven active: ${probe.filter?.reason ?? 'no filter evidence'}`,
        };
      }
      if (probe.limits?.applied !== true) {
        return {
          available: false,
          resourceLimitFailure: true,
          reason: `The Docker isolation limits were not proven active: ${probe.limits?.reason ?? 'no limit evidence'}`,
        };
      }
      return {
        available: true,
        reason: 'Docker passed its container, seccomp and resource-limit probe.',
        engine: this.engine,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return {
        available: false,
        ...(error instanceof SandboxFilterUnavailableError ? { filterFailure: true } : {}),
        ...(error instanceof SandboxResourceLimitUnavailableError ? { resourceLimitFailure: true } : {}),
        reason: `The Docker sandbox probe failed: ${message}`,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    const workspace = assertWorkspace(spec.workspaceDirectory);
    if (workspace.includes(',') || workspace.includes('\n') || workspace.includes('\r')) {
      throw new HostUnavailableError('The Docker workspace path contains an unsupported delimiter.');
    }
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new HostUnavailableError('A Docker sandbox command must have a non-empty argv.');
    }
    const workdir = dockerWorkdir(spec.cwd);
    const cpuSeconds = bubblewrapCpuSeconds(spec.timeoutMs);
    const profile = buildDockerSeccompProfile();
    const profileDirectory = mkdtempSync(join(tmpdir(), 'aios-docker-seccomp-'));
    const profilePath = join(profileDirectory, 'profile.json');
    writeFileSync(profilePath, profile.profile, { mode: 0o600 });
    const containerName = `aios-${randomUUID()}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    const user = uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
    const args = [
      'create',
      '--name', containerName,
      '--init',
      '--network=none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--security-opt', `seccomp=${profilePath}`,
      '--pids-limit', String(DOCKER_MAX_PROCESSES),
      '--memory', String(DOCKER_MEMORY_BYTES),
      '--memory-swap', String(DOCKER_MEMORY_BYTES),
      '--cpus', String(DOCKER_CPU_LIMIT),
      '--ulimit', `cpu=${cpuSeconds}:${cpuSeconds}`,
      // Read-write is the default; Docker rejects a bare `rw` mount field.
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      '--workdir', workdir,
      ...(user === undefined ? [] : ['--user', user]),
      '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--entrypoint', spec.argv[0],
      this.image,
      ...spec.argv.slice(1),
    ];
    let created = false;
    const killContainer = () => {
      if (!created) return;
      void this.docker(['kill', containerName], 5_000, 1024);
    };
    const onAbort = () => killContainer();
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const creation = await this.docker(args, 15_000, 4096);
      if (creation.spawnError !== undefined) {
        throw new HostUnavailableError(`The Docker CLI could not start: ${creation.spawnError}`);
      }
      if (creation.exitCode !== 0) {
        throw new HostUnavailableError(`The Docker container could not be created: ${DockerSandbox.detail(creation)}`);
      }
      created = true;

      // Inspect before execution. These are daemon-reported controls, not workload
      // self-report: read-only root, no network, dropped capabilities, no-new-privileges,
      // cgroup memory/PID/CPU limits, per-process rlimits, workspace mount, and non-root UID.
      const before = await this.inspect(containerName);
      const controls = this.controlEvidence(before, workspace, profile, cpuSeconds, user);
      if (!controls.filter.applied) {
        throw new SandboxFilterUnavailableError(
          `The Docker seccomp profile was not active: ${controls.filter.reason ?? 'no filter evidence'}.`,
        );
      }
      if (!controls.limits.applied) {
        throw new SandboxResourceLimitUnavailableError(
          `The Docker resource limits were not active: ${controls.limits.reason ?? 'no limit evidence'}.`,
        );
      }

      const started = await spawnProvider('docker', ['start', '--attach', containerName], {
        id: this.id,
        assurance: this.assurance,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        env: {},
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      });
      let exitCode = started.exitCode;
      if (!started.timedOut && !started.cancelled && started.spawnError === undefined) {
        const after = await this.inspect(containerName);
        if (after.State?.ExitCode !== undefined) exitCode = after.State.ExitCode;
      }
      return {
        ...started,
        exitCode,
        filter: controls.filter,
        limits: controls.limits,
        ...(this.engine === undefined ? {} : { engine: this.engine }),
      };
    } finally {
      spec.signal?.removeEventListener('abort', onAbort);
      if (created) {
        // The CLI dying does not stop the container. Remove it explicitly for normal
        // exits, timeouts, cancellation, quota aborts, and provider errors.
        await this.docker(['kill', containerName], 5_000, 1024);
        await this.docker(['rm', '--force', containerName], 5_000, 1024);
      }
      rmSync(profileDirectory, { recursive: true, force: true });
    }
  }

  private async inspect(containerName: string): Promise<DockerInspect> {
    const result = await this.docker(
      ['inspect', '--format', '{{json .}}', containerName],
      10_000,
      256 * 1024,
    );
    if (result.spawnError !== undefined || result.exitCode !== 0) {
      throw new HostUnavailableError(`The Docker container could not be inspected: ${DockerSandbox.detail(result)}`);
    }
    try {
      return JSON.parse(result.stdout.toString('utf8')) as DockerInspect;
    } catch {
      throw new HostUnavailableError('The Docker inspect output was not valid JSON.');
    }
  }

  private controlEvidence(
    inspected: DockerInspect,
    workspace: string,
    profile: DockerSeccompProfile,
    cpuSeconds: number,
    user: string | undefined,
  ): { filter: SandboxFilterEvidence; limits: SandboxResourceLimitEvidence } {
    const host = inspected.HostConfig ?? {};
    const security = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
    const capDrop = Array.isArray(host.CapDrop) ? host.CapDrop : [];
    const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
    const hasUlimit = (name: string, value: number): boolean => ulimits.some(
      (entry) => entry.Name === name && entry.Soft === value && entry.Hard === value,
    );
    const mount = (inspected.Mounts ?? []).find((entry) => entry.Destination === '/workspace');
    // Docker reports that a non-default seccomp profile is configured, but it does
    // not expose the client-side source path or its digest. The daemon is trusted
    // for that report; profile.sha256 binds the generated JSON in executor evidence.
    const seccompApplied = security.some(
      (entry) => entry.startsWith('seccomp=') && entry !== 'seccomp=unconfined',
    );
    const checks: Array<[string, boolean]> = [
      ['read-only root filesystem', host.ReadonlyRootfs === true],
      ['network none', host.NetworkMode === 'none'],
      ['all capabilities dropped', capDrop.includes('ALL')],
      ['no-new-privileges', security.some((entry) => entry.startsWith('no-new-privileges'))],
      ['PID limit', host.PidsLimit === DOCKER_MAX_PROCESSES],
      ['memory limit', host.Memory === DOCKER_MEMORY_BYTES],
      ['swap disabled', host.MemorySwap === DOCKER_MEMORY_BYTES],
      ['CPU quota', host.NanoCpus === DOCKER_NANO_CPUS],
      ['CPU rlimit', hasUlimit('cpu', cpuSeconds)],
      [
        'workspace only mount',
        mount !== undefined
          && mount.Type === 'bind'
          && mount.RW === true
          && mount.Source !== undefined
          && resolve(mount.Source) === resolve(workspace),
      ],
      ...(user === undefined ? [] : [['non-root user', inspected.Config?.User === user] as [string, boolean]]),
    ];
    const missing = checks.filter(([, applied]) => !applied).map(([name]) => name);
    return {
      filter: {
        profile: profile.profile,
        sha256: profile.sha256,
        applied: seccompApplied,
        ...(seccompApplied ? {} : { reason: 'a non-default seccomp profile is absent from HostConfig.SecurityOpt' }),
      },
      limits: {
        memory_bytes: DOCKER_MEMORY_BYTES,
        cpu_seconds: cpuSeconds,
        processes: DOCKER_MAX_PROCESSES,
        applied: missing.length === 0,
        mechanism: 'docker-cgroup',
        ...(missing.length === 0 ? {} : { reason: `missing or mismatched controls: ${missing.join(', ')}` }),
      },
    };
  }

  private async docker(
    args: string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<CapturedProcessResult> {
    return runCapturedProcess('docker', args, {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      timeoutMs,
      maxOutputBytes,
    });
  }

  private static detail(result: CapturedProcessResult): string {
    const line = result.stderr.toString('utf8').trim().split('\n')[0] ?? '';
    return (line.length > 0 ? line : `exit ${result.exitCode ?? 'unknown'}`).slice(0, 240);
  }
}

/**
 * Bubblewrap user namespaces, no network, read-only host system, writable workspace.
 *
 * This is a kernel-namespace boundary, not a container: there is no cgroup memory/CPU
 * accounting. Every invocation installs per-process RLIMIT_AS, RLIMIT_CPU and RLIMIT_NPROC
 * and a generated seccomp deny-list before exec; if either cannot be installed the run is
 * denied rather than executed without the filter or limits.
 */
class BubblewrapSandbox implements SandboxProvider {
  readonly id = 'bubblewrap';
  readonly assurance = 'kernel-namespace' as const;

  async check(): Promise<SandboxCheck> {
    if (process.platform !== 'linux') {
      return { available: false, reason: 'bubblewrap is only available on Linux.' };
    }
    const version = await runCapturedProcess(
      'bwrap',
      ['--version'],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    if (version.spawnError || version.exitCode !== 0) {
      return { available: false, reason: 'bubblewrap is not installed or cannot run on this host.' };
    }
    if (!existsSync('/usr/bin/prlimit')) {
      return {
        available: false,
        resourceLimitFailure: true,
        reason: 'prlimit is not installed at /usr/bin/prlimit, so per-run resource limits cannot be proven.',
      };
    }
    let probe: SandboxResult;
    try {
      probe = await this.invoke(['/bin/true'], undefined, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
    } catch (error) {
      return {
        available: false,
        filterFailure: true,
        reason: `The system-call filter cannot be installed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
    if (probe.filter?.applied !== true) {
      return {
        available: false,
        filterFailure: true,
        reason: `The system-call filter was not active for the probe: ${probe.filter?.reason ?? 'no filter evidence'}`,
      };
    }
    if (probe.limits?.applied !== true) {
      return {
        available: false,
        resourceLimitFailure: true,
        reason: `The per-run resource limits were not active for the probe: ${probe.limits?.reason ?? 'no resource-limit evidence'}`,
      };
    }
    if (probe.exitCode !== 0) {
      return { available: false, reason: 'bubblewrap cannot create the required user namespace on this host.' };
    }
    return { available: true, reason: 'bubblewrap passed its namespace, seccomp-filter and resource-limit probes.' };
  }

  private seccompProfile(): SeccompProfile {
    try {
      return buildSeccompProfile();
    } catch (error) {
      throw new SandboxFilterUnavailableError(
        `The system-call filter could not be generated: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async invoke(
    argv: string[],
    cwd: string | undefined,
    _pathForProbe: string,
    workspace?: string,
    timeoutMs = 5_000,
    maxOutputBytes = 1024,
    env: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const profile = this.seccompProfile();
    const cpuSeconds = bubblewrapCpuSeconds(timeoutMs);
    const filterDirectory = mkdtempSync(join(tmpdir(), 'aios-seccomp-'));
    const filterPath = join(filterDirectory, 'filter.bpf');
    const markerPath = join(filterDirectory, 'applied');
    writeFileSync(filterPath, profile.filter, { mode: 0o600 });
    writeFileSync(markerPath, '', { mode: 0o600 });
    const filterFd = openSync(filterPath, 'r');
    const markerFd = openSync(markerPath, 'r+');
    const binds = ['/usr', '/bin', '/lib', '/lib64', '/etc']
      .filter((path) => existsSync(path))
      .flatMap((path) => ['--ro-bind', path, path]);
    // bwrap installs the filter, then invokes the trusted host prlimit binary with
    // inherited per-process address-space, CPU and process ceilings. prlimit execs this
    // fixed wrapper only after all three limits are installed. The wrapper validates
    // the kernel's Seccomp mode and the exact /proc/self/limits values, records both
    // proofs on fd 4, closes the inherited descriptors, and execs the requested argv
    // without a shell string. A missing marker means bwrap never reached the wrapped
    // command, so the host refuses to treat the invocation as filtered or limited.
    const wrapper = [
      'seccomp=missing',
      'limits=missing',
      'while read -r key value; do',
      '  if [ "$key" = "Seccomp:" ] && [ "$value" = "2" ]; then seccomp=applied; break; fi',
      'done < /proc/self/status',
      `if [ "$seccomp" = applied ] && grep -q '^Max address space[[:space:]]*${BWRAP_MEMORY_MAX_BYTES}[[:space:]]*${BWRAP_MEMORY_MAX_BYTES}' /proc/self/limits && grep -q '^Max cpu time[[:space:]]*${cpuSeconds}[[:space:]]*${cpuSeconds}' /proc/self/limits && grep -q '^Max processes[[:space:]]*${BWRAP_MAX_PROCESSES}[[:space:]]*${BWRAP_MAX_PROCESSES}' /proc/self/limits; then limits=applied; fi`,
      'printf "seccomp=%s limits=%s" "$seccomp" "$limits" >&4',
      'exec 3>&- 4>&-',
      '[ "$seccomp" = applied ] || exit 126',
      '[ "$limits" = applied ] || exit 125',
      'exec "$@"',
    ].join('\n');
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--cap-drop', 'ALL',
      '--seccomp', '3',
      ...binds,
      '--proc', '/proc',
      '--dev', '/dev',
      '--size', '67108864',
      '--tmpfs', '/tmp',
      ...(workspace === undefined
        ? ['--ro-bind', '/', '/']
        : ['--bind', workspace, '/workspace', '--chdir', cwd ? `/workspace/${cwd}` : '/workspace']),
      '--clearenv',
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]),
      '--',
      '/usr/bin/prlimit',
      `--as=${BWRAP_MEMORY_MAX_BYTES}`,
      `--cpu=${cpuSeconds}`,
      `--nproc=${BWRAP_MAX_PROCESSES}`,
      '--',
      '/bin/sh', '-c', wrapper, 'aios-filter',
      ...argv,
    ];
    try {
      const result = await spawnProvider('bwrap', args, {
        id: this.id,
        assurance: this.assurance,
        timeoutMs,
        maxOutputBytes,
        env: {},
        ...(signal === undefined ? {} : { signal }),
        extraFds: [filterFd, markerFd],
      });
      let marker = '';
      try {
        marker = readFileSync(markerPath, 'utf8').trim();
      } catch {
        // A missing marker is treated as a failed filter installation below.
      }
      const seccompApplied = /(?:^|\s)seccomp=applied(?:\s|$)/.test(marker);
      const limitsApplied = /(?:^|\s)limits=applied(?:\s|$)/.test(marker);
      return {
        ...result,
        filter: {
          profile: profile.profile,
          sha256: profile.sha256,
          applied: seccompApplied,
          ...(seccompApplied ? {} : { reason: marker.length > 0 ? `filter marker was "${marker}"` : 'filter marker was not written' }),
        },
        limits: {
          memory_bytes: BWRAP_MEMORY_MAX_BYTES,
          cpu_seconds: cpuSeconds,
          processes: BWRAP_MAX_PROCESSES,
          applied: limitsApplied,
          mechanism: 'rlimit',
          ...(limitsApplied ? {} : { reason: marker.length > 0 ? `resource-limit marker was "${marker}"` : 'resource-limit marker was not written' }),
        },
      };
    } finally {
      closeSync(filterFd);
      closeSync(markerFd);
      rmSync(filterDirectory, { recursive: true, force: true });
    }
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    return this.invoke(
      spec.argv,
      spec.cwd,
      process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      assertWorkspace(spec.workspaceDirectory),
      spec.timeoutMs,
      spec.maxOutputBytes,
      spec.env,
      spec.signal,
    );
  }
}

interface VerifiedGvisorRuntime {
  provenance: SandboxProvenanceEvidence;
  executable: MaterializedExecutable;
  directory: OwnedDirectory;
}

/**
 * gVisor through its OCI runtime `runsc`.
 *
 * The workload runs under gVisor's user-space Sentry, not on the host kernel. The provider
 * generates a controlled OCI bundle: a read-only configured rootfs, one writable workspace
 * bind, private PID/network/IPC/UTS/mount namespaces, no capabilities, no-new-privileges, and
 * OCI rlimits for address space, CPU, processes and file descriptors. `--rootless` keeps the
 * runtime and gofer outside root and maps only the caller's UID into the sandbox.
 *
 * `runsc do` is deliberately not used: it mounts the host rootfs read-only and is documented
 * as a test convenience. The gVisor evidence therefore records the actual Sentry launch and
 * the generated OCI controls, not workload self-report.
 */
class GvisorSandbox implements SandboxProvider {
  readonly id = 'gvisor';
  readonly assurance = 'gvisor-user-space-kernel' as const;
  private engine: SandboxEngineEvidence | undefined;
  private provenance: SandboxProvenanceEvidence | undefined;

  constructor(
    private readonly rootfs: string,
    private readonly pinPath: string = GVISOR_RUNTIME_PIN_PATH,
  ) {}

  async check(): Promise<SandboxCheck> {
    if (process.platform !== 'linux') {
      return { available: false, reason: 'gVisor runsc is only available on Linux.' };
    }
    let provenance: SandboxProvenanceEvidence;
    let verified: VerifiedGvisorRuntime | undefined;
    try {
      verified = await this.verifyProvenance();
      provenance = verified.provenance;
    } catch (error) {
      return {
        available: false,
        isolationFailure: true,
        reason: `gVisor runtime provenance failed closed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
    this.provenance = provenance;
    this.engine = { name: 'runsc', version: provenance.runtime.version, rootless: true };

    const directory = mkdtempSync(join(tmpdir(), 'aios-gvisor-probe-'));
    try {
      const probe = await this.run({
        argv: ['/bin/true'],
        workspaceDirectory: directory,
        cwd: '.',
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        env: {},
      });
      if (probe.spawnError !== undefined || probe.exitCode !== 0 || probe.boundary?.applied !== true) {
        return {
          available: false,
          isolationFailure: true,
          reason: `The gVisor OCI probe did not complete under the Sentry: ${probe.boundary?.reason ?? probe.spawnError ?? 'no boundary evidence'}`,
        };
      }
      if (probe.limits?.applied !== true) {
        return {
          available: false,
          resourceLimitFailure: true,
          reason: `The gVisor resource limits were not proven active: ${probe.limits?.reason ?? 'no limit evidence'}`,
        };
      }
      return {
        available: true,
        reason: 'gVisor runsc passed its pinned-runtime, canonical-rootfs, Sentry, network and rlimit probe.',
        engine: this.engine,
        provenance,
      };
    } catch (error) {
      return {
        available: false,
        isolationFailure: true,
        reason: `The gVisor OCI probe failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (verified !== undefined) removeOwnedDirectory(verified.directory);
    }
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    let verified: VerifiedGvisorRuntime;
    try {
      // Re-verify on every invocation. A pin or runtime changed after `check()` must not
      // inherit the earlier availability result, and a different PATH candidate must not
      // silently replace the binary whose digest was advertised.
      verified = await this.verifyProvenance();
    } catch (error) {
      throw new SandboxIsolationUnavailableError(
        `The gVisor runtime provenance could not be verified: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    try {
      return await this.executeVerified(spec, verified);
    } finally {
      // The measured copy is used for this invocation only; the next invocation measures a
      // fresh copy rather than trusting an on-disk cache.
      removeOwnedDirectory(verified.directory);
    }
  }

  private async executeVerified(
    spec: SandboxRunSpec,
    verified: VerifiedGvisorRuntime,
  ): Promise<SandboxResult> {
    const provenance = verified.provenance;
    this.provenance = provenance;
    this.engine = { name: 'runsc', version: provenance.runtime.version, rootless: true };
    const rootfs = this.rootfsPath();
    const workspace = assertWorkspace(spec.workspaceDirectory);
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new HostUnavailableError('A gVisor sandbox command must have a non-empty argv.');
    }
    const workdir = gvisorWorkdir(spec.cwd);
    const cpuSeconds = bubblewrapCpuSeconds(spec.timeoutMs);
    const bundleDirectory = mkdtempSync(join(tmpdir(), 'aios-gvisor-bundle-'));
    const stateDirectory = mkdtempSync(join(tmpdir(), 'aios-gvisor-state-'));
    const containerName = `aios-${randomUUID()}`;
    const config = {
      ociVersion: '1.0.0',
      process: {
        user: { uid: 0, gid: 0 },
        args: spec.argv,
        env: [
          'PATH=/usr/local/bin:/usr/bin:/bin',
          'HOME=/tmp',
          'TMPDIR=/tmp',
          ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        ],
        cwd: workdir,
        capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] },
        noNewPrivileges: true,
        rlimits: [
          { type: 'RLIMIT_CPU', soft: cpuSeconds, hard: cpuSeconds },
          { type: 'RLIMIT_AS', soft: GVISOR_MEMORY_BYTES, hard: GVISOR_MEMORY_BYTES },
          { type: 'RLIMIT_NPROC', soft: GVISOR_MAX_PROCESSES, hard: GVISOR_MAX_PROCESSES },
          { type: 'RLIMIT_NOFILE', soft: 1024, hard: 1024 },
        ],
      },
      root: { path: rootfs, readonly: true },
      hostname: 'aios-gvisor',
      mounts: [
        {
          destination: '/workspace',
          type: 'bind',
          source: workspace,
          options: ['rbind', 'rw', 'nosuid', 'nodev'],
        },
        { destination: '/proc', type: 'proc', source: 'proc', options: ['nosuid', 'noexec', 'nodev'] },
        { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
        { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'size=64m'] },
        { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
      ],
      linux: {
        namespaces: [
          { type: 'pid' },
          { type: 'network' },
          { type: 'ipc' },
          { type: 'uts' },
          { type: 'mount' },
        ],
        maskedPaths: ['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/sched_debug', '/sys/firmware'],
        readonlyPaths: ['/proc/sys', '/proc/sysrq-trigger', '/proc/irq', '/proc/bus'],
      },
    };
    writeFileSync(join(bundleDirectory, 'config.json'), JSON.stringify(config), { mode: 0o600 });

    try {
      const result = await runCapturedProcess(
        verified.executable.path,
        [
          '--root', stateDirectory,
          '--rootless',
          '--network=none',
          'run',
          '--bundle', bundleDirectory,
          containerName,
        ],
        {
          env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
          timeoutMs: spec.timeoutMs,
          maxOutputBytes: spec.maxOutputBytes,
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
        },
      );
      // Bind the result to the artifact whose digest was attested: if the rootfs changed
      // while the sandbox ran, the outcome cannot be attributed to the verified tree.
      try {
        assertRootfsUnchanged(provenance.rootfs, digestRootfs(rootfs));
      } catch (error) {
        throw new SandboxIsolationUnavailableError(
          `The gVisor rootfs could not be re-verified after execution: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      const stderr = result.stderr.toString('utf8');
      const runtimeFailure = /^(?:running|creating|starting) container:/m.test(stderr)
        || /^runsc:/m.test(stderr);
      const boundaryApplied = result.spawnError === undefined && !runtimeFailure;
      const reason = boundaryApplied
        ? undefined
        : GvisorSandbox.firstLine(stderr) || result.spawnError || 'runsc did not start the sandbox';
      return {
        ...result,
        provider: this.id,
        assurance: this.assurance,
        ...(this.engine === undefined ? {} : { engine: this.engine }),
        provenance: {
          ...provenance,
          rootfs: { ...provenance.rootfs, reverified_after_run: true },
        },
        boundary: {
          mechanism: 'gvisor-sentry',
          applied: boundaryApplied,
          version: this.engine?.version ?? 'unknown',
          rootless: true,
          ...(reason === undefined ? {} : { reason }),
        },
        limits: {
          memory_bytes: GVISOR_MEMORY_BYTES,
          cpu_seconds: cpuSeconds,
          processes: GVISOR_MAX_PROCESSES,
          applied: boundaryApplied,
          mechanism: 'gvisor-oci-rlimit',
          ...(reason === undefined ? {} : { reason }),
        },
      };
    } finally {
      // A killed `runsc run` client does not by itself prove the sandbox is gone. Delete the
      // named sandbox from its private state directory on every exit path, then remove the
      // generated bundle and state. Errors here are ignored only after both attempts.
      await this.cleanup(verified.executable.path, stateDirectory, containerName);
      rmSync(bundleDirectory, { recursive: true, force: true });
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  }

  private async cleanup(executable: string, stateDirectory: string, containerName: string): Promise<void> {
    const runsc = executable;
    await runCapturedProcess(
      runsc,
      ['--root', stateDirectory, 'kill', '--all', containerName],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 2_000, maxOutputBytes: 1024 },
    );
    await runCapturedProcess(
      runsc,
      ['--root', stateDirectory, 'delete', '--force', containerName],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 2_000, maxOutputBytes: 1024 },
    );
  }

  private rootfsPath(): string {
    if (!isAbsolute(this.rootfs)) {
      throw new HostUnavailableError('The gVisor rootfs must be an absolute path.');
    }
    const resolved = resolve(this.rootfs);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(resolved);
    } catch {
      throw new HostUnavailableError('The configured gVisor rootfs does not exist.');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HostUnavailableError('The configured gVisor rootfs must be a real directory, not a symlink.');
    }
    if (resolved === '/') {
      throw new HostUnavailableError('The gVisor rootfs must not be the host root filesystem.');
    }
    return resolved;
  }

  private async verifyProvenance(): Promise<VerifiedGvisorRuntime> {
    const rootfs = this.rootfsPath();
    const loaded = readGvisorRuntimePin(this.pinPath);
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    if (loaded.pin.architecture !== architecture) {
      throw new ProvenanceError(
        `The gVisor runtime pin is for ${loaded.pin.architecture}, but this host is ${architecture}.`,
      );
    }
    const resolved = resolveExecutable('runsc');
    const binarySha256 = hashFile(resolved, 'sha256');
    if (binarySha256 !== loaded.pin.runsc.sha256) {
      throw new ProvenanceError(
        `The gVisor runsc SHA-256 does not match the repository pin (expected ${loaded.pin.runsc.sha256}, observed ${binarySha256}).`,
      );
    }
    const directory = createOwnedStagingDirectory(tmpdir(), 'aios-gvisor-runtime-');
    try {
      // Execute a private copy of the measured runtime tree, not the PATH-resolved original.
      // A rename over the original between hashing and execution cannot affect this copy, and
      // runsc finds its Sentry sidecars relative to the copied binary.
      const runtime = materializeVerifiedRuntime(dirname(resolved), binarySha256, directory);
      const executable = runtime.executable;
      const version = await this.runscVersion(executable.path);
      if (version === undefined) {
        throw new ProvenanceError('The pinned gVisor runsc did not report its version.');
      }
      if (version !== loaded.pin.runsc.version) {
        throw new ProvenanceError(
          `The gVisor runsc version does not match the repository pin (expected ${loaded.pin.runsc.version}, observed ${version}).`,
        );
      }
      assertMaterializedExecutableUnchanged(executable);
      return {
        directory,
        executable,
        provenance: {
          runtime: {
            release: loaded.pin.release,
            version,
            binary_sha256: binarySha256,
            artifact_sha512: loaded.pin.artifact.sha512,
            pin_sha256: loaded.pin_sha256,
          },
          rootfs: digestRootfs(rootfs),
        },
      };
    } catch (error) {
      removeOwnedDirectory(directory);
      throw error;
    }
  }

  private async runscVersion(executable: string): Promise<string | undefined> {
    const result = await runCapturedProcess(
      executable,
      ['--version'],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    if (result.spawnError !== undefined || result.exitCode !== 0) return undefined;
    const output = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
    return /^runsc version\s+(\S+)/m.exec(output)?.[1];
  }

  private static firstLine(value: string): string {
    return (value.trim().split('\n')[0] ?? '').slice(0, 240);
  }
}

/**
 * macOS Seatbelt via `sandbox-exec`.
 *
 * Apple deprecates the tool but ships it on current macOS. This profile denies
 * network, process spawning outside the requested program, and writes outside the
 * workspace/temp directories. It is an OS sandbox, not a VM boundary.
 */
class SeatbeltSandbox implements SandboxProvider {
  readonly id = 'seatbelt';
  readonly assurance = 'seatbelt' as const;

  async check(): Promise<SandboxCheck> {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'Seatbelt is only available on macOS.' };
    }
    const probe = await runCapturedProcess(
      'sandbox-exec',
      ['-p', '(version 1)(deny default)(allow process-exec)(allow process-fork)', '/usr/bin/true'],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    if (probe.spawnError || probe.exitCode !== 0) {
      return { available: false, reason: 'sandbox-exec is unavailable or cannot apply a profile on this host.' };
    }
    return { available: true, reason: 'sandbox-exec passed its profile probe.' };
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    const workspace = assertWorkspace(spec.workspaceDirectory);
    const cwd = resolve(workspace, spec.cwd ?? '.');
    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow sysctl-read)',
      '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/dev") (subpath "/tmp"))',
      `(allow file-read* file-write* (subpath "${workspace.replaceAll('"', '')}"))`,
      '(allow file-write* (subpath "/tmp"))',
      '(deny network*)',
    ].join('\n');
    const args = ['-p', profile, ...spec.argv];
    return spawnProvider('sandbox-exec', args, {
      id: this.id,
      assurance: this.assurance,
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      env: { ...spec.env, HOME: '/tmp', TMPDIR: '/tmp' },
      cwd,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    });
  }
}

export function createSandboxProvider(config: {
  provider: SandboxProviderKind;
  image?: string;
  rootfs?: string;
  /** Test-only pin override; production resolves the repository pin. */
  gvisorPinPath?: string;
}): SandboxProvider {
  if (config.provider === 'docker') {
    if (!config.image) throw new HostUnavailableError('The Docker sandbox requires a configured image.');
    return new DockerSandbox(config.image);
  }
  if (config.provider === 'gvisor') {
    if (!config.rootfs) throw new HostUnavailableError('The gVisor sandbox requires a configured rootfs.');
    return new GvisorSandbox(config.rootfs, config.gvisorPinPath);
  }
  if (config.provider === 'bubblewrap') return new BubblewrapSandbox();
  if (config.provider === 'seatbelt') return new SeatbeltSandbox();

  // Auto prefers an explicitly configured container boundary, then the strongest
  // platform-native boundary. It never pulls or installs anything: check() fails closed
  // when the selected tool is absent or its probe fails.
  if (config.image) return new DockerSandbox(config.image);
  if (process.platform === 'darwin') return new SeatbeltSandbox();
  if (process.platform === 'linux') return new BubblewrapSandbox();
  return new DockerSandbox('node:22-alpine');
}
