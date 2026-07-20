/**
 * PublishSyncOutcome metadata-only catalog helper.
 * Run: pnpm --filter @moolam/observability test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createValidatingEventBus,
  parseCatalogEvent,
  publishSyncOutcome,
  SYNC_OUTCOME,
} from "../dist/index.js";

test("happy path: publishSyncOutcome converged is catalog-valid", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  publishSyncOutcome(bus, {
    subjectId: "subj-so",
    deviceId: "dev-so",
    syncAttemptId: "11111111-1111-4111-8111-111111111111",
    outcome: "converged",
    attempts: 1,
    durationMs: 12,
    advisoryCodes: ["CLOCK_SKEW_CLAMPED", "CLOCK_SKEW_CLAMPED"],
  });

  assert.equal(seen.length, 1);
  const parsed = parseCatalogEvent(seen[0]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.event.payload.advisoryCodes, ["CLOCK_SKEW_CLAMPED"]);
  assert.doesNotMatch(JSON.stringify(seen[0]), /mastery|frictionLog|detail/i);
});

test("edge: skipped-offline accepts attempts 0", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  publishSyncOutcome(bus, {
    subjectId: "subj-off",
    deviceId: "dev-off",
    syncAttemptId: "22222222-2222-4222-8222-222222222222",
    outcome: "skipped-offline",
    attempts: 0,
  });

  assert.equal(parseCatalogEvent(seen[0]).ok, true);
  assert.equal(seen[0].payload.outcome, "skipped-offline");
  assert.equal(seen[0].payload.attempts, 0);
});

test("edge: unknown advisory codes and state keys are dropped / rejected", () => {
  const bus = createValidatingEventBus({ mode: "throw" });
  const seen = [];
  bus.subscribe(SYNC_OUTCOME, (e) => seen.push(e));

  publishSyncOutcome(bus, {
    subjectId: "s",
    deviceId: "d",
    syncAttemptId: "33333333-3333-4333-8333-333333333333",
    outcome: "exhausted",
    attempts: 3,
    exhaustedCode: "TRANSIENT_ATTEMPTS_EXHAUSTED",
    advisoryCodes: ["NOT_A_REAL_CODE", "STATE_VECTOR_REGRESSION"],
  });
  assert.deepEqual(seen[0].payload.advisoryCodes, ["STATE_VECTOR_REGRESSION"]);

  assert.throws(
    () =>
      bus.publish({
        type: SYNC_OUTCOME,
        at: new Date().toISOString(),
        payload: {
          subjectId: "s",
          deviceId: "d",
          syncAttemptId: "33333333-3333-4333-8333-333333333333",
          outcome: "converged",
          attempts: 1,
          mastery: { leak: true },
        },
      }),
    /forbidden|schema|catalog/i,
  );
});
