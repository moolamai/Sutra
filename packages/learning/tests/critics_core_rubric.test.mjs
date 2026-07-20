/**
 * Core rubric scoring (C3) — format/invariant/schema/ACCEPTED/clean success.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRAJECTORY_SCHEMA_VERSION,
  CORE_RUBRIC_ID,
  CORE_RUBRIC_VERSION,
  CORE_RUBRIC_WEIGHTS,
  CriticContractError,
  assertCriticScore,
  assertDeterministicScores,
  bindHumanOutcomeForRubric,
  createCoreRubricCritic,
  detectCleanSuccess,
  scoreCoreRubric,
  scoreCoreRubricBreakdown,
  scoreCoreRubricWithOutcome,
} from "../dist/index.js";

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.core-rubric.test",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "dev-core-01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    ...overrides,
  };
}

test("happy path: ACCEPTED + clean success emit breakdown and agree with labels", () => {
  const events = [];
  const critic = createCoreRubricCritic({
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(critic.rubricId, CORE_RUBRIC_ID);
  assert.equal(critic.rubricVersion, CORE_RUBRIC_VERSION);

  const accepted = draft({ humanOutcomeSignal: "ACCEPTED" });
  const a = critic.score(accepted);
  const b = critic.score(accepted);
  assertCriticScore(a, CORE_RUBRIC_VERSION);
  assertDeterministicScores(a, b);

  assert.equal(a.breakdown.human_accepted, CORE_RUBRIC_WEIGHTS.human_accepted);
  assert.equal(a.breakdown.clean_success, CORE_RUBRIC_WEIGHTS.clean_success);
  assert.equal(
    a.total,
    CORE_RUBRIC_WEIGHTS.human_accepted + CORE_RUBRIC_WEIGHTS.clean_success,
  );
  // Held-out ACCEPTED label → positive total above 0.85 threshold proxy
  assert.ok(a.total >= 1.0);
  assert.ok(events.some((e) => e.outcome === "ok" && e.subjectId === accepted.subjectId));
});

test("edge: format / invariant / schema violations stack additively", () => {
  const format = draft({
    stages: [
      { stage: "format", opCode: "protocol.format", status: "error" },
    ],
  });
  const formatScore = scoreCoreRubric(format);
  assert.equal(formatScore.breakdown.format_breach, -1.0);

  const invariant = draft({
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
  });
  const invScore = scoreCoreRubric(invariant);
  assert.equal(invScore.breakdown.invariant_violation, -2.0);

  // Schema: stages exceed soft limit → schema_failure −1.0
  const tooMany = draft({
    stages: Array.from({ length: 33 }, (_, i) => ({
      stage: "act",
      status: "ok",
      opCode: `op.${i}`,
    })),
  });
  const schemaScore = scoreCoreRubric(tooMany);
  assert.equal(schemaScore.breakdown.schema_failure, -1.0);

  // Stack: format + invariant on one record
  const stacked = draft({
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [
      { stage: "protocol", opCode: "format.breach", status: "error" },
    ],
  });
  const stackedScore = scoreCoreRubricBreakdown(stacked);
  assert.equal(stackedScore.format_breach, -1.0);
  assert.equal(stackedScore.invariant_violation, -2.0);
  assert.equal(
    scoreCoreRubric(stacked).total,
    -1.0 + -2.0,
  );
});

test("edge: one repair cycle disqualifies clean_success; reward-hack scores zero", () => {
  assert.equal(
    detectCleanSuccess(
      draft({
        humanOutcomeSignal: "ACCEPTED",
        correctionCycleCount: 1,
      }),
    ),
    false,
  );
  const repaired = scoreCoreRubric(
    draft({
      humanOutcomeSignal: "ACCEPTED",
      stages: [{ stage: "repair", opCode: "tool.repair", status: "ok" }],
    }),
  );
  assert.equal(repaired.breakdown.clean_success, undefined);
  assert.equal(repaired.breakdown.human_accepted, 1.0);

  const critic = createCoreRubricCritic();
  const empty = draft({ stages: [] });
  assert.equal(critic.score(empty).total, 0);

  const spam = draft({
    toolCallIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
    stages: [{ stage: "act", status: "error" }],
  });
  assert.equal(critic.score(spam).total, 0);
});

test("edge: REJECTED/DISCARDED stay non-positive on human/clean components", () => {
  const rejected = scoreCoreRubric(
    draft({ humanOutcomeSignal: "REJECTED" }),
  );
  assert.equal(rejected.breakdown.human_accepted, undefined);
  assert.equal(rejected.breakdown.clean_success, undefined);
  assert.equal(rejected.breakdown.human_rejected, CORE_RUBRIC_WEIGHTS.human_rejected);
  assert.ok(rejected.total <= 0);

  const discarded = scoreCoreRubric(
    draft({ humanOutcomeSignal: "DISCARDED" }),
  );
  assert.equal(discarded.breakdown.human_accepted, undefined);
  assert.equal(discarded.breakdown.clean_success, undefined);
  assert.equal(discarded.breakdown.human_discarded, 0);
  assert.ok(discarded.total <= 0);
});

test("outcome wiring: REJECTED penalty; DISCARDED zeroes positives; C0 bind", () => {
  const events = [];
  const critic = createCoreRubricCritic({
    onTelemetry: (e) => events.push(e),
  });

  // REJECTED applies human_rejected −1.0 and stacks with format breach
  const rejectedStacked = scoreCoreRubric(
    draft({
      humanOutcomeSignal: "REJECTED",
      stages: [
        { stage: "format", opCode: "protocol.format", status: "error" },
      ],
    }),
  );
  assert.equal(rejectedStacked.breakdown.human_rejected, -1.0);
  assert.equal(rejectedStacked.breakdown.format_breach, -1.0);
  assert.equal(rejectedStacked.total, -2.0);

  // DISCARDED zeroes positives even if stages look clean
  const discardedClean = scoreCoreRubric(
    draft({ humanOutcomeSignal: "DISCARDED" }),
  );
  assert.equal(discardedClean.breakdown.clean_success, undefined);
  assert.equal(discardedClean.breakdown.human_accepted, undefined);
  assert.equal(discardedClean.breakdown.human_discarded, 0);
  assert.equal(discardedClean.total, 0);

  // DISCARDED keeps verifiable penalties, strips positives
  const discardedPenalty = scoreCoreRubricBreakdown(
    draft({
      humanOutcomeSignal: "DISCARDED",
      stages: [
        { stage: "format", opCode: "protocol.format", status: "error" },
      ],
    }),
  );
  assert.equal(discardedPenalty.format_breach, -1.0);
  assert.equal(discardedPenalty.human_discarded, 0);
  assert.ok(!Object.values(discardedPenalty).some((v) => v > 0));

  // C0 attachOutcomeSignal path via scoreCoreRubricWithOutcome
  const base = draft();
  const withOutcome = scoreCoreRubricWithOutcome(base, {
    subjectId: base.subjectId,
    turnId: base.turnId,
    deviceId: base.deviceId,
    humanOutcomeSignal: "ACCEPTED",
  });
  assert.equal(withOutcome.breakdown.human_accepted, 1.0);
  assert.equal(withOutcome.breakdown.clean_success, 0.5);

  // Cross-subject binding refused
  assert.throws(
    () =>
      bindHumanOutcomeForRubric(base, {
        subjectId: "subj.intruder",
        turnId: base.turnId,
        humanOutcomeSignal: "ACCEPTED",
      }),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );

  // Invalid wire signal → typed error
  assert.throws(
    () =>
      scoreCoreRubric(
        draft({ humanOutcomeSignal: "MAYBE" }),
      ),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.invalid_score",
  );

  critic.score(draft({ humanOutcomeSignal: "REJECTED" }));
  assert.ok(
    events.some(
      (e) =>
        e.oracleKind === "outcome:REJECTED" &&
        e.breakdownKeys?.includes("human_rejected"),
    ),
  );
  assert.equal(/utterance|keystroke|rawContent/i.test(JSON.stringify(events)), false);
});

test("sovereignty: missing subjectId throws; telemetry has no utterance bodies", () => {
  const events = [];
  const critic = createCoreRubricCritic({
    onTelemetry: (e) => events.push(e),
  });
  assert.throws(
    () => critic.score(draft({ subjectId: "" })),
    (err) =>
      err instanceof CriticContractError &&
      err.obligation === "critic.subject_scope",
  );
  critic.score(draft({ humanOutcomeSignal: "ACCEPTED" }));
  const blob = JSON.stringify(events);
  assert.equal(/utterance|keystrokeText|rawContent/i.test(blob), false);
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
});
