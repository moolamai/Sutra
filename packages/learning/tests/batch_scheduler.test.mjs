/**
 * Offline batch collector — B9 export scan, consent filter, threshold gate.
 * Run: pnpm --filter @moolam/learning test (includes this file)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT,
  OfflineBatchContractError,
  collectConsentedTrajectories,
  draftBatchTrajectoryForTests,
  loadOfflineBatchConfigFile,
  parseOfflineBatchConfig,
  proveBatchCollectorMicroRun,
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

function writeTrajectories(dir, records) {
  mkdirSync(dir, { recursive: true });
  for (const r of records) {
    const sub = join(dir, r.subjectId);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `${r.turnId}.json`), `${JSON.stringify(r)}\n`);
  }
}

test("happy path: consented exports enqueue and meet threshold → ready", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-collect-"));
  const exportRoot = join(root, "exports");
  const queueRoot = join(root, "queue");
  const events = [];
  try {
    writeTrajectories(exportRoot, [
      draftBatchTrajectoryForTests({
        subjectId: "subj.batch.a",
        turnId: "turn.1",
        policyCheckpointHash: "ckpt:sha256:aaaa",
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.batch.a",
        turnId: "turn.2",
        policyCheckpointHash: "ckpt:sha256:aaaa",
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.batch.b",
        turnId: "turn.3",
        consent: {
          optedIn: true,
          consentClass: "product-improve",
          recordedAt: "2026-07-16T18:00:00.000Z",
        },
        policyCheckpointHash: "ckpt:sha256:bbbb",
      }),
    ]);

    const config = parseOfflineBatchConfig({
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
      b9ExportPath: exportRoot,
      allowedConsentClasses: ["research", "product-improve"],
      minTrajectoryCount: 3,
      maxScanFiles: 50,
      wallClockMs: 60_000,
      queueMaxDepth: 32,
      locality: "on-device",
    });

    const result = collectConsentedTrajectories({
      config,
      exportRoot,
      queueRootDir: queueRoot,
      queueKeyMaterial: "test-batch-key",
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(result.verdict, "ready");
    assert.equal(result.enqueued, 3);
    assert.equal(result.minTrajectoryCount, 3);
    assert.ok(result.subjectIds.includes("subj.batch.a"));
    assert.ok(events.some((e) => e.event === "learning.batch.collect"));
    assert.ok(events.some((e) => e.event === "learning.batch.enqueue"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: below-threshold collect emits skip, not empty candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-skip-"));
  try {
    const exportRoot = join(root, "exports");
    writeTrajectories(exportRoot, [
      draftBatchTrajectoryForTests({
        subjectId: "subj.batch.a",
        turnId: "turn.only",
      }),
    ]);

    const result = collectConsentedTrajectories({
      config: parseOfflineBatchConfig({
        schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
        b9ExportPath: exportRoot,
        allowedConsentClasses: ["research", "product-improve"],
        minTrajectoryCount: 100,
        maxScanFiles: 50,
        wallClockMs: 60_000,
        queueMaxDepth: 32,
        locality: "on-device",
      }),
      exportRoot,
      queueRootDir: join(root, "queue"),
    });

    assert.equal(result.verdict, "skip");
    assert.equal(result.skipReason, "below_threshold");
    assert.equal(result.enqueued, 1);
    assert.equal(result.minTrajectoryCount, 100);
    assert.ok(!("candidate" in result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge: opt-out / personal filtered; accelerator defer advisory", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-filter-"));
  const events = [];
  try {
    const exportRoot = join(root, "exports");
    writeTrajectories(exportRoot, [
      draftBatchTrajectoryForTests({
        subjectId: "subj.optout",
        turnId: "turn.opt",
        consent: {
          optedIn: false,
          consentClass: "research",
          recordedAt: "2026-07-16T18:00:00.000Z",
        },
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.personal",
        turnId: "turn.pers",
        consent: {
          optedIn: true,
          consentClass: "personal",
          recordedAt: "2026-07-16T18:00:00.000Z",
        },
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.ok",
        turnId: "turn.ok",
      }),
    ]);

    const result = collectConsentedTrajectories({
      config: parseOfflineBatchConfig({
        schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
        b9ExportPath: exportRoot,
        allowedConsentClasses: ["research", "product-improve"],
        minTrajectoryCount: 1,
        maxScanFiles: 50,
        wallClockMs: 60_000,
        queueMaxDepth: 32,
        locality: "on-device",
      }),
      exportRoot,
      queueRootDir: join(root, "queue"),
      onTelemetry: (e) => events.push(e),
    });

    assert.equal(result.verdict, "ready");
    assert.equal(result.enqueued, 1);
    assert.equal(result.filteredOut, 2);
    assert.ok(
      events.some(
        (e) =>
          e.event === "learning.batch.filter" &&
          e.failureClass === "batch.consent_filtered",
      ),
    );

    const defer = collectConsentedTrajectories({
      config: parseOfflineBatchConfig({
        schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
        b9ExportPath: exportRoot,
        allowedConsentClasses: ["research", "product-improve"],
        minTrajectoryCount: 1,
        maxScanFiles: 50,
        wallClockMs: 60_000,
        queueMaxDepth: 32,
        locality: "on-device",
      }),
      exportRoot,
      acceleratorAvailable: false,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(defer.verdict, "defer");
    assert.equal(defer.skipReason, "accelerator_unavailable");
    assert.equal(defer.enqueued, 0);
    assert.ok(events.some((e) => e.event === "learning.batch.defer"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sovereignty: subjectId scope filters cross-subject exports", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-scope-"));
  try {
    const exportRoot = join(root, "exports");
    writeTrajectories(exportRoot, [
      draftBatchTrajectoryForTests({
        subjectId: "subj.keep",
        turnId: "turn.keep",
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.other",
        turnId: "turn.other",
      }),
    ]);

    const result = collectConsentedTrajectories({
      config: parseOfflineBatchConfig({
        schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
        b9ExportPath: exportRoot,
        allowedConsentClasses: ["research"],
        minTrajectoryCount: 1,
        maxScanFiles: 50,
        wallClockMs: 60_000,
        queueMaxDepth: 32,
        locality: "on-device",
      }),
      exportRoot,
      queueRootDir: join(root, "queue"),
      subjectId: "subj.keep",
    });

    assert.equal(result.verdict, "ready");
    assert.equal(result.enqueued, 1);
    assert.deepEqual(result.subjectIds, ["subj.keep"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent re-scan does not double-count enqueues", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-idem-"));
  try {
    const exportRoot = join(root, "exports");
    const queueRoot = join(root, "queue");
    writeTrajectories(exportRoot, [
      draftBatchTrajectoryForTests({
        subjectId: "subj.idem",
        turnId: "turn.idem",
      }),
      draftBatchTrajectoryForTests({
        subjectId: "subj.idem",
        turnId: "turn.idem2",
      }),
    ]);

    const config = parseOfflineBatchConfig({
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
      b9ExportPath: exportRoot,
      allowedConsentClasses: ["research"],
      minTrajectoryCount: 2,
      maxScanFiles: 50,
      wallClockMs: 60_000,
      queueMaxDepth: 32,
      locality: "on-device",
    });

    const first = collectConsentedTrajectories({
      config,
      exportRoot,
      queueRootDir: queueRoot,
      queueKeyMaterial: "idem-key",
    });
    const second = collectConsentedTrajectories({
      config,
      exportRoot,
      queueRootDir: queueRoot,
      queueKeyMaterial: "idem-key",
    });

    assert.equal(first.verdict, "ready");
    assert.equal(first.enqueued, 2);
    assert.equal(second.enqueued, 0);
    assert.equal(second.queueDepth, 2);
    assert.equal(second.verdict, "skip");
    assert.equal(second.skipReason, "below_threshold");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed batch_config.json loads with hundreds-class threshold", () => {
  const cfg = loadOfflineBatchConfigFile(PIPELINE_CONFIG);
  assert.equal(cfg.schemaVersion, OFFLINE_BATCH_CONFIG_SCHEMA_VERSION);
  assert.equal(
    cfg.minTrajectoryCount,
    OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT,
  );
  assert.ok(cfg.allowedConsentClasses.includes("research"));
  assert.equal(cfg.locality, "on-device");

  const raw = JSON.parse(readFileSync(PIPELINE_CONFIG, "utf8"));
  assert.throws(
    () => parseOfflineBatchConfig({ ...raw, schemaVersion: "nope" }),
    (err) =>
      err instanceof OfflineBatchContractError &&
      err.obligation === "batch.config_invalid",
  );
});

test("prove gate: ready + skip + defer", () => {
  const root = mkdtempSync(join(tmpdir(), "batch-prove-"));
  try {
    const proved = proveBatchCollectorMicroRun({
      exportRoot: join(root, "exports"),
      queueRootDir: join(root, "queue"),
      writeExports: (dir) => {
        writeTrajectories(dir, [
          draftBatchTrajectoryForTests({
            subjectId: "subj.prove",
            turnId: "t1",
          }),
          draftBatchTrajectoryForTests({
            subjectId: "subj.prove",
            turnId: "t2",
          }),
          draftBatchTrajectoryForTests({
            subjectId: "subj.prove",
            turnId: "t3",
          }),
        ]);
      },
    });
    assert.equal(proved.ok, true);
    assert.equal(proved.ready.verdict, "ready");
    assert.equal(proved.skip.verdict, "skip");
    assert.equal(proved.defer.verdict, "defer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
