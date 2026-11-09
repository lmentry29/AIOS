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

  it('denies when the resource has no policy or references an unknown policy', async () => {
    const noPolicy = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => undefined, new InMemoryAuthorizationAuditStore());
    const unknownPolicy = new AuthorizationService(new StaticAccessPolicyStore([policy]), async () => randomUUID(), new InMemoryAuthorizationAuditStore());
    const request = { actor_id: actorId, action: 'execute' as const, resource_id: resourceId };
    expect(await noPolicy.authorize(request)).toBe(false);
    expect(await unknownPolicy.authorize(request)).toBe(false);
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

    const pending = admin.publish(mutable, actorId);
    mutable.rules[0]!.actions[0] = 'coordinate';
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
