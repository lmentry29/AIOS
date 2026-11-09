# ADR-0013 — Default-Deny, Resource-Attached Authorization

## Status
**Accepted — founder-directed implementation decision, 2026-11-08.** This ADR settles the authorization semantics and security boundary. It does not claim that the full identity, policy-administration, persistence, or audit infrastructure is implemented.

## Context

The Canonical Entity schema has an optional `access_policy` UUID placeholder, but no ratified policy model. AGENTS.md correctly prohibited filling that gap casually. The founder has now explicitly directed that authorization be resolved as part of completing AIOS. A concrete, conservative model is required before orchestration can be treated as a trusted execution boundary.

## Decision

### 1. Default deny

Every protected operation requires an authorization decision. Missing resource policy, missing policy record, unavailable policy resolver, malformed request, or absence of a matching allow rule MUST result in denial. No implicit allow path exists.

### 2. Resource-attached policies

A protected resource's `access_policy` field identifies the policy governing that resource. A resource without an `access_policy` reference is inaccessible through protected operations until a policy is attached through the trusted policy-administration path.

A policy contains explicit rules with:
- effect: `allow` or `deny`;
- exact subject identifiers (human principal or Agent entity ID);
- exact action identifiers;
- exact resource entity IDs.

The initial action vocabulary includes `intake`, `dispatch`, `execute`, `coordinate`, `read_status`, and `read_evidence`. New action identifiers require explicit policy configuration and review; they do not create implicit grants.

Wildcards, role expansion, group inheritance, and pattern-based resource grants are not part of v1. They require a separate ADR and security analysis.

### 3. Evaluation semantics

A request is authorized only when at least one rule matches the exact subject, action, and resource and no matching rule has effect `deny`. Explicit deny overrides allow. Matching is case-sensitive and exact.

### 4. Identity and ownership are separate

The caller's authenticated identity MUST be established by a trusted host identity subsystem before it reaches the policy evaluator. A caller-supplied string is not proof of identity. The kernel therefore requires an explicit actor ID, but a production API MUST derive that ID from a validated session/token rather than trusting request-body fields.

`owner_id`, `created_by`, and `assigned_agent` are accountability/provenance/execution fields, not authorization grants. Ownership MUST NOT create an implicit bypass.

### 5. Policy administration and lifecycle

Policy creation, attachment, replacement, revocation, and audit are privileged operations. Policies are immutable once published; a policy change creates a new policy identity/version and changes the resource reference through the trusted administration path. There is no self-service or agent-controlled privilege escalation.

The initial policy-administration principal and bootstrap mechanism MUST be configured out-of-band by the deployment owner. The bootstrap principal MUST be a human principal, never an Agent UUID; an Agent must not publish, attach, replace, or revoke policies. No universal in-band superuser or implicit founder bypass is defined.

### 6. Audit

Every authorization decision and every policy lifecycle change MUST produce a durable audit record containing request ID, actor, action, resource, policy ID/version, decision, reason, and timestamp. Audit storage MUST be append-only and protected from modification by the principal whose action is being audited.

## Implementation consequences

- The existing `AuthorizationService` in `@aios/founder` implements exact matching, default deny, deny-overrides, input validation, and fail-closed policy resolution.
- The current evaluator accepts immutable policy configuration at construction. `PolicyAdministrationService` restricts publish/attach/revoke to a configured human bootstrap principal; Agent UUIDs are rejected. It delegates each operation to a port whose implementation must atomically persist state and append audit. No concrete durable administration port is supplied yet; the evaluator is not a persistent policy registry.
- `FounderInterface` authorizes canonical-entity and learning-memory content reads with `read_evidence`; decision creation requires `intake` on a configured protected decision-collection resource; decision reads require `read_evidence` on that collection. Denied reads return no protected records, and denied writes fail closed.
- Orchestration requires explicit requester identity and calls the authorization port for intake, dispatch, execution, coordination, status reads, and execution-evidence reads. Evidence reads are authorized against the parent Task's resource policy.
- Production deployment remains blocked until authenticated identity, durable policy storage and administration, policy attachment/revocation controls, durable decision audit, and security testing are implemented.
- The access-policy field remains a UUID reference; this ADR does not silently redefine Canonical Entity schemas or add an unreviewed persisted entity subtype.

## Security properties and limits

This model intentionally prefers false denials over accidental grants. It does not by itself defend against a compromised host process, malicious policy administrator, forged identity supplied by an untrusted host, or mutation of an in-memory policy configuration before service construction. Those risks require the production identity, deployment, persistence, and operational controls listed above.

## Alternatives rejected

- **Owner-implies-access:** rejected because ownership and authority are distinct in the Canonical Object Model.
- **Default allow when no policy exists:** rejected because newly created or partially migrated resources would be exposed.
- **Wildcard subjects/actions/resources:** rejected because broad grants are difficult to review and revoke safely.
- **Caller-selected provider or permission:** rejected because requesters must not select their own authority or provider implementation.
- **Implicit founder superuser:** rejected because it creates an unreviewed bypass and makes auditability ambiguous. Bootstrap authority is deployment configuration, not a hidden runtime exception.
