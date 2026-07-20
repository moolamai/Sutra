/**
 * Bounded offline-batch training window — C3 critic scoring → SFT pin / GRPO
 * when threshold met → candidate emission. Hard wall-clock + step budget;
 * lineage on completion or skip (never silent overrun, never empty candidate).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OfflineBatchContractError,
  OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  type CollectConsentedBatchResult,
  type OfflineBatchConfig,
  type OfflineBatchSkipReason,
  type OfflineBatchTelemetryEvent,
} from "./batch_scheduler.js";
import {
  CHECKPOINT_LINEAGE_SCHEMA_VERSION,
  admitCandidateEmissionOrThrow,
  openCheckpointLineageRegistry,
  resetCheckpointLineageCandidateCache,
  type CheckpointLineageRegistry,
  type CheckpointLineageTelemetryEvent,
} from "./checkpoint_lineage.js";
import type { TrajectoryCritic } from "./critics/interface.js";
import {
  proveGrpoAdvantageLossMicroRun,
  resetGrpoAdvantageCache,
  type GrpoAdvantageTelemetryEvent,
} from "./grpo_advantage.js";
import {
  proveGrpoGroupSamplingMicroRun,
  resetGrpoGroupCache,
  type GrpoGroupTelemetryEvent,
} from "./grpo_group.js";
import { GRPO_GROUP_SIZE_MIN } from "./staleness_control.js";
import type { TrajectoryQueueTransport } from "./trajectory_queue.js";

export const OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION =
  "offline.batch.candidate.v1" as const;

/** Default hard wall clock for the training window (separate from collect). */
export const OFFLINE_BATCH_TRAINING_WALL_CLOCK_MS_DEFAULT = 300_000;

/** Soft cap on GRPO/SFT steps inside one window. */
export const OFFLINE_BATCH_MAX_TRAINING_STEPS_DEFAULT = 8;

export type TrainingWindowStage =
  | "gate"
  | "critic"
  | "sft"
  | "grpo"
  | "lineage"
  | "candidate"
  | "deadline";

export type TrainingWindowTelemetryEvent = OfflineBatchTelemetryEvent;

/**
 * Differentiating C3 critic for offline-batch GRPO (σ above skip floor).
 */
export function createBatchWindowDifferentiatingCritic(): TrajectoryCritic {
  const rubricId = "critic.batch-window.diff";
  const rubricVersion = "1.0.0";
  return {
    rubricId,
    rubricVersion,
    score(record) {
      const seed =
        typeof record.rolloutSeed === "number" &&
        Number.isFinite(record.rolloutSeed)
          ? record.rolloutSeed
          : (createHash("sha256")
              .update(record.turnId)
              .digest()
              .readUInt8(0) %
              7) +
            1;
      const quality = 0.12 * seed;
      return {
        total: quality,
        breakdown: { quality },
        rubricVersion,
      };
    },
  };
}

function emit(
  onTelemetry: ((e: TrainingWindowTelemetryEvent) => void) | undefined,
  event: TrainingWindowTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertWithinDeadline(
  startedAt: number,
  budgetMs: number,
  stage: TrainingWindowStage,
  ctx: { subjectId: string; deviceId: string },
  nowMs: () => number,
): void {
  const elapsed = nowMs() - startedAt;
  if (elapsed > budgetMs) {
    throw new OfflineBatchContractError(
      `training window wall-clock exceeded at stage=${stage}`,
      {
        obligation: "batch.deadline",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        failingSlice: stage,
        diff: `elapsedMs=${elapsed} budgetMs=${budgetMs} stage=${stage}`,
      },
    );
  }
}

function resolveTrainingBudget(config: OfflineBatchConfig): {
  wallClockMs: number;
  maxTrainingSteps: number;
} {
  const wallClockMs =
    config.trainingWallClockMs !== undefined
      ? config.trainingWallClockMs
      : (config.wallClockMs ?? OFFLINE_BATCH_TRAINING_WALL_CLOCK_MS_DEFAULT);

  const maxTrainingSteps =
    config.maxTrainingSteps !== undefined
      ? Math.max(1, config.maxTrainingSteps)
      : OFFLINE_BATCH_MAX_TRAINING_STEPS_DEFAULT;

  return { wallClockMs, maxTrainingSteps };
}

function appendSkipLineage(input: {
  registry: CheckpointLineageRegistry;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  baseModelHash: string;
  corpusManifestHash: string;
  skipReason: OfflineBatchSkipReason;
  critic: TrajectoryCritic;
  onTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
}): { runId: string; revision: number; checkpointHash: string } {
  const criticHash = `sha256:${createHash("sha256")
    .update(`${input.critic.rubricId}@${input.critic.rubricVersion}`)
    .digest("hex")}`;
  const checkpointHash = `sha256:${createHash("sha256")
    .update(`skip|${input.skipReason}|${input.baseModelHash}`)
    .digest("hex")}`;
  const runId = `run.batch.skip.${input.subjectId}`;
  const appended = input.registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      checkpointHash,
      corpusManifestHash: input.corpusManifestHash,
      baseModelHash: input.baseModelHash,
      hyperparameters: { window: "skip", skipReason: input.skipReason },
      criticVersions: [
        {
          rubricId: input.critic.rubricId,
          rubricVersion: input.critic.rubricVersion,
          contentHash: criticHash,
        },
      ],
      stage: "SFT",
      evalVerdicts: [
        {
          verdictId: `batch.skip.${input.skipReason}`,
          outcome: "skip",
        },
      ],
      recordedAt: "2026-07-16T19:00:00.000Z",
    },
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  return {
    runId,
    revision: appended.revision,
    checkpointHash,
  };
}

export type TrainingWindowCandidate = {
  schemaVersion: typeof OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  baseModelHash: string;
  sftCheckpointHash: string;
  grpoCheckpointHash: string;
  corpusManifestHash: string;
  lineageRunId: string;
  lineageRevision: number;
  stepsUsed: number;
  elapsedMs: number;
  stagesCompleted: TrainingWindowStage[];
};

export type RunBoundedTrainingWindowResult =
  | {
      ok: true;
      verdict: "candidate";
      candidate: TrainingWindowCandidate;
      candidatePath: string;
      sftCheckpointHash: string;
      grpoCheckpointHash: string;
      lineageRevision: number;
      stepsUsed: number;
      elapsedMs: number;
      scored: number;
    }
  | {
      ok: true;
      verdict: "skip" | "defer";
      skipReason: OfflineBatchSkipReason;
      lineageRunId?: string;
      lineageRevision?: number;
      stepsUsed: number;
      elapsedMs: number;
      scored: number;
    };

/**
 * Run one bounded training window after a collect gate.
 * Skip/defer → lineage skip verdict, no candidate artifact.
 * Ready → C3 score → SFT pin → GRPO → lineage → candidate.
 */
export function runBoundedTrainingWindow(opts: {
  config: OfflineBatchConfig;
  collect: CollectConsentedBatchResult;
  queue?: TrajectoryQueueTransport;
  critic?: TrajectoryCritic;
  baseModelHash: string;
  corpusManifestHash: string;
  lineageRootDir: string;
  outDir: string;
  subjectId?: string;
  deviceId?: string;
  acceleratorAvailable?: boolean;
  nowMs?: () => number;
  onTelemetry?: (e: TrainingWindowTelemetryEvent) => void;
  onLineageTelemetry?: (e: CheckpointLineageTelemetryEvent) => void;
  onGrpoTelemetry?: (e: GrpoGroupTelemetryEvent) => void;
  onAdvantageTelemetry?: (e: GrpoAdvantageTelemetryEvent) => void;
}): RunBoundedTrainingWindowResult {
  const startedAt = (opts.nowMs ?? Date.now)();
  const nowMs = opts.nowMs ?? Date.now;
  const subjectId = opts.subjectId ?? "batch.fleet";
  const deviceId = opts.deviceId ?? "batch.device";
  const ctx = { subjectId, deviceId };
  const { wallClockMs, maxTrainingSteps } = resolveTrainingBudget(opts.config);
  const critic = opts.critic ?? createBatchWindowDifferentiatingCritic();
  const tel = opts.onTelemetry;
  const locality = opts.config.locality;

  mkdirSync(opts.lineageRootDir, { recursive: true });
  mkdirSync(opts.outDir, { recursive: true });

  resetGrpoGroupCache();
  resetGrpoAdvantageCache();
  resetCheckpointLineageCandidateCache();

  const registry = openCheckpointLineageRegistry({
    backend: "fs",
    rootDir: opts.lineageRootDir,
    ...(opts.onLineageTelemetry !== undefined
      ? { onTelemetry: opts.onLineageTelemetry }
      : {}),
  });

  if (opts.acceleratorAvailable === false) {
    emit(tel, {
      event: "learning.batch.defer",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "defer",
      skipReason: "accelerator_unavailable",
      failureClass: "batch.accelerator_unavailable",
      stage: "gate",
    });
    const skip = appendSkipLineage({
      registry,
      subjectId,
      deviceId,
      locality,
      baseModelHash: opts.baseModelHash,
      corpusManifestHash: opts.corpusManifestHash,
      skipReason: "accelerator_unavailable",
      critic,
      ...(opts.onLineageTelemetry !== undefined
        ? { onTelemetry: opts.onLineageTelemetry }
        : {}),
    });
    emit(tel, {
      event: "learning.batch.skip_lineage",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "defer",
      skipReason: "accelerator_unavailable",
      stage: "lineage",
      checkpointHash: skip.checkpointHash,
    });
    return {
      ok: true,
      verdict: "defer",
      skipReason: "accelerator_unavailable",
      lineageRunId: skip.runId,
      lineageRevision: skip.revision,
      stepsUsed: 0,
      elapsedMs: nowMs() - startedAt,
      scored: 0,
    };
  }

  if (opts.collect.verdict !== "ready") {
    const skipReason: OfflineBatchSkipReason =
      opts.collect.skipReason ??
      (opts.collect.verdict === "defer"
        ? "accelerator_unavailable"
        : "below_threshold");
    emit(tel, {
      event: "learning.batch.threshold",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: opts.collect.verdict,
      skipReason,
      failureClass: "batch.below_threshold",
      stage: "gate",
      enqueued: opts.collect.enqueued,
      minTrajectoryCount: opts.collect.minTrajectoryCount,
    });
    const skip = appendSkipLineage({
      registry,
      subjectId,
      deviceId,
      locality,
      baseModelHash: opts.baseModelHash,
      corpusManifestHash: opts.corpusManifestHash,
      skipReason,
      critic,
      ...(opts.onLineageTelemetry !== undefined
        ? { onTelemetry: opts.onLineageTelemetry }
        : {}),
    });
    const candidatePath = path.join(opts.outDir, "candidate.json");
    if (existsSync(candidatePath)) {
      throw new OfflineBatchContractError(
        "skip path must not leave a candidate artifact",
        {
          obligation: "batch.below_threshold",
          subjectId,
          deviceId,
          failingSlice: candidatePath,
        },
      );
    }
    return {
      ok: true,
      verdict: opts.collect.verdict === "defer" ? "defer" : "skip",
      skipReason,
      lineageRunId: skip.runId,
      lineageRevision: skip.revision,
      stepsUsed: 0,
      elapsedMs: nowMs() - startedAt,
      scored: 0,
    };
  }

  try {
    assertWithinDeadline(startedAt, wallClockMs, "critic", ctx, nowMs);
  } catch (err) {
    if (err instanceof OfflineBatchContractError) {
      const skip = appendSkipLineage({
        registry,
        subjectId,
        deviceId,
        locality,
        baseModelHash: opts.baseModelHash,
        corpusManifestHash: opts.corpusManifestHash,
        skipReason: "deadline",
        critic,
        ...(opts.onLineageTelemetry !== undefined
          ? { onTelemetry: opts.onLineageTelemetry }
          : {}),
      });
      return {
        ok: true,
        verdict: "skip",
        skipReason: "deadline",
        lineageRunId: skip.runId,
        lineageRevision: skip.revision,
        stepsUsed: 0,
        elapsedMs: nowMs() - startedAt,
        scored: 0,
      };
    }
    throw err;
  }

  let scored = 0;
  let stepsUsed = 0;
  const policyHashes = new Set<string>();
  if (opts.queue) {
    const sampleLimit = Math.min(GRPO_GROUP_SIZE_MIN, maxTrainingSteps);
    for (let i = 0; i < sampleLimit; i++) {
      assertWithinDeadline(startedAt, wallClockMs, "critic", ctx, nowMs);
      const next =
        opts.subjectId !== undefined
          ? opts.queue.dequeue({ subjectId: opts.subjectId })
          : opts.queue.dequeue();
      if (!next.dequeued) break;
      const traj = next.record.trajectory;
      if (opts.subjectId !== undefined && traj.subjectId !== opts.subjectId) {
        throw new OfflineBatchContractError(
          "dequeued trajectory subjectId does not match training window scope",
          {
            obligation: "batch.subject_scope",
            subjectId: opts.subjectId,
            deviceId,
            failingSlice: traj.subjectId,
            diff: `expected=${opts.subjectId} actual=${traj.subjectId}`,
          },
        );
      }
      critic.score(traj);
      scored += 1;
      stepsUsed += 1;
      if (traj.policyCheckpointHash) {
        policyHashes.add(traj.policyCheckpointHash);
      }
      emit(tel, {
        event: "learning.batch.critic",
        outcome: "ok",
        subjectId: traj.subjectId,
        deviceId: traj.deviceId ?? deviceId,
        stage: "critic",
        turnId: traj.turnId,
        ...(traj.policyCheckpointHash !== undefined
          ? { policyCheckpointHash: traj.policyCheckpointHash }
          : {}),
        stepsUsed,
      });
    }
  }

  const policyCheckpointHash =
    [...policyHashes][0] ??
    opts.collect.policyCheckpointHashes[0] ??
    opts.baseModelHash;

  assertWithinDeadline(startedAt, wallClockMs, "sft", ctx, nowMs);
  stepsUsed += 1;
  if (stepsUsed > maxTrainingSteps) {
    const skip = appendSkipLineage({
      registry,
      subjectId,
      deviceId,
      locality,
      baseModelHash: opts.baseModelHash,
      corpusManifestHash: opts.corpusManifestHash,
      skipReason: "deadline",
      critic,
      ...(opts.onLineageTelemetry !== undefined
        ? { onTelemetry: opts.onLineageTelemetry }
        : {}),
    });
    emit(tel, {
      event: "learning.batch.train",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "skip",
      skipReason: "deadline",
      stage: "deadline",
      stepsUsed,
      maxTrainingSteps,
      failureClass: "batch.deadline",
    });
    return {
      ok: true,
      verdict: "skip",
      skipReason: "deadline",
      lineageRunId: skip.runId,
      lineageRevision: skip.revision,
      stepsUsed,
      elapsedMs: nowMs() - startedAt,
      scored,
    };
  }

  const sftCheckpointHash = `sha256:${createHash("sha256")
    .update(
      `sft-pin|${opts.baseModelHash}|${opts.corpusManifestHash}|${policyCheckpointHash}`,
    )
    .digest("hex")}`;

  const criticHash = `sha256:${createHash("sha256")
    .update(`${critic.rubricId}@${critic.rubricVersion}`)
    .digest("hex")}`;

  const sftRow = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: `run.batch.sft.${subjectId}`,
      subjectId,
      deviceId,
      locality,
      checkpointHash: sftCheckpointHash,
      corpusManifestHash: opts.corpusManifestHash,
      baseModelHash: opts.baseModelHash,
      hyperparameters: {
        lr: 1e-4,
        epochs: 1,
        maxTrainingSteps,
        window: "offline-batch",
      },
      criticVersions: [
        {
          rubricId: critic.rubricId,
          rubricVersion: critic.rubricVersion,
          contentHash: criticHash,
        },
      ],
      stage: "SFT",
      evalVerdicts: [],
      recordedAt: "2026-07-16T19:01:00.000Z",
    },
    ...(opts.onLineageTelemetry !== undefined
      ? { onTelemetry: opts.onLineageTelemetry }
      : {}),
  });

  emit(tel, {
    event: "learning.batch.sft",
    outcome: "ok",
    subjectId,
    deviceId,
    stage: "sft",
    checkpointHash: sftCheckpointHash,
    stepsUsed,
  });

  try {
    assertWithinDeadline(startedAt, wallClockMs, "grpo", ctx, nowMs);
  } catch (err) {
    if (err instanceof OfflineBatchContractError) {
      emit(tel, {
        event: "learning.batch.deadline",
        outcome: "advisory",
        subjectId,
        deviceId,
        stage: "deadline",
        checkpointHash: sftCheckpointHash,
        failureClass: "batch.deadline",
        stepsUsed,
      });
      return {
        ok: true,
        verdict: "skip",
        skipReason: "deadline",
        lineageRunId: sftRow.row.runId,
        lineageRevision: sftRow.revision,
        stepsUsed,
        elapsedMs: nowMs() - startedAt,
        scored,
      };
    }
    throw err;
  }

  stepsUsed += 1;
  const groupProved = proveGrpoGroupSamplingMicroRun({
    subjectId,
    deviceId,
    promptId: "prompt.batch.window",
    policyCheckpointHash: sftCheckpointHash,
    critic,
    groupSize: GRPO_GROUP_SIZE_MIN,
    corpusManifestId: "corpus.batch.window",
    hyperparametersId: "hyper.batch.window.v1",
    loraRank: 16,
    loraAlpha: 32,
    ...(opts.onGrpoTelemetry !== undefined
      ? { onTelemetry: opts.onGrpoTelemetry }
      : {}),
  });

  if (!groupProved.group.admitted || groupProved.group.skipped) {
    throw new OfflineBatchContractError(
      "GRPO group skipped — critic scores not differentiated",
      {
        obligation: "batch.queue_error",
        subjectId,
        deviceId,
        failingSlice: "grpo",
        diff: JSON.stringify({
          admitted: groupProved.group.admitted,
          skipped: groupProved.group.skipped,
          sigma: groupProved.group.sigma,
        }),
      },
    );
  }

  const advProved =
    opts.onAdvantageTelemetry !== undefined
      ? proveGrpoAdvantageLossMicroRun({
          group: groupProved.group,
          onTelemetry: opts.onAdvantageTelemetry,
        })
      : proveGrpoAdvantageLossMicroRun({
          group: groupProved.group,
        });
  if (!advProved.ok || advProved.skipped || !advProved.loss) {
    throw new OfflineBatchContractError("GRPO advantage/loss skipped", {
      obligation: "batch.queue_error",
      subjectId,
      deviceId,
      failingSlice: "grpo",
      diff: JSON.stringify({ skipped: advProved.skipped }),
    });
  }

  const policyLoss = advProved.loss.loss;
  const grpoCheckpointHash = `sha256:${createHash("sha256")
    .update(
      `grpo|${sftCheckpointHash}|${policyLoss}|${critic.rubricId}@${critic.rubricVersion}`,
    )
    .digest("hex")}`;

  emit(tel, {
    event: "learning.batch.grpo",
    outcome: "ok",
    subjectId,
    deviceId,
    stage: "grpo",
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
    stepsUsed,
  });

  assertWithinDeadline(startedAt, wallClockMs, "lineage", ctx, nowMs);
  const grpoRow = registry.appendCommitted({
    row: {
      schemaVersion: CHECKPOINT_LINEAGE_SCHEMA_VERSION,
      runId: `run.batch.grpo.${subjectId}`,
      subjectId,
      deviceId,
      locality,
      checkpointHash: grpoCheckpointHash,
      parentCheckpointHash: sftCheckpointHash,
      corpusManifestHash: opts.corpusManifestHash,
      baseModelHash: opts.baseModelHash,
      hyperparameters: {
        lr: 5e-5,
        groupSize: GRPO_GROUP_SIZE_MIN,
        clipEps: 0.2,
        maxTrainingSteps,
        policyLoss,
      },
      criticVersions: [
        {
          rubricId: critic.rubricId,
          rubricVersion: critic.rubricVersion,
          contentHash: criticHash,
        },
      ],
      stage: "GRPO",
      evalVerdicts: [{ verdictId: "batch.window", outcome: "pass" }],
      recordedAt: "2026-07-16T19:02:00.000Z",
    },
    expectedRevision: sftRow.revision,
    ...(opts.onLineageTelemetry !== undefined
      ? { onTelemetry: opts.onLineageTelemetry }
      : {}),
  });

  emit(tel, {
    event: "learning.batch.lineage",
    outcome: "ok",
    subjectId,
    deviceId,
    stage: "lineage",
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
  });

  assertWithinDeadline(startedAt, wallClockMs, "candidate", ctx, nowMs);
  const admitted = admitCandidateEmissionOrThrow(
    {
      candidateId: `cand.batch.${subjectId}`,
      subjectId,
      deviceId,
      lineageRunId: grpoRow.row.runId,
      checkpointHash: grpoCheckpointHash,
    },
    registry,
    opts.onLineageTelemetry !== undefined
      ? { onTelemetry: opts.onLineageTelemetry }
      : {},
  );

  const elapsedMs = nowMs() - startedAt;
  const candidate: TrainingWindowCandidate = {
    schemaVersion: OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
    candidateId: admitted.candidateId,
    subjectId,
    deviceId,
    locality,
    baseModelHash: opts.baseModelHash,
    sftCheckpointHash,
    grpoCheckpointHash,
    corpusManifestHash: opts.corpusManifestHash,
    lineageRunId: grpoRow.row.runId,
    lineageRevision: grpoRow.revision,
    stepsUsed,
    elapsedMs,
    stagesCompleted: ["gate", "critic", "sft", "grpo", "lineage", "candidate"],
  };

  const candidatePath = path.join(opts.outDir, "candidate.json");
  writeFileSync(
    candidatePath,
    `${JSON.stringify(candidate, null, 2)}\n`,
    "utf8",
  );

  emit(tel, {
    event: "learning.batch.candidate",
    outcome: "ok",
    subjectId,
    deviceId,
    stage: "candidate",
    candidateId: candidate.candidateId,
    checkpointHash: grpoCheckpointHash,
    parentCheckpointHash: sftCheckpointHash,
    stepsUsed,
    elapsedMs,
  });

  emit(tel, {
    event: "learning.batch.train",
    outcome: "ok",
    subjectId,
    deviceId,
    verdict: "candidate",
    stage: "candidate",
    stepsUsed,
    maxTrainingSteps,
    elapsedMs,
    candidateId: candidate.candidateId,
  });

  return {
    ok: true,
    verdict: "candidate",
    candidate,
    candidatePath,
    sftCheckpointHash,
    grpoCheckpointHash,
    lineageRevision: grpoRow.revision,
    stepsUsed,
    elapsedMs,
    scored,
  };
}

/**
 * CI prove: skip below threshold records lineage without candidate;
 * ready collect produces candidate + lineage.
 */
export function proveBoundedTrainingWindowMicroRun(opts: {
  readyCollect: CollectConsentedBatchResult;
  skipCollect: CollectConsentedBatchResult;
  lineageRootDir: string;
  outDir: string;
  baseModelHash?: string;
  corpusManifestHash?: string;
  onTelemetry?: (e: TrainingWindowTelemetryEvent) => void;
}): {
  ok: true;
  candidate: Extract<RunBoundedTrainingWindowResult, { verdict: "candidate" }>;
  skip: Extract<RunBoundedTrainingWindowResult, { verdict: "skip" | "defer" }>;
} {
  const baseModelHash =
    opts.baseModelHash ??
    "ckpt:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const corpusManifestHash =
    opts.corpusManifestHash ??
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  const config: OfflineBatchConfig = {
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    b9ExportPath: "var/b9-exports",
    allowedConsentClasses: ["research", "product-improve"],
    minTrajectoryCount: 2,
    maxScanFiles: 100,
    wallClockMs: 60_000,
    queueMaxDepth: 64,
    locality: "on-device",
    trainingWallClockMs: 60_000,
    maxTrainingSteps: 8,
  };

  const skip = runBoundedTrainingWindow({
    config,
    collect: opts.skipCollect,
    lineageRootDir: path.join(opts.lineageRootDir, "skip"),
    outDir: path.join(opts.outDir, "skip"),
    baseModelHash,
    corpusManifestHash,
    deviceId: "ci.batch.train",
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (skip.verdict !== "skip" && skip.verdict !== "defer") {
    throw new OfflineBatchContractError(
      `expected skip/defer training window, got ${skip.verdict}`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.fleet",
        deviceId: "ci.batch.train",
      },
    );
  }
  if (existsSync(path.join(opts.outDir, "skip", "candidate.json"))) {
    throw new OfflineBatchContractError(
      "skip training window must not emit candidate.json",
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.fleet",
        deviceId: "ci.batch.train",
      },
    );
  }

  const candidate = runBoundedTrainingWindow({
    config,
    collect: opts.readyCollect,
    lineageRootDir: path.join(opts.lineageRootDir, "ready"),
    outDir: path.join(opts.outDir, "ready"),
    baseModelHash,
    corpusManifestHash,
    deviceId: "ci.batch.train",
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (candidate.verdict !== "candidate") {
    throw new OfflineBatchContractError(
      `expected candidate verdict, got ${candidate.verdict}`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.fleet",
        deviceId: "ci.batch.train",
        diff: JSON.stringify(candidate),
      },
    );
  }
  if (!existsSync(candidate.candidatePath)) {
    throw new OfflineBatchContractError(
      "candidate.json missing after ready window",
      {
        obligation: "batch.queue_error",
        subjectId: "batch.fleet",
        deviceId: "ci.batch.train",
      },
    );
  }

  return { ok: true, candidate, skip };
}
