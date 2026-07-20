/**
 * GRPO group sampling from gym rollouts + C3 critic scores (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GRPO_GROUP_SIZE_MAX,
  GRPO_GROUP_SIZE_MIN,
  GrpoGroupContractError,
  assembleGrpoGroup,
  createCriticScore,
  proveGrpoGroupSamplingMicroRun,
  resetGrpoGroupCache,
  sampleGrpoGroupFromRollouts,
} from "../dist/index.js";

const CKPT = "ckpt:sha256:grpotrain01234567";
const PROMPT = "prompt.ratios.g6";

function traj(turnId, subjectId = "subj.grpo.01") {
  return {
    schemaVersion: "trajectory.v1",
    subjectId,
    sessionId: "sess.grpo.01",
    turnId,
    deviceId: "dev.grpo.01",
    capturedAt: "2026-07-16T12:00:00.000Z",
    locality: "on-device",
    consent: {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T12:00:00.000Z",
    },
    stages: [{ stage: "act", opCode: "tool.write", status: "ok" }],
    policyCheckpointHash: CKPT,
    rolloutSeed: Number(String(turnId).replace(/\D/g, "") || 1),
  };
}

/** Deterministic critic: reward = rolloutSeed (spread) or constant (identical). */
function makeCritic(mode = "spread") {
  return {
    rubricId: "critic.grpo-micro",
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

function candidates(n, opts = {}) {
  const subjectId = opts.subjectId ?? "subj.grpo.01";
  const promptId = opts.promptId ?? PROMPT;
  const policy = opts.policyCheckpointHash ?? CKPT;
  return Array.from({ length: n }, (_, i) => {
    const trajectoryId = `traj.${i + 1}`;
    const trajectory = traj(trajectoryId, subjectId);
    if (opts.policyCheckpointHash) {
      trajectory.policyCheckpointHash = policy;
    }
    return {
      subjectId,
      deviceId: "dev.grpo.01",
      promptId,
      trajectoryId,
      policyCheckpointHash: policy,
      trajectory,
    };
  });
}

test("happy path: G=4 sample + score + assemble with shared promptId and lineage", () => {
  resetGrpoGroupCache();
  const events = [];
  const proved = proveGrpoGroupSamplingMicroRun({
    subjectId: "subj.grpo.01",
    deviceId: "dev.grpo.01",
    promptId: PROMPT,
    policyCheckpointHash: CKPT,
    critic: makeCritic("spread"),
    groupSize: GRPO_GROUP_SIZE_MIN,
    loraRank: 16,
    loraAlpha: 32,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.group.admitted, true);
  assert.equal(proved.group.skipped, false);
  assert.equal(proved.group.groupSize, 4);
  assert.equal(proved.group.promptId, PROMPT);
  assert.equal(proved.group.policyCheckpointHash, CKPT);
  assert.equal(proved.group.lineage.loraRank, 16);
  assert.equal(proved.group.lineage.criticRubricVersion, "1.0.0");
  assert.ok(proved.group.sigma >= 1e-6);
  assert.ok(events.some((e) => e.event === "learning.grpo.group_sample"));
  assert.ok(events.some((e) => e.event === "learning.grpo.critic_score"));
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: identical critic scores → σ skip (no divide-by-near-zero)", () => {
  resetGrpoGroupCache();
  const events = [];
  const proved = proveGrpoGroupSamplingMicroRun({
    subjectId: "subj.grpo.01",
    deviceId: "dev.grpo.01",
    promptId: PROMPT,
    policyCheckpointHash: CKPT,
    critic: makeCritic("identical"),
    groupSize: 4,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.group.admitted, false);
  assert.equal(proved.group.skipped, true);
  assert.equal(proved.group.failureClass, "grpo.sigma_skip");
  assert.ok(proved.group.sigma < 1e-6);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.grpo.group_skip" &&
        e.failureClass === "grpo.sigma_skip",
    ),
  );
});

test("edge: mixed critic rubric versions refused", () => {
  resetGrpoGroupCache();
  const scored = candidates(4).map((c, i) => ({
    ...c,
    score: createCriticScore(
      { seed_reward: i + 1 },
      i === 2 ? "2.0.0" : "1.0.0",
    ),
    reward: i + 1,
  }));

  assert.throws(
    () =>
      assembleGrpoGroup({
        candidates: scored,
        criticRubricId: "critic.grpo-micro",
        criticRubricVersion: "1.0.0",
        lineage: {
          corpusManifestId: "corpus.grpo.micro.v1",
          baseCheckpointHash: CKPT,
        },
      }),
    (err) =>
      err instanceof GrpoGroupContractError &&
      err.obligation === "grpo.mixed_critic_version",
  );
});

test("edge: G outside [4,8] and prompt mismatch rejected", () => {
  resetGrpoGroupCache();
  assert.throws(
    () =>
      sampleGrpoGroupFromRollouts({
        candidates: candidates(3),
        critic: makeCritic("spread"),
        lineage: {
          corpusManifestId: "corpus.grpo.micro.v1",
          baseCheckpointHash: CKPT,
        },
      }),
    (err) =>
      err instanceof GrpoGroupContractError &&
      err.obligation === "grpo.group_size",
  );

  assert.throws(
    () =>
      sampleGrpoGroupFromRollouts({
        candidates: candidates(GRPO_GROUP_SIZE_MAX + 1),
        critic: makeCritic("spread"),
        lineage: {
          corpusManifestId: "corpus.grpo.micro.v1",
          baseCheckpointHash: CKPT,
        },
      }),
    (err) =>
      err instanceof GrpoGroupContractError &&
      err.obligation === "grpo.group_size",
  );

  const mixedPrompt = candidates(4);
  mixedPrompt[1].promptId = "prompt.other";
  assert.throws(
    () =>
      sampleGrpoGroupFromRollouts({
        candidates: mixedPrompt,
        critic: makeCritic("spread"),
        lineage: {
          corpusManifestId: "corpus.grpo.micro.v1",
          baseCheckpointHash: CKPT,
        },
      }),
    (err) =>
      err instanceof GrpoGroupContractError &&
      err.obligation === "grpo.prompt_mismatch",
  );
});

test("sovereignty: cross-subject group refused", () => {
  resetGrpoGroupCache();
  const group = candidates(4);
  group[2].subjectId = "subj.other";
  group[2].trajectory = traj("traj.3", "subj.other");

  assert.throws(
    () =>
      sampleGrpoGroupFromRollouts({
        candidates: group,
        critic: makeCritic("spread"),
        lineage: {
          corpusManifestId: "corpus.grpo.micro.v1",
          baseCheckpointHash: CKPT,
        },
      }),
    (err) =>
      err instanceof GrpoGroupContractError &&
      err.obligation === "grpo.subject_scope",
  );
});

test("idempotent: groupId replay returns same decision", () => {
  resetGrpoGroupCache();
  const events = [];
  const input = {
    candidates: candidates(4),
    critic: makeCritic("spread"),
    lineage: {
      corpusManifestId: "corpus.grpo.micro.v1",
      baseCheckpointHash: CKPT,
    },
    groupId: "group.idem.grpo.01",
    onTelemetry: (e) => events.push(e),
  };
  const a = sampleGrpoGroupFromRollouts(input);
  const b = sampleGrpoGroupFromRollouts(input);
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  assert.equal(a.promptId, b.promptId);
  assert.ok(events.some((e) => e.idempotentReplay === true));
});
