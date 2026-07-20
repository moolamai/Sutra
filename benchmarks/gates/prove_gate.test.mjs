/**
 * Prove-gate: seeded core_loop slowdown → red + DIFF; revert → green.
 * Simulates a scratch-branch artificial delay without mutating bench sources.
 * Run: pnpm --filter @moolam/benchmarks prove:gate
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchGate } from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS_PATH = path.join(__dirname, "thresholds.json");
const BASELINE_PATH = path.join(__dirname, "baseline.json");
const BENCHMARKS_DIR = path.resolve(__dirname, "..");
const PKG_JSON = path.join(__dirname, "../package.json");
import {
  loadAllCi,
  loadNightlyCi,
} from "../../scripts/ci-workflow-test-helpers.mjs";

/** Nominal green measurements (under absolute ceilings + within baseline ±50%). */
const GREEN_P95 = {
  core_loop: 0.04,
  crdt_merge: 8,
  memory_retrieval: 70,
  sync_roundtrip: 6,
  router: 0.03,
  agent_turn: 0.06,
  sync_convergence: 25,
  py_sync_merge: 4,
  py_agent_runtime: 4,
};

/** Scratch-branch slowdown: core_loop well above NFR-06 absolute ceiling (10ms). */
const SLOWDOWN_CORE_LOOP_P95 = 99;

function makeExecutor(deviceId, p95ByBench) {
  return async (benchId) => ({
    ok: true,
    benchId,
    measuredP95: p95ByBench[benchId],
    samples: [],
    subjectId: null,
    deviceId,
  });
}

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.prove_gate.test", ...event })}\n`,
  );
}

test("happy path: seeded core_loop slowdown is red with DIFF; revert is green", async () => {
  const slowP95 = { ...GREEN_P95, core_loop: SLOWDOWN_CORE_LOOP_P95 };

  const red = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    baselinePath: BASELINE_PATH,
    deviceId: "prove-slowdown",
    executeBench: makeExecutor("prove-slowdown", slowP95),
  });
  assert.equal(red.ok, false, "seeded slowdown must fail the gate");
  assert.equal(red.failureClass, "p95_breach");
  assert.match(red.diff, /DIFF \(benchmark gate breach\)/);
  assert.match(red.diff, /core_loop/);
  assert.match(red.diff, /measured/);
  assert.match(red.diff, /budget/);
  assert.match(red.diff, /99\.000ms|99ms/);
  assert.match(red.diff, /10\.000ms|10ms/);
  assert.match(red.diff, /\+/);
  const failRow = red.rows.find((r) => r.benchId === "core_loop");
  assert.ok(failRow && !failRow.ok);
  assert.equal(failRow.measuredP95, SLOWDOWN_CORE_LOOP_P95);
  assert.equal(failRow.budgetP95, 10);
  assert.ok(failRow.headroomPercent < 0);

  // Revert: same harness, nominal measurements — CI must go green again.
  const green = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    baselinePath: BASELINE_PATH,
    deviceId: "prove-revert",
    executeBench: makeExecutor("prove-revert", GREEN_P95),
  });
  assert.equal(green.ok, true, green.detail);
  assert.equal(green.diff, "");
  assert.ok(green.rows.every((r) => r.ok));
  assert.equal(green.baselineMode, true);
  log({ outcome: "ok", case: "red-then-green-revert", subjectId: null });
});

test("edge: DIFF stays in log contract; CI runs prove suite before live ci:gate", () => {
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.match(pkg.scripts.test, /prove_gate\.test\.mjs/);
  assert.equal(typeof pkg.scripts["prove:gate"], "string");
  assert.match(pkg.scripts["prove:gate"], /prove_gate\.test\.mjs/);

  const ci = loadNightlyCi();
  assert.match(ci, /prove.?gate|seeded slowdown/i);
  const testAt = ci.indexOf("@moolam/benchmarks test");
  const gateAt = ci.indexOf("@moolam/benchmarks run ci:gate");
  assert.ok(testAt >= 0 && gateAt > testAt, "prove suite must run before live ci:gate");
  log({ outcome: "ok", case: "ci-orders-prove-before-gate", subjectId: null });
});

test("edge: replay of identical slowdown stay red (idempotent breach); no learner bodies", async () => {
  const slowP95 = { ...GREEN_P95, core_loop: SLOWDOWN_CORE_LOOP_P95 };
  const first = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    baselinePath: BASELINE_PATH,
    deviceId: "prove-replay-a",
    executeBench: makeExecutor("prove-replay-a", slowP95),
  });
  const second = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    baselinePath: BASELINE_PATH,
    deviceId: "prove-replay-b",
    executeBench: makeExecutor("prove-replay-b", slowP95),
  });
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(first.failureClass, second.failureClass);
  assert.equal(
    first.rows.find((r) => r.benchId === "core_loop").measuredP95,
    second.rows.find((r) => r.benchId === "core_loop").measuredP95,
  );

  const blob = `${first.diff}\n${JSON.stringify(first.rows)}`;
  assert.doesNotMatch(blob, /benchmark utterance|learner|password|ssn/i);
  for (const row of first.rows) {
    assert.equal(row.subjectId ?? null, null);
  }
  log({ outcome: "ok", case: "idempotent-red-sovereignty", subjectId: null });
});
