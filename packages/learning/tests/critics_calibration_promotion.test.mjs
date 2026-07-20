/**
 * Critic calibration promotion gate (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CalibrationContractError,
  assertCriticEligibleForTrainingConfig,
  buildTrainingCriticConfigPin,
  createCoreRubricCritic,
  createKnownBadCalibrationCritic,
  loadCalibrationSet,
  loadKnownBadCalibrationRubric,
  proveCalibrationPromotionGate,
  runCriticCalibrationPromotionGate,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("happy path: known-good candidate promotes into training config pin", () => {
  const events = [];
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const critic = createCoreRubricCritic();

  const verdict = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic,
      agreementThreshold: set.manifest.defaultAgreementThreshold,
      surgeryClasses: ["core-rubric"],
    },
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, "promote");
  assert.equal(verdict.trainingConfigAllowed, true);
  assert.deepEqual(verdict.failingSlices, []);
  assert.ok(verdict.agreement.overall.value >= 0.85);

  const pin = buildTrainingCriticConfigPin(verdict);
  assert.equal(pin.calibrated, true);
  assert.equal(pin.rubricId, critic.rubricId);
  assert.equal(pin.schemaVersion, "critic.training-config-pin.v1");

  const eligible = assertCriticEligibleForTrainingConfig(verdict);
  assert.equal(eligible.ok, true);
  assert.ok(
    events.some(
      (e) =>
        e.event === "learning.critic.calibration_promotion" &&
        e.verdict === "promote",
    ),
  );
  assert.equal(
    /utterance|keystroke|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: known-bad rubric fixture fails gate with failing slice named", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const fixture = loadKnownBadCalibrationRubric({ repoRoot: REPO_ROOT });
  const bad = createKnownBadCalibrationCritic(fixture);

  const verdict = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic: bad,
      agreementThreshold: fixture.agreementThreshold,
      surgeryClasses: ["known-bad"],
    },
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.trainingConfigAllowed, false);
  assert.ok(verdict.failingSlices.length >= 1);
  assert.ok(
    verdict.failingSlices.some((s) => s.includes("/") || s === "(overall)"),
  );

  assert.throws(
    () => buildTrainingCriticConfigPin(verdict),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.training_config_blocked" &&
      typeof err.failingSlice === "string",
  );

  assert.throws(
    () => assertCriticEligibleForTrainingConfig(verdict),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.training_config_blocked",
  );
});

test("edge: multi-surgery attribution void; train-on-eval decontam blocks", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const critic = createCoreRubricCritic();

  const multi = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic,
      agreementThreshold: 0.85,
      surgeryClasses: ["core-rubric", "process-reward"],
    },
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.failureClass, "calibration.attribution_void");
  assert.deepEqual(multi.failingSlices, ["(surgery)"]);

  const contaminated = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic,
      agreementThreshold: 0.85,
      surgeryClasses: ["core-rubric"],
    },
    baselineContentHashes: [set.entries[0].contentHash],
  });
  assert.equal(contaminated.ok, false);
  assert.equal(contaminated.failureClass, "calibration.train_on_eval_void");
  assert.ok(typeof contaminated.failingSlices[0] === "string");
});

test("sovereignty + CI prove: champion promotes, known-bad rejects; idempotent", () => {
  const events = [];
  const proved = proveCalibrationPromotionGate({
    repoRoot: REPO_ROOT,
    deviceId: "ci-test",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.champion.verdict, "promote");
  assert.equal(proved.knownBad.verdict, "reject");
  assert.ok(proved.knownBad.failingSlices.length >= 1);
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
  assert.equal(
    /utterance|keystrokeText|rawContent/i.test(JSON.stringify(proved)),
    false,
  );
});
