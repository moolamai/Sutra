/**
 * Unit coverage for the dependency audit gate.
 * Run: node --test scripts/run-audit-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  SUPPRESSIONS_PATH,
  formatFindingLine,
  filterUnsuppressed,
  isExpired,
  isSuppressed,
  loadSuppressions,
  parsePipAudit,
  parsePnpmAudit,
  runAuditGate,
  validateSuppressions,
} from "./run-audit-gate.mjs";
import {
  SEED_ADVISORY_ID,
  fakePnpmWithUnsuppressed,
  proveAuditGate,
  seedExpiredSuppression,
} from "./prove-audit-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

function validSuppressions(extra = []) {
  return {
    schemaVersion: 1,
    lastReviewed: "2026-07-16",
    nextReviewDue: "2026-10-01",
    suppressions: [
      {
        advisoryIds: ["GHSA-abc", "123"],
        ecosystem: "npm",
        package: "left-pad",
        severity: "high",
        owner: "owner",
        expiresOn: "2099-01-01",
        rationale: "acceptable risk documented with remediation path",
      },
      ...extra,
    ],
  };
}

function fastAuditMocks(overrides = {}) {
  const viteHigh = {
    id: 1123525,
    severity: "high",
    module_name: "vite",
    title: "vite advisory",
    github_advisory_id: "GHSA-fx2h-pf6j-xcff",
    cves: ["CVE-2026-53571"],
  };
  return {
    runPnpm:
      overrides.runPnpm ??
      (() => ({
        status: 1,
        stdout: JSON.stringify({ advisories: { "1123525": viteHigh } }),
        stderr: "",
      })),
    runPip:
      overrides.runPip ??
      (() => ({
        status: 0,
        stdout: JSON.stringify({ dependencies: [] }),
        stderr: "",
      })),
  };
}

test("happy path: committed suppressions + clean audits pass", () => {
  const result = runAuditGate({
    runPnpm: () => ({
      status: 0,
      stdout: JSON.stringify({ advisories: {} }),
      stderr: "",
    }),
    runPip: () => ({
      status: 0,
      stdout: JSON.stringify({ dependencies: [] }),
      stderr: "",
    }),
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("live: gate passes against real lockfile with committed suppressions", async (t) => {
  t.diagnostic("runs real pnpm audit + pip-audit — may take up to 90s");
  const result = runAuditGate();
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("parsePnpmAudit: extracts high/critical only", () => {
  const findings = parsePnpmAudit(
    JSON.stringify({
      advisories: {
        "1": {
          id: 1,
          severity: "high",
          module_name: "vite",
          github_advisory_id: "GHSA-x",
          cves: ["CVE-1"],
          title: "t",
        },
        "2": { id: 2, severity: "moderate", module_name: "lodash", title: "m" },
      },
    }),
  );
  assert.equal(findings.length, 1);
  assert.ok(findings[0].advisoryIds.includes("GHSA-x"));
});

test("parsePipAudit: extracts vulns from dependencies", () => {
  const findings = parsePipAudit(
    JSON.stringify({
      dependencies: [
        {
          name: "requests",
          version: "1.0",
          vulns: [
            {
              id: "PYSEC-1",
              aliases: ["GHSA-y", "CVE-2"],
              description: "rce",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ecosystem, "pip");
});

test("isSuppressed: matches by advisory id and ecosystem", () => {
  const suppressions = validateSuppressions(validSuppressions());
  const finding = {
    ecosystem: "npm",
    package: "left-pad",
    severity: "high",
    advisoryIds: ["GHSA-abc"],
  };
  assert.equal(isSuppressed(finding, suppressions), true);
  assert.equal(
    isSuppressed({ ...finding, advisoryIds: ["GHSA-other"] }, suppressions),
    false,
  );
});

test("edge: expired suppression fails EXPIRED_SUPPRESSION", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-audit-exp-"));
  const file = path.join(dir, "suppressions.json");
  try {
    writeFileSync(
      file,
      JSON.stringify(
        validSuppressions([
          {
            advisoryIds: ["GHSA-old"],
            ecosystem: "npm",
            package: "old",
            severity: "high",
            owner: "owner",
            expiresOn: "2020-01-01",
            rationale: "was acceptable once upon a time here",
          },
        ]),
      ),
      "utf8",
    );
    assert.throws(() => loadSuppressions(file), /expired_suppression/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: un-suppressed high finding fails with advisory ids in output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-audit-unsup-"));
  const file = path.join(dir, "suppressions.json");
  try {
    writeFileSync(file, JSON.stringify(validSuppressions(), null, 2), "utf8");
    const pnpm = fakePnpmWithUnsuppressed("{}");
    const result = runAuditGate({
      suppressionsPath: file,
      runPnpm: () => ({ status: 1, stdout: pnpm, stderr: "" }),
      runPip: () => ({
        status: 0,
        stdout: JSON.stringify({ dependencies: [] }),
        stderr: "",
      }),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes(SEED_ADVISORY_ID)),
    );
    assert.ok(result.failureLines?.[0]?.includes("advisoryIds="));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: invalid suppressions schema fails INVALID_SUPPRESSIONS", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-audit-bad-"));
  const file = path.join(dir, "suppressions.json");
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 2 }), "utf8");
    assert.throws(
      () => loadSuppressions(file),
      /invalid_suppressions/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatFindingLine: prints advisory ids for CI logs", () => {
  const line = formatFindingLine({
    ecosystem: "npm",
    package: "vite",
    severity: "high",
    advisoryIds: ["1123525", "GHSA-x"],
    title: "bypass",
  });
  assert.match(line, /advisoryIds=1123525,GHSA-x/);
});

test("prove: red→green cycle restores suppressions byte-identical", () => {
  const before = readFileSync(SUPPRESSIONS_PATH, "utf8");
  const mocks = fastAuditMocks();
  const result = proveAuditGate({
    runGate: (opts) => runAuditGate({ ...mocks, ...opts }),
  });
  assert.equal(result.ok, true, result.failures.join("\n\n"));
  assert.equal(readFileSync(SUPPRESSIONS_PATH, "utf8"), before);
});

test("ci wires dependency audit gate and prove", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(ci, /run-audit-gate\.mjs/);
  assert.match(ci, /prove-audit-gate\.mjs/);
  assert.match(ci, /pip-audit/);
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.equal(pkg.scripts["audit:gate"], "node scripts/run-audit-gate.mjs");
  assert.equal(pkg.scripts["audit:gate:prove"], "node scripts/prove-audit-gate.mjs");
});

test("isExpired: past dates expire, future dates do not", () => {
  assert.equal(isExpired("2020-01-01", new Date("2026-01-01")), true);
  assert.equal(isExpired("2099-01-01", new Date("2026-01-01")), false);
});

test("filterUnsuppressed: bounded set — only blocking severities considered", () => {
  const suppressions = validateSuppressions(validSuppressions());
  const open = filterUnsuppressed(
    [
      {
        ecosystem: "npm",
        package: "left-pad",
        severity: "high",
        advisoryIds: ["GHSA-abc"],
      },
      {
        ecosystem: "npm",
        package: "other",
        severity: "high",
        advisoryIds: ["GHSA-open"],
      },
    ],
    suppressions,
  );
  assert.equal(open.length, 1);
  assert.equal(open[0].advisoryIds[0], "GHSA-open");
});
