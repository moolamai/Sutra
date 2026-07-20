// Minimal benchmark harness: warmup, timed iterations, p50/p95/p99 report.
// Structured telemetry carries subjectId/deviceId only — never learner content.
// Capture session lets gates/check.mjs read p95 after importing a *.bench.mjs.

/** Synthetic subject used by microbenches (never a real learner id). */
export const BENCH_SUBJECT_ID = "bench-subject";

/** Soft cap on captured samples per bench module import. */
export const BENCH_CAPTURE_LIMIT = 32;

/** @type {{ name: string, p50: number, p95: number, p99: number, mean: number, subjectId: string, deviceId: string }[]} */
let captureSession = [];
let captureEnabled = false;

export function beginBenchCapture() {
  captureEnabled = true;
  captureSession = [];
}

export function endBenchCapture() {
  captureEnabled = false;
  const samples = captureSession;
  captureSession = [];
  return samples;
}

export function getBenchCapture() {
  return captureSession.slice();
}

/**
 * Worst-case p95 across captured samples in one bench module (multi-size files).
 */
export function maxP95FromCapture(samples) {
  if (!samples.length) return NaN;
  return samples.reduce((m, s) => (s.p95 > m ? s.p95 : m), samples[0].p95);
}

/**
 * Build a baseline document from measured p95 map (PR-reviewed refresh aid).
 * Checker never auto-writes or auto-relaxes committed baselines.
 */
export function buildBaselineDocument(input) {
  const {
    measurements,
    recordedAt = new Date().toISOString(),
    deviceId = "bench-harness",
    subjectId = null,
    nfrByBench = {},
    note,
    /** Round p95 to this many decimals for stable JSON (default 3). */
    p95Decimals = 3,
  } = input;
  const benches = {};
  for (const benchId of Object.keys(measurements).sort()) {
    const value = measurements[benchId];
    const raw =
      value && typeof value === "object" ? Number(value.p95Ms ?? value.p95) : Number(value);
    const factor = 10 ** p95Decimals;
    const p95Ms = Math.round(raw * factor) / factor;
    benches[benchId] = {
      p95Ms,
      ...(nfrByBench[benchId] ? { nfrId: nfrByBench[benchId] } : {}),
    };
  }
  return {
    schemaVersion: "bench-baseline.v1",
    unit: "ms",
    metric: "p95",
    recordedAt,
    deviceId,
    subjectId,
    ...(note !== undefined ? { note } : {}),
    benches,
  };
}

/** Canonical operator note stored in baseline.json (PR-reviewed updates only). */
export const BASELINE_UPDATE_NOTE =
  "Regression reference for CI `ci:gate` (absolute ceilings + relative ±50% vs this file). " +
  "Checker never auto-rewrites or auto-relaxes baselines. " +
  "To refresh after intentional perf work: (1) pnpm build from repo root, " +
  "(2) pnpm --filter @moolam/benchmarks baseline:record, " +
  "(3) pnpm --filter @moolam/benchmarks ci:gate, " +
  "(4) open a PR that updates gates/baseline.json with rationale — never push baseline-only without review.";

export function percentileFromSorted(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

/**
 * Emit a structured bench sample event for gate consumers.
 * Never includes utterance / prompt / keystroke bodies.
 */
export function emitBenchTelemetry(event) {
  process.stdout.write(
    `${JSON.stringify({
      event: "benchmarks.sample",
      subjectId: event.subjectId ?? BENCH_SUBJECT_ID,
      ...event,
    })}\n`,
  );
}

export async function bench(
  name,
  fn,
  {
    warmup = 20,
    iterations = 200,
    subjectId = BENCH_SUBJECT_ID,
    deviceId = "bench-harness",
    emitStructured = false,
  } = {},
) {
  for (let i = 0; i < warmup; i++) await fn(i);

  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples[i] = performance.now() - t0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentileFromSorted(sorted, 50);
  const p95 = percentileFromSorted(sorted, 95);
  const p99 = percentileFromSorted(sorted, 99);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

  console.log(
    `${name.padEnd(38)} p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  p99=${p99.toFixed(3)}ms  mean=${mean.toFixed(3)}ms  ops/s=${(1000 / mean).toFixed(0)}`,
  );

  const result = { p50, p95, p99, mean, subjectId, deviceId, name };

  if (captureEnabled && captureSession.length < BENCH_CAPTURE_LIMIT) {
    captureSession.push({
      name,
      p50,
      p95,
      p99,
      mean,
      subjectId,
      deviceId,
    });
  }

  if (emitStructured) {
    emitBenchTelemetry({
      outcome: "ok",
      name,
      subjectId,
      deviceId,
      p50,
      p95,
      p99,
      mean,
      iterations,
    });
  }

  return result;
}
