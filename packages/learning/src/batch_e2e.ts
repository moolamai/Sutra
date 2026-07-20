/**
 * Offline batch end-to-end prove — synthetic B9 exports → collect → training
 * window → candidate with lineage; below-threshold fixture → skip (no candidate).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  OfflineBatchContractError,
  OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  collectConsentedTrajectories,
  parseOfflineBatchConfig,
  type CollectConsentedBatchResult,
  type OfflineBatchConfig,
  type OfflineBatchTelemetryEvent,
} from "./batch_scheduler.js";
import {
  OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
  runBoundedTrainingWindow,
  type RunBoundedTrainingWindowResult,
  type TrainingWindowTelemetryEvent,
} from "./batch_training_window.js";
import { openLocalEncryptedTrajectoryQueue } from "./trajectory_queue.js";

/** Committed synthetic fixture tree under training/pipeline. */
export const OFFLINE_BATCH_E2E_FIXTURES_RELPATH =
  "training/pipeline/batch_e2e/fixtures" as const;

export const OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION =
  "offline.batch.e2e.fixtures.v1" as const;

export type OfflineBatchE2EFixtureManifest = {
  schemaVersion: typeof OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION;
  setId: string;
  readyExportRel: string;
  belowThresholdExportRel: string;
  ciMinTrajectoryCount: number;
  readyConsentedExpected: number;
  readyFilteredOptOutExpected: number;
  belowThresholdConsentedExpected: number;
  locality: "on-device" | "self-hosted";
};

export function loadOfflineBatchE2EFixtureManifest(
  fixturesRoot: string,
): OfflineBatchE2EFixtureManifest {
  const manifestPath = path.join(fixturesRoot, "set.manifest.json");
  if (!existsSync(manifestPath)) {
    throw new OfflineBatchContractError(
      `missing batch e2e fixture manifest: ${manifestPath}`,
      {
        obligation: "batch.config_invalid",
        subjectId: "batch.e2e",
        deviceId: "ci",
        failingSlice: manifestPath,
      },
    );
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (raw.schemaVersion !== OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION) {
    throw new OfflineBatchContractError(
      "batch e2e fixture manifest schemaVersion mismatch",
      {
        obligation: "batch.config_invalid",
        subjectId: "batch.e2e",
        deviceId: "ci",
        failingSlice: "schemaVersion",
        diff: `expected=${OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION} actual=${String(raw.schemaVersion)}`,
      },
    );
  }
  return raw as OfflineBatchE2EFixtureManifest;
}

function e2eConfig(
  exportRoot: string,
  minTrajectoryCount: number,
  locality: "on-device" | "self-hosted",
): OfflineBatchConfig {
  return parseOfflineBatchConfig({
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    b9ExportPath: exportRoot,
    allowedConsentClasses: ["research", "product-improve"],
    minTrajectoryCount,
    maxScanFiles: 200,
    wallClockMs: 60_000,
    trainingWallClockMs: 60_000,
    maxTrainingSteps: 8,
    queueMaxDepth: 64,
    locality,
  });
}

export type OfflineBatchE2ERunResult = {
  collect: CollectConsentedBatchResult;
  train: RunBoundedTrainingWindowResult;
};

/**
 * Collect consented synthetic exports then run the bounded training window.
 */
export function runOfflineBatchModeE2E(opts: {
  exportRoot: string;
  workDir: string;
  minTrajectoryCount: number;
  locality?: "on-device" | "self-hosted";
  subjectId?: string;
  deviceId?: string;
  acceleratorAvailable?: boolean;
  baseModelHash?: string;
  corpusManifestHash?: string;
  onTelemetry?: (
    e: OfflineBatchTelemetryEvent | TrainingWindowTelemetryEvent,
  ) => void;
}): OfflineBatchE2ERunResult {
  const locality = opts.locality ?? "on-device";
  const deviceId = opts.deviceId ?? "dev.batch.e2e";
  const subjectId = opts.subjectId ?? "batch.e2e";
  const baseModelHash =
    opts.baseModelHash ??
    "ckpt:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const corpusManifestHash =
    opts.corpusManifestHash ??
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  const config = e2eConfig(opts.exportRoot, opts.minTrajectoryCount, locality);
  const queueRootDir = path.join(opts.workDir, "queue");
  const lineageRootDir = path.join(opts.workDir, "lineage");
  const outDir = path.join(opts.workDir, "out");

  const queue = openLocalEncryptedTrajectoryQueue({
    rootDir: queueRootDir,
    keyMaterial: "offline-batch-e2e-v1",
    maxDepth: config.queueMaxDepth,
    consentGate: { allowedConsentClasses: config.allowedConsentClasses },
  });

  const collect = collectConsentedTrajectories({
    config,
    exportRoot: opts.exportRoot,
    queue,
    deviceId,
    ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts.acceleratorAvailable !== undefined
      ? { acceleratorAvailable: opts.acceleratorAvailable }
      : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const train = runBoundedTrainingWindow({
    config,
    collect,
    queue,
    lineageRootDir,
    outDir,
    baseModelHash,
    corpusManifestHash,
    deviceId,
    ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts.acceleratorAvailable !== undefined
      ? { acceleratorAvailable: opts.acceleratorAvailable }
      : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  return { collect, train };
}

/**
 * CI prove against committed synthetic fixtures:
 * ready → candidate + lineage; below-threshold → skip, no candidate.json.
 */
export function proveOfflineBatchModeE2E(opts: {
  fixturesRoot: string;
  workDir: string;
  onTelemetry?: (
    e: OfflineBatchTelemetryEvent | TrainingWindowTelemetryEvent,
  ) => void;
}): {
  ok: true;
  manifest: OfflineBatchE2EFixtureManifest;
  ready: OfflineBatchE2ERunResult;
  belowThreshold: OfflineBatchE2ERunResult;
} {
  const manifest = loadOfflineBatchE2EFixtureManifest(opts.fixturesRoot);
  const readyExport = path.join(opts.fixturesRoot, manifest.readyExportRel);
  const belowExport = path.join(
    opts.fixturesRoot,
    manifest.belowThresholdExportRel,
  );

  if (!existsSync(readyExport) || !existsSync(belowExport)) {
    throw new OfflineBatchContractError(
      "batch e2e fixture export directories missing",
      {
        obligation: "batch.export_missing",
        subjectId: "batch.e2e",
        deviceId: "ci",
        failingSlice: `${manifest.readyExportRel}|${manifest.belowThresholdExportRel}`,
      },
    );
  }

  const events: Array<
    OfflineBatchTelemetryEvent | TrainingWindowTelemetryEvent
  > = [];
  const onTelemetry = (
    e: OfflineBatchTelemetryEvent | TrainingWindowTelemetryEvent,
  ) => {
    events.push(e);
    opts.onTelemetry?.(e);
  };

  const ready = runOfflineBatchModeE2E({
    exportRoot: readyExport,
    workDir: path.join(opts.workDir, "ready"),
    minTrajectoryCount: manifest.ciMinTrajectoryCount,
    locality: manifest.locality,
    deviceId: "ci.batch.e2e",
    onTelemetry,
  });

  if (ready.collect.verdict !== "ready") {
    throw new OfflineBatchContractError(
      `ready fixture collect expected ready, got ${ready.collect.verdict}`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: JSON.stringify(ready.collect),
      },
    );
  }
  if (ready.collect.enqueued !== manifest.readyConsentedExpected) {
    throw new OfflineBatchContractError(
      `ready fixture enqueued count mismatch`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: `expected=${manifest.readyConsentedExpected} actual=${ready.collect.enqueued} filteredOut=${ready.collect.filteredOut}`,
      },
    );
  }
  if (ready.collect.filteredOut < manifest.readyFilteredOptOutExpected) {
    throw new OfflineBatchContractError(
      `ready fixture expected opt-out filter`,
      {
        obligation: "batch.consent_filtered",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: `filteredOut=${ready.collect.filteredOut}`,
      },
    );
  }
  if (ready.train.verdict !== "candidate") {
    throw new OfflineBatchContractError(
      `ready fixture training expected candidate, got ${ready.train.verdict}`,
      {
        obligation: "batch.queue_error",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: JSON.stringify(ready.train),
      },
    );
  }
  if (
    ready.train.candidate.schemaVersion !==
    OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION
  ) {
    throw new OfflineBatchContractError("candidate schemaVersion mismatch", {
      obligation: "batch.config_invalid",
      subjectId: "batch.e2e",
      deviceId: "ci.batch.e2e",
    });
  }
  if (!existsSync(ready.train.candidatePath)) {
    throw new OfflineBatchContractError(
      "ready fixture missing candidate.json",
      {
        obligation: "batch.queue_error",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        failingSlice: ready.train.candidatePath,
      },
    );
  }
  if (ready.train.lineageRevision < 2) {
    throw new OfflineBatchContractError(
      "ready fixture expected SFT+GRPO lineage revisions",
      {
        obligation: "batch.queue_error",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: `lineageRevision=${ready.train.lineageRevision}`,
      },
    );
  }

  const belowThreshold = runOfflineBatchModeE2E({
    exportRoot: belowExport,
    workDir: path.join(opts.workDir, "below"),
    minTrajectoryCount: manifest.ciMinTrajectoryCount,
    locality: manifest.locality,
    deviceId: "ci.batch.e2e",
    onTelemetry,
  });

  if (
    belowThreshold.collect.verdict !== "skip" ||
    belowThreshold.collect.skipReason !== "below_threshold"
  ) {
    throw new OfflineBatchContractError(
      `below-threshold fixture collect expected skip/below_threshold`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: JSON.stringify(belowThreshold.collect),
      },
    );
  }
  if (
    belowThreshold.train.verdict !== "skip" ||
    belowThreshold.train.skipReason !== "below_threshold"
  ) {
    throw new OfflineBatchContractError(
      `below-threshold fixture training expected skip verdict`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        diff: JSON.stringify(belowThreshold.train),
      },
    );
  }
  const skipCandidate = path.join(opts.workDir, "below", "out", "candidate.json");
  if (existsSync(skipCandidate)) {
    throw new OfflineBatchContractError(
      "below-threshold must not emit candidate.json",
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
        failingSlice: skipCandidate,
      },
    );
  }
  if (!belowThreshold.train.lineageRunId) {
    throw new OfflineBatchContractError(
      "below-threshold skip must record lineage",
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.e2e",
        deviceId: "ci.batch.e2e",
      },
    );
  }

  // Observability: collect + train signals present (no raw content).
  if (!events.some((e) => e.event === "learning.batch.collect" || e.event === "learning.batch.threshold")) {
    throw new OfflineBatchContractError("missing batch collect/threshold telemetry", {
      obligation: "batch.config_invalid",
      subjectId: "batch.e2e",
      deviceId: "ci.batch.e2e",
    });
  }

  return { ok: true, manifest, ready, belowThreshold };
}
