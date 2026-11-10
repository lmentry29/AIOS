import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  FilePolicyRegistry,
  PolicyAdministrationService,
  type AccessPolicy,
} from '@aios/founder';
import { loadHostConfig } from './config.js';
import { HostConfigError } from './errors.js';

const MAX_POLICY_FILE_BYTES = 256 * 1024;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads an offline policy-provisioning document.
 *
 * Policy administration is intentionally not an HTTP route. ADR-0013 requires that agents
 * cannot administer policies, and the architecture notes require the bootstrap surface to
 * stay out of the general request path. A human operator runs this CLI on the local machine
 * while the host is stopped (the registry holds a single-process lock), which makes both the
 * authority and the audit trail explicit.
 */
export function readPolicyProvisioningDocument(filePath: string): PolicyProvisioningDocument {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new HostConfigError('Policy provisioning path must be absolute.');
  }
  const resolved = resolve(filePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new HostConfigError('Policy provisioning file could not be read.');
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new HostConfigError('Policy provisioning file must be a regular, unlinked file.');
  }
  if (stats.size > MAX_POLICY_FILE_BYTES) {
    throw new HostConfigError('Policy provisioning file exceeds the 256 KiB size limit.');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new HostConfigError('Policy provisioning file must be owner-only (chmod 600).');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    throw new HostConfigError('Policy provisioning file is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new HostConfigError('Policy provisioning document must be an object.');
  for (const key of Object.keys(parsed)) {
    if (key !== 'policy' && key !== 'attach_to') {
      throw new HostConfigError(`Policy provisioning document contains an unsupported field "${key}".`);
    }
  }
  if (!isRecord(parsed.policy)) throw new HostConfigError('Field "policy" must be an object.');
  if (!Array.isArray(parsed.attach_to) || parsed.attach_to.length === 0) {
    throw new HostConfigError('Field "attach_to" must list at least one resource UUID.');
  }
  if (parsed.attach_to.length > 64) {
    throw new HostConfigError('Field "attach_to" must list at most 64 resources.');
  }
  const attached = parsed.attach_to.map((value) => {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new HostConfigError('Every "attach_to" entry must be a resource UUID.');
    }
    return value;
  });
  if (new Set(attached).size !== attached.length) {
    throw new HostConfigError('Field "attach_to" must not repeat a resource UUID.');
  }
  return { policy: parsed.policy as unknown as AccessPolicy, attach_to: attached };
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
  const registry = new FilePolicyRegistry({ filePath: config.policy_file });
  try {
    const administration = new PolicyAdministrationService(
      config.bootstrap_principal_id,
      registry,
      registry,
    );
    await administration.publish(document.policy, config.bootstrap_principal_id);
    for (const resourceId of document.attach_to) {
      await administration.attach(resourceId, document.policy.policy_id, config.bootstrap_principal_id);
    }
    return { policy_id: document.policy.policy_id, attached: [...document.attach_to] };
  } finally {
    registry.close();
  }
}
