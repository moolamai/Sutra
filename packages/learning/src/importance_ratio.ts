/**
 * Importance-ratio computation for IMPALA-lineage staleness control (C4).
 *
 * ratio = π_train(a|s) / π_rollout(a|s) per trajectory.
 * Batch mean is the clip-band input — batches outside (1−ε, 1+ε) are dropped.
 */

import { TRAJECTORY_HASH_LIMIT, TRAJECTORY_ID_LIMIT } from "./trajectory_schema.js";

/** Default ε for the importance-ratio clip band (1−ε, 1+ε). */
export const STALENESS_EPSILON = 0.2 as const;
export const STALENESS_CLIP_BAND_LOW = 1 - STALENESS_EPSILON; // 0.8
export const STALENESS_CLIP_BAND_HIGH = 1 + STALENESS_EPSILON; // 1.2

/** Soft cap on trajectories per staleness batch (NFR — bounded result sets). */
export const IMPORTANCE_RATIO_BATCH_LIMIT = 64;

export type ImportanceRatioFailureClass =
  | "staleness.invalid_probability"
  | "staleness.zero_rollout_prob"
  | "staleness.non_finite_ratio"
  | "staleness.section_limit"
  | "staleness.missing_policy_hash"
  | "staleness.floating_checkpoint"
  | "staleness.subject_scope"
  | "staleness.empty_batch";

export type ImportanceRatioTelemetryEvent = {
  event: "learning.staleness.importance_ratio";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  ratio?: number;
  meanRatio?: number;
  rolloutPolicyHash?: string;
  trainPolicyHash?: string;
  failureClass?: ImportanceRatioFailureClass;
  batchSize?: number;
};

export class ImportanceRatioContractError extends Error {
  readonly obligation: ImportanceRatioFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: ImportanceRatioFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "ImportanceRatioContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

/**
 * One trajectory's action likelihoods under train vs rollout policies.
 * Probabilities only — never raw utterances / completions.
 */
export type TrajectoryImportanceSample = {
  subjectId: string;
  deviceId: string;
  /** Opaque turn / queue record id. */
  trajectoryId: string;
  /** Exact rollout policy checkpoint hash stamped at capture. */
  rolloutPolicyHash: string;
  /** Trainer policy checkpoint hash used for π_train evaluation. */
  trainPolicyHash: string;
  /** π_train(a|s) — finite and > 0. */
  piTrain: number;
  /** π_rollout(a|s) — finite and > 0. */
  piRollout: number;
};

export type TrajectoryImportanceRatio = {
  subjectId: string;
  deviceId: string;
  trajectoryId: string;
  rolloutPolicyHash: string;
  trainPolicyHash: string;
  ratio: number;
};

function assertOpaquePolicyHash(
  hash: string,
  field: string,
  subjectId?: string,
): void {
  if (typeof hash !== "string" || hash.length === 0) {
    throw new ImportanceRatioContractError(
      `${field} must be an opaque checkpoint hash`,
      {
        obligation: "staleness.missing_policy_hash",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
  if (hash.toLowerCase() === "latest") {
    throw new ImportanceRatioContractError(
      `floating checkpoint 'latest' forbidden on ${field}`,
      {
        obligation: "staleness.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
  if (hash.length < 8 || hash.length > TRAJECTORY_HASH_LIMIT) {
    throw new ImportanceRatioContractError(
      `${field} must be an opaque checkpoint hash`,
      {
        obligation: "staleness.missing_policy_hash",
        ...(subjectId !== undefined ? { subjectId } : {}),
        failingSlice: field,
      },
    );
  }
}

/**
 * Assert opaque policy checkpoint hash (no floating "latest").
 * Shared by importance-ratio samples and rollout/trainer policy tags.
 */
export function assertPolicyCheckpointHash(
  hash: string,
  opts?: { subjectId?: string; field?: string },
): string {
  const field = opts?.field ?? "policyCheckpointHash";
  assertOpaquePolicyHash(hash, field, opts?.subjectId);
  return hash;
}

/**
 * Compute ρ = π_train(a|s) / π_rollout(a|s).
 */
export function computeImportanceRatio(
  piTrain: number,
  piRollout: number,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: ImportanceRatioTelemetryEvent) => void;
  },
): number {
  const subjectId = opts?.subjectId ?? "staleness";
  const deviceId = opts?.deviceId ?? "ci";

  if (
    typeof piTrain !== "number" ||
    typeof piRollout !== "number" ||
    !Number.isFinite(piTrain) ||
    !Number.isFinite(piRollout) ||
    piTrain <= 0 ||
    piRollout < 0
  ) {
    opts?.onTelemetry?.({
      event: "learning.staleness.importance_ratio",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "staleness.invalid_probability",
    });
    throw new ImportanceRatioContractError(
      "piTrain and piRollout must be finite probabilities with piTrain > 0 and piRollout ≥ 0",
      {
        obligation: "staleness.invalid_probability",
        subjectId,
        deviceId,
      },
    );
  }

  if (piRollout === 0) {
    opts?.onTelemetry?.({
      event: "learning.staleness.importance_ratio",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "staleness.zero_rollout_prob",
    });
    throw new ImportanceRatioContractError(
      "piRollout must be > 0 (zero rollout probability is undefined for importance ratio)",
      {
        obligation: "staleness.zero_rollout_prob",
        subjectId,
        deviceId,
      },
    );
  }

  const ratio = piTrain / piRollout;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    opts?.onTelemetry?.({
      event: "learning.staleness.importance_ratio",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "staleness.non_finite_ratio",
    });
    throw new ImportanceRatioContractError(
      "importance ratio must be a finite positive number",
      {
        obligation: "staleness.non_finite_ratio",
        subjectId,
        deviceId,
      },
    );
  }

  opts?.onTelemetry?.({
    event: "learning.staleness.importance_ratio",
    outcome: "ok",
    subjectId,
    deviceId,
    ratio,
  });

  return ratio;
}

/**
 * Per-trajectory importance ratio with policy-hash lineage pins.
 */
export function computeTrajectoryImportanceRatio(
  sample: TrajectoryImportanceSample,
  opts?: { onTelemetry?: (e: ImportanceRatioTelemetryEvent) => void },
): TrajectoryImportanceRatio {
  if (!sample.subjectId) {
    throw new ImportanceRatioContractError("subjectId required", {
      obligation: "staleness.subject_scope",
    });
  }
  if (
    !sample.trajectoryId ||
    sample.trajectoryId.length > TRAJECTORY_ID_LIMIT
  ) {
    throw new ImportanceRatioContractError("trajectoryId required", {
      obligation: "staleness.section_limit",
      subjectId: sample.subjectId,
    });
  }

  assertOpaquePolicyHash(
    sample.rolloutPolicyHash,
    "rolloutPolicyHash",
    sample.subjectId,
  );
  assertOpaquePolicyHash(
    sample.trainPolicyHash,
    "trainPolicyHash",
    sample.subjectId,
  );

  const ratio = computeImportanceRatio(sample.piTrain, sample.piRollout, {
    subjectId: sample.subjectId,
    deviceId: sample.deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  return {
    subjectId: sample.subjectId,
    deviceId: sample.deviceId,
    trajectoryId: sample.trajectoryId,
    rolloutPolicyHash: sample.rolloutPolicyHash,
    trainPolicyHash: sample.trainPolicyHash,
    ratio,
  };
}

export type BatchImportanceRatioReport = {
  meanRatio: number;
  ratios: TrajectoryImportanceRatio[];
  rolloutPolicyHash: string;
  trainPolicyHash: string;
  batchSize: number;
};

/**
 * Batch-level mean importance ratio (arithmetic mean of per-trajectory ρ).
 */
export function computeBatchMeanImportanceRatio(
  samples: readonly TrajectoryImportanceSample[],
  opts?: {
    onTelemetry?: (e: ImportanceRatioTelemetryEvent) => void;
  },
): BatchImportanceRatioReport {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new ImportanceRatioContractError(
      "importance-ratio batch requires at least one trajectory",
      { obligation: "staleness.empty_batch" },
    );
  }
  if (samples.length > IMPORTANCE_RATIO_BATCH_LIMIT) {
    throw new ImportanceRatioContractError(
      `importance-ratio batch exceeds ${IMPORTANCE_RATIO_BATCH_LIMIT}`,
      { obligation: "staleness.section_limit" },
    );
  }

  const ratios: TrajectoryImportanceRatio[] = [];
  for (const sample of samples) {
    ratios.push(
      computeTrajectoryImportanceRatio(sample, {
        ...(opts?.onTelemetry !== undefined
          ? { onTelemetry: opts.onTelemetry }
          : {}),
      }),
    );
  }

  const meanRatio =
    ratios.reduce((acc, r) => acc + r.ratio, 0) / ratios.length;
  if (!Number.isFinite(meanRatio)) {
    throw new ImportanceRatioContractError(
      "batch mean importance ratio is non-finite",
      { obligation: "staleness.non_finite_ratio" },
    );
  }

  const report: BatchImportanceRatioReport = {
    meanRatio,
    ratios,
    rolloutPolicyHash: ratios[0]!.rolloutPolicyHash,
    trainPolicyHash: ratios[0]!.trainPolicyHash,
    batchSize: ratios.length,
  };

  opts?.onTelemetry?.({
    event: "learning.staleness.importance_ratio",
    outcome: "ok",
    subjectId: ratios[0]!.subjectId,
    deviceId: ratios[0]!.deviceId,
    meanRatio,
    rolloutPolicyHash: report.rolloutPolicyHash,
    trainPolicyHash: report.trainPolicyHash,
    batchSize: report.batchSize,
  });

  return report;
}

/**
 * True iff mean ratio lies strictly inside (1−ε, 1+ε).
 * Outside → batch must be dropped (not clipped into the loss).
 */
export function isMeanRatioInsideClipBand(
  meanRatio: number,
  epsilon: number = STALENESS_EPSILON,
): boolean {
  if (
    typeof meanRatio !== "number" ||
    !Number.isFinite(meanRatio) ||
    typeof epsilon !== "number" ||
    !Number.isFinite(epsilon) ||
    epsilon <= 0 ||
    epsilon >= 1
  ) {
    return false;
  }
  const low = 1 - epsilon;
  const high = 1 + epsilon;
  return meanRatio > low && meanRatio < high;
}
