import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthorizationService, InMemoryAuthorizationAuditStore, PolicyAdministrationService, PolicyAdministrationError, InMemoryPolicyRegistry, StaticAccessPolicyStore, type AccessPolicy } from '../src/authorization.js';

describe('AuthorizationService', () => {
  const policyId = randomUUID();
  const resourceId = randomUUID();
  const actorId = 'human:founder';
  const policy: AccessPolicy = {
    policy_id: policyId,
    version: 1,
    rules: [{
      effect: 'allow',
      subject_ids: [actorId],
      actions: ['execute', 'read_evidence'],
      resource_ids: [resourceId],
    }],
  };

  it('allows only an exact subject/action/resource match', async () => {
    const auth = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => policyId, new InMemoryAuthorizationAuditStore());
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(true);
    expect(await auth.authorize({ actor_id: 'human:other', action: 'execute', resource_id: resourceId })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'coordinate', resource_id: resourceId })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: randomUUID() })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'read_evidence', resource_id: resourceId })).toBe(true);
  });

  it('requires an exact human administer_policy grant', async () => {
    const adminPolicy: AccessPolicy = {
      policy_id: randomUUID(),
      version: 1,
      rules: [{
        effect: 'allow',
        subject_ids: [actorId],
        actions: ['administer_policy'],
        resource_ids: [resourceId],
      }],
    };
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(
      new StaticAccessPolicyStore([adminPolicy]),
      async () => adminPolicy.policy_id,
      audit,
    );

    expect(await auth.authorize({ actor_id: actorId, action: 'administer_policy', resource_id: resourceId })).toBe(true);
    expect(await auth.authorize({ actor_id: 'human:other', action: 'administer_policy', resource_id: resourceId })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'administer_policy', resource_id: randomUUID() })).toBe(false);
    expect(audit.list()).toContainEqual(expect.objectContaining({
      action: 'administer_policy',
      decision: 'allow',
      reason: 'matching_allow',
      matched_rule_index: 0,
      matched_rule_effect: 'allow',
    }));
    const adminRule = adminPolicy.rules[0];
    if (!adminRule) throw new Error('Admin policy fixture rule missing.');
    expect(() => new StaticAccessPolicyStore([{
      ...adminPolicy,
      rules: [{ ...adminRule, subject_ids: [randomUUID()] }],
    }])).toThrow(/human/);
  });

  it('denies when the resource has no policy or references an unknown policy', async () => {
    const noPolicy = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => undefined, new InMemoryAuthorizationAuditStore());
    const unknownPolicy = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => randomUUID(), new InMemoryAuthorizationAuditStore());
    const request = { actor_id: actorId, action: 'execute' as const, resource_id: resourceId };
    expect(await noPolicy.authorize(request)).toBe(false);
    expect(await unknownPolicy.authorize(request)).toBe(false);
  });

  it('denies a policy store response whose policy ID does not match the resource reference', async () => {
    const mismatched = { ...policy, policy_id: randomUUID() };
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(
      { get: async () => mismatched },
      async () => policyId,
      audit,
    );

    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(false);
    expect(audit.list()).toMatchObject([
      { decision: 'deny', policy_id: policyId, policy_version: null, reason: 'policy_missing_or_invalid' },
    ]);
  });

  it('applies explicit deny over a matching allow', async () => {
    const withDeny: AccessPolicy = {
      policy_id: policyId,
      version: 1,
      rules: [
        ...policy.rules,
        {
          effect: 'deny',
          subject_ids: [actorId],
          actions: ['execute'],
          resource_ids: [resourceId],
        },
      ],
    };
    const auth = new AuthorizationService(new StaticAccessPolicyStore([withDeny]), async () => policyId, new InMemoryAuthorizationAuditStore());
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(false);
  });


  it('fails closed when policy resolution throws or the actor identity is malformed', async () => {
    const unavailable = new AuthorizationService({ get: async () => { throw new Error('policy store unavailable'); } }, async () => policyId, new InMemoryAuthorizationAuditStore());
    expect(await unavailable.authorize({
      actor_id: actorId,
      action: 'execute',
      resource_id: resourceId,
    })).toBe(false);

    const auth = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => policyId, new InMemoryAuthorizationAuditStore());
    expect(await auth.authorize({
      actor_id: '*',
      action: 'execute',
      resource_id: resourceId,
    })).toBe(false);
  });


  it('fails closed for malformed runtime requests and policy identifiers', async () => {
    const auth = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => 'not-a-uuid', new InMemoryAuthorizationAuditStore());
    await expect(auth.authorize(null as never)).resolves.toBe(false);
    await expect(auth.authorize({
      actor_id: actorId,
      action: 'execute',
      resource_id: resourceId,
    })).resolves.toBe(false);
  });





  it('publishes, attaches, authorizes, and revokes through the in-memory admin registry', async () => {
    const registry = new InMemoryPolicyRegistry();
    const admin = new PolicyAdministrationService(actorId, registry, registry);
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(registry, (id) => registry.resolve(id), audit);

    await admin.publish(policy, actorId);
    await admin.attach(resourceId, policyId, actorId);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(true);

    const replacement: AccessPolicy = { ...policy, policy_id: randomUUID(), version: 1 };
    await admin.publish(replacement, actorId);
    await admin.attach(resourceId, replacement.policy_id, actorId);
    expect(registry.listAudit()[3]?.previous_policy_id).toBe(policyId);

    await admin.revoke(resourceId, actorId);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(false);
    expect(registry.listAudit().map((event) => event.operation)).toEqual(['publish', 'attach', 'publish', 'attach', 'revoke']);
  });

  it('restricts policy lifecycle operations to the out-of-band bootstrap principal', async () => {
    const events: string[] = [];
    const admin = new PolicyAdministrationService(actorId, new StaticAccessPolicyStore([policy]), {
      publish: async (next, actor) => { events.push(`publish:${next.policy_id}:${actor}`); },
      attach: async (resource, id, actor) => { events.push(`attach:${resource}:${id}:${actor}`); },
      revoke: async (resource, actor) => { events.push(`revoke:${resource}:${actor}`); },
    });
    const nextPolicy: AccessPolicy = { ...policy, policy_id: randomUUID(), version: 1 };

    await expect(admin.publish(nextPolicy, 'human:attacker')).rejects.toBeInstanceOf(PolicyAdministrationError);
    await admin.publish(nextPolicy, actorId);
    await admin.attach(resourceId, policyId, actorId);
    await admin.revoke(resourceId, actorId);

    expect(events).toEqual([
      `publish:${nextPolicy.policy_id}:${actorId}`,
      `attach:${resourceId}:${policyId}:${actorId}`,
      `revoke:${resourceId}:${actorId}`,
    ]);
  });

  it('snapshots a policy before awaiting the asynchronous publication adapter', async () => {
    let published: AccessPolicy | undefined;
    const mutable = {
      policy_id: randomUUID(),
      version: 1,
      rules: [{
        effect: 'allow' as const,
        subject_ids: [actorId],
        actions: ['execute' as const],
        resource_ids: [resourceId],
      }],
    };
    const admin = new PolicyAdministrationService(actorId, { get: async () => undefined }, {
      publish: async (next) => { published = next; },
      attach: async () => undefined,
      revoke: async () => undefined,
    });

    const mutableRule = mutable.rules[0];
    if (!mutableRule) throw new Error('Mutable policy fixture rule missing.');
    const pending = admin.publish(mutable, actorId);
    mutableRule.actions[0] = 'coordinate';
    await pending;

    expect(published?.rules[0]?.actions).toEqual(['execute']);
    expect(Object.isFrozen(published?.rules[0]?.actions)).toBe(true);
  });

  it('prevents Agent identities from becoming policy administrators', async () => {
    const agentId = randomUUID();
    const registry = new InMemoryPolicyRegistry();

    expect(() => new PolicyAdministrationService(agentId, registry, registry))
      .toThrow(PolicyAdministrationError);

    const admin = new PolicyAdministrationService(actorId, registry, registry);
    await expect(admin.publish(policy, agentId)).rejects.toBeInstanceOf(PolicyAdministrationError);
    await expect(admin.attach(resourceId, policyId, agentId)).rejects.toBeInstanceOf(PolicyAdministrationError);
    await expect(admin.revoke(resourceId, agentId)).rejects.toBeInstanceOf(PolicyAdministrationError);
    await expect(registry.publish(policy, agentId)).rejects.toBeInstanceOf(PolicyAdministrationError);
  });

  it('refuses to attach a policy that has not been published', async () => {
    const admin = new PolicyAdministrationService(actorId, new StaticAccessPolicyStore([policy]), {
      publish: async () => undefined,
      attach: async () => undefined,
      revoke: async () => undefined,
    });
    await expect(admin.attach(resourceId, randomUUID(), actorId)).rejects.toBeInstanceOf(PolicyAdministrationError);
  });

  it('refuses to attach when the policy store returns a different policy identity', async () => {
    const mismatched = { ...policy, policy_id: randomUUID() };
    const admin = new PolicyAdministrationService(actorId, {
      get: async () => mismatched,
    }, {
      publish: async () => undefined,
      attach: async () => undefined,
      revoke: async () => undefined,
    });

    await expect(admin.attach(resourceId, policyId, actorId)).rejects.toBeInstanceOf(PolicyAdministrationError);
  });

  it('snapshots and freezes policy configuration at construction', async () => {
    const mutable = {
      policy_id: randomUUID(),
      version: 1,
      rules: [{
        effect: 'allow' as const,
        subject_ids: [actorId],
        actions: ['execute'] as const,
        resource_ids: [resourceId],
      }],
    };
    const store = new StaticAccessPolicyStore([mutable]);
    const mutableRule = mutable.rules[0];
    if (!mutableRule) throw new Error('Policy fixture rule missing.');
    mutableRule.effect = 'deny';
    const stored = await store.get(mutable.policy_id);

    expect(stored?.rules[0]?.effect).toBe('allow');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.rules)).toBe(true);
  });

  it('records every allow and deny decision with policy version and reason', async () => {
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => policyId, audit);
    await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId });
    await auth.authorize({ actor_id: 'human:other', action: 'execute', resource_id: resourceId });

    expect(audit.list()).toMatchObject([
      { decision: 'allow', policy_id: policyId, policy_version: 1, reason: 'matching_allow' },
      { decision: 'deny', policy_id: policyId, policy_version: 1, reason: 'no_matching_allow' },
    ]);
  });

  it('fails closed when the mandatory audit sink is unavailable', async () => {
    const auth = new AuthorizationService(
      new StaticAccessPolicyStore([policy]),
      async () => policyId,
      { append: async () => { throw new Error('audit unavailable'); } },
    );
    await expect(auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId }))
      .resolves.toBe(false);
  });

  it('rejects wildcard-like policy subjects and invalid resource IDs at construction', () => {
    expect(() => new StaticAccessPolicyStore([{
      policy_id: randomUUID(),
      version: 1,
      rules: [{
        effect: 'allow',
        subject_ids: ['*'],
        actions: ['execute'],
        resource_ids: [resourceId],
      }],
    }])).toThrow(/invalid subject or resource IDs/);
  });

  it('rejects empty or malformed policy configuration', () => {
    expect(() => new AuthorizationService(new StaticAccessPolicyStore([{
      policy_id: 'not-a-uuid',
      rules: policy.rules,
    }]), async () => policyId)).toThrow(/Invalid access policy ID/);
    expect(() => new AuthorizationService(new StaticAccessPolicyStore([{
      policy_id: randomUUID(),
      version: 1,
      rules: [],
    }]), async () => policyId)).toThrow(/at least one rule/);
  });
});

describe('Authorization audit correlation and grant binding', () => {
  const policyId = randomUUID();
  const resourceId = randomUUID();
  const actorId = 'human:founder';
  const policy: AccessPolicy = {
    policy_id: policyId,
    version: 1,
    rules: [{
      effect: 'allow',
      subject_ids: [actorId],
      actions: ['execute'],
      resource_ids: [resourceId],
    }],
  };

  function service(): { auth: AuthorizationService; audit: InMemoryAuthorizationAuditStore } {
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(
      new StaticAccessPolicyStore([policy]),
      async () => policyId,
      audit,
    );
    return { auth, audit };
  }

  it('uses the caller request id and records the exact matching grant', async () => {
    const { auth, audit } = service();
    const requestId = randomUUID();
    expect(await auth.authorize({
      actor_id: actorId,
      action: 'execute',
      resource_id: resourceId,
      request_id: requestId,
    })).toBe(true);

    expect(audit.list()).toMatchObject([{
      request_id: requestId,
      actor_id: actorId,
      action: 'execute',
      resource_id: resourceId,
      policy_id: policyId,
      policy_version: 1,
      decision: 'allow',
      reason: 'matching_allow',
      matched_rule_index: 0,
      matched_rule_effect: 'allow',
    }]);
  });

  it('records explicit deny with its deny rule, and default deny without a grant', async () => {
    const denyPolicy: AccessPolicy = {
      ...policy,
      rules: [
        ...policy.rules,
        {
          effect: 'deny',
          subject_ids: [actorId],
          actions: ['execute'],
          resource_ids: [resourceId],
        },
      ],
    };
    const audit = new InMemoryAuthorizationAuditStore();
    const auth = new AuthorizationService(
      new StaticAccessPolicyStore([denyPolicy]),
      async () => policyId,
      audit,
    );

    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId }))
      .toBe(false);
    expect(await auth.authorize({ actor_id: 'human:other', action: 'execute', resource_id: resourceId }))
      .toBe(false);

    expect(audit.list()).toMatchObject([
      {
        decision: 'deny',
        reason: 'explicit_deny',
        matched_rule_index: 1,
        matched_rule_effect: 'deny',
      },
      {
        decision: 'deny',
        reason: 'no_matching_allow',
        matched_rule_index: null,
        matched_rule_effect: null,
      },
    ]);
  });

  it('generates a UUID correlation id when the guarded operation has none', async () => {
    const { auth, audit } = service();
    await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId });
    expect(audit.list()[0]?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('keeps the audit record to the fixed, non-secret field set', async () => {
    const { auth, audit } = service();
    await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId });
    const record = audit.list()[0];
    expect(record).toBeDefined();
    expect(Object.keys(record as object).sort()).toEqual([
      'action',
      'actor_id',
      'decision',
      'matched_rule_effect',
      'matched_rule_index',
      'policy_id',
      'policy_version',
      'reason',
      'request_id',
      'resource_id',
      'timestamp',
    ]);
    expect(JSON.stringify(record)).not.toContain('token');
    expect(JSON.stringify(record)).not.toContain('authorization');
  });

  it('fails closed for both allow and deny when the audit sink rejects the record', async () => {
    const auth = new AuthorizationService(
      new StaticAccessPolicyStore([policy]),
      async () => policyId,
      { append: async () => { throw new Error('audit unavailable'); } },
    );
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId }))
      .toBe(false);
    expect(await auth.authorize({ actor_id: 'human:other', action: 'execute', resource_id: resourceId }))
      .toBe(false);
  });
});
