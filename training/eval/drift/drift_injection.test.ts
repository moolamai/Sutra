/**
 * Drift monitor injection prove — single-slice regression trips;
 * derived aggregate stays flat; stable lanes do not false-positive.
 *
 * Run: node --experimental-strip-types --test training/eval/drift/drift_injection.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SliceDriftContractError,
  createSliceDriftMonitor,
  deriveSliceDriftAggregate,
  loadSliceDriftMonitor,
  proveSliceDriftInjection,
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
const SUBJECT_ID = "subject.drift-injection";
const DEVICE_ID = "device.drift-injection";

const MULTI_SLICE_BASELINE: SliceDriftBaselineDocument = {
  schemaVersion: "slice-drift-baselines.v1",
  baselineRegistryHash:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  confidenceAlpha: 0.05,
  slices: [
    { sliceId: "teacher/en/b8", baselineScore: 1, tolerance: 0.05 },
    { sliceId: "lawyer/en/b8", baselineScore: 1, tolerance: 0.05 },
    { sliceId: "smoke/en/edge", baselineScore: 1, tolerance: 0 },
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

test("injection: one slice trips while derived aggregate stays flat", async () => {
  const events: SliceDriftTelemetryEvent[] = [];
  const report = await proveSliceDriftInjection({
    repoRoot: REPO_ROOT,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    injectedSliceId: "teacher/en/b8",
    injectedScore: 0.5,
    stableScore: 1,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(report.injectedSliceId, "teacher/en/b8");
  assert.equal(report.routedAlerts.length, 1);
  assert.equal(report.routedAlerts[0]?.channel, "production");
  assert.equal(report.routedAlerts[0]?.sliceId, "teacher/en/b8");
  assert.ok(report.routedAlerts[0]?.metricDelta < 0);
  assert.equal(
    report.routedAlerts[0]?.baselineHash,
    report.baselineRegistryHash,
  );

  const breached = report.production.slices.filter((row) => row.breached);
  assert.equal(breached.length, 1);
  assert.equal(breached[0]?.sliceId, "teacher/en/b8");
  assert.ok(
    report.production.slices
      .filter((row) => row.sliceId !== "teacher/en/b8")
      .every((row) => row.breached === false),
  );

  assert.equal(report.aggregate.flat, true);
  assert.equal(report.aggregate.breachedCount, 1);
  assert.ok(report.aggregate.scoredCount >= 7);
  assert.ok(report.aggregate.mean > 0.9);

  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.slice_drift.breach" &&
        event.sliceId === "teacher/en/b8",
    ),
  );
  assert.ok(
    events.every(
      (event) =>
        event.subjectId === SUBJECT_ID &&
        event.deviceId === DEVICE_ID &&
        !Object.keys(event).some((key) =>
          /utterance|content|body|prompt|secret/i.test(key),
        ),
    ),
  );
});

test("injection: synthetic-canary channel does not pollute production", async () => {
  const report = await proveSliceDriftInjection({
    repoRoot: REPO_ROOT,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
  });
  const productionTeacher = report.production.slices.find(
    (row) => row.sliceId === "teacher/en/b8",
  );
  const canaryTeacher = report.syntheticCanary.slices.find(
    (row) => row.sliceId === "teacher/en/b8",
  );
  assert.equal(productionTeacher?.sampleCount, 2);
  assert.equal(canaryTeacher?.sampleCount, 1);
  assert.equal(canaryTeacher?.mean, 0);
  assert.notEqual(productionTeacher?.mean, 0);
});

test("injection: low-traffic single-sample regression still trips", () => {
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: MULTI_SLICE_BASELINE,
  });
  for (const sliceId of ["lawyer/en/b8", "smoke/en/edge"] as const) {
    monitor.record(
      sample({
        operationId: `stable.${sliceId.replaceAll("/", ".")}`,
        sliceId,
        score: 1,
      }),
    );
  }
  const tripped = monitor.record(
    sample({
      operationId: "low.traffic.inject",
      sliceId: "teacher/en/b8",
      score: 0.4,
    }),
  );
  assert.equal(tripped.lowTraffic, true);
  assert.equal(tripped.breached, true);

  const snapshot = monitor.snapshot({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "production",
    cycleId: "cycle.1",
  });
  // Three-slice micro fixture: one deep regression still keeps aggregate
  // within a widened flat band (fleet-scale C0 prove uses the default 0.15).
  const aggregate = deriveSliceDriftAggregate(snapshot.slices, {
    flatTolerance: 0.25,
  });
  assert.equal(aggregate.breachedCount, 1);
  assert.equal(aggregate.flat, true);
  assert.ok(
    snapshot.slices
      .filter((row) => row.sliceId !== "teacher/en/b8")
      .every((row) => !row.breached),
  );
});

test("injection: concurrent same-subject records stay idempotent; cross-subject denied", async () => {
  const routed: string[] = [];
  const monitor = await loadSliceDriftMonitor({
    repoRoot: REPO_ROOT,
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    alertSink: {
      async route(payload) {
        routed.push(payload.alertId);
      },
    },
  });

  const payload = sample({
    operationId: "concurrent.inject",
    sliceId: "lawyer/en/b8",
    score: 0.4,
    cycleId: "cycle.concurrent",
  });
  const [a, b] = await Promise.all([
    monitor.recordAndRoute(payload),
    monitor.recordAndRoute(payload),
  ]);
  assert.equal(a.routed, true);
  assert.equal(b.routed, true);
  assert.equal(routed.length, 1);

  assert.throws(
    () =>
      monitor.record(
        sample({
          operationId: "cross.subject",
          subjectId: "subject.other",
          sliceId: "lawyer/en/b8",
          score: 0.4,
          cycleId: "cycle.concurrent",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SliceDriftContractError);
      assert.equal(error.obligation, "drift_monitor.cross_subject_denied");
      return true;
    },
  );
});

test("injection: partial alert failure recovers without double-scoring", async () => {
  let fail = true;
  let routeCount = 0;
  const monitor = createSliceDriftMonitor({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    baseline: MULTI_SLICE_BASELINE,
    alertSink: {
      async route() {
        routeCount += 1;
        if (fail) {
          fail = false;
          throw new Error("pager down");
        }
      },
    },
  });
  monitor.record(
    sample({
      operationId: "stable.lawyer",
      sliceId: "lawyer/en/b8",
      score: 0.99,
    }),
  );
  const injected = sample({
    operationId: "partial.inject",
    sliceId: "teacher/en/b8",
    score: 0.4,
  });
  await assert.rejects(
    monitor.recordAndRoute(injected),
    (error: unknown) => {
      assert.ok(error instanceof SliceDriftContractError);
      assert.equal(error.obligation, "drift_monitor.route_failed");
      return true;
    },
  );
  const recovered = await monitor.recordAndRoute(injected);
  assert.equal(recovered.routed, true);
  assert.equal(routeCount, 2);
  const snapshot = monitor.snapshot({
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    channel: "production",
    cycleId: "cycle.1",
  });
  assert.equal(
    snapshot.slices.find((row) => row.sliceId === "teacher/en/b8")
      ?.sampleCount,
    1,
  );
});
