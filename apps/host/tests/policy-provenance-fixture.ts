import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTrustRoot, generateSigningKey } from "../src/execution/artifact-signing.js";
import { PolicyProvenanceAuthority } from "../src/policy-provenance.js";

export interface PolicyAuthorityFixture {
  authority: PolicyProvenanceAuthority;
  config: {
    trust_root_file: string;
    signing_key_file: string;
    key_id: string;
  };
}

/** Generates a disposable trust root and owner-only signer for host tests. */
export function createPolicyAuthority(
  directory: string,
  options: {
    now?: Date;
    status?: "trusted" | "revoked";
    notBefore?: Date;
    notAfter?: Date;
  } = {},
): PolicyAuthorityFixture {
  const trustRootPath = join(directory, "policy-trust-root.json");
  const privateKeyPath = join(directory, "policy-signing-key.pem");
  if (existsSync(trustRootPath) && existsSync(privateKeyPath)) {
    const trustRoot = JSON.parse(readFileSync(trustRootPath, "utf8")) as {
      keys: Array<{ key_id: string }>;
    };
    const keyId = trustRoot.keys[0]?.key_id;
    if (typeof keyId !== "string") throw new Error("Existing policy trust root has no key.");
    return {
      authority: PolicyProvenanceAuthority.fromFiles({
        trust_root_file: trustRootPath,
        private_key_file: privateKeyPath,
        key_id: keyId,
      }),
      config: { trust_root_file: trustRootPath, signing_key_file: privateKeyPath, key_id: keyId },
    };
  }
  const key = generateSigningKey();
  const now = options.now ?? new Date();
  const trustRoot = createTrustRoot({
    key_id: key.key_id,
    public_key_pem: key.public_key_pem,
    not_before: (options.notBefore ?? new Date(now.getTime() - 60_000)).toISOString(),
    not_after: (options.notAfter ?? new Date(now.getTime() + 24 * 60 * 60 * 1000)).toISOString(),
    purpose: "policy",
    ...(options.status === undefined ? {} : { status: options.status }),
  });
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(privateKeyPath, key.private_key_pem, { mode: 0o600 });
  const authority = PolicyProvenanceAuthority.fromFiles({
    trust_root_file: trustRootPath,
    private_key_file: privateKeyPath,
    key_id: key.key_id,
    ...(options.now === undefined ? {} : { now: () => options.now as Date }),
  });
  return {
    authority,
    config: {
      trust_root_file: trustRootPath,
      signing_key_file: privateKeyPath,
      key_id: key.key_id,
    },
  };
}
