#!/usr/bin/env node
/**
 * Executable journal recovery drill against the built host code.
 *
 * Runs the real AppendOnlyJournal: fills a 4 KiB journal to its limit, compacts it through
 * the archive-and-snapshot path, corrupts the live file, restores from the archive, checks
 * idempotency, and proves a tampered archive is rejected. Prints one JSON result per step
 * and exits non-zero on any failure. This is a drill, not a unit test: every step touches
 * the filesystem and the observed output is recorded in docs/security/validation-ledger.md.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const journalModule = await import(
  pathToFileURL(new URL("../../apps/host/dist/persistence/journal.js", import.meta.url).pathname)
    .href
);
const { AppendOnlyJournal } = journalModule;

const results = [];
function step(name, details) {
  results.push({ step: name, ...details });
  console.log(JSON.stringify({ step: name, ...details }));
}
function fail(name, error) {
  console.error(
    JSON.stringify({
      step: name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), "aios-journal-drill-"));
const filePath = join(directory, "operational.jsonl");
const archivePath = join(directory, "archive.json");
const tamperedPath = join(directory, "archive-tampered.json");

try {
  const journal = new AppendOnlyJournal({ filePath, maxBytes: 4096 });
  let appended = 0;
  let limitError = "";
  for (let index = 0; index < 100; index += 1) {
    try {
      journal.append("probe", { index, note: "x".repeat(128) });
      appended += 1;
    } catch (error) {
      limitError = error.message;
      break;
    }
  }
  if (!/size limit/.test(limitError))
    throw new Error(`expected a size-limit rejection, saw: ${limitError}`);
  step("size_limit", { ok: true, appended, journal_bytes: journal.sizeBytes });

  const compacted = journal.compactWithSnapshot("probe_snapshot", { resumed: true }, archivePath);
  if (compacted.bytes_after >= compacted.bytes_before)
    throw new Error("compaction did not reduce bytes");
  journal.append("probe", { index: "post-compaction" });
  step("compact", {
    ok: true,
    records_archived: compacted.record_count,
    bytes_before: compacted.bytes_before,
    bytes_after: compacted.bytes_after,
    archive_sha256: compacted.archive_sha256,
    append_after_compaction: true,
  });
  journal.close();

  const original = readFileSync(filePath);
  const corrupted = Buffer.from(original);
  const offset = Math.floor(corrupted.length / 2);
  corrupted[offset] = corrupted[offset] === 0x78 ? 0x79 : 0x78;
  writeFileSync(filePath, corrupted, { mode: 0o600 });
  let detected = false;
  try {
    const probe = new AppendOnlyJournal({ filePath, maxBytes: 65536 });
    probe.close();
  } catch {
    detected = true;
  }
  if (!detected) throw new Error("corrupted journal was accepted");
  step("corruption_detected", { ok: true, corrupted_offset: offset });

  const restored = AppendOnlyJournal.restore({ filePath, archivePath, maxBytes: 65536 });
  if (!restored.restored || restored.unchanged)
    throw new Error("restore did not replace the damaged journal");
  step("restore", {
    ok: true,
    records: restored.record_count,
    head_hash: restored.head_hash,
    backup_created: restored.backup_path !== undefined,
  });

  const again = AppendOnlyJournal.restore({ filePath, archivePath, maxBytes: 65536 });
  if (again.restored || !again.unchanged) throw new Error("second restore was not a no-op");
  step("restore_idempotent", { ok: true, unchanged: again.unchanged });

  const archive = JSON.parse(readFileSync(archivePath, "utf8"));
  archive.records[0].payload = { forged: true };
  writeFileSync(tamperedPath, JSON.stringify(archive), { mode: 0o600 });
  let tamperRejected = false;
  try {
    AppendOnlyJournal.restore({ filePath, archivePath: tamperedPath, maxBytes: 65536 });
  } catch {
    tamperRejected = true;
  }
  if (!tamperRejected) throw new Error("tampered archive was accepted");
  step("tampered_archive_rejected", { ok: true });

  const final = new AppendOnlyJournal({ filePath, maxBytes: 65536 });
  const kinds = final.read().map((record) => record.kind);
  final.close();
  step("known_good_state", { ok: kinds.includes("probe"), kinds: [...new Set(kinds)] });
  console.log(
    JSON.stringify({ drill: "journal-recovery", ok: true, steps: results.length, directory }),
  );
} catch (error) {
  fail("journal_drill", error);
}
