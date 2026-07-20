/**
 * Audit triage policy gate (SEC-02 — governance slice).
 *
 * Asserts security/AUDIT-TRIAGE-POLICY.md is a real triage policy with
 * severity thresholds, suppression rules, quarterly cadence, and an
 * inventory whose suppressed critical/high advisories match
 * security/AUDIT-SUPPRESSIONS.json. Examples must be real (vite GHSA).
 *
 * Usage (repo root):
 *   node scripts/check-audit-triage-policy.mjs
 *   pnpm audit:policy:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPRESSIONS_PATH,
  validateSuppressions,
} from "./run-audit-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const POLICY_PATH = path.join(
  REPO_ROOT,
  "security",
  "AUDIT-TRIAGE-POLICY.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_POLICY: "audit_policy.missing_policy",
  MISSING_SECTION: "audit_policy.missing_section",
  MISSING_SUPPRESSIONS: "audit_policy.missing_suppressions",
  INVENTORY_MISMATCH: "audit_policy.inventory_mismatch",
  WORKED_EXAMPLE: "audit_policy.worked_example_incomplete",
  QUARTERLY: "audit_policy.quarterly_incomplete",
  CVE_ONLY: "audit_policy.cve_only_scope",
  SOVEREIGNTY: "audit_policy.sovereignty_incomplete",
});

export const REQUIRED_SECTIONS = Object.freeze([
  "## Severity thresholds",
  "## Suppression rules",
  "## Quarterly review cadence",
  "## Initial advisory inventory",
]);

/** Real advisory that must appear as a worked suppress example. */
export const REQUIRED_EXAMPLE_IDS = Object.freeze([
  "1123525",
  "GHSA-fx2h-pf6j-xcff",
  "CVE-2026-53571",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "audit_policy.check", ...event })}\n`,
  );
}

/**
 * Collect GHSA / CVE / numeric advisory ids mentioned in backticks.
 * @param {string} body
 */
export function extractAdvisoryIds(body) {
  const ids = new Set();
  for (const m of body.matchAll(/`(GHSA-[a-z0-9-]+)`/gi)) {
    ids.add(m[1]);
  }
  for (const m of body.matchAll(/`(CVE-\d{4}-\d+)`/gi)) {
    ids.add(m[1]);
  }
  for (const m of body.matchAll(/`(\d{6,})`/g)) {
    ids.add(m[1]);
  }
  return ids;
}

/**
 * @param {{ policyPath?: string, suppressionsPath?: string }} [opts]
 */
export function checkAuditTriagePolicy(opts = {}) {
  const policyPath = opts.policyPath ?? POLICY_PATH;
  const suppressionsPath = opts.suppressionsPath ?? SUPPRESSIONS_PATH;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(policyPath)) {
    failures.push(`${OBLIGATIONS.MISSING_POLICY}:${policyPath}`);
    return { ok: false, failures, suppressions: 0 };
  }
  if (!existsSync(suppressionsPath)) {
    failures.push(`${OBLIGATIONS.MISSING_SUPPRESSIONS}:${suppressionsPath}`);
    return { ok: false, failures, suppressions: 0 };
  }

  const body = readFileSync(policyPath, "utf8");
  const suppressions = validateSuppressions(
    JSON.parse(readFileSync(suppressionsPath, "utf8")),
  );

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      failures.push(`${OBLIGATIONS.MISSING_SECTION}:${section}`);
    }
  }

  // Severity thresholds must block critical and high.
  if (
    !/critical/i.test(body) ||
    !/high/i.test(body) ||
    !/[Bb]locks? merge/.test(body)
  ) {
    failures.push(`${OBLIGATIONS.MISSING_SECTION}:severity_block`);
  }

  // Quarterly cadence with expiry enforcement language.
  if (
    !/quarterly/i.test(body) ||
    !/expiresOn|expired suppressions fail/i.test(body) ||
    !/lastReviewed|nextReviewDue/i.test(body)
  ) {
    failures.push(OBLIGATIONS.QUARTERLY);
  }

  // Worked examples: real vite high + "fix instead" guidance.
  for (const id of REQUIRED_EXAMPLE_IDS) {
    if (!body.includes(id)) {
      failures.push(`${OBLIGATIONS.WORKED_EXAMPLE}:missing:${id}`);
    }
  }
  if (!/do not suppress|fix instead/i.test(body)) {
    failures.push(`${OBLIGATIONS.WORKED_EXAMPLE}:missing_fix_path`);
  }

  // Every suppression in JSON must be named in the policy inventory.
  const mentioned = extractAdvisoryIds(body);
  for (const s of suppressions) {
    const hit = s.advisoryIds.some((id) => mentioned.has(id));
    if (!hit) {
      failures.push(
        `${OBLIGATIONS.INVENTORY_MISMATCH}:suppression_not_in_inventory:${s.advisoryIds[0]}`,
      );
    }
    if (!body.includes(s.package)) {
      failures.push(
        `${OBLIGATIONS.INVENTORY_MISMATCH}:package_not_in_inventory:${s.package}`,
      );
    }
  }

  // Inventory must acknowledge pip cleanliness or list pip suppressions.
  if (!/pip|cloud-orchestrator/i.test(body)) {
    failures.push(`${OBLIGATIONS.INVENTORY_MISMATCH}:missing_pip_surface`);
  }

  // Policy must not be CVE-scan shelfware — triage + gate language required.
  if (
    !/not blind ignore|triage/i.test(body) ||
    !/AUDIT-SUPPRESSIONS\.json/.test(body) ||
    !/run-audit-gate|audit:gate/i.test(body)
  ) {
    failures.push(OBLIGATIONS.CVE_ONLY);
  }

  // Sovereignty / observability contract.
  if (
    !/subjectId/.test(body) ||
    !/never raw learner|metadata about dependencies/i.test(body) ||
    !/outcome/i.test(body)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const ok = failures.length === 0;
  return { ok, failures, suppressions: suppressions.length };
}

function main() {
  const result = checkAuditTriagePolicy();
  emit({
    outcome: result.ok ? "ok" : "fail",
    suppressions: result.suppressions,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) {
      process.stderr.write(`${f}\n`);
    }
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
