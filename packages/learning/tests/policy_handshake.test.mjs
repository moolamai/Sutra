/**
 * Policy-version tagging + rollout ↔ trainer handshake (C4).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GRPO_GROUP_SIZE_MAX,
  GRPO_GROUP_SIZE_MIN,
  StalenessControlContractError,
  TrainerPolicyPublisher,
  handshakeGrpoGroupPolicyVersions,
  provePolicyVersionHandshakeMicroRun,
  resetStalenessClipBandCache,
  stampRolloutPolicyCheckpoint,
} from "../dist/index.js";

const ROLLOUT = "ckpt:sha256:rollout0123456789";
const TRAIN_A = "ckpt:sha256:trainA0123456789";
const TRAIN_B = "ckpt:sha256:trainB0123456789";

function candidates(n, hash = ROLLOUT, subjectId = "subj.handshake.01") {
  return Array.from({ length: n }, (_, i) => ({
    subjectId,
    deviceId: "dev.handshake.01",
    trajectoryId: `traj.${i + 1}`,
    policyCheckpointHash: hash,
  }));
}

test("happy path: stamp + publish + G=4 handshake micro-run with lineage", () => {
  resetStalenessClipBandCache();
  const events = [];
  const stamp = stampRolloutPolicyCheckpoint({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
    trajectoryId: "traj.stamp",
    policyCheckpointHash: ROLLOUT,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(stamp.policyCheckpointHash, ROLLOUT);
  assert.ok(events.some((e) => e.event === "learning.staleness.policy_stamp"));

  const proved = provePolicyVersionHandshakeMicroRun({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
    rolloutPolicyHash: ROLLOUT,
    trainerPolicyHash: TRAIN_A,
    groupSize: GRPO_GROUP_SIZE_MIN,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.handshake.groupSize, 4);
  assert.equal(proved.handshake.rolloutPolicyHash, ROLLOUT);
  assert.equal(proved.handshake.trainerPublishedHash, TRAIN_A);
  assert.equal(proved.lineage.length, 1);
  assert.equal(proved.lineage[0].hash, TRAIN_A);
  assert.equal(proved.clipBand.admitted, true);
  assert.ok(
    events.some((e) => e.event === "learning.staleness.trainer_publish"),
  );
  assert.ok(
    events.some((e) => e.event === "learning.staleness.policy_handshake"),
  );
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: within-group policy hash mismatch rejected", () => {
  resetStalenessClipBandCache();
  const trainer = new TrainerPolicyPublisher({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
  });
  trainer.publish({ hash: TRAIN_A });

  const group = candidates(4);
  group[2].policyCheckpointHash = "ckpt:sha256:otherrollouthash01";

  assert.throws(
    () =>
      handshakeGrpoGroupPolicyVersions({
        candidates: group,
        trainer,
        expectedTrainerHash: TRAIN_A,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.policy_hash_mismatch",
  );
});

test("edge: trainer advance mid-batch discards group; append-only lineage", () => {
  resetStalenessClipBandCache();
  const events = [];
  const trainer = new TrainerPolicyPublisher({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
    onTelemetry: (e) => events.push(e),
  });
  trainer.publish({ hash: TRAIN_A });
  trainer.publish({ hash: TRAIN_B, parentHash: TRAIN_A });
  assert.equal(trainer.current(), TRAIN_B);
  assert.equal(trainer.lineage().length, 2);

  // Fork / wrong parent refused
  assert.throws(
    () => trainer.publish({ hash: "ckpt:sha256:trainC0123456789", parentHash: TRAIN_A }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.lineage_corrupt",
  );

  // Consumer assembled against TRAIN_A but tip advanced to TRAIN_B
  assert.throws(
    () =>
      handshakeGrpoGroupPolicyVersions({
        candidates: candidates(4),
        trainer,
        expectedTrainerHash: TRAIN_A,
        onTelemetry: (e) => events.push(e),
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.trainer_checkpoint_advance",
  );
});

test("edge: G outside [4,8] rejected; floating latest stamp refused", () => {
  resetStalenessClipBandCache();
  const trainer = new TrainerPolicyPublisher({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
  });
  trainer.publish({ hash: TRAIN_A });

  assert.throws(
    () =>
      handshakeGrpoGroupPolicyVersions({
        candidates: candidates(3),
        trainer,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.grpo_group_size",
  );

  assert.throws(
    () =>
      handshakeGrpoGroupPolicyVersions({
        candidates: candidates(GRPO_GROUP_SIZE_MAX + 1),
        trainer,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.grpo_group_size",
  );

  assert.throws(
    () =>
      stampRolloutPolicyCheckpoint({
        subjectId: "subj.handshake.01",
        deviceId: "dev.handshake.01",
        trajectoryId: "traj.latest",
        policyCheckpointHash: "latest",
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.floating_checkpoint",
  );
});

test("sovereignty: cross-subject GRPO group refused", () => {
  resetStalenessClipBandCache();
  const trainer = new TrainerPolicyPublisher({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
  });
  trainer.publish({ hash: TRAIN_A });

  const group = candidates(4);
  group[1].subjectId = "subj.other";

  assert.throws(
    () =>
      handshakeGrpoGroupPolicyVersions({
        candidates: group,
        trainer,
        expectedTrainerHash: TRAIN_A,
      }),
    (err) =>
      err instanceof StalenessControlContractError &&
      err.obligation === "staleness.subject_scope",
  );
});

test("idempotent: re-publish tip + replay handshake groupId", () => {
  resetStalenessClipBandCache();
  const events = [];
  const trainer = new TrainerPolicyPublisher({
    subjectId: "subj.handshake.01",
    deviceId: "dev.handshake.01",
    onTelemetry: (e) => events.push(e),
  });
  const first = trainer.publish({ hash: TRAIN_A });
  const again = trainer.publish({ hash: TRAIN_A });
  assert.equal(again.idempotentReplay, true);
  assert.equal(first.lineageLength, again.lineageLength);

  const hs1 = handshakeGrpoGroupPolicyVersions({
    candidates: candidates(4),
    trainer,
    expectedTrainerHash: TRAIN_A,
    groupId: "group.idem.01",
    onTelemetry: (e) => events.push(e),
  });
  const hs2 = handshakeGrpoGroupPolicyVersions({
    candidates: candidates(4),
    trainer,
    expectedTrainerHash: TRAIN_A,
    groupId: "group.idem.01",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(hs1.rolloutPolicyHash, hs2.rolloutPolicyHash);
  assert.ok(events.some((e) => e.idempotentReplay === true));
});
