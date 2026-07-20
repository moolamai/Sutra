/**
 * Critic–human agreement metrics on held-out calibration set (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CalibrationContractError,
  assertCriticHumanAgreementPasses,
  computeCohenKappa,
  computeCriticHumanAgreement,
  createCoreRubricCritic,
  humanOutcomeToBinaryLabel,
  loadCalibrationSet,
  predictCriticLabelsOnCalibrationSet,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function labelsMatchingHuman(set) {
  /** @type {Record<string, "accept" | "reject">} */
  const labels = {};
  for (const e of set.entries) {
    const bin = humanOutcomeToBinaryLabel(e.humanOutcomeSignal);
    if (bin !== null) labels[e.id] = bin;
  }
  return labels;
}

test("happy path: known-good candidate passes; Cohen kappa + per-slice breakdown", () => {
  const events = [];
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const labels = labelsMatchingHuman(set);

  const report = computeCriticHumanAgreement({
    set,
    criticLabels: labels,
    criticId: "critic.oracle-match",
    criticVersion: "1.0.0",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(report.schemaVersion, "critic.calibration-agreement.v1");
  assert.equal(report.metricId, "cohen_kappa");
  assert.equal(report.heldOut, true);
  assert.equal(report.threshold, 0.85);
  assert.equal(report.overall.value, 1);
  assert.equal(report.overall.accuracy, 1);
  assert.equal(report.passes, true);
  assert.deepEqual(report.failingSlices, []);
  assert.ok(report.slices.length >= 2);
  for (const s of report.slices) {
    assert.equal(s.passesThreshold, true);
    assert.ok(s.sliceId.includes("/"));
  }

  const promoted = assertCriticHumanAgreementPasses(report);
  assert.equal(promoted.ok, true);
  assert.ok(events.some((e) => e.event === "learning.critic.calibration_agreement"));
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
  assert.equal(
    /utterance|keystrokeText|rawContent/i.test(JSON.stringify(events)),
    false,
  );
});

test("edge: known-regressed candidate rejected with failing slice named", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const labels = labelsMatchingHuman(set);

  // Flip all doctor-slice predictions → doctor/en/edge fails by name
  for (const e of set.entries) {
    if (e.sliceId === "doctor/en/edge") {
      const bin = humanOutcomeToBinaryLabel(e.humanOutcomeSignal);
      if (bin !== null) {
        labels[e.id] = bin === "accept" ? "reject" : "accept";
      }
    }
  }

  const report = computeCriticHumanAgreement({
    set,
    criticLabels: labels,
    criticId: "critic.regressed",
    criticVersion: "0.0.1",
    threshold: 0.85,
  });

  assert.equal(report.passes, false);
  assert.ok(report.failingSlices.includes("doctor/en/edge"));
  assert.ok(!report.failingSlices.includes("teacher/en/edge"));

  assert.throws(
    () => assertCriticHumanAgreementPasses(report),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.agreement_below_threshold" &&
      err.failingSlice === "doctor/en/edge",
  );
});

test("edge: missing prediction / insufficient pairs / kappa math", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });

  assert.throws(
    () =>
      computeCriticHumanAgreement({
        set,
        criticLabels: {},
        criticId: "critic.empty",
        criticVersion: "1.0.0",
      }),
    (err) =>
      err instanceof CalibrationContractError &&
      (err.obligation === "calibration.missing_prediction" ||
        err.obligation === "calibration.insufficient_pairs") &&
      typeof err.failingSlice === "string",
  );

  assert.throws(
    () => computeCohenKappa([]),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.insufficient_pairs",
  );

  const perfect = computeCohenKappa([
    { human: "accept", critic: "accept" },
    { human: "reject", critic: "reject" },
  ]);
  assert.equal(perfect.kappa, 1);
  assert.equal(perfect.accuracy, 1);

  const chance = computeCohenKappa([
    { human: "accept", critic: "accept" },
    { human: "accept", critic: "reject" },
    { human: "reject", critic: "accept" },
    { human: "reject", critic: "reject" },
  ]);
  assert.equal(chance.kappa, 0);
  assert.equal(chance.accuracy, 0.5);
});

test("sovereignty: core-rubric predictions strip human label; no utterance in report", () => {
  const events = [];
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const critic = createCoreRubricCritic();
  const labels = predictCriticLabelsOnCalibrationSet(set, critic);

  // Structural core rubric (human stripped) should align on this fixture set
  const report = computeCriticHumanAgreement({
    set,
    criticLabels: labels,
    criticId: critic.rubricId,
    criticVersion: critic.rubricVersion,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(report.overall.n, 4); // DISCARDED excluded
  assert.ok(report.overall.value >= 0.85);
  assert.equal(report.passes, true);
  assert.equal(
    /utterance|keystroke|rawContent/i.test(JSON.stringify(report)),
    false,
  );
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
});
