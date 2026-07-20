/**
 * 002 — CK-10 refusal obligations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_CONSERVATIVE_UNRESOLVED_REFUSAL,
  MUST_REFUSALS_AS_CONSTRAINTS,
  MUST_REFUSAL_DECLINE,
  REFUSAL_OBLIGATION_IDS,
  REFUSAL_PROBE_LEGAL,
  createCompliantRefusalHarnessFactory,
  createConstraintsDroppedHarnessFactory,
  createDeclineIgnoringHarnessFactory,
  createRefusalObligationsRegistry,
  createRefusalSwallowingHarnessFactory,
  formatDeclineReply,
  listRefusalViolationFixtures,
  runConformance,
  unresolvedRefusalCategories,
} from "../dist/index.js";

test("happy path: compliant harness passes full CK-10 obligation set", async () => {
  const report = await runConformance({
    registry: createRefusalObligationsRegistry(),
    factory: createCompliantRefusalHarnessFactory(),
    subjectId: "subj-ck10-good",
    deviceId: "dev-ck10",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts.length, 3);
  assert.ok(report.verdicts.every((v) => v.outcome === "pass"));
  const ids = report.verdicts.map((v) => v.obligationId).sort();
  assert.deepEqual(ids, ["CK-10.1", "CK-10.2", "CK-10.3"]);
});

test("violation: decline-ignoring fails CK-10.1 exactly", async () => {
  const report = await runConformance({
    registry: createRefusalObligationsRegistry(),
    factory: createDeclineIgnoringHarnessFactory(),
    subjectId: "subj-ck10-ignore",
    deviceId: "dev-ck10",
    obligationIds: [REFUSAL_OBLIGATION_IDS.declinePath],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, REFUSAL_OBLIGATION_IDS.declinePath);
  assert.equal(report.verdicts[0].mustText, MUST_REFUSAL_DECLINE);
});

test("violation: swallowing reasoner fails CK-10.1 and CK-10.3 exactly", async () => {
  for (const id of [
    REFUSAL_OBLIGATION_IDS.declinePath,
    REFUSAL_OBLIGATION_IDS.conservativeUnresolved,
  ]) {
    const report = await runConformance({
      registry: createRefusalObligationsRegistry(),
      factory: createRefusalSwallowingHarnessFactory(),
      subjectId: "subj-ck10-swallow",
      deviceId: "dev-ck10",
      obligationIds: [id],
    });
    assert.equal(report.exitCode, 1);
    assert.equal(report.verdicts[0].obligationId, id);
    assert.match(
      report.verdicts[0].message ?? "",
      /decline|completed normally|conservative/i,
    );
  }
  // CK-10.2 still holds: CognitiveCore forwards refusals even if Reason drops them.
  const constraints = await runConformance({
    registry: createRefusalObligationsRegistry(),
    factory: createRefusalSwallowingHarnessFactory(),
    subjectId: "subj-ck10-swallow-c",
    deviceId: "dev-ck10",
    obligationIds: [REFUSAL_OBLIGATION_IDS.refusalsAsConstraints],
  });
  assert.equal(constraints.exitCode, 0);
});

test("violation: constraints-dropped fails CK-10.2 exactly", async () => {
  const report = await runConformance({
    registry: createRefusalObligationsRegistry(),
    factory: createConstraintsDroppedHarnessFactory(),
    subjectId: "subj-ck10-drop",
    deviceId: "dev-ck10",
    obligationIds: [REFUSAL_OBLIGATION_IDS.refusalsAsConstraints],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    REFUSAL_OBLIGATION_IDS.refusalsAsConstraints,
  );
  assert.equal(report.verdicts[0].mustText, MUST_REFUSALS_AS_CONSTRAINTS);
  assert.match(report.verdicts[0].message ?? "", /missing|constraints/i);
});

test("edge: violation fixtures target distinct obligations; helpers stable", () => {
  const fixtures = listRefusalViolationFixtures();
  assert.ok(fixtures.length >= 4);
  assert.ok(
    fixtures.some(
      (f) =>
        f.fixtureId.includes("constraint-swallowing") &&
        f.targetObligationId === REFUSAL_OBLIGATION_IDS.declinePath,
    ),
  );
  assert.deepEqual(
    unresolvedRefusalCategories(
      [REFUSAL_PROBE_LEGAL, "other"],
      [REFUSAL_PROBE_LEGAL, "noise"],
    ),
    [REFUSAL_PROBE_LEGAL],
  );
  const reply = formatDeclineReply([REFUSAL_PROBE_LEGAL], {
    conclusion: "out of scope",
  });
  assert.match(reply, /decline/i);
  assert.equal(MUST_CONSERVATIVE_UNRESOLVED_REFUSAL, MUST_REFUSAL_DECLINE);
});

test("edge: independent factories share no mutable turn state", async () => {
  const good = createCompliantRefusalHarnessFactory();
  const bad = createDeclineIgnoringHarnessFactory();
  const a = good({
    subjectId: "a",
    obligationId: "CK-10.1",
    signal: AbortSignal.abort(),
  });
  const b = bad({
    subjectId: "b",
    obligationId: "CK-10.1",
    signal: AbortSignal.abort(),
  });
  const inScope = await a.turn({
    subjectId: "a",
    sessionId: "s",
    utterance: "probe.ck10.utterance.clinical.ok",
  });
  const ignored = await b.turn({
    subjectId: "b",
    sessionId: "s",
    utterance: "probe.ck10.utterance.legal.peer",
  });
  assert.equal(inScope.declined, false);
  assert.equal(ignored.declined, false);
  assert.match(ignored.reply, /normal-completion/);
  assert.ok(a.lastDeliberateConstraints()?.includes(REFUSAL_PROBE_LEGAL));
});
