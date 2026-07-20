/**
 * Isolated LLM-judge lane — aspect separation + denylist (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TRAJECTORY_SCHEMA_VERSION,
  LLM_JUDGE_ALLOWED_ASPECTS,
  LLM_JUDGE_LANE_RUBRIC_PREFIX,
  LlmJudgePolicyContractError,
  assertCriticScore,
  assertSingleLlmJudgeAspectCall,
  createIsolatedLlmJudgeLane,
} from "../dist/index.js";

function draft(overrides = {}) {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: "subj.llm-judge.lane",
    sessionId: "sess-lane-1",
    turnId: "turn-lane-1",
    deviceId: "dev-lane-01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "reply", status: "ok" }],
    ...overrides,
  };
}

test("happy path: aspect-separated scores pin judgeModelId; separate allowed calls", async () => {
  const events = [];
  let calls = 0;
  const lane = createIsolatedLlmJudgeLane({
    judgeModelId: "judge.tone.local-v1",
    judgePromptVersion: "prompt.tone.1.0.0",
    scoreAspectFn: ({ aspect }) => {
      calls += 1;
      return aspect === "tone" ? 0.5 : 0.25;
    },
    onTelemetry: (e) => events.push(e),
  });

  const tone = await lane.scoreAspect({
    subjectId: "subj.llm-judge.lane",
    deviceId: "dev-lane-01",
    turnId: "turn-lane-1",
    aspect: "tone",
  });
  assert.equal(tone.aspect, "tone");
  assert.equal(tone.score, 0.5);
  assert.equal(tone.judgeModelId, "judge.tone.local-v1");
  assert.equal(tone.judgePromptVersion, "prompt.tone.1.0.0");

  const both = await lane.scoreAllowedAspectsSeparately({
    subjectId: "subj.llm-judge.lane",
    deviceId: "dev-lane-01",
    turnId: "turn-lane-2",
  });
  assert.equal(both.length, LLM_JUDGE_ALLOWED_ASPECTS.length);
  assert.deepEqual(
    both.map((j) => j.aspect),
    [...LLM_JUDGE_ALLOWED_ASPECTS],
  );
  assert.ok(both.every((j) => j.judgeModelId === "judge.tone.local-v1"));
  // tone scored twice (turn-1 + turn-2), clarity once → 3 scorer calls
  assert.equal(calls, 3);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.critic.llm_judge_lane" &&
        e.outcome === "ok" &&
        e.aspect === "tone",
    ),
  );

  const critic = lane.createAspectCritic("clarity");
  assert.equal(critic.rubricId, `${LLM_JUDGE_LANE_RUBRIC_PREFIX}.clarity`);
  assert.equal(critic.judgeModelId, "judge.tone.local-v1");
  const score = critic.score(draft({ turnId: "turn-lane-3" }));
  assertCriticScore(score, critic.rubricVersion);
  assert.equal(score.breakdown.clarity, 0.25);
});

test("edge: denylist / multi-aspect / unpinned identity rejected", async () => {
  assert.throws(
    () => assertSingleLlmJudgeAspectCall(["tone", "clarity"]),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.multi_aspect_call",
  );

  assert.throws(
    () =>
      createIsolatedLlmJudgeLane({
        judgeModelId: "",
        judgePromptVersion: "v1",
        scoreAspectFn: () => 0,
      }),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.unpinned_identity",
  );

  const lane = createIsolatedLlmJudgeLane({
    judgeModelId: "judge.clarity.local-v1",
    judgePromptVersion: "prompt.clarity.1.0.0",
    scoreAspectFn: () => 1,
  });

  await assert.rejects(
    () =>
      lane.scoreAspect({
        subjectId: "subj.a",
        deviceId: "dev.a",
        turnId: "t1",
        aspect: "mastery_math",
      }),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.forbidden_domain",
  );

  await assert.rejects(
    () =>
      lane.scoreAspect({
        subjectId: "subj.a",
        deviceId: "dev.a",
        turnId: "t1",
        aspect: "schema_validity",
      }),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.forbidden_domain",
  );
});

test("edge: subject isolation + concurrent same-subject + idempotent replay", async () => {
  const events = [];
  let calls = 0;
  const lane = createIsolatedLlmJudgeLane({
    judgeModelId: "judge.tone.local-v1",
    judgePromptVersion: "prompt.tone.1.0.0",
    expectedSubjectId: "subj.locked",
    scoreAspectFn: ({ aspect }) => {
      calls += 1;
      return aspect === "tone" ? 0.1 : 0.2;
    },
    onTelemetry: (e) => events.push(e),
  });

  await assert.rejects(
    () =>
      lane.scoreAspect({
        subjectId: "subj.other",
        deviceId: "dev.x",
        turnId: "t-cross",
        aspect: "tone",
      }),
    (err) =>
      err instanceof LlmJudgePolicyContractError &&
      err.obligation === "llm_judge.subject_scope",
  );

  const [a, b] = await Promise.all([
    lane.scoreAspect({
      subjectId: "subj.locked",
      deviceId: "dev.x",
      turnId: "t-concurrent",
      aspect: "tone",
    }),
    lane.scoreAspect({
      subjectId: "subj.locked",
      deviceId: "dev.x",
      turnId: "t-concurrent",
      aspect: "clarity",
    }),
  ]);
  assert.equal(a.aspect, "tone");
  assert.equal(b.aspect, "clarity");
  assert.equal(calls, 2);

  const replay = await lane.scoreAspect({
    subjectId: "subj.locked",
    deviceId: "dev.x",
    turnId: "t-concurrent",
    aspect: "tone",
  });
  assert.equal(replay.score, a.score);
  assert.equal(calls, 2); // idempotent — no second scorer call
  assert.ok(events.some((e) => e.idempotentReplay === true));
});
