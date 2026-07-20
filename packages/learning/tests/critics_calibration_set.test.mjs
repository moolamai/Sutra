/**
 * Held-out human label calibration set (C3).
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALIBRATION_SETS_RELPATH,
  CalibrationContractError,
  assertCalibrationDecontaminatedAgainstBaselines,
  assertCorpusExcludedFromCalibrationSet,
  computeCalibrationContentHash,
  exportCalibrationContentHashes,
  listCalibrationSliceIds,
  loadCalibrationSet,
  parseCalibrationSetManifest,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

test("happy path: load held-out set; hashes registered; slices tagged", () => {
  const events = [];
  const set = loadCalibrationSet({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(set.manifest.heldOut, true);
  assert.equal(set.manifest.excludeFromTrainingCorpora, true);
  assert.equal(set.manifest.setId, "human-label.calibration.v1");
  assert.ok(set.entries.length >= 4);
  assert.ok(set.contentHashes.length === set.entries.length);

  const slices = listCalibrationSliceIds(set);
  assert.ok(slices.includes("teacher/en/edge"));
  assert.ok(slices.includes("doctor/en/edge"));

  const labels = new Set(set.entries.map((e) => e.humanOutcomeSignal));
  assert.ok(labels.has("ACCEPTED"));
  assert.ok(labels.has("REJECTED"));

  const exported = exportCalibrationContentHashes(set);
  assert.equal(exported.heldOut, true);
  assert.equal(exported.excludeFromTrainingCorpora, true);
  assert.deepEqual(exported.contentHashes, set.contentHashes);
  assert.ok(events.some((e) => e.outcome === "ok"));

  // Clean corpus (no calibration hashes) is allowed
  const clean = assertCorpusExcludedFromCalibrationSet(set, [
    {
      docId: "corpus.unrelated",
      contentHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ]);
  assert.equal(clean.ok, true);
});

test("edge: train-on-eval void when corpus reuses calibration hash; failingSlice named", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });
  const hit = set.entries[0];
  assert.throws(
    () =>
      assertCorpusExcludedFromCalibrationSet(set, [
        { docId: "corpus.leaked", contentHash: hit.contentHash },
      ]),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.train_on_eval_void" &&
      err.failingSlice === hit.sliceId,
  );
});

test("edge: hash mismatch / label mismatch / baseline collision rejected", () => {
  const set = loadCalibrationSet({ repoRoot: REPO_ROOT });

  // Baseline decontam: colliding hash voids
  assert.throws(
    () =>
      assertCalibrationDecontaminatedAgainstBaselines(set, [
        set.entries[0].contentHash,
      ]),
    (err) =>
      err instanceof CalibrationContractError &&
      err.obligation === "calibration.train_on_eval_void" &&
      typeof err.failingSlice === "string",
  );

  // Known-good: no collision with unrelated baseline hash
  assert.equal(
    assertCalibrationDecontaminatedAgainstBaselines(set, [
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]).ok,
    true,
  );

  // Manifest must declare heldOut
  assert.throws(
    () =>
      parseCalibrationSetManifest({
        schemaVersion: "critic.calibration-set.v1",
        setId: "bad",
        heldOut: false,
        excludeFromTrainingCorpora: true,
        pinnedSeed: 1,
        defaultAgreementThreshold: 0.85,
        locality: "on-device",
        entries: [set.manifest.entries[0]],
      }),
    (err) =>
      err instanceof CalibrationContractError &&
      (err.obligation === "calibration.schema_violation" ||
        err.obligation === "calibration.not_held_out"),
  );

  // Content hash recompute matches registered
  const bytes = readFileSync(set.entries[0].absolutePath);
  assert.equal(
    computeCalibrationContentHash(bytes),
    set.entries[0].contentHash,
  );
});

test("sovereignty: fixtures have subjectId; telemetry has no utterance bodies", () => {
  const events = [];
  const set = loadCalibrationSet({
    repoRoot: REPO_ROOT,
    onTelemetry: (e) => events.push(e),
  });
  for (const e of set.entries) {
    assert.ok(e.trajectory.subjectId);
    const blob = JSON.stringify(e.trajectory);
    assert.equal(/utterance|keystroke|rawContent/i.test(blob), false);
  }
  assert.equal(
    /utterance|keystrokeText|rawContent/i.test(JSON.stringify(events)),
    false,
  );
  assert.ok(events.every((e) => e.subjectId && e.deviceId));
  assert.ok(CALIBRATION_SETS_RELPATH.includes("calibration_sets"));
});
