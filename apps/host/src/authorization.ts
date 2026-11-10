import type { AuthorizationService, FounderAuthorizationPort, FounderAuthorizationRequest } from '@aios/founder';
import { currentRequestId } from './request-context.js';

/**
 * The one authorization boundary in the process.
 *
 * Founder and Orchestration both receive this adapter, so there is exactly one evaluator,
 * one resource-policy resolution path, and one append-only decision audit chain. Wiring two
 * independent `AuthorizationService` instances over the same registry would be a silent
 * divergence risk: a policy change would be observed by one surface and not the other.
 *
 * The adapter adds no semantics. ADR-0013 is enforced by `AuthorizationService`: default
 * deny, exact subject/action/resource matching, explicit deny wins, no wildcard or
 * owner-implied grants, and fail-closed auditing. When called inside a host request, the
 * adapter supplies that request's id as the decision correlation id; otherwise the evaluator
 * generates one.
 */
export class SharedAuthorizationBoundary implements FounderAuthorizationPort {
  constructor(private readonly service: AuthorizationService) {}

  async authorize(request: FounderAuthorizationRequest): Promise<boolean> {
    const requestId = currentRequestId();
    return this.service.authorize({
      actor_id: request.actor_id,
      action: request.action,
      resource_id: request.resource_id,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    });
  }

  /** Ops/diagnostics access to the evaluator; carries no extra authority. */
  get evaluator(): AuthorizationService {
    return this.service;
  }
}
