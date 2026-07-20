/**
 * GRPO group-relative advantage + clipped surrogate loss (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GRPO_CLIP_EPSILON,
  GRPO_GROUP_SIZE_MIN,
  GrpoAdvantageContractError,
  assertNoValueHead,
  clippedSurrogateTerm,
  computeClippedSurrogateLoss,
  computeGroupRelativeAdvantages,
  createCriticScore,
  proveGrpoAdvantageLossMicroRun,
  proveGrpoGroupSamplingMicroRun,
  resetGrpoAdvantageCache,
  resetGrpoGroupCache,
} from "../dist/index.js";

const CKPT = "ckpt:sha256:grpoadv0123456789";
const PROMPT = "prompt.adv.g4";

function makeCritic(mode = "spread") {
  return {
    rubricId: "critic.grpo-adv",
    rubricVersion: "1.0.0",
    score(record) {
      const reward =
        mode === "identical"
          ? 1
          : typeof record.rolloutSeed === "number"
            ? record.rolloutSeed
            : 1;
      return createCriticScore({ seed_reward: reward }, "1.0.0");
    },
  };
}

test("happy path: A_i=(r−μ)/σ + clipped surrogate loss micro-run", () => {
  resetGrpoGroupCache();
  resetGrpoAdvantageCache();
  const events = [];

  const sampled = proveGrpoGroupSamplingMicroRun({
    subjectId: "subj.adv.01",
    deviceId: "dev.adv.01",
    promptId: PROMPT,
    policyCheckpointHash: CKPT,
    critic: makeCritic("spread"),
    groupSize: GRPO_GROUP_SIZE_MIN,
    loraRank: 16,
    loraAlpha: 32,
  });
  assert.equal(sampled.group.admitted, true);

  const proved = proveGrpoAdvantageLossMicroRun({
    group: sampled.group,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.skipped, false);
  assert.equal(proved.advantage.computed, true);
  assert.equal(proved.advantage.valueHead, false);
  assert.equal(proved.advantage.advantages.length, 4);
  assert.ok(proved.advantage.sigma >= 1e-6);
  // Advantages should sum ~0 for standardized group
  const sumA = proved.advantage.advantages.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumA) < 1e-9);
  assert.equal(proved.loss.epsilon, GRPO_CLIP_EPSILON);
  assert.equal(proved.loss.valueHead, false);
  assert.equal(proved.loss.groupSize, 4);
  assert.ok(Number.isFinite(proved.loss.loss));
  assert.equal(proved.lineage.baseCheckpointHash, CKPT);
  assert.ok(events.some((e) => e.event === "learning.grpo.advantage"));
  assert.ok(events.some((e) => e.event === "learning.grpo.surrogate_loss"));
  assert.ok(events.every((e) => e.valueHead === false));
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: identical rewards → σ skip (no divide-by-near-zero)", () => {
  resetGrpoAdvantageCache();
  const events = [];
  const result = computeGroupRelativeAdvantages({
    rewards: [2, 2, 2, 2],
    subjectId: "subj.adv.01",
    deviceId: "dev.adv.01",
    promptId: PROMPT,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.failureClass, "grpo.advantage.sigma_skip");
  assert.ok(result.sigma < 1e-6);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.grpo.advantage_skip" &&
        e.failureClass === "grpo.advantage.sigma_skip",
    ),
  );
});

test("edge: clipped surrogate clamps ratio; value head forbidden", () => {
  resetGrpoAdvantageCache();
  // Positive advantage + high ratio → clip binds
  const high = clippedSurrogateTerm(2.0, 1.0, 0.2);
  assert.equal(high.unclipped, 2.0);
  assert.equal(high.clipped, 1.2);
  assert.equal(high.term, 1.2);

  // Negative advantage + low ratio → clip binds the other way
  const low = clippedSurrogateTerm(0.5, -1.0, 0.2);
  assert.equal(low.unclipped, -0.5);
  assert.equal(low.clipped, -0.8);
  assert.equal(low.term, -0.8);

  assert.throws(
    () =>
      assertNoValueHead(
        { valueHead: { hidden: 64 } },
        { subjectId: "subj.adv.01" },
      ),
    (err) =>
      err instanceof GrpoAdvantageContractError &&
      err.obligation === "grpo.advantage.value_head_forbidden",
  );

  assert.throws(
    () =>
      computeClippedSurrogateLoss({
        ratios: [1, 1, 1, 1],
        advantages: [0.1, -0.1, 0.2, -0.2],
        subjectId: "subj.adv.01",
        deviceId: "dev.adv.01",
        valueLoss: 0.5,
      }),
    (err) =>
      err instanceof GrpoAdvantageContractError &&
      err.obligation === "grpo.advantage.value_head_forbidden",
  );
});

test("sovereignty: subjectId required; cross-subject not silently merged", () => {
  resetGrpoAdvantageCache();
  assert.throws(
    () =>
      computeGroupRelativeAdvantages({
        rewards: [1, 2, 3, 4],
        subjectId: "",
        deviceId: "dev.adv.01",
      }),
    (err) =>
      err instanceof GrpoAdvantageContractError &&
      err.obligation === "grpo.advantage.subject_scope",
  );
});

test("idempotent: lossId replay returns same scalar loss", () => {
  resetGrpoAdvantageCache();
  const events = [];
  const input = {
    ratios: [1.0, 1.1, 0.9, 1.05],
    advantages: [0.5, -0.2, 0.1, -0.4],
    subjectId: "subj.adv.01",
    deviceId: "dev.adv.01",
    promptId: PROMPT,
    lossId: "loss.idem.01",
    onTelemetry: (e) => events.push(e),
  };
  const a = computeClippedSurrogateLoss(input);
  const b = computeClippedSurrogateLoss(input);
  assert.equal(a.loss, b.loss);
  assert.equal(a.meanRatio, b.meanRatio);
  assert.ok(events.some((e) => e.idempotentReplay === true));
});
