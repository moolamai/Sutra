/**
 * End-to-end offline batch mode on synthetic consented fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
  OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION,
  OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT,
  loadOfflineBatchConfigFile,
  loadOfflineBatchE2EFixtureManifest,
  proveOfflineBatchModeE2E,
  runOfflineBatchModeE2E,
} from "../../../../packages/learning/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");
const PIPELINE_CONFIG = join(__dirname, "..", "..", "batch_config.json");

test("happy path: synthetic ready fixtures → candidate with lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-e2e-ready-"));
  const events = [];
  try {
    const manifest = loadOfflineBatchE2EFixtureManifest(FIXTURES);
    assert.equal(
      manifest.schemaVersion,
      OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION,
    );

    const ran = runOfflineBatchModeE2E({
      exportRoot: join(FIXTURES, manifest.readyExportRel),
      workDir: root,
      minTrajectoryCount: manifest.ciMinTrajectoryCount,
      deviceId: "dev.batch.e2e",
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(ran.collect.verdict, "ready");
    assert.equal(ran.collect.enqueued, manifest.readyConsentedExpected);
    assert.ok(ran.collect.filteredOut >= manifest.readyFilteredOptOutExpected);
    assert.equal(ran.train.verdict, "candidate");
    assert.equal(
      ran.train.candidate.schemaVersion,
      OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
    );
    assert.ok(existsSync(ran.train.candidatePath));
    assert.ok(ran.train.lineageRevision >= 2);
    assert.match(ran.train.grpoCheckpointHash, /^sha256:/);
    assert.equal(ran.train.candidate.locality, "on-device");
    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.batch.candidate" ||
          e.event === "learning.batch.train",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: below-threshold fixture emits skip, no candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-e2e-skip-"));
  try {
    const manifest = loadOfflineBatchE2EFixtureManifest(FIXTURES);
    const ran = runOfflineBatchModeE2E({
      exportRoot: join(FIXTURES, manifest.belowThresholdExportRel),
      workDir: root,
      minTrajectoryCount: manifest.ciMinTrajectoryCount,
      deviceId: "dev.batch.e2e",
    });

    assert.equal(ran.collect.verdict, "skip");
    assert.equal(ran.collect.skipReason, "below_threshold");
    assert.equal(ran.train.verdict, "skip");
    assert.equal(ran.train.skipReason, "below_threshold");
    assert.ok(ran.train.lineageRunId);
    assert.equal(existsSync(join(root, "out", "candidate.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: accelerator unavailable defers without candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-e2e-defer-"));
  try {
    const manifest = loadOfflineBatchE2EFixtureManifest(FIXTURES);
    const ran = runOfflineBatchModeE2E({
      exportRoot: join(FIXTURES, manifest.readyExportRel),
      workDir: root,
      minTrajectoryCount: manifest.ciMinTrajectoryCount,
      acceleratorAvailable: false,
      deviceId: "dev.batch.e2e",
    });

    assert.equal(ran.collect.verdict, "defer");
    assert.equal(ran.train.verdict, "defer");
    assert.equal(ran.train.skipReason, "accelerator_unavailable");
    assert.equal(existsSync(join(root, "out", "candidate.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sovereignty: subject-scoped e2e keeps subjectId on candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-e2e-scope-"));
  try {
    const manifest = loadOfflineBatchE2EFixtureManifest(FIXTURES);
    const ran = runOfflineBatchModeE2E({
      exportRoot: join(FIXTURES, manifest.readyExportRel),
      workDir: root,
      minTrajectoryCount: 1,
      subjectId: "subj.batch.synth",
      deviceId: "dev.batch.e2e",
    });

    assert.equal(ran.collect.verdict, "ready");
    assert.equal(ran.train.verdict, "candidate");
    assert.equal(ran.train.candidate.subjectId, "subj.batch.synth");
    assert.deepEqual(ran.collect.subjectIds, ["subj.batch.synth"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production config remains hundreds-class while e2e uses micro threshold", () => {
  const cfg = loadOfflineBatchConfigFile(PIPELINE_CONFIG);
  const manifest = loadOfflineBatchE2EFixtureManifest(FIXTURES);
  assert.equal(
    cfg.minTrajectoryCount,
    OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT,
  );
  assert.ok(manifest.ciMinTrajectoryCount < cfg.minTrajectoryCount);
  assert.equal(manifest.ciMinTrajectoryCount, 4);
});

test("prove gate: ready candidate + below-threshold skip", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-e2e-prove-"));
  try {
    const proved = proveOfflineBatchModeE2E({
      fixturesRoot: FIXTURES,
      workDir: root,
    });
    assert.equal(proved.ok, true);
    assert.equal(proved.ready.train.verdict, "candidate");
    assert.equal(proved.belowThreshold.train.verdict, "skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
