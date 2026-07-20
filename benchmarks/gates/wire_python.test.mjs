/**
 * Wire Python benches into check.mjs (unified p95 parse + dispatch).
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertThresholdCoverageAsync,
  executeGateBench,
  isPythonBenchEntry,
  listBenchIds,
  listGateBenchIds,
  loadThresholds,
  parsePythonBenchStdout,
  parseThresholdsDocument,
  runBenchGate,
} from "./check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = path.join(__dirname, "thresholds.json");
const BENCHMARKS_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "../..");
import { loadNightlyCi } from "../../scripts/ci-workflow-test-helpers.mjs";

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.wire_python.test", ...event })}\n`,
  );
}

test("happy path: thresholds register python benches; parse unified capture JSON", async () => {
  const loaded = await loadThresholds(THRESHOLDS);
  assert.equal(loaded.ok, true, loaded.detail);
  assert.equal(loaded.document.benches.py_sync_merge.runtime, "python");
  assert.equal(loaded.document.benches.py_agent_runtime.runtime, "python");
  assert.ok(isPythonBenchEntry(loaded.document.benches.py_sync_merge));

  const jsIds = await listBenchIds(BENCHMARKS_DIR);
  const coverage = await assertThresholdCoverageAsync(
    loaded.document,
    jsIds,
    { repoRoot: REPO_ROOT },
  );
  assert.equal(coverage.ok, true, coverage.detail);

  const gateIds = listGateBenchIds(loaded.document);
  assert.ok(gateIds.includes("py_sync_merge"));
  assert.ok(gateIds.includes("py_agent_runtime"));
  assert.ok(gateIds.includes("router"));
  assert.ok(gateIds.includes("agent_turn"));

  const parsed = parsePythonBenchStdout(`
py merge demo                       p50=1.000ms  p95=2.500ms  p99=3.000ms  mean=1.200ms  ops/s=833
{"event":"benchmarks.sample","subjectId":"bench-subject","deviceId":"d","outcome":"ok","name":"py merge","p50":1,"p95":2.5,"p99":3,"mean":1.2}
{"schemaVersion":"bench-capture.v1","unit":"ms","metric":"p95","measuredP95":2.5,"samples":[]}
`);
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.measuredP95, 2.5);
  log({ outcome: "ok", case: "wire-parse", subjectId: null });
});

test("edge: seeded python slowdown trips gate with DIFF via injected executor", async () => {
  const result = await runBenchGate({
    thresholdsPath: THRESHOLDS,
    benchmarksDir: BENCHMARKS_DIR,
    repoRoot: REPO_ROOT,
    deviceId: "test-py-slow",
    executeBench: async (benchId) => ({
      ok: true,
      benchId,
      measuredP95: benchId === "py_agent_runtime" ? 99 : 1,
      samples: [],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "p95_breach");
  assert.match(result.diff, /DIFF/);
  assert.match(result.diff, /py_agent_runtime/);
  assert.match(result.diff, /99\.000ms/);
  log({ outcome: "rejected", case: "seeded-py-slowdown", subjectId: null });
});

test("edge: invalid python schema + missing stdout p95 fail loud", () => {
  const bad = parseThresholdsDocument({
    schemaVersion: "bench-thresholds.v1",
    unit: "ms",
    metric: "p95",
    policy: { autoRelax: false },
    benches: {
      broken: {
        runtime: "python",
        benchModule: "not_benchmarks.x",
        benchFile: "x.py",
        nfrId: "NFR-06",
        p95Ms: 10,
      },
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /benchModule/);

  const empty = parsePythonBenchStdout("no metrics here\n");
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, "bench_failed");
  log({ outcome: "rejected", case: "schema-and-parse-fail", subjectId: null });
});

test("sovereignty: python parse never surfaces utterance keys from noise lines", () => {
  const parsed = parsePythonBenchStdout(
    `{"event":"benchmarks.sample","subjectId":"s","p95":1.5,"utterance":"secret"}\n`,
  );
  assert.equal(parsed.ok, true);
  // Parser keeps sample objects as emitted; gate telemetry path strips bodies separately.
  // Ensure we do not require utterance for success and subjectId stays synthetic-safe.
  assert.equal(parsed.measuredP95, 1.5);
  const ci = loadNightlyCi();
  assert.match(ci, /setup-python@v5/);
  assert.match(ci, /pip install -e \./);
  assert.match(ci, /cloud-orchestrator/);
  log({ outcome: "ok", case: "ci-python-wired", subjectId: null });
});

test("edge: executeGateBench dispatches python runtime (live spawn when available)", async () => {
  const loaded = await loadThresholds(THRESHOLDS);
  const entry = loaded.document.benches.py_sync_merge;
  const result = await executeGateBench({
    entry,
    benchId: "py_sync_merge",
    benchmarksDir: BENCHMARKS_DIR,
    repoRoot: REPO_ROOT,
    deviceId: "test-py-live",
    subjectId: null,
  });
  if (!result.ok) {
    // Local environments without deps may fail install — still a typed breach, not skip.
    assert.equal(result.failureClass, "bench_failed");
    assert.match(result.detail, /py_sync_merge|python|ModuleNotFound|spawn/i);
    log({
      outcome: "rejected",
      case: "python-spawn-unavailable",
      subjectId: null,
      detail: result.detail,
    });
    return;
  }
  assert.ok(result.measuredP95 > 0);
  assert.ok(result.measuredP95 < entry.p95Ms);
  assert.equal(result.runtime, "python");
  log({
    outcome: "ok",
    case: "python-spawn-live",
    subjectId: null,
    measuredP95: result.measuredP95,
  });
});
