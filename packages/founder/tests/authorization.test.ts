import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthorizationService, type AccessPolicy } from '../src/authorization.js';

describe('AuthorizationService', () => {
  const policyId = randomUUID();
  const resourceId = randomUUID();
  const actorId = 'human:founder';
  const policy: AccessPolicy = {
    policy_id: policyId,
    rules: [{
      effect: 'allow',
      subject_ids: [actorId],
      actions: ['execute'],
      resource_ids: [resourceId],
    }],
  };

  it('allows only an exact subject/action/resource match', async () => {
    const auth = new AuthorizationService([policy], async () => policyId);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(true);
    expect(await auth.authorize({ actor_id: 'human:other', action: 'execute', resource_id: resourceId })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'coordinate', resource_id: resourceId })).toBe(false);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: randomUUID() })).toBe(false);
  });

  it('denies when the resource has no policy or references an unknown policy', async () => {
    const noPolicy = new AuthorizationService([policy], async () => undefined);
    const unknownPolicy = new AuthorizationService([policy], async () => randomUUID());
    const request = { actor_id: actorId, action: 'execute' as const, resource_id: resourceId };
    expect(await noPolicy.authorize(request)).toBe(false);
    expect(await unknownPolicy.authorize(request)).toBe(false);
  });

  it('applies explicit deny over a matching allow', async () => {
    const withDeny: AccessPolicy = {
      policy_id: policyId,
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
    const auth = new AuthorizationService([withDeny], async () => policyId);
    expect(await auth.authorize({ actor_id: actorId, action: 'execute', resource_id: resourceId })).toBe(false);
  });

  it('rejects empty or malformed policy configuration', () => {
    expect(() => new AuthorizationService([{
      policy_id: 'not-a-uuid',
      rules: policy.rules,
    }], async () => policyId)).toThrow(/Invalid access policy ID/);
    expect(() => new AuthorizationService([{
      policy_id: randomUUID(),
      rules: [],
    }], async () => policyId)).toThrow(/at least one rule/);
  });
});
