/**
 * Threat-model STRIDE enumeration gate (P7 STRIDE — enumeration slice).
 *
 * Asserts security/THREAT-MODEL.md enumerates per-surface threats with
 * mitigations, test links that resolve to existing files, and a residual
 * risk register with owner + review date.
 *
 * Usage (repo root):
 *   node scripts/check-threat-model-stride.mjs
 *   pnpm threat-model:stride:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THREAT_MODEL } from "./check-threat-model-inventory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const OBLIGATIONS = Object.freeze({
  MISSING_THREAT_MODEL: "threat_model.stride.missing_threat_model",
  MISSING_STRIDE_SECTION: "threat_model.stride.missing_stride_section",
  MISSING_THREAT: "threat_model.stride.missing_threat",
  MISSING_TEST_LINK: "threat_model.stride.missing_test_link",
  BROKEN_TEST_LINK: "threat_model.stride.broken_test_link",
  INVALID_STATUS: "threat_model.stride.invalid_status",
  MISSING_RESIDUAL_SECTION: "threat_model.stride.missing_residual_section",
  MISSING_RESIDUAL: "threat_model.stride.missing_residual",
  INCOMPLETE_RESIDUAL: "threat_model.stride.incomplete_residual",
});

/** Enumerated threats — one row per ID in STRIDE tables. */
export const REQUIRED_THREAT_IDS = Object.freeze([
  "TH-EDGE-001",
  "TH-EDGE-002",
  "TH-EDGE-003",
  "TH-EDGE-004",
  "TH-EDGE-005",
  "TH-EDGE-006",
  "TH-CLOUD-001",
  "TH-CLOUD-002",
  "TH-CLOUD-003",
  "TH-CLOUD-004",
  "TH-CLOUD-005",
  "TH-CLOUD-006",
  "TH-SYNC-001",
  "TH-SYNC-002",
  "TH-SYNC-003",
  "TH-SYNC-004",
  "TH-SYNC-005",
  "TH-SYNC-006",
  "TH-TOOL-001",
  "TH-TOOL-002",
  "TH-TOOL-003",
  "TH-TOOL-004",
  "TH-TOOL-005",
  "TH-TOOL-006",
]);

export const REQUIRED_RESIDUAL_IDS = Object.freeze([
  "RR-TLS-001",
  "RR-HOST-TOOL-001",
  "RR-DEVICE-001",
]);

const VALID_THREAT_STATUS = new Set(["mitigated"]);
const VALID_RESIDUAL_STATUS = new Set(["accepted"]);

const TEST_LINK_RE =
  /`((?:packages|scripts)\/[^`]+\.(?:test\.mjs|py))`/;

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "threat_model.stride.check", ...event })}\n`,
  );
}

/**
 * @param {string} body
 * @param {string} heading
 * @param {string} untilHeading
 */
export function sectionBetween(body, heading, untilHeading) {
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length);
  const end = rest.indexOf(untilHeading);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * @param {string} line
 */
export function parseTableRow(line) {
  if (!line.startsWith("|")) return null;
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length < 2) return null;
  return cells;
}

/**
 * @param {string} cell
 */
export function idFromCell(cell) {
  const m = /`((?:TH|RR|TB)-[A-Z0-9]+(?:-[A-Z0-9]+)*)`/.exec(cell);
  return m?.[1] ?? null;
}

/**
 * @param {string} cell
 */
export function testLinkFromCell(cell) {
  const m = TEST_LINK_RE.exec(cell);
  return m?.[1] ?? null;
}

/**
 * @param {string} strideSection
 * @returns {Map<string, { testLink: string, status: string }>}
 */
export function parseStrideThreats(strideSection) {
  /** @type {Map<string, { testLink: string, status: string }>} */
  const threats = new Map();
  for (const line of strideSection.split(/\r?\n/)) {
    if (!line.includes("TH-")) continue;
    const cells = parseTableRow(line);
    if (!cells || cells.length < 7) continue;
    const threatId = idFromCell(cells[0]);
    if (!threatId?.startsWith("TH-")) continue;
    const testLink = testLinkFromCell(cells[5]);
    const status = cells[6].replace(/`/g, "").trim().toLowerCase();
    threats.set(threatId, {
      testLink: testLink ?? "",
      status,
    });
  }
  return threats;
}

/**
 * @param {string} residualSection
 * @returns {Map<string, { status: string, owner: string, reviewDate: string, rationale: string }>}
 */
export function parseResidualRisks(residualSection) {
  /** @type {Map<string, { status: string, owner: string, reviewDate: string, rationale: string }>} */
  const risks = new Map();
  for (const line of residualSection.split(/\r?\n/)) {
    if (!line.includes("RR-")) continue;
    const cells = parseTableRow(line);
    if (!cells || cells.length < 6) continue;
    const riskId = idFromCell(cells[0]);
    if (!riskId?.startsWith("RR-")) continue;
    risks.set(riskId, {
      status: cells[2].replace(/`/g, "").trim().toLowerCase(),
      owner: cells[3],
      reviewDate: cells[4],
      rationale: cells[5],
    });
  }
  return risks;
}

/**
 * @param {{ threatModelPath?: string, repoRoot?: string }} [opts]
 */
export function checkThreatModelStride(opts = {}) {
  const threatModelPath = opts.threatModelPath ?? THREAT_MODEL;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  /** @type {string[]} */
  const failures = [];

  if (!existsSync(threatModelPath)) {
    failures.push(`${OBLIGATIONS.MISSING_THREAT_MODEL}:${threatModelPath}`);
    return { ok: false, failures, threats: 0, residuals: 0 };
  }

  const body = readFileSync(threatModelPath, "utf8");
  const strideSection = sectionBetween(
    body,
    "## STRIDE enumeration",
    "## Edge-case coverage",
  );
  if (!strideSection.trim()) {
    failures.push(OBLIGATIONS.MISSING_STRIDE_SECTION);
    return { ok: false, failures, threats: 0, residuals: 0 };
  }

  const threats = parseStrideThreats(strideSection);
  for (const id of REQUIRED_THREAT_IDS) {
    const row = threats.get(id);
    if (!row) {
      failures.push(`${OBLIGATIONS.MISSING_THREAT}:${id}`);
      continue;
    }
    if (!row.testLink) {
      failures.push(`${OBLIGATIONS.MISSING_TEST_LINK}:${id}`);
      continue;
    }
    const abs = path.join(repoRoot, row.testLink.replace(/\//g, path.sep));
    if (!existsSync(abs)) {
      failures.push(`${OBLIGATIONS.BROKEN_TEST_LINK}:${id}:${row.testLink}`);
    }
    if (!VALID_THREAT_STATUS.has(row.status)) {
      failures.push(`${OBLIGATIONS.INVALID_STATUS}:${id}:${row.status}`);
    }
  }

  const residualSection = sectionBetween(
    body,
    "## Residual risk register",
    "## Correlation",
  );
  if (!residualSection.trim()) {
    failures.push(OBLIGATIONS.MISSING_RESIDUAL_SECTION);
  } else {
    const residuals = parseResidualRisks(residualSection);
    for (const id of REQUIRED_RESIDUAL_IDS) {
      const row = residuals.get(id);
      if (!row) {
        failures.push(`${OBLIGATIONS.MISSING_RESIDUAL}:${id}`);
        continue;
      }
      if (!VALID_RESIDUAL_STATUS.has(row.status)) {
        failures.push(`${OBLIGATIONS.INVALID_STATUS}:${id}:${row.status}`);
      }
      if (
        !row.owner.trim() ||
        !/\d{4}-\d{2}-\d{2}/.test(row.reviewDate) ||
        row.rationale.trim().length < 20
      ) {
        failures.push(`${OBLIGATIONS.INCOMPLETE_RESIDUAL}:${id}`);
      }
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    failures,
    threats: threats.size,
    residuals: REQUIRED_RESIDUAL_IDS.length,
  };
}

function main() {
  const result = checkThreatModelStride();
  emit({
    outcome: result.ok ? "ok" : "fail",
    threats: result.threats,
    residuals: result.residuals,
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
