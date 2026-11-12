#!/usr/bin/env node
/**
 * Dependency audit gate with an explicit, documented triage list.
 *
 * `pnpm audit --audit-level high` fails the build for any high advisory, including ones
 * that cannot be patched without a breaking major upgrade. This gate still fails on every
 * high/critical advisory except the ones below, each of which must name the advisory, the
 * affected package, and the compensating control that makes it non-actionable now. Adding
 * an entry is a reviewed security decision, not a way to silence the scanner.
 */
import { execFileSync } from "node:child_process";

const ALLOWED = new Map();

function runAudit() {
  try {
    return execFileSync("pnpm", ["audit", "--prod", "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout =
      typeof error?.stdout === "string" ? error.stdout : error?.stdout?.toString?.("utf8");
    if (stdout && stdout.trim().startsWith("{")) return stdout;
    throw error;
  }
}

const raw = runAudit();
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("audit-policy: could not parse pnpm audit JSON output.");
  process.exit(1);
}

/** Normalizes npm/pnpm audit report shapes into { id, package, severity }. */
function advisories(input) {
  const found = [];
  const vulnerabilities = input?.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === "object") {
    for (const [name, entry] of Object.entries(vulnerabilities)) {
      const severity = String(entry?.severity ?? "unknown");
      const via = Array.isArray(entry?.via) ? entry.via : [];
      const ghsa = via
        .map((item) => (typeof item === "object" && typeof item?.url === "string" ? item.url : ""))
        .map((url) => /GHSA-[0-9a-z-]+/i.exec(url)?.[0])
        .find((id) => id !== undefined);
      found.push({ id: ghsa ?? `npm:${name}`, package: name, severity });
    }
    return found;
  }
  const legacy = input?.advisories;
  if (legacy && typeof legacy === "object") {
    for (const entry of Object.values(legacy)) {
      found.push({
        id: String(entry?.github_advisory_id ?? entry?.id ?? "unknown"),
        package: String(entry?.module_name ?? "unknown"),
        severity: String(entry?.severity ?? "unknown"),
      });
    }
  }
  return found;
}

const blocking = [];
const triaged = [];
for (const finding of advisories(report)) {
  if (finding.severity !== "high" && finding.severity !== "critical") continue;
  const allowed = ALLOWED.get(finding.id);
  if (allowed && allowed.package === finding.package) triaged.push(finding);
  else blocking.push(finding);
}

for (const finding of triaged) {
  console.log(`audit-policy: triaged ${finding.severity} ${finding.package} (${finding.id})`);
}
if (blocking.length > 0) {
  for (const finding of blocking) {
    console.error(`audit-policy: blocking ${finding.severity} ${finding.package} (${finding.id})`);
  }
  process.exit(1);
}
console.log(`audit-policy: no untriaged high or critical advisories (${triaged.length} triaged)`);
