import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  FilePolicyRegistry,
  MAX_POLICY_REVOCATION_TARGETS,
  PolicyAdministrationService,
  type AccessPolicy,
} from "@aios/founder";
import { loadHostConfig } from "./config.js";
import { HostConfigError, HostHttpError } from "./errors.js";
import { PolicyProvenanceAuthority } from "./policy-provenance.js";

const MAX_POLICY_FILE_BYTES = 256 * 1024;
const MAX_ATTACH_TARGETS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PolicyProvisioningDocument {
  policy: AccessPolicy;
  /** Resource UUIDs the policy is attached to. */
  attach_to: string[];
}

export interface PolicyProvisioningResult {
  policy_id: string;
  attached: string[];
}

export interface PolicyRevocationDocument {
  policy_id: string;
  /** Exact complete set of resources that reference the policy version. */
  targets: string[];
}

export interface PolicyRevocationResult {
  policy_id: string;
  retired: true;
  targets: string[];
}

type ParseFailure = (message: string) => Error;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttachTo(value: unknown, fail: ParseFailure): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('Field "attach_to" must list at least one resource UUID.');
  }
  if (value.length > MAX_ATTACH_TARGETS) {
    throw fail(`Field "attach_to" must list at most ${MAX_ATTACH_TARGETS} resources.`);
  }
  const attached = value.map((entry) => {
    if (typeof entry !== "string" || !UUID.test(entry)) {
      throw fail('Every "attach_to" entry must be a resource UUID.');
    }
    return entry;
  });
  if (new Set(attached).size !== attached.length) {
    throw fail('Field "attach_to" must not repeat a resource UUID.');
  }
  return attached;
}

function parseProvisioningDocument(
  parsed: unknown,
  fail: ParseFailure,
): PolicyProvisioningDocument {
  if (!isRecord(parsed)) throw fail("Policy provisioning document must be an object.");
  for (const key of Object.keys(parsed)) {
    if (key !== "policy" && key !== "attach_to") {
      throw fail(`Policy provisioning document contains an unsupported field "${key}".`);
    }
  }
  if (!isRecord(parsed.policy)) throw fail('Field "policy" must be an object.');
  return {
    policy: parsed.policy as unknown as AccessPolicy,
    attach_to: parseAttachTo(parsed.attach_to, fail),
  };
}

function parseRevocationTargets(value: unknown, fail: ParseFailure): string[] {
  if (!Array.isArray(value)) {
    throw fail('Field "targets" must be an array of resource UUIDs.');
  }
  if (value.length > MAX_POLICY_REVOCATION_TARGETS) {
    throw fail(`Field "targets" must list at most ${MAX_POLICY_REVOCATION_TARGETS} resources.`);
  }
  const targets = value.map((entry) => {
    if (typeof entry !== "string" || !UUID.test(entry)) {
      throw fail('Every "targets" entry must be a resource UUID.');
    }
    return entry;
  });
  if (new Set(targets).size !== targets.length) {
    throw fail('Field "targets" must not repeat a resource UUID.');
  }
  return targets;
}

function parseRevocationDocument(parsed: unknown, fail: ParseFailure): PolicyRevocationDocument {
  if (!isRecord(parsed)) throw fail("Policy revocation document must be an object.");
  for (const key of Object.keys(parsed)) {
    if (key !== "policy_id" && key !== "targets") {
      throw fail(`Policy revocation document contains an unsupported field "${key}".`);
    }
  }
  if (typeof parsed.policy_id !== "string" || !UUID.test(parsed.policy_id)) {
    throw fail('Field "policy_id" must be a policy UUID.');
  }
  return {
    policy_id: parsed.policy_id,
    targets: parseRevocationTargets(parsed.targets, fail),
  };
}

function readOwnerOnlyJson(filePath: string, label: string): unknown {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new HostConfigError(`${label} path must be absolute.`);
  }
  const resolved = resolve(filePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new HostConfigError(`${label} could not be read.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new HostConfigError(`${label} must be a regular, unlinked file.`);
  }
  if (stats.size > MAX_POLICY_FILE_BYTES) {
    throw new HostConfigError(`${label} exceeds the 256 KiB size limit.`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new HostConfigError(`${label} must be owner-only (chmod 600).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new HostConfigError(`${label} is not valid JSON.`);
  }
  return parsed;
}

/**
 * Reads an offline policy-provisioning document.
 *
 * `aios-host publish-policy` remains the out-of-band bootstrap path. The runtime
 * `POST /v1/policies` path parses the same envelope but additionally requires an
 * authenticated human and an exact `administer_policy` grant on every target resource.
 */
export function readPolicyProvisioningDocument(filePath: string): PolicyProvisioningDocument {
  const parsed = readOwnerOnlyJson(filePath, "Policy provisioning file");
  return parseProvisioningDocument(parsed, (message) => new HostConfigError(message));
}

/** Reads the offline bootstrap retirement document. */
export function readPolicyRevocationDocument(filePath: string): PolicyRevocationDocument {
  const parsed = readOwnerOnlyJson(filePath, "Policy revocation file");
  return parseRevocationDocument(parsed, (message) => new HostConfigError(message));
}

/**
 * Parses the authenticated runtime publication envelope. This checks only the envelope and
 * target list; the immutable policy itself is validated by the durable registry before any
 * write, so an invalid artifact is rejected without touching policy state.
 */
export function parseRuntimePolicyPublication(
  body: Record<string, unknown>,
): PolicyProvisioningDocument {
  return parseProvisioningDocument(
    body,
    (message) => new HostHttpError(400, "invalid_policy", message),
  );
}

/** Parses the authenticated runtime retirement envelope; the policy id is in the path. */
export function parseRuntimePolicyRevocation(body: Record<string, unknown>): string[] {
  if (!isRecord(body)) {
    throw new HostHttpError(400, "invalid_targets", "The revocation body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (key !== "targets") {
      throw new HostHttpError(
        400,
        "invalid_targets",
        `Revocation body contains an unsupported field "${key}".`,
      );
    }
  }
  return parseRevocationTargets(
    body.targets,
    (message) => new HostHttpError(400, "invalid_targets", message),
  );
}

/**
 * Retires one immutable policy version through the offline bootstrap facade. The host must
 * be stopped because the durable registry holds a single-process lock.
 */
export async function revokePolicies(options: {
  configPath: string;
  revocationPath: string;
}): Promise<PolicyRevocationResult> {
  const config = loadHostConfig(options.configPath);
  const document = readPolicyRevocationDocument(options.revocationPath);
  const registry = new FilePolicyRegistry({ filePath: config.policy_file });
  try {
    const administration = new PolicyAdministrationService(
      config.bootstrap_principal_id,
      registry,
      registry,
    );
    await administration.retirePolicy(
      document.policy_id,
      document.targets,
      config.bootstrap_principal_id,
    );
    return { policy_id: document.policy_id, retired: true, targets: [...document.targets] };
  } finally {
    registry.close();
  }
}

/**
 * Publishes one immutable policy and attaches it to the listed resources, using the same
 * durable hash-chained registry the host later evaluates against.
 *
 * Returns the audit-visible identifier only; no policy contents or credentials are printed.
 */
export async function provisionPolicies(options: {
  configPath: string;
  provisioningPath: string;
}): Promise<PolicyProvisioningResult> {
  const config = loadHostConfig(options.configPath);
  const document = readPolicyProvisioningDocument(options.provisioningPath);
  const authority = PolicyProvenanceAuthority.fromFiles({
    trust_root_file: config.policy_provenance.trust_root_file,
    private_key_file: config.policy_provenance.signing_key_file,
    key_id: config.policy_provenance.key_id,
  });
  const signed = await authority.signPolicy(document.policy);
  const registry = new FilePolicyRegistry({ filePath: config.policy_file });
  try {
    const administration = new PolicyAdministrationService(
      config.bootstrap_principal_id,
      registry,
      registry,
    );
    await administration.publish(signed, config.bootstrap_principal_id);
    for (const resourceId of document.attach_to) {
      await administration.attach(resourceId, signed.policy_id, config.bootstrap_principal_id);
    }
    return { policy_id: signed.policy_id, attached: [...document.attach_to] };
  } finally {
    registry.close();
  }
}
