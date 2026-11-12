# ADR-0025 — Operational Journal Compaction and Verified Recovery

## Status

**Accepted** (2026-11-10). Amends ADR-0015, which accepted the hash-chained append-only
journal and explicitly stated that compaction and migrations did not exist. This ADR adds
compaction and a tested restore path without changing authorization or execution semantics.

## Context

ADR-0015's journal is append-only and fails closed at a size limit with the message that
"compaction is required". No compaction existed, and there was no tested backup or restore
procedure. That made the size limit a dead end: an operator's only options were to stop the
host permanently or hand-edit a hash-chained file, which destroys the tamper evidence the
chain exists to provide. A damaged journal had the same problem — detection without recovery
is not an operational control.

The journal is the authority for Task, Workflow, Artifact, dispatch-run, and per-Task
execution state. Execution attempts carry the `result_sha256` that the independent verifier
recomputes. Compaction therefore must not be allowed to lose or rewrite an attempt, because
that would let a forged or replayed verification result become acceptable after a rewrite.

## Decision

1. **Archive first.** Compaction exports every live record to a JSON archive with an explicit
   format and version, a source manifest (file name, record count, head hash, byte size), the
   complete record chain, and a SHA-256 digest over the canonical archive body. The archive is
   written to a temporary file, fsynced, renamed into place, and set owner-only. A failed
   export aborts before the live journal is touched.
2. **Snapshot, not truncation.** After the archive is durable, the live journal is replaced by
   exactly one hash-chained record of kind `journal_snapshot`. Its payload contains the current
   canonical state plus a `compaction` object naming the source sequence, source head hash,
   archive digest, and archive file name. The chain restarts at sequence 1 with a zero previous
   hash, so ordinary integrity validation still applies. Provenance is preserved by the
   snapshot's reference to the archived head; it is not silently discarded.
3. **Replay through existing validators.** The operational store carries tasks, workflows,
   artifacts, runs, and every execution attempt into the snapshot, and on restart replays them
   through the same `restore()` methods used for journal records (canonical schema validation,
   store invariants, monotonic revisions, contiguous attempt chains). A forged or replayed
   execution result is still rejected by the verifier after compaction because the durable
   attempt and its digest survive.
4. **Offline, locked restore.** `AppendOnlyJournal.restore()` requires absolute paths, takes the
   journal lock (so a running host cannot race it), and fully validates the archive — format,
   version, record hashes, chain order, manifest counts, head hash, and archive digest — before
   writing anything. It refuses to overwrite a different *valid* journal. A damaged target is
   preserved as `operational.jsonl.pre-restore-<timestamp>` (mode 0600) and then replaced
   atomically. Restoring the same archive again is a verified no-op returning
   `{ restored: false, unchanged: true }`.
5. **Bounded input.** Archives are capped at 128 MiB; a snapshot that cannot fit the journal's
   configured limit fails instead of being written partially.
6. **Operator commands.** `compact-journal` and `restore-journal` are offline CLI commands that
   take the host configuration and an absolute archive path, and emit one JSON event with
   counts, hashes, and byte sizes.

## Consequences

- The journal is no longer a dead end at its size limit: compaction reduces it to the live
  state and it accepts new appends immediately.
- Integrity detection now has a recovery path with an explicit, preserved backup of the
  damaged file.
- The archive is the authority for history that the compacted journal no longer carries. It is
  **not encrypted, not signed, and not externally custodied**; its digest detects accidental or
  out-of-band modification relative to the manifest, but an attacker who can rewrite both the
  archive and its digest can forge it. Operators must protect archives (owner-only directory,
  encrypted volume, retention policy) and are responsible for retaining them as long as the
  history matters. Automatic retention, remote custody, signing, and migrations remain open.
- Compaction is manual and offline; there is no scheduler and no online compaction while the
  host serves requests.
- This is a local single-process control. It does not make the journal safe for multi-host
  access and does not change ADR-0015's durability or locking model.

## Verification

`apps/host/tests/journal-recovery.test.ts` covers size-limit compaction, corruption detection
and restore, tampered-archive rejection, restore idempotency, refusal to overwrite a different
valid journal, and verifier acceptance/rejection of the same result before and after a
compaction cycle. `tools/security/journal-drill.mjs` executes the same lifecycle against the
built journal and prints observed results; the run is recorded in
`docs/security/validation-ledger.md`.

## Red-team replay amendment (2026-11-12)

A malicious reorder or duplicated segment is rejected by the contiguous sequence and previous
hash checks; a scheduler graph whose revision skips a record, mutates immutable fields, regresses
a terminal node, duplicates an approval, releases a gated node early or returns a non-opted
running node directly to pending is rejected on replay. Recovery still converts a surviving
running record to interrupted, so truncated completion never becomes silent completion. The
infrastructure collection rejects replay that retargets `secret_ref` or changes immutable
identity fields, and broker ciphertext is never part of the journal or its snapshot.

Complete-line suffix truncation remains indistinguishable from a legitimate shorter journal
without an independent head anchor. The chain detects edits, reordering and duplicated
segments, but cannot prove that the newest complete records existed. External WORM/RFC3161
anchoring (CL-006/CL-021) is the owner-gated control that closes this; complete-line rollback
detection is tracked separately in CL-024. The local authorization audit head does not anchor
the operational journal.
