# Offline evidence bundles

Status: implemented and locally verified (2026-11-11). This is a portable audit export, not a
claim of Sigstore, SLSA or in-toto conformance.

## Purpose

The host's operational journal is the authority for Tasks, executions, artifacts and verifier
decisions. A party outside the host process needs to verify that history without trusting the
host that produced it. An evidence bundle is a bounded, versioned, signed snapshot of the
journal and its evidence records that can be verified offline with only an external trust root.

The bundle is **historical**: it proves what the host recorded and signed at export time. It
does not prove that the live journal still has that head. Replay detection therefore requires
an independently obtained checkpoint (`--expect-head`), as described below.

## Format

```
{
  format: "aios-evidence-bundle",
  version: 1,
  bundle_id: "<opaque id>",
  exported_at: "<ISO-8601 UTC>",
  source: {
    record_count: <n>,
    head_hash: "<journal record hash>",
    entry_head_hash: "<bundle entry-chain head>"
  },
  signing_key: { key_id, algorithm: "ed25519", public_key_pem },
  entries: [{ sequence, kind, payload, previous_hash, hash, entry_hash }],
  tasks: [{ task_id, lifecycle_state, audit_trail_ref?, entity_sha256 }],
  artifacts: [{ artifact_id, entity_sha256, task_id?, verifier_id?,
                verifier_accepted?, verifier_reason_sha256?,
                verifier_evidence_sha256?, recorded_at? }],
  executions: [{ execution_id, task_id, attempt, attempt_kind,
                 previous_execution_id?, state, evidence, ..., record_sha256 }],
  bundle_sha256: "<digest of canonical signed payload>",
  signature: "<canonical 64-byte base64 Ed25519 signature>"
}
```

`entries` preserve every journal record and its source hash chain. In addition, each entry is
wrapped in a second chain:

```
entry_hash = SHA-256("aios-evidence-bundle/entry/v1\n" + sequence + "\n" + hash + "\n" + previous_entry_hash)
```

The domain-separated chain gives explicit ordering independent of the journal's own record
format, and detects deletion, reordering and truncation even if a source record hash was
recomputed. `bundle_sha256` covers the canonical JSON of the payload excluding the digest and
signature. The signature is over
`"aios-evidence-bundle/signature/v1\n" + canonical(payload)`. Canonical JSON recursively sorts
keys and omits `undefined` properties, matching the journal's write semantics.

Task, Artifact and execution projections are recomputed from journal entity records during
verification. A projection cannot claim a verifier decision, Task binding or attempt record
that is not present in the signed journal entries. Entity digests use separate
`aios-evidence-bundle/{task,artifact,execution}/v1` domains. This binds the exact artifact
bytes, verifier identity/decision hashes, execution attempt and result binding already in the
ledger.

## Offline verification contract

`verifyEvidenceBundle` and `tools/security/evidence-bundle.mjs verify` read exactly two
documents: the bundle and a trust root. They do not open the operational store, use the
network, invoke a sandbox, or read mutable process state. They fail closed and use these exit
codes / failure classes:

| Exit | Code | Meaning |
| --- | --- | --- |
| 2 | `INVALID_JSON` | Not strict JSON, duplicate/dangerous key, bad string/escape, trailing content |
| 2 | `MALFORMED_BUNDLE` | Wrong shape, type, size, digest format, unknown field or malformed signature encoding |
| 8 | `UNSUPPORTED_VERSION` | Unknown bundle schema version |
| 3 | `SIGNATURE` | Ed25519 signature invalid or not canonical |
| 5 | `BUNDLE_DIGEST` | `bundle_sha256` does not match the signed payload |
| 4 | `CHAIN` | Deleted, edited, reordered or truncated journal/entry chain, or source head mismatch |
| 6 | `TASK_BINDING` | Completed Task lacks accepted verifier evidence, Artifact/Task mismatch, or projection not present in journal |
| 7 | `EXECUTION_CHAIN` | Missing/duplicate attempt, gap, mismatched predecessor, wrong execution digest, or Task/execution mismatch |
| 9 | `UNKNOWN_KEY` | Signing key absent from the supplied trust root or key material mismatch |
| 9 | `KEY_REVOKED`, `KEY_NOT_YET_VALID`, `KEY_EXPIRED` | Key lifecycle denial |
| 10 | `REPLAY` | Bundle head is not the independently expected checkpoint |
| 9 | `TRUST_ROOT` | Trust root file missing, unreadable or invalid |

The exit code distinguishes malformed input, integrity, chain, binding, key lifecycle and
replay failures. All are denials; none returns a partially verified bundle.

Replay detection is only possible against external state. Pass a head obtained from a trusted
channel:

```
node tools/security/evidence-bundle.mjs verify \
  --bundle exported.json \
  --trust-root tools/security/trust-root.json \
  --expect-head "$(cat trusted-checkpoint)"
```

Without `--expect-head`, a valid historical bundle remains verifiable after the live journal
advances. That is expected: the bundle is evidence of what was signed, not proof of the current
head. With a stale checkpoint it fails `REPLAY`.

## Export

Export requires the operational store in a quiescent state because the CLI opens the journal
under its single-process lock:

```
node tools/security/evidence-bundle.mjs export \
  --store /var/lib/aios \
  --key /run/secrets/aios-evidence-key.pem \
  --out /var/backups/aios-evidence.json
```

The export opens no network connection, writes the output through an unpredictable
owner-only (`0600`) temporary file in the destination directory followed by `rename`, and
refuses to export a Task whose completed evidence does not pass the same binding checks as
the verifier. The private key is read from an operator-supplied path and is never written into
the bundle.

## Key lifecycle and provisioning

- **Provisioning:** generate an Ed25519 key out-of-band, store the private half in a secret
  manager/HSM-backed workflow, and commit only the public key and validity window to the
  repository trust root. `evidence-bundle.mjs keygen` is a development/CI convenience that
  prints key material to stdout; it is not a production key-custody mechanism.
- **Named keys:** every bundle records its key id (SHA-256 of the DER SPKI public key), signing
  algorithm and public PEM. Public material in the bundle is never trusted by itself; it must
  equal a key in the external trust root.
- **Rotation:** add the new public key to the trust root with an overlapping validity window,
  export new bundles with the new private key, and retain the old public key in the trust root
  while old bundles still need verification. Do not remove a key until retention requires it.
- **Revocation:** set the key's status to `revoked` in the trust root. Verification denies every
  bundle signed by it with `KEY_REVOKED`; there is no fallback to the bundle's embedded key.
- **Absence and expiry:** an absent key is `UNKNOWN_KEY`; a key outside its validity window is
  `KEY_NOT_YET_VALID` or `KEY_EXPIRED`. None silently degrades to an unauthenticated or
  "diagnostic only" acceptance.
- **Compromise:** revoke the key, stop exporting with it, publish the new trusted key, and
  re-export the retained journal with the new key if a continued chain of custody is required.
  Bundles remain historical; revocation does not rewrite past evidence, and this project has no
  external timestamp/transparency log to settle the exact compromise time.

The checked-in trust root remains empty and therefore fail-closed; provisioning a production
key is an operator action outside this repository.

## Evaluated, reused and rejected

- **Reused:** the existing Ed25519 detached-signature primitives, `parseStrictJson` strict
  reader, canonical JSON encoding and append-only journal hash chain. No new runtime dependency
  was added.
- **Sigstore/cosign keyless:** evaluated and not used as the primary mechanism. Fulcio and Rekor
  require network access and an OIDC workload identity; AIOS's offline verification contract
  cannot depend on either, and no production identity is provisioned. Detached Ed25519 over a
  repository trust root is the implemented path. A future Sigstore attestation can be added as
  an additional envelope without replacing this verifier.
- **SLSA provenance:** the bundle records source-side facts only when the caller supplies them
  elsewhere; AIOS does not yet build a SLSA provenance statement, does not verify a builder
  identity, and claims no SLSA level.
- **in-toto attestations:** the design borrows the payload/signature separation and domain
  separation conceptually, but this is a project-specific versioned format, not an in-toto
  envelope. No conformance is claimed.
- **Database or object-store export:** rejected for this step. The journal already provides
  ordered, hash-chained, single-file evidence; adding an external store would add a trust and
  availability dependency without improving offline verifiability.

## Review of adjacent code and residual risks

The review covered the new bundle writer/verifier, existing journal canonicalization/archive
handling, artifact-signature parsing, Task/execution projections and CLI path handling.
Findings fixed during implementation:

- object input to the verifier initially bypassed schema validation; all input is now parsed
  through the strict reader;
- projections initially trusted their own verifier fields; they are now recomputed from signed
  journal artifact records;
- deletion of an execution attempt was initially invisible; every latest journal execution is
  now required in the bundle;
- artifact-signature canonical JSON rejects explicit `undefined`, while the journal omits it;
  the bundle uses the journal-compatible canonicalizer.

Residual limitations, stated explicitly:

- no external audit custody, notarization, transparency log or trusted timestamp: possession
  of the host signing key is still sufficient to sign a fabricated history;
- replay detection depends on a checkpoint delivered outside the bundle;
- the bundle contains the full exported journal, so it is not a selective-disclosure format;
- export requires a quiescent host; verification is offline and read-only;
- production trust-root/key provisioning and OIDC-backed identity remain operator/host gaps;
- no SLSA level, Sigstore conformance or in-toto conformance is claimed;
- Linux bundle verification was exercised in CI; macOS and rootless Docker were not measured
  for this feature and no extrapolation is made.
