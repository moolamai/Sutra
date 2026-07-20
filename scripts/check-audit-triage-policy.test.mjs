/**
 * Unit coverage for the audit triage policy gate.
 * Run: node --test scripts/check-audit-triage-policy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  POLICY_PATH,
  REQUIRED_EXAMPLE_IDS,
  checkAuditTriagePolicy,
  extractAdvisoryIds,
} from "./check-audit-triage-policy.mjs";
import { SUPPRESSIONS_PATH } from "./run-audit-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

function validPolicy() {
  return [
    "## Severity thresholds",
    "critical and high Blocks merge until fixed.",
    "## Suppression rules",
    "expiresOn; expired suppressions fail CI",
    "## Quarterly review cadence",
    "quarterly review of lastReviewed and nextReviewDue",
    "## Initial advisory inventory",
    "| `1123525` / `GHSA-fx2h-pf6j-xcff` / `CVE-2026-53571` | high | `vite` | suppressed |",
    "### Worked example — suppress",
    "vite GHSA-fx2h-pf6j-xcff",
    "### Worked example — do not suppress (fix instead)",
    "fix a reachable RCE; do not suppress",
    "pip cloud-orchestrator clean",
    "not blind ignore — triage via AUDIT-SUPPRESSIONS.json and audit:gate / run-audit-gate",
    "## Sovereignty",
    "metadata about dependencies; subjectId; never raw learner content; outcome",
  ].join("\n");
}

function validSuppressionsJson() {
  return JSON.stringify({
    schemaVersion: 1,
    lastReviewed: "2026-07-16",
    nextReviewDue: "2026-10-01",
    suppressions: [
      {
        advisoryIds: ["1123525", "GHSA-fx2h-pf6j-xcff", "CVE-2026-53571"],
        ecosystem: "npm",
        package: "vite",
        severity: "high",
        owner: "Track A lead",
        expiresOn: "2026-10-01",
        rationale: "Vite is a dev/build dependency for docs-site only here",
      },
    ],
  });
}

test("happy path: committed policy matches suppressions inventory", () => {
  const result = checkAuditTriagePolicy();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.ok(result.suppressions >= 1);
});

test("helpers: extractAdvisoryIds collects GHSA CVE and numeric ids", () => {
  const ids = extractAdvisoryIds(
    "`1123525` / `GHSA-fx2h-pf6j-xcff` / `CVE-2026-53571`",
  );
  for (const id of REQUIRED_EXAMPLE_IDS) {
    assert.ok(ids.has(id), id);
  }
});

test("edge: missing policy fails MISSING_POLICY", () => {
  const result = checkAuditTriagePolicy({
    policyPath: path.join(tmpdir(), "no-such-policy.md"),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.startsWith(OBLIGATIONS.MISSING_POLICY)),
  );
});

test("edge: inventory that omits a suppression fails INVENTORY_MISMATCH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-policy-"));
  try {
    const policyPath = path.join(dir, "POLICY.md");
    const suppressionsPath = path.join(dir, "suppressions.json");
    writeFileSync(suppressionsPath, validSuppressionsJson(), "utf8");
    // Policy mentions thresholds but not the vite advisory ids.
    writeFileSync(
      policyPath,
      validPolicy().replace(/`1123525`[\s\S]*?suppressed \|/, "| omitted |"),
      "utf8",
    );
    // Also strip the ids from the worked-example lines so mismatch is clear.
    let body = readFileSync(policyPath, "utf8");
    for (const id of REQUIRED_EXAMPLE_IDS) {
      body = body.replaceAll(id, "PLACEHOLDER");
    }
    writeFileSync(policyPath, body, "utf8");
    const result = checkAuditTriagePolicy({ policyPath, suppressionsPath });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.INVENTORY_MISMATCH) ||
          f.includes(OBLIGATIONS.WORKED_EXAMPLE),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: dropping quarterly cadence fails QUARTERLY", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-policy-q-"));
  try {
    const policyPath = path.join(dir, "POLICY.md");
    const suppressionsPath = path.join(dir, "suppressions.json");
    writeFileSync(suppressionsPath, validSuppressionsJson(), "utf8");
    writeFileSync(
      policyPath,
      validPolicy()
        .replace("## Quarterly review cadence", "## Notes")
        .replace(/quarterly[\s\S]*?nextReviewDue/, "no cadence"),
      "utf8",
    );
    const result = checkAuditTriagePolicy({ policyPath, suppressionsPath });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.QUARTERLY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: dropping subjectId / no-raw-content fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-policy-sov-"));
  try {
    const policyPath = path.join(dir, "POLICY.md");
    const suppressionsPath = path.join(dir, "suppressions.json");
    writeFileSync(suppressionsPath, validSuppressionsJson(), "utf8");
    writeFileSync(
      policyPath,
      validPolicy().replace(
        "metadata about dependencies; subjectId; never raw learner content; outcome",
        "no privacy notes",
      ),
      "utf8",
    );
    const result = checkAuditTriagePolicy({ policyPath, suppressionsPath });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.SOVEREIGNTY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ci and README surface the policy + gate", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /check-audit-triage-policy\.mjs/);
  assert.match(ci, /check-audit-triage-policy\.test\.mjs/);
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    pkg.scripts["audit:policy:check"],
    "node scripts/check-audit-triage-policy.mjs",
  );
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /AUDIT-TRIAGE-POLICY\.md/);
  // Committed policy and suppressions stay consistent.
  assert.ok(existsSync(POLICY_PATH));
  assert.ok(existsSync(SUPPRESSIONS_PATH));
});
