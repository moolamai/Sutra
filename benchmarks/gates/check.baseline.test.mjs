/**
 * Relative-regression baseline mode.
 * Run: node --test benchmarks/gates/check.baseline.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaselineDocument } from "../_shared/bench.mjs";
import {
  DEFAULT_BASELINE_PATH,
  evaluateCombinedGate,
  evaluateRelativeRegressionGate,
  loadBaseline,
  runBenchGate,
} from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS_PATH = path.join(__dirname, "thresholds.json");
const BENCHMARKS_DIR = path.resolve(__dirname, "..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.gate.baseline.test", ...event })}\n`,
  );
}

const seedBaseline = {
  schemaVersion: "bench-baseline.v1",
  unit: "ms",
  metric: "p95",
  recordedAt: "2026-07-15T18:00:00.000Z",
  deviceId: "test-baseline",
  subjectId: null,
  benches: {
    core_loop: { p95Ms: 1, nfrId: "NFR-06" },
    crdt_merge: { p95Ms: 2, nfrId: "NFR-03" },
    memory_retrieval: { p95Ms: 3, nfrId: "NFR-06" },
    sync_roundtrip: { p95Ms: 2, nfrId: "NFR-03" },
    router: { p95Ms: 2, nfrId: "NFR-04" },
    agent_turn: { p95Ms: 1, nfrId: "NFR-06" },
    sync_convergence: { p95Ms: 50, nfrId: "NFR-03" },
    py_sync_merge: { p95Ms: 2, nfrId: "NFR-03" },
    py_agent_runtime: { p95Ms: 1, nfrId: "NFR-06" },
  },
};

test("happy path: committed baseline loads; within +50% passes relative mode", async () => {
  const loaded = await loadBaseline(DEFAULT_BASELINE_PATH);
  assert.equal(loaded.ok, true, loaded.detail);
  assert.equal(loaded.document.schemaVersion, "bench-baseline.v1");

  const ok = evaluateRelativeRegressionGate({
    benchId: "core_loop",
    measuredP95: 1.4,
    baselineP95: 1,
    tolerancePercent: 50,
    budgetP95: 10,
    nfrId: "NFR-06",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.allowedP95, 1.5);
  assert.ok(ok.headroomPercent > 0);

  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-rel-ok",
    baselineDocument: seedBaseline,
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      // +40% vs seed baseline — within 50% tol; far under abs ceilings
      measuredP95: seedBaseline.benches[benchId].p95Ms * 1.4,
      samples: [],
    }),
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.baselineMode, true);
  assert.ok(result.rows.every((r) => r.baselineP95 != null));
  log({ outcome: "ok", case: "relative-within-tol", subjectId: null });
});

test("edge: seeded relative regression trips gate even under absolute ceiling", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-rel-breach",
    baselineDocument: seedBaseline,
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      // +100% vs baseline — breaches 50% tol; still under abs budgets
      measuredP95: seedBaseline.benches[benchId].p95Ms * 2,
      samples: [],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "relative_regression");
  assert.match(result.diff, /DIFF/);
  assert.match(result.diff, /baseline/);
  assert.match(result.diff, /core_loop/);
  log({
    outcome: "rejected",
    case: "relative-regression",
    subjectId: null,
  });
});

test("edge: absolute ceiling still enforced in baseline mode (no auto-relax)", () => {
  const abs = evaluateCombinedGate({
    benchId: "core_loop",
    measuredP95: 50,
    budgetP95: 10,
    nfrId: "NFR-06",
    baselineMode: true,
    baselineP95: 40,
    tolerancePercent: 50,
    enforceAbsoluteCeiling: true,
    subjectId: null,
    deviceId: "test-abs",
  });
  // 50 > 10 abs ceiling → p95_breach even though baseline+50% would allow 60
  assert.equal(abs.ok, false);
  assert.equal(abs.failureClass, "p95_breach");
  log({
    outcome: "rejected",
    case: "abs-ceiling-in-baseline-mode",
    subjectId: null,
  });
});

test("edge: missing baseline entry for a bench fails loud", async () => {
  const incomplete = {
    ...seedBaseline,
    benches: { core_loop: { p95Ms: 1 } },
  };
  let executed = false;
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-missing-base",
    baselineDocument: incomplete,
    executeBench: async () => {
      executed = true;
      return { ok: true, benchId: "x", measuredP95: 1, samples: [] };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "missing_baseline");
  assert.equal(executed, false);
  log({
    outcome: "rejected",
    case: "missing-baseline-entry",
    subjectId: null,
  });
});

test("sovereignty: baseline builder and gate rows never carry learner content", () => {
  const doc = buildBaselineDocument({
    measurements: { core_loop: 0.05, crdt_merge: 8 },
    deviceId: "dev-build",
    subjectId: null,
    nfrByBench: { core_loop: "NFR-06" },
  });
  assert.equal(doc.schemaVersion, "bench-baseline.v1");
  assert.equal(doc.benches.core_loop.p95Ms, 0.05);
  const blob = JSON.stringify(doc);
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));
  log({ outcome: "ok", case: "baseline-builder-sov", subjectId: null });
});
