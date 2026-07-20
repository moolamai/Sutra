import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SliceDriftContractError,
  createSliceDriftMonitor,
  loadSliceDriftMonitor,
  type SliceDriftAlertPayload,
  type SliceDriftBaselineDocument,
  type SliceDriftSample,
  type SliceDriftTelemetryEvent,
} from "../../../packages/learning/dist/drift_monitor.js";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SUBJECT_ID = "subject.drift-monitor";
const DEVICE_ID = "device.drift-monitor";

const ONE_SLICE_BASELINE: SliceDriftBaselineDocument = {
  schemaVersion: "slice-drift-baselines.v1",
  baselineRegistryHash:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  confidenceAlpha: 0.05,
  slices: [
    {
      sliceId: "teacher/en/b8",
      baselineScore: 1,
      tolerance: 0.05,
    },
  ],
};

function sample(
  overrides: Partial<SliceDriftSample> = {},
): SliceDriftSample {
  return {
    operationId: "operation.1",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "production",
    cycleId: "cycle.1",
    sliceId: "teacher/en/b8",
    score: 1,
    ...overrides,
  };
}

function assertObligation(
  action: () => unknown,
  obligation: string,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SliceDriftContractError);
    assert.equal(error.obligation, obligation);
    return true;
  });
}

async function assertRejectedObligation(
  action: Promise<unknown>,
  obligation: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SliceDriftContractError);
    assert.equal(error.obligation, obligation);
    return true;
  });
}

test("loads hash-pinned C0 registry and activates every registered slice", async () => {
  const events: SliceDriftTelemetryEvent[] = [];
  const monitor = await loadSliceDriftMonitor({
    repoRoot: REPO_ROOT,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    onTelemetry: (event) => events.push(event),
  });

  assert.deepEqual(monitor.registeredSliceIds, [
    "guidance/en/b8",
    "lawyer/en/b8",
    "nfr/en/edge",
    "protocol/en/a-p6",
    "smoke/en/edge",
    "teacher/en/b8",
    "wire/en/protocol",
  ]);
  const snapshot = monitor.snapshot({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "production",
    cycleId: "cycle.empty",
  });
  assert.equal(snapshot.slices.length, 7);
  assert.ok(snapshot.slices.every((row) => row.sampleCount === 0));
  assert.ok(snapshot.slices.every((row) => row.confidenceUpper === 1));
  assert.equal(events.length, 0);
});

test("stable production traffic stays green; one regressed slice breaches", async () => {
  const events: SliceDriftTelemetryEvent[] = [];
  const monitor = await loadSliceDriftMonitor({
    repoRoot: REPO_ROOT,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    onTelemetry: (event) => events.push(event),
  });

  const stable = monitor.record(
    sample({
      operationId: "stable.1",
      sliceId: "teacher/en/b8",
      score: 0.98,
    }),
  );
  assert.equal(stable.breached, false);
  assert.equal(stable.mean, 0.98);

  const breached = monitor.record(
    sample({
      operationId: "regressed.1",
      sliceId: "lawyer/en/b8",
      score: 0.7,
    }),
  );
  assert.equal(breached.breached, true);
  assert.equal(breached.lowTraffic, true);
  assert.equal(breached.confidenceLower, 0);
  assert.equal(breached.confidenceUpper, 1);
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.slice_drift.breach" &&
        event.sliceId === "lawyer/en/b8" &&
        event.subjectId === SUBJECT_ID &&
        event.deviceId === DEVICE_ID,
    ),
  );
  assert.ok(
    events.every(
      (event) =>
        !Object.keys(event).some((key) =>
          /utterance|content|body|prompt|secret/i.test(key),
        ),
    ),
  );
});

test("low traffic widens confidence but never suppresses threshold breach", () => {
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
  });
  const result = monitor.record(sample({ score: 0.5 }));
  assert.equal(result.sampleCount, 1);
  assert.equal(result.lowTraffic, true);
  assert.equal(result.confidenceLower, 0);
  assert.equal(result.confidenceUpper, 1);
  assert.equal(result.breached, true);
  assert.equal(result.confirmedBreach, false);
});

test("synthetic canary and production statistics are strictly separated", () => {
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
  });
  monitor.record(
    sample({
      operationId: "synthetic.1",
      channel: "synthetic-canary",
      score: 0,
    }),
  );
  const production = monitor.record(
    sample({ operationId: "production.1", score: 1 }),
  );
  assert.equal(production.sampleCount, 1);
  assert.equal(production.mean, 1);
  const synthetic = monitor.snapshot({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "synthetic-canary",
    cycleId: "cycle.1",
  });
  assert.equal(synthetic.slices[0]?.mean, 0);
  assert.equal(synthetic.slices[0]?.sampleCount, 1);
});

test("replays are idempotent, conflicts fail, and callback partial failure recovers", () => {
  let shouldThrow = true;
  const events: SliceDriftTelemetryEvent[] = [];
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    onTelemetry(event) {
      events.push(event);
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("telemetry unavailable");
      }
    },
  });

  assert.throws(() => monitor.record(sample()), /telemetry unavailable/);
  const replay = monitor.record(sample());
  assert.equal(replay.sampleCount, 1);
  assert.equal(
    events.at(-1)?.outcome,
    "idempotent_replay",
    "receipt is durable before a failing callback",
  );
  assertObligation(
    () => monitor.record(sample({ score: 0.4 })),
    "drift_monitor.idempotent_conflict",
  );
});

test("cross-subject/locality access and raw content are denied", () => {
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
  });

  assertObligation(
    () =>
      monitor.record(
        sample({
          subjectId: "subject.other",
          operationId: "cross-subject.1",
        }),
      ),
    "drift_monitor.cross_subject_denied",
  );
  assertObligation(
    () =>
      monitor.record(
        sample({
          locality: "self-hosted",
          operationId: "cross-locality.1",
        }),
      ),
    "drift_monitor.locality_forbidden",
  );
  assertObligation(
    () =>
      monitor.record({
        ...sample({ operationId: "raw-content.1" }),
        promptBody: "must never be retained",
      } as SliceDriftSample),
    "drift_monitor.raw_content_forbidden",
  );
  assertObligation(
    () =>
      monitor.snapshot({
        subjectId: "subject.other",
        deviceId: DEVICE_ID,
        locality: "on-device",
        channel: "production",
        cycleId: "cycle.1",
      }),
    "drift_monitor.cross_subject_denied",
  );
});

test("bounded operation and fixed-cycle capacities fail loudly", () => {
  const operationBounded = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    operationLimit: 1,
  });
  operationBounded.record(sample());
  assertObligation(
    () =>
      operationBounded.record(
        sample({ operationId: "operation.2" }),
      ),
    "drift_monitor.capacity",
  );

  const cycleBounded = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    cycleLimit: 1,
  });
  cycleBounded.record(sample());
  assertObligation(
    () =>
      cycleBounded.record(
        sample({
          operationId: "cycle.2.operation",
          cycleId: "cycle.2",
        }),
      ),
    "drift_monitor.capacity",
  );
});

test("breach routes one metadata-only alert with slice, delta, and baseline hash", async () => {
  const routed: SliceDriftAlertPayload[] = [];
  const events: SliceDriftTelemetryEvent[] = [];
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    alertSink: {
      async route(payload) {
        routed.push(payload);
      },
    },
    onTelemetry: (event) => events.push(event),
  });

  const stable = await monitor.recordAndRoute(
    sample({ operationId: "stable.route", score: 0.98 }),
  );
  assert.equal(stable.routed, false);
  assert.equal(routed.length, 0);

  const breach = await monitor.recordAndRoute(
    sample({ operationId: "breach.route", score: 0.5 }),
  );
  assert.equal(breach.routed, true);
  assert.equal(routed.length, 1);
  assert.deepEqual(routed[0], breach.alert);
  assert.equal(routed[0]?.sliceId, "teacher/en/b8");
  assert.equal(routed[0]?.metricDelta, -0.26);
  assert.equal(
    routed[0]?.baselineHash,
    ONE_SLICE_BASELINE.baselineRegistryHash,
  );
  assert.equal(routed[0]?.subjectId, SUBJECT_ID);
  assert.equal(routed[0]?.deviceId, DEVICE_ID);
  assert.equal(routed[0]?.locality, "on-device");
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.slice_drift.alert_routing" &&
        event.outcome === "routed" &&
        event.sliceId === "teacher/en/b8",
    ),
  );
  assert.ok(
    Object.keys(routed[0]!).every(
      (key) => !/utterance|content|body|prompt|secret/i.test(key),
    ),
  );
});

test("low-traffic alert and concurrent replays route exactly once", async () => {
  let routeCount = 0;
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    alertSink: {
      async route() {
        routeCount += 1;
        await Promise.resolve();
      },
    },
  });
  const lowTraffic = sample({
    operationId: "concurrent.route",
    score: 0.5,
  });
  const [first, second] = await Promise.all([
    monitor.recordAndRoute(lowTraffic),
    monitor.recordAndRoute(lowTraffic),
  ]);
  assert.equal(first.score.lowTraffic, true);
  assert.equal(first.routed, true);
  assert.deepEqual(second.alert, first.alert);
  assert.equal(routeCount, 1);

  const detachedRoute = monitor.recordAndRoute;
  await detachedRoute(lowTraffic);
  assert.equal(routeCount, 1);
});

test("routing failure retries the same alert without scoring twice", async () => {
  const payloads: SliceDriftAlertPayload[] = [];
  let fail = true;
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    alertSink: {
      async route(payload) {
        payloads.push(payload);
        if (fail) {
          fail = false;
          throw new Error("router unavailable");
        }
      },
    },
  });
  const routedSample = sample({
    operationId: "retry.route",
    score: 0.5,
  });
  await assertRejectedObligation(
    monitor.recordAndRoute(routedSample),
    "drift_monitor.route_failed",
  );
  const recovered = await monitor.recordAndRoute(routedSample);
  assert.equal(recovered.routed, true);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]?.alertId, payloads[1]?.alertId);
  const snapshot = monitor.snapshot({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "production",
    cycleId: "cycle.1",
  });
  assert.equal(snapshot.slices[0]?.sampleCount, 1);
});

test("missing sink and downstream timeout surface typed failures", async () => {
  const missing = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
  });
  await assertRejectedObligation(
    missing.recordAndRoute(
      sample({ operationId: "missing.sink", score: 0.5 }),
    ),
    "drift_monitor.alert_sink_missing",
  );

  const timeout = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: ONE_SLICE_BASELINE,
    alertTimeoutMs: 5,
    alertSink: {
      route: () => new Promise<void>(() => {}),
    },
  });
  await assertRejectedObligation(
    timeout.recordAndRoute(
      sample({ operationId: "timeout.route", score: 0.5 }),
    ),
    "drift_monitor.downstream_timeout",
  );
});
