/**
 * Mid-train anchor gate — GRPO admission requires completed SFT parent (C4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  GRPO_JOB_SCHEMA_VERSION,
  SFT_ANCHOR_GATE_FIXTURE_DIR,
  SftWarmstartContractError,
  admitGrpoJobOrThrow,
  lintGrpoJobMidTrainAnchor,
  proveMidTrainAnchorGateCi,
  proveSftWarmstartMicroRun,
  resetGrpoAdmitCache,
  resetSftWarmstartCache,
} from "../dist/sft_warmstart.js";
import { CORPUS_PACKAGE_ROOT } from "../dist/build.js";

const FIXTURE_DIR = path.join(CORPUS_PACKAGE_ROOT, SFT_ANCHOR_GATE_FIXTURE_DIR);
const BASE = "ckpt:sha256:sftgatebase012345678";

test("happy path: SFT anchor then GRPO job admitted", () => {
  resetSftWarmstartCache();
  resetGrpoAdmitCache();
  const events = [];
  const warm = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.gate",
    deviceId: "dev.sft.gate",
    baseCheckpointHash: BASE,
  });
  const admitted = lintGrpoJobMidTrainAnchor(
    {
      schemaVersion: GRPO_JOB_SCHEMA_VERSION,
      jobId: "grpo.ok.1",
      subjectId: "subj.sft.gate",
      deviceId: "dev.sft.gate",
      baseCheckpointHash: BASE,
      declaredCorpusManifestHash: warm.corpusManifestHash,
      sftParent: warm.checkpoint,
    },
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(admitted.ok, true);
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.sftParentCheckpointHash, warm.checkpoint.checkpointHash);
  assert.ok(events.some((e) => e.event === "training.sft_warmstart.grpo_admit"));
  assert.ok(events.every((e) => !("content" in e) && !("utterance" in e)));
});

test("edge: unanchored GRPO (null sftParent) rejected", () => {
  resetGrpoAdmitCache();
  const events = [];
  const linted = lintGrpoJobMidTrainAnchor(
    {
      schemaVersion: GRPO_JOB_SCHEMA_VERSION,
      jobId: "grpo.unanchored.1",
      subjectId: "subj.sft.gate",
      deviceId: "dev.sft.gate",
      baseCheckpointHash: BASE,
      declaredCorpusManifestHash:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      sftParent: null,
    },
    { onTelemetry: (e) => events.push(e) },
  );
  assert.equal(linted.ok, false);
  assert.equal(linted.failureClass, "sft.unanchored_grpo");
  assert.ok(
    events.some(
      (e) =>
        e.event === "training.sft_warmstart.grpo_lint" &&
        e.failureClass === "sft.unanchored_grpo",
    ),
  );

  assert.throws(
    () =>
      admitGrpoJobOrThrow({
        schemaVersion: GRPO_JOB_SCHEMA_VERSION,
        jobId: "grpo.unanchored.throw",
        subjectId: "subj.sft.gate",
        deviceId: "dev.sft.gate",
        baseCheckpointHash: BASE,
        declaredCorpusManifestHash:
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sftParent: null,
      }),
    (err) =>
      err instanceof SftWarmstartContractError &&
      err.obligation === "sft.unanchored_grpo",
  );
});

test("edge: corpus hash drift after SFT invalidates GRPO admission", () => {
  resetSftWarmstartCache();
  resetGrpoAdmitCache();
  const warm = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.gate",
    deviceId: "dev.sft.gate",
    baseCheckpointHash: BASE,
  });
  const linted = lintGrpoJobMidTrainAnchor({
    schemaVersion: GRPO_JOB_SCHEMA_VERSION,
    jobId: "grpo.drift.1",
    subjectId: "subj.sft.gate",
    deviceId: "dev.sft.gate",
    baseCheckpointHash: BASE,
    declaredCorpusManifestHash: "sha256:" + "f".repeat(64),
    sftParent: warm.checkpoint,
  });
  assert.equal(linted.ok, false);
  assert.equal(linted.failureClass, "sft.manifest_drift");
});

test("CI fixture: unanchored RL violation rejects; anchored admits", () => {
  resetSftWarmstartCache();
  resetGrpoAdmitCache();
  const proved = proveMidTrainAnchorGateCi({
    fixtureDir: FIXTURE_DIR,
    subjectId: "subj.sft.gate",
    deviceId: "dev.sft.gate",
  });
  assert.equal(proved.ok, true);
  assert.equal(proved.violationRejected, true);
  assert.equal(proved.violationFailureClass, "sft.unanchored_grpo");
  assert.equal(proved.anchoredAdmitted, true);
});

test("sovereignty: cross-subject SFT parent refused", () => {
  resetSftWarmstartCache();
  resetGrpoAdmitCache();
  const warm = proveSftWarmstartMicroRun({
    subjectId: "subj.sft.a",
    deviceId: "dev.sft.gate",
    baseCheckpointHash: BASE,
  });
  assert.throws(
    () =>
      lintGrpoJobMidTrainAnchor({
        schemaVersion: GRPO_JOB_SCHEMA_VERSION,
        jobId: "grpo.xs.1",
        subjectId: "subj.sft.b",
        deviceId: "dev.sft.gate",
        baseCheckpointHash: BASE,
        declaredCorpusManifestHash: warm.corpusManifestHash,
        sftParent: warm.checkpoint,
      }),
    (err) =>
      err instanceof SftWarmstartContractError &&
      err.obligation === "sft.subject_scope",
  );
});
