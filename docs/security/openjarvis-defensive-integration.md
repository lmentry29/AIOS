# OpenJarvis defensive-capability integration

**Status:** Implemented and tested on `security/openjarvis-defensive-integration`
**AIOS baseline:** `74dba764b93edb00b7fb1c939b8e73ea485385dd`
**OpenJarvis evidence baseline:** `6201505cd3425079459589f54764667b4758ce48`
**Scope:** defensive primitives only. No OpenJarvis runtime, executor, shell/REPL, MCP,
A2A, approval store, scheduler, channel, memory store, audit system or signing code was
imported, and no Python/Rust runtime dependency was added.

## Work ledger

| Capability | State | Implementation | Integration point | Evidence |
| --- | --- | --- | --- | --- |
| SSRF protection | Implemented | `packages/founder/src/security/ssrf.ts` | Default transport for the local Obsidian++ vault and Gmail/Notion readers; safe fetch factory for future connectors | `packages/founder/tests/ssrf.test.ts`, `packages/founder/tests/local-connectors.test.ts` |
| Taint tracking | Implemented | `packages/founder/src/security/taint.ts` | Every vault and connector record carries external-content labels; Founder host responses are a declared sink; declassification requires a human, a reason and a durable audit append | `packages/founder/tests/taint.test.ts`, `packages/founder/tests/local-connectors.test.ts`, `packages/founder/tests/obsidian-evidence.test.ts` |
| Sensitive paths | Implemented | `packages/founder/src/security/sensitive-path.ts` | Vault evidence paths and signed build-provenance artifacts; symlink-aware containment helper | `packages/founder/tests/sensitive-path.test.ts`, `apps/host/tests/security-file-integrity.test.ts` |
| Capability inventory | Implemented | `packages/founder/src/security/capability-inventory.ts` | Single source for policy validation, exact-resource authorization and human-only administrative actions | `packages/founder/tests/capability-inventory.test.ts`, `packages/founder/tests/authorization.test.ts` |
| Atomic persistence | Verified, one durability gap closed | Existing `Journal`, gVisor staging/promotion and evidence-bundle code | Directory fsync after evidence-bundle export and gVisor promotion; no second store created | `apps/host/tests/evidence-bundle.test.ts`, `apps/host/tests/gvisor-provenance.test.ts` |
| No-follow file reads | Implemented | `apps/host/src/security/file-integrity.ts` | Build attestations, trust roots, gVisor runtime/rootfs pins, rootfs manifest and Dockerfile verification | `apps/host/tests/security-file-integrity.test.ts`, existing provenance/signing suites |
| Trust-root lifecycle and build provenance | Implemented | `tools/security/trust-root.mjs`, `tools/security/build-provenance.mjs`, `apps/host/src/execution/artifact-signing.ts`, `apps/host/src/execution/build-provenance.ts` | External Ed25519 root with multiple active keys, overlapping rotation, revocation, expiry and key-id pinning; CI and offline local provenance bind commit, builder, workflow, run and exact artifacts | `apps/host/tests/trust-root-lifecycle.test.ts`, `apps/host/tests/build-provenance.test.ts`, `apps/host/tests/artifact-signing.test.ts` |

## Production reachability (verified 2026-11-12)

All six controls have a production caller. Every chain below starts at a real host entry
point, not at a test-only factory or an exported helper. No control is library-only.

| Control | Production call site | Status |
| --- | --- | --- |
| SSRF boundary | `apps/host/src/server.ts:1207` (`/v1/founder/gmail/search`) and `apps/host/src/server.ts:1222` (`/v1/founder/notion/applications`) → `apps/host/src/runtime.ts:356` (`AuthorizedLocalConnectorEvidenceReader`) → `packages/founder/src/local-connectors.ts:137` (default `createLoopbackFetcher`). The vault path is `apps/host/src/server.ts:1192` → `apps/host/src/runtime.ts:345` → `packages/founder/src/obsidian-evidence.ts:278`. Enforcement: `packages/founder/src/security/ssrf.ts:521`. | Wired |
| Taint tracking | `apps/host/src/server.ts:1192`, `:1207` and `:1222` return Founder evidence records; `packages/founder/src/index.ts:274`, `:296` and `:306` pass them through the `host_response` sink (policy at `:121`). | Wired |
| Sensitive-path protection | `apps/host/src/server.ts:1192` → `apps/host/src/runtime.ts:345` → `packages/founder/src/obsidian-evidence.ts:135` (`assertNotSensitivePath`). Signed build artifacts use `apps/host/src/execution/build-provenance.ts:249-250`. | Wired |
| Capability inventory | `apps/host/src/server.ts:444` (and the other `requireAllowed` routes) → `apps/host/src/server.ts:458` → `apps/host/src/authorization.ts:27` → `packages/founder/src/security/capability-inventory.ts:111` (`isAccessAction`). Policy construction validates the same inventory at `packages/founder/src/authorization.ts:389`. | Wired |
| No-follow bounded reads | `apps/host/src/runtime.ts:253` (`PolicyProvenanceAuthority.fromFiles`) → `apps/host/src/policy-provenance.ts:285` → `apps/host/src/security/file-integrity.ts:28`, with `O_NOFOLLOW` at `:44`. Signed artifacts use `apps/host/src/execution/artifact-signing.ts:295`. | Wired |
| Directory fsync | `apps/host/src/runtime.ts:263` constructs `DurableAuthorizationAuditStore`; `apps/host/src/persistence/authorization-audit-store.ts:442` fsyncs the directory after the signed audit head is renamed. Journal compaction uses `apps/host/src/persistence/journal.ts:511`; implementation: `apps/host/src/persistence/fsync-directory.ts:16`. | Wired |

## SSRF contract

`resolveSafeHttpUrl` validates the absolute URL, rejects credentials and fragments,
enforces exact protocol/host/port allow-lists, resolves every DNS answer and rejects the
request if **any** answer is non-public. Public means globally routable unicast; loopback,
private, link-local, multicast, documentation, benchmarking, translation and reserved
ranges are denied. IPv4-mapped/compatible IPv6, 6to4 and NAT64 embeds are classified by
their embedded IPv4 address.

`safeHttpRequest` connects to the already-validated IP, not the hostname, while retaining
the original hostname for the HTTP `Host` header and TLS SNI/certificate verification.
This removes the DNS-rebinding verification-to-connect window. Redirects are never
followed: any 3xx is a hard error. Request/response bytes, header count/name/value,
timeouts and abort signals are bounded.

The local Obsidian++ readers accept only an explicit-port HTTP loopback origin. Their
default transport is `createLoopbackFetcher`, which pins that exact origin and rejects
redirects; an injected `fetch` remains available only for deterministic tests.

## Taint contract

Labels are closed (`external_untrusted`, `prompt_injection_risk`,
`connector_poisoning_risk`). Marks carry deduplicated, sorted labels and source IDs.
`mapTainted` propagates the mark, and `mergeTaint` is order-independent. `TaintSinkPolicy`
denies unknown sinks and unlisted labels. `declassify` requires an authenticated
`human:` actor, a non-empty bounded reason and a successful append to
`TaintDeclassificationAudit`; an audit failure rejects declassification.

Vault and connector records carry labels. `FounderInterface` checks every returned record
at the `host_response` sink, so adding a label without updating the response policy fails
closed. The only permanent record currently reachable from Founder (`recordDecision`)
requires an authenticated human and is not an automatic promotion of tainted evidence;
permanent Memory promotion remains behind ADR-0014's separate human approval.

## Sensitive-path contract

High-confidence credential locations are denied: `.env` files (except documented
`.example`/`.sample`/`.template` templates), private keys and key stores, `.ssh`, `.aws`,
`.gnupg`, `.kube`, `.docker`, cloud credentials, service-account JSON, credential stores,
shell history and wallet stores. `.env.md`-style vault notes are denied before any body
read. Signed build provenance refuses a sensitive artifact name or path.

`resolveContainedPath` rejects traversal, validates every symlink against the canonical
root, allows only the final component to be absent when creation explicitly opts in, and
rejects a symlinked root.
The host's no-follow reader uses `O_NOFOLLOW`, `fstat` and a post-read identity/size/time
check, closing the final-component lstat/read replacement race. The gVisor rootfs manifest
and the evidence-bundle, trust-root, pin and attestation readers all use it. Parent-directory
replacement still needs an OS-level `openat2`/`RESOLVE_BENEATH` primitive that portable Node
does not expose; that residual limitation is explicit rather than claimed away.

## Capability inventory contract

All twelve authorization actions are declared exactly once with
`resource_scope: 'exact_resource'`. Unknown values return `undefined`; there is no
wildcard, guest or default-allow capability. Policy construction and runtime evaluation
both use the same inventory. Only `administer_policy`, `revoke_policy` and
`administer_sessions` are human-only. An unknown capability is denied and audited as
`invalid_request`, never inferred from an owner, role or resource match.

Named fail-closed tests cover the policy-construction and runtime paths:
`rejects unsupported and wildcard actions during policy construction`,
`denies and audits an unknown capability instead of inferring authority`,
`allows only an exact subject/action/resource match`, and the three exact human-only
grant tests. The inventory tests also reject `*`, `execute:*`, inherited properties and
malformed values.

## Atomic persistence decision

AIOS already has a hash-chained, fsynced, lock-protected append-only journal
(`apps/host/src/persistence/journal.ts`), unique-invocation gVisor staging directories with
inode-checked promotion, and an immutable rootfs manifest v2 covering content, ownership,
permissions, timestamps and extended attributes. No replacement store or second system of
record was introduced.

One concrete gap was closed: completed evidence-bundle exports and promoted gVisor outputs
now fsync their parent directory after the atomic rename. The helper ignores only errno
values that mean directory fsync is unavailable on the platform/filesystem; permission,
I/O and missing-directory failures propagate. File content has already been fsynced before
the rename.

## Supply-chain lifecycle evidence

The trust root consumed by the runtime/rootfs verifier, provenance verifier and evidence-bundle
verifier is now provisionable and rotatable with `tools/security/trust-root.mjs`. It supports
multiple distinct active keys, overlapping windows, `revoke`, `list` and `validate`. Private
keys are written only to operator-supplied runtime paths with mode `0600`; the checked-in root
remains empty and fail-closed. `tools/security/build-provenance.mjs` now has a local/offline
producer using the same signed statement as CI, and `verify` can pin the exact key id
(`WRONG_KEY`, exit 19) in addition to repository, commit, builder, workflow, run/attempt and
real artifact bytes. Generation is atomic and no-replace.

Named tests cover unknown/revoked/expired keys, overlap rotation then expiry, rollback to a
previous attestation version, wrong key id, wrong commit, artifact digest, forged builder,
symlinked attestation/trust-root files, local generate/verify and refusal to overwrite an
existing attestation or non-empty trust root. Focused lifecycle/signing/provenance:
**30/30**. Full evidence is in [`trust-root-lifecycle.md`](trust-root-lifecycle.md) and
[`build-provenance.md`](build-provenance.md).

## Verification evidence (2026-11-11)

Full uncached gate:

```bash
./node_modules/.bin/turbo run lint typecheck build test --force --cache-dir="$PWD/.turbo/cache"
```

Result: **46/46 tasks successful, 0 cached, exit status 0**. Test totals:

- `@aios/founder`: 95 passed across 10 files.
- `@aios/host`: 298 passed, 17 skipped across 30 passed files and 3 skipped files. The
  skips are live gVisor/Docker/rootfs probes that require a host environment; they are not
  counted as passing evidence. Mission, signed-archive and lifecycle tests are included.
- conformance: 107 passed; integration: 43 passed; orchestration: 31 passed. The remaining
  packages' configured tasks, including `--passWithNoTests` where applicable, succeeded.
  Full workspace total: **757 passed / 17 skipped**.

The VM exposed pnpm only through `npx`, so the gate used a temporary workspace-local pnpm
binary and a workspace-local Turbo cache. No lockfile or dependency was changed for that
workaround.

`pnpm format:check` is now green after the owner-approved repository-wide migration:
the current gate checks **203 files with 0 findings**, and `biome format --write .` fixed
**149 files**. This replaced the historical baseline rather than cherry-picking the added
files. The previous line-number citations in the production-reachability table were
re-anchored in the same migration commit. The migration changed formatting only; the full
gate below is the evidence that behavior did not change.

## CI evidence (2026-11-12)

The Security workflow now includes `security/openjarvis-defensive-integration` in its
`push` trigger. The `pull_request` and `main` triggers, `permissions: contents: read`, and
all job contents are unchanged. Security run **43234936169**
(https://github.com/lmentry29/AIOS/actions/runs/43234936169) passed for code head
`7f0b350ecd606215df42db1c7f82eec6bfc7c107`; both the live-sandbox and supply-chain jobs
succeeded. Earlier run **43136322627** passed for code head
`d232c91f8f439091649b83b79c8e691e47ffd1a3`.

The first branch run, **43135546414**
(https://github.com/lmentry29/AIOS/actions/runs/43135546414), failed at
`session-operator-drill.mjs`: the drill still wrote a host config without the required
`policy_provenance` object. `d232c91` provisions a disposable Ed25519 trust root and
owner-only signing key in the drill's temp directory; the drill passes all 13 steps
locally without weakening host validation. Local suites after the fix: founder 95/95,
host 287 passed / 17 skipped.

This documentation-only follow-up is a separate head. Its Security run is recorded in the
branch run history:
https://github.com/lmentry29/AIOS/actions/workflows/security.yml?query=branch%3Asecurity%2Fopenjarvis-defensive-integration

## Current full-gate evidence (2026-11-12)

At code head `646e1cc` (the docs-only follow-up after `d232c91`), the forced workspace gate is
**46/46 tasks successful, 0 cached, exit status 0**. Totals: core 51, objects 32, tools 10,
containers 21, work-hierarchy 24, learning 28, agents 6, founder 95, orchestration 31,
conformance 107, integration 43; host **287 passed / 17 skipped** across 31 files (28 passed
files, 3 skipped files). The 17 skipped host tests are live gVisor/Docker/rootfs probes and
are not counted as passing. Security run `43136727667`
(https://github.com/lmentry29/AIOS/actions/runs/43136727667) passed both jobs on `646e1cc`.

## Residual boundaries

- The local Obsidian++ service is a separate process and is not authenticated as a host
  principal by AIOS. AIOS authorizes the resource before the request and constrains the
  origin, but the provider's own authorization remains part of the trust boundary.
- No general public-web connector currently exists. The public-URL-safe client is tested
  independently and is the only sanctioned path for a future connector; no new network
  surface was invented to exercise it.
- Taint metadata is carried in memory response records. There is currently no automatic
  external-network or permanent-Memory sink that accepts connector content, so no such
  sink is fabricated. Any future sink must call `assertTaintSink`; the host display sink
  already does.
- Filesystem containment cannot be made fully race-free portably without kernel
  `openat2`; the no-follow final-component check and canonical containment are the
  strongest portable controls used here.
- The repository trust root remains empty until an operator provisions a public key. The
  lifecycle is implemented and tested, but production key custody, provisioning authority and
  external transparency/identity remain open; no Sigstore or SLSA conformance is claimed.

## Verification commands

```bash
pnpm --filter @aios/founder typecheck
pnpm --filter @aios/host typecheck
pnpm --filter @aios/founder test
pnpm --filter @aios/host test
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```
