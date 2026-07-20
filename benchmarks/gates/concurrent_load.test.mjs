/**
 * Concurrent-subject load generator — sync + turn endpoints.
 * Run: pnpm --filter @moolam/benchmarks test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SUBJECT_COUNT,
  NFR04_TURN_P95_MS,
  LOAD_SYNC_P95_MS,
  buildSyncRequest,
  buildAgentTurnRequest,
  buildLoadSubjectIds,
  createInProcessLoadClient,
  runConcurrentSubjectLoad,
  evaluateConcurrentLoadGate,
} from "../_shared/concurrent_load_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.join(__dirname, "../load/soak.mjs");

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "benchmarks.concurrent_load.test", ...event })}\n`,
  );
}

test("happy path: C workers spread load across M subjects with zero errors", async () => {
  const subjectCount = 6;
  const concurrency = 4;
  const result = await runConcurrentSubjectLoad({
    client: createInProcessLoadClient(),
    concurrency,
    subjectCount,
    roundsPerWorker: 4,
    warmupRounds: 1,
  });

  assert.equal(result.errorCount, 0);
  assert.equal(result.errorRate, 0);
  assert.equal(result.subjectsTouched.length, subjectCount);
  assert.ok(result.sync.count > 0);
  assert.ok(result.turn.count > 0);
  assert.ok(result.sync.p95 < LOAD_SYNC_P95_MS);
  assert.ok(result.turn.p95 < NFR04_TURN_P95_MS);

  const gate = evaluateConcurrentLoadGate(result);
  assert.equal(gate.ok, true);
  assert.ok((gate.measuredTurnP95 ?? 0) > 0);
  log({
    outcome: "ok",
    case: "happy-concurrent",
    subjectCount,
    concurrency,
    turnP95: result.turn.p95,
  });
});

test("edge: seeded slowdown trips turn p95 gate; fast path has headroom", async () => {
  const slowClient = {
    path: "seeded-slow",
    async postSync() {
      return { ok: true, elapsedMs: 12, status: 200, body: {} };
    },
    async postAgentTurn() {
      return { ok: true, elapsedMs: 99, status: 200, body: {} };
    },
  };
  const slow = await runConcurrentSubjectLoad({
    client: slowClient,
    concurrency: 2,
    subjectCount: 2,
    roundsPerWorker: 3,
    warmupRounds: 0,
  });
  const breach = evaluateConcurrentLoadGate(slow);
  assert.equal(breach.ok, false);
  assert.equal(breach.failureClass, "p95_breach");
  assert.ok(breach.breaches.some((b) => b.metric === "turn_p95"));
  assert.ok(breach.measuredTurnP95 > NFR04_TURN_P95_MS);

  const fast = await runConcurrentSubjectLoad({
    client: createInProcessLoadClient(),
    concurrency: 2,
    subjectCount: 2,
    roundsPerWorker: 2,
    warmupRounds: 0,
  });
  const ok = evaluateConcurrentLoadGate(fast);
  assert.equal(ok.ok, true);
  assert.ok(ok.turnBudget - ok.measuredTurnP95 > 0);
  log({ outcome: "ok", case: "seeded-slowdown", subjectId: null });
});

test("edge: validation_failed for bad subject; soak uses public wire paths", () => {
  assert.throws(
    () => buildSyncRequest("", "edge-xxxx"),
    (err) => err.failureClass === "validation_failed",
  );
  assert.throws(
    () => buildAgentTurnRequest(""),
    (err) => err.failureClass === "validation_failed",
  );
  const src = readFileSync(SOAK, "utf8");
  assert.match(src, /\/v1\/sync|\/v1\/agent\/turn/);
  assert.doesNotMatch(src, /test-only backdoor|BYPASS/i);
  log({ outcome: "ok", case: "validation", subjectId: null });
});

test("sovereignty: subject isolation — distinct subjects; telemetry omits utterance", async () => {
  const ids = buildLoadSubjectIds(3, "subj-iso");
  const a = buildSyncRequest(ids[0], "edge-iso-a", 2);
  const b = buildSyncRequest(ids[1], "edge-iso-b", 2);
  assert.notEqual(a.edgeState.subjectId, b.edgeState.subjectId);
  assert.ok(a.edgeState.frictionLog.every((s) => !("utterance" in s)));

  const result = await runConcurrentSubjectLoad({
    client: createInProcessLoadClient(),
    subjectIds: ids,
    concurrency: 3,
    roundsPerWorker: 1,
    warmupRounds: 0,
  });
  assert.deepEqual(result.subjectsTouched.sort(), ids.sort());

  const blob = JSON.stringify({
    subjects: result.subjectsTouched,
    syncP95: result.sync.p95,
  });
  assert.ok(!blob.includes("ratio guidance probe"));
  assert.ok(!blob.includes("utterance"));
  log({ outcome: "ok", case: "subject-isolation", subjectId: null });
});

test("edge: default concurrency and subject spread match design constants", () => {
  assert.equal(DEFAULT_CONCURRENCY, 8);
  assert.equal(DEFAULT_SUBJECT_COUNT, 16);
  const ids = buildLoadSubjectIds(DEFAULT_SUBJECT_COUNT);
  assert.equal(ids.length, DEFAULT_SUBJECT_COUNT);
  assert.equal(new Set(ids).size, DEFAULT_SUBJECT_COUNT);
  log({ outcome: "ok", case: "design-constants", subjectId: null });
});
