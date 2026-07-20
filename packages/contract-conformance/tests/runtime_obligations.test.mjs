/**
 * Runtime obligations : lifecycle, scheduler, bus, storage.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_DURABLE_BEFORE_RESOLVE,
  MUST_FAILED_TASK_NON_BLOCKING,
  MUST_FLUSH_BEFORE_DISPOSE,
  MUST_INITIALIZE_IDEMPOTENT,
  MUST_STABLE_SCHEDULER_ORDER,
  MUST_SUBSCRIBER_THROW_ISOLATION,
  RUNTIME_OBLIGATION_IDS,
  RUNTIME_SUBSCRIBER_ERROR_TYPE,
  buildRuntimeProbeKey,
  createDisposeWithoutFlushRuntimeHarnessFactory,
  createDurableBeforeResolveObligationRegistry,
  createExecuteBeforeDurableRuntimeHarnessFactory,
  createFailBlocksQueueRuntimeHarnessFactory,
  createFailedTaskNonBlockingObligationRegistry,
  createFlushBeforeDisposeObligationRegistry,
  createInitializeIdempotentObligationRegistry,
  createNonIdempotentInitRuntimeHarnessFactory,
  createPublishRethrowsRuntimeHarnessFactory,
  createReferenceRuntimeHarnessFactory,
  createRuntimeObligationsRegistry,
  createStableSchedulerOrderObligationRegistry,
  createSubscriberThrowIsolationObligationRegistry,
  createUnstableSchedulerRuntimeHarnessFactory,
  runConformance,
} from "../dist/index.js";

test("happy path: reference passes RT-01.1 initialize idempotent", async () => {
  const events = [];
  const report = await runConformance({
    registry: createInitializeIdempotentObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-init-good",
    deviceId: "dev-rt",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    RUNTIME_OBLIGATION_IDS.initializeIdempotent,
  );
  assert.equal(report.verdicts[0].mustText, MUST_INITIALIZE_IDEMPOTENT);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "RT-01.1" &&
        e.deviceId === "dev-rt",
    ),
  );
});

test("happy path: reference passes RT-01.2 flush-before-dispose", async () => {
  const report = await runConformance({
    registry: createFlushBeforeDisposeObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-flush-good",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].mustText, MUST_FLUSH_BEFORE_DISPOSE);
});

test("happy path: reference passes RT-02.1 stable scheduler order", async () => {
  const report = await runConformance({
    registry: createStableSchedulerOrderObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-order-good",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].mustText, MUST_STABLE_SCHEDULER_ORDER);
});

test("happy path: reference passes RT-02.2 failed-task non-blocking", async () => {
  const report = await runConformance({
    registry: createFailedTaskNonBlockingObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-fail-good",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].mustText, MUST_FAILED_TASK_NON_BLOCKING);
});

test("happy path: reference passes RT-03.1 subscriber throw isolation", async () => {
  const report = await runConformance({
    registry: createSubscriberThrowIsolationObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-bus-good",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].mustText, MUST_SUBSCRIBER_THROW_ISOLATION);
});

test("happy path: reference passes RT-04.1 durable-before-resolve", async () => {
  const report = await runConformance({
    registry: createDurableBeforeResolveObligationRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-store-good",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts[0].mustText, MUST_DURABLE_BEFORE_RESOLVE);
});

test("happy path: full runtime registry passes all six obligations", async () => {
  const report = await runConformance({
    registry: createRuntimeObligationsRegistry(),
    factory: createReferenceRuntimeHarnessFactory(),
    subjectId: "subj-rt-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 6);
});

test("violation: non-idempotent init fails RT-01.1", async () => {
  const report = await runConformance({
    registry: createInitializeIdempotentObligationRegistry(),
    factory: createNonIdempotentInitRuntimeHarnessFactory(),
    subjectId: "subj-rt-reinit",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    RUNTIME_OBLIGATION_IDS.initializeIdempotent,
  );
  assert.match(report.verdicts[0].message ?? "", /once|idempotent|re-entry/i);
});

test("violation: dispose-without-flush fails RT-01.2", async () => {
  const report = await runConformance({
    registry: createFlushBeforeDisposeObligationRegistry(),
    factory: createDisposeWithoutFlushRuntimeHarnessFactory(),
    subjectId: "subj-rt-no-flush",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /flush|durable|lost/i);
});

test("violation: unstable scheduler fails RT-02.1", async () => {
  const report = await runConformance({
    registry: createStableSchedulerOrderObligationRegistry(),
    factory: createUnstableSchedulerRuntimeHarnessFactory(),
    subjectId: "subj-rt-unstable",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /order|submission/i);
});

test("violation: fail-blocks-queue fails RT-02.2", async () => {
  const report = await runConformance({
    registry: createFailedTaskNonBlockingObligationRegistry(),
    factory: createFailBlocksQueueRuntimeHarnessFactory(),
    subjectId: "subj-rt-blocked",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /blocked|later/i);
});

test("violation: publish-rethrows fails RT-03.1", async () => {
  const report = await runConformance({
    registry: createSubscriberThrowIsolationObligationRegistry(),
    factory: createPublishRethrowsRuntimeHarnessFactory(),
    subjectId: "subj-rt-rethrow",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /threw|subscriber/i);
});

test("violation: execute-before-durable fails RT-04.1", async () => {
  const report = await runConformance({
    registry: createDurableBeforeResolveObligationRegistry(),
    factory: createExecuteBeforeDurableRuntimeHarnessFactory(),
    subjectId: "subj-rt-late-durable",
  });
  assert.equal(report.exitCode, 1);
  assert.match(report.verdicts[0].message ?? "", /durable|before/i);
});

test("edge: probe keys are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  assert.match(buildRuntimeProbeKey(ctx, "flush"), /subj-a\.peer/);
  assert.doesNotMatch(buildRuntimeProbeKey(ctx, "flush"), /password|ssn/i);
  assert.equal(RUNTIME_SUBSCRIBER_ERROR_TYPE, "runtime.subscriber-error");
});

test("edge: independent factory runs share no durable storage", async () => {
  const factory = createReferenceRuntimeHarnessFactory();
  const a = factory();
  const b = factory();
  await a.storage.execute("UPSERT", ["k-a", "v-a"]);
  assert.ok(a.durableRows().some((r) => r.key === "k-a"));
  assert.equal(b.durableRows().length, 0);
});

test("edge: concurrent equal-runAtMs schedules preserve order per drain", async () => {
  const harness = createReferenceRuntimeHarnessFactory()();
  const order = [];
  for (const id of ["x", "y", "z"]) {
    harness.scheduler.schedule({
      taskId: id,
      name: id,
      runAtMs: 0,
      deadlineMs: 500,
      execute: async () => {
        order.push(id);
      },
    });
  }
  await harness.untilIdle();
  assert.deepEqual(order, ["x", "y", "z"]);
});

test("edge: dispose-without-flush still passes RT-01.1 when selected alone", async () => {
  const report = await runConformance({
    registry: createRuntimeObligationsRegistry(),
    factory: createDisposeWithoutFlushRuntimeHarnessFactory(),
    subjectId: "subj-rt-partial",
    obligationIds: [RUNTIME_OBLIGATION_IDS.initializeIdempotent],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of RT-02.2 violation is idempotent", async () => {
  const opts = {
    registry: createFailedTaskNonBlockingObligationRegistry(),
    factory: createFailBlocksQueueRuntimeHarnessFactory(),
    subjectId: "subj-replay-rt",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});
