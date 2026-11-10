import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCapturedProcess } from '../src/execution/process.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

/**
 * These tests use real processes, not doubles. They prove that a timeout or an abort
 * terminates descendants the direct child started, which is what prevents a sandboxed
 * workload from surviving its invocation and continuing to hold host resources.
 */
describe.skipIf(process.platform === 'win32')('captured process cleanup', () => {
  it('kills the whole process group on timeout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-process-timeout-'));
    const pidFile = join(directory, 'pids.json');
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
      setInterval(() => {}, 1000);
    `;
    const result = await runCapturedProcess(process.execPath, ['-e', script, pidFile], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 1_500,
      maxOutputBytes: 4096,
    });

    expect(result.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const { parent, grandchild } = JSON.parse(readFileSync(pidFile, 'utf8')) as {
      parent: number;
      grandchild: number;
    };
    expect(await waitDead(parent)).toBe(true);
    expect(await waitDead(grandchild)).toBe(true);
  });

  it('kills descendants when the caller aborts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aios-process-abort-'));
    const pidFile = join(directory, 'pid');
    const controller = new AbortController();
    const script = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)';
    const running = runCapturedProcess(process.execPath, ['-e', script, pidFile], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(await waitDead(pid)).toBe(true);
  });

  it('does not leak the caller environment to the child', async () => {
    writeFileSync(join(tmpdir(), 'aios-unused'), '');
    const result = await runCapturedProcess('/usr/bin/env', [], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 5_000,
      maxOutputBytes: 65536,
    });
    expect(result.stdout.toString('utf8')).not.toContain('AWS_SECRET_ACCESS_KEY');
  });
});
