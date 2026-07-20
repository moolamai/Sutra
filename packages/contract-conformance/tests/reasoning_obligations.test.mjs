/**
 * Reasoning obligations : mandatory trace + constraint surfacing.
 * Run: pnpm --filter @moolam/contract-conformance test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_CONSTRAINTS_SURFACE,
  MUST_TRACE_NON_EMPTY,
  REASONING_OBLIGATION_IDS,
  REASONING_VIOLATION_FIXTURES,
  buildConstraintSurfacingProbeRequest,
  buildTraceProbeRequest,
  createConstraintSurfacingObligationRegistry,
  createDroppedConstraintReasoningHarnessFactory,
  createEmptyTraceReasoningHarnessFactory,
  createFillerTraceReasoningHarnessFactory,
  createMandatoryTraceObligationRegistry,
  createParaphrasedConstraintReasoningHarnessFactory,
  createReasoningObligationsRegistry,
  createTracedReasoningHarnessFactory,
  isFillerStepStatement,
  listReasoningViolationFixtures,
  runConformance,
  unverifiableConstraintToken,
} from "../dist/index.js";

test("happy path: traced reference mock passes CK-04.1", async () => {
  const events = [];
  const report = await runConformance({
    registry: createMandatoryTraceObligationRegistry(),
    factory: createTracedReasoningHarnessFactory(),
    subjectId: "subj-reasoning-good",
    deviceId: "dev-reasoning",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(report.verdicts[0].obligationId, REASONING_OBLIGATION_IDS.mandatoryTrace);
  assert.equal(report.verdicts[0].mustText, MUST_TRACE_NON_EMPTY);
  assert.ok(
    events.some(
      (e) =>
        e.event === "conformance.runner" &&
        e.outcome === "pass" &&
        e.obligationId === "CK-04.1" &&
        e.subjectId &&
        e.deviceId === "dev-reasoning",
    ),
  );
});

test("happy path: constraint-surfacing reference passes CK-04.2", async () => {
  const events = [];
  const report = await runConformance({
    registry: createConstraintSurfacingObligationRegistry(),
    factory: createTracedReasoningHarnessFactory(),
    subjectId: "subj-constraint-good",
    deviceId: "dev-constraint",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    REASONING_OBLIGATION_IDS.constraintSurfacing,
  );
  assert.equal(report.verdicts[0].mustText, MUST_CONSTRAINTS_SURFACE);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-04.2" &&
        e.subjectId &&
        e.deviceId === "dev-constraint",
    ),
  );
});

test("happy path: full reasoning registry passes CK-04.1 and CK-04.2", async () => {
  const report = await runConformance({
    registry: createReasoningObligationsRegistry(),
    factory: createTracedReasoningHarnessFactory(),
    subjectId: "subj-reasoning-full",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
});

test("violation: empty-trace fixture fails CK-04.1 exactly", async () => {
  const report = await runConformance({
    registry: createMandatoryTraceObligationRegistry(),
    factory: createEmptyTraceReasoningHarnessFactory(),
    subjectId: "subj-empty-trace",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(report.verdicts[0].obligationId, REASONING_OBLIGATION_IDS.mandatoryTrace);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.equal(report.verdicts[0].mustText, MUST_TRACE_NON_EMPTY);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /empty steps/i);
});

test("violation: filler-trace fixture fails CK-04.1", async () => {
  const report = await runConformance({
    registry: createMandatoryTraceObligationRegistry(),
    factory: createFillerTraceReasoningHarnessFactory(),
    subjectId: "subj-filler-trace",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, REASONING_OBLIGATION_IDS.mandatoryTrace);
  assert.match(report.verdicts[0].message ?? "", /filler/i);
});

test("violation: dropped-constraint fixture fails CK-04.2 exactly", async () => {
  const report = await runConformance({
    registry: createConstraintSurfacingObligationRegistry(),
    factory: createDroppedConstraintReasoningHarnessFactory(),
    subjectId: "subj-drop-constraint",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    REASONING_OBLIGATION_IDS.constraintSurfacing,
  );
  assert.equal(report.verdicts[0].mustText, MUST_CONSTRAINTS_SURFACE);
  assert.equal(report.verdicts[0].attribution, "implementation");
  assert.match(report.verdicts[0].message ?? "", /silently dropped|missing/i);
});

test("violation: paraphrased constraint is not verbatim surfacing", async () => {
  const report = await runConformance({
    registry: createConstraintSurfacingObligationRegistry(),
    factory: createParaphrasedConstraintReasoningHarnessFactory(),
    subjectId: "subj-paraphrase",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    REASONING_OBLIGATION_IDS.constraintSurfacing,
  );
});

test("edge: probe request is subject-scoped metadata tokens only", () => {
  const req = buildTraceProbeRequest({
    subjectId: "subj-a::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  });
  assert.match(req.proposition, /subj-a\.peer/);
  assert.equal(req.evidence[0].content, "probe.ck04.1.evidence.token");
  assert.doesNotMatch(req.proposition, /password|ssn|email/i);
});

test("edge: constraint probe scopes unverifiable token by subjectId", () => {
  const req = buildConstraintSurfacingProbeRequest({
    subjectId: "subj-b::peer",
    deviceId: "dev",
    deadlineMs: 1000,
    emit() {},
  });
  assert.equal(req.constraints?.[0], unverifiableConstraintToken("subj-b::peer"));
  assert.match(req.constraints?.[0] ?? "", /subj-b\.peer/);
  assert.doesNotMatch(req.constraints?.[0] ?? "", /password|ssn/i);
});

test("edge: independent factory runs share no mutable state", async () => {
  const factory = createTracedReasoningHarnessFactory();
  const a = factory();
  const b = factory();
  const [ra, rb] = await Promise.all([
    a.reasoning.deliberate({
      proposition: "probe.a",
      evidence: [{ sourceRef: "a", content: "probe.a.token" }],
      constraints: ["probe.a.constraint"],
    }),
    b.reasoning.deliberate({
      proposition: "probe.b",
      evidence: [{ sourceRef: "b", content: "probe.b.token" }],
      constraints: ["probe.b.constraint"],
    }),
  ]);
  assert.ok(ra.steps.length > 0);
  assert.ok(rb.steps.length > 0);
  assert.deepEqual(ra.unresolvedConstraints, ["probe.a.constraint"]);
  assert.deepEqual(rb.unresolvedConstraints, ["probe.b.constraint"]);
  assert.notEqual(a, b);
});

test("edge: concurrent deliberate surfaces each request's constraints", async () => {
  const harness = createTracedReasoningHarnessFactory()();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.reasoning.deliberate({
        proposition: `probe.concurrent.${i}`,
        evidence: [{ sourceRef: `e.${i}`, content: "probe.token" }],
        constraints: [`probe.constraint.${i}`],
      }),
    ),
  );
  assert.ok(results.every((r) => r.steps.length > 0));
  assert.ok(
    results.every((r, i) => r.unresolvedConstraints.includes(`probe.constraint.${i}`)),
  );
});

test("edge: dropped-constraint still passes CK-04.1 when selected alone", async () => {
  const report = await runConformance({
    registry: createReasoningObligationsRegistry(),
    factory: createDroppedConstraintReasoningHarnessFactory(),
    subjectId: "subj-drop-partial",
    obligationIds: [REASONING_OBLIGATION_IDS.mandatoryTrace],
  });
  assert.equal(report.exitCode, 0);
});

test("edge: replay of CK-04.2 run is idempotent on exit code", async () => {
  const opts = {
    registry: createConstraintSurfacingObligationRegistry(),
    factory: createDroppedConstraintReasoningHarnessFactory(),
    subjectId: "subj-replay-constraint",
  };
  const first = await runConformance(opts);
  const second = await runConformance(opts);
  assert.equal(first.exitCode, 1);
  assert.equal(second.exitCode, first.exitCode);
  assert.equal(second.failed, first.failed);
});

test("edge: isFillerStepStatement rejects empty and stub phrases", () => {
  assert.equal(isFillerStepStatement("   "), true);
  assert.equal(isFillerStepStatement("..."), true);
  assert.equal(isFillerStepStatement("n/a"), true);
  assert.equal(
    isFillerStepStatement("Weighted evidence against the proposition"),
    false,
  );
});

/* ── two fixtures, each fails exactly its target ── */

test("catalog: two named reasoning violation fixtures", () => {
  const fixtures = listReasoningViolationFixtures();
  assert.equal(fixtures.length, 2);
  assert.deepEqual(
    fixtures.map((f) => f.fixtureId).sort(),
    [
      "reasoning.violation.constraint-swallowing",
      "reasoning.violation.empty-trace",
    ].sort(),
  );
  assert.deepEqual(
    fixtures.map((f) => f.targetObligationId).sort(),
    ["CK-04.1", "CK-04.2"].sort(),
  );
});

test("violation isolation: each REASOBLI-003 fixture fails only its target", async () => {
  for (const fixture of listReasoningViolationFixtures()) {
    const events = [];
    const report = await runConformance({
      registry: createReasoningObligationsRegistry(),
      factory: fixture.createFactory(),
      subjectId: `subj-fixture-${fixture.fixtureId.split(".").pop()}`,
      deviceId: "dev-reas-isolation",
      emit: (e) => events.push(e),
    });
    assert.equal(report.exitCode, 1, fixture.fixtureId);
    assert.equal(report.passed, 1, fixture.fixtureId);
    assert.equal(report.failed, 1, fixture.fixtureId);
    const byId = Object.fromEntries(
      report.verdicts.map((v) => [v.obligationId, v]),
    );
    for (const id of Object.values(REASONING_OBLIGATION_IDS)) {
      if (id === fixture.targetObligationId) {
        assert.equal(byId[id].outcome, "fail", `${fixture.fixtureId} → ${id}`);
        assert.equal(byId[id].mustText, fixture.mustText);
        assert.equal(byId[id].attribution, "implementation");
      } else {
        assert.equal(byId[id].outcome, "pass", `${fixture.fixtureId} → ${id}`);
      }
    }
    assert.ok(
      events.some(
        (e) =>
          e.event === "conformance.runner" &&
          e.outcome === "fail" &&
          e.obligationId === fixture.targetObligationId &&
          e.subjectId &&
          e.deviceId === "dev-reas-isolation",
      ),
      `observability for ${fixture.fixtureId}`,
    );
  }
});

test("edge: empty-trace fixture still surfaces subject-scoped constraints", async () => {
  const harness = REASONING_VIOLATION_FIXTURES.emptyTrace.createFactory()();
  const token = unverifiableConstraintToken("subj-empty-iso");
  const result = await harness.reasoning.deliberate({
    proposition: "probe.empty.iso",
    evidence: [{ sourceRef: "e", content: "probe.token" }],
    constraints: [token],
  });
  assert.equal(result.steps.length, 0);
  assert.deepEqual(result.unresolvedConstraints, [token]);
});

test("edge: concurrent deliberate on constraint-swallowing stays empty unresolved", async () => {
  const harness =
    REASONING_VIOLATION_FIXTURES.constraintSwallowing.createFactory()();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      harness.reasoning.deliberate({
        proposition: `probe.swallow.${i}`,
        evidence: [{ sourceRef: `e.${i}`, content: "probe.token" }],
        constraints: [`probe.constraint.${i}`],
      }),
    ),
  );
  assert.ok(results.every((r) => r.steps.length > 0));
  assert.ok(results.every((r) => r.unresolvedConstraints.length === 0));
});

test("edge: replay of full fixture-isolation suite is idempotent", async () => {
  const fixture = REASONING_VIOLATION_FIXTURES.emptyTrace;
  const opts = {
    registry: createReasoningObligationsRegistry(),
    factory: fixture.createFactory(),
    subjectId: "subj-replay-reas-fixture",
  };
  const a = await runConformance(opts);
  const b = await runConformance(opts);
  assert.equal(a.exitCode, 1);
  assert.equal(b.exitCode, a.exitCode);
  assert.equal(a.failed, b.failed);
  assert.equal(a.passed, b.passed);
});
