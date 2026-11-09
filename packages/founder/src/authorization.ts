export type AccessAction = 'intake' | 'dispatch' | 'execute' | 'coordinate' | 'read_status';

export interface AccessRule {
  effect: 'allow' | 'deny';
  subject_ids: readonly string[];
  actions: readonly AccessAction[];
  resource_ids: readonly string[];
}

export interface AccessPolicy {
  policy_id: string;
  rules: readonly AccessRule[];
}

export interface AccessRequest {
  actor_id: string;
  action: AccessAction;
  resource_id: string;
}

export interface AccessPolicyStore {
  get(policyId: string): Promise<AccessPolicy | undefined>;
}

export type AccessPolicyResolver = (resourceId: string) => Promise<string | undefined>;

/** Immutable bootstrap policy store. A durable implementation can satisfy AccessPolicyStore. */
export class StaticAccessPolicyStore implements AccessPolicyStore {
  private readonly policies = new Map<string, AccessPolicy>();

  constructor(policies: readonly AccessPolicy[]) {
    for (const policy of policies) {
      if (!isUuid(policy.policy_id)) throw new Error(`Invalid access policy ID "${policy.policy_id}".`);
      if (this.policies.has(policy.policy_id)) throw new Error(`Duplicate access policy "${policy.policy_id}".`);
      if (policy.rules.length === 0) throw new Error(`Access policy "${policy.policy_id}" must contain at least one rule.`);
      for (const rule of policy.rules) {
        if (rule.effect !== 'allow' && rule.effect !== 'deny') throw new Error(`Invalid effect in access policy "${policy.policy_id}".`);
        if (!rule.subject_ids.length || !rule.actions.length || !rule.resource_ids.length) {
          throw new Error(`Every rule in access policy "${policy.policy_id}" must define subjects, actions, and resources.`);
        }
        if (rule.subject_ids.some((id) => !isActorRef(id)) || rule.resource_ids.some((id) => !isUuid(id))) {
          throw new Error(`Access policy "${policy.policy_id}" contains invalid subject or resource IDs.`);
        }
        if (rule.actions.some((action) => !isAccessAction(action))) {
          throw new Error(`Access policy "${policy.policy_id}" contains an unsupported action.`);
        }
      }
      this.policies.set(policy.policy_id, Object.freeze({
        policy_id: policy.policy_id,
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
 * Exact-match authorization evaluator.
 *
 * Security semantics: no resource policy means deny; no matching allow means deny;
 * any matching deny overrides all matching allows. There are no wildcard subjects,
 * actions, resources, implicit owner bypasses, or role expansion. The policy store is
 * injected so production can replace the immutable bootstrap store with a durable,
 * audited implementation.
 */
export class AuthorizationService {
  constructor(
    private readonly policies: AccessPolicyStore,
    private readonly resolvePolicyId: AccessPolicyResolver,
  ) {}

  async authorize(request: AccessRequest): Promise<boolean> {
    if (!request || typeof request !== 'object') return false;
    if (!isActorRef(request.actor_id) || !isUuid(request.resource_id) || !isAccessAction(request.action)) return false;
    let policyId: string | undefined;
    let policy: AccessPolicy | undefined;
    try {
      policyId = await this.resolvePolicyId(request.resource_id);
      if (!policyId || !isUuid(policyId)) return false;
      policy = await this.policies.get(policyId);
    } catch {
      return false;
    }
    if (!policy || !Array.isArray(policy.rules)) return false;

    try {
      const matching = policy.rules.filter((rule) =>
        rule.subject_ids.includes(request.actor_id)
        && rule.actions.includes(request.action)
        && rule.resource_ids.includes(request.resource_id),
      );
      if (matching.some((rule) => rule.effect === 'deny')) return false;
      return matching.some((rule) => rule.effect === 'allow');
    } catch {
      return false;
    }
  }
}

function isActorRef(value: string): boolean {
  return isUuid(value) || /^human:[^\s:*]+$/.test(value);
}

function isAccessAction(value: string): value is AccessAction {
  return ['intake', 'dispatch', 'execute', 'coordinate', 'read_status'].includes(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
