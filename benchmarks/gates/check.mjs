/**
 * Benchmark gate: run each Node *.bench.mjs (+ optional Python modules),
 * compare max p95 to thresholds.json, print measured vs budget (+ headroom),
 * exit 1 on breach with DIFF table.
 *
 * Invariants:
 * - Every benchmarks/*.bench.mjs must have a thresholds entry with nfrId.
 * - Python benches (runtime:"python") invoke cloud-orchestrator modules and
 *   parse bench.mjs-compatible JSON sample / capture lines.
 * - Checker output always prints measured p95, budget p95, and % headroom.
 * - Never auto-relaxes budgets.
 */

import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  beginBenchCapture,
  endBenchCapture,
  maxP95FromCapture,
} from "../_shared/bench.mjs";

export const THRESHOLDS_SCHEMA_VERSION = "bench-thresholds.v1";
export const BASELINE_SCHEMA_VERSION = "bench-baseline.v1";
export const THRESHOLDS_RELPATH = "benchmarks/gates/thresholds.json";
export const BASELINE_RELPATH = "benchmarks/gates/baseline.json";
export const BENCH_FILE_SUFFIX = ".bench.mjs";
export const PYTHON_BENCH_FILE_SUFFIX = ".py";
export const DEFAULT_REGRESSION_TOLERANCE_PERCENT = 50;
export const DEFAULT_PYTHON_PACKAGE_RELPATH = "packages/cloud-orchestrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THRESHOLDS_PATH = path.join(__dirname, "thresholds.json");
export const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline.json");
export const DEFAULT_BENCHMARKS_DIR = path.resolve(__dirname, "..");
export const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");

/** Soft caps (NFR — bounded bench catalogs). */
export const BENCH_ENTRY_LIMIT = 64;
export const REGRESSION_TOLERANCE_PERCENT_MAX = 200;

export function emitGateTelemetry(event) {
  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.gate",
      ...event,
    })}\n`,
  );
}

/**
 * Load and validate thresholds.json. Untrusted input — validate at boundary.
 */
export function parseThresholdsDocument(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "thresholds root must be an object",
    };
  }
  if (raw.schemaVersion !== THRESHOLDS_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `schemaVersion must be ${THRESHOLDS_SCHEMA_VERSION}`,
    };
  }
  if (raw.metric !== "p95" || raw.unit !== "ms") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "metric must be p95 and unit must be ms",
    };
  }
  if (raw.policy?.autoRelax === true) {
    return {
      ok: false,
      failureClass: "policy_violation",
      detail: "checker never auto-relaxes budgets (policy.autoRelax must be false)",
    };
  }
  if (
    raw.policy?.regressionTolerancePercent !== undefined &&
    (typeof raw.policy.regressionTolerancePercent !== "number" ||
      raw.policy.regressionTolerancePercent < 0 ||
      raw.policy.regressionTolerancePercent > REGRESSION_TOLERANCE_PERCENT_MAX)
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `policy.regressionTolerancePercent must be 0..${REGRESSION_TOLERANCE_PERCENT_MAX}`,
    };
  }
  if (!raw.benches || typeof raw.benches !== "object") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "benches map required",
    };
  }

  const benchIds = Object.keys(raw.benches);
  if (benchIds.length === 0 || benchIds.length > BENCH_ENTRY_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `benches must contain 1..${BENCH_ENTRY_LIMIT} entries`,
    };
  }

  for (const id of benchIds) {
    const entry = raw.benches[id];
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `bench ${id}: entry must be an object`,
      };
    }
    if (typeof entry.nfrId !== "string" || !/^NFR-\d{2}$/.test(entry.nfrId)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `bench ${id}: nfrId must match NFR-NN (PRD_MATRIX row)`,
      };
    }
    if (typeof entry.p95Ms !== "number" || !(entry.p95Ms > 0)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `bench ${id}: p95Ms must be a positive number`,
      };
    }
    const runtime = entry.runtime === undefined ? "node" : entry.runtime;
    if (runtime !== "node" && runtime !== "python") {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `bench ${id}: runtime must be "node" or "python"`,
      };
    }
    entry.runtime = runtime;
    if (runtime === "python") {
      if (
        typeof entry.benchModule !== "string" ||
        !entry.benchModule.startsWith("benchmarks.")
      ) {
        return {
          ok: false,
          failureClass: "schema_violation",
          detail: `bench ${id}: python benchModule must be benchmarks.*`,
        };
      }
      if (
        typeof entry.benchFile !== "string" ||
        !entry.benchFile.endsWith(PYTHON_BENCH_FILE_SUFFIX)
      ) {
        return {
          ok: false,
          failureClass: "schema_violation",
          detail: `bench ${id}: python benchFile must end with ${PYTHON_BENCH_FILE_SUFFIX}`,
        };
      }
    } else if (
      typeof entry.benchFile !== "string" ||
      !entry.benchFile.endsWith(BENCH_FILE_SUFFIX)
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `bench ${id}: benchFile must end with ${BENCH_FILE_SUFFIX}`,
      };
    }
  }

  return { ok: true, document: raw };
}

export function isPythonBenchEntry(entry) {
  return entry?.runtime === "python";
}

export async function loadThresholds(absPath = DEFAULT_THRESHOLDS_PATH) {
  let text;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    return {
      ok: false,
      failureClass: "missing_thresholds",
      detail: `cannot read ${absPath}`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "thresholds.json is not valid JSON",
    };
  }
  return parseThresholdsDocument(raw);
}

/** Discover Node bench ids from `*.bench.mjs` filenames (basename without suffix). */
export async function listBenchIds(benchmarksDir = DEFAULT_BENCHMARKS_DIR) {
  const ids = [];
  const names = await readdir(benchmarksDir);
  for (const n of names) {
    if (n.endsWith(BENCH_FILE_SUFFIX)) {
      ids.push(n.slice(0, -BENCH_FILE_SUFFIX.length));
    }
    if (n === "load") {
      const loadDir = path.join(benchmarksDir, "load");
      let loadNames;
      try {
        loadNames = await readdir(loadDir);
      } catch {
        continue;
      }
      for (const ln of loadNames) {
        if (ln.endsWith(BENCH_FILE_SUFFIX)) {
          ids.push(ln.slice(0, -BENCH_FILE_SUFFIX.length));
        }
      }
    }
  }
  return ids.sort();
}

/** Gate bench ids = thresholds keys (Node + Python), sorted. */
export function listGateBenchIds(document) {
  return Object.keys(document.benches).sort();
}

export function resolvePythonPackageDir(entry, repoRoot = DEFAULT_REPO_ROOT) {
  const rel =
    typeof entry.packageRelpath === "string" && entry.packageRelpath.length > 0
      ? entry.packageRelpath
      : DEFAULT_PYTHON_PACKAGE_RELPATH;
  return path.isAbsolute(rel) ? rel : path.resolve(repoRoot, rel);
}

/**
 * Node: every on-disk *.bench.mjs ↔ thresholds (bidirectional).
 * Python: every runtime:python entry must resolve to an on-disk module file.
 * Missing mapping → fail loud, never silent pass.
 */
export function assertThresholdCoverage(document, jsBenchIds, opts = {}) {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const mapped = Object.keys(document.benches);
  const jsMapped = mapped.filter((id) => !isPythonBenchEntry(document.benches[id]));
  const pyMapped = mapped.filter((id) => isPythonBenchEntry(document.benches[id]));
  const onDisk = new Set(jsBenchIds);

  const missingThreshold = jsBenchIds.filter((id) => !mapped.includes(id));
  const orphanThreshold = jsMapped.filter((id) => !onDisk.has(id));
  const missingPythonFiles = [];

  for (const id of pyMapped) {
    const entry = document.benches[id];
    const pkgDir = resolvePythonPackageDir(entry, repoRoot);
    const abs = path.join(pkgDir, "benchmarks", path.basename(entry.benchFile));
    try {
      // sync existence check via access is async — callers use assertThresholdCoverageAsync
      // Keep sync helper for unit tests that pass existingPythonFiles.
      if (opts.existingPythonFiles instanceof Set) {
        if (!opts.existingPythonFiles.has(abs) && !opts.existingPythonFiles.has(id)) {
          missingPythonFiles.push(id);
        }
      }
    } catch {
      missingPythonFiles.push(id);
    }
  }

  if (missingThreshold.length > 0) {
    return {
      ok: false,
      failureClass: "missing_mapping",
      detail: `bench(es) lack thresholds.json entry: ${missingThreshold.join(", ")}`,
      missingThreshold,
      orphanThreshold,
      missingPythonFiles,
    };
  }
  if (orphanThreshold.length > 0) {
    return {
      ok: false,
      failureClass: "orphan_mapping",
      detail: `thresholds.json has no matching *.bench.mjs: ${orphanThreshold.join(", ")}`,
      missingThreshold,
      orphanThreshold,
      missingPythonFiles,
    };
  }
  if (opts.existingPythonFiles instanceof Set && missingPythonFiles.length > 0) {
    return {
      ok: false,
      failureClass: "missing_mapping",
      detail: `python bench module file(s) missing: ${missingPythonFiles.join(", ")}`,
      missingThreshold,
      orphanThreshold,
      missingPythonFiles,
    };
  }
  return {
    ok: true,
    count: mapped.length,
    missingThreshold: [],
    orphanThreshold: [],
    missingPythonFiles: [],
  };
}

/** Async coverage: verifies Python module files exist on disk. */
export async function assertThresholdCoverageAsync(
  document,
  jsBenchIds,
  opts = {},
) {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const existing = new Set();
  for (const id of Object.keys(document.benches)) {
    const entry = document.benches[id];
    if (!isPythonBenchEntry(entry)) continue;
    const pkgDir = resolvePythonPackageDir(entry, repoRoot);
    const abs = path.join(pkgDir, "benchmarks", path.basename(entry.benchFile));
    try {
      await access(abs, fsConstants.R_OK);
      existing.add(abs);
      existing.add(id);
    } catch {
      // leave absent — sync helper reports missingPythonFiles
    }
  }
  return assertThresholdCoverage(document, jsBenchIds, {
    repoRoot,
    existingPythonFiles: existing,
  });
}

/**
 * Compare measured p95 to budget. Always returns printable measured/budget/headroom.
 * Seeded slowdown → ok:false with breach failureClass.
 */
export function evaluateP95Gate(input) {
  const {
    benchId,
    measuredP95,
    budgetP95,
    nfrId,
    subjectId = null,
    deviceId,
  } = input;

  if (typeof measuredP95 !== "number" || Number.isNaN(measuredP95)) {
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      nfrId: nfrId ?? null,
      measuredP95: null,
      budgetP95,
      headroomPercent: null,
      detail: `bench ${benchId}: measured p95 unavailable (treat as gate breach)`,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  const headroomPercent =
    budgetP95 > 0
      ? ((budgetP95 - measuredP95) / budgetP95) * 100
      : null;

  if (measuredP95 > budgetP95) {
    return {
      ok: false,
      failureClass: "p95_breach",
      benchId,
      nfrId: nfrId ?? null,
      measuredP95,
      budgetP95,
      headroomPercent,
      detail: `bench ${benchId}: p95 ${measuredP95.toFixed(3)}ms exceeds budget ${budgetP95}ms (${nfrId ?? "?"})`,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  return {
    ok: true,
    failureClass: null,
    benchId,
    nfrId: nfrId ?? null,
    measuredP95,
    budgetP95,
    headroomPercent,
    detail: `bench ${benchId}: p95 ${measuredP95.toFixed(3)}ms ≤ budget ${budgetP95}ms`,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  };
}

/**
 * Relative regression vs recorded baseline p95.
 * allowed = baselineP95 * (1 + tolerancePercent/100).
 * Never auto-raises baseline; PR must refresh baseline.json intentionally.
 */
export function evaluateRelativeRegressionGate(input) {
  const {
    benchId,
    measuredP95,
    baselineP95,
    tolerancePercent,
    nfrId,
    budgetP95,
    subjectId = null,
    deviceId,
  } = input;

  if (typeof measuredP95 !== "number" || Number.isNaN(measuredP95)) {
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      nfrId: nfrId ?? null,
      measuredP95: null,
      budgetP95: budgetP95 ?? null,
      baselineP95: baselineP95 ?? null,
      allowedP95: null,
      regressionPercent: null,
      headroomPercent: null,
      detail: `bench ${benchId}: measured p95 unavailable (treat as gate breach)`,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  if (
    typeof baselineP95 !== "number" ||
    Number.isNaN(baselineP95) ||
    !(baselineP95 > 0)
  ) {
    return {
      ok: false,
      failureClass: "missing_baseline",
      benchId,
      nfrId: nfrId ?? null,
      measuredP95,
      budgetP95: budgetP95 ?? null,
      baselineP95: null,
      allowedP95: null,
      regressionPercent: null,
      headroomPercent: null,
      detail: `bench ${benchId}: baseline p95 missing or non-positive`,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  const tol =
    typeof tolerancePercent === "number" && tolerancePercent >= 0
      ? tolerancePercent
      : DEFAULT_REGRESSION_TOLERANCE_PERCENT;
  const allowedP95 = baselineP95 * (1 + tol / 100);
  const regressionPercent =
    ((measuredP95 - baselineP95) / baselineP95) * 100;
  const headroomPercent = ((allowedP95 - measuredP95) / allowedP95) * 100;

  if (measuredP95 > allowedP95) {
    return {
      ok: false,
      failureClass: "relative_regression",
      benchId,
      nfrId: nfrId ?? null,
      measuredP95,
      budgetP95: budgetP95 ?? null,
      baselineP95,
      allowedP95,
      regressionPercent,
      headroomPercent,
      detail:
        `bench ${benchId}: p95 ${measuredP95.toFixed(3)}ms exceeds baseline ` +
        `${baselineP95}ms + ${tol}% (allowed ${allowedP95.toFixed(3)}ms; ` +
        `regression ${regressionPercent.toFixed(1)}%)`,
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
  }

  return {
    ok: true,
    failureClass: null,
    benchId,
    nfrId: nfrId ?? null,
    measuredP95,
    budgetP95: budgetP95 ?? null,
    baselineP95,
    allowedP95,
    regressionPercent,
    headroomPercent,
    detail:
      `bench ${benchId}: p95 ${measuredP95.toFixed(3)}ms within baseline ` +
      `${baselineP95}ms + ${tol}%`,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  };
}

/**
 * Combine absolute NFR ceiling + optional relative baseline check.
 * Absolute ceiling is never auto-relaxed when baseline mode is on.
 */
export function evaluateCombinedGate(input) {
  const absolute = evaluateP95Gate({
    benchId: input.benchId,
    measuredP95: input.measuredP95,
    budgetP95: input.budgetP95,
    nfrId: input.nfrId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  if (!input.baselineMode) {
    return absolute;
  }

  const relative = evaluateRelativeRegressionGate({
    benchId: input.benchId,
    measuredP95: input.measuredP95,
    baselineP95: input.baselineP95,
    tolerancePercent: input.tolerancePercent,
    nfrId: input.nfrId,
    budgetP95: input.budgetP95,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  const enforceAbsolute =
    input.enforceAbsoluteCeiling !== false;

  if (enforceAbsolute && !absolute.ok) {
    return {
      ...absolute,
      baselineP95: relative.baselineP95 ?? input.baselineP95 ?? null,
      allowedP95: relative.allowedP95 ?? null,
      regressionPercent: relative.regressionPercent ?? null,
    };
  }
  if (!relative.ok) {
    return relative;
  }

  return {
    ...relative,
    ok: true,
    // Report absolute headroom in output as well (NFR ceiling still printed).
    budgetP95: input.budgetP95,
    absHeadroomPercent: absolute.headroomPercent,
    detail: `${relative.detail}; abs ceiling ${input.budgetP95}ms ok`,
  };
}

export function parseBaselineDocument(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "baseline root must be an object",
    };
  }
  if (raw.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `baseline schemaVersion must be ${BASELINE_SCHEMA_VERSION}`,
    };
  }
  if (raw.metric !== "p95" || raw.unit !== "ms") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "baseline metric must be p95 and unit must be ms",
    };
  }
  if (!raw.benches || typeof raw.benches !== "object") {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "baseline benches map required",
    };
  }
  const ids = Object.keys(raw.benches);
  if (ids.length === 0 || ids.length > BENCH_ENTRY_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `baseline benches must contain 1..${BENCH_ENTRY_LIMIT} entries`,
    };
  }
  for (const id of ids) {
    const entry = raw.benches[id];
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.p95Ms !== "number" ||
      !(entry.p95Ms > 0)
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `baseline ${id}: p95Ms must be a positive number`,
      };
    }
  }
  return { ok: true, document: raw };
}

export async function loadBaseline(absPath = DEFAULT_BASELINE_PATH) {
  let text;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    return {
      ok: false,
      failureClass: "missing_baseline",
      detail: `cannot read baseline ${absPath}`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "baseline.json is not valid JSON",
    };
  }
  return parseBaselineDocument(raw);
}

/** Human + machine-readable row — never bare pass/fail. */
export function formatGateRow(result) {
  const measured =
    result.measuredP95 == null ? "n/a" : `${result.measuredP95.toFixed(3)}ms`;
  const budget =
    result.budgetP95 == null ? "n/a" : `${Number(result.budgetP95).toFixed(3)}ms`;
  const headroom =
    result.headroomPercent == null
      ? "n/a"
      : `${result.headroomPercent.toFixed(1)}%`;
  const status = result.ok ? "PASS" : "FAIL";
  let line =
    `${status}  ${String(result.benchId).padEnd(22)} ` +
    `measured_p95=${measured.padEnd(12)} budget_p95=${budget.padEnd(12)} ` +
    `headroom=${headroom.padEnd(8)} nfr=${result.nfrId ?? "?"}`;
  if (result.baselineP95 != null) {
    const base = `${Number(result.baselineP95).toFixed(3)}ms`;
    const reg =
      result.regressionPercent == null
        ? "n/a"
        : `${result.regressionPercent.toFixed(1)}%`;
    line += ` baseline_p95=${base.padEnd(12)} regression=${reg}`;
  }
  return line;
}

/**
 * Diff-on-failure table: measured vs budget with signed delta.
 * Always includes measured/budget/headroom columns (never bare pass/fail).
 */
export function formatFailureDiff(rows) {
  const failed = rows.filter((r) => !r.ok);
  if (failed.length === 0) return "";
  const withBaseline = failed.some((r) => r.baselineP95 != null);
  const lines = [
    "---- DIFF (benchmark gate breach) ----",
    [
      "bench".padEnd(22),
      "measured".padEnd(12),
      "budget".padEnd(12),
      ...(withBaseline ? ["baseline".padEnd(12), "regress%".padEnd(10)] : []),
      "delta".padEnd(12),
      "headroom".padEnd(10),
      "nfr",
    ].join(" "),
  ];
  for (const r of failed) {
    const measured =
      r.measuredP95 == null ? "n/a" : `${r.measuredP95.toFixed(3)}ms`;
    const budget =
      r.budgetP95 == null ? "n/a" : `${Number(r.budgetP95).toFixed(3)}ms`;
    let delta = "n/a";
    const compareTo =
      r.failureClass === "relative_regression" && r.allowedP95 != null
        ? r.allowedP95
        : r.budgetP95;
    if (r.measuredP95 != null && compareTo != null) {
      const d = r.measuredP95 - compareTo;
      delta = `${d >= 0 ? "+" : ""}${d.toFixed(3)}ms`;
    }
    const headroom =
      r.headroomPercent == null ? "n/a" : `${r.headroomPercent.toFixed(1)}%`;
    const cols = [
      String(r.benchId).padEnd(22),
      measured.padEnd(12),
      budget.padEnd(12),
    ];
    if (withBaseline) {
      const base =
        r.baselineP95 == null ? "n/a" : `${Number(r.baselineP95).toFixed(3)}ms`;
      const reg =
        r.regressionPercent == null
          ? "n/a"
          : `${r.regressionPercent.toFixed(1)}%`;
      cols.push(base.padEnd(12), reg.padEnd(10));
    }
    cols.push(delta.padEnd(12), headroom.padEnd(10), r.nfrId ?? "?");
    lines.push(cols.join(" "));
  }
  lines.push("-------------------------------------");
  return `${lines.join("\n")}\n`;
}

/**
 * Import a bench module under capture; return max p95 (worst case in file).
 * Import / runtime errors → bench_failed (gate breach, never silent skip).
 */
export async function executeBenchModule(opts) {
  const {
    benchmarksDir = DEFAULT_BENCHMARKS_DIR,
    benchFile,
    benchId,
    subjectId = null,
    deviceId = "bench-gate",
  } = opts;

  const abs = path.join(benchmarksDir, benchFile);
  beginBenchCapture();
  try {
    const url = `${pathToFileURL(abs).href}?gate=${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;
    await import(url);
    const samples = endBenchCapture();
    const measuredP95 = maxP95FromCapture(samples);
    if (typeof measuredP95 !== "number" || Number.isNaN(measuredP95)) {
      return {
        ok: false,
        failureClass: "bench_failed",
        benchId,
        measuredP95: null,
        detail: `bench ${benchId}: no p95 samples captured`,
        subjectId,
        deviceId,
        samples,
      };
    }
    emitGateTelemetry({
      outcome: "ok",
      action: "execute_bench",
      subjectId,
      deviceId,
      benchId,
      measuredP95,
      sampleCount: samples.length,
    });
    return {
      ok: true,
      benchId,
      measuredP95,
      samples,
      subjectId,
      deviceId,
    };
  } catch (err) {
    endBenchCapture();
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}`.slice(0, 240)
        : "bench import/execution failed";
    emitGateTelemetry({
      outcome: "rejected",
      action: "execute_bench",
      subjectId,
      deviceId,
      benchId,
      failureClass: "bench_failed",
      detail,
    });
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      measuredP95: null,
      detail: `bench ${benchId}: ${detail}`,
      subjectId,
      deviceId,
      samples: [],
    };
  }
}

/**
 * Parse bench.mjs-compatible Python stdout (human lines + JSON samples/capture).
 * Prefer capture document measuredP95; else max p95 across benchmarks.sample events.
 */
export function parsePythonBenchStdout(stdout) {
  const text = String(stdout ?? "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  let measuredP95 = NaN;
  const samples = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.event === "benchmarks.python.capture" && typeof obj.measuredP95Max === "number") {
      measuredP95 = obj.measuredP95Max;
    }
    if (obj.event === "benchmarks.sample" && typeof obj.p95 === "number") {
      samples.push(obj);
      if (Number.isNaN(measuredP95) || obj.p95 > measuredP95) {
        measuredP95 = obj.p95;
      }
    }
    // Inline capture document printed as JSON object
    if (
      obj.schemaVersion === "bench-capture.v1" &&
      typeof obj.measuredP95 === "number"
    ) {
      measuredP95 = obj.measuredP95;
      if (Array.isArray(obj.samples)) samples.push(...obj.samples);
    }
  }
  // Human lines: name… p95=1.234ms
  for (const line of lines) {
    const m = line.match(/\bp95=([0-9]+(?:\.[0-9]+)?)ms\b/);
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isNaN(v) && (Number.isNaN(measuredP95) || v > measuredP95)) {
      measuredP95 = v;
    }
  }
  if (typeof measuredP95 !== "number" || Number.isNaN(measuredP95)) {
    return {
      ok: false,
      failureClass: "bench_failed",
      detail: "python bench stdout missing p95 samples",
      samples,
      measuredP95: null,
    };
  }
  return { ok: true, measuredP95, samples };
}

export function resolvePythonExecutable() {
  return process.env.PYTHON || process.env.PYTHON_BIN || "python";
}

/**
 * Spawn a single Python bench module under capture; parse unified p95 output.
 */
export function executePythonBenchModule(opts) {
  const {
    entry,
    benchId,
    subjectId = null,
    deviceId = "bench-gate",
    repoRoot = DEFAULT_REPO_ROOT,
    pythonBin = resolvePythonExecutable(),
  } = opts;

  const pkgDir = resolvePythonPackageDir(entry, repoRoot);
  const mod = entry.benchModule;
  const py = `
import json, importlib
from benchmarks.harness import run_capture
m = importlib.import_module(${JSON.stringify(mod)})
doc = run_capture(m.run)
print(json.dumps(doc, separators=(",", ":")))
`.trim();

  const spawned = spawnSync(pythonBin, ["-c", py], {
    cwd: pkgDir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pkgDir },
    timeout: 120_000,
  });

  if (spawned.error) {
    const detail = `python spawn failed: ${spawned.error.message}`.slice(0, 240);
    emitGateTelemetry({
      outcome: "rejected",
      action: "execute_bench",
      subjectId,
      deviceId,
      benchId,
      failureClass: "bench_failed",
      detail,
      runtime: "python",
    });
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      measuredP95: null,
      detail: `bench ${benchId}: ${detail}`,
      subjectId,
      deviceId,
      samples: [],
      runtime: "python",
    };
  }
  if (spawned.status !== 0) {
    const detail = (
      spawned.stderr ||
      spawned.stdout ||
      `python exited ${spawned.status}`
    )
      .toString()
      .trim()
      .slice(0, 240);
    emitGateTelemetry({
      outcome: "rejected",
      action: "execute_bench",
      subjectId,
      deviceId,
      benchId,
      failureClass: "bench_failed",
      detail,
      runtime: "python",
    });
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      measuredP95: null,
      detail: `bench ${benchId}: ${detail}`,
      subjectId,
      deviceId,
      samples: [],
      runtime: "python",
    };
  }

  const parsed = parsePythonBenchStdout(spawned.stdout);
  if (!parsed.ok) {
    emitGateTelemetry({
      outcome: "rejected",
      action: "execute_bench",
      subjectId,
      deviceId,
      benchId,
      failureClass: "bench_failed",
      detail: parsed.detail,
      runtime: "python",
    });
    return {
      ok: false,
      failureClass: "bench_failed",
      benchId,
      measuredP95: null,
      detail: `bench ${benchId}: ${parsed.detail}`,
      subjectId,
      deviceId,
      samples: parsed.samples,
      runtime: "python",
    };
  }

  emitGateTelemetry({
    outcome: "ok",
    action: "execute_bench",
    subjectId,
    deviceId,
    benchId,
    measuredP95: parsed.measuredP95,
    sampleCount: parsed.samples.length,
    runtime: "python",
  });
  return {
    ok: true,
    benchId,
    measuredP95: parsed.measuredP95,
    samples: parsed.samples,
    subjectId,
    deviceId,
    runtime: "python",
  };
}

/** Dispatch Node import vs Python spawn by thresholds entry.runtime. */
export async function executeGateBench(opts) {
  const { entry, benchId } = opts;
  if (isPythonBenchEntry(entry)) {
    return executePythonBenchModule({ ...opts, entry, benchId });
  }
  return executeBenchModule({
    benchmarksDir: opts.benchmarksDir,
    benchFile: entry.benchFile,
    benchId,
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
  });
}

/**
 * Validate committed thresholds against on-disk benches and optional measurements.
 */
export async function validateThresholdsGate(opts = {}) {
  const thresholdsPath = opts.thresholdsPath ?? DEFAULT_THRESHOLDS_PATH;
  const benchmarksDir = opts.benchmarksDir ?? DEFAULT_BENCHMARKS_DIR;
  const subjectId = opts.subjectId ?? null;
  const deviceId = opts.deviceId ?? "bench-gate";
  const measurements = opts.measurements ?? null;
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;

  const loaded = await loadThresholds(thresholdsPath);
  if (!loaded.ok) {
    emitGateTelemetry({
      outcome: "rejected",
      failureClass: loaded.failureClass,
      subjectId,
      deviceId,
    });
    return loaded;
  }

  const jsBenchIds = await listBenchIds(benchmarksDir);
  const coverage = await assertThresholdCoverageAsync(
    loaded.document,
    jsBenchIds,
    { repoRoot },
  );
  if (!coverage.ok) {
    emitGateTelemetry({
      outcome: "rejected",
      failureClass: coverage.failureClass,
      subjectId,
      deviceId,
      detail: coverage.detail,
    });
    return coverage;
  }

  const benchIds = listGateBenchIds(loaded.document);
  const rows = [];
  if (measurements && typeof measurements === "object") {
    for (const benchId of benchIds) {
      const entry = loaded.document.benches[benchId];
      const measured = measurements[benchId];
      const result = evaluateP95Gate({
        benchId,
        measuredP95:
          measured && typeof measured === "object" ? measured.p95 : measured,
        budgetP95: entry.p95Ms,
        nfrId: entry.nfrId,
        subjectId,
        deviceId,
      });
      rows.push(result);
      process.stdout.write(`${formatGateRow(result)}\n`);
      emitGateTelemetry({
        outcome: result.ok ? "ok" : "rejected",
        action: "evaluate_p95",
        subjectId,
        deviceId,
        benchId,
        nfrId: entry.nfrId,
        measuredP95: result.measuredP95,
        budgetP95: result.budgetP95,
        headroomPercent: result.headroomPercent,
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
      });
    }
    const breached = rows.filter((r) => !r.ok);
    if (breached.length > 0) {
      const diff = formatFailureDiff(rows);
      process.stderr.write(diff);
      return {
        ok: false,
        failureClass: breached[0].failureClass,
        detail: breached.map((r) => r.detail).join("; "),
        rows,
        diff,
        document: loaded.document,
      };
    }
  } else {
    for (const benchId of benchIds) {
      const entry = loaded.document.benches[benchId];
      process.stdout.write(
        `MAP   ${benchId.padEnd(22)} budget_p95=${String(entry.p95Ms).padEnd(8)}ms nfr=${entry.nfrId}\n`,
      );
    }
  }

  emitGateTelemetry({
    outcome: "ok",
    action: "validate_thresholds",
    subjectId,
    deviceId,
    benchCount: benchIds.length,
  });

  return {
    ok: true,
    document: loaded.document,
    benchIds,
    rows,
  };
}

/**
 * Full gate: coverage → execute each bench → compare p95 → DIFF on failure.
 * Optional baseline path enables relative-regression tolerance vs last green.
 * `executeBench` may be injected for unit tests (seeded slowdown / import fail).
 */
export async function runBenchGate(opts = {}) {
  const thresholdsPath = opts.thresholdsPath ?? DEFAULT_THRESHOLDS_PATH;
  const benchmarksDir = opts.benchmarksDir ?? DEFAULT_BENCHMARKS_DIR;
  const subjectId = opts.subjectId ?? null;
  const deviceId = opts.deviceId ?? "bench-gate";
  const baselinePath = opts.baselinePath;
  const baselineDocument = opts.baselineDocument;
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const executeBench =
    opts.executeBench ??
    ((benchId, entry) =>
      executeGateBench({
        benchmarksDir,
        entry,
        benchId,
        subjectId,
        deviceId,
        repoRoot,
      }));

  const loaded = await loadThresholds(thresholdsPath);
  if (!loaded.ok) {
    emitGateTelemetry({
      outcome: "rejected",
      failureClass: loaded.failureClass,
      subjectId,
      deviceId,
    });
    return loaded;
  }

  const jsBenchIds = await listBenchIds(benchmarksDir);
  const coverage = await assertThresholdCoverageAsync(
    loaded.document,
    jsBenchIds,
    { repoRoot },
  );
  if (!coverage.ok) {
    emitGateTelemetry({
      outcome: "rejected",
      failureClass: coverage.failureClass,
      subjectId,
      deviceId,
      detail: coverage.detail,
    });
    return coverage;
  }

  const benchIds = listGateBenchIds(loaded.document);

  let baseline = null;
  const baselineMode =
    baselineDocument != null ||
    (typeof baselinePath === "string" && baselinePath.length > 0);
  if (baselineMode) {
    if (baselineDocument != null) {
      const parsed = parseBaselineDocument(baselineDocument);
      if (!parsed.ok) {
        emitGateTelemetry({
          outcome: "rejected",
          failureClass: parsed.failureClass,
          subjectId,
          deviceId,
          detail: parsed.detail,
        });
        return parsed;
      }
      baseline = parsed.document;
    } else {
      const loadedBaseline = await loadBaseline(baselinePath);
      if (!loadedBaseline.ok) {
        emitGateTelemetry({
          outcome: "rejected",
          failureClass: loadedBaseline.failureClass,
          subjectId,
          deviceId,
          detail: loadedBaseline.detail,
        });
        return loadedBaseline;
      }
      baseline = loadedBaseline.document;
    }

    for (const benchId of benchIds) {
      if (!baseline.benches[benchId]) {
        const detail = `baseline missing entry for bench ${benchId}`;
        emitGateTelemetry({
          outcome: "rejected",
          failureClass: "missing_baseline",
          subjectId,
          deviceId,
          detail,
        });
        return {
          ok: false,
          failureClass: "missing_baseline",
          detail,
        };
      }
    }
  }

  const tolerancePercent =
    loaded.document.policy?.regressionTolerancePercent ??
    DEFAULT_REGRESSION_TOLERANCE_PERCENT;
  const enforceAbsoluteCeiling =
    loaded.document.policy?.baselineModeStillEnforcesAbsoluteCeiling !== false;

  process.stdout.write(
    `benchmarks.gate RUN  benches=${benchIds.length} thresholds=${path.basename(thresholdsPath)}` +
      (baselineMode
        ? ` baseline=${path.basename(baselinePath ?? "inline")} tol=${tolerancePercent}%`
        : "") +
      `\n`,
  );

  const rows = [];
  for (const benchId of benchIds) {
    const entry = loaded.document.benches[benchId];
    const executed = await executeBench(benchId, entry);
    const measuredP95 = executed.ok ? executed.measuredP95 : null;
    if (!executed.ok && executed.failureClass === "bench_failed") {
      const failRow = evaluateCombinedGate({
        benchId,
        measuredP95: null,
        budgetP95: entry.p95Ms,
        nfrId: entry.nfrId,
        subjectId,
        deviceId,
        baselineMode,
        baselineP95: baseline?.benches?.[benchId]?.p95Ms,
        tolerancePercent,
        enforceAbsoluteCeiling,
      });
      failRow.detail = executed.detail ?? failRow.detail;
      rows.push(failRow);
      process.stdout.write(`${formatGateRow(failRow)}\n`);
      emitGateTelemetry({
        outcome: "rejected",
        action: "evaluate_p95",
        subjectId,
        deviceId,
        benchId,
        nfrId: entry.nfrId,
        failureClass: "bench_failed",
        budgetP95: entry.p95Ms,
      });
      continue;
    }

    const result = evaluateCombinedGate({
      benchId,
      measuredP95,
      budgetP95: entry.p95Ms,
      nfrId: entry.nfrId,
      subjectId,
      deviceId,
      baselineMode,
      baselineP95: baseline?.benches?.[benchId]?.p95Ms,
      tolerancePercent,
      enforceAbsoluteCeiling,
    });
    rows.push(result);
    process.stdout.write(`${formatGateRow(result)}\n`);
    emitGateTelemetry({
      outcome: result.ok ? "ok" : "rejected",
      action: baselineMode ? "evaluate_relative" : "evaluate_p95",
      subjectId,
      deviceId,
      benchId,
      nfrId: entry.nfrId,
      measuredP95: result.measuredP95,
      budgetP95: result.budgetP95,
      headroomPercent: result.headroomPercent,
      ...(result.baselineP95 != null
        ? { baselineP95: result.baselineP95 }
        : {}),
      ...(result.regressionPercent != null
        ? { regressionPercent: result.regressionPercent }
        : {}),
      ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    });
  }

  const breached = rows.filter((r) => !r.ok);
  if (breached.length > 0) {
    const diff = formatFailureDiff(rows);
    process.stderr.write(diff);
    emitGateTelemetry({
      outcome: "rejected",
      action: "run_bench_gate",
      subjectId,
      deviceId,
      failureClass: breached[0].failureClass,
      breachCount: breached.length,
      baselineMode,
    });
    return {
      ok: false,
      failureClass: breached[0].failureClass,
      detail: breached.map((r) => r.detail).join("; "),
      rows,
      diff,
      document: loaded.document,
      benchIds,
      baselineMode,
    };
  }

  emitGateTelemetry({
    outcome: "ok",
    action: "run_bench_gate",
    subjectId,
    deviceId,
    benchCount: benchIds.length,
    baselineMode,
  });

  return {
    ok: true,
    rows,
    document: loaded.document,
    benchIds,
    diff: "",
    baselineMode,
  };
}

async function main(argv) {
  const subjectId = null;
  const deviceId = "bench-gate-cli";
  let measurements = null;
  let validateOnly = argv.includes("--validate");
  let baselinePath;

  const baselineIdx = argv.indexOf("--baseline");
  if (baselineIdx >= 0) {
    const arg = argv[baselineIdx + 1];
    if (!arg || arg.startsWith("--")) {
      // Flag without path → committed default baseline.
      baselinePath = DEFAULT_BASELINE_PATH;
    } else {
      baselinePath = path.isAbsolute(arg)
        ? arg
        : path.resolve(process.cwd(), arg);
    }
  }

  const measuredIdx = argv.indexOf("--measured");
  if (measuredIdx >= 0) {
    validateOnly = true;
    const payload = argv[measuredIdx + 1];
    if (!payload) {
      emitGateTelemetry({
        outcome: "rejected",
        failureClass: "schema_violation",
        subjectId,
        deviceId,
        detail: "--measured requires a JSON object",
      });
      process.exitCode = 1;
      return;
    }
    try {
      measurements = JSON.parse(payload);
    } catch {
      emitGateTelemetry({
        outcome: "rejected",
        failureClass: "schema_violation",
        subjectId,
        deviceId,
        detail: "--measured JSON parse failed",
      });
      process.exitCode = 1;
      return;
    }
  }

  const result = validateOnly
    ? await validateThresholdsGate({
        subjectId,
        deviceId,
        ...(measurements !== null ? { measurements } : {}),
      })
    : await runBenchGate({
        subjectId,
        deviceId,
        ...(baselinePath !== undefined ? { baselinePath } : {}),
      });

  if (!result.ok) {
    process.stderr.write(`benchmarks.gate FAIL: ${result.detail}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("benchmarks.gate OK\n");
  process.exitCode = 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    emitGateTelemetry({
      outcome: "rejected",
      failureClass: "bench_failed",
      subjectId: null,
      deviceId: "bench-gate-cli",
      detail: err instanceof Error ? err.message : "unhandled",
    });
    process.exitCode = 1;
  });
}
