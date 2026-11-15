import { readFileSync } from "node:fs";
import type {
  ExecutionLedger,
  ExecutionProcessRecord,
  ProcessReapOutcome,
  ProcessReapSummary,
} from "../persistence/execution-ledger.js";

/**
 * Returns a stable Linux process identity (`boot_id:starttime`) or `undefined` when the
 * host cannot prove one. The boot id prevents a start-time value from matching after a
 * reboot; the start time prevents killing a recycled PID.
 */
export function processStartToken(pid: number): string | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    // Field 3 starts after the parenthesized command. `starttime` is field 22, so it is
    // index 19 in the remainder.
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (bootId.length === 0 || startTime === undefined || !/^[0-9]+$/.test(startTime)) {
      return undefined;
    }
    return `${bootId}:${startTime}`;
  } catch {
    return undefined;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reapOne(record: ExecutionProcessRecord): ProcessReapOutcome {
  if (record.pid <= 1 || record.pid === process.pid) return "identity_mismatch";
  if (record.start_token === undefined) return "identity_unavailable";
  const observed = processStartToken(record.pid);
  if (observed === undefined) {
    // The leader is gone. If its process group is also gone, this is a clean exit; if a
    // group remains, no proof of identity is available, so fail closed and do not signal.
    return groupAlive(record.pid) ? "identity_unavailable" : "already_gone";
  }
  if (observed !== record.start_token) return "identity_mismatch";

  try {
    process.kill(-record.process_group, "SIGKILL");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    ) {
      return "already_gone";
    }
    return "kill_failed";
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!groupAlive(record.process_group)) return "killed";
    pause(20);
  }
  return "kill_failed";
}

/**
 * Terminates process groups recorded by a previous host boot before their attempts are
 * reconciled. The operation is idempotent: a reaped record is never signalled again, and
 * every outcome is journaled. No PID is signalled without a matching boot/start token.
 */
export function reapRecordedProcesses(ledger: ExecutionLedger): ProcessReapSummary {
  const summary: ProcessReapSummary = {
    killed: 0,
    alreadyGone: 0,
    identityMismatch: 0,
    identityUnavailable: 0,
    failed: 0,
  };
  for (const record of ledger.listProcesses()) {
    if (record.reaped_at !== undefined) continue;
    const outcome = reapOne(record);
    ledger.markProcessReaped(record.execution_id, record.pid, outcome);
    if (outcome === "killed") summary.killed += 1;
    else if (outcome === "already_gone") summary.alreadyGone += 1;
    else if (outcome === "identity_mismatch") summary.identityMismatch += 1;
    else if (outcome === "identity_unavailable") summary.identityUnavailable += 1;
    else summary.failed += 1;
  }
  return summary;
}
