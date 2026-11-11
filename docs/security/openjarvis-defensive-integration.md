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
| No-follow file reads | Implemented | `apps/host/src/security/file-integrity.ts` | Build attestations, trust roots, gVisor runtime/rootfs pins and Dockerfile verification | `apps/host/tests/security-file-integrity.test.ts`, existing provenance/signing suites |

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
The host's no-follow reader uses `O_NOFOLLOW`, `fstat` and a post-read identity/size check,
closing the final-component lstat/read replacement race. Parent-directory replacement
still needs an OS-level `openat2`/`RESOLVE_BENEATH` primitive that portable Node does not
expose; that residual limitation is explicit rather than claimed away.

## Capability inventory contract

All twelve authorization actions are declared exactly once with
`resource_scope: 'exact_resource'`. Unknown values return `undefined`; there is no
wildcard, guest or default-allow capability. Policy construction and runtime evaluation
both use the same inventory. Only `administer_policy`, `revoke_policy` and
`administer_sessions` are human-only. An unknown capability is denied and audited as
`invalid_request`, never inferred from an owner, role or resource match.

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

## Verification evidence (2026-11-11)

Full uncached gate:

```bash
./node_modules/.bin/turbo run lint typecheck build test --force --cache-dir="$PWD/.turbo/cache"
```

Result: **46/46 tasks successful, 0 cached, exit status 0**. Test totals:

- `@aios/founder`: 93 passed across 10 files.
- `@aios/host`: 251 passed, 17 skipped across 28 files (25 passed files, 3 skipped files).
  The skips are live gVisor/Docker/rootfs probes that require a host environment; they are
  not counted as passing evidence.
- conformance: 107 passed; integration: 43 passed; orchestration: 30 passed. The remaining
  packages' configured tasks, including `--passWithNoTests` where applicable, succeeded.

The VM exposed pnpm only through `npx`, so the gate used a temporary workspace-local pnpm
binary and a workspace-local Turbo cache. No lockfile or dependency was changed for that
workaround.

`pnpm format:check` remains red with 155 findings across 189 tracked files. All files
added by this change pass the formatter, and no unrelated baseline file was reformatted.
The baseline is reported here rather than claimed as a passing gate.

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
