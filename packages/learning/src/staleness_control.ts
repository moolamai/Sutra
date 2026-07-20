/**
 * Staleness control — clip-band filter over importance ratios (C4).
 *
 * Batches whose mean ρ = π_train/π_rollout lies outside (1−ε, 1+ε) are
 * dropped (not clipped into the loss). ε defaults to 0.2 → band (0.8, 1.2).
 * Also provides the GRPO near-zero σ skip guard (σ < 1e−6).
 */

import {
  IMPORTANCE_RATIO_BATCH_LIMIT,
  STALENESS_CLIP_BAND_HIGH,
  STALENESS_CLIP_BAND_LOW,
  STALENESS_EPSILON,
  ImportanceRatioContractError,
  assertPolicyCheckpointHash,
  computeBatchMeanImportanceRatio,
  computeImportanceRatio,
  computeTrajectoryImportanceRatio,
  isMeanRatioInsideClipBand,
  type BatchImportanceRatioReport,
  type ImportanceRatioTelemetryEvent,
  type TrajectoryImportanceRatio,
  type TrajectoryImportanceSample,
} from "./importance_ratio.js";
import { TRAJECTORY_ID_LIMIT } from "./trajectory_schema.js";

/** GRPO group advantage skips when reward σ is below this floor. */
export const GRPO_SIGMA_EPSILON = 1e-6;

/** GRPO group size bounds (candidates per prompt). */
export const GRPO_GROUP_SIZE_MIN = 4;
export const GRPO_GROUP_SIZE_MAX = 8;

export const STALENESS_CONTROL_SCHEMA_VERSION =
  "staleness.clip-band.v1" as const;

export const POLICY_HANDSHAKE_SCHEMA_VERSION =
  "staleness.policy-handshake.v1" as const;

export type StalenessFailureClass =
  | "staleness.clip_band_drop"
  | "staleness.mixed_rollout_policy"
  | "staleness.trainer_checkpoint_advance"
  | "staleness.partial_batch_discard"
  | "staleness.subject_scope"
  | "staleness.section_limit"
  | "staleness.empty_batch"
  | "staleness.idempotent_conflict"
  | "staleness.grpo_group_size"
  | "staleness.policy_hash_mismatch"
  | "staleness.lineage_corrupt"
  | "staleness.floating_checkpoint"
  | "staleness.missing_policy_hash";

export type StalenessTelemetryEvent = {
  event:
    | "learning.staleness.clip_band"
    | "learning.staleness.batch_drop"
    | "learning.staleness.grpo_sigma"
    | "learning.staleness.policy_stamp"
    | "learning.staleness.trainer_publish"
    | "learning.staleness.policy_handshake";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  meanRatio?: number;
  epsilon?: number;
  clipLow?: number;
  clipHigh?: number;
  rolloutPolicyHash?: string;
  trainPolicyHash?: string;
  policyCheckpointHash?: string;
  parentHash?: string;
  batchSize?: number;
  groupSize?: number;
  sigma?: number;
  failureClass?: StalenessFailureClass;
  idempotentReplay?: boolean;
};

export class StalenessControlContractError extends Error {
  readonly obligation: StalenessFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: StalenessFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "StalenessControlContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type ClipBandFilterInput = {
  samples: readonly TrajectoryImportanceSample[];
  /** Current trainer checkpoint — mid-batch advance discards partial assembly. */
  trainerPolicyHash: string;
  epsilon?: number;
  subjectId?: string;
  deviceId?: string;
  /** Stable batch id for idempotent drop/admit decisions. */
  batchId?: string;
  onTelemetry?: (
    e: StalenessTelemetryEvent | ImportanceRatioTelemetryEvent,
  ) => void;
};

export type ClipBandAdmitted = {
  admitted: true;
  dropped: false;
  schemaVersion: typeof STALENESS_CONTROL_SCHEMA_VERSION;
  meanRatio: number;
  epsilon: number;
  clipLow: number;
  clipHigh: number;
  rolloutPolicyHash: string;
  trainPolicyHash: string;
  batchSize: number;
  ratios: TrajectoryImportanceRatio[];
  report: BatchImportanceRatioReport;
};

export type ClipBandDropped = {
  admitted: false;
  dropped: true;
  schemaVersion: typeof STALENESS_CONTROL_SCHEMA_VERSION;
  meanRatio: number;
  epsilon: number;
  clipLow: number;
  clipHigh: number;
  rolloutPolicyHash: string;
  trainPolicyHash: string;
  batchSize: number;
  ratios: TrajectoryImportanceRatio[];
  /** Distinct failure class for dropped-batch metrics. */
  failureClass: StalenessFailureClass;
  detail: string;
};

export type ClipBandFilterResult = ClipBandAdmitted | ClipBandDropped;

/** Idempotent decision cache keyed by batchId. */
const clipBandDecisionCache = new Map<string, ClipBandFilterResult>();

/**
 * Assert all samples share one rollout policy hash (mixed-policy GRPO reject).
 */
export function assertUniformRolloutPolicyHash(
  samples: readonly TrajectoryImportanceSample[],
): string {
  if (samples.length === 0) {
    throw new StalenessControlContractError("empty batch", {
      obligation: "staleness.empty_batch",
    });
  }
  const first = samples[0]!.rolloutPolicyHash;
  for (const s of samples) {
    if (s.rolloutPolicyHash !== first) {
      throw new StalenessControlContractError(
        "mixed-policy batch rejected — all trajectories must share the same rollout policy hash",
        {
          obligation: "staleness.mixed_rollout_policy",
          subjectId: s.subjectId,
          deviceId: s.deviceId,
          failingSlice: s.rolloutPolicyHash,
        },
      );
    }
  }
  return first;
}

/**
 * Trainer checkpoint advance mid-batch: any sample whose trainPolicyHash
 * differs from the live trainer hash → discard (do not patch).
 */
export function assertTrainerCheckpointStable(
  samples: readonly TrajectoryImportanceSample[],
  trainerPolicyHash: string,
): void {
  for (const s of samples) {
    if (s.trainPolicyHash !== trainerPolicyHash) {
      throw new StalenessControlContractError(
        "trainer checkpoint advanced mid-batch — partial batch discarded",
        {
          obligation: "staleness.trainer_checkpoint_advance",
          subjectId: s.subjectId,
          deviceId: s.deviceId,
          failingSlice: s.trainPolicyHash,
        },
      );
    }
  }
}

/**
 * Filter a batch by the importance-ratio clip band.
 * Outside (1−ε, 1+ε) → dropped with metrics (policy hashes), never clipped into loss.
 */
export function filterBatchByImportanceRatioClipBand(
  input: ClipBandFilterInput,
): ClipBandFilterResult {
  const epsilon = input.epsilon ?? STALENESS_EPSILON;
  const subjectId = input.subjectId ?? "staleness";
  const deviceId = input.deviceId ?? "ci";
  const clipLow = 1 - epsilon;
  const clipHigh = 1 + epsilon;

  if (input.batchId !== undefined) {
    const cached = clipBandDecisionCache.get(input.batchId);
    if (cached) {
      input.onTelemetry?.({
        event: "learning.staleness.clip_band",
        outcome: cached.admitted ? "ok" : "advisory",
        subjectId,
        deviceId,
        meanRatio: cached.meanRatio,
        epsilon,
        clipLow,
        clipHigh,
        rolloutPolicyHash: cached.rolloutPolicyHash,
        trainPolicyHash: cached.trainPolicyHash,
        batchSize: cached.batchSize,
        idempotentReplay: true,
        ...(cached.admitted
          ? {}
          : { failureClass: cached.failureClass }),
      });
      return cached;
    }
  }

  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    throw new StalenessControlContractError(
      "clip-band filter requires a non-empty batch",
      { obligation: "staleness.empty_batch", subjectId, deviceId },
    );
  }
  if (input.samples.length > IMPORTANCE_RATIO_BATCH_LIMIT) {
    throw new StalenessControlContractError(
      `clip-band batch exceeds ${IMPORTANCE_RATIO_BATCH_LIMIT}`,
      { obligation: "staleness.section_limit", subjectId, deviceId },
    );
  }

  // Subject isolation: every sample must carry subjectId; refuse cross-subject batches.
  for (const s of input.samples) {
    if (!s.subjectId) {
      throw new StalenessControlContractError(
        "subjectId required on every importance sample",
        { obligation: "staleness.subject_scope", deviceId },
      );
    }
  }
  const subjectScope = input.samples[0]!.subjectId;
  for (const s of input.samples) {
    if (s.subjectId !== subjectScope) {
      throw new StalenessControlContractError(
        "cross-subject importance-ratio batch refused",
        {
          obligation: "staleness.subject_scope",
          subjectId: s.subjectId,
          deviceId: s.deviceId,
          failingSlice: s.subjectId,
        },
      );
    }
  }

  const rolloutPolicyHash = assertUniformRolloutPolicyHash(input.samples);
  assertTrainerCheckpointStable(input.samples, input.trainerPolicyHash);

  let report: BatchImportanceRatioReport;
  try {
    report = computeBatchMeanImportanceRatio(input.samples, {
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
  } catch (err) {
    if (err instanceof ImportanceRatioContractError) {
      throw new StalenessControlContractError(err.message, {
        obligation:
          err.obligation === "staleness.empty_batch"
            ? "staleness.empty_batch"
            : "staleness.section_limit",
        ...(err.subjectId !== undefined ? { subjectId: err.subjectId } : {}),
        ...(err.deviceId !== undefined ? { deviceId: err.deviceId } : {}),
        ...(err.failingSlice !== undefined
          ? { failingSlice: err.failingSlice }
          : {}),
      });
    }
    throw err;
  }

  const inside = isMeanRatioInsideClipBand(report.meanRatio, epsilon);

  if (!inside) {
    const dropped: ClipBandDropped = {
      admitted: false,
      dropped: true,
      schemaVersion: STALENESS_CONTROL_SCHEMA_VERSION,
      meanRatio: report.meanRatio,
      epsilon,
      clipLow,
      clipHigh,
      rolloutPolicyHash,
      trainPolicyHash: input.trainerPolicyHash,
      batchSize: report.batchSize,
      ratios: report.ratios,
      failureClass: "staleness.clip_band_drop",
      detail: `mean importance ratio ${report.meanRatio} outside (${clipLow}, ${clipHigh}) — batch dropped`,
    };

    input.onTelemetry?.({
      event: "learning.staleness.batch_drop",
      outcome: "advisory",
      subjectId,
      deviceId,
      meanRatio: dropped.meanRatio,
      epsilon,
      clipLow,
      clipHigh,
      rolloutPolicyHash: dropped.rolloutPolicyHash,
      trainPolicyHash: dropped.trainPolicyHash,
      batchSize: dropped.batchSize,
      failureClass: "staleness.clip_band_drop",
    });

    if (input.batchId !== undefined) {
      clipBandDecisionCache.set(input.batchId, dropped);
      // Bound cache size
      if (clipBandDecisionCache.size > IMPORTANCE_RATIO_BATCH_LIMIT) {
        const first = clipBandDecisionCache.keys().next().value as
          | string
          | undefined;
        if (first !== undefined) clipBandDecisionCache.delete(first);
      }
    }

    return dropped;
  }

  const admitted: ClipBandAdmitted = {
    admitted: true,
    dropped: false,
    schemaVersion: STALENESS_CONTROL_SCHEMA_VERSION,
    meanRatio: report.meanRatio,
    epsilon,
    clipLow,
    clipHigh,
    rolloutPolicyHash,
    trainPolicyHash: input.trainerPolicyHash,
    batchSize: report.batchSize,
    ratios: report.ratios,
    report,
  };

  input.onTelemetry?.({
    event: "learning.staleness.clip_band",
    outcome: "ok",
    subjectId,
    deviceId,
    meanRatio: admitted.meanRatio,
    epsilon,
    clipLow,
    clipHigh,
    rolloutPolicyHash: admitted.rolloutPolicyHash,
    trainPolicyHash: admitted.trainPolicyHash,
    batchSize: admitted.batchSize,
  });

  if (input.batchId !== undefined) {
    clipBandDecisionCache.set(input.batchId, admitted);
    if (clipBandDecisionCache.size > IMPORTANCE_RATIO_BATCH_LIMIT) {
      const first = clipBandDecisionCache.keys().next().value as
        | string
        | undefined;
      if (first !== undefined) clipBandDecisionCache.delete(first);
    }
  }

  return admitted;
}

/**
 * Discard a partial in-flight batch (trainer advance / assembly abort).
 * Typed failure — never silently patched.
 */
export function discardPartialStalenessBatch(opts: {
  subjectId: string;
  deviceId: string;
  trainerPolicyHash: string;
  rolloutPolicyHash?: string;
  reason: "trainer_checkpoint_advance" | "assembly_abort";
  onTelemetry?: (e: StalenessTelemetryEvent) => void;
}): { discarded: true; failureClass: StalenessFailureClass } {
  const failureClass: StalenessFailureClass =
    opts.reason === "trainer_checkpoint_advance"
      ? "staleness.trainer_checkpoint_advance"
      : "staleness.partial_batch_discard";

  opts.onTelemetry?.({
    event: "learning.staleness.batch_drop",
    outcome: "advisory",
    subjectId: opts.subjectId,
    deviceId: opts.deviceId,
    trainPolicyHash: opts.trainerPolicyHash,
    ...(opts.rolloutPolicyHash !== undefined
      ? { rolloutPolicyHash: opts.rolloutPolicyHash }
      : {}),
    failureClass,
  });

  return { discarded: true, failureClass };
}

/**
 * GRPO group advantage skip guard: σ < 1e−6 → skip group (no divide-by-near-zero).
 */
export function shouldSkipGrpoGroupNearZeroSigma(
  rewards: readonly number[],
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: StalenessTelemetryEvent) => void;
  },
): { skip: boolean; sigma: number; mean: number } {
  if (!Array.isArray(rewards) || rewards.length === 0) {
    throw new StalenessControlContractError(
      "GRPO sigma guard requires a non-empty reward group",
      {
        obligation: "staleness.empty_batch",
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      },
    );
  }
  if (rewards.length > IMPORTANCE_RATIO_BATCH_LIMIT) {
    throw new StalenessControlContractError(
      `GRPO reward group exceeds ${IMPORTANCE_RATIO_BATCH_LIMIT}`,
      { obligation: "staleness.section_limit" },
    );
  }

  for (const r of rewards) {
    if (typeof r !== "number" || !Number.isFinite(r)) {
      throw new StalenessControlContractError(
        "GRPO rewards must be finite numbers",
        { obligation: "staleness.section_limit" },
      );
    }
  }

  const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  let variance = 0;
  for (const r of rewards) {
    const d = r - mean;
    variance += d * d;
  }
  variance /= rewards.length;
  const sigma = Math.sqrt(variance);
  const skip = sigma < GRPO_SIGMA_EPSILON;

  opts?.onTelemetry?.({
    event: "learning.staleness.grpo_sigma",
    outcome: skip ? "advisory" : "ok",
    subjectId: opts.subjectId ?? "staleness",
    deviceId: opts.deviceId ?? "ci",
    sigma,
  });

  return { skip, sigma, mean };
}

// ── Policy-version tagging + rollout ↔ trainer handshake ──────────────────

export type RolloutPolicyStamp = {
  subjectId: string;
  deviceId: string;
  trajectoryId: string;
  /** Exact rollout checkpoint — never floating "latest". */
  policyCheckpointHash: string;
  stampedAt: string;
};

/**
 * Rollout worker stamps policyCheckpointHash onto a trajectory candidate.
 * Stale workers must still tag the exact hash they loaded — not "latest".
 */
export function stampRolloutPolicyCheckpoint(input: {
  subjectId: string;
  deviceId: string;
  trajectoryId: string;
  policyCheckpointHash: string;
  stampedAt?: string;
  onTelemetry?: (e: StalenessTelemetryEvent) => void;
}): RolloutPolicyStamp {
  if (!input.subjectId) {
    throw new StalenessControlContractError("subjectId required", {
      obligation: "staleness.subject_scope",
    });
  }
  if (
    !input.trajectoryId ||
    input.trajectoryId.length > TRAJECTORY_ID_LIMIT
  ) {
    throw new StalenessControlContractError("trajectoryId required", {
      obligation: "staleness.section_limit",
      subjectId: input.subjectId,
    });
  }

  let hash: string;
  try {
    hash = assertPolicyCheckpointHash(input.policyCheckpointHash, {
      subjectId: input.subjectId,
      field: "policyCheckpointHash",
    });
  } catch (err) {
    if (err instanceof ImportanceRatioContractError) {
      const obligation: StalenessFailureClass =
        err.obligation === "staleness.floating_checkpoint"
          ? "staleness.floating_checkpoint"
          : "staleness.missing_policy_hash";
      input.onTelemetry?.({
        event: "learning.staleness.policy_stamp",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        failureClass: obligation,
      });
      throw new StalenessControlContractError(err.message, {
        obligation,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
    }
    throw err;
  }

  const stamp: RolloutPolicyStamp = {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    trajectoryId: input.trajectoryId,
    policyCheckpointHash: hash,
    stampedAt: input.stampedAt ?? new Date().toISOString(),
  };

  input.onTelemetry?.({
    event: "learning.staleness.policy_stamp",
    outcome: "ok",
    subjectId: stamp.subjectId,
    deviceId: stamp.deviceId,
    policyCheckpointHash: stamp.policyCheckpointHash,
  });

  return stamp;
}

export type TrainerCheckpointEntry = {
  hash: string;
  parentHash: string | undefined;
  publishedAt: string;
};

export type TrainerPolicyPublication = {
  hash: string;
  parentHash: string | undefined;
  publishedAt: string;
  lineageLength: number;
  idempotentReplay: boolean;
};

/**
 * Append-only trainer checkpoint publisher.
 * A crash must never rewrite history — only append with parent linkage.
 */
export class TrainerPolicyPublisher {
  private readonly entries: TrainerCheckpointEntry[] = [];
  private readonly byHash = new Map<string, TrainerCheckpointEntry>();
  private currentHash: string | undefined;

  constructor(
    private readonly opts?: {
      subjectId?: string;
      deviceId?: string;
      onTelemetry?: (e: StalenessTelemetryEvent) => void;
    },
  ) {}

  current(): string | undefined {
    return this.currentHash;
  }

  lineage(): readonly TrainerCheckpointEntry[] {
    return this.entries.slice();
  }

  /**
   * Publish the trainer's current policy hash.
   * Re-publishing the same tip hash is idempotent; rewriting history is forbidden.
   */
  publish(input: {
    hash: string;
    parentHash?: string;
    publishedAt?: string;
  }): TrainerPolicyPublication {
    const subjectId = this.opts?.subjectId ?? "trainer";
    const deviceId = this.opts?.deviceId ?? "ci";

    let hash: string;
    try {
      hash = assertPolicyCheckpointHash(input.hash, {
        subjectId,
        field: "trainerPolicyHash",
      });
    } catch (err) {
      if (err instanceof ImportanceRatioContractError) {
        const obligation: StalenessFailureClass =
          err.obligation === "staleness.floating_checkpoint"
            ? "staleness.floating_checkpoint"
            : "staleness.missing_policy_hash";
        this.opts?.onTelemetry?.({
          event: "learning.staleness.trainer_publish",
          outcome: "fail",
          subjectId,
          deviceId,
          failureClass: obligation,
        });
        throw new StalenessControlContractError(err.message, {
          obligation,
          subjectId,
          deviceId,
        });
      }
      throw err;
    }

    const existing = this.byHash.get(hash);
    if (existing) {
      // Idempotent tip replay — never mutate the stored entry.
      if (this.currentHash === hash) {
        this.opts?.onTelemetry?.({
          event: "learning.staleness.trainer_publish",
          outcome: "ok",
          subjectId,
          deviceId,
          policyCheckpointHash: hash,
          ...(existing.parentHash !== undefined
            ? { parentHash: existing.parentHash }
            : {}),
          idempotentReplay: true,
        });
        return {
          hash,
          parentHash: existing.parentHash,
          publishedAt: existing.publishedAt,
          lineageLength: this.entries.length,
          idempotentReplay: true,
        };
      }
      this.opts?.onTelemetry?.({
        event: "learning.staleness.trainer_publish",
        outcome: "fail",
        subjectId,
        deviceId,
        policyCheckpointHash: hash,
        failureClass: "staleness.lineage_corrupt",
      });
      throw new StalenessControlContractError(
        "checkpoint lineage is append-only — cannot re-insert an earlier hash as tip",
        {
          obligation: "staleness.lineage_corrupt",
          subjectId,
          deviceId,
          failingSlice: hash,
        },
      );
    }

    if (this.entries.length === 0) {
      if (input.parentHash !== undefined) {
        throw new StalenessControlContractError(
          "genesis trainer publish must not carry parentHash",
          {
            obligation: "staleness.lineage_corrupt",
            subjectId,
            deviceId,
          },
        );
      }
    } else {
      const expectedParent = this.currentHash!;
      if (input.parentHash === undefined) {
        throw new StalenessControlContractError(
          "non-genesis trainer publish requires parentHash",
          {
            obligation: "staleness.lineage_corrupt",
            subjectId,
            deviceId,
          },
        );
      }
      let parent: string;
      try {
        parent = assertPolicyCheckpointHash(input.parentHash, {
          subjectId,
          field: "parentHash",
        });
      } catch (err) {
        if (err instanceof ImportanceRatioContractError) {
          throw new StalenessControlContractError(err.message, {
            obligation: "staleness.lineage_corrupt",
            subjectId,
            deviceId,
          });
        }
        throw err;
      }
      if (parent !== expectedParent) {
        this.opts?.onTelemetry?.({
          event: "learning.staleness.trainer_publish",
          outcome: "fail",
          subjectId,
          deviceId,
          policyCheckpointHash: hash,
          parentHash: parent,
          failureClass: "staleness.lineage_corrupt",
        });
        throw new StalenessControlContractError(
          "parentHash must equal the current trainer tip — lineage fork refused",
          {
            obligation: "staleness.lineage_corrupt",
            subjectId,
            deviceId,
            failingSlice: parent,
          },
        );
      }
    }

    const entry: TrainerCheckpointEntry = {
      hash,
      parentHash: input.parentHash,
      publishedAt: input.publishedAt ?? new Date().toISOString(),
    };
    this.entries.push(entry);
    this.byHash.set(hash, entry);
    this.currentHash = hash;

    // Bound lineage length (NFR — no unbounded growth in-process).
    if (this.entries.length > IMPORTANCE_RATIO_BATCH_LIMIT) {
      const dropped = this.entries.shift()!;
      this.byHash.delete(dropped.hash);
    }

    this.opts?.onTelemetry?.({
      event: "learning.staleness.trainer_publish",
      outcome: "ok",
      subjectId,
      deviceId,
      policyCheckpointHash: hash,
      ...(entry.parentHash !== undefined ? { parentHash: entry.parentHash } : {}),
    });

    return {
      hash,
      parentHash: entry.parentHash,
      publishedAt: entry.publishedAt,
      lineageLength: this.entries.length,
      idempotentReplay: false,
    };
  }
}

export type GrpoGroupCandidate = {
  subjectId: string;
  deviceId: string;
  trajectoryId: string;
  policyCheckpointHash: string;
};

export type PolicyHandshakeResult = {
  ok: true;
  schemaVersion: typeof POLICY_HANDSHAKE_SCHEMA_VERSION;
  groupSize: number;
  subjectId: string;
  deviceId: string;
  rolloutPolicyHash: string;
  trainerPublishedHash: string;
  candidates: RolloutPolicyStamp[];
  lineageLength: number;
};

const handshakeDecisionCache = new Map<string, PolicyHandshakeResult>();

/**
 * Queue consumer handshake: admit a GRPO group only when
 * - G ∈ [4, 8]
 * - all candidates share one subjectId
 * - all candidates share one policyCheckpointHash (reject within-group mismatch)
 * - trainer has published a current hash (lineage tip recorded)
 *
 * Does not rewrite stamps — mismatch → typed reject / discard.
 */
export function handshakeGrpoGroupPolicyVersions(input: {
  candidates: readonly GrpoGroupCandidate[];
  trainer: TrainerPolicyPublisher;
  /** Expected trainer tip at assembly start — mid-advance discards the group. */
  expectedTrainerHash?: string;
  groupId?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: StalenessTelemetryEvent) => void;
}): PolicyHandshakeResult {
  const subjectId = input.subjectId ?? input.candidates[0]?.subjectId ?? "staleness";
  const deviceId = input.deviceId ?? input.candidates[0]?.deviceId ?? "ci";

  if (input.groupId !== undefined) {
    const cached = handshakeDecisionCache.get(input.groupId);
    if (cached) {
      input.onTelemetry?.({
        event: "learning.staleness.policy_handshake",
        outcome: "ok",
        subjectId: cached.subjectId,
        deviceId: cached.deviceId,
        rolloutPolicyHash: cached.rolloutPolicyHash,
        trainPolicyHash: cached.trainerPublishedHash,
        groupSize: cached.groupSize,
        idempotentReplay: true,
      });
      return cached;
    }
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new StalenessControlContractError(
      "GRPO policy handshake requires candidates",
      { obligation: "staleness.empty_batch", subjectId, deviceId },
    );
  }

  const g = input.candidates.length;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    input.onTelemetry?.({
      event: "learning.staleness.policy_handshake",
      outcome: "fail",
      subjectId,
      deviceId,
      groupSize: g,
      failureClass: "staleness.grpo_group_size",
    });
    throw new StalenessControlContractError(
      `GRPO group size must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}] — got ${g}`,
      {
        obligation: "staleness.grpo_group_size",
        subjectId,
        deviceId,
      },
    );
  }

  const trainerHash = input.trainer.current();
  if (!trainerHash) {
    throw new StalenessControlContractError(
      "trainer must publish a policy hash before GRPO group handshake",
      {
        obligation: "staleness.missing_policy_hash",
        subjectId,
        deviceId,
      },
    );
  }

  if (
    input.expectedTrainerHash !== undefined &&
    input.expectedTrainerHash !== trainerHash
  ) {
    input.onTelemetry?.({
      event: "learning.staleness.policy_handshake",
      outcome: "fail",
      subjectId,
      deviceId,
      trainPolicyHash: trainerHash,
      failureClass: "staleness.trainer_checkpoint_advance",
    });
    discardPartialStalenessBatch({
      subjectId,
      deviceId,
      trainerPolicyHash: trainerHash,
      reason: "trainer_checkpoint_advance",
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
    throw new StalenessControlContractError(
      "trainer checkpoint advanced mid-batch — GRPO group discarded",
      {
        obligation: "staleness.trainer_checkpoint_advance",
        subjectId,
        deviceId,
        failingSlice: trainerHash,
      },
    );
  }

  const stamps: RolloutPolicyStamp[] = [];
  for (const c of input.candidates) {
    if (!c.subjectId) {
      throw new StalenessControlContractError(
        "subjectId required on every GRPO candidate",
        { obligation: "staleness.subject_scope", deviceId },
      );
    }
    stamps.push(
      stampRolloutPolicyCheckpoint({
        subjectId: c.subjectId,
        deviceId: c.deviceId,
        trajectoryId: c.trajectoryId,
        policyCheckpointHash: c.policyCheckpointHash,
        ...(input.onTelemetry !== undefined
          ? { onTelemetry: input.onTelemetry }
          : {}),
      }),
    );
  }

  const scopeSubject = stamps[0]!.subjectId;
  for (const s of stamps) {
    if (s.subjectId !== scopeSubject) {
      throw new StalenessControlContractError(
        "cross-subject GRPO group refused",
        {
          obligation: "staleness.subject_scope",
          subjectId: s.subjectId,
          deviceId: s.deviceId,
          failingSlice: s.subjectId,
        },
      );
    }
  }

  const rolloutHash = stamps[0]!.policyCheckpointHash;
  for (const s of stamps) {
    if (s.policyCheckpointHash !== rolloutHash) {
      input.onTelemetry?.({
        event: "learning.staleness.policy_handshake",
        outcome: "fail",
        subjectId: scopeSubject,
        deviceId: s.deviceId,
        rolloutPolicyHash: s.policyCheckpointHash,
        trainPolicyHash: trainerHash,
        groupSize: g,
        failureClass: "staleness.policy_hash_mismatch",
      });
      throw new StalenessControlContractError(
        "hash mismatch within GRPO group — all G candidates must share the same rollout policyCheckpointHash",
        {
          obligation: "staleness.policy_hash_mismatch",
          subjectId: scopeSubject,
          deviceId: s.deviceId,
          failingSlice: s.policyCheckpointHash,
        },
      );
    }
  }

  const result: PolicyHandshakeResult = {
    ok: true,
    schemaVersion: POLICY_HANDSHAKE_SCHEMA_VERSION,
    groupSize: g,
    subjectId: scopeSubject,
    deviceId: stamps[0]!.deviceId,
    rolloutPolicyHash: rolloutHash,
    trainerPublishedHash: trainerHash,
    candidates: stamps,
    lineageLength: input.trainer.lineage().length,
  };

  input.onTelemetry?.({
    event: "learning.staleness.policy_handshake",
    outcome: "ok",
    subjectId: result.subjectId,
    deviceId: result.deviceId,
    rolloutPolicyHash: result.rolloutPolicyHash,
    trainPolicyHash: result.trainerPublishedHash,
    groupSize: result.groupSize,
  });

  if (input.groupId !== undefined) {
    handshakeDecisionCache.set(input.groupId, result);
    if (handshakeDecisionCache.size > IMPORTANCE_RATIO_BATCH_LIMIT) {
      const first = handshakeDecisionCache.keys().next().value as
        | string
        | undefined;
      if (first !== undefined) handshakeDecisionCache.delete(first);
    }
  }

  return result;
}

/**
 * Micro-run: stamp G candidates → trainer publish → handshake → clip-band admit.
 * Records lineage hashes; never carries raw learner content.
 */
export function provePolicyVersionHandshakeMicroRun(input: {
  subjectId: string;
  deviceId: string;
  rolloutPolicyHash: string;
  trainerPolicyHash: string;
  groupSize?: number;
  onTelemetry?: (e: StalenessTelemetryEvent | ImportanceRatioTelemetryEvent) => void;
}): {
  ok: true;
  handshake: PolicyHandshakeResult;
  clipBand: ClipBandFilterResult;
  lineage: readonly TrainerCheckpointEntry[];
} {
  const g = input.groupSize ?? GRPO_GROUP_SIZE_MIN;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    throw new StalenessControlContractError(
      `micro-run groupSize must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}]`,
      { obligation: "staleness.grpo_group_size", subjectId: input.subjectId },
    );
  }

  const trainer = new TrainerPolicyPublisher({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  trainer.publish({ hash: input.trainerPolicyHash });

  const candidates: GrpoGroupCandidate[] = Array.from({ length: g }, (_, i) => ({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    trajectoryId: `traj.micro.${i + 1}`,
    policyCheckpointHash: input.rolloutPolicyHash,
  }));

  const handshake = handshakeGrpoGroupPolicyVersions({
    candidates,
    trainer,
    expectedTrainerHash: input.trainerPolicyHash,
    groupId: `group.micro.${input.subjectId}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  const samples: TrajectoryImportanceSample[] = candidates.map((c, i) => ({
    subjectId: c.subjectId,
    deviceId: c.deviceId,
    trajectoryId: c.trajectoryId,
    rolloutPolicyHash: c.policyCheckpointHash,
    trainPolicyHash: input.trainerPolicyHash,
    // Near-identical likelihoods → mean ρ ≈ 1.0 inside clip band.
    piTrain: 0.5,
    piRollout: 0.5 + (i % 2) * 0.01,
  }));

  const clipBand = filterBatchByImportanceRatioClipBand({
    samples,
    trainerPolicyHash: input.trainerPolicyHash,
    batchId: `batch.micro.${input.subjectId}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  return {
    ok: true,
    handshake,
    clipBand,
    lineage: trainer.lineage(),
  };
}

/** Test helper — clear idempotent clip-band + handshake decision caches. */
export function resetStalenessClipBandCache(): void {
  clipBandDecisionCache.clear();
  handshakeDecisionCache.clear();
}

// Re-export ratio primitives for a single published surface.
export {
  IMPORTANCE_RATIO_BATCH_LIMIT,
  STALENESS_CLIP_BAND_HIGH,
  STALENESS_CLIP_BAND_LOW,
  STALENESS_EPSILON,
  ImportanceRatioContractError,
  assertPolicyCheckpointHash,
  computeBatchMeanImportanceRatio,
  computeImportanceRatio,
  computeTrajectoryImportanceRatio,
  isMeanRatioInsideClipBand,
};
