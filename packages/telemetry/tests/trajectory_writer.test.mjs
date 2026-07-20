/**
 * Bounded trajectory write-ahead queue: non-blocking admission, consent
 * recheck, backpressure, subject isolation, and idempotent persistence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TrajectoryWriteAheadQueue,
  TRAJECTORY_FORMAT_VERSION,
} from "../dist/index.js";

function validRecord(turnId = "turn-1", overrides = {}) {
  return {
    trajectoryFormatVersion: TRAJECTORY_FORMAT_VERSION,
    turnId,
    subjectId: "learner-a",
    deviceId: "edge-dev1",
    capturedAt: "001700000000100:000002:edge-dev1",
    locality: "on-device",
    consentRecordId: "consent-traj-001",
    stages: [
      { stage: "perceive", status: "ok", chunkIndex: 0 },
      { stage: "reason", status: "ok", chunkIndex: 0 },
      { stage: "act", status: "ok", chunkIndex: 0 },
    ],
    toolCalls: [],
    outcomes: { status: "completed", terminalStage: "act" },
    modelId: "slm-edge-v1",
    promptHash: "sha256:prompt01",
    responseHash: "sha256:response01",
    ...overrides,
  };
}

function activeConsent(overrides = {}) {
  return {
    consentRecordId: "consent-traj-001",
    subjectId: "learner-a",
    scope: "trajectory",
    optedIn: true,
    active: true,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function memoryDriver(options = {}) {
  const pending = new Map();
  const stored = new Map();
  let writes = 0;
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
        const key = `${params[0]}\0${params[1]}`;
        if (options.writeAheadGate) await options.writeAheadGate.promise;
        pending.set(key, {
          subject_id: String(params[0]),
          turn_id: String(params[1]),
          payload_json: String(params[4]),
          enqueued_at: String(params[5]),
        });
        options.afterWriteAhead?.();
        return;
      }
      if (sql.includes("INSERT OR IGNORE INTO turn_trajectories")) {
        writes++;
        if (options.finalGate) await options.finalGate.promise;
        if (options.finalNever) await new Promise(() => {});
        if (options.finalError) throw new Error("sqlite busy");
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

function createWriter(driver, options = {}) {
  const events = [];
  let consent = activeConsent();
  const writer = new TrajectoryWriteAheadQueue({
    driver,
    subjectId: "learner-a",
    locality: "on-device",
    resolveConsent: () => consent,
    onTelemetry: (event) => events.push(event),
    capacity: options.capacity ?? 4,
    storageTimeoutMs: options.storageTimeoutMs ?? 100,
    maxRetries: options.maxRetries ?? 0,
  });
  return {
    writer,
    events,
    setConsent(next) {
      consent = next;
    },
  };
}

test("happy path: capture returns before durable write and commits write-ahead first", async () => {
  const finalGate = deferred();
  const driver = memoryDriver({ finalGate });
  const { writer, events } = createWriter(driver);
  await writer.initialize();

  const result = writer.captureTrajectory(validRecord());
  assert.equal(result.queued, true);
  assert.equal(driver.stored.size, 0, "turn path must not await final storage");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(driver.pending.size, 1, "pending row must precede final row");
  assert.equal(driver.stored.size, 0);

  finalGate.resolve();
  assert.equal(await writer.flush(500), true);
  assert.equal(driver.pending.size, 0);
  assert.equal(driver.stored.size, 1);
  assert.ok(events.some((event) => event.outcome === "queued"));
  assert.ok(events.some((event) => event.outcome === "persisted"));
  assert.ok(
    events.every(
      (event) =>
        !("prompt" in event) &&
        !("responseHash" in event) &&
        !("keystrokes" in event),
    ),
  );
});

test("backpressure: bounded queue drops after cap without waiting on storage", async () => {
  const writeAheadGate = deferred();
  const driver = memoryDriver({ writeAheadGate });
  const { writer, events } = createWriter(driver, { capacity: 1 });
  await writer.initialize();

  const first = writer.captureTrajectory(validRecord("turn-1"));
  const second = writer.captureTrajectory(validRecord("turn-2"));
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.failureClass, "queue_full");
  assert.equal(writer.droppedCount, 1);
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "dropped" && event.failureClass === "queue_full",
    ),
  );

  writeAheadGate.resolve();
  assert.equal(await writer.flush(500), true);
});

test("consent revoked after write-ahead discards pending record before final insert", async () => {
  let setConsent;
  const driver = memoryDriver({
    afterWriteAhead: () =>
      setConsent(activeConsent({ active: false, optedIn: false })),
  });
  const harness = createWriter(driver);
  setConsent = harness.setConsent;
  await harness.writer.initialize();

  assert.equal(harness.writer.captureTrajectory(validRecord()).queued, true);
  assert.equal(await harness.writer.flush(500), true);
  assert.equal(driver.pending.size, 0);
  assert.equal(driver.stored.size, 0);
  assert.ok(
    harness.events.some(
      (event) =>
        event.outcome === "rejected" &&
        event.failureClass === "consent_denied",
    ),
  );
});

test("sovereignty: cross-subject capture is rejected before storage", async () => {
  const driver = memoryDriver();
  const { writer, events } = createWriter(driver);
  await writer.initialize();

  const result = writer.captureTrajectory(
    validRecord("turn-cross", { subjectId: "learner-b" }),
  );
  assert.equal(result.queued, false);
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(driver.writes, 0);
  assert.ok(
    events.some((event) => event.failureClass === "cross_subject"),
  );
});

test("replay: duplicate subject/turn remains one durable row", async () => {
  const driver = memoryDriver();
  const { writer } = createWriter(driver);
  await writer.initialize();

  assert.equal(writer.captureTrajectory(validRecord()).queued, true);
  assert.equal(await writer.flush(500), true);
  assert.equal(writer.captureTrajectory(validRecord()).queued, true);
  assert.equal(await writer.flush(500), true);
  assert.equal(driver.stored.size, 1);
});

test("partial failure recovery: pending row is replayed idempotently on initialize", async () => {
  const driver = memoryDriver();
  const record = validRecord("turn-recovered");
  driver.pending.set("learner-a\0turn-recovered", {
    subject_id: "learner-a",
    turn_id: "turn-recovered",
    payload_json: JSON.stringify(record),
    enqueued_at: record.capturedAt,
  });
  const { writer, events } = createWriter(driver);

  await writer.initialize();
  assert.equal(await writer.flush(500), true);
  assert.equal(driver.pending.size, 0);
  assert.equal(driver.stored.size, 1);
  assert.ok(events.some((event) => event.outcome === "recovered"));
});

test("storage timeout is retried only within bound and emitted distinctly", async () => {
  const driver = memoryDriver({ finalNever: true });
  const { writer, events } = createWriter(driver, {
    storageTimeoutMs: 10,
    maxRetries: 1,
  });
  await writer.initialize();

  assert.equal(writer.captureTrajectory(validRecord()).queued, true);
  assert.equal(await writer.flush(200), true);
  assert.equal(driver.stored.size, 0);
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "retrying" &&
        event.failureClass === "storage_timeout",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.outcome === "rejected" &&
        event.failureClass === "storage_timeout",
    ),
  );
});
