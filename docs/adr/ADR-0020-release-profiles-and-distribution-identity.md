# ADR-0020 — Release Profiles and Distribution Identity

## Status

**Accepted** (2026-11-10). This ADR governs packaging and publication; it does not claim
that a signed installer or automated update channel exists.

## Context

All nine packages are `private: true` and the root package is private, but the release
workflow still invokes `changeset publish`. That currently publishes nothing, which is
safe but misleading: a future accidental removal of `private` could publish packages that
were never designed as a supported public API. The app also has no named release profile,
so “release” could mean a build, a container image, or an npm package depending on who is
reading.

## Decision

1. **The initial distribution is the application artifact, not npm packages.** The
   `@aios/*` packages remain private workspace implementation details. No package is
   published to a public registry until a separate decision names the package scope,
   support policy, and API compatibility commitment.
2. **Named release profiles:**
   - `local-dev` — source checkout, `pnpm`, no sandbox provider guaranteed; dispatch may be
     disabled. This is the profile used for tests and development.
   - `local-secure` — built host plus a verified isolation provider (Docker preferred,
     bubblewrap/Seatbelt where supported), owner-only config, durable journal, and a
     configured independent verifier.
   - `distribution` — a future signed application/container artifact with an update policy.
     It does not exist yet; do not label a build archive as one.
3. **Release identity is the app artifact, not the packages.** A release must state the
   host version, commit, release profile, isolation provider requirement, and whether
   Founder Intelligence/connectors are configured. It must not imply that optional
   integrations are bundled or live.
4. **No secrets in artifacts.** Build outputs, source maps, config samples, and container
   images must exclude `.env` files, provider passwords, bearer-token digests, workspace
   contents, and operational journals.
5. **Package publication is gated.** `changeset publish` must not run in CI while packages
   are private. The release workflow is now a manual build that uploads a reviewable
   artifact; it does not invoke changesets or publish packages.
6. **Update integrity is a future ADR.** A real updater requires a signed metadata root,
   TUF-style delegation, key rotation, rollback protection, and platform-specific
   installation. A checksum in a release note is not an update system.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Publish every `@aios/*` package now | They are private, unstable, and not designed as a supported public SDK. |
| Call any `dist/` archive a release | Omits sandbox requirements, configuration, and verification state. |
| Ship an updater before signing/rotation exists | Turns a code-distribution channel into a remote-code-execution path. |
| Leave `changeset publish` in place | A misleading no-op that becomes dangerous on one metadata edit. |

## Consequences

- The release workflow no longer invokes `changeset publish`; it is a manual
  `workflow_dispatch` build that uploads `apps/host/dist` and package `dist` output.
- Contributors can build and run the host, but there is no supported npm install path.
- A future public SDK or package release requires an amending ADR and a compatibility
  policy.
- Distribution signing, installer UX, and update metadata remain unimplemented and must
  not be claimed in release notes.

## Tests / evidence

`pnpm -r run build` produces local artifacts. The package manifests remain `private: true`.
There is no publication test because publication is not authorized. A release checklist
must fail closed if a package loses `private: true` without an accepted amending ADR.
