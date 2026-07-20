/**
 * Degradation drills — cloud LLM down + edge SLM weights failure.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCloudLlmDownDrill,
  runEdgeSlmFailureDrill,
  formatDegradationDrillReport,
  DEGRADE_CONCURRENCY_CAP,
} from "../_shared/degradation_drill_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRILL = path.join(__dirname, "../chaos/degradation_drills.mjs");
const EDGE_ROOT = path.resolve(__dirname, "../../packages/edge-agent");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.degradation_drills.test", ...event })}\n`,
  );
}

test("happy path: cloud LLM timeout → GUIDE reply + freshness + http 200 class", () => {
  const result = runCloudLlmDownDrill({
    mode: "turn",
    subjectId: "subj-degr-happy",
    deviceId: "edge-degr-happy",
  });
  assert.equal(result.ok, true, result.failureClass ?? result.detail);
  assert.equal(result.degraded, true);
  assert.equal(result.replyStartsWithGuide, true);
  assert.equal(result.freshnessSource, "last-known-good");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fabricated, false);
  assert.match(formatDegradationDrillReport(result), /PASS/);
  log({
    outcome: "ok",
    case: "turn-atr05",
    subjectId: result.subjectId,
  });
});

test("edge: HTTP /v1/agent/turn returns 200 with freshness marker, not 5xx", () => {
  const result = runCloudLlmDownDrill({
    mode: "http",
    subjectId: "subj-degr-http",
    deviceId: "edge-degr-http",
  });
  assert.equal(result.ok, true, result.failureClass ?? result.detail);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.degraded, true);
  assert.equal(result.freshnessSource, "last-known-good");
  log({
    outcome: "ok",
    case: "http-200",
    subjectId: result.subjectId,
    httpStatus: result.httpStatus,
  });
});

test("edge: concurrent same-subject turns each degrade without fabricate", () => {
  assert.ok(DEGRADE_CONCURRENCY_CAP >= 2);
  const result = runCloudLlmDownDrill({
    mode: "concurrent",
    subjectId: "subj-degr-conc",
    deviceId: "edge-degr-conc",
  });
  assert.equal(result.ok, true, result.failureClass ?? result.detail);
  assert.equal(result.concurrent, 2);
  assert.equal(result.fabricated, false);
  log({
    outcome: "ok",
    case: "concurrent",
    subjectId: result.subjectId,
  });
});

test("sovereignty: degraded reply metadata-only; other subject untouched", () => {
  const result = runCloudLlmDownDrill({
    mode: "sovereignty",
    subjectId: "subj-degr-sov",
    deviceId: "edge-degr-sov",
  });
  assert.equal(result.ok, true, result.failureClass ?? result.detail);
  assert.equal(result.contentLeak, false);
  log({
    outcome: "ok",
    case: "sovereignty",
    subjectId: result.subjectId,
  });
});

test("happy path: missing SLM weights → typed init error + telemetry; no crash loop", async () => {
  const result = await runEdgeSlmFailureDrill({
    mode: "missing",
    subjectId: "subj-slm-miss",
    deviceId: "edge-slm-miss",
  });
  assert.equal(result.ok, true, result.detail ?? result.failureClass);
  assert.equal(result.failureClass, "missing_weights");
  assert.equal(result.loadAttempts, 1);
  assert.equal(result.crashLoop, false);
  assert.equal(result.telemetryEmitted, true);
  assert.match(formatDegradationDrillReport(result), /PASS/);
  log({
    outcome: "ok",
    case: "slm-missing",
    subjectId: result.subjectId,
  });
});

test("edge: corrupt weights fail typed; repeated load does not spin", async () => {
  const result = await runEdgeSlmFailureDrill({
    mode: "corrupt",
    subjectId: "subj-slm-corrupt",
    deviceId: "edge-slm-corrupt",
  });
  assert.equal(result.ok, true, result.detail ?? result.failureClass);
  assert.equal(result.failureClass, "corrupt_weights");
  assert.equal(result.loadAttempts, 3);
  assert.equal(result.crashLoop, false);
  log({
    outcome: "ok",
    case: "slm-corrupt",
    subjectId: result.subjectId,
  });
});

test("edge: recover after fixing weights file", async () => {
  const result = await runEdgeSlmFailureDrill({
    mode: "recovery",
    subjectId: "subj-slm-rec",
    deviceId: "edge-slm-rec",
  });
  assert.equal(result.ok, true, result.detail ?? result.failureClass);
  assert.equal(result.recovered, true);
  log({
    outcome: "ok",
    case: "slm-recovery",
    subjectId: result.subjectId,
  });
});

test("sovereignty: SLM init telemetry scoped by subjectId", async () => {
  const result = await runEdgeSlmFailureDrill({
    mode: "sovereignty",
    subjectId: "subj-slm-sov",
    deviceId: "edge-slm-sov",
  });
  assert.equal(result.ok, true, result.detail ?? result.failureClass);
  assert.equal(result.contentLeak, false);
  log({
    outcome: "ok",
    case: "slm-sovereignty",
    subjectId: result.subjectId,
  });
});

test("drill runner wires cloud LLM, edge SLM, and registry crossref", () => {
  const src = readFileSync(DRILL, "utf8");
  assert.match(src, /runCloudLlmDownDrill/);
  assert.match(src, /runEdgeSlmFailureDrill/);
  assert.match(src, /runCrossrefGate/);
  assert.match(src, /cloud_llm_down/);
  assert.match(src, /edge_slm_failure/);
  assert.match(src, /crossref/);
  const slmSrc = readFileSync(
    path.join(EDGE_ROOT, "src/slm_runtime.ts"),
    "utf8",
  );
  assert.match(slmSrc, /LocalWeightSlmRuntime/);
  assert.match(slmSrc, /SlmRuntimeInitError/);
  assert.match(slmSrc, /missing_weights/);
});
