/**
 * Edge load proof: post-reflect capture stays non-blocking under slow storage.
 * Admission (schedule) p95 within NFR-06; consented records eventually durable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EdgeTrajectoryCaptureWriter } from "../dist/trajectory_capture.js";

const LOAD_TURN_COUNT = 48;
const SLOW_STORAGE_MS = 80;
/** NFR-06 composition ceiling — schedule must not await durable I/O. */
const CAPTURE_SCHEDULE_P95_MS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

function slowTrajectoryDriver(delayMs = SLOW_STORAGE_MS) {
  const pending = new Map();
  const stored = new Map();
  return {
    pending,
    stored,
    async execute(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return;
      if (sql.includes("INSERT OR IGNORE INTO trajectory_write_ahead")) {
        await sleep(delayMs);
        pending.set(`${params[0]}\0${params[1]}`, String(params[4]));
        return;
      }
      if (sql.includes("INSERT OR IGNORE INTO turn_trajectories")) {
        await sleep(delayMs);
        stored.set(`${params[0]}\0${params[1]}`, JSON.parse(String(params[6])));
        return;
      }
      if (sql.includes("DELETE FROM trajectory_write_ahead")) {
        pending.delete(`${params[0]}\0${params[1]}`);
        return;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async query(sql, params = []) {
      if (!sql.includes("SELECT payload_json FROM trajectory_write_ahead")) {
        throw new Error(`unexpected query: ${sql}`);
      }
      const subjectId = String(params[0]);
      const limit = Number(params[1]);
      return [...pending.entries()]
        .filter(([key]) => key.startsWith(`${subjectId}\0`))
        .slice(0, limit)
        .map(([, payload_json]) => ({ payload_json }));
    },
  };
}

function hookInput(i, overrides = {}) {
  return {
    turnId: `turn-edge-load-${i}`,
    subjectId: "learner-edge-load",
    deviceId: "edge-load-dev",
    sessionId: "session-edge-load",
    capturedAt: "001700000000200:000001:edge-load-dev",
    utterance: "SECRET_EDGE_LOAD_UTTERANCE",
    reply: "SECRET_EDGE_LOAD_REPLY",
    modelId: "edge-load-model",
    declined: false,
    ...overrides,
  };
}

test("edge load: N concurrent post-reflect schedules stay within NFR-06; eventually durable", async () => {
  const storage = slowTrajectoryDriver();
  const events = [];
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-edge-load",
    deviceId: "edge-load-dev",
    resolveActiveConsentRecordId: () => "consent-edge-load",
    resolveConsent: () => ({
      consentRecordId: "consent-edge-load",
      subjectId: "learner-edge-load",
      scope: "trajectory",
      optedIn: true,
      active: true,
    }),
    capacity: LOAD_TURN_COUNT,
    storageTimeoutMs: 5_000,
    onHookTelemetry: (event) => events.push(event),
  });
  await writer.initialize();

  const latencies = [];
  const wall0 = performance.now();
  for (let i = 0; i < LOAD_TURN_COUNT; i++) {
    const t0 = performance.now();
    const result = writer.captureAfterReflect(hookInput(i));
    latencies.push(performance.now() - t0);
    assert.equal(result.scheduled, true);
  }
  const wallMs = performance.now() - wall0;
  assert.ok(
    wallMs < SLOW_STORAGE_MS,
    `schedule wall ${wallMs.toFixed(2)}ms must not wait on slow storage`,
  );
  assert.equal(storage.stored.size, 0);

  const p95 = percentile([...latencies].sort((a, b) => a - b), 95);
  assert.ok(
    p95 <= CAPTURE_SCHEDULE_P95_MS,
    `edge schedule p95 ${p95.toFixed(3)}ms exceeds NFR-06 ${CAPTURE_SCHEDULE_P95_MS}ms`,
  );

  assert.equal(
    await writer.flush(SLOW_STORAGE_MS * LOAD_TURN_COUNT * 2 + 10_000),
    true,
  );
  assert.equal(storage.stored.size, LOAD_TURN_COUNT);
  for (const row of storage.stored.values()) {
    assert.equal(row.subjectId, "learner-edge-load");
    assert.equal(row.consentRecordId, "consent-edge-load");
    assert.doesNotMatch(
      JSON.stringify(row),
      /SECRET_EDGE_LOAD_UTTERANCE|SECRET_EDGE_LOAD_REPLY/,
    );
  }
  assert.ok(events.some((e) => e.outcome === "scheduled"));
  assert.doesNotMatch(
    JSON.stringify(events),
    /SECRET_EDGE_LOAD_UTTERANCE|SECRET_EDGE_LOAD_REPLY/,
  );
});

test("edge load: absent consent skips all concurrent schedules — no empty records", async () => {
  const storage = slowTrajectoryDriver(20);
  const events = [];
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-edge-load",
    deviceId: "edge-load-dev",
    resolveActiveConsentRecordId: () => null,
    resolveConsent: () => null,
    capacity: 32,
    onHookTelemetry: (event) => events.push(event),
  });
  await writer.initialize();

  for (let i = 0; i < 24; i++) {
    const result = writer.captureAfterReflect(hookInput(i));
    assert.equal(result.scheduled, false);
    assert.equal(result.failureClass, "consent_missing");
  }
  assert.equal(await writer.flush(500), true);
  assert.equal(storage.stored.size, 0);
  assert.equal(storage.pending.size, 0);
  assert.ok(
    events.every(
      (e) => e.outcome === "skipped" && e.failureClass === "consent_missing",
    ),
  );
});

test("edge load: cross-subject schedule rejected before storage", async () => {
  const storage = slowTrajectoryDriver(20);
  const writer = new EdgeTrajectoryCaptureWriter({
    storage,
    subjectId: "learner-edge-load",
    deviceId: "edge-load-dev",
    resolveActiveConsentRecordId: () => "consent-edge-load",
    resolveConsent: () => ({
      consentRecordId: "consent-edge-load",
      subjectId: "learner-edge-load",
      scope: "trajectory",
      optedIn: true,
      active: true,
    }),
    capacity: 8,
  });
  await writer.initialize();

  const result = writer.captureAfterReflect(
    hookInput(0, { subjectId: "learner-other" }),
  );
  assert.equal(result.scheduled, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(await writer.flush(500), true);
  assert.equal(storage.stored.size, 0);
});
