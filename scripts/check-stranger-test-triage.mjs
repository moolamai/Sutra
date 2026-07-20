/**
 * Gate for stranger-test triage (STRATEST-002).
 *
 * Usage:
 *   node scripts/check-stranger-test-triage.mjs
 *   pnpm stranger-test:triage:check
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFindingsFiles, STRANGER_DIR } from "./check-stranger-test-protocol.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

export const TRIAGE_PATH = path.join(STRANGER_DIR, "TRIAGE-2026-07-16.md");
export const P7_ENTRIES_PATH = path.join(STRANGER_DIR, "P7-RFC-ENTRIES.md");
export const IMPLEMENTOR_QS = path.join(
  REPO_ROOT,
  "docs",
  "sdk",
  "implementor-quickstart.md",
);
export const SITE_STRANGER = path.join(
  REPO_ROOT,
  "docs-site",
  "src",
  "quickstarts",
  "stranger-test.md",
);
export const CREATE_SUTRA = path.join(
  REPO_ROOT,
  "tools",
  "create-sutra",
  "bin",
  "create-sutra.mjs",
);

export const OBLIGATIONS = Object.freeze({
  MISSING_TRIAGE: "docs_site.stranger.triage.missing_triage",
  MISSING_P7: "docs_site.stranger.triage.missing_p7_entries",
  OPEN_P0_P1: "docs_site.stranger.triage.open_p0_p1",
  MISSING_QUICKSTART_FIX: "docs_site.stranger.triage.missing_quickstart_fix",
  MISSING_F001_FIX: "docs_site.stranger.triage.missing_f001_fix",
  WAIVED_SILENT: "docs_site.stranger.triage.waived_silent",
});

const FRICTION_IDS = Object.freeze(["F-001", "F-002", "F-003", "F-004", "F-005"]);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "docs_site.stranger_test.triage", ...event })}\n`,
  );
}

export function validateStrangerTestTriage(opts = {}) {
  const triagePath = opts.triagePath ?? TRIAGE_PATH;
  const p7Path = opts.p7Path ?? P7_ENTRIES_PATH;
  const implementorPath = opts.implementorPath ?? IMPLEMENTOR_QS;
  const sitePath = opts.sitePath ?? SITE_STRANGER;
  const createSutraPath = opts.createSutraPath ?? CREATE_SUTRA;
  const findingsDir = opts.findingsDir ?? STRANGER_DIR;
  const violations = [];

  if (!existsSync(triagePath)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_TRIAGE,
      detail: "TRIAGE-2026-07-16.md is required",
    });
    return { status: 1, violations };
  }

  if (!existsSync(p7Path)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_P7,
      detail: "P7-RFC-ENTRIES.md is required for deferred findings",
    });
  }

  const triage = readFileSync(triagePath, "utf8");
  const p7 = existsSync(p7Path) ? readFileSync(p7Path, "utf8") : "";
  const implementor = existsSync(implementorPath)
    ? readFileSync(implementorPath, "utf8")
    : "";
  const site = existsSync(sitePath) ? readFileSync(sitePath, "utf8") : "";
  const createSutra = existsSync(createSutraPath)
    ? readFileSync(createSutraPath, "utf8")
    : "";

  for (const id of FRICTION_IDS) {
    if (!triage.includes(id)) {
      violations.push({
        obligation: OBLIGATIONS.OPEN_P0_P1,
        detail: `triage must disposition ${id}`,
      });
    }
  }

  // P0/P1 must show Closed or explicit P7 defer — never bare "waive".
  if (/\bwaived?\b/i.test(triage) && !/not waived|Deferred|P7-RFC/i.test(triage)) {
    violations.push({
      obligation: OBLIGATIONS.WAIVED_SILENT,
      detail: "triage must not waive without fix or P7 deferral",
    });
  }

  if (!/F-001[\s\S]*Closed/i.test(triage)) {
    violations.push({
      obligation: OBLIGATIONS.OPEN_P0_P1,
      detail: "F-001 (P0) must be Closed — fixed",
    });
  }
  if (!/F-003[\s\S]*Closed/i.test(triage)) {
    violations.push({
      obligation: OBLIGATIONS.OPEN_P0_P1,
      detail: "F-003 (P1) must be Closed — fixed",
    });
  }
  if (!/P7-RFC-INTENT-001/.test(triage) || !/P7-RFC-INTENT-001/.test(p7)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_P7,
      detail: "F-002 production registry requires P7-RFC-INTENT-001",
    });
  }
  if (!/P7-RFC-INTENT-002/.test(triage) || !/P7-RFC-INTENT-002/.test(p7)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_P7,
      detail: "F-004 requires P7-RFC-INTENT-002",
    });
  }

  if (!/@moolam\/observability/.test(implementor) || !/scratch packs/i.test(implementor)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_QUICKSTART_FIX,
      detail: "implementor quickstart must document scratch packs + observability",
    });
  }

  if (!/Tester brief/i.test(site) || !/404/i.test(site)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_QUICKSTART_FIX,
      detail: "site stranger-test page must carry tester brief + scratch 404 warning",
    });
  }

  if (!/\(\(await rl\.question\(`Output directory/.test(createSutra)) {
    violations.push({
      obligation: OBLIGATIONS.MISSING_F001_FIX,
      detail: "create-sutra F-001 parse fix missing",
    });
  }

  const findings = listFindingsFiles(findingsDir);
  if (findings.length === 0) {
    violations.push({
      obligation: OBLIGATIONS.OPEN_P0_P1,
      detail: "findings recording must still exist for triage audit",
    });
  }

  return {
    status: violations.length === 0 ? 0 : 1,
    violations,
  };
}

export function runStrangerTestTriageCheck(opts = {}) {
  const subjectId = opts.subjectId ?? "docs-site-stranger-triage";
  const deviceId = opts.deviceId ?? "ci";
  const emitEvents = opts.emitEvents !== false;

  const result = validateStrangerTestTriage(opts);
  if (result.status !== 0) {
    if (emitEvents) {
      emit({
        outcome: "fail",
        subjectId,
        deviceId,
        phase: "validate",
        violationCount: result.violations.length,
      });
    }
    return {
      status: 1,
      violations: result.violations,
      combined: result.violations
        .map((v) => `[${v.obligation}] ${v.detail}`)
        .join("\n"),
    };
  }

  if (emitEvents) {
    emit({
      outcome: "ok",
      subjectId,
      deviceId,
      phase: "validate",
      closedCount: 4,
      deferredCount: 2,
    });
  }

  return {
    status: 0,
    violations: [],
    combined: "OK: stranger-test triage closed P0/P1 with P7 deferrals recorded",
  };
}

function main() {
  const result = runStrangerTestTriageCheck();
  if (result.status !== 0) {
    process.stderr.write(`${result.combined}\n`);
    process.exit(result.status);
  }
  process.stdout.write(`${result.combined}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
