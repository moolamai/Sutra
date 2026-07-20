/**
 * Importance-ratio + clip-band staleness control (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GRPO_SIGMA_EPSILON,
  STALENESS_CLIP_BAND_HIGH,
  STALENESS_CLIP_BAND_LOW,
  STALENESS_EPSILON,
  ImportanceRatioContractError,
  StalenessControlContractError,
  computeBatchMeanImportanceRatio,
  computeImportanceRatio,
  discardPartialStalenessBatch,
  filterBatchByImportanceRatioClipBand,
  isMeanRatioInsideClipBand,
  resetStalenessClipBandCache,
  shouldSkipGrpoGroupNearZeroSigma,
} from "../dist/index.js";

const ROLLOUT = "ckpt:sha256:rollout0123456789";
const TRAIN = "ckpt:sha256:train0123456789ab";

function sample(overrides = {}) {
  return {
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
    trajectoryId: "traj.01",
    rolloutPolicyHash: ROLLOUT,
    trainPolicyHash: TRAIN,
    piTrain: 0.4,
    piRollout: 0.4,
    ...overrides,
  };
}

test("happy path: ratio + batch mean inside clip band admits", () => {
  resetStalenessClipBandCache();
  const events = [];
  const ratio = computeImportanceRatio(0.45, 0.5);
  assert.equal(ratio, 0.9);
  assert.equal(isMeanRatioInsideClipBand(0.9), true);
  assert.equal(STALENESS_CLIP_BAND_LOW, 0.8);
  assert.equal(STALENESS_CLIP_BAND_HIGH, 1.2);
  assert.equal(STALENESS_EPSILON, 0.2);

  const report = computeBatchMeanImportanceRatio([
    sample({ trajectoryId: "t1", piTrain: 0.45, piRollout: 0.5 }),
    sample({ trajectoryId: "t2", piTrain: 0.5, piRollout: 0.5 }),
  ]);
  assert.ok(report.meanRatio > 0.8 && report.meanRatio < 1.2);

  const result = filterBatchByImportanceRatioClipBand({
    samples: [
      sample({ trajectoryId: "t1", piTrain: 0.45, piRollout: 0.5 }),
      sample({ trajectoryId: "t2", piTrain: 0.5, piRollout: 0.5 }),
    ],
    trainerPolicyHash: TRAIN,
    batchId: "batch.admit.01",
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.admitted, true);
  assert.equal(result.dropped, false);
  assert.equal(result.rolloutPolicyHash, ROLLOUT);
  assert.equal(result.trainPolicyHash, TRAIN);
  assert.ok(events.some((e) => e.event === "learning.staleness.clip_band"));
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: mean ratio outside (0.8, 1.2) drops batch with policy hashes", () => {
  resetStalenessClipBandCache();
  const events = [];
  const result = filterBatchByImportanceRatioClipBand({
    samples: [
      sample({ trajectoryId: "t1", piTrain: 0.9, piRollout: 0.3 }),
      sample({ trajectoryId: "t2", piTrain: 0.95, piRollout: 0.3 }),
    ],
    trainerPolicyHash: TRAIN,
    batchId: "batch.drop.01",
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(result.admitted, false);
  assert.equal(result.dropped, true);
  assert.equal(result.failureClass, "staleness.clip_band_drop");
  assert.ok(result.meanRatio >= 1.2 || result.meanRatio <= 0.8);
  assert.equal(result.rolloutPolicyHash, ROLLOUT);
  assert.equal(result.trainPolicyHash, TRAIN);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.staleness.batch_drop" &&
        e.failureClass === "staleness.clip_band_drop" &&
        e.rolloutPolicyHash === ROLLOUT &&
        e.trainPolicyHash === TRAIN,
    ),
  );

  // Idempotent replay
  const replay = filterBatchByImportanceRatioClipBand({
    samples: [
      sample({ trajectoryId: "t1", piTrain: 0.9, piRollout: 0.3 }),
      sample({ trajectoryId: "t2", piTrain: 0.95, piRollout: 0.3 }),
    ],
    trainerPolicyHash: TRAIN,
    batchId: "batch.drop.01",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(replay.dropped, true);
  assert.ok(events.some((e) => e.idempotentReplay === true));
});

test("edge: mixed-policy batch rejected", () => {
  resetStalenessClipBandCache();
  assert.throws(
    () =>
      filterBatchByImportanceRatioClipBand({
        samples: [
          sample({ trajectoryId: "t1" }),
          sample({
            trajectoryId: "t2",
            rolloutPolicyHash: "ckpt:sha256:otherpolicyhash01",
          }),
        ],
        trainerPolicyHash: TRAIN,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.mixed_rollout_policy",
  );
});

test("edge: trainer checkpoint advance mid-batch discards", () => {
  resetStalenessClipBandCache();
  assert.throws(
    () =>
      filterBatchByImportanceRatioClipBand({
        samples: [
          sample({ trajectoryId: "t1", trainPolicyHash: TRAIN }),
          sample({
            trajectoryId: "t2",
            trainPolicyHash: "ckpt:sha256:advancedtrainer01",
          }),
        ],
        trainerPolicyHash: TRAIN,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.trainer_checkpoint_advance",
  );

  const discarded = discardPartialStalenessBatch({
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
    trainerPolicyHash: "ckpt:sha256:advancedtrainer01",
    rolloutPolicyHash: ROLLOUT,
    reason: "trainer_checkpoint_advance",
  });
  assert.equal(discarded.discarded, true);
  assert.equal(
    discarded.failureClass,
    "staleness.trainer_checkpoint_advance",
  );
});

test("edge: GRPO sigma < 1e-6 skip guard", () => {
  const nearZero = shouldSkipGrpoGroupNearZeroSigma([1.0, 1.0, 1.0], {
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
  });
  assert.equal(nearZero.skip, true);
  assert.ok(nearZero.sigma < GRPO_SIGMA_EPSILON);

  const spread = shouldSkipGrpoGroupNearZeroSigma([0.1, 0.5, 0.9], {
    subjectId: "subj.staleness.01",
    deviceId: "dev.staleness.01",
  });
  assert.equal(spread.skip, false);
  assert.ok(spread.sigma >= GRPO_SIGMA_EPSILON);
});

test("sovereignty: cross-subject batch refused", () => {
  resetStalenessClipBandCache();
  assert.throws(
    () =>
      filterBatchByImportanceRatioClipBand({
        samples: [
          sample({ subjectId: "subj.a", trajectoryId: "t1" }),
          sample({ subjectId: "subj.b", trajectoryId: "t2" }),
        ],
        trainerPolicyHash: TRAIN,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.subject_scope",
  );
});

test("contract: zero rollout probability is typed failure", () => {
  assert.throws(
    () => computeImportanceRatio(0.5, 0),
    (err) =>
      err instanceof ImportanceRatioContractError &&
      err.obligation === "staleness.zero_rollout_prob",
  );
});

test("scalability: batch over limit rejected", () => {
  resetStalenessClipBandCache();
  const samples = Array.from({ length: 65 }, (_, i) =>
    sample({ trajectoryId: `traj.${i}` }),
  );
  assert.throws(
    () =>
      filterBatchByImportanceRatioClipBand({
        samples,
        trainerPolicyHash: TRAIN,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.section_limit",
  );
});
