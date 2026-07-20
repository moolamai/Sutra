/**
 * Conformance coverage appendix gate for the Protocol 1.0 freeze RFC.
 *
 * Ensures the generated coverage report is present, maps obligation IDs to
 * pass/fail, links B-track suite files that exist, and is attached from
 * rfcs/0001-protocol-1.0-freeze.md. Failed obligations block the gate.
 *
 * Usage:
 *   node scripts/check-conformance-coverage.mjs
 *   pnpm conformance:coverage:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPORT_JSON,
  REPORT_MD,
  REPO_ROOT,
  suiteCatalog,
} from "./generate-conformance-coverage.mjs";

export const RFC_PATH = path.join(
  REPO_ROOT,
  "rfcs",
  "0001-protocol-1.0-freeze.md",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_JSON: "coverage.missing_json",
  MISSING_MD: "coverage.missing_md",
  INVALID_SCHEMA: "coverage.invalid_schema",
  FAILED_OBLIGATION: "coverage.failed_obligation",
  MISSING_SUITE: "coverage.missing_suite",
  BROKEN_SUITE_LINK: "coverage.broken_suite_link",
  MISSING_RFC_LINK: "coverage.missing_rfc_link",
  RFC_STALE_PROVISIONAL: "coverage.rfc_stale_provisional",
  SOVEREIGNTY: "coverage.sovereignty_incomplete",
  CATALOG_DRIFT: "coverage.catalog_drift",
});

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "conformance.coverage.check", ...event })}\n`,
  );
}

/**
 * @param {{
 *   reportJsonPath?: string,
 *   reportMdPath?: string,
 *   rfcPath?: string,
 *   repoRoot?: string,
 *   expectedContracts?: string[],
 * }} [opts]
 */
export function checkConformanceCoverage(opts = {}) {
  const reportJsonPath = opts.reportJsonPath ?? REPORT_JSON;
  const reportMdPath = opts.reportMdPath ?? REPORT_MD;
  const rfcPath = opts.rfcPath ?? RFC_PATH;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(reportJsonPath)) {
    failures.push(`${OBLIGATIONS.MISSING_JSON}:${reportJsonPath}`);
    return { ok: false, failures, declared: 0, passed: 0 };
  }
  if (!existsSync(reportMdPath)) {
    failures.push(`${OBLIGATIONS.MISSING_MD}:${reportMdPath}`);
  }

  /** @type {any} */
  let report;
  try {
    report = JSON.parse(readFileSync(reportJsonPath, "utf8"));
  } catch (err) {
    failures.push(
      `${OBLIGATIONS.INVALID_SCHEMA}:json_parse:${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, failures, declared: 0, passed: 0 };
  }

  if (
    report.kind !== "conformance-coverage-report" ||
    report.reportVersion !== "1.0.0" ||
    !report.summary ||
    !Array.isArray(report.interfaces)
  ) {
    failures.push(OBLIGATIONS.INVALID_SCHEMA);
  }

  const subjectId = String(report.subjectId ?? "").trim();
  const deviceId = String(report.deviceId ?? "").trim();
  if (!subjectId || !deviceId) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const expected =
    opts.expectedContracts ??
    [
      "SyncRequest (wire shape)",
      "MemoryInterface",
      "ModelInterface",
      "ModelInterface locality policy",
      "ReasoningInterface",
      "SpeechInterface",
      "VisionInterface",
      "ToolInterface",
      "PlanningInterface",
      "KnowledgeConnectorInterface",
      "CAST cold-start",
      "Runtime lifecycle",
      "Refusal composition (CK-10)",
    ];

  const seenContracts = new Set();
  let declared = 0;
  let passed = 0;
  for (const row of report.interfaces ?? []) {
    seenContracts.add(row.contract);
    declared += Number(row.declared) || 0;
    passed += Number(row.passed) || 0;
    if (!row.suite || typeof row.suite !== "string") {
      failures.push(`${OBLIGATIONS.MISSING_SUITE}:${row.contract}`);
    } else {
      const abs = path.join(repoRoot, row.suite.replace(/\//g, path.sep));
      if (!existsSync(abs)) {
        failures.push(`${OBLIGATIONS.BROKEN_SUITE_LINK}:${row.suite}`);
      }
    }
    for (const obl of row.obligations ?? []) {
      if (obl.outcome !== "pass") {
        failures.push(
          `${OBLIGATIONS.FAILED_OBLIGATION}:${obl.id}:${obl.outcome}`,
        );
      }
      if (
        typeof obl.mustText === "string" &&
        /\b(utterance|keystroke)\b/i.test(obl.mustText) &&
        /raw learner/i.test(obl.mustText)
      ) {
        failures.push(`${OBLIGATIONS.SOVEREIGNTY}:${obl.id}`);
      }
    }
    const computed = row.declared > 0 ? (row.passed / row.declared) * 100 : 0;
    if (Math.abs(computed - Number(row.coveragePercent)) > 0.01) {
      failures.push(
        `${OBLIGATIONS.INVALID_SCHEMA}:pct:${row.contract}:${row.coveragePercent}`,
      );
    }
  }

  for (const contract of expected) {
    if (!seenContracts.has(contract)) {
      failures.push(`${OBLIGATIONS.CATALOG_DRIFT}:missing:${contract}`);
    }
  }

  if (Number(report.summary?.failed) > 0 || Number(report.summary?.exitCode) !== 0) {
    failures.push(
      `${OBLIGATIONS.FAILED_OBLIGATION}:summary:failed=${report.summary?.failed}`,
    );
  }

  if (!existsSync(rfcPath)) {
    failures.push(`${OBLIGATIONS.MISSING_RFC_LINK}:missing_rfc`);
  } else {
    const rfc = readFileSync(rfcPath, "utf8");
    if (
      !/appendix\/conformance-coverage\.md/.test(rfc) ||
      !/appendix\/conformance-coverage\.json/.test(rfc)
    ) {
      failures.push(OBLIGATIONS.MISSING_RFC_LINK);
    }
    if (/provisional counts before acceptance/i.test(rfc)) {
      failures.push(OBLIGATIONS.RFC_STALE_PROVISIONAL);
    }
    if (!/### Conformance coverage report/i.test(rfc)) {
      failures.push(`${OBLIGATIONS.MISSING_RFC_LINK}:section`);
    }
  }

  const md = existsSync(reportMdPath)
    ? readFileSync(reportMdPath, "utf8")
    : "";
  if (
    md &&
    (!/subjectId/.test(md) ||
      !/deviceId/.test(md) ||
      !/never raw learner/i.test(md) ||
      !/Obligation ID/.test(md))
  ) {
    failures.push(OBLIGATIONS.SOVEREIGNTY);
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    declared,
    passed,
    interfaces: report.interfaces?.length ?? 0,
    coveragePercent: report.summary?.coveragePercent ?? 0,
  };
}

/**
 * Compare live catalog contract names to a report (optional drift probe).
 * @param {object} report
 * @param {object} cc
 */
export function catalogContractsMatch(report, cc) {
  const live = suiteCatalog(cc).map((s) => s.contract);
  const reported = (report.interfaces ?? []).map((r) => r.contract);
  return (
    live.length === reported.length &&
    live.every((c, i) => c === reported[i])
  );
}

function main() {
  const result = checkConformanceCoverage();
  emit({
    outcome: result.ok ? "ok" : "fail",
    subjectId: "ci-freeze-coverage",
    deviceId: "ci",
    declared: result.declared,
    passed: result.passed,
    interfaces: result.interfaces,
    coveragePercent: result.coveragePercent,
    failureCount: result.failures.length,
  });
  if (!result.ok) {
    for (const f of result.failures) process.stderr.write(`${f}\n`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) main();
