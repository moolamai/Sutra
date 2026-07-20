/**
 * Gate for field-pilot dated findings → P7 freeze RFC packaging (PILOEXEC-002).
 *
 * Asserts:
 *   - findings/YYYY-MM-DD-*.md each carry severity, repro, affected spec, subjectId
 *   - PILOT-SUMMARY.md indexes FP-* findings
 *   - P7-FREEZE-RFC-DRAFT.md links PILOT-SUMMARY
 *   - trajectoryExport stays false; no raw utterance bodies
 *
 * Usage (repo root):
 *   node scripts/check-field-pilot-findings.mjs
 *   pnpm field-pilot:findings:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINDINGS_DIR,
  OBLIGATIONS as EXEC_OBLIGATIONS,
  listFindingsFiles,
  validatePilotFindings,
} from "./run-field-pilot-execution.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const PILOT_SUMMARY = path.join(REPO_ROOT, "docs", "pilot", "PILOT-SUMMARY.md");
export const FREEZE_RFC_DRAFT = path.join(
  REPO_ROOT,
  "docs",
  "pilot",
  "P7-FREEZE-RFC-DRAFT.md",
);

export const OBLIGATIONS = Object.freeze({
  ...EXEC_OBLIGATIONS,
  MISSING_SUMMARY: "field_pilot.findings.missing_summary",
  MISSING_RFC_DRAFT: "field_pilot.findings.missing_rfc_draft",
  FINDING_FIELDS: "field_pilot.findings.missing_fields",
  SUMMARY_INDEX: "field_pilot.findings.summary_index",
  RFC_LINK: "field_pilot.findings.rfc_link",
  OPEN_P1: "field_pilot.findings.open_p1_silent",
});

/** Required fields inside each dated finding body. */
export const REQUIRED_FINDING_PATTERNS = Object.freeze([
  { id: "findingId", re: /Finding ID|\bFP-00\d\b/i },
  { id: "severity", re: /\*\*Severity\*\*|Severity\s*\|\s*`?P[0-3]/i },
  { id: "repro", re: /## Repro/i },
  { id: "affectedSpec", re: /Affected spec|CAST-0|ATR-0|CK-0/i },
  { id: "subjectId", re: /subjectId/ },
  { id: "deviceId", re: /deviceId/ },
  { id: "trajectoryFalse", re: /trajectoryExport["']?\s*:\s*`?false|trajectoryExport.*false/i },
  { id: "privacy", re: /behavioral metadata|never raw keystroke|no raw/i },
]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "field_pilot.findings.check", ...event })}\n`,
  );
}

/**
 * @returns {{ ok: boolean, failures: string[], files: string[] }}
 */
export function checkFieldPilotFindings(opts = {}) {
  const findingsDir = opts.findingsDir ?? FINDINGS_DIR;
  const summaryPath = opts.summaryPath ?? PILOT_SUMMARY;
  const rfcDraftPath = opts.rfcDraftPath ?? FREEZE_RFC_DRAFT;
  /** @type {string[]} */
  const failures = [];

  const base = validatePilotFindings({ findingsDir });
  failures.push(...base.failures);
  const files = base.files;

  for (const name of files) {
    const body = readFileSync(path.join(findingsDir, name), "utf8");
    for (const { id, re } of REQUIRED_FINDING_PATTERNS) {
      if (!re.test(body)) {
        failures.push(
          `${OBLIGATIONS.FINDING_FIELDS}: ${name} missing ${id}`,
        );
      }
    }
  }

  if (!existsSync(summaryPath)) {
    failures.push(`${OBLIGATIONS.MISSING_SUMMARY}: PILOT-SUMMARY.md required`);
  } else {
    const summary = readFileSync(summaryPath, "utf8");
    for (const id of ["FP-001", "FP-002", "FP-003", "FP-004"]) {
      if (!summary.includes(id)) {
        failures.push(
          `${OBLIGATIONS.SUMMARY_INDEX}: PILOT-SUMMARY must index ${id}`,
        );
      }
    }
    if (!/P7-FREEZE-RFC-DRAFT\.md/.test(summary)) {
      failures.push(
        `${OBLIGATIONS.SUMMARY_INDEX}: PILOT-SUMMARY must link freeze RFC draft`,
      );
    }
    if (!/PILOT-EXIT-REVIEW\.md|exit review/i.test(summary)) {
      failures.push(
        `${OBLIGATIONS.SUMMARY_INDEX}: PILOT-SUMMARY must link exit review`,
      );
    }
    if (!/trajectoryExport.*false|trajectoryExport\*\*.*false/i.test(summary)) {
      failures.push(
        `${OBLIGATIONS.TRAJECTORY}: PILOT-SUMMARY must keep trajectoryExport false`,
      );
    }
    if (!/subjectId/.test(summary)) {
      failures.push(
        `${OBLIGATIONS.SUBJECT_SCOPE}: PILOT-SUMMARY must mention subjectId scope`,
      );
    }
    emit({
      outcome: "ok",
      phase: "summary",
      subjectId: "field-pilot-findings",
      deviceId: "ci",
    });
  }

  if (!existsSync(rfcDraftPath)) {
    failures.push(
      `${OBLIGATIONS.MISSING_RFC_DRAFT}: P7-FREEZE-RFC-DRAFT.md required`,
    );
  } else {
    const rfc = readFileSync(rfcDraftPath, "utf8");
    if (!/PILOT-SUMMARY\.md/.test(rfc)) {
      failures.push(
        `${OBLIGATIONS.RFC_LINK}: freeze RFC draft must link PILOT-SUMMARY.md`,
      );
    }
    if (!/FP-002/.test(rfc) || !/P1/.test(rfc)) {
      failures.push(
        `${OBLIGATIONS.OPEN_P1}: draft must surface FP-002 P1 (no silent deferral)`,
      );
    } else {
      const closedOk =
        /Closed/i.test(rfc) && /fixture|hi-classroom-noise|fp002/i.test(rfc);
      const openOk = /Open|blocker/i.test(rfc);
      if (!closedOk && !openOk) {
        failures.push(
          `${OBLIGATIONS.OPEN_P1}: FP-002 disposition must be Closed+fixture or open blocker`,
        );
      }
    }
    if (!/findings\//.test(rfc)) {
      failures.push(
        `${OBLIGATIONS.RFC_LINK}: draft must cite findings/ directory`,
      );
    }
    emit({
      outcome: "ok",
      phase: "rfc_draft",
      subjectId: "field-pilot-findings",
      deviceId: "ci",
    });
  }

  const ok = failures.length === 0;
  emit({
    outcome: ok ? "ok" : "fail",
    phase: "complete",
    subjectId: "field-pilot-findings",
    deviceId: "ci",
    failureClass: ok ? undefined : failures[0]?.split(":")[0],
    failureCount: failures.length,
    findingCount: files.length,
  });
  return { ok, failures, files };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const result = checkFieldPilotFindings();
  if (!result.ok) {
    for (const f of result.failures) {
      console.error(f);
    }
    process.exitCode = 1;
  }
}
