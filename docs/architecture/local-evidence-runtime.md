# Local Evidence Runtime Composition

## Purpose

`createLocalEvidenceRuntime()` composes the durable local policy registry, the shared default-deny AuthorizationService, and three read-only evidence sources: the Obsidian vault, Gmail, and Notion.

The factory does not create policies or attach resources. Missing grants remain denied. It also does not authenticate callers; the trusted host must map an authenticated local session to an actor such as `human:founder`.

## Configuration

The host supplies:

- An absolute policy-state file path in a dedicated owner-only directory.
- Three distinct UUIDs for the vault, Gmail, and Notion resources.
- The Obsidian++ loopback URL (default `http://127.0.0.1:4444`).
- The local Obsidian++ password, loaded from owner-only local configuration.
- Optional fetch and timeout overrides for controlled tests.

Provider credentials remain inside Obsidian++. AIOS receives no Google OAuth token or Notion integration token.

## Bootstrap sequence

1. Create the runtime and keep the returned policy registry private to the trusted host.
2. Construct `PolicyAdministrationService` with the configured bootstrap principal and the same registry.
3. Publish immutable policies and explicitly attach separate read grants for the vault, Gmail, and Notion resources.
4. Inject the returned shared AuthorizationService into Founder and Orchestration.
5. Close the runtime on orderly shutdown so its single-process policy lock is released.

The bootstrap service must not be exposed as a general-purpose endpoint. The host should expose only the minimum reviewed administrative action surface.

## Failure behavior

- Invalid resource IDs, aliased resources, weak local passwords, external URLs, and invalid policy paths fail during construction.
- Missing policy, explicit deny, resolver error, or audit-write failure denies the operation.
- Authorization is evaluated before any evidence request reaches Obsidian++.
- No adapter performs external writes or promotes evidence into permanent Founder Memory.

## Verification boundary

The composition and adapters are unit-tested with mocked HTTP. A live local startup, actual vault read, Gmail OAuth exchange, and Notion API read remain unverified until the user's local machine has the required configuration.
