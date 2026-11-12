import { z } from "zod";
import { CanonicalObjectEntityShape, withCanonicalObjectLifecycle } from "./canonical-object.js";

/**
 * Infrastructure is a Canonical Object subtype, not a sixth entity type (ADR-0018).
 *
 * A record deliberately contains no credential fields. The only link to a credential is
 * `secret_ref`, whose value is an opaque broker entry id. The broker owns the secret and
 * resolves it host-side; no route returns it.
 */
export const InfrastructureSubtype = z.enum([
  "infrastructure_host",
  "infrastructure_endpoint",
  "infrastructure_store",
]);
export type InfrastructureSubtype = z.infer<typeof InfrastructureSubtype>;

export const InfrastructureHealth = z.enum(["unknown", "healthy", "degraded", "unavailable"]);
export type InfrastructureHealth = z.infer<typeof InfrastructureHealth>;

/** Opaque, non-secret broker reference. The referenced value never enters the record. */
export const SecretBrokerRef = z.object({
  entry_id: z.string().uuid(),
  broker: z.literal("host_encrypted_file"),
});
export type SecretBrokerRef = z.infer<typeof SecretBrokerRef>;

// Secret-shaped values are rejected even when they are placed in a field that is supposed
// to be descriptive. This is a second line of defence behind `.strict()`: unknown fields
// such as "password" are rejected outright, while a token pasted into `name` is refused.
const SECRET_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential)\s*[:=]\s*\S+/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PROVIDER_TOKEN =
  /\b(?:AKIA|ASIA|ghp_|gho_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9])[A-Za-z0-9_-]{8,}\b/;

export function containsSecretMaterial(value: string): boolean {
  return (
    SECRET_ASSIGNMENT.test(value) || PRIVATE_KEY_BLOCK.test(value) || PROVIDER_TOKEN.test(value)
  );
}

const SafeText = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => !containsSecretMaterial(value), {
    message: "Infrastructure text must not contain secret-shaped material (ADR-0018)",
  });

/**
 * A non-secret endpoint reference. Credentials, paths, queries and fragments are rejected;
 * connection strings with embedded credentials therefore cannot be stored here.
 */
const SafeEndpoint = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => /^(?:[a-z][a-z0-9+.-]*:\/\/)?[A-Za-z0-9._:[\]-]+(?::\d{1,5})?$/.test(value), {
    message:
      "Infrastructure endpoint must be a scheme/host/port reference without credentials, a path, a query, or a fragment",
  });

const InfrastructureEntityShape = CanonicalObjectEntityShape.extend({
  name: SafeText,
  description: SafeText.optional(),
  entity_subtype: InfrastructureSubtype,
  endpoint: SafeEndpoint.optional(),
  health: InfrastructureHealth,
  /** Opaque broker reference; the secret itself is never a record field. */
  secret_ref: SecretBrokerRef.optional(),
  /** Bounded adapter label, not a provider payload or connection string. */
  adapter: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional(),
  health_checked_at: z.string().datetime().optional(),
})
  // Unknown fields are rejected rather than stripped: a caller cannot smuggle a
  // credential-shaped field past validation and have it silently disappear.
  .strict();

const InfrastructureEntityWithoutParent = InfrastructureEntityShape.refine(
  (entity: z.infer<typeof InfrastructureEntityShape>) => entity.work_hierarchy_parent === undefined,
  {
    message:
      "Infrastructure is not a Work Hierarchy level and must not carry work_hierarchy_parent (ADR-0018)",
  },
);

export const InfrastructureEntity = withCanonicalObjectLifecycle(InfrastructureEntityWithoutParent);
export type InfrastructureEntity = z.infer<typeof InfrastructureEntity>;
