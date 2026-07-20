/**
 * Load proof: concurrent captureTrajectory stays non-blocking under slow
 * storage. Turn-path admission p95 stays within NFR-06; trajectories become
 * durable after drain. Metadata-only events — never utterance bodies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TrajectoryWriteAheadQueue,
  TRAJECTORY_FORMAT_VERSION,
} from "../dist/index.js";

/** Concurrent turns under slow storage (N). */
const LOAD_TURN_COUNT = 64;

/** Artificial storage latency — if capture awaited this, p95 would breach. */
const SLOW_STORAGE_MS = 80;

/**
 * NFR-06: core composition overhead ≤ 10ms p95 (PRD_MATRIX). Capture admits
 * synchronously; turn path must not wait on durable I/O.
 */
const CAPTURE_ADMISSION_P95_MS = 10;

function validRecord(turnId, overrides = {}) {
  return {
    trajectoryFormatVersion: TRAJECTORY_FORMAT_VERSION,
    turnId,
    subjectId: "learner-load-a",
    deviceId: "edge-load-1",
    capturedAt: "001700000000100:000002:edge-load-1",
    locality: "on-device",
    consentRecordId: "consent-traj-load-1",
    stages: [
      { stage: "perceive", status: "ok", chunkIndex: 0 },
      { stage: "reason", status: "ok", chunkIndex: 0 },
      { stage: "act", status: "ok", chunkIndex: 0 },
    ],
    toolCalls: [],
    outcomes: { status: "completed", terminalStage: "act" },
    modelId: "slm-edge-load",
    promptHash: "sha256:promptload01",
    responseHash: "sha256:responseload01",
    ...overrides,
  };
}

function activeConsent(overrides = {}) {
  return {
    consentRecordId: "consent-traj-load-1",
    subjectId: "learner-load-a",
    scope: "trajectory",
    optedIn: true,
    active: true,
    ...overrides,
  };
}

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

function slowMemoryDriver(options = {}) {
  const pending = new Map();
  const stored = new Map();
  let writes = 0;
  const delayMs = options.delayMs ?? SLOW_STORAGE_MS;
  return {
    pending,
    stored,
    get writes() {
      return writes;
    },
    async execute(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return;
      if (sql.includes("INSERT OR IGNORE INTO trajectory_write_ahead")) {
        writes++;
        await sleep(delayMs);
        const key = `${params[0]}\0${params[1]}`;
        pending.set(key, {
          subject_id: String(params[0]),
          turn_id: String(params[1]),
          payload_json: String(params[4]),
          enqueued_at: String(params[5]),
        });
        return;
      }
      if (sql.includes("INSERT OR IGNORE INTO turn_trajectories")) {
        writes++;
        await sleep(delayMs);
        const key = `${params[0]}\0${params[1]}`;
        if (!stored.has(key)) stored.set(key, JSON.parse(String(params[6])));
        return;
      }
      if (sql.includes("DELETE FROM trajectory_write_ahead")) {
        writes++;
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
      return [...pending.values()]
        .filter((row) => row.subject_id === subjectId)
        .sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at))
        .slice(0, limit)
        .map(({ payload_json }) => ({ payload_json }));
    },
  };
}

test("load: N concurrent captures return before slow storage; p95 ≤ NFR-06; eventually durable", async () => {
  const driver = slowMemoryDriver();
  const events = [];
  let consent = activeConsent();
  const writer = new TrajectoryWriteAheadQueue({
    driver,
    subjectId: "learner-load-a",
    locality: "on-device",
    resolveConsent: () => consent,
    onTelemetry: (event) => events.push(event),
    capacity: LOAD_TURN_COUNT,
    storageTimeoutMs: 5_000,
    maxRetries: 1,
  });
  await writer.initialize();

  const latencies = [];
  const results = [];
  const started = performance.now();
  for (let i = 0; i < LOAD_TURN_COUNT; i++) {
    const t0 = performance.now();
    const result = writer.captureTrajectory(validRecord(`turn-load-${i}`));
    latencies.push(performance.now() - t0);
    results.push(result);
  }
  const admissionWallMs = performance.now() - started;

  assert.ok(
    admissionWallMs < SLOW_STORAGE_MS,
    `admission wall ${admissionWallMs.toFixed(2)}ms must stay below one slow write (${SLOW_STORAGE_MS}ms)`,
  );
  assert.equal(driver.stored.size, 0, "no durable row before drain completes");
  assert.ok(
    results.every((r) => r.queued === true && r.duplicate !== true),
    "every concurrent turn must enqueue",
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  assert.ok(
    p95 <= CAPTURE_ADMISSION_P95_MS,
    `capture admission p95 ${p95.toFixed(3)}ms exceeds NFR-06 budget ${CAPTURE_ADMISSION_P95_MS}ms`,
  );

  assert.equal(
    await writer.flush(SLOW_STORAGE_MS * LOAD_TURN_COUNT * 2 + 5_000),
    true,
  );
  assert.equal(driver.stored.size, LOAD_TURN_COUNT);
  assert.equal(driver.pending.size, 0);

  const subjects = new Set(
    [...driver.stored.values()].map((row) => row.subjectId),
  );
  assert.deepEqual([...subjects], ["learner-load-a"]);
  assert.ok(events.some((e) => e.outcome === "queued"));
  assert.ok(events.some((e) => e.outcome === "persisted"));
  assert.doesNotMatch(
    JSON.stringify(events),
    /utterance|keystroke|SECRET_|promptHash/i,
  );
});

test("load edge: queue full drops without blocking; telemetry names queue_full", async () => {
  const driver = slowMemoryDriver({ delayMs: 200 });
  const events = [];
  const capacity = 4;
  const writer = new TrajectoryWriteAheadQueue({
    driver,
    subjectId: "learner-load-a",
    locality: "on-device",
    resolveConsent: () => activeConsent(),
    onTelemetry: (event) => events.push(event),
    capacity,
    storageTimeoutMs: 5_000,
    maxRetries: 0,
  });
  await writer.initialize();

  const latencies = [];
  let queued = 0;
  let dropped = 0;
  for (let i = 0; i < capacity + 8; i++) {
    const t0 = performance.now();
    const result = writer.captureTrajectory(validRecord(`turn-bp-${i}`));
    latencies.push(performance.now() - t0);
    if (result.queued) queued++;
    else {
      dropped++;
      assert.equal(result.failureClass, "queue_full");
    }
  }

  assert.equal(queued, capacity);
  assert.equal(dropped, 8);
  assert.equal(writer.droppedCount, 8);
  const p95 = percentile([...latencies].sort((a, b) => a - b), 95);
  assert.ok(
    p95 <= CAPTURE_ADMISSION_P95_MS,
    `backpressure admission p95 ${p95.toFixed(3)}ms must stay within NFR-06`,
  );
  assert.ok(
    events.some(
      (e) => e.outcome === "dropped" && e.failureClass === "queue_full",
    ),
  );

  // Allow worker to finish whatever was admitted; do not block the assertion path.
  await writer.flush(5_000);
});

test("sovereignty under load: subject A and B writers never cross-store", async () => {
  const driverA = slowMemoryDriver({ delayMs: 20 });
  const driverB = slowMemoryDriver({ delayMs: 20 });
  const writerA = new TrajectoryWriteAheadQueue({
    driver: driverA,
    subjectId: "learner-load-a",
    locality: "on-device",
    resolveConsent: () => activeConsent(),
    capacity: 32,
  });
  const writerB = new TrajectoryWriteAheadQueue({
    driver: driverB,
    subjectId: "learner-load-b",
    locality: "on-device",
    resolveConsent: () =>
      activeConsent({
        consentRecordId: "consent-traj-load-b",
        subjectId: "learner-load-b",
      }),
    capacity: 32,
  });
  await writerA.initialize();
  await writerB.initialize();

  for (let i = 0; i < 16; i++) {
    assert.equal(
      writerA.captureTrajectory(validRecord(`a-${i}`)).queued,
      true,
    );
    assert.equal(
      writerB.captureTrajectory(
        validRecord(`b-${i}`, {
          subjectId: "learner-load-b",
          deviceId: "edge-load-b",
          consentRecordId: "consent-traj-load-b",
        }),
      ).queued,
      true,
    );
  }

  const cross = writerA.captureTrajectory(
    validRecord("cross", { subjectId: "learner-load-b" }),
  );
  assert.equal(cross.queued, false);
  assert.equal(cross.failureClass, "cross_subject");

  assert.equal(await writerA.flush(10_000), true);
  assert.equal(await writerB.flush(10_000), true);
  assert.equal(driverA.stored.size, 16);
  assert.equal(driverB.stored.size, 16);
  for (const row of driverA.stored.values()) {
    assert.equal(row.subjectId, "learner-load-a");
  }
  for (const row of driverB.stored.values()) {
    assert.equal(row.subjectId, "learner-load-b");
  }
});

test("load edge: consent revoked mid-drain discards pending; replay stays idempotent", async () => {
  let consent = activeConsent();
  const driver = slowMemoryDriver({ delayMs: 30 });
  const events = [];
  const writer = new TrajectoryWriteAheadQueue({
    driver,
    subjectId: "learner-load-a",
    locality: "on-device",
    resolveConsent: () => consent,
    onTelemetry: (event) => events.push(event),
    capacity: 16,
    storageTimeoutMs: 5_000,
    maxRetries: 0,
  });
  await writer.initialize();

  assert.equal(writer.captureTrajectory(validRecord("turn-revoke")).queued, true);
  consent = activeConsent({ active: false, optedIn: false });
  assert.equal(await writer.flush(5_000), true);
  assert.equal(driver.stored.size, 0);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "rejected" &&
        (e.failureClass === "consent_denied" ||
          e.failureClass === "consent_missing"),
    ),
  );

  consent = activeConsent();
  const writer2 = new TrajectoryWriteAheadQueue({
    driver,
    subjectId: "learner-load-a",
    locality: "on-device",
    resolveConsent: () => consent,
    capacity: 8,
  });
  await writer2.initialize();
  assert.equal(writer2.captureTrajectory(validRecord("turn-idem")).queued, true);
  assert.equal(await writer2.flush(5_000), true);
  assert.equal(writer2.captureTrajectory(validRecord("turn-idem")).queued, true);
  assert.equal(await writer2.flush(5_000), true);
  assert.equal(driver.stored.size, 1);
});
