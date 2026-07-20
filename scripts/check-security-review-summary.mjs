/**
 * Adopter security-review summary gate (SEC-01 — publication slice).
 *
 * Asserts docs/security/SECURITY-REVIEW-SUMMARY.md is a real summary of the
 * committed review, not an aspiration: its finding counts (by severity and by
 * closure status) must match the findings register in
 * security/EXTERNAL-REVIEW.md, it must state zero open P0/P1, name a
 * vulnerability reporting channel, and hold the sovereignty posture.
 *
 * Usage (repo root):
 *   node scripts/check-security-review-summary.mjs
 *   pnpm security-summary:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_REVIEW, parseFindings } from "./check-external-review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const SUMMARY = path.join(
  REPO_ROOT,
  "docs",
  "security",
  "SECURITY-REVIEW-SUMMARY.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_SUMMARY: "security_summary.missing_summary",
  MISSING_SECTION: "security_summary.missing_section",
  COUNT_MISMATCH: "security_summary.count_mismatch",
  OPEN_P0P1_NOT_ZERO: "security_summary.open_p0p1_not_zero",
  MISSING_REPORTING_CHANNEL: "security_summary.missing_reporting_channel",
  CVE_ONLY_SCOPE: "security_summary.cve_only_scope",
  SOVEREIGNTY: "security_summary.sovereignty_incomplete",
});

export const REQUIRED_SECTIONS = Object.freeze([
  "## What was reviewed (scope)",
  "## How it was reviewed (methodology)",
  "## What was found (finding counts)",
  "## Closure status",
  "## Reporting a vulnerability",
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "security_summary.check", ...event })}\n`,
  );
}

/**
 * Tally the register findings by severity and by closure status.
 * @param {{ severity: string, status: string }[]} findings
 */
export function tallyFindings(findings) {
  const severity = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const status = { closed: 0, accepted: 0, open: 0 };
  for (const f of findings) {
    if (f.severity in severity) severity[f.severity] += 1;
    if (f.status in status) status[f.status] += 1;
    else status.open += 1;
  }
  const total = findings.length;
  const openP0P1 =
    findings.filter(
      (f) =>
        (f.severity === "P0" || f.severity === "P1") && f.status !== "closed",
    ).length;
  return { severity, status, total, openP0P1 };
}

/**
 * Read the count a summary row asserts, e.g. "| P0 | 2 |" → 2.
 * @param {string} body
 * @param {string} label
 */
export function statedCount(body, label) {
  const re = new RegExp(`\\|\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*\\|\\s*(?:\\*\\*)?(\\d+)`);
  const m = re.exec(body);
  return m ? Number(m[1]) : null;
}

/**
 * @param {{ summaryPath?: string, reviewPath?: string }} [opts]
 */
export function checkSecurityReviewSummary(opts = {}) {
  const summaryPath = opts.summaryPath ?? SUMMARY;
  const reviewPath = opts.reviewPath ?? EXTERNAL_REVIEW;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(summaryPath)) {
    failures.push(`${OBLIGATIONS.MISSING_SUMMARY}:${summaryPath}`);
    return { ok: false, failures };
  }

  const body = readFileSync(summaryPath, "utf8");

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      failures.push(`${OBLIGATIONS.MISSING_SECTION}:${section}`);
    }
  }

  // Cross-check the published counts against the real findings register.
  const review = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : "";
  const tally = tallyFindings(parseFindings(review));

  const checks = [
    ["Total", tally.total],
    ["P0", tally.severity.P0],
    ["P1", tally.severity.P1],
    ["P2", tally.severity.P2],
    ["P3", tally.severity.P3],
  ];
  for (const [label, actual] of checks) {
    const stated = statedCount(body, label);
    if (stated === null) {
      failures.push(`${OBLIGATIONS.COUNT_MISMATCH}:${label}:missing`);
    } else if (stated !== actual) {
      failures.push(
        `${OBLIGATIONS.COUNT_MISMATCH}:${label}:stated=${stated}:actual=${actual}`,
      );
    }
  }

  const statedClosed = statedCount(body, "Closed[^|]*");
  if (statedClosed !== null && statedClosed !== tally.status.closed) {
    failures.push(
      `${OBLIGATIONS.COUNT_MISMATCH}:Closed:stated=${statedClosed}:actual=${tally.status.closed}`,
    );
  }
  const statedAccepted = statedCount(body, "Accepted[^|]*");
  if (statedAccepted !== null && statedAccepted !== tally.status.accepted) {
    failures.push(
      `${OBLIGATIONS.COUNT_MISMATCH}:Accepted:stated=${statedAccepted}:actual=${tally.status.accepted}`,
    );
  }

  // The register must have no open P0/P1, and the summary must say so.
  const statedOpen = statedCount(body, "Open");
  if (tally.openP0P1 !== 0) {
    failures.push(`${OBLIGATIONS.OPEN_P0P1_NOT_ZERO}:register=${tally.openP0P1}`);
  }
  if (
    !/no open P0\/P1|there are no open P0\/P1|zero open P0\/P1/i.test(body) ||
    (statedOpen !== null && statedOpen !== tally.status.open)
  ) {
    failures.push(`${OBLIGATIONS.OPEN_P0P1_NOT_ZERO}:summary`);
  }

  // Adopters must be told where to report vulnerabilities.
  if (
    !/security@moolam\.org/.test(body) ||
    !/SECURITY\.md/.test(body) ||
    !/Report a vulnerability|Reporting a vulnerability/i.test(body)
  ) {
    failures.push(OBLIGATIONS.MISSING_REPORTING_CHANNEL);
  }

  // Scope must be more than CVE scanning.
  if (
    !/not just dependency CVEs|not its substance|floor of the engagement/i.test(
      body,
    ) ||
    !/auth|protocol|sandbox/i.test(body)
  ) {
    failures.push(OBLIGATIONS.CVE_ONLY_SCOPE);
  }

  // Sovereignty: summary publishes aggregates only, no learner content.
  if (
    !/subjectId/.test(body) ||
    !/no raw learner content|no exploit detail|no learner content/i.test(body)
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const ok = failures.length === 0;
  return { ok, failures, tally };
}

function main() {
  const result = checkSecurityReviewSummary();
  emit({
    outcome: result.ok ? "ok" : "fail",
    total: result.tally?.total ?? 0,
    openP0P1: result.tally?.openP0P1 ?? 0,
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
