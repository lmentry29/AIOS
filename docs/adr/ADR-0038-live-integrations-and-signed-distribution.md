# ADR-0038 — Read-Only Live Integrations and Signed Application Distribution

## Status

**Accepted** (2026-11-12). This ADR records the owner's completion decisions for CL-009 and
CL-015. Live credentials and a real release artifact remain operator-supplied.

## Context

The Founder evidence adapters are tested with fixtures but no live Gmail, Notion, or Obsidian
account is configured. ADR-0020 keeps `@aios/*` private and makes the application artifact the
distribution unit, but no signed archive or offline verifier exists.

## Decision

### 1. Live integrations are read-only and host-mediated

The supported live integrations are:

- Gmail search;
- Notion application listing;
- the local Obsidian vault.

All three are read-only. No send, write, delete, or schema-normalizing action is authorized by
this ADR. OAuth tokens and local vault credentials are held by the operator secret store and
resolved by the host; they never appear in a Task environment, canonical record, evidence,
prompt, or log.

The host exposes only reviewed read routes. Each read requires the exact resource grant on the
named integration resource. Fixture tests and live tests must exercise the same response shape
and failure semantics; a live credential does not widen the adapter's authority.

### 2. Distribution is a signed application archive

The supported distribution is a signed application archive for the `local-secure` profile.
It contains the built host and workspace packages, a release manifest naming the host version,
commit, profile, isolation-provider requirement, and Founder/connector configuration status.
It contains no secrets, journals, workspace contents, environment files, or private keys.

The archive is accompanied by an offline verifier and a detached signature made with an
`artifact`-purpose key from the v2 trust root. Verification checks the exact archive digest, the
manifest, the signer purpose, revocation, validity window, and the release identity. A checksum
without a signature is not a release.

There is no auto-update channel in this decision. A future updater requires a separate ADR
covering a signed metadata root, delegation, rotation, rollback protection, and platform
installation.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Write-capable live integrations | Expands authority beyond the tested read adapters and requires a new approval model. |
| Store provider tokens in canonical records | Leaks through logs, evidence, prompts, and generated schemas. |
| Call any build archive a release | It may omit the provider requirement and release identity. |
| Auto-update before a signed metadata design | Turns a code-distribution channel into remote code execution. |
| Publish npm packages | ADR-0020 keeps the packages private. |

## Consequences

- Live tests remain blocked until operator accounts and vault access exist; no live claim is
  made from fixtures.
- `tools/security/app-archive.mjs` implements the deterministic archive and offline verifier.
  The release workflow produces only an unsigned review archive because the operator's
  artifact-purpose key is not present in the repository; a signed release remains
  operator-supplied.
- The release manifest is a security artifact and must be verified before installation.

## Tests required

- Gmail, Notion, and Obsidian live reads return the same shape as their fixtures.
- Missing, expired, revoked, or wrong-scope credentials fail closed without leaking the secret.
- A write/send route is absent or denied; evidence and logs contain no token material.
- The offline verifier accepts the exact signed archive and rejects a changed byte, wrong
  signer purpose, revoked key, expired key, or mismatched release identity.
- The archive contains no `.env`, private key, journal, workspace, or secret material.
