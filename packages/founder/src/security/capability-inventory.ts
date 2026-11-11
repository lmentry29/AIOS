/**
 * Closed inventory of authorization capabilities.
 *
 * AIOS authorization is exact-resource and default-deny (ADR-0013). A capability that is
 * not listed here has no meaning and must never be treated as an allow. This table is the
 * single source of truth for the runtime action vocabulary; policy construction and
 * evaluation both consult it rather than maintaining parallel string lists.
 */
export interface CapabilityDefinition {
  /** Administrative capabilities may only be granted to human principals. */
  readonly human_only: boolean;
  /** Every capability is evaluated against one exact resource id. Wildcards never exist. */
  readonly resource_scope: 'exact_resource';
  readonly summary: string;
}

export const CAPABILITY_INVENTORY = Object.freeze({
  intake: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Create or admit work into the orchestration boundary.',
  },
  dispatch: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Dispatch an existing Task to an Agent.',
  },
  execute: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Execute a Task through a configured execution adapter.',
  },
  coordinate: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Coordinate multiple Agents on one Task.',
  },
  cancel: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Cancel an active Task or run.',
  },
  resume: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Resume suspended work.',
  },
  retry: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Retry a failed operation under its existing identity and scope.',
  },
  read_status: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Read lifecycle or operational status.',
  },
  read_evidence: {
    human_only: false,
    resource_scope: 'exact_resource',
    summary: 'Read evidence or content from one exact resource.',
  },
  administer_policy: {
    human_only: true,
    resource_scope: 'exact_resource',
    summary: 'Publish and attach immutable authorization policy.',
  },
  revoke_policy: {
    human_only: true,
    resource_scope: 'exact_resource',
    summary: 'Retire an authorization policy from every exact target.',
  },
  administer_sessions: {
    human_only: true,
    resource_scope: 'exact_resource',
    summary: 'Rotate or revoke trusted host sessions.',
  },
} as const satisfies Record<string, CapabilityDefinition>);

for (const definition of Object.values(CAPABILITY_INVENTORY)) Object.freeze(definition);

export type AccessAction = keyof typeof CAPABILITY_INVENTORY;

export const ACCESS_ACTIONS: readonly AccessAction[] = Object.freeze(
  Object.keys(CAPABILITY_INVENTORY) as AccessAction[],
);

export type HumanOnlyAccessAction = {
  [Action in AccessAction]: (typeof CAPABILITY_INVENTORY)[Action]['human_only'] extends true
    ? Action
    : never;
}[AccessAction];

export const HUMAN_ONLY_ACTIONS: ReadonlySet<HumanOnlyAccessAction> = new Set(
  ACCESS_ACTIONS.filter(
    (action): action is HumanOnlyAccessAction => CAPABILITY_INVENTORY[action].human_only,
  ),
);

/**
 * Looks up one capability. Unknown values return `undefined`; there is deliberately no
 * fallback, guest capability, wildcard, or default-allow entry.
 */
export function capabilityFor(value: unknown): CapabilityDefinition | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(CAPABILITY_INVENTORY, value)) {
    return undefined;
  }
  return CAPABILITY_INVENTORY[value as AccessAction];
}

export function isAccessAction(value: unknown): value is AccessAction {
  return capabilityFor(value) !== undefined;
}

export function isHumanOnlyAction(value: unknown): value is HumanOnlyAccessAction {
  return isAccessAction(value) && HUMAN_ONLY_ACTIONS.has(value as HumanOnlyAccessAction);
}
