# ADR-0024 — Authorized Runtime Policy Retirement

## Status

**Accepted** (2026-11-10). This ADR adds the action identifier `revoke_policy` and an
authenticated runtime retirement surface. It does not amend ADR-0013's default-deny,
exact-match, deny-overrides, human-only administration, or durable-audit rules, and it does
not weaken ADR-0023's publication contract. It is the explicit review ADR-0013 requires
before a new action identifier becomes grantable.

## Context

ADR-0023 made policy publication a runtime operation: a human with an exact
`administer_policy` grant can publish and attach an immutable replacement while the host is
running. It recorded, as a known limit, that there was **no HTTP revocation route**. A
version that must stop deciding therefore had to be replaced by a new, higher version that
omits it, or the operator had to stop the host and edit state.

Neither is the operation ADR-0013 describes. ADR-0013 requires policy *revocation* to be
privileged, human-only, and durably audited; it does not require revocation to be performed
by publication, and it does not forbid an authenticated runtime path. A version found to be
wrong should be able to stop deciding without inventing a replacement artifact and without an
outage.

`FilePolicyRegistry` already stores the pieces retirement needs: immutable policy records,
per-resource attachments, and an atomically committed lifecycle audit. The durable
authorization journal already records every allow and deny. This ADR adds no new storage
substrate.

## Decision

### 1. A distinct action, never implied

`revoke_policy` is added to the exact `AccessAction` vocabulary. It is a separate grant from
`administer_policy`: holding one never implies the other, and neither is implied by ownership,
the bootstrap identity, or any other action.

Like `administer_policy`, a rule that grants `revoke_policy` may name only human subjects
(`human:*`). Policy loading and publication reject the rule if any subject is an Agent UUID,
so an Agent cannot be made a policy administrator by configuration.

### 2. Route and envelope

`POST /v1/policies/:policyId/revoke` requires:

1. a verified bearer session;
2. an authenticated human principal; and
3. an exact `revoke_policy` allow on **every** resource in `targets`.

The body is exactly:

```json
{ "targets": ["<resource-uuid>", "<resource-uuid>"] }
```

Unknown fields are rejected. `targets` is a list of at most 256 distinct resource UUIDs. It is
not a filter: it must be the **complete** set of resources whose policy history references the
version, including resources where the version is a retained fallback rather than the
currently effective one. An empty, partial, or superset list is rejected.

All target decisions are evaluated before the registry looks the policy up, so a caller
without the grant learns nothing about whether the version exists.

### 3. Retirement semantics

The durable registry moves to schema v2 with two additions:

- `resource_policy_history`: resource UUID → ordered policy-version history, newest last.
  This record is what makes fallback possible.
- `retired_policies`: policy UUIDs that may never decide again.

A v1 state file is read as a one-entry history per attached resource. Migration invents no
fallback: a resource that had one attachment keeps exactly that one.

Retirement is one atomic commit against a cloned state:

1. the version is removed from every affected resource's history;
2. each affected resource is reattached to the **newest remaining** version in its own
   history;
3. a resource whose history becomes empty loses its attachment entirely;
4. one `policy_lifecycle` event with `operation: "revoke"` is appended per affected resource;
5. the version is added to `retired_policies`.

Policy records, remaining attachments, and lifecycle events therefore become visible
together. A rejected request never reaches `commit()`, so the previous bytes remain on disk.

A retired version remains readable for audit but cannot be reattached. Recovery from a bad
retirement is a new publication with a new UUID and a higher version — not un-retiring.

### 4. Fallback and deny

After retirement, authorization for an affected resource uses the newest remaining version in
that resource's own history. If no version remains, the resource has no attachment and the
existing default-deny path returns `resource_policy_missing_or_invalid`. There is no implicit
grant, no synthesized empty allow policy, and no fallback to another resource's policy.

### 5. Audit

Each target authorization evaluation uses the existing `AuthorizationService` and durable
`DurableAuthorizationAuditStore`; `revoke_policy` is added to that store's action allowlist.
Records carry the request correlation id, principal, action, target resource, deciding policy
id/version, decision, fixed reason, matched rule, and timestamp.

An audit append failure turns the decision into a deny. The route returns `403
policy_revoke_denied` and never calls `retirePolicy`, so the mutation does not take effect.
Lifecycle events are committed atomically with policy state.

### 6. Errors

| Condition | Status | Code |
|---|---|---|
| Missing, malformed, or unknown credential | 401 | `unauthenticated` |
| Any target lacks an exact `revoke_policy` grant | 403 | `policy_revoke_denied` |
| Authenticated non-human principal | 403 | `human_principal_required` |
| Malformed path policy id or envelope | 400 | `invalid_policy_id` / `invalid_targets` |
| Unknown policy version | 404 | `policy_not_found` |
| Version referenced by no resource history | 409 | `policy_not_attached` |
| Version already in `retired_policies` | 409 | `policy_already_revoked` |
| Target set is not the exact complete reference set | 409 | `target_scope_mismatch` |

Success is `200` with `{ "policy_id": ..., "retired": true, "targets": [...] }`. A rejected
attempt leaves policy state, attachments, and on-disk bytes unchanged.

### 7. Offline symmetry

`aios-host revoke-policy --config <path> --revocation <path>` performs the same registry
operation for a stopped host. The revocation document is an owner-only (`0600`), regular,
unlinked JSON file of at most 256 KiB containing exactly `{ policy_id, targets }`; unknown
fields are rejected. It runs through `PolicyAdministrationService` as the configured bootstrap
principal, exactly like `publish-policy`. The host must be stopped because the registry holds
a single-process lock.

### 8. Signature boundary

The trust model is unchanged: authority is the verified session plus the exact grant. There is
no detached policy signature and no signed revocation artifact. A caller-supplied signature
field is rejected by the strict envelope rather than carried.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Require a replacement publication instead of revocation | Forces the operator to invent a policy artifact to express "this version must stop deciding", and leaves the bad version attached until the replacement is ready. |
| Let `administer_policy` imply `revoke_policy` | Collapses two distinct authorities. ADR-0013's model is exact grants; publication and retirement are separable powers. |
| Accept a partial target list and retire only those resources | Silently changes some resources while leaving others under a version the caller declared wrong. The complete-set requirement makes the blast radius explicit and auditable. |
| Delete the policy record | Destroys the audit trail and lets the same UUID be re-published. Retirement is a marker, not a deletion. |
| Allow reattaching a retired version | Defeats the permanence of the decision and permits silent revival of revoked authority. |
| Look up affected resources server-side instead of requiring `targets` | The caller could then retire a version without presenting the full scope it is exercising, and authorization would be checked on a set it never named. |
| Skip the durable decision journal for revocations | ADR-0013 requires durable audit of policy revocation. |

## Consequences

- A wrongly published version can stop deciding while the host runs, with fallback to the
  newest remaining version or a fail-closed deny. No restart, replacement artifact, or
  hand-edited file is required.
- Retiring a version requires enumerating every resource that references it, including
  retained fallbacks. A caller who cannot enumerate the scope does not hold the authority to
  retire it.
- Publication remains the only way to *add* authority; retirement can only narrow it.
- Registry state is now v2, and an older host cannot read it. Downgrade is not supported; a v1
  file migrates on load and is rewritten on the next mutation.
- Still no detached policy signature, key rotation, external audit custody, or multi-host
  administration.

## Tests / evidence

`packages/founder/tests/authorization.test.ts`:

- `requires an exact human revoke_policy grant` proves the action is exact, is not implied by
  `administer_policy`, and cannot be granted to an Agent subject.
- `publishes, attaches, authorizes, and revokes through the in-memory admin registry` proves
  the lifecycle audit order `publish, attach, publish, attach, revoke`.

`packages/founder/tests/file-policy-registry.test.ts`:

- `retires a version with fallback and denies when no version remains` proves fallback to the
  newest remaining version and the default deny once the history is empty, across reopen.
- `rejects invalid, unattached, mismatched, and repeated retirements without touching state`
  proves every typed rejection leaves the policy file byte-identical.

`apps/host/tests/policy-admin.test.ts`:

- `retires an attached policy through the offline bootstrap path` proves the owner-only
  document and bootstrap facade.

`apps/host/tests/http-host.test.ts`:

- `retires an exact-granted version, falls back, then denies when none remains` proves the
  authorized path changes later decisions and records revoked lifecycle events.
- `rejects unknown, unattached, invalid-shape, and out-of-scope retirements without changing
  state` proves typed 400/404/409 handling and an unchanged registry, including an ungranted
  human, an Agent, and a caller naming only part of the scope all denied with
  `policy_revoke_denied` before lookup.
- `does not mutate policy when the revocation authorization audit append fails` proves an
  audit append failure blocks the retirement.
- `keeps a retirement and its fallback decision across restart` proves the retirement marker,
  fallback attachment, and audit prefix survive close and reopen.

The full workspace gate at this ADR's implementation commit is **513 passing tests** (host
**106** with **51** loopback-HTTP tests, founder **61**), with schema regeneration producing
no diff.
