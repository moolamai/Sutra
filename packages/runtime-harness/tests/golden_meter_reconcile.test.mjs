/**
 * Golden-turn metering reconciliation — local vs provider usage.
 * Fixtures: fixtures/metering-reconcile/ (language-neutral JSON).
 * Documented tolerance: exact field-wise match (0).
 * Run: pnpm --filter @moolam/runtime-harness test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  METERING_RECONCILE_FIXTURE_RELPATH,
  METER_GOLDEN_TOKEN_TOLERANCE,
  StreamingTurnHost,
  TurnMeter,
  canonicalizeMeterEventsJson,
  loadGoldenTurnCorpus,
  reconcileMeterTokensWithinTolerance,
  replayGoldenMeterReconcileCase,
  unifiedDiff,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const FIXTURE_DIR = join(PKG, METERING_RECONCILE_FIXTURE_RELPATH);

function log(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function loadCorpus() {
  const raw = readFileSync(join(FIXTURE_DIR, "golden-turns.json"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  return JSON.parse(raw);
}

function loadManifest() {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8").replace(/\r\n/g, "\n"),
  );
}

function fakeBus() {
  const events = [];
  return {
    events,
    publish(e) {
      events.push(e);
    },
    subscribe() {
      return () => {};
    },
  };
}

test("fixture: metering-reconcile corpus documents exact tolerance policy", () => {
  const manifest = loadManifest();
  const corpus = loadCorpus();
  assert.equal(manifest.tolerancePolicy, "exact-field-wise-match");
  assert.equal(corpus.tolerancePolicy, "exact-field-wise-match");
  assert.deepEqual(corpus.tokenTolerance, METER_GOLDEN_TOKEN_TOLERANCE);
  assert.ok(Array.isArray(corpus.cases));
  assert.ok(corpus.cases.length >= 5);
  const ids = new Set(corpus.cases.map((c) => c.id));
  for (const required of [
    "complete-match",
    "cache-hit-only",
    "aborted-partial",
    "multi-model-handoff",
    "provider-discrepancy",
  ]) {
    assert.ok(ids.has(required), `missing case ${required}`);
  }
});

test("happy path: every golden case reconciles byte-identically", () => {
  const corpus = loadCorpus();
  for (const fixtureCase of corpus.cases) {
    const result = replayGoldenMeterReconcileCase(fixtureCase);
    if (!result.ok) {
      if (result.canonicalJson && result.expectedCanonicalJson) {
        process.stdout.write(
          unifiedDiff(result.expectedCanonicalJson, result.canonicalJson, {
            fromFile: `${fixtureCase.id}.expected`,
            toFile: `${fixtureCase.id}.actual`,
          }),
        );
      }
      assert.fail(`${fixtureCase.id}: ${result.detail}`);
    }
    assert.equal(result.canonicalJson, result.expectedCanonicalJson);
    assert.equal(
      result.totalPromptTokens,
      result.totals.inputTokens + result.totals.cachedInputTokens,
    );
    // Sovereignty: telemetry/result must not carry learner content.
    assert.ok(!JSON.stringify(result).includes("Metered reply"));
    log({
      event: "runtime.harness.meter_reconcile",
      outcome: "ok",
      subjectId: result.subjectId,
      deviceId: result.deviceId,
      caseId: result.caseId,
      reconcileOk: result.reconcile.ok,
      discrepancy: result.discrepancy,
      aborted: result.aborted,
    });
  }
});

test("happy path: complete-match aligns with A P6 meter-tick golden tick", () => {
  const corpus = loadCorpus();
  const complete = corpus.cases.find((c) => c.id === "complete-match");
  assert.equal(complete.aP6GoldenTurnId, "meter-tick");

  const loaded = loadGoldenTurnCorpus();
  assert.equal(loaded.ok, true);
  const aP6 = loaded.fixtures.find((f) => f.id === "meter-tick");
  assert.ok(aP6);
  const meterFrame = aP6.expectedFrames.find((f) => f.type === "METER_TICK");
  assert.ok(meterFrame);

  assert.equal(
    canonicalizeMeterEventsJson([meterFrame.tick]),
    canonicalizeMeterEventsJson(complete.expected.events),
  );

  const replayed = replayGoldenMeterReconcileCase(complete);
  assert.equal(replayed.ok, true);
  assert.deepEqual(replayed.events[0], meterFrame.tick);
});

test("edge: host flushMeterAndReconcile matches golden provider usage", () => {
  const corpus = loadCorpus();
  const complete = corpus.cases.find((c) => c.id === "complete-match");
  let t = complete.startedAtMs;
  const turnMeter = new TurnMeter({
    subjectId: complete.subjectId,
    deviceId: complete.deviceId,
    modelId: complete.modelId,
    locality: complete.locality,
    startedAtMs: complete.startedAtMs,
    now: () => {
      t = complete.startedAtMs + complete.latencyMs;
      return t;
    },
  });
  for (const record of complete.records) {
    assert.equal(turnMeter.record(record).ok, true);
  }

  const bus = fakeBus();
  const host = new StreamingTurnHost({
    subjectId: complete.subjectId,
    correlationId: "corr-golden-meter",
    deviceId: complete.deviceId,
    sessionId: complete.sessionId,
    turnMeter,
    eventBus: bus,
  });
  assert.equal(host.emitSessionStart("2026-07-15T00:00:00.000Z").ok, true);

  const result = host.flushMeterAndReconcile(complete.providerUsage, {
    tokenTolerance: complete.tokenTolerance,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reconcile.ok, true);
  assert.equal(result.discrepancy, false);
  assert.equal(result.flush.framesEmitted, 1);
  assert.equal(result.flush.spinePublished, 1);
  assert.equal(bus.events[0].type, "harness.meter");
  assert.equal(bus.events[0].payload.subjectId, "anika-k");
  assert.equal("prompt" in bus.events[0].payload, false);
});

test("edge: tolerance-0 fails when provider conflates cached into fresh", () => {
  const local = {
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 2,
  };
  const conflated = reconcileMeterTokensWithinTolerance(
    local,
    { inputTokens: 15, cachedInputTokens: 0, outputTokens: 2 },
    METER_GOLDEN_TOKEN_TOLERANCE,
  );
  assert.equal(conflated.ok, false);
  assert.equal(conflated.field, "inputTokens");
});

test("sovereignty: cross-subject golden case is rejected", () => {
  const corpus = loadCorpus();
  const base = corpus.cases.find((c) => c.id === "complete-match");
  const poisoned = {
    ...base,
    id: "cross-subject-poison",
    subjectId: "",
  };
  const result = replayGoldenMeterReconcileCase(poisoned);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "missing_subject");
});

test("scalability: corpus case count stays bounded", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.cases.length <= 64);
  for (const c of corpus.cases) {
    assert.ok(c.records.length <= 16);
    assert.ok(c.expected.events.length <= 16);
  }
});
