/**
 * Offline-horizon clock seam + NFR-02 proof metrics (P3 observability spine).
 * Simulated days advance without wall-clock wait.
 * Run: pnpm --filter @moolam/edge-agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InProcessEventBus } from "@moolam/runtime";
import {
  assertSpanExportPrivacy,
  initObservability,
  shutdownObservability,
  TURN_STAGE_NAMES,
} from "@moolam/observability";
import { compareHLC } from "@moolam/sync-protocol";
import { CognitiveTelemetryCollector } from "@moolam/telemetry";
import {
  createLocalVectorMemoryDriver,
  EdgeAgent,
  EDGE_NFR02_PROOF,
  NFR02_PROOF_THRESHOLDS,
} from "../dist/index.js";

const DAY_MS = 86_400_000;
const START_MS = 1_700_000_000_000;

function mockRuntime() {
  return {
    descriptor: {
      modelId: "mock-phi",
      quantization: "q4",
      contextWindow: 4096,
      languages: ["en"],
    },
    load: async () => {},
    generate: async () => ({
      text: "on-device reply",
      tokensPerSecond: 40,
      finishReason: "stop",
    }),
    embed: async (text) => {
      const out = new Float32Array(8);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
      out[0] = (h % 997) / 997;
      return out;
    },
  };
}

/** Test-owned monotonic wall clock — advances simulated days in-process. */
function manualClock(startMs = START_MS) {
  let ms = startMs;
  return {
    nowMs: () => ms,
    advanceMs(delta) {
      if (!(delta >= 0) || !Number.isFinite(delta)) {
        const err = new Error("clock advanceMs requires non-negative finite delta");
        err.failureClass = "validation_failed";
        throw err;
      }
      ms += delta;
    },
    advanceDays(days) {
      this.advanceMs(days * DAY_MS);
    },
    setMs(next) {
      ms = next;
    },
    getMs: () => ms,
  };
}

/** Approximate bytes for one durable friction_samples row (text columns + ints). */
function frictionRowApproxBytes(row) {
  return (
    String(row.captured_at).length +
    String(row.concept_id).length +
    String(row.outcome).length +
    48
  );
}

/**
 * In-memory StorageDriver for horizon proofs: memory_records + friction_samples.
 * (createLocalVectorMemoryDriver alone does not persist CAST telemetry rows.)
 * Tracks unbounded full-table friction scans for NFR-02 degradation proofs.
 */
function horizonStorageDriver() {
  const memory = createLocalVectorMemoryDriver();
  const friction = new Map();
  let frictionBytes = 0;
  let unboundedFrictionFullScans = 0;
  return {
    rowCount: () => memory.rowCount(),
    frictionCount: () => friction.size,
    frictionApproxBytes: () => frictionBytes,
    unboundedFrictionFullScans: () => unboundedFrictionFullScans,
    async execute(sql, params = []) {
      const s = sql.trim();
      if (s.includes("friction_samples") || s.includes("CREATE TABLE IF NOT EXISTS friction")) {
        if (s.startsWith("CREATE")) return;
        if (s.includes("INSERT")) {
          const key = params[0];
          if (!friction.has(key)) {
            const row = {
              captured_at: params[0],
              concept_id: params[1],
              hesitation_ms: params[2],
              input_velocity: params[3],
              revision_count: params[4],
              assistance_requested: params[5],
              outcome: params[6],
              synced: 0,
            };
            friction.set(key, row);
            frictionBytes += frictionRowApproxBytes(row);
          }
          return;
        }
        if (s.includes("UPDATE") && s.includes("synced")) {
          const row = friction.get(params[0]);
          if (row) row.synced = 1;
          return;
        }
        return;
      }
      return memory.execute(sql, params);
    },
    async query(sql, params = []) {
      if (sql.includes("friction_samples")) {
        const hasLimit = /LIMIT\s+\d+/i.test(sql);
        const isStar = /SELECT\s+\*/i.test(sql);
        if (isStar && !hasLimit) {
          unboundedFrictionFullScans += 1;
        }
        if (sql.includes("COUNT(*)")) {
          if (sql.includes("synced = 0")) {
            const n = [...friction.values()].filter((r) => r.synced === 0).length;
            return [{ n }];
          }
          return [{ n: friction.size }];
        }
        if (hasLimit && sql.includes("captured_at")) {
          const sorted = [...friction.values()].sort((a, b) =>
            a.captured_at < b.captured_at ? -1 : 1,
          );
          if (sorted.length === 0) return [];
          const row = /DESC/i.test(sql)
            ? sorted[sorted.length - 1]
            : sorted[0];
          return [{ captured_at: row.captured_at }];
        }
        return [...friction.values()]
          .filter((r) => r.synced === 0)
          .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));
      }
      return memory.query(sql, params);
    },
  };
}

function makeAgent(overrides = {}) {
  return new EdgeAgent({
    subjectId: "subj-horizon",
    deviceId: "edge-horizon",
    runtime: mockRuntime(),
    storage: horizonStorageDriver(),
    profile: {
      ageBand: "adult",
      track: "bench-track",
      language: "en-IN",
    },
    attachEventBusSpans: false,
    // Permanently offline — no transport (NFR-02 sovereign mode).
    ...overrides,
  });
}

test("happy path: injected clock advances simulated days; wall-clock stays short", async () => {
  const clock = manualClock();
  const t0 = performance.now();
  const agent = makeAgent({ nowMs: clock.nowMs });
  await agent.initialize();
  // No transport → permanently-offline sovereign mode (syncNow reports offline).
  const sync = await agent.syncNow();
  assert.equal(sync.status, "offline-mode");

  assert.equal(agent.wallNowMs(), START_MS);
  assert.equal(agent.telemetryCollector.nowMs(), START_MS);

  const t1 = agent.hlcClock.tick();
  clock.advanceDays(3);
  assert.equal(agent.wallNowMs(), START_MS + 3 * DAY_MS);
  const t2 = agent.hlcClock.tick();
  assert.ok(compareHLC(t2, t1) > 0, "HLC advances with simulated days");
  assert.equal(Number(t2.slice(0, 15)), START_MS + 3 * DAY_MS);

  const elapsedWall = performance.now() - t0;
  assert.ok(
    elapsedWall < 5_000,
    `wall-clock must stay minutes-scale, got ${elapsedWall.toFixed(1)}ms`,
  );
});

test("edge: DST-style backward jump stays HLC-monotonic (no spurious ordering)", async () => {
  const clock = manualClock(START_MS);
  const agent = makeAgent({ nowMs: clock.nowMs, deviceId: "edge-dst" });
  await agent.initialize();

  const before = agent.hlcClock.tick();
  // Jump "backward" across a DST boundary — wall clock regresses.
  clock.setMs(START_MS - DAY_MS);
  const after = agent.hlcClock.tick();
  assert.ok(
    compareHLC(after, before) > 0,
    "HLC must remain strictly monotonic when wall clock regresses",
  );
  // Physical stays at last peak; logical bumps (HlcClock contract).
  assert.equal(Number(after.slice(0, 15)), START_MS);
});

test("edge: collector shared clock; CAST write-ahead survives restart with advanced seam", async () => {
  const clock = manualClock(START_MS);
  const storage = horizonStorageDriver();

  const agent1 = makeAgent({
    subjectId: "subj-cast",
    deviceId: "edge-cast-a",
    storage,
    nowMs: clock.nowMs,
  });
  await agent1.initialize();
  const col = agent1.telemetryCollector;
  const at = clock.getMs();
  col.observe({ type: "prompt-rendered", conceptId: "c.horizon", atMs: at });
  col.observe({ type: "input", charsDelta: 4, atMs: at + 50 });
  const sample1 = await col.submitted("correct", at + 100);
  assert.ok(sample1);
  assert.equal((await col.unsynced()).length, 1);

  clock.advanceDays(2);
  // "Restart": new agent/collector over same durable store + same clock seam.
  const agent2 = makeAgent({
    subjectId: "subj-cast",
    deviceId: "edge-cast-a",
    storage,
    nowMs: clock.nowMs,
  });
  await agent2.initialize();
  const unsynced = await agent2.telemetryCollector.unsynced();
  assert.equal(unsynced.length, 1);
  assert.equal(unsynced[0].capturedAt, sample1.capturedAt);

  const at2 = clock.getMs();
  agent2.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.horizon",
    atMs: at2,
  });
  const sample2 = await agent2.telemetryCollector.submitted("correct", at2 + 10);
  assert.ok(sample2);
  assert.ok(compareHLC(sample2.capturedAt, sample1.capturedAt) > 0);
});

test("sovereignty: subject clocks isolated — cross-subject storage never mixes samples", async () => {
  const clockA = manualClock(START_MS);
  const clockB = manualClock(START_MS + DAY_MS);
  const storageA = horizonStorageDriver();
  const storageB = horizonStorageDriver();

  const a = makeAgent({
    subjectId: "subj-a",
    deviceId: "edge-a",
    storage: storageA,
    nowMs: clockA.nowMs,
  });
  const b = makeAgent({
    subjectId: "subj-b",
    deviceId: "edge-b",
    storage: storageB,
    nowMs: clockB.nowMs,
  });
  await a.initialize();
  await b.initialize();

  const tA = clockA.getMs();
  a.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.a",
    atMs: tA,
  });
  const sampleA = await a.telemetryCollector.submitted("correct", tA + 1);
  assert.ok(sampleA);

  const tB = clockB.getMs();
  b.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.b",
    atMs: tB,
  });
  const sampleB = await b.telemetryCollector.submitted("incorrect", tB + 1);
  assert.ok(sampleB);

  assert.equal((await a.telemetryCollector.unsynced()).length, 1);
  assert.equal((await b.telemetryCollector.unsynced()).length, 1);
  assert.notEqual(sampleA.capturedAt, sampleB.capturedAt);
  assert.match(sampleA.capturedAt, /:edge-a$/);
  assert.match(sampleB.capturedAt, /:edge-b$/);
  // No learner utterance bodies in captured samples.
  assert.equal("utterance" in sampleA, false);
});

test("edge: telemetry collector accepts standalone nowMs seam with injected HlcClock", async () => {
  const clock = manualClock(START_MS);
  const { HlcClock } = await import("@moolam/sync-protocol");
  const driver = horizonStorageDriver();
  const hlc = new HlcClock("test-telem", clock.nowMs);
  const collector = new CognitiveTelemetryCollector(driver, hlc, {
    nowMs: clock.nowMs,
  });
  await collector.initialize();
  assert.equal(collector.nowMs(), START_MS);
  clock.advanceDays(1);
  assert.equal(collector.nowMs(), START_MS + DAY_MS);
  const tick = collector.hlcClock.tick();
  assert.equal(Number(tick.slice(0, 15)), START_MS + DAY_MS);
});

/* ── Multi-day offline simulation harness (NFR-02) ───────────────────── */

const HORIZON_TURNS = 5_000;
const HORIZON_DAYS = 30;
/** Budgets aligned with committed {@link NFR02_PROOF_THRESHOLDS}. */
const BUDGET = {
  foldP95Ms: NFR02_PROOF_THRESHOLDS.foldP95MsMax,
  castPersistP95Ms: NFR02_PROOF_THRESHOLDS.castPersistP95MsMax,
  turnP95Ms: NFR02_PROOF_THRESHOLDS.turnP95MsMax,
  wallMaxMs: NFR02_PROOF_THRESHOLDS.wallMsMax,
  maxBytesPerFrictionSample: NFR02_PROOF_THRESHOLDS.storeBytesPerSampleMax,
};

function proofMetricsFrom(proof) {
  return {
    turns: proof.turns,
    days: proof.days,
    turnsPerDay: proof.turnsPerDay,
    foldP95Ms: proof.foldP95Ms,
    castPersistP95Ms: proof.castPersistP95Ms,
    turnP95Ms: proof.turnP95Ms,
    storeBytes: proof.agent.telemetryCollector.approxDurableStoreBytes(),
    durableSampleCount: proof.durableCount,
    wallMs: proof.wallMs,
  };
}

const FRICTION_PATTERNS = [
  {
    name: "fluent",
    hesitationMs: 400,
    revisions: 0,
    assistance: false,
    outcome: "correct",
    chars: 12,
  },
  {
    name: "hesitant",
    hesitationMs: 4_500,
    revisions: 2,
    assistance: false,
    outcome: "correct",
    chars: 8,
  },
  {
    name: "assisted",
    hesitationMs: 2_000,
    revisions: 1,
    assistance: true,
    outcome: "partial",
    chars: 10,
  },
  {
    name: "struggle",
    hesitationMs: 8_000,
    revisions: 4,
    assistance: true,
    outcome: "incorrect",
    chars: 6,
  },
];

const CONCEPTS = [
  "c.ratios",
  "c.fractions",
  "c.hashes",
  "c.graphs",
  "c.loops",
  "c.sets",
  "c.proofs",
  "c.bounds",
];

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.ceil((p / 100) * sortedAsc.length) - 1,
  );
  return sortedAsc[Math.max(0, idx)];
}

function masteryMean(entry, deviceId) {
  const a = entry.alpha[deviceId] ?? 0;
  const b = entry.beta[deviceId] ?? 0;
  const den = a + b;
  return den === 0 ? 0.5 : a / den;
}

/**
 * Drive N turns over simulated days with varied CAST patterns.
 * Returns latency / storage / mastery proof stats (permanently offline).
 * Day-boundary checkpoints power zero-CAST-degradation assertions.
 *
 * @param {object} opts
 * @param {number|null} [opts.restartAt] turn index to restart (`null` = never)
 */
async function runMultiDayOfflineHorizon(opts = {}) {
  const turns = opts.turns ?? HORIZON_TURNS;
  const days = opts.days ?? HORIZON_DAYS;
  const restartAt =
    opts.restartAt === null
      ? null
      : (opts.restartAt ?? Math.floor(turns / 2));
  const dstJumpAt =
    opts.dstJumpAt === null
      ? null
      : (opts.dstJumpAt ?? Math.floor(turns / 5));
  const subjectId = opts.subjectId ?? "subj-horizon-sim";
  const deviceId = opts.deviceId ?? "edge-horizon-sim";

  const clock = manualClock(START_MS);
  const storage = horizonStorageDriver();
  const foldLatencies = [];
  const castPersistLatencies = [];
  const turnLatencies = [];
  const turnOutcomes = [];
  /** @type {Array<{ day: number, durableCount: number, unsyncedCount: number, earliestCapturedAt: string|null, latestCapturedAt: string|null, mastery: object, masteryByConcept: Record<string,{alpha:number,beta:number}> }>} */
  const dayCheckpoints = [];
  let expectedAlpha = 0;
  let expectedBeta = 0;

  const tickMs = (days * DAY_MS) / turns;
  /** Inclusive turn counts at each day boundary (spreads remainder evenly). */
  const dayBoundaryTurns = Array.from({ length: days }, (_, d) =>
    Math.round(((d + 1) * turns) / days),
  );
  const turnsPerDay = dayBoundaryTurns[0];

  function makeSimAgent() {
    return makeAgent({
      subjectId,
      deviceId,
      storage,
      nowMs: clock.nowMs,
      ...(opts.maxResidentVectors !== undefined
        ? { maxResidentVectors: opts.maxResidentVectors }
        : {}),
    });
  }

  async function captureDayCheckpoint(day) {
    const probe = await agent.telemetryCollector.castIntegrityProbe();
    const summary = agent.masteryShardSummary();
    const masteryByConcept = {};
    for (const [cid, entry] of Object.entries(agent.cognitiveState.mastery)) {
      masteryByConcept[cid] = {
        alpha: entry.alpha[deviceId] ?? 0,
        beta: entry.beta[deviceId] ?? 0,
      };
    }
    return {
      day,
      durableCount: probe.durableCount,
      unsyncedCount: probe.unsyncedCount,
      earliestCapturedAt: probe.earliestCapturedAt,
      latestCapturedAt: probe.latestCapturedAt,
      mastery: summary,
      masteryByConcept,
    };
  }

  let agent = makeSimAgent();
  await agent.initialize();
  assert.equal((await agent.syncNow()).status, "offline-mode");

  const wallStart = performance.now();

  for (let i = 0; i < turns; i++) {
    if (dstJumpAt !== null && i === dstJumpAt) {
      // DST-style regression — HLC must stay monotonic; harness continues.
      clock.setMs(clock.getMs() - 2 * 3_600_000);
    }
    if (restartAt !== null && i === restartAt) {
      // In-memory CognitiveState is session-local; CAST rows survive on storage.
      // Reset expected mastery shards to match genesis after process restart.
      agent.dispose();
      agent = makeSimAgent();
      await agent.initialize();
      expectedAlpha = 0;
      expectedBeta = 0;
    }

    const pattern = FRICTION_PATTERNS[i % FRICTION_PATTERNS.length];
    const conceptId = CONCEPTS[i % CONCEPTS.length];
    const t0 = clock.getMs();
    const col = agent.telemetryCollector;

    col.observe({ type: "prompt-rendered", conceptId, atMs: t0 });
    const firstInput = t0 + pattern.hesitationMs;
    col.observe({
      type: "input",
      charsDelta: pattern.chars,
      atMs: firstInput,
    });
    for (let r = 0; r < pattern.revisions; r++) {
      col.observe({ type: "deletion", atMs: firstInput + 10 + r });
    }
    if (pattern.assistance) {
      col.observe({
        type: "assistance-requested",
        atMs: firstInput + 20,
      });
    }
    col.observe({
      type: "input",
      charsDelta: 2,
      atMs: firstInput + 40,
    });

    const persistStart = performance.now();
    const sample = await col.submitted(pattern.outcome, firstInput + 50);
    castPersistLatencies.push(performance.now() - persistStart);
    assert.ok(sample, `CAST write-ahead must succeed at turn ${i}`);

    const turnStart = performance.now();
    const reply = await agent.agentTurn(`horizon turn ${i}`, sample);
    turnLatencies.push(performance.now() - turnStart);
    foldLatencies.push(agent.lastFrictionFoldLatencyMs());
    turnOutcomes.push({
      subjectId,
      deviceId,
      conceptId: reply.conceptId,
      outcome: pattern.outcome,
      servedLocally: reply.servedLocally,
    });

    // Expected Bayesian increments (mirrors foldFriction fluency rules).
    const fluency =
      pattern.hesitationMs < 3000 && pattern.revisions <= 1 ? 1.0 : 0.5;
    if (pattern.outcome === "correct") {
      expectedAlpha += fluency;
    } else if (pattern.outcome === "incorrect") {
      expectedBeta += 1;
    } else if (pattern.outcome === "partial") {
      expectedAlpha += 0.5 * fluency;
      expectedBeta += 0.5;
    }

    clock.advanceMs(tickMs);

    const boundaryIdx = dayBoundaryTurns.indexOf(i + 1);
    if (boundaryIdx >= 0) {
      dayCheckpoints.push(await captureDayCheckpoint(boundaryIdx + 1));
    }
  }

  assert.equal(
    dayCheckpoints.length,
    days,
    `expected ${days} day checkpoints, got ${dayCheckpoints.length}`,
  );

  const wallMs = performance.now() - wallStart;
  const mastery = agent.cognitiveState.mastery;
  let totalAlpha = 0;
  let totalBeta = 0;
  for (const entry of Object.values(mastery)) {
    totalAlpha += entry.alpha[deviceId] ?? 0;
    totalBeta += entry.beta[deviceId] ?? 0;
  }

  foldLatencies.sort((a, b) => a - b);
  castPersistLatencies.sort((a, b) => a - b);
  turnLatencies.sort((a, b) => a - b);

  const finalProbe = await agent.telemetryCollector.castIntegrityProbe();

  return {
    agent,
    storage,
    clock,
    subjectId,
    deviceId,
    turns,
    days,
    turnsPerDay,
    wallMs,
    foldP95Ms: percentile(foldLatencies, 95),
    castPersistP95Ms: percentile(castPersistLatencies, 95),
    turnP95Ms: percentile(turnLatencies, 95),
    durableCount: finalProbe.durableCount,
    castProbe: finalProbe,
    dayCheckpoints,
    frictionApproxBytes: storage.frictionApproxBytes(),
    memoryRows: storage.rowCount(),
    unboundedFrictionFullScans: storage.unboundedFrictionFullScans(),
    mastery,
    masterySummary: agent.masteryShardSummary(),
    totalAlpha,
    totalBeta,
    expectedAlpha,
    expectedBeta,
    turnOutcomes,
    simulatedEndMs: clock.getMs(),
  };
}

/** Zero CAST capture degradation: day 1 vs day 30 sample counts + mastery shards. */
function assertZeroCastDegradation(proof, opts = {}) {
  const requireGrowOnly = opts.requireGrowOnly === true;
  const day1 = proof.dayCheckpoints.find((c) => c.day === 1);
  const day30 = proof.dayCheckpoints.find((c) => c.day === proof.days);
  assert.ok(day1, "day-1 checkpoint required");
  assert.ok(day30, "final-day checkpoint required");

  // No dropped samples — cumulative durable count is non-decreasing.
  let prev = 0;
  for (const cp of proof.dayCheckpoints) {
    assert.ok(
      cp.durableCount >= prev,
      `CAST count dropped between days (prev=${prev}, day ${cp.day}=${cp.durableCount})`,
    );
    prev = cp.durableCount;
  }
  assert.equal(day1.durableCount, proof.turnsPerDay);
  assert.equal(day30.durableCount, proof.turns);
  assert.ok(day30.durableCount > day1.durableCount);

  // Capture density does not degrade late in the horizon.
  const rateDay1 = day1.durableCount / 1;
  const rateOverall = proof.turns / proof.days;
  assert.ok(
    Math.abs(rateDay1 - rateOverall) / rateOverall < 0.05,
    `capture rate drift day1=${rateDay1} overall=${rateOverall}`,
  );

  // Bounded integrity probes only — never full-table SELECT * during the proof.
  assert.equal(
    proof.unboundedFrictionFullScans,
    0,
    "CAST integrity must not full-scan friction_samples",
  );
  assert.ok(proof.castProbe.earliestCapturedAt);
  assert.ok(proof.castProbe.latestCapturedAt);
  assert.ok(
    proof.castProbe.earliestCapturedAt < proof.castProbe.latestCapturedAt,
    "HLC capture order must advance across the horizon",
  );
  assert.equal(proof.castProbe.unsyncedCount, proof.turns);

  // Posterior integrity — no corruption signals.
  assert.equal(proof.masterySummary.corrupt, false);
  assert.equal(proof.masterySummary.meansInRange, true);
  assert.equal(day1.mastery.corrupt, false);
  assert.equal(day30.mastery.corrupt, false);
  assert.equal(day30.mastery.subjectId, proof.subjectId);
  assert.equal(day30.mastery.deviceId, proof.deviceId);

  if (requireGrowOnly) {
    // Continuous session: G-Counter shards are pointwise non-decreasing day1→day30.
    for (const [cid, d1] of Object.entries(day1.masteryByConcept)) {
      const d30 = day30.masteryByConcept[cid];
      assert.ok(d30, `concept ${cid} missing at day ${proof.days}`);
      assert.ok(d30.alpha >= d1.alpha - 1e-9, `${cid} alpha shrank`);
      assert.ok(d30.beta >= d1.beta - 1e-9, `${cid} beta shrank`);
    }
    assert.ok(day30.mastery.totalAlpha >= day1.mastery.totalAlpha - 1e-9);
    assert.ok(day30.mastery.totalBeta >= day1.mastery.totalBeta - 1e-9);
  }

  // Observability: structured outcome records, no raw content fields.
  assert.ok(
    proof.turnOutcomes.every(
      (o) =>
        o.subjectId === proof.subjectId &&
        o.deviceId === proof.deviceId &&
        !("utterance" in o) &&
        !("text" in o),
    ),
  );
}

test("happy path: multi-day harness runs N≥5000 turns / 30 days within budgets", async () => {
  const proof = await runMultiDayOfflineHorizon();

  assert.equal(proof.turns, HORIZON_TURNS);
  assert.ok(
    proof.simulatedEndMs >= START_MS + HORIZON_DAYS * DAY_MS - DAY_MS,
    "simulated clock must cover ~30 days",
  );
  assert.ok(
    proof.wallMs < BUDGET.wallMaxMs,
    `wall-clock ${proof.wallMs.toFixed(0)}ms exceeds ${BUDGET.wallMaxMs}ms`,
  );

  // NFR-02: zero CAST capture degradation across day-1 vs day-30 checkpoints.
  assertZeroCastDegradation(proof);

  // NFR-02: emit proof metrics through EventBus / OTel seam (thresholds committed).
  const recorded = proof.agent.recordNfr02ProofMetrics(proofMetricsFrom(proof));
  assert.equal(recorded.nfrId, NFR02_PROOF_THRESHOLDS.nfrId);
  assert.equal(recorded.outcome, "ok");
  assert.deepEqual(recorded.breachCodes, []);
  assert.equal(recorded.locality, "on-device");

  assert.equal(proof.durableCount, HORIZON_TURNS);
  assert.ok(
    proof.frictionApproxBytes / HORIZON_TURNS <=
      BUDGET.maxBytesPerFrictionSample,
    `SQLite growth ${proof.frictionApproxBytes}B / ${HORIZON_TURNS} exceeds per-sample budget`,
  );
  assert.ok(
    proof.frictionApproxBytes <
      HORIZON_TURNS * BUDGET.maxBytesPerFrictionSample,
    "friction table growth must stay linearly bounded",
  );

  assert.ok(
    proof.foldP95Ms <= BUDGET.foldP95Ms,
    `fold p95 ${proof.foldP95Ms.toFixed(3)}ms > ${BUDGET.foldP95Ms}ms`,
  );
  assert.ok(
    proof.castPersistP95Ms <= BUDGET.castPersistP95Ms,
    `CAST persist p95 ${proof.castPersistP95Ms.toFixed(3)}ms > ${BUDGET.castPersistP95Ms}ms`,
  );
  assert.ok(
    proof.turnP95Ms <= BUDGET.turnP95Ms,
    `turn p95 ${proof.turnP95Ms.toFixed(3)}ms > ${BUDGET.turnP95Ms}ms`,
  );

  // Mastery posterior updates track folded evidence (G-Counter shards).
  assert.ok(
    Math.abs(proof.totalAlpha - proof.expectedAlpha) < 1e-9,
    `alpha ${proof.totalAlpha} != expected ${proof.expectedAlpha}`,
  );
  assert.ok(
    Math.abs(proof.totalBeta - proof.expectedBeta) < 1e-9,
    `beta ${proof.totalBeta} != expected ${proof.expectedBeta}`,
  );
  assert.ok(Object.keys(proof.mastery).length === CONCEPTS.length);
  for (const conceptId of CONCEPTS) {
    const entry = proof.mastery[conceptId];
    assert.ok(entry, `mastery missing for ${conceptId}`);
    const mean = masteryMean(entry, proof.deviceId);
    assert.ok(mean >= 0 && mean <= 1, `posterior mean out of range: ${mean}`);
    assert.ok(entry.lastExercisedAt.length > 0);
  }

  // Observability: outcomes are structured (subject/device/concept) — no raw utterance.
  assert.equal(proof.turnOutcomes.length, HORIZON_TURNS);
  assert.ok(proof.turnOutcomes.every((o) => o.servedLocally === true));
  assert.ok(proof.turnOutcomes.every((o) => o.subjectId === proof.subjectId));
  assert.ok(
    proof.turnOutcomes.every((o) => !("utterance" in o) && !("text" in o)),
  );

  // Memory wrote episodics each turn (bounded by StorageDriver seam).
  assert.ok(proof.memoryRows >= 1);
  assert.ok(proof.memoryRows <= HORIZON_TURNS + 8);
});

test("edge: mid-horizon restart + DST jump keep CAST durable and mastery consistent", async () => {
  // Smaller N still covers restart/DST paths used by the full harness.
  const proof = await runMultiDayOfflineHorizon({
    turns: 200,
    days: 4,
    restartAt: 80,
    dstJumpAt: 40,
  });
  assert.equal(proof.durableCount, 200);
  assert.ok(
    Math.abs(proof.totalAlpha - proof.expectedAlpha) < 1e-9,
  );
  assert.ok(Math.abs(proof.totalBeta - proof.expectedBeta) < 1e-9);
});

test("edge: maxResidentVectors pin keeps corrections visible under episodic flood", async () => {
  const clock = manualClock(START_MS);
  const storage = horizonStorageDriver();
  const agent = makeAgent({
    subjectId: "subj-cap",
    deviceId: "edge-cap-pin",
    storage,
    nowMs: clock.nowMs,
    maxResidentVectors: 4,
  });
  await agent.initialize();

  const pinVec = new Float32Array(8);
  pinVec[0] = 0.91;
  await agent.vectorDb.upsert({
    id: "corr-pin-horizon",
    subjectId: "subj-cap",
    conceptId: "c.pin",
    text: "pinned correction never evicted",
    vector: pinVec,
    kind: "correction",
    createdAt: agent.hlcClock.tick(),
  });

  for (let i = 0; i < 12; i++) {
    const t = clock.getMs();
    const col = agent.telemetryCollector;
    col.observe({
      type: "prompt-rendered",
      conceptId: "c.flood",
      atMs: t,
    });
    col.observe({ type: "input", charsDelta: 3, atMs: t + 20 });
    const sample = await col.submitted("correct", t + 40);
    await agent.agentTurn(`flood ${i}`, sample);
    clock.advanceMs(DAY_MS / 12);
  }

  const hits = await agent.vectorDb.search("subj-cap", pinVec, { limit: 8 });
  assert.ok(
    hits.some((h) => h.record.kind === "correction"),
    "correction must stay in working set under maxResidentVectors",
  );
  assert.ok(hits.every((h) => h.record.subjectId === "subj-cap"));
});

test("edge: CAST durable then turn throw leaves mastery unchanged (partial failure)", async () => {
  const clock = manualClock(START_MS);
  const base = mockRuntime();
  const runtime = {
    ...base,
    generate: async () => {
      const err = new Error("deadline exceeded");
      err.failureClass = "downstream_timeout";
      throw err;
    },
  };

  const agent = makeAgent({
    subjectId: "subj-partial",
    deviceId: "edge-partial",
    runtime,
    nowMs: clock.nowMs,
  });
  await agent.initialize();

  const t = clock.getMs();
  agent.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.partial",
    atMs: t,
  });
  agent.telemetryCollector.observe({
    type: "input",
    charsDelta: 4,
    atMs: t + 10,
  });
  const sample = await agent.telemetryCollector.submitted("correct", t + 20);
  assert.ok(sample);
  assert.equal(await agent.telemetryCollector.durableSampleCount(), 1);

  await assert.rejects(
    () => agent.agentTurn("will fail", sample),
    /deadline exceeded/,
  );
  assert.equal(
    Object.keys(agent.cognitiveState.mastery).length,
    0,
    "fold must not run after core.turn throw",
  );
  assert.equal(
    await agent.telemetryCollector.durableSampleCount(),
    1,
    "CAST write-ahead must survive mid-turn failure",
  );
});

test("sovereignty: concurrent same-subject turns serialize; cross-subject mastery isolated", async () => {
  const clock = manualClock(START_MS);
  const agent = makeAgent({
    subjectId: "subj-rmw",
    deviceId: "edge-rmw",
    nowMs: clock.nowMs,
  });
  await agent.initialize();

  async function durableSample(conceptId, outcome) {
    const t = clock.getMs();
    agent.telemetryCollector.observe({
      type: "prompt-rendered",
      conceptId,
      atMs: t,
    });
    agent.telemetryCollector.observe({
      type: "input",
      charsDelta: 3,
      atMs: t + 5,
    });
    const sample = await agent.telemetryCollector.submitted(outcome, t + 10);
    clock.advanceMs(1);
    return sample;
  }

  const s1 = await durableSample("c.one", "correct");
  const s2 = await durableSample("c.two", "incorrect");
  await Promise.all([
    agent.agentTurn("t1", s1),
    agent.agentTurn("t2", s2),
  ]);

  const mastery = agent.cognitiveState.mastery;
  assert.ok(mastery["c.one"]);
  assert.ok(mastery["c.two"]);
  assert.ok((mastery["c.one"].alpha["edge-rmw"] ?? 0) > 0);
  assert.ok((mastery["c.two"].beta["edge-rmw"] ?? 0) > 0);

  const other = makeAgent({
    subjectId: "subj-other",
    deviceId: "edge-other",
    nowMs: clock.nowMs,
  });
  await other.initialize();
  assert.equal(Object.keys(other.cognitiveState.mastery).length, 0);
  assert.equal(agent.cognitiveState.subjectId, "subj-rmw");
  assert.equal(other.cognitiveState.subjectId, "subj-other");
  assert.notEqual(
    agent.cognitiveState.subjectId,
    other.cognitiveState.subjectId,
  );
});

/* ── Zero CAST capture degradation (day 1 vs day 30) ─────────────────── */

test("happy path: zero CAST degradation — grow-only mastery day1→day30 (no restart)", async () => {
  const proof = await runMultiDayOfflineHorizon({
    turns: 600,
    days: 30,
    restartAt: null,
    dstJumpAt: null,
    subjectId: "subj-cast-degrade",
    deviceId: "edge-cast-degrade",
  });
  assertZeroCastDegradation(proof, { requireGrowOnly: true });
  assert.equal(proof.durableCount, 600);
  assert.ok(
    Math.abs(proof.totalAlpha - proof.expectedAlpha) < 1e-9,
  );
  assert.ok(Math.abs(proof.totalBeta - proof.expectedBeta) < 1e-9);
});

test("edge: restart + DST never drop CAST counts across day checkpoints", async () => {
  const proof = await runMultiDayOfflineHorizon({
    turns: 300,
    days: 10,
    restartAt: 120,
    dstJumpAt: 60,
    subjectId: "subj-cast-restart",
    deviceId: "edge-cast-restart",
  });
  assertZeroCastDegradation(proof);
  const day1 = proof.dayCheckpoints[0];
  const final = proof.dayCheckpoints[proof.dayCheckpoints.length - 1];
  assert.ok(final.durableCount > day1.durableCount);
  assert.equal(proof.castProbe.durableCount, 300);
});

test("edge: duplicate CAST persist is idempotent (INSERT OR IGNORE)", async () => {
  const clock = manualClock(START_MS);
  const storage = horizonStorageDriver();
  const agent = makeAgent({
    subjectId: "subj-idem",
    deviceId: "edge-idem",
    storage,
    nowMs: clock.nowMs,
  });
  await agent.initialize();
  const t = clock.getMs();
  agent.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.idem",
    atMs: t,
  });
  agent.telemetryCollector.observe({
    type: "input",
    charsDelta: 2,
    atMs: t + 5,
  });
  const sample = await agent.telemetryCollector.submitted("correct", t + 10);
  assert.ok(sample);
  assert.equal(await agent.telemetryCollector.durableSampleCount(), 1);

  // Re-insert same primary key — must not double-count durable rows.
  await storage.execute(
    `INSERT OR IGNORE INTO friction_samples
      (captured_at, concept_id, hesitation_ms, input_velocity, revision_count, assistance_requested, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sample.capturedAt,
      sample.conceptId,
      sample.hesitationMs,
      sample.inputVelocity,
      sample.revisionCount,
      sample.assistanceRequested ? 1 : 0,
      sample.outcome,
    ],
  );
  const probe = await agent.telemetryCollector.castIntegrityProbe();
  assert.equal(probe.durableCount, 1);
  assert.equal(storage.frictionCount(), 1);
  assert.equal(storage.unboundedFrictionFullScans(), 0);
});

test("sovereignty: CAST integrity probes stay subject-scoped across devices", async () => {
  const clock = manualClock(START_MS);
  const storageA = horizonStorageDriver();
  const storageB = horizonStorageDriver();
  const a = makeAgent({
    subjectId: "subj-probe-a",
    deviceId: "edge-probe-a",
    storage: storageA,
    nowMs: clock.nowMs,
  });
  const b = makeAgent({
    subjectId: "subj-probe-b",
    deviceId: "edge-probe-b",
    storage: storageB,
    nowMs: clock.nowMs,
  });
  await a.initialize();
  await b.initialize();

  for (const [agent, concept] of [
    [a, "c.a"],
    [b, "c.b"],
  ]) {
    const t = clock.getMs();
    agent.telemetryCollector.observe({
      type: "prompt-rendered",
      conceptId: concept,
      atMs: t,
    });
    agent.telemetryCollector.observe({
      type: "input",
      charsDelta: 2,
      atMs: t + 3,
    });
    await agent.telemetryCollector.submitted("correct", t + 6);
    clock.advanceMs(10);
  }

  const probeA = await a.telemetryCollector.castIntegrityProbe();
  const probeB = await b.telemetryCollector.castIntegrityProbe();
  assert.equal(probeA.durableCount, 1);
  assert.equal(probeB.durableCount, 1);
  assert.notEqual(probeA.earliestCapturedAt, probeB.earliestCapturedAt);
  assert.match(probeA.earliestCapturedAt, /:edge-probe-a$/);
  assert.match(probeB.earliestCapturedAt, /:edge-probe-b$/);

  const sumA = a.masteryShardSummary();
  const sumB = b.masteryShardSummary();
  assert.equal(sumA.subjectId, "subj-probe-a");
  assert.equal(sumB.subjectId, "subj-probe-b");
  assert.equal(sumA.conceptCount, 0);
  assert.equal(sumB.conceptCount, 0);
  assert.equal(storageA.unboundedFrictionFullScans(), 0);
  assert.equal(storageB.unboundedFrictionFullScans(), 0);
});

/* ── NFR-02 proof metrics via P3 observability spine ─────────────────── */

test("happy path: NFR-02 proof metrics emit bus event + OTel span (metadata only)", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "edge-nfr02-proof",
  });

  const proof = await runMultiDayOfflineHorizon({
    turns: 60,
    days: 6,
    restartAt: null,
    dstJumpAt: null,
    subjectId: "subj-nfr02-metrics",
    deviceId: "edge-nfr02-metrics",
  });
  const seen = [];
  proof.agent.bus.subscribe(EDGE_NFR02_PROOF, (e) => seen.push(e));
  const recorded = proof.agent.recordNfr02ProofMetrics(proofMetricsFrom(proof));
  assert.equal(recorded.outcome, "ok");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, EDGE_NFR02_PROOF);
  assert.equal(seen[0].payload.subjectId, "subj-nfr02-metrics");
  assert.equal(seen[0].payload.deviceId, "edge-nfr02-metrics");
  assert.equal(seen[0].payload.nfrId, "NFR-02");
  assert.equal(seen[0].payload.turnsPerDay, proof.turnsPerDay);
  assert.ok(typeof seen[0].payload.foldP95Ms === "number");
  assert.ok(typeof seen[0].payload.storeBytes === "number");
  assert.equal("utterance" in seen[0].payload, false);
  assert.equal("text" in seen[0].payload, false);

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  await shutdownObservability();

  const proofSpan = spans.find((s) => s.name === "sutra.nfr02.proof");
  assert.ok(proofSpan, "sutra.nfr02.proof span must be emitted");
  assert.equal(proofSpan.attributes["sutra.subject_id"], "subj-nfr02-metrics");
  assert.equal(proofSpan.attributes["sutra.nfr_id"], "NFR-02");
  assert.equal(proofSpan.attributes["sutra.outcome"], "ok");
  assertSpanExportPrivacy(spans, {
    forbiddenSubstrings: ["SECRET_UTTER", "learner said"],
  });
});

test("happy path: one turn emits full OTel stage tree; privacy holds on NFR-02 attrs", async () => {
  const SECRET = "SECRET_UTTERANCE_MUST_NOT_APPEAR_IN_SPANS_QX7";
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "edge-nfr02-turn-tree",
  });

  const clock = manualClock(START_MS);
  const agent = makeAgent({
    subjectId: "subj-span-tree",
    deviceId: "edge-span-tree",
    nowMs: clock.nowMs,
  });
  await agent.initialize();
  const t = clock.getMs();
  agent.telemetryCollector.observe({
    type: "prompt-rendered",
    conceptId: "c.span",
    atMs: t,
  });
  agent.telemetryCollector.observe({
    type: "input",
    charsDelta: 4,
    atMs: t + 10,
  });
  const sample = await agent.telemetryCollector.submitted("correct", t + 20);
  await agent.agentTurn(SECRET, sample);

  agent.recordNfr02ProofMetrics({
    turns: 1,
    days: 1,
    turnsPerDay: 1,
    foldP95Ms: agent.lastFrictionFoldLatencyMs(),
    castPersistP95Ms: agent.telemetryCollector.lastPersistLatencyMs(),
    turnP95Ms: 1,
    storeBytes: agent.telemetryCollector.approxDurableStoreBytes(),
    durableSampleCount: 1,
    wallMs: 10,
  });

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(spans.some((s) => s.name === "sutra.turn"));
  for (const stage of TURN_STAGE_NAMES) {
    assert.ok(
      spans.some((s) => s.name === `sutra.turn.${stage}`),
      `missing stage span sutra.turn.${stage}`,
    );
  }
  assert.ok(spans.some((s) => s.name === "sutra.nfr02.proof"));
  assertSpanExportPrivacy(spans, {
    forbiddenSubstrings: [SECRET],
  });
});

test("edge: budget breach emits distinct breachCodes and budget_breached outcome", async () => {
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_NFR02_PROOF, (e) => seen.push(e));
  const agent = makeAgent({
    subjectId: "subj-breach",
    deviceId: "edge-breach",
    eventBus: bus,
  });
  await agent.initialize();
  const recorded = agent.recordNfr02ProofMetrics({
    turns: 10,
    days: 2,
    turnsPerDay: 5,
    foldP95Ms: NFR02_PROOF_THRESHOLDS.foldP95MsMax + 10,
    castPersistP95Ms: 0.1,
    turnP95Ms: NFR02_PROOF_THRESHOLDS.turnP95MsMax + 5,
    storeBytes: 100,
    durableSampleCount: 10,
    wallMs: 50,
  });
  assert.equal(recorded.outcome, "budget_breached");
  assert.ok(recorded.breachCodes.includes("fold_p95"));
  assert.ok(recorded.breachCodes.includes("turn_p95"));
  assert.equal(seen[0].payload.outcome, "budget_breached");
});

test("edge: missing observability exporter never blocks proof bus emission", async () => {
  await shutdownObservability();
  const bus = new InProcessEventBus();
  const seen = [];
  bus.subscribe(EDGE_NFR02_PROOF, (e) => seen.push(e));
  const agent = makeAgent({
    subjectId: "subj-no-otel",
    deviceId: "edge-no-otel",
    eventBus: bus,
  });
  await agent.initialize();
  const recorded = agent.recordNfr02ProofMetrics({
    turns: 2,
    days: 1,
    turnsPerDay: 2,
    foldP95Ms: 0.1,
    castPersistP95Ms: 0.1,
    turnP95Ms: 1,
    storeBytes: 80,
    durableSampleCount: 2,
    wallMs: 5,
  });
  assert.equal(recorded.outcome, "ok");
  assert.equal(seen.length, 1);
});

test("edge: invalid proof metrics raise validation_failed", async () => {
  const agent = makeAgent({
    subjectId: "subj-invalid",
    deviceId: "edge-invalid",
  });
  await agent.initialize();
  await assert.rejects(
    async () =>
      agent.recordNfr02ProofMetrics({
        turns: -1,
        days: 1,
        turnsPerDay: 1,
        foldP95Ms: 0,
        castPersistP95Ms: 0,
        turnP95Ms: 0,
        storeBytes: 0,
        durableSampleCount: 0,
        wallMs: 0,
      }),
    /validation failed/,
  );
});

test("sovereignty: NFR-02 thresholds are committed and subject-scoped on records", async () => {
  assert.equal(NFR02_PROOF_THRESHOLDS.nfrId, "NFR-02");
  assert.ok(NFR02_PROOF_THRESHOLDS.foldP95MsMax > 0);
  assert.ok(NFR02_PROOF_THRESHOLDS.storeBytesPerSampleMax > 0);

  const a = makeAgent({ subjectId: "subj-th-a", deviceId: "edge-th-a" });
  const b = makeAgent({ subjectId: "subj-th-b", deviceId: "edge-th-b" });
  await a.initialize();
  await b.initialize();
  const ra = a.recordNfr02ProofMetrics({
    turns: 1,
    days: 1,
    turnsPerDay: 1,
    foldP95Ms: 0,
    castPersistP95Ms: 0,
    turnP95Ms: 0,
    storeBytes: 40,
    durableSampleCount: 1,
    wallMs: 1,
  });
  const rb = b.recordNfr02ProofMetrics({
    turns: 1,
    days: 1,
    turnsPerDay: 1,
    foldP95Ms: 0,
    castPersistP95Ms: 0,
    turnP95Ms: 0,
    storeBytes: 40,
    durableSampleCount: 1,
    wallMs: 1,
  });
  assert.equal(ra.subjectId, "subj-th-a");
  assert.equal(rb.subjectId, "subj-th-b");
  assert.notEqual(ra.subjectId, rb.subjectId);
});
