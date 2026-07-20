/**
 * Bounded offline-batch training window — C3 → SFT/GRPO → candidate / skip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
  loadOfflineBatchConfigFile,
  parseOfflineBatchConfig,
  proveBoundedTrainingWindowMicroRun,
  runBoundedTrainingWindow,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_CONFIG = join(
  __dirname,
  "..",
  "..",
  "..",
  "training",
  "pipeline",
  "batch_config.json",
);

const BASE =
  "ckpt:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CORPUS =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function readyCollect(enqueued = 4) {
  return {
    ok: true,
    verdict: "ready",
    scanned: enqueued,
    filteredOut: 0,
    enqueued,
    queueDepth: enqueued,
    minTrajectoryCount: 2,
    elapsedMs: 1,
    subjectIds: ["subj.batch.a"],
    policyCheckpointHashes: ["ckpt:sha256:policy1"],
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  };
}

function skipCollect() {
  return {
    ok: true,
    verdict: "skip",
    skipReason: "below_threshold",
    scanned: 1,
    filteredOut: 0,
    enqueued: 1,
    queueDepth: 1,
    minTrajectoryCount: 100,
    elapsedMs: 1,
    subjectIds: ["subj.batch.a"],
    policyCheckpointHashes: ["ckpt:sha256:policy1"],
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  };
}

function config(overrides = {}) {
  return parseOfflineBatchConfig({
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    b9ExportPath: "var/b9-exports",
    allowedConsentClasses: ["research", "product-improve"],
    minTrajectoryCount: 2,
    maxScanFiles: 50,
    wallClockMs: 60_000,
    trainingWallClockMs: 60_000,
    maxTrainingSteps: 8,
    queueMaxDepth: 32,
    locality: "on-device",
    ...overrides,
  });
}

test("happy path: ready collect → candidate with lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-"));
  const events = [];
  try {
    const result = runBoundedTrainingWindow({
      config: config(),
      collect: readyCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(result.verdict, "candidate");
    assert.equal(result.candidate.schemaVersion, OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION);
    assert.ok(existsSync(result.candidatePath));
    assert.match(result.grpoCheckpointHash, /^sha256:/);
    assert.ok(result.lineageRevision >= 2);
    assert.ok(events.some((e) => e.event === "learning.batch.sft"));
    assert.ok(events.some((e) => e.event === "learning.batch.grpo"));
    assert.ok(events.some((e) => e.event === "learning.batch.candidate"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: below-threshold skip records lineage, no candidate.json", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-skip-"));
  try {
    const result = runBoundedTrainingWindow({
      config: config(),
      collect: skipCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
    });

    assert.equal(result.verdict, "skip");
    assert.equal(result.skipReason, "below_threshold");
    assert.ok(result.lineageRunId);
    assert.equal(existsSync(join(root, "out", "candidate.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: accelerator unavailable defers with skip lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-defer-"));
  const events = [];
  try {
    const result = runBoundedTrainingWindow({
      config: config(),
      collect: readyCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
      acceleratorAvailable: false,
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(result.verdict, "defer");
    assert.equal(result.skipReason, "accelerator_unavailable");
    assert.equal(existsSync(join(root, "out", "candidate.json")), false);
    assert.ok(events.some((e) => e.event === "learning.batch.defer"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: wall-clock overrun → skip deadline with lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-deadline-"));
  try {
    const cfg = config();
    cfg.trainingWallClockMs = 1;
    let t = 0;
    const result = runBoundedTrainingWindow({
      config: cfg,
      collect: readyCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
      nowMs: () => {
        const cur = t;
        t += 5_000;
        return cur;
      },
    });

    assert.equal(result.verdict, "skip");
    assert.equal(result.skipReason, "deadline");
    assert.ok(result.lineageRunId);
    assert.equal(existsSync(join(root, "out", "candidate.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sovereignty: subject-scoped candidate carries subjectId", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-scope-"));
  try {
    const result = runBoundedTrainingWindow({
      config: config(),
      collect: readyCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
      subjectId: "subj.batch.only",
      deviceId: "dev.batch.only",
    });

    assert.equal(result.verdict, "candidate");
    assert.equal(result.candidate.subjectId, "subj.batch.only");
    assert.equal(result.candidate.deviceId, "dev.batch.only");
    assert.equal(result.candidate.locality, "on-device");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed config includes training window budgets", () => {
  const cfg = loadOfflineBatchConfigFile(PIPELINE_CONFIG);
  assert.equal(cfg.trainingWallClockMs, 300_000);
  assert.equal(cfg.maxTrainingSteps, 8);
  const raw = JSON.parse(readFileSync(PIPELINE_CONFIG, "utf8"));
  assert.ok(raw.trainingWallClockMs);
});

test("prove gate: skip then candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-train-prove-"));
  try {
    const proved = proveBoundedTrainingWindowMicroRun({
      readyCollect: readyCollect(),
      skipCollect: skipCollect(),
      lineageRootDir: join(root, "lineage"),
      outDir: join(root, "out"),
      baseModelHash: BASE,
      corpusManifestHash: CORPUS,
    });
    assert.equal(proved.ok, true);
    assert.equal(proved.candidate.verdict, "candidate");
    assert.equal(proved.skip.verdict, "skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
