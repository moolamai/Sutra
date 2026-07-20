/**
 * Unit coverage for conformance coverage report generation and gate.
 * Run: node --test scripts/check-conformance-coverage.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  checkConformanceCoverage,
} from "./check-conformance-coverage.mjs";
import {
  REPORT_JSON,
  REPORT_MD,
  formatCoverageMarkdown,
  writeCoverageArtifacts,
} from "./generate-conformance-coverage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CI = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const ROOT_PKG = path.join(REPO_ROOT, "package.json");
const RFC = path.join(REPO_ROOT, "rfcs", "0001-protocol-1.0-freeze.md");

function sampleReport(overrides = {}) {
  return {
    kind: "conformance-coverage-report",
    reportVersion: "1.0.0",
    generatedAt: "2026-07-17T00:00:00.000Z",
    subjectId: "ci-freeze-coverage",
    deviceId: "ci",
    summary: {
      interfaces: 1,
      declared: 2,
      passed: 2,
      failed: 0,
      coveragePercent: 100,
      exitCode: 0,
    },
    interfaces: [
      {
        contract: "MemoryInterface",
        suite: "packages/contract-conformance/tests/memory_obligations.test.mjs",
        declared: 2,
        passed: 2,
        failed: 0,
        coveragePercent: 100,
        obligations: [
          {
            id: "CK-02.1",
            outcome: "pass",
            contract: "MemoryInterface",
            mustText: "remember MUST be durable before resolving.",
            durationMs: 1,
          },
          {
            id: "CK-02.3",
            outcome: "pass",
            contract: "MemoryInterface",
            mustText: "Implementations MUST be safe under concurrent subjects.",
            durationMs: 1,
          },
        ],
      },
    ],
    notes: {
      method: "covered ÷ declared × 100",
      sovereignty:
        "Every suite run is scoped by subjectId; report never includes raw learner content",
      fieldPilotBlocker: "FP-002",
      bTrackSuite: "suite column links B-track tests",
    },
    ...overrides,
  };
}

test("happy path: committed coverage appendix passes the gate", () => {
  assert.equal(existsSync(REPORT_JSON), true);
  assert.equal(existsSync(REPORT_MD), true);
  const result = checkConformanceCoverage();
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.declared, 34);
  assert.equal(result.passed, 34);
  assert.equal(result.coveragePercent, 100);
});

test("happy path: markdown formatter lists obligation outcomes", () => {
  const md = formatCoverageMarkdown(sampleReport());
  assert.match(md, /CK-02\.1/);
  assert.match(md, /\*\*pass\*\*/);
  assert.match(md, /subjectId/);
  assert.match(md, /never raw learner/);
  assert.match(md, /memory_obligations\.test\.mjs/);
});

test("edge: failed obligation in report fails FAILED_OBLIGATION", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cov-fail-"));
  try {
    const report = sampleReport({
      summary: {
        interfaces: 1,
        declared: 2,
        passed: 1,
        failed: 1,
        coveragePercent: 50,
        exitCode: 1,
      },
      interfaces: [
        {
          contract: "MemoryInterface",
          suite:
            "packages/contract-conformance/tests/memory_obligations.test.mjs",
          declared: 2,
          passed: 1,
          failed: 1,
          coveragePercent: 50,
          obligations: [
            {
              id: "CK-02.1",
              outcome: "pass",
              contract: "MemoryInterface",
              mustText: "remember MUST be durable before resolving.",
              durationMs: 1,
            },
            {
              id: "CK-02.3",
              outcome: "fail",
              contract: "MemoryInterface",
              mustText:
                "Implementations MUST be safe under concurrent subjects.",
              durationMs: 1,
              message: "cross-subject leak",
            },
          ],
        },
      ],
    });
    const jsonPath = path.join(dir, "report.json");
    const mdPath = path.join(dir, "report.md");
    writeCoverageArtifacts({ report, jsonPath, mdPath });
    const rfcPath = path.join(dir, "rfc.md");
    writeFileSync(
      rfcPath,
      [
        "# RFC",
        "### Conformance coverage report",
        "appendix/conformance-coverage.md",
        "appendix/conformance-coverage.json",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = checkConformanceCoverage({
      reportJsonPath: jsonPath,
      reportMdPath: mdPath,
      rfcPath,
      expectedContracts: ["MemoryInterface"],
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(`${OBLIGATIONS.FAILED_OBLIGATION}:CK-02.3`),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: broken B-track suite path fails BROKEN_SUITE_LINK", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cov-suite-"));
  try {
    const report = sampleReport({
      interfaces: [
        {
          contract: "MemoryInterface",
          suite: "packages/contract-conformance/tests/does-not-exist.test.mjs",
          declared: 1,
          passed: 1,
          failed: 0,
          coveragePercent: 100,
          obligations: [
            {
              id: "CK-02.1",
              outcome: "pass",
              contract: "MemoryInterface",
              mustText: "remember MUST be durable before resolving.",
              durationMs: 1,
            },
          ],
        },
      ],
      summary: {
        interfaces: 1,
        declared: 1,
        passed: 1,
        failed: 0,
        coveragePercent: 100,
        exitCode: 0,
      },
    });
    const jsonPath = path.join(dir, "report.json");
    const mdPath = path.join(dir, "report.md");
    writeCoverageArtifacts({ report, jsonPath, mdPath });
    const rfcPath = path.join(dir, "rfc.md");
    writeFileSync(
      rfcPath,
      "### Conformance coverage report\nappendix/conformance-coverage.md\nappendix/conformance-coverage.json\n",
      "utf8",
    );
    const result = checkConformanceCoverage({
      reportJsonPath: jsonPath,
      reportMdPath: mdPath,
      rfcPath,
      expectedContracts: ["MemoryInterface"],
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) =>
        f.startsWith(`${OBLIGATIONS.BROKEN_SUITE_LINK}:`),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: replay of the same report artifacts is idempotent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cov-replay-"));
  try {
    const report = sampleReport();
    const jsonPath = path.join(dir, "report.json");
    const mdPath = path.join(dir, "report.md");
    writeCoverageArtifacts({ report, jsonPath, mdPath });
    const firstJson = readFileSync(jsonPath, "utf8");
    const firstMd = readFileSync(mdPath, "utf8");
    writeCoverageArtifacts({ report, jsonPath, mdPath });
    assert.equal(readFileSync(jsonPath, "utf8"), firstJson);
    assert.equal(readFileSync(mdPath, "utf8"), firstMd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sovereignty: missing subjectId / deviceId fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-cov-sov-"));
  try {
    const report = sampleReport({ subjectId: "", deviceId: "" });
    const jsonPath = path.join(dir, "report.json");
    const mdPath = path.join(dir, "report.md");
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(mdPath, "# incomplete\n", "utf8");
    const rfcPath = path.join(dir, "rfc.md");
    writeFileSync(
      rfcPath,
      "### Conformance coverage report\nappendix/conformance-coverage.md\nappendix/conformance-coverage.json\n",
      "utf8",
    );
    const result = checkConformanceCoverage({
      reportJsonPath: jsonPath,
      reportMdPath: mdPath,
      rfcPath,
      expectedContracts: ["MemoryInterface"],
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(OBLIGATIONS.SOVEREIGNTY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RFC attaches appendix; CI and package scripts are wired", () => {
  const rfc = readFileSync(RFC, "utf8");
  assert.match(rfc, /### Conformance coverage report/);
  assert.match(rfc, /appendix\/conformance-coverage\.md/);
  assert.match(rfc, /appendix\/conformance-coverage\.json/);
  assert.doesNotMatch(rfc, /provisional counts before acceptance/i);

  const ci = readFileSync(CI, "utf8");
  assert.match(ci, /pnpm conformance:coverage:check/);
  assert.match(ci, /check-conformance-coverage\.test\.mjs/);

  const pkg = JSON.parse(readFileSync(ROOT_PKG, "utf8"));
  assert.equal(
    pkg.scripts["conformance:coverage"],
    "node scripts/generate-conformance-coverage.mjs",
  );
  assert.equal(
    pkg.scripts["conformance:coverage:check"],
    "node scripts/check-conformance-coverage.mjs",
  );
});
