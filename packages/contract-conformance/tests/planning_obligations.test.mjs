/**
 * Planning obligations ( / CK-08): cyclic revise + rationale updates.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_CYCLIC_REVISE,
  MUST_REVISION_UPDATES_RATIONALE,
  PLANNING_OBLIGATION_IDS,
  buildPlanningProbeContext,
  buildPlanningProbeGoals,
  createCyclicPlanningHarnessFactory,
  createCyclicReviseObligationRegistry,
  createNoLoopBackPlanningHarnessFactory,
  createPlanningObligationsRegistry,
  createRevisionUpdatesRationaleObligationRegistry,
  createSilentRationalePlanningHarnessFactory,
  detectsLoopBack,
  runConformance,
} from "../dist/index.js";

test("happy path: cyclic reference passes CK-08.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createCyclicReviseObligationRegistry(),
    factory: createCyclicPlanningHarnessFactory(),
    subjectId: "subj-plan-cyclic-good",
    deviceId: "dev-plan",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    PLANNING_OBLIGATION_IDS.cyclicRevise,
  );
  assert.equal(report.verdicts[0].mustText, MUST_CYCLIC_REVISE);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-08.1" &&
        e.subjectId &&
        e.deviceId === "dev-plan",
    ),
  );
});

test("happy path: cyclic reference passes CK-08.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createRevisionUpdatesRationaleObligationRegistry(),
    factory: createCyclicPlanningHarnessFactory(),
    subjectId: "subj-plan-rationale-good",
    deviceId: "dev-rationale",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
  );
  assert.equal(report.verdicts[0].mustText, MUST_REVISION_UPDATES_RATIONALE);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-08.2" &&
        e.deviceId === "dev-rationale",
    ),
  );
});

test("happy path: full planning registry passes CK-08.1 and CK-08.2", async () => {
  const report = await runConformance({
    registry: createPlanningObligationsRegistry(),
    factory: createCyclicPlanningHarnessFactory(),
    subjectId: "subj-plan-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
});

test("violation: no-loop-back fails CK-08.1 exactly", async () => {
  const report = await runConformance({
    registry: createCyclicReviseObligationRegistry(),
    factory: createNoLoopBackPlanningHarnessFactory(),
    subjectId: "subj-plan-no-loop",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    PLANNING_OBLIGATION_IDS.cyclicRevise,
  );
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /route back|earlier|loop/i);
});

test("violation: silent rationale fails CK-08.2 exactly", async () => {
  const report = await runConformance({
    registry: createRevisionUpdatesRationaleObligationRegistry(),
    factory: createSilentRationalePlanningHarnessFactory(),
    subjectId: "subj-plan-silent",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    PLANNING_OBLIGATION_IDS.revisionUpdatesRationale,
  );
  assert.match(report.verdicts[0].message ?? "", /rationale|unchanged|silent/i);
});

test("edge: probe goals and context are subject-scoped metadata", () => {
  const ctx = {
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const goals = buildPlanningProbeGoals(ctx);
  assert.ok(goals.every((g) => g.goalId.includes("subj-a.peer")));
  assert.doesNotMatch(goals[0].description, /password|ssn/i);
  assert.match(buildPlanningProbeContext(ctx), /subj-a\.peer/);
});

test("edge: detectsLoopBack recognizes foundation reopen", () => {
  const before = {
    planId: "p",
    rationale: "a",
    steps: [
      {
        stepId: "s0",
        goalId: "g0",
        action: "a0",
        dependsOn: [],
        status: "done",
      },
      {
        stepId: "s1",
        goalId: "g1",
        action: "a1",
        dependsOn: ["s0"],
        status: "active",
      },
    ],
  };
  const after = {
    ...before,
    steps: [
      { ...before.steps[0], status: "active" },
      { ...before.steps[1], status: "pending" },
    ],
  };
  assert.equal(
    detectsLoopBack(before, after, before.steps[1], after.steps[0]),
    true,
  );
  assert.equal(
    detectsLoopBack(before, before, before.steps[1], before.steps[1]),
    false,
  );
});

test("edge: independent factory runs share no revision sequence", async () => {
  const factory = createCyclicPlanningHarnessFactory();
  const a = factory();
  const b = factory();
  const goals = buildPlanningProbeGoals({
    subjectId: "s",
    deviceId: "d",
    deadlineMs: 1,
    emit() {},
  });
  const planA = await a.planning.compose(goals, "ctx-a");
  const planB = await b.planning.compose(goals, "ctx-b");
  const revA = await a.planning.revise(planA, {
    observation: "obs-a",
    severity: "blocking",
  });
  assert.notEqual(revA.rationale, planA.rationale);
  assert.equal(planB.rationale.includes("ctx-b"), true);
  assert.notEqual(a, b);
});

test("edge: concurrent revise calls each update rationale", async () => {
  const harness = createCyclicPlanningHarnessFactory()();
  const ctx = {
    subjectId: "subj-conc",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  };
  const goals = buildPlanningProbeGoals(ctx);
  const plans = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.planning.compose(goals, `probe.ck08.conc.${i}`),
    ),
  );
  const revised = await Promise.all(
    plans.map((p, i) =>
      harness.planning.revise(p, {
        observation: `probe.obs.${i}`,
        severity: "informational",
      }),
    ),
  );
  assert.ok(
    revised.every((r, i) => r.rationale !== plans[i].rationale),
  );
});

test("edge: no-loop-back still passes CK-08.2 when selected alone", async () => {
  const report = await runConformance({
    registry: createPlanningObligationsRegistry(),
    factory: createNoLoopBackPlanningHarnessFactory(),
    subjectId: "subj-plan-partial",
    obligationIds: [PLANNING_OBLIGATION_IDS.revisionUpdatesRationale],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-08.1 violation is idempotent", async () => {
  const opts = {
    registry: createCyclicReviseObligationRegistry(),
    factory: createNoLoopBackPlanningHarnessFactory(),
    subjectId: "subj-replay-plan",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});
