/**
 * Correction-cycle features + process reward shaping (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRAJECTORY_SCHEMA_VERSION,
  MAX_CORRECTION_TURNS,
  PROCESS_FIRST_PASS_BONUS,
  PROCESS_MIN_SCORE,
  PROCESS_OUTCOME_OBLIGATION_PENALTY,
  PROCESS_REPAIR_PENALTY_PER_DEPTH,
  PROCESS_REWARD_ABS_CAP,
  ProcessRewardContractError,
  assertProcessDominatedByObligation,
  countCorrectionDepth,
  createProcessRewardCritic,
  detectFirstPassValidToolCall,
  extractCorrectionCycleFeatures,
  scoreProcessReward,
  shapeProcessReward,
} from "../dist/index.js";

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.process.test",
    sessionId: "sess-1",
    turnId: "turn-1",
    deviceId: "dev-process-01",
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

test("happy path: first-pass valid tool call with zero correction depth", () => {
  const events = [];
  const features = extractCorrectionCycleFeatures(draft(), {
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(features.correctionDepth, 0);
  assert.equal(features.effectiveDepth, 0);
  assert.equal(features.cappedAtMax, false);
  assert.equal(features.firstPassValidToolCall, true);
  assert.equal(features.firstPassBonusEligible, true);
  assert.equal(features.maxCorrectionTurns, MAX_CORRECTION_TURNS);
  assert.ok(
    events.some(
      (e) => e.outcome === "ok" && e.subjectId === "subj.process.test",
    ),
  );
});

test("happy path: first-pass shapes modest bonus under dominance cap", () => {
  const events = [];
  const shaped = scoreProcessReward(draft(), {
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(shaped.total, PROCESS_FIRST_PASS_BONUS);
  assert.equal(shaped.breakdown.first_pass_valid, PROCESS_FIRST_PASS_BONUS);
  assert.ok(Math.abs(shaped.total) <= PROCESS_REWARD_ABS_CAP);
  assertProcessDominatedByObligation(shaped.total);
  assert.ok(
    shaped.total + PROCESS_OUTCOME_OBLIGATION_PENALTY < 0,
    "obligation must keep net negative",
  );
  assert.ok(events.some((e) => e.event === "learning.critic.process_score"));

  const critic = createProcessRewardCritic();
  const score = critic.score(draft());
  assert.equal(score.total, PROCESS_FIRST_PASS_BONUS);
  assert.equal(score.rubricVersion, "1.0.0");
});

test("edge: repair depth counted; first-pass bonus ineligible", () => {
  const repaired = draft({
    stages: [
      { stage: "act", opCode: "tool.write", status: "error" },
      { stage: "repair", opCode: "tool.repair", status: "ok" },
    ],
  });
  assert.equal(countCorrectionDepth(repaired), 1);
  assert.equal(detectFirstPassValidToolCall(repaired, 1), false);

  const features = extractCorrectionCycleFeatures(repaired);
  assert.equal(features.correctionDepth, 1);
  assert.equal(features.firstPassValidToolCall, false);
  assert.equal(features.firstPassBonusEligible, false);

  const shaped = scoreProcessReward(repaired);
  assert.equal(
    shaped.breakdown.repair_depth,
    -PROCESS_REPAIR_PENALTY_PER_DEPTH,
  );
  assert.equal(shaped.total, -PROCESS_REPAIR_PENALTY_PER_DEPTH);
});

test("edge: depth at MAX_CORRECTION_TURNS gets min process score; synthetic retry never first-pass", () => {
  const capped = extractCorrectionCycleFeatures(
    draft({
      correctionDepth: MAX_CORRECTION_TURNS + 3,
      stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    }),
  );
  assert.equal(capped.correctionDepth, MAX_CORRECTION_TURNS + 3);
  assert.equal(capped.effectiveDepth, MAX_CORRECTION_TURNS);
  assert.equal(capped.cappedAtMax, true);
  assert.equal(capped.firstPassBonusEligible, false);

  const shaped = shapeProcessReward(capped);
  assert.equal(shaped.total, PROCESS_MIN_SCORE);
  assert.equal(shaped.minScoreApplied, true);
  assert.equal(shaped.breakdown.process_cap_floor, PROCESS_MIN_SCORE);
  const deeper = shapeProcessReward({
    ...capped,
    correctionDepth: MAX_CORRECTION_TURNS + 99,
  });
  assert.equal(deeper.total, PROCESS_MIN_SCORE);

  const synthetic = scoreProcessReward(
    draft({
      correctionDepth: 0,
      syntheticRetryAfterExhaustion: true,
      stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    }),
  );
  assert.equal(synthetic.features.firstPassValidToolCall, false);
  assert.equal(synthetic.total, PROCESS_MIN_SCORE);
  assert.equal(synthetic.minScoreApplied, true);
});

test("edge: dominance cap clamps |process|; obligation still nets negative", () => {
  const deep = scoreProcessReward(
    draft({
      correctionDepth: 6,
      stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    }),
  );
  assert.equal(deep.total, -PROCESS_REWARD_ABS_CAP);
  assert.equal(deep.dominanceCapped, true);
  assertProcessDominatedByObligation(deep.total);
  assert.ok(deep.total + PROCESS_OUTCOME_OBLIGATION_PENALTY < 0);

  assert.throws(
    () => assertProcessDominatedByObligation(PROCESS_REWARD_ABS_CAP + 0.1),
    (err) =>
      err instanceof ProcessRewardContractError &&
      err.obligation === "process.dominance_breach",
  );
});

test("edge: reward-hack fixtures score zero; missing subject throws", () => {
  const events = [];
  const empty = scoreProcessReward(draft({ stages: [] }), {
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(empty.total, 0);
  assert.equal(empty.breakdown.reward_hack_guard, 0);
  assert.ok(events.some((e) => e.failureClass === "process.reward_hack"));

  assert.throws(
    () => extractCorrectionCycleFeatures(draft({ subjectId: "" })),
    (err) =>
      err instanceof ProcessRewardContractError &&
      err.obligation === "process.missing_subject",
  );
});

test("sovereignty: telemetry has subjectId/deviceId and no utterance bodies", () => {
  const events = [];
  scoreProcessReward(draft(), {
    onTelemetry: (e) => events.push(e),
  });
  const blob = JSON.stringify(events);
  assert.equal(/utterance|keystroke|rawContent/i.test(blob), false);
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
});
