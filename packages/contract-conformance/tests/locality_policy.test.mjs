/**
 * Locality policy + assertLocality + obligations.
 *
 * Happy path: compliant turn passes CK-03.L1/L2 under sovereign policy.
 * Edge: regulated→third-party fails L1 only; cross-subject initiator fails L2 only.
 * Edge: hanging capture respects runner deadline; assertLocality is idempotent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SOVEREIGN_LOCALITY_POLICY,
  LOCALITY_OBLIGATION_IDS,
  assertLocality,
  createCompliantLocalityHarnessFactory,
  createCrossSubjectEgressViolationFactory,
  createLocalityPolicyObligationsRegistry,
  createRegulatedThirdPartyViolationFactory,
  runConformance,
  withEgressRecordingTurn,
} from "../dist/index.js";

test("happy path: compliant locality harness passes both policy obligations", async () => {
  const events = [];
  const report = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: createCompliantLocalityHarnessFactory(),
    subjectId: "anika-k",
    deviceId: "dev-policy",
    emit: (e) => events.push(e),
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.verdicts.length, 2);
  assert.ok(report.verdicts.every((v) => v.outcome === "pass"));
});

test("violation: regulated third-party fails CK-03.L1 exactly", async () => {
  const report = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: createRegulatedThirdPartyViolationFactory(),
    subjectId: "anika-k",
    deviceId: "dev-policy",
    obligationIds: [LOCALITY_OBLIGATION_IDS.regulatedStaysLocal],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(report.verdicts[0].obligationId, LOCALITY_OBLIGATION_IDS.regulatedStaysLocal);
  assert.equal(report.verdicts[0].outcome, "fail");
  assert.match(report.verdicts[0].message ?? "", /regulated|third-party|vendor/i);

  const other = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: createRegulatedThirdPartyViolationFactory(),
    subjectId: "anika-k",
    deviceId: "dev-policy",
    obligationIds: [LOCALITY_OBLIGATION_IDS.subjectBoundEgress],
  });
  assert.equal(other.exitCode, 0, "L2 must pass when only L1 is violated");
});

test("violation: cross-subject initiator fails CK-03.L2 exactly", async () => {
  const report = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: createCrossSubjectEgressViolationFactory(),
    subjectId: "anika-k",
    deviceId: "dev-policy",
    obligationIds: [LOCALITY_OBLIGATION_IDS.subjectBoundEgress],
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts[0].obligationId, LOCALITY_OBLIGATION_IDS.subjectBoundEgress);
  assert.match(report.verdicts[0].message ?? "", /subjectId|peer/i);

  const other = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: createCrossSubjectEgressViolationFactory(),
    subjectId: "anika-k",
    deviceId: "dev-policy",
    obligationIds: [LOCALITY_OBLIGATION_IDS.regulatedStaysLocal],
  });
  assert.equal(other.exitCode, 0, "L1 must pass when only L2 is violated");
});

test("edge: assertLocality is idempotent; hanging capture hits runner deadline", async () => {
  const { turn } = await withEgressRecordingTurn(
    {
      subjectId: "subj-assert",
      deviceId: "dev-assert",
      caller: { principalId: "ops", subjectScope: "*" },
      selfHostedHosts: ["school.local"],
    },
    async (api) => {
      const mock = api.mockAgent();
      assert.ok(mock);
      mock
        .get("https://vendor.example")
        .intercept({ path: "/", method: "GET" })
        .reply(200, "x");
      await api.withPayloadClass("regulated", async () => {
        await fetch("https://vendor.example/");
      });
    },
  );

  const a = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  const b = assertLocality(turn, DEFAULT_SOVEREIGN_LOCALITY_POLICY);
  assert.equal(a.ok, false);
  assert.deepEqual(
    a.violations.map((v) => v.code),
    b.violations.map((v) => v.code),
  );
  assert.equal(a.violations[0].code, "LOCALITY_FORBIDDEN_DESTINATION");

  const hangFactory = () => ({
    policy: DEFAULT_SOVEREIGN_LOCALITY_POLICY,
    async captureTurn() {
      await new Promise(() => {
        /* hang */
      });
      throw new Error("unreachable");
    },
  });

  const hung = await runConformance({
    registry: createLocalityPolicyObligationsRegistry(),
    factory: hangFactory,
    subjectId: "subj-hang",
    deviceId: "dev-hang",
    deadlineMs: 40,
    obligationIds: [LOCALITY_OBLIGATION_IDS.regulatedStaysLocal],
  });
  assert.equal(hung.exitCode, 1);
  assert.equal(hung.verdicts[0].outcome, "timeout");
  assert.match(hung.verdicts[0].message ?? "", /deadline/i);
});
