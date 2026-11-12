#!/usr/bin/env node
/**
 * High-signal secret scan over tracked files.
 *
 * This is a guardrail, not a replacement for a dedicated scanner or history rewrite. It
 * reads only files Git tracks, caps file size, skips binaries, and reports the file and
 * line without echoing the matched secret value.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_BYTES = 2 * 1024 * 1024;

const patterns = [
  { id: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/ },
  { id: "github-fine-grained", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/ },
  { id: "openai-key", regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "bearer-literal", regex: /\bBearer\s+[A-Za-z0-9._~+/-]{40,}=*/ },
];

const allowed = [
  // Documented placeholders and test sentinels that are not credentials.
  /must-not-cross/,
  /must-not-appear/,
  /token_sha256/,
  /sha256:[a-f0-9]{64}/,
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file.length > 0);

const findings = [];
for (const file of files) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > MAX_BYTES) continue;
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (contents.includes("\0")) continue;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (allowed.some((pattern) => pattern.test(line))) continue;
    for (const pattern of patterns) {
      if (pattern.regex.test(line)) {
        findings.push({ file, line: index + 1, kind: pattern.id });
        break;
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`secret-scan: no findings across ${files.length} tracked files`);
  process.exit(0);
}

for (const finding of findings) {
  console.error(`secret-scan: ${finding.kind} at ${finding.file}:${finding.line}`);
}
console.error(`secret-scan: ${findings.length} finding(s); remove or rotate the credential.`);
process.exit(1);
