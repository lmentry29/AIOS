import { randomUUID } from 'node:crypto';

export type AccessAction = 'intake' | 'dispatch' | 'execute' | 'coordinate' | 'cancel' | 'resume' | 'retry' | 'read_status' | 'read_evidence' | 'administer_policy';

export interface AccessRule {
  effect: 'allow' | 'deny';
  subject_ids: readonly string[];
  actions: readonly AccessAction[];
  resource_ids: readonly string[];
}

export interface AccessPolicy {
  policy_id: string;
  version: number;
  rules: readonly AccessRule[];
}

export interface AccessRequest {
  actor_id: string;
  action: AccessAction;
  resource_id: string;
  request_id?: string;
}

export interface AuthorizationDecisionAudit {
  /** Correlation id: the guarded host operation's request id when one exists. */
  request_id: string;
  actor_id: string | null;
  action: string | null;
  resource_id: string | null;
  policy_id: string | null;
  policy_version: number | null;
  decision: 'allow' | 'deny';
  /** Fixed reason code, e.g. matching_allow, explicit_deny, no_matching_allow. */
  reason: string;
  /** Zero-based index of the decisive rule in the resolved policy; null for default deny. */
  matched_rule_index?: number | null;
  /** Effect of the decisive rule; null when no rule decided the outcome. */
  matched_rule_effect?: 'allow' | 'deny' | null;
  timestamp: string;
}

export interface AccessPolicyStore {
  get(policyId: string): Promise<AccessPolicy | undefined>;
}

export interface AuthorizationAuditStore {
  /** Append-only durable sink in production. Implementations must reject mutation/deletion. */
  append(record: AuthorizationDecisionAudit): Promise<void>;
}

export type AccessPolicyResolver = (resourceId: string) => Promise<string | undefined>;

export interface PolicyAdministrationPort {
  /** Implementations must atomically persist the immutable policy and its audit event. */
  publish(policy: AccessPolicy, actorId: string): Promise<void>;
  /** Implementations must atomically attach the policy reference and append its audit event. */
  attach(resourceId: string, policyId: string, actorId: string): Promise<void>;
  /** Implementations must atomically remove the resource reference and append its audit event. */
  revoke(resourceId: string, actorId: string): Promise<void>;
}

export class PolicyAdministrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyAdministrationError';
  }
}

/**
 * Privileged policy lifecycle facade. The configured bootstrap principal must be
 * provisioned out-of-band; actorId must come from a trusted host identity subsystem.
 * Storage and audit are delegated to one transactional administration port.
 */
export class PolicyAdministrationService {
  constructor(
    private readonly bootstrapPrincipalId: string,
    private readonly policies: AccessPolicyStore,
    private readonly administration: PolicyAdministrationPort,
  ) {
    if (!isHumanPrincipal(bootstrapPrincipalId)) {
      throw new PolicyAdministrationError('Bootstrap principal must be a valid actor identifier.');
    }
  }

  async publish(policy: AccessPolicy, actorId: string): Promise<void> {
    this.assertBootstrapPrincipal(actorId);
    // Validate and snapshot before the first await. Never pass a caller-owned mutable
    // policy object across the asynchronous administration boundary.
    const validated = new StaticAccessPolicyStore([policy]);
    const snapshot = await validated.get(policy.policy_id);
    if (!snapshot) throw new PolicyAdministrationError('Validated policy snapshot could not be created.');
    if (await this.policies.get(snapshot.policy_id)) {
      throw new PolicyAdministrationError('Published policies are immutable; publish a new policy ID for every change.');
    }
    await this.administration.publish(snapshot, actorId);
  }

  async attach(resourceId: string, policyId: string, actorId: string): Promise<void> {
    this.assertBootstrapPrincipal(actorId);
    if (!isUuid(resourceId) || !isUuid(policyId)) {
      throw new PolicyAdministrationError('Policy attachment requires valid resource and policy UUIDs.');
    }
    const policy = await this.policies.get(policyId);
    if (!policy || policy.policy_id !== policyId || !isUuid(policy.policy_id)
      || !Number.isSafeInteger(policy.version) || policy.version < 1) {
      throw new PolicyAdministrationError('Cannot attach a missing, mismatched, or invalid published policy.');
    }
    await this.administration.attach(resourceId, policyId, actorId);
  }

  async revoke(resourceId: string, actorId: string): Promise<void> {
    this.assertBootstrapPrincipal(actorId);
    if (!isUuid(resourceId)) throw new PolicyAdministrationError('Policy revocation requires a valid resource UUID.');
    await this.administration.revoke(resourceId, actorId);
  }

  private assertBootstrapPrincipal(actorId: string): void {
    if (!isHumanPrincipal(actorId) || actorId !== this.bootstrapPrincipalId) {
      throw new PolicyAdministrationError('Policy lifecycle changes are restricted to the configured bootstrap principal.');
    }
  }
}


/** In-memory test/development sink. Not a durable production audit store. */
export class InMemoryAuthorizationAuditStore implements AuthorizationAuditStore {
  private readonly records: AuthorizationDecisionAudit[] = [];

  async append(record: AuthorizationDecisionAudit): Promise<void> {
    this.records.push({ ...record });
  }

  list(): AuthorizationDecisionAudit[] {
    return this.records.map((record) => ({ ...record }));
  }
}

/** Immutable bootstrap policy store. A durable implementation can satisfy AccessPolicyStore. */
export class StaticAccessPolicyStore implements AccessPolicyStore {
  private readonly policies = new Map<string, AccessPolicy>();

  constructor(policies: readonly AccessPolicy[]) {
    for (const policy of policies) {
      if (!isRecord(policy) || !hasOnlyFields(policy, POLICY_FIELDS)) {
        throw new Error('Access policy contains an unsupported field.');
      }
      if (!isUuid(policy.policy_id)) throw new Error(`Invalid access policy ID "${policy.policy_id}".`);
      if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
        throw new Error(`Access policy "${policy.policy_id}" requires a positive integer version.`);
      }
      if (this.policies.has(policy.policy_id)) throw new Error(`Duplicate access policy "${policy.policy_id}".`);
      if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
        throw new Error(`Access policy "${policy.policy_id}" must contain at least one rule.`);
      }
      for (const rule of policy.rules as readonly AccessRule[]) {
        if (!isRecord(rule) || !hasOnlyFields(rule, RULE_FIELDS)) {
          throw new Error(`Access policy "${policy.policy_id}" contains an unsupported rule field.`);
        }
        if (!Array.isArray(rule.subject_ids) || !rule.subject_ids.every((id: unknown) => typeof id === 'string')
          || !Array.isArray(rule.actions) || !rule.actions.every((action: unknown) => typeof action === 'string')
          || !Array.isArray(rule.resource_ids) || !rule.resource_ids.every((id: unknown) => typeof id === 'string')) {
          throw new Error(`Every rule in access policy "${policy.policy_id}" must define string subjects, actions, and resources.`);
        }
        if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new Error(`Invalid effect in access policy "${policy.policy_id}".`);
        if (!rule.subject_ids.length || !rule.actions.length || !rule.resource_ids.length) {
          throw new Error(`Every rule in access policy "${policy.policy_id}" must define subjects, actions, and resources.`);
        }
        if (rule.subject_ids.some((id: string) => !isActorRef(id)) || rule.resource_ids.some((id: string) => !isUuid(id))) {
          throw new Error(`Access policy "${policy.policy_id}" contains invalid subject or resource IDs.`);
        }
        if (rule.actions.some((action: string) => !isAccessAction(action))) {
          throw new Error(`Access policy "${policy.policy_id}" contains an unsupported action.`);
        }
        if (rule.actions.includes('administer_policy')
          && rule.subject_ids.some((id: string) => !isHumanPrincipal(id))) {
          throw new Error(`Access policy "${policy.policy_id}" may grant administer_policy only to human principals.`);
        }
      }
      this.policies.set(policy.policy_id, Object.freeze({
        policy_id: policy.policy_id,
        version: policy.version,
        rules: Object.freeze(policy.rules.map((rule) => Object.freeze({
          ...rule,
          subject_ids: Object.freeze([...rule.subject_ids]),
          actions: Object.freeze([...rule.actions]),
          resource_ids: Object.freeze([...rule.resource_ids]),
        }))),
      }));
    }
  }

  async get(policyId: string): Promise<AccessPolicy | undefined> {
    return this.policies.get(policyId);
  }
}

/**
 * Exact-match, default-deny authorization with mandatory decision auditing.
 * Missing policies, invalid inputs, resolver failures, and audit-sink failures deny.
 * Any matching deny overrides all matching allows; no owner or role bypass exists.
 */

export interface PolicyLifecycleAuditEvent {
  event_id: string;
  operation: 'publish' | 'attach' | 'revoke';
  actor_id: string;
  policy_id: string;
  policy_version: number;
  resource_id?: string;
  previous_policy_id?: string;
  timestamp: string;
}

/** In-memory policy registry/attachment index for tests and local development only. */
export class InMemoryPolicyRegistry implements AccessPolicyStore, PolicyAdministrationPort {
  private readonly policies = new Map<string, AccessPolicy>();
  private readonly resourcePolicies = new Map<string, string>();
  private readonly events: PolicyLifecycleAuditEvent[] = [];

  async get(policyId: string): Promise<AccessPolicy | undefined> {
    return this.policies.get(policyId);
  }

  async resolve(resourceId: string): Promise<string | undefined> {
    return this.resourcePolicies.get(resourceId);
  }

  async publish(policy: AccessPolicy, actorId: string): Promise<void> {
    if (!isHumanPrincipal(actorId)) throw new PolicyAdministrationError('Policy publication requires an authenticated human administrator.');
    new StaticAccessPolicyStore([policy]);
    if (this.policies.has(policy.policy_id)) {
      throw new PolicyAdministrationError('Published policies are immutable; publish a new policy ID.');
    }
    this.policies.set(policy.policy_id, Object.freeze({
      policy_id: policy.policy_id,
      version: policy.version,
      rules: Object.freeze(policy.rules.map((rule) => Object.freeze({
        ...rule,
        subject_ids: Object.freeze([...rule.subject_ids]),
        actions: Object.freeze([...rule.actions]),
        resource_ids: Object.freeze([...rule.resource_ids]),
      }))),
    }));
    this.events.push({
      event_id: randomUUID(),
      operation: 'publish',
      actor_id: actorId,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      timestamp: new Date().toISOString(),
    });
  }

  async attach(resourceId: string, policyId: string, actorId: string): Promise<void> {
    if (!isHumanPrincipal(actorId)) throw new PolicyAdministrationError('Policy attachment requires an authenticated human administrator.');
    const policy = this.policies.get(policyId);
    if (!isUuid(resourceId) || !policy) throw new PolicyAdministrationError('Cannot attach an invalid or unpublished policy.');
    const previousPolicyId = this.resourcePolicies.get(resourceId);
    this.resourcePolicies.set(resourceId, policyId);
    this.events.push({
      event_id: randomUUID(),
      operation: 'attach',
      actor_id: actorId,
      policy_id: policyId,
      policy_version: policy.version,
      resource_id: resourceId,
      ...(previousPolicyId ? { previous_policy_id: previousPolicyId } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  async revoke(resourceId: string, actorId: string): Promise<void> {
    if (!isHumanPrincipal(actorId) || !isUuid(resourceId)) throw new PolicyAdministrationError('Policy revocation requires an authenticated human administrator and valid resource UUID.');
    const policyId = this.resourcePolicies.get(resourceId);
    if (!policyId) throw new PolicyAdministrationError('Resource has no attached policy to revoke.');
    const policy = this.policies.get(policyId);
    if (!policy) throw new PolicyAdministrationError('Attached policy is missing from the registry.');
    this.resourcePolicies.delete(resourceId);
    this.events.push({
      event_id: randomUUID(),
      operation: 'revoke',
      actor_id: actorId,
      policy_id: policyId,
      policy_version: policy.version,
      resource_id: resourceId,
      timestamp: new Date().toISOString(),
    });
  }

  listAudit(): PolicyLifecycleAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export class AuthorizationService {
  constructor(
    private readonly policies: AccessPolicyStore,
    private readonly resolvePolicyId: AccessPolicyResolver,
    private readonly audit: AuthorizationAuditStore,
  ) {}

  async authorize(request: AccessRequest): Promise<boolean> {
    const requestId = request && typeof request.request_id === 'string' && isUuid(request.request_id)
      ? request.request_id
      : randomUUID();
    const actorId = request && typeof request.actor_id === 'string' ? request.actor_id : null;
    const action = request && typeof request.action === 'string' ? request.action : null;
    const resourceId = request && typeof request.resource_id === 'string' ? request.resource_id : null;
    let policyId: string | null = null;
    let policyVersion: number | null = null;
    let matchedRuleIndex: number | null = null;
    let matchedRuleEffect: 'allow' | 'deny' | null = null;
    let decision: 'allow' | 'deny' = 'deny';
    let reason = 'invalid_request';

    try {
      if (!request || typeof request !== 'object'
        || !actorId || !isActorRef(actorId)
        || !resourceId || !isUuid(resourceId)
        || !action || !isAccessAction(action)) {
        reason = 'invalid_request';
      } else {
        const resolved = await this.resolvePolicyId(resourceId);
        if (!resolved || !isUuid(resolved)) {
          reason = 'resource_policy_missing_or_invalid';
        } else {
          policyId = resolved;
          const policy = await this.policies.get(resolved);
          if (!policy || policy.policy_id !== resolved || !isUuid(policy.policy_id)
            || !Array.isArray(policy.rules) || !Number.isSafeInteger(policy.version) || policy.version < 1) {
            reason = 'policy_missing_or_invalid';
          } else {
            policyVersion = policy.version;
            const rules = policy.rules as readonly AccessRule[];
            const matching = rules
              .map((rule, index) => ({ rule, index }))
              .filter(({ rule }) =>
                rule.subject_ids.includes(actorId)
                && rule.actions.includes(action)
                && rule.resource_ids.includes(resourceId),
              );
            const denying = matching.find(({ rule }) => rule.effect === 'deny');
            const allowing = matching.find(({ rule }) => rule.effect === 'allow');
            if (denying) {
              reason = 'explicit_deny';
              matchedRuleIndex = denying.index;
              matchedRuleEffect = 'deny';
            } else if (allowing) {
              decision = 'allow';
              reason = 'matching_allow';
              matchedRuleIndex = allowing.index;
              matchedRuleEffect = 'allow';
            } else {
              reason = 'no_matching_allow';
            }
          }
        }
      }
    } catch {
      decision = 'deny';
      reason = 'policy_resolution_or_evaluation_error';
    }

    const auditRecord: AuthorizationDecisionAudit = {
      request_id: requestId,
      actor_id: actorId,
      action,
      resource_id: resourceId,
      policy_id: policyId,
      policy_version: policyVersion,
      decision,
      reason,
      matched_rule_index: matchedRuleIndex,
      matched_rule_effect: matchedRuleEffect,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.audit.append(auditRecord);
    } catch {
      // An authorization decision without its mandatory audit record is not valid.
      return false;
    }
    return decision === 'allow';
  }
}

const POLICY_FIELDS = new Set(['policy_id', 'version', 'rules']);
const RULE_FIELDS = new Set(['effect', 'subject_ids', 'actions', 'resource_ids']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isActorRef(value: string): boolean {
  return isUuid(value) || isHumanPrincipal(value);
}

function isHumanPrincipal(value: string): boolean {
  return /^human:[^\s:*]+$/.test(value);
}

function isAccessAction(value: string): value is AccessAction {
  return ['intake', 'dispatch', 'execute', 'coordinate', 'cancel', 'resume', 'retry', 'read_status', 'read_evidence', 'administer_policy'].includes(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
