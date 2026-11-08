export type AccessAction = 'intake' | 'execute' | 'coordinate' | 'read_status';

export interface AccessPolicy {
  policy_id: string;
  effect: 'allow' | 'deny';
  subject_ids: readonly string[];
  actions: readonly AccessAction[];
  resource_ids: readonly string[];
}

export interface AccessRequest {
  actor_id: string;
  action: AccessAction;
  resource_id: string;
}

export type AccessPolicyResolver = (resourceId: string) => Promise<string | undefined>;

/**
 * Explicit, exact-match authorization evaluator.
 *
 * Security semantics: no resource policy means deny; no matching allow means deny;
 * an explicit deny overrides every allow. There are no wildcard subjects, actions,
 * resources, implicit owner bypasses, or role expansion. Policy configuration is
 * immutable for the lifetime of this instance and must come from a trusted bootstrap
 * source. This is an in-process evaluator, not a durable policy-management system.
 */
export class AuthorizationService {
  private readonly policies = new Map<string, AccessPolicy>();

  constructor(
    policies: readonly AccessPolicy[],
    private readonly resolvePolicyId: AccessPolicyResolver,
  ) {
    for (const policy of policies) {
      if (!isUuid(policy.policy_id)) throw new Error(`Invalid access policy ID "${policy.policy_id}".`);
      if (this.policies.has(policy.policy_id)) throw new Error(`Duplicate access policy "${policy.policy_id}".`);
      if (!policy.subject_ids.length || !policy.actions.length || !policy.resource_ids.length) {
        throw new Error(`Access policy "${policy.policy_id}" must define subjects, actions, and resources.`);
      }
      this.policies.set(policy.policy_id, Object.freeze({
        ...policy,
        subject_ids: Object.freeze([...policy.subject_ids]),
        actions: Object.freeze([...policy.actions]),
        resource_ids: Object.freeze([...policy.resource_ids]),
      }));
    }
  }

  async authorize(request: AccessRequest): Promise<boolean> {
    if (!request.actor_id.trim() || !request.resource_id.trim()) return false;
    const policyId = await this.resolvePolicyId(request.resource_id);
    if (!policyId) return false;

    const policy = this.policies.get(policyId);
    if (!policy) return false;

    const matching = policy.subject_ids.includes(request.actor_id)
      && policy.actions.includes(request.action)
      && policy.resource_ids.includes(request.resource_id);
    if (!matching) return false;
    return policy.effect === 'allow';
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
