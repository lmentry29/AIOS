# ADR-0023 — Authorized Runtime Policy Administration

## Status

**Accepted** (2026-11-10). This ADR adds the action identifier `administer_policy` and an
authenticated runtime publication surface. It does not amend ADR-0013's default-deny,
exact-match, deny-overrides, human-only administration, or durable-audit rules. It is the
explicit review ADR-0013 requires before a new action identifier becomes grantable.

## Context

ADR-0013 requires protected operations to use resource-attached, exact-match, default-deny
policies. It also requires policy creation, attachment, replacement, and revocation to be
privileged, human-only, and durably audited. The initial policy-administration principal and
bootstrap mechanism must be configured out-of-band; an Agent must never administer policy.

The host implemented the bootstrap half of that contract with the offline
`aios-host publish-policy` CLI. That path is correct for initial provisioning, but it is not a
usable administration path once the host is running: the registry is single-process, so the
operator must stop the host, edit a file, publish, and restart. A policy change cannot
therefore decide subsequent authorization without an outage.

ADR-0013 does **not** forbid an authenticated runtime path. It forbids wildcard authority,
implicit owner or founder bypasses, Agent administration, and unauthenticated mutation. A
human principal who holds an exact `administer_policy` grant on every affected resource is
the policy-delegation model ADR-0013 already describes, not an exception to it.

The host also already has the two durable pieces this ADR needs: `FilePolicyRegistry` for
policy state, attachments, and lifecycle audit, and the hash-chained authorization decision
journal for every allow and deny. No new storage substrate or audit store is introduced.

## Decision

### 1. A distinct action, behind the existing boundary

`administer_policy` is added to the exact `AccessAction` vocabulary. It is never implied by
`intake`, `dispatch`, `execute`, ownership, the bootstrap identity, or another resource
grant. A policy rule that includes `administer_policy` may only name human subjects
(`human:*`); policy loading and publication reject the rule if any subject is an Agent
UUID. There is no wildcard subject, action, or resource.

`POST /v1/policies` is the runtime administration route. It requires:

1. a verified bearer session;
2. a human authenticated principal; and
3. an exact `administer_policy` allow on **every** resource in `attach_to`.

All target decisions are evaluated before the registry is called. If any target lacks the
grant, the request returns `403 policy_admin_denied`, no target is mutated, and every
decision that was evaluated is in the durable authorization journal. The host returns
`403 human_principal_required` if a non-human somehow reaches the human check; valid policy
validation makes that unreachable through a real grant.

The existing offline CLI remains the out-of-band bootstrap path. It is not removed or
widened. A non-bootstrap human with an exact grant may use the runtime route; the bootstrap
principal receives no implicit administration right and must itself be granted
`administer_policy` if it is to use the route.

### 2. Publication envelope and immutable policy

The request body is exactly:

```json
{
  "policy": {
    "policy_id": "<new-uuid>",
    "version": 2,
    "rules": [{
      "effect": "allow",
      "subject_ids": ["human:operator"],
      "actions": ["read_status"],
      "resource_ids": ["<resource-uuid>"]
    }]
  },
  "attach_to": ["<resource-uuid>"]
}
```

The envelope rejects unknown fields. `attach_to` must contain 1–64 distinct resource UUIDs.
The policy must pass the same strict validator used for offline publication and policy
loading. Published policies are immutable: `policy_id` must be new, and `version` must be a
positive safe integer.

The new policy's rules may reference only resources in `attach_to`, and every target must be
referenced by at least one rule. The version must exceed the currently effective version for
every target that already has an attachment. An unattached target may receive any valid
version. A stale or replayed policy cannot silently replace a newer one; rollback means
publishing a new, higher version containing the desired rules, not reattaching an old
version.

### 3. One atomic commit

`FilePolicyRegistry.publishAndAttach()` performs validation, target and rule-scope checks,
monotonic-version checks, lifecycle-event construction, and attachment changes against a
cloned state. It writes the complete next snapshot with the registry's normal fsync and
atomic-rename commit only after every check succeeds. The policy record, all target
attachments, and their lifecycle audit events therefore become visible together.

A malformed artifact, an unauthenticated request, an unsupported-version artifact, a
schema-invalid policy, an out-of-scope rule, or a stale version is rejected before
`commit()`. The previous policy remains effective, the previous bytes remain on disk, and no
partial attachment is observable.

### 4. Audit and failure behavior

Every target authorization evaluation uses the existing `AuthorizationService` and durable
`DurableAuthorizationAuditStore`. Records include the request correlation id, principal,
`administer_policy`, target resource, deciding policy id/version, decision, fixed reason,
matched rule index/effect, and timestamp. Denials use the existing typed reason
(`no_matching_allow` or an explicit deny), so the route's `policy_admin_denied` response has
a durable, queryable cause.

An audit append failure makes the authorization decision deny even if a matching allow rule
exists. The route therefore returns `policy_admin_denied` and never calls
`publishAndAttach`; the mutation does not take effect. Policy lifecycle events are appended
atomically with the policy snapshot, as before.

### 5. Errors and restart

The route uses typed, non-secret errors:

| Condition | Status | Code |
|---|---|---|
| Missing, malformed, or unknown bearer credential | 401 | `unauthenticated` |
| Any target lacks an exact grant | 403 | `policy_admin_denied` |
| Authenticated non-human principal | 403 | `human_principal_required` |
| Invalid envelope, policy, rule scope, or non-positive version | 400 | `invalid_policy` / `invalid_targets` |
| Existing policy identifier | 409 | `policy_exists` |
| Version not greater than an effective target version | 409 | `version_conflict` |

On a successful publish the response is `201` with the policy id, version, and attached
resource ids. A host close and reopen reloads and validates the policy state and its
hash-chained lifecycle/audit events; the new attachment decides later authorization and the
publish decision reads back in the durable authorization journal in order.

### 6. Signature boundary

The current trust model has **no detached policy signature**. Authority comes from the
verified session plus the exact `administer_policy` grant; the request body is not signed.
Unknown policy fields, including a caller-supplied `signature` field, are rejected by the
strict schema rather than silently carried. This ADR does not claim cryptographic policy
provenance. Adding detached signatures requires key generation, distribution, rotation, and
offline verification, which is a separate security decision and deployment contract.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep the offline CLI as the only path | Requires a host outage for every policy change; the mission requires runtime decisions without restart or hand-edited grant files. |
| Let the bootstrap principal use an implicit HTTP bypass | Reintroduces a principal-based superuser and makes the exact-grant audit ambiguous. The bootstrap identity is a configured deployment principal, not a policy bypass. |
| Allow any human to administer policy | Violates default deny and exact resource attachment. The human check is an additional constraint, not a substitute for a grant. |
| Let an Agent hold `administer_policy` | ADR-0013 explicitly forbids Agent policy administration; the validator rejects it at load and publication time. |
| Publish and attach in separate commits | A crash or failed attachment can leave a policy published but not effective, or partially attached across targets. The operation is one state commit. |
| Allow old versions to be reattached for rollback | Removes monotonic-version protection and permits a stale artifact to overwrite newer authority. Rollback is a new higher version with restored rules. |
| Add a detached signature now | No key-management or verification contract exists. Implementing it ad hoc would create a false provenance claim and a new secret-handling surface. |

## Consequences

- A human with the right exact grant can change effective policy while the host is running.
  Later authorization calls use the new attachment immediately; no restart is required.
- Every runtime attempt is visible in the durable authorization journal, including denials
  with the target resource and matched-rule state. Audit failure blocks the mutation.
- A policy publication must include every resource it governs and must exceed the effective
  version of every already-attached target. This is deliberately stricter than the offline
  CLI's publish-then-attach sequence.
- An old policy version cannot be reattached. Recovery from a bad publication is a new,
  higher-version publication with the desired rules.
- The offline CLI still works for initial bootstrap and for operators who deliberately stop
  the host. Runtime administration does not replace it.
- There is still no HTTP revocation route, detached policy signature, key rotation, or
  external audit custody. Those remain production blockers.
- The registry remains single-process and local-disk only. Multi-host administration is not
  supported.

## Tests / evidence

`packages/founder/tests/authorization.test.ts`:

- `requires an exact human administer_policy grant` proves a matching human allow and
  rejects an Agent subject.
- `prevents Agent identities from becoming policy administrators` proves the action cannot
  be delegated to an Agent UUID.

`packages/founder/tests/file-policy-registry.test.ts`:

- `atomically publishes and attaches a higher-version replacement` proves the policy and all
  attachments change together.
- `rejects invalid or stale atomic publications without touching policy state` proves an
  invalid action and a stale version leave the policy file and effective attachment
  unchanged.

`apps/host/tests/http-host.test.ts`:

- `publishes an exact-granted replacement that immediately decides later authorization`
  uses a non-bootstrap human principal, observes the `administer_policy` allow in the durable
  journal, and proves a later protected read is decided by the new policy.
- `denies an unauthorized principal and mismatched action, resource, or scope` proves an
  Agent is denied, a different action/resource is denied, and a multi-target scope with one
  missing grant is denied without publishing any candidate.
- `rejects malformed, unsigned, unsupported, or schema-invalid publications without applying
  them` covers an unauthenticated (unsigned-by-request) attempt, malformed JSON, an invalid
  action, version 0, a stale version, byte-identical policy state, and unchanged effective
  attachment.
- `does not mutate policy when the authorization audit append fails` closes the durable
  decision journal, observes a typed denial, and proves no policy or attachment changed.
- `keeps an admin-published replacement and its decision audit across restart` closes and
  reopens the host, reads the same replacement, preserves the audit prefix in order, and
  serves a protected read under the replacement.

The host test also asserts that the serialized policy file and authorization journal do not
contain the bearer token or the `Bearer` scheme. The full workspace gate at this ADR's
implementation commit is 503 passing tests, with schema regeneration producing no diff.
