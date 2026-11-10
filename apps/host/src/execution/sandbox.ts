import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxProviderKind } from '../config.js';
import { HostUnavailableError } from '../errors.js';
import { runCapturedProcess } from './process.js';

export type SandboxAssurance = 'container' | 'kernel-namespace' | 'seatbelt' | 'test-only-process';

export interface SandboxCheck {
  available: boolean;
  reason: string;
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
  });
  return { ...result, provider: options.id, assurance: options.assurance };
}

function assertWorkspace(workspaceDirectory: string): string {
  if (!isAbsolute(workspaceDirectory)) {
    throw new HostUnavailableError('A sandbox workspace must be an absolute path.');
  }
  return resolve(workspaceDirectory);
}

class DockerSandbox implements SandboxProvider {
  readonly id = 'docker';
  readonly assurance = 'container' as const;

  constructor(private readonly image: string) {}

  async check(): Promise<SandboxCheck> {
    const info = await runCapturedProcess(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    if (info.spawnError) return { available: false, reason: 'The Docker CLI is not installed or not on PATH.' };
    if (info.exitCode !== 0) {
      return { available: false, reason: 'The Docker daemon is not reachable; a container sandbox cannot be established.' };
    }
    const inspected = await runCapturedProcess(
      'docker',
      ['image', 'inspect', this.image, '--format', '{{.Id}}'],
      { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 10_000, maxOutputBytes: 1024 },
    );
    if (inspected.exitCode !== 0) {
      return {
        available: false,
        reason: `The configured sandbox image "${this.image}" is not present locally; the host does not pull images implicitly.`,
      };
    }
    return { available: true, reason: 'Docker daemon and sandbox image are available.' };
  }

  async run(spec: SandboxRunSpec): Promise<SandboxResult> {
    const workspace = assertWorkspace(spec.workspaceDirectory);
    const containerName = `aios-${randomUUID()}`;
    const mount = `type=bind,src=${workspace},dst=/workspace,rw`;
    const workdir = spec.cwd === undefined ? '/workspace' : `/workspace/${spec.cwd}`;
    // The workspace is mode 0700. Running the container as the host UID/GID keeps
    // that permission meaningful; a fixed nobody UID would make every command fail
    // to read its own workspace. On non-POSIX hosts the container default is used.
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    const user = uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
    const args = [
      'run',
      '--rm',
      '--name', containerName,
      '--network=none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      '--mount', mount,
      '--workdir', workdir,
      ...(user === undefined ? [] : ['--user', user]),
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      this.image,
      ...spec.argv,
    ];
    // Killing the Docker CLI alone leaves the container running. On cancellation, issue an
    // explicit `docker kill` for this run's unique container name. The kill is best-effort
    // relative to the CLI abort; `--rm` still removes the container after it stops.
    const killContainer = () => {
      void runCapturedProcess('docker', ['kill', containerName], {
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      });
    };
    spec.signal?.addEventListener('abort', killContainer, { once: true });
    try {
      return await spawnProvider('docker', args, {
        id: this.id,
        assurance: this.assurance,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        env: {},
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      });
    } finally {
      spec.signal?.removeEventListener('abort', killContainer);
    }
  }
}

/**
 * Bubblewrap user namespaces, no network, read-only host system, writable workspace.
 *
 * This is a kernel-namespace boundary, not a container: there is no cgroup memory/CPU
 * accounting and no seccomp profile. It is therefore labelled honestly and is suitable
 * only for trusted local commands until Landlock/seccomp hardening lands.
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
    const probe = await this.invoke(['/bin/true'], undefined, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
    if (probe.exitCode !== 0) {
      return { available: false, reason: 'bubblewrap cannot create the required user namespace on this host.' };
    }
    return { available: true, reason: 'bubblewrap passed its namespace probe.' };
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
    const binds = ['/usr', '/bin', '/lib', '/lib64', '/etc']
      .filter((path) => existsSync(path))
      .flatMap((path) => ['--ro-bind', path, path]);
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--cap-drop', 'ALL',
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
      ...argv,
    ];
    return spawnProvider('bwrap', args, {
      id: this.id,
      assurance: this.assurance,
      timeoutMs,
      maxOutputBytes,
      env: {},
      ...(signal === undefined ? {} : { signal }),
    });
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
}): SandboxProvider {
  if (config.provider === 'docker') {
    if (!config.image) throw new HostUnavailableError('The Docker sandbox requires a configured image.');
    return new DockerSandbox(config.image);
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
