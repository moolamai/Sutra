/**
 * Thresholds.json NFR mapping + gate compare helpers.
 * Run: node --test benchmarks/gates/thresholds.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  assertThresholdCoverage,
  assertThresholdCoverageAsync,
  evaluateP95Gate,
  formatGateRow,
  listBenchIds,
  loadThresholds,
  parseThresholdsDocument,
  validateThresholdsGate,
} from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS_PATH = path.join(__dirname, "thresholds.json");
const BENCHMARKS_DIR = path.resolve(__dirname, "..");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.gate.test", ...event })}\n`,
  );
}

test("happy path: thresholds.json loads with NFR-mapped p95 for all benches", async () => {
  const loaded = await loadThresholds(THRESHOLDS_PATH);
  assert.equal(loaded.ok, true, loaded.detail);
  const ids = Object.keys(loaded.document.benches).sort();
  assert.deepEqual(ids, [
    "agent_turn",
    "core_loop",
    "crdt_merge",
    "memory_retrieval",
    "py_agent_runtime",
    "py_sync_merge",
    "router",
    "sync_convergence",
    "sync_roundtrip",
  ]);
  assert.equal(loaded.document.benches.core_loop.nfrId, "NFR-06");
  assert.equal(loaded.document.benches.core_loop.p95Ms, 10);
  assert.equal(loaded.document.benches.crdt_merge.nfrId, "NFR-03");
  assert.equal(loaded.document.benches.sync_roundtrip.nfrId, "NFR-03");
  assert.equal(loaded.document.benches.memory_retrieval.nfrId, "NFR-06");
  assert.ok(loaded.document.benches.memory_retrieval.p95Ms >= 100);
  assert.equal(loaded.document.benches.router.nfrId, "NFR-04");
  assert.equal(loaded.document.benches.router.p95Ms, 50);
  assert.equal(loaded.document.benches.agent_turn.nfrId, "NFR-06");
  assert.equal(loaded.document.benches.agent_turn.p95Ms, 10);
  assert.equal(loaded.document.benches.sync_convergence.nfrId, "NFR-03");
  assert.equal(loaded.document.benches.sync_convergence.p95Ms, 10_000);
  assert.equal(loaded.document.benches.py_sync_merge.runtime, "python");
  assert.equal(loaded.document.benches.py_agent_runtime.runtime, "python");
  assert.equal(loaded.document.policy.autoRelax, false);

  const benchIds = await listBenchIds(BENCHMARKS_DIR);
  const coverage = await assertThresholdCoverageAsync(loaded.document, benchIds, {
    repoRoot: path.resolve(BENCHMARKS_DIR, ".."),
  });
  assert.equal(coverage.ok, true, coverage.detail);

  const validated = await validateThresholdsGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    deviceId: "test-happy",
    measurements: {
      crdt_merge: { p95: 1 },
      memory_retrieval: { p95: 1 },
      sync_roundtrip: { p95: 1 },
      core_loop: { p95: 1 },
      router: { p95: 1 },
      agent_turn: { p95: 1 },
      sync_convergence: { p95: 1 },
      py_sync_merge: { p95: 1 },
      py_agent_runtime: { p95: 1 },
    },
  });
  assert.equal(validated.ok, true, validated.detail);
  log({
    outcome: "ok",
    case: "load-nfr-map",
    subjectId: null,
    count: ids.length,
  });
});

test("edge: seeded slowdown trips p95 gate with measured vs budget headroom", () => {
  const breach = evaluateP95Gate({
    benchId: "core_loop",
    measuredP95: 42,
    budgetP95: 10,
    nfrId: "NFR-06",
    subjectId: null,
    deviceId: "test-slow",
  });
  assert.equal(breach.ok, false);
  assert.equal(breach.failureClass, "p95_breach");
  assert.equal(breach.measuredP95, 42);
  assert.equal(breach.budgetP95, 10);
  assert.ok(breach.headroomPercent < 0);
  const line = formatGateRow(breach);
  assert.match(line, /FAIL/);
  assert.match(line, /measured_p95=/);
  assert.match(line, /budget_p95=/);
  assert.match(line, /headroom=/);
  assert.match(line, /NFR-06/);

  const pass = evaluateP95Gate({
    benchId: "core_loop",
    measuredP95: 2,
    budgetP95: 10,
    nfrId: "NFR-06",
  });
  assert.equal(pass.ok, true);
  assert.ok(pass.headroomPercent > 0);
  log({
    outcome: "rejected",
    case: "seeded-slowdown",
    subjectId: null,
  });
});

test("edge: missing threshold mapping fails loud (never silent pass)", async () => {
  const loaded = await loadThresholds(THRESHOLDS_PATH);
  assert.equal(loaded.ok, true);
  const coverage = assertThresholdCoverage(loaded.document, [
    ...Object.keys(loaded.document.benches),
    "brand_new_bench",
  ]);
  assert.equal(coverage.ok, false);
  assert.equal(coverage.failureClass, "missing_mapping");
  assert.ok(coverage.detail.includes("brand_new_bench"));
  log({
    outcome: "rejected",
    case: "missing-mapping",
    subjectId: null,
  });
});

test("edge: bench failure (missing measured p95) is a gate breach, not a skip", () => {
  const failed = evaluateP95Gate({
    benchId: "sync_roundtrip",
    measuredP95: NaN,
    budgetP95: 50,
    nfrId: "NFR-03",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failureClass, "bench_failed");
  assert.match(formatGateRow(failed), /measured_p95=n\/a/);
  log({
    outcome: "rejected",
    case: "bench-failed",
    subjectId: null,
  });
});

test("sovereignty: telemetry / rows never carry learner content bodies", async () => {
  const validated = await validateThresholdsGate({
    thresholdsPath: THRESHOLDS_PATH,
    benchmarksDir: BENCHMARKS_DIR,
    subjectId: null,
    deviceId: "test-sov",
    measurements: {
      crdt_merge: 0.5,
      memory_retrieval: 0.5,
      sync_roundtrip: 0.5,
      core_loop: 0.5,
      router: 0.5,
      agent_turn: 0.5,
      sync_convergence: 0.5,
      py_sync_merge: 0.5,
      py_agent_runtime: 0.5,
    },
  });
  assert.equal(validated.ok, true);
  const blob = JSON.stringify(validated);
  assert.ok(!blob.includes("utterance"));
  assert.ok(!blob.includes("keystroke"));
  assert.ok(!blob.includes("learner's"));
  log({ outcome: "ok", case: "no-learner-content", subjectId: null });
});

test("edge: autoRelax:true policy rejected at parse boundary", () => {
  const bad = parseThresholdsDocument({
    schemaVersion: "bench-thresholds.v1",
    unit: "ms",
    metric: "p95",
    policy: { autoRelax: true },
    benches: {
      core_loop: {
        benchFile: "core_loop.bench.mjs",
        nfrId: "NFR-06",
        p95Ms: 10,
      },
    },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.failureClass, "policy_violation");
  log({ outcome: "rejected", case: "no-auto-relax", subjectId: null });
});

test("edge: orphan threshold entry without bench file fails coverage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-thresh-"));
  try {
    const docPath = path.join(dir, "thresholds.json");
    const benchesDir = path.join(dir, "benches");
    await writeFile(
      path.join(dir, "noop"),
      "", // ensure dir exists via write then we need benches subdir
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(benchesDir, { recursive: true });
    await writeFile(
      path.join(benchesDir, "fun.bench.mjs"),
      "export default {}\n",
    );
    await writeFile(
      docPath,
      JSON.stringify({
        schemaVersion: "bench-thresholds.v1",
        unit: "ms",
        metric: "p95",
        policy: { autoRelax: false },
        benches: {
          fun: {
            benchFile: "fun.bench.mjs",
            nfrId: "NFR-06",
            p95Ms: 10,
          },
          ghost: {
            benchFile: "ghost.bench.mjs",
            nfrId: "NFR-03",
            p95Ms: 10,
          },
        },
      }),
    );
    const result = await validateThresholdsGate({
      thresholdsPath: docPath,
      benchmarksDir: benchesDir,
      deviceId: "test-orphan",
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "orphan_mapping");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  log({ outcome: "rejected", case: "orphan-mapping", subjectId: null });
});
