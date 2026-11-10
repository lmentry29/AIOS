import { spawn } from 'node:child_process';

export interface CapturedProcessOptions {
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Aborts the child process with SIGKILL. The result is marked `cancelled`. */
  signal?: AbortSignal;
}

export interface CapturedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
}

/**
 * Runs an argument vector without a shell.
 *
 * This helper is shared by the isolation providers but is not itself a sandbox. It
 * only enforces collection limits and a hard timeout; the provider decides the
 * isolation boundary. Output is capped while it is being collected so a noisy
 * command cannot exhaust host memory.
 */
export function runCapturedProcess(
  command: string,
  args: string[],
  options: CapturedProcessOptions,
): Promise<CapturedProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    const abort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      child.kill('SIGKILL');
    };

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer): Buffer<ArrayBufferLike> => {
      const remaining = options.maxOutputBytes - current.length;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) {
        truncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref();

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
  });
}
