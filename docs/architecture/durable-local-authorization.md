# Durable Local Authorization and Audit Storage

## Scope

`FilePolicyRegistry` is a local durable implementation of the policy store, resource-to-policy resolver, policy administration port, and authorization decision audit sink.

It stores only authorization policy snapshots, resource attachments, and authorization audit records. It is **not** a Founder Intelligence store and does not duplicate Obsidian notes, Founder Memory, Gmail messages, or Notion page content.

## Storage behavior

- The host supplies an absolute path to a dedicated local state file.
- The parent directory is canonicalized and restricted to owner-only permissions (0700); the state and lock files are owner-only (0600).
- A process lock prevents concurrent writers. A stale lock is reclaimed only when its recorded process no longer exists; malformed or active locks fail closed.
- Every policy mutation and authorization decision is persisted by writing a complete snapshot to a same-directory temporary file, fsyncing it, and atomically renaming it.
- Published policies are immutable. A policy change requires a new policy UUID and a new explicit attachment. The host exposes an authenticated `POST /v1/policies` path through `FilePolicyRegistry.publishAndAttach()`; it requires an exact `administer_policy` grant on every target and a human principal, then commits the policy and all attachments as one validated snapshot. A replacement version must exceed the effective version for every already-attached target.
- The append-only audit envelope chain is SHA-256 hash-linked and verified on startup. Out-of-band modification or truncation is detected.

The registry is single-process and local-disk only. The host must call `close()` during orderly shutdown. The file should live in a dedicated application-data directory on an encrypted local volume.

## Authorization semantics

The registry plugs into the existing `AuthorizationService` and `PolicyAdministrationService`. The evaluator remains exact-match and default-deny, with deny-overrides and mandatory audit persistence. If an audit append fails, the authorization decision is denied.

No wildcard grants, implicit owner grants, or policy auto-attachments are introduced. The trusted host remains responsible for authenticating the caller and supplying the actor ID; this file store does not authenticate users.

## Limitations

- A hash chain detects edits relative to the stored chain but is not a digital signature and cannot protect against an attacker who can rewrite the entire file and recompute every hash.
- The registry is not a distributed database and is not suitable for multi-host or multi-user deployments.
- Runtime administration is authenticated by the host's bearer session plus an exact grant; there is no detached cryptographic policy signature.
- Backup, restore, retention, external audit export, and recovery drills still require operational implementation.
