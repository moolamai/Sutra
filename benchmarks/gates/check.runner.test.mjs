/**
 * check.mjs full gate runner — execute + DIFF on failure.
 * Run: node --test benchmarks/gates/check.runner.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  formatFailureDiff,
  runBenchGate,
} from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS_PATH = path.join(__dirname, "thresholds.json");
const BENCHMARKS_DIR = path.resolve(__dirname, "..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.gate.runner.test", ...event })}\n`,
  );
}

test("happy path: injected measurements pass gate with headroom rows", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-run-ok",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: 1,
      samples: [],
      subjectId: null,
      deviceId: "test-run-ok",
    }),
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.rows.length, 9);
  assert.ok(result.rows.every((r) => r.ok && r.headroomPercent > 0));
  assert.equal(result.diff, "");
  log({ outcome: "ok", case: "runner-pass", subjectId: null });
});

test("edge: seeded slowdown trips gate and prints DIFF with measured vs budget", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-run-slow",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: benchId === "core_loop" ? 99 : 1,
      samples: [],
      subjectId: null,
      deviceId: "test-run-slow",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "p95_breach");
  assert.match(result.diff, /DIFF/);
  assert.match(result.diff, /core_loop/);
  assert.match(result.diff, /measured/);
  assert.match(result.diff, /budget/);
  assert.match(result.diff, /\+/);
  const fail = result.rows.find((r) => r.benchId === "core_loop");
  assert.equal(fail.ok, false);
  assert.equal(fail.measuredP95, 99);
  assert.equal(fail.budgetP95, 10);
  log({ outcome: "rejected", case: "seeded-slowdown-diff", subjectId: null });
});

test("edge: import/execution failure is a gate breach (not a skip)", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-run-fail",
    executeBench: async (benchId) => ({
      ok: false,
      failureClass: "bench_failed",
      benchId,
      measuredP95: null,
      detail: `bench ${benchId}: SyntaxError: boom`,
      subjectId: null,
      deviceId: "test-run-fail",
      samples: [],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "bench_failed");
  assert.ok(result.rows.every((r) => r.failureClass === "bench_failed"));
  assert.match(result.diff, /DIFF/);
  assert.match(formatFailureDiff(result.rows), /n\/a/);
  log({ outcome: "rejected", case: "bench-failed-breach", subjectId: null });
});

test("edge: missing threshold mapping fails loud before execute", async () => {
  const root = path.join(tmpdir(), `bench-map-${process.pid}-${Date.now()}`);
  const benchesDir = path.join(root, "benches");
  await mkdir(benchesDir, { recursive: true });
  await writeFile(path.join(benchesDir, "lonely.bench.mjs"), "export {}\n");
  await writeFile(
    path.join(root, "thresholds.json"),
    JSON.stringify({
      schemaVersion: "bench-thresholds.v1",
      unit: "ms",
      metric: "p95",
      policy: { autoRelax: false },
      benches: {
        other: {
          benchFile: "other.bench.mjs",
          nfrId: "NFR-06",
          p95Ms: 10,
        },
      },
    }),
  );

  let executed = false;
  const result = await runBenchGate({
    thresholdsPath: path.join(root, "thresholds.json"),
    benchmarksDir: benchesDir,
    deviceId: "test-missing-map",
    executeBench: async () => {
      executed = true;
      return { ok: true, benchId: "x", measuredP95: 1, samples: [] };
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failureClass === "missing_mapping" ||
      result.failureClass === "orphan_mapping",
  );
  assert.equal(executed, false);
  await rm(root, { recursive: true, force: true });
  log({ outcome: "rejected", case: "missing-before-execute", subjectId: null });
});

test("sovereignty: gate telemetry and DIFF omit learner content", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    subjectId: null,
    deviceId: "test-sov-run",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: 0.5,
      samples: [],
      subjectId: null,
      deviceId: "test-sov-run",
    }),
  });
  assert.equal(result.ok, true);
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));
  log({ outcome: "ok", case: "no-learner-content", subjectId: null });
});
