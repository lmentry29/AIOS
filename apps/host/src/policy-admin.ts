import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  FilePolicyRegistry,
  PolicyAdministrationService,
  type AccessPolicy,
} from '@aios/founder';
import { loadHostConfig } from './config.js';
import { HostConfigError, HostHttpError } from './errors.js';

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

type ParseFailure = (message: string) => Error;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttachTo(value: unknown, fail: ParseFailure): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('Field "attach_to" must list at least one resource UUID.');
  }
  if (value.length > MAX_ATTACH_TARGETS) {
    throw fail(`Field "attach_to" must list at most ${MAX_ATTACH_TARGETS} resources.`);
  }
  const attached = value.map((entry) => {
    if (typeof entry !== 'string' || !UUID.test(entry)) {
      throw fail('Every "attach_to" entry must be a resource UUID.');
    }
    return entry;
  });
  if (new Set(attached).size !== attached.length) {
    throw fail('Field "attach_to" must not repeat a resource UUID.');
  }
  return attached;
}

function parseProvisioningDocument(parsed: unknown, fail: ParseFailure): PolicyProvisioningDocument {
  if (!isRecord(parsed)) throw fail('Policy provisioning document must be an object.');
  for (const key of Object.keys(parsed)) {
    if (key !== 'policy' && key !== 'attach_to') {
      throw fail(`Policy provisioning document contains an unsupported field "${key}".`);
    }
  }
  if (!isRecord(parsed.policy)) throw fail('Field "policy" must be an object.');
  return {
    policy: parsed.policy as unknown as AccessPolicy,
    attach_to: parseAttachTo(parsed.attach_to, fail),
  };
}

/**
 * Reads an offline policy-provisioning document.
 *
 * `aios-host publish-policy` remains the out-of-band bootstrap path. The runtime
 * `POST /v1/policies` path parses the same envelope but additionally requires an
 * authenticated human and an exact `administer_policy` grant on every target resource.
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
  return parseProvisioningDocument(parsed, (message) => new HostConfigError(message));
}

/**
 * Parses the authenticated runtime publication envelope. This checks only the envelope and
 * target list; the immutable policy itself is validated by the durable registry before any
 * write, so an invalid artifact is rejected without touching policy state.
 */
export function parseRuntimePolicyPublication(body: Record<string, unknown>): PolicyProvisioningDocument {
  return parseProvisioningDocument(body, (message) => new HostHttpError(400, 'invalid_policy', message));
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
