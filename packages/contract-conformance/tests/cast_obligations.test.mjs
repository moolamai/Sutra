/**
 * CAST-05.1 cold-start advance-blocked obligation + violation fixture.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  CAST_COLDSTART_GOLDENS_RELPATH,
  CAST_COLDSTART_GOLDENS_SCHEMA,
  CAST_OBLIGATION_IDS,
  CAST_VIOLATION_FIXTURES,
  MUST_COLD_START_ADVANCE_BLOCKED,
  buildColdStartProbeInput,
  createCastObligationsRegistry,
  createColdStartAdvanceBlockedObligationRegistry,
  createCompliantCastHarnessFactory,
  createPrematureAdvanceCastHarnessFactory,
  listCastViolationFixtures,
  runConformance,
} from "../dist/index.js";

test("happy path: compliant reference passes CAST-05.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createColdStartAdvanceBlockedObligationRegistry(),
    factory: createCompliantCastHarnessFactory(),
    subjectId: "subj-cast-compliant",
    deviceId: "dev-cast",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
  );
  assert.equal(report.verdicts[0].mustText, MUST_COLD_START_ADVANCE_BLOCKED);
  assert.ok(
    events.some(
      (e) =>
        (e.event === "conformance.runner" ||
          e.event === "conformance.obligation") &&
        e.outcome === "pass" &&
        e.obligationId === "CAST-05.1" &&
        typeof e.subjectId === "string" &&
        e.subjectId.startsWith("subj-cast-compliant"),
    ),
  );
  assert.ok(events.some((e) => e.deviceId === "dev-cast"));
});

test("happy path: full cast registry passes CAST-05.1", async () => {
  const report = await runConformance({
    registry: createCastObligationsRegistry(),
    factory: createCompliantCastHarnessFactory(),
    subjectId: "subj-cast-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
});

test("violation: premature-advance fixture fails CAST-05.1 exactly", async () => {
  const report = await runConformance({
    registry: createColdStartAdvanceBlockedObligationRegistry(),
    factory: createPrematureAdvanceCastHarnessFactory(),
    subjectId: "subj-cast-premature",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    CAST_OBLIGATION_IDS.coldStartAdvanceBlocked,
  );
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(
    report.verdicts[0].message ?? "",
    /advance|unassessed|root/i,
  );
});

test("catalog: CAST_VIOLATION_FIXTURES targets CAST-05.1", () => {
  const fixtures = listCastViolationFixtures();
  assert.equal(fixtures.length, 1);
  assert.equal(
    CAST_VIOLATION_FIXTURES.prematureAdvance.targetObligationId,
    "CAST-05.1",
  );
  assert.equal(
    CAST_VIOLATION_FIXTURES.prematureAdvance.mustText,
    MUST_COLD_START_ADVANCE_BLOCKED,
  );
  assert.equal(CAST_05_MIN_ROOT_FRICTION_SAMPLES, 3);
  assert.equal(
    CAST_COLDSTART_GOLDENS_SCHEMA,
    "teacher-cbse-slice.coldstart-goldens.v1",
  );
  assert.ok(
    CAST_COLDSTART_GOLDENS_RELPATH.includes(
      "teacher-cbse-slice.coldstart-goldens.json",
    ),
  );
});

test("edge: probe inputs are subject-scoped metadata (no shared mutable state)", () => {
  const ctxA = {
    subjectId: "subj-a",
    deviceId: "dev-1",
    deadlineMs: 1000,
    signal: AbortSignal.timeout(1000),
    emit() {},
  };
  const ctxB = {
    subjectId: "subj-b",
    deviceId: "dev-2",
    deadlineMs: 1000,
    signal: AbortSignal.timeout(1000),
    emit() {},
  };
  const a = buildColdStartProbeInput(ctxA);
  const b = buildColdStartProbeInput(ctxB);
  assert.equal(a.subjectId, "subj-a");
  assert.equal(b.subjectId, "subj-b");
  assert.notEqual(a.rootConceptIds[0], b.rootConceptIds[0]);
  assert.ok(a.rootConceptIds[0].includes("subj-a"));
  assert.ok(!a.rootConceptIds[0].includes("subj-b"));
});

test("edge: high-confidence first turn does not advance under compliant router", async () => {
  const harness = createCompliantCastHarnessFactory()();
  const input = buildColdStartProbeInput({
    subjectId: "subj-first-turn",
    deviceId: "dev",
    deadlineMs: 1000,
    signal: AbortSignal.timeout(1000),
    emit() {},
  });
  const result = await harness.router.route(input);
  assert.notEqual(result.routeAction, "advance");
  assert.equal(result.mode, "diagnostic");
});

test("edge: partial root assessment still blocks advance", async () => {
  const harness = createCompliantCastHarnessFactory()();
  const ctx = {
    subjectId: "subj-partial",
    deviceId: "dev",
    deadlineMs: 1000,
    signal: AbortSignal.timeout(1000),
    emit() {},
  };
  const base = buildColdStartProbeInput(ctx);
  const [rootA, rootB] = base.rootConceptIds;
  const result = await harness.router.route(
    buildColdStartProbeInput(ctx, {
      frictionSampleCounts: {
        [rootA]: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
        [rootB]: 1,
        [base.activeConceptId]: 0,
      },
    }),
  );
  assert.notEqual(result.routeAction, "advance");
  assert.equal(result.mode, "diagnostic");
  assert.ok(result.unassessedRootConceptIds.includes(rootB));
});

test("violation isolation: premature fixture fails only CAST-05.1", async () => {
  const fixture = CAST_VIOLATION_FIXTURES.prematureAdvance;
  const report = await runConformance({
    registry: createCastObligationsRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-cast-isolation",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, fixture.targetObligationId);
});
