/**
 * Remaining-contracts violation fixtures .
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_OBLIGATION_IDS,
  PLANNING_OBLIGATION_IDS,
  PLANNING_VIOLATION_FIXTURES,
  REMAINING_VIOLATION_FIXTURES,
  RUNTIME_OBLIGATION_IDS,
  RUNTIME_VIOLATION_FIXTURES,
  SPEECH_OBLIGATION_IDS,
  VISION_OBLIGATION_IDS,
  createPlanningObligationsRegistry,
  createRuntimeObligationsRegistry,
  listPlanningViolationFixtures,
  listRemainingViolationFixtures,
  listRuntimeViolationFixtures,
  runConformance,
} from "../dist/index.js";

test("catalog: five named remaining-contracts violation fixtures", () => {
  const fixtures = listRemainingViolationFixtures();
  assert.equal(fixtures.length, 5);
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.cumulativeStream.fixtureId,
    "remaining.violation.cumulative-stream",
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.noPartialSpeech.fixtureId,
    "remaining.violation.no-partial-speech",
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.silentOversizeVision.fixtureId,
    "remaining.violation.silent-oversize",
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.staticRationalePlanner.fixtureId,
    "planning.violation.static-rationale",
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.nonIdempotentLifecycle.fixtureId,
    "runtime.violation.non-idempotent-lifecycle",
  );
});

test("violation isolation: each REMAINING fixture fails only its domain target", async () => {
  for (const fixture of listRemainingViolationFixtures()) {
    const events = [];
    const report = await runConformance({
      registry: fixture.createRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-remaining-${fixture.fixtureId.split(".").pop()}`,
      deviceId: "dev-remaining-isolation",
      emit: (e) => events.push(e),
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    assert.ok(report.passed >= 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    assert.equal(
      byId[fixture.targetObligationId].outcome,
      "fail",
      `${fixture.fixtureId} → ${fixture.targetObligationId}`,
    );
    assert.equal(byId[fixture.targetObligationId].mustText, fixture.mustText);
    assert.equal(
      byId[fixture.targetObligationId].attribution,
      "implementation",
    );
    for (const verdict of report.verdicts) {
      if (verdict.obligationId === fixture.targetObligationId) continue;
      assert.equal(
        verdict.outcome,
        "pass",
        `${fixture.fixtureId} must pass ${verdict.obligationId}`,
      );
    }
    assert.ok(
      events.some(
        (e) =>
          e.event === "conformance.runner" &&
          e.outcome === "fail" &&
          e.obligationId === fixture.targetObligationId &&
          e.subjectId &&
          e.deviceId === "dev-remaining-isolation",
      ),
      `observability for ${fixture.fixtureId}`,
    );
  }
});

test("violation isolation: each PLANNING_VIOLATION_FIXTURES entry fails only its target", async () => {
  for (const fixture of listPlanningViolationFixtures()) {
    const report = await runConformance({
      registry: createPlanningObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-plan-fix-${fixture.fixtureId.split(".").pop()}`,
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 1, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(PLANNING_OBLIGATION_IDS)) {
      if (id === fixture.targetObligationId) {
        assert.equal(byId[id].outcome, "fail", fixture.fixtureId);
      } else {
        assert.equal(byId[id].outcome, "pass", fixture.fixtureId);
      }
    }
  }
});

test("violation isolation: each RUNTIME_VIOLATION_FIXTURES entry fails only its target", async () => {
  for (const fixture of listRuntimeViolationFixtures()) {
    const report = await runConformance({
      registry: createRuntimeObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-rt-fix-${fixture.fixtureId.split(".").pop()}`,
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 5, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(RUNTIME_OBLIGATION_IDS)) {
      if (id === fixture.targetObligationId) {
        assert.equal(byId[id].outcome, "fail", fixture.fixtureId);
      } else {
        assert.equal(byId[id].outcome, "pass", `${fixture.fixtureId} → ${id}`);
      }
    }
  }
});

test("edge: remaining fixtures target the expected obligation ids", () => {
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.cumulativeStream.targetObligationId,
    MODEL_OBLIGATION_IDS.streamDeltas,
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.noPartialSpeech.targetObligationId,
    SPEECH_OBLIGATION_IDS.transcribePartials,
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.silentOversizeVision.targetObligationId,
    VISION_OBLIGATION_IDS.rejectOversized,
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.staticRationalePlanner.targetObligationId,
    PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
  );
  assert.equal(
    REMAINING_VIOLATION_FIXTURES.nonIdempotentLifecycle.targetObligationId,
    RUNTIME_OBLIGATION_IDS.initializeIdempotent,
  );
  assert.equal(
    PLANNING_VIOLATION_FIXTURES.staticRationale.fixtureId,
    REMAINING_VIOLATION_FIXTURES.staticRationalePlanner.fixtureId,
  );
  assert.equal(
    RUNTIME_VIOLATION_FIXTURES.nonIdempotentLifecycle.fixtureId,
    REMAINING_VIOLATION_FIXTURES.nonIdempotentLifecycle.fixtureId,
  );
});

test("edge: concurrent isolation runs stay independent per subjectId", async () => {
  const fixture = REMAINING_VIOLATION_FIXTURES.staticRationalePlanner;
  const reports = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      runConformance({
        registry: fixture.createRegistry(),
        factory: fixture.createFactory(),
        subjectId: `subj-concurrent-remaining-${i}`,
      }),
    ),
  );
  assert.ok(reports.every((r) => r.exitCode === 1 && r.failed === 1));
});

test("edge: replay of remaining isolation suite is idempotent", async () => {
  const fixture = REMAINING_VIOLATION_FIXTURES.noPartialSpeech;
  const opts = {
    registry: fixture.createRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-replay-remaining",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, a.exitCode);
  assert.equal(a.failed, b.failed);
  assert.equal(a.passed, b.passed);
});
