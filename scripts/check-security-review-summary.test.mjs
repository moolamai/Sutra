/**
 * Unit coverage for the adopter security-review summary gate.
 * Run: node --test scripts/check-security-review-summary.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  SUMMARY,
  checkSecurityReviewSummary,
  statedCount,
  tallyFindings,
} from "./check-security-review-summary.mjs";
import { EXTERNAL_REVIEW, parseFindings } from "./check-external-review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

test("happy path: committed summary matches the real findings register", () => {
  const result = checkSecurityReviewSummary();
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("counts published in the summary equal the register tally", () => {
  const tally = tallyFindings(parseFindings(readFileSync(EXTERNAL_REVIEW, "utf8")));
  const body = readFileSync(SUMMARY, "utf8");
  assert.equal(statedCount(body, "Total"), tally.total);
  assert.equal(statedCount(body, "P0"), tally.severity.P0);
  assert.equal(statedCount(body, "P1"), tally.severity.P1);
  assert.equal(tally.openP0P1, 0);
});

test("helpers: tallyFindings groups by severity and status", () => {
  const tally = tallyFindings([
    { severity: "P0", status: "closed" },
    { severity: "P1", status: "closed" },
    { severity: "P3", status: "accepted" },
  ]);
  assert.equal(tally.total, 3);
  assert.equal(tally.severity.P0, 1);
  assert.equal(tally.status.accepted, 1);
  assert.equal(tally.openP0P1, 0);
});

test("edge: missing summary fails MISSING_SUMMARY", () => {
  const result = checkSecurityReviewSummary({
    summaryPath: path.join(tmpdir(), "no-such-summary.md"),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.startsWith(OBLIGATIONS.MISSING_SUMMARY)),
  );
});

/** A summary body whose counts match a fixed 2×closed register. */
function summaryFor({ total = 2, p0 = 1, p1 = 1, p2 = 0, p3 = 0, closed = 2, accepted = 0, open = 0 } = {}) {
  return [
    "## What was reviewed (scope)",
    "auth, protocol, sandbox — not just dependency CVEs; floor of the engagement.",
    "## How it was reviewed (methodology)",
    "red team",
    "## What was found (finding counts)",
    `| Total | **${total}** |`,
    `| P0 | ${p0} |`,
    `| P1 | ${p1} |`,
    `| P2 | ${p2} |`,
    `| P3 | ${p3} |`,
    `| Closed (verified) | ${closed} |`,
    `| Accepted (residual) | ${accepted} |`,
    `| Open | ${open} |`,
    "## Closure status",
    "there are no open P0/P1 findings; subjectId scoping holds; no raw learner content.",
    "## Reporting a vulnerability",
    "Email security@moolam.org — see SECURITY.md — Report a vulnerability.",
  ].join("\n");
}

/** Scratch register with 1 P0 closed + 1 P1 closed (matches summaryFor default). */
function scratchReview() {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sum-"));
  const reviewPath = path.join(dir, "EXTERNAL-REVIEW.md");
  const body = [
    "## Findings register",
    "| Finding ID | Surface | Severity | Status | Owner | Re-test evidence |",
    "|---|---|---|---|---|---|",
    "| `F-EXT-001` | auth | P0 | closed | lead | `packages/x.test.mjs` |",
    "| `F-EXT-002` | sync | P1 | closed | lead | `packages/y.test.mjs` |",
    "## Correlation",
  ].join("\n");
  writeFileSync(reviewPath, body, "utf8");
  return { dir, reviewPath };
}

test("edge: a count that disagrees with the register fails COUNT_MISMATCH", () => {
  const { dir, reviewPath } = scratchReview();
  const summaryPath = path.join(dir, "SUMMARY.md");
  try {
    writeFileSync(summaryPath, summaryFor({ p0: 5 }), "utf8");
    const result = checkSecurityReviewSummary({ summaryPath, reviewPath });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(`${OBLIGATIONS.COUNT_MISMATCH}:P0`),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: register with an open P1 fails OPEN_P0P1_NOT_ZERO", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-sum-open-"));
  const reviewPath = path.join(dir, "EXTERNAL-REVIEW.md");
  const summaryPath = path.join(dir, "SUMMARY.md");
  try {
    writeFileSync(
      reviewPath,
      [
        "## Findings register",
        "| Finding ID | Surface | Severity | Status | Owner | Re-test evidence |",
        "|---|---|---|---|---|---|",
        "| `F-EXT-001` | auth | P0 | closed | lead | `packages/x.test.mjs` |",
        "| `F-EXT-002` | sync | P1 | open | lead | pending |",
        "## Correlation",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(summaryPath, summaryFor({ closed: 1, open: 1 }), "utf8");
    const result = checkSecurityReviewSummary({ summaryPath, reviewPath });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(OBLIGATIONS.OPEN_P0P1_NOT_ZERO),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: dropping the reporting channel fails MISSING_REPORTING_CHANNEL", () => {
  const { dir, reviewPath } = scratchReview();
  const summaryPath = path.join(dir, "SUMMARY.md");
  try {
    const body = summaryFor().replace(
      "Email security@moolam.org — see SECURITY.md — Report a vulnerability.",
      "Contact us somehow.",
    );
    writeFileSync(summaryPath, body, "utf8");
    const result = checkSecurityReviewSummary({ summaryPath, reviewPath });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.MISSING_REPORTING_CHANNEL));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: dropping the no-learner-content posture fails", () => {
  const { dir, reviewPath } = scratchReview();
  const summaryPath = path.join(dir, "SUMMARY.md");
  try {
    const body = summaryFor().replace(
      "there are no open P0/P1 findings; subjectId scoping holds; no raw learner content.",
      "there are no open P0/P1 findings.",
    );
    writeFileSync(summaryPath, body, "utf8");
    const result = checkSecurityReviewSummary({ summaryPath, reviewPath });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.SOVEREIGNTY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci and README surface the summary + gate", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-security-review-summary\.mjs/);
  assert.match(ci, /check-security-review-summary\.test\.mjs/);
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    pkg.scripts["security-summary:check"],
    "node scripts/check-security-review-summary.mjs",
  );
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /SECURITY-REVIEW-SUMMARY\.md/);
});
