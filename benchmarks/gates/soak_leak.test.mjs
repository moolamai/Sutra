/**
 * Soak leak detection — RSS + handle growth after warmup.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOAK_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_WARMUP_SAMPLES,
  DEFAULT_RSS_GROWTH_TOLERANCE_BYTES,
  evaluateMonotonicGrowth,
  evaluateSoakLeakGate,
  formatSoakLeakGateReport,
  parseDockerMemBytes,
  runSoakWithLeakDetection,
  sampleEdgeHarnessResources,
} from "../_shared/soak_leak_probe.mjs";
import { createInProcessLoadClient, runConcurrentSubjectLoad } from "../_shared/concurrent_load_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.join(__dirname, "../load/soak.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.soak_leak.test", ...event })}\n`,
  );
}

function flatSeries(target, n, rss = 100_000_000, handles = 40) {
  return Array.from({ length: n }, (_, i) => ({
    target,
    atMs: 1_000 + i * 60_000,
    rssBytes: rss,
    handleCount: handles,
  }));
}

test("happy path: flat post-warmup samples pass leak gate", () => {
  const series = {
    edge: flatSeries("edge", 6),
    orchestrator: flatSeries("orchestrator", 6, 200_000_000, 20),
  };
  const gate = evaluateSoakLeakGate(series, { warmupSamples: 2 });
  assert.equal(gate.ok, true);
  const report = formatSoakLeakGateReport(gate, { soakMs: DEFAULT_SOAK_MS });
  assert.match(report, /PASS/);
  assert.match(report, /soak leak gate/);
  log({ outcome: "ok", case: "flat-pass", subjectId: null });
});

test("edge: seeded monotonic RSS growth trips leak gate with printed budget", () => {
  const leaking = Array.from({ length: 8 }, (_, i) => ({
    target: "edge",
    atMs: i * 60_000,
    rssBytes: 50_000_000 + i * 20_000_000,
    handleCount: 10 + i,
  }));
  const row = evaluateMonotonicGrowth(leaking, {
    warmupSamples: 2,
    rssGrowthToleranceBytes: 30_000_000,
    metricKey: "rssBytes",
    target: "edge",
  });
  assert.equal(row.ok, false);
  assert.equal(row.failureClass, "leak_detected");
  assert.ok(row.measuredGrowth > row.budget);

  const gate = evaluateSoakLeakGate(
    {
      edge: leaking,
      orchestrator: flatSeries("orchestrator", 8),
    },
    { warmupSamples: 2, rssGrowthToleranceBytes: 30_000_000 },
  );
  assert.equal(gate.ok, false);
  assert.match(formatSoakLeakGateReport(gate), /FAIL/);
  assert.match(formatSoakLeakGateReport(gate), /measured_growth=/);
  assert.match(formatSoakLeakGateReport(gate), /budget=/);
  log({ outcome: "rejected", case: "seeded-rss-leak", subjectId: null });
});

test("edge: handle monotonic growth trips gate; insufficient samples fail loud", () => {
  const handles = Array.from({ length: 6 }, (_, i) => ({
    target: "orchestrator",
    atMs: i,
    rssBytes: 80_000_000,
    handleCount: 5 + i * 20,
  }));
  const row = evaluateMonotonicGrowth(handles, {
    warmupSamples: 1,
    handleGrowthTolerance: 10,
    metricKey: "handleCount",
    target: "orchestrator",
  });
  assert.equal(row.ok, false);
  assert.equal(row.failureClass, "leak_detected");

  const short = evaluateMonotonicGrowth(flatSeries("edge", 2), {
    warmupSamples: 2,
  });
  assert.equal(short.ok, false);
  assert.equal(short.failureClass, "insufficient_samples");
  log({ outcome: "ok", case: "handle-and-sample-floor", subjectId: null });
});

test("happy path: short soak with in-process load samples edge resources", async () => {
  let clock = 0;
  const client = createInProcessLoadClient();
  const result = await runSoakWithLeakDetection({
    soakMs: 3,
    sampleIntervalMs: 1,
    warmupSamples: 1,
    nowMs: () => clock,
    sleepMs: async (ms) => {
      clock += Math.max(ms, 1);
    },
    sampleEdge: ({ nowMs }) => ({
      target: "edge",
      atMs: nowMs,
      rssBytes: 90_000_000,
      handleCount: 25,
    }),
    sampleOrchestrator: async ({ nowMs }) => ({
      target: "orchestrator",
      atMs: nowMs,
      rssBytes: 120_000_000,
      handleCount: 12,
      source: "test",
    }),
    runLoadCycle: async () =>
      runConcurrentSubjectLoad({
        client,
        concurrency: 2,
        subjectCount: 2,
        roundsPerWorker: 1,
        warmupRounds: 0,
      }),
  });
  assert.ok(result.ticks >= 3);
  assert.equal(result.leakGate.ok, true);
  assert.ok(result.loadResults.every((r) => r.errorCount === 0));
  log({
    outcome: "ok",
    case: "short-soak-in-process",
    ticks: result.ticks,
    subjectId: null,
  });
});

test("sovereignty: samples scoped without utterance; soak uses public paths", () => {
  const snap = sampleEdgeHarnessResources({ nowMs: 1 });
  assert.equal(snap.target, "edge");
  assert.ok(!("utterance" in snap));
  assert.ok(Number.isFinite(snap.rssBytes));

  assert.equal(parseDockerMemBytes("128.5MiB"), Math.round(128.5 * 1024 * 1024));
  assert.ok(Number.isNaN(parseDockerMemBytes("")));

  const src = readFileSync(SOAK, "utf8");
  assert.match(src, /runSoakWithLeakDetection/);
  assert.match(src, /\/v1\/sync|concurrent/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  assert.equal(DEFAULT_SOAK_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_SAMPLE_INTERVAL_MS, 60_000);
  assert.equal(DEFAULT_WARMUP_SAMPLES, 2);
  assert.equal(DEFAULT_RSS_GROWTH_TOLERANCE_BYTES, 64 * 1024 * 1024);
  log({ outcome: "ok", case: "sovereignty-constants", subjectId: null });
});

test("edge: validation_failed when runLoadCycle missing", async () => {
  await assert.rejects(
    () => runSoakWithLeakDetection({ soakMs: 10, sampleIntervalMs: 1 }),
    (err) => err.failureClass === "validation_failed",
  );
  log({ outcome: "ok", case: "validation", subjectId: null });
});
