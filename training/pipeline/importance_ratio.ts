/**
 * Importance-ratio computation — published path (C4).
 * Source: packages/learning/src/importance_ratio.ts
 */
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
  type BatchImportanceRatioReport,
  type ImportanceRatioFailureClass,
  type ImportanceRatioTelemetryEvent,
  type TrajectoryImportanceRatio,
  type TrajectoryImportanceSample,
} from "@moolam/learning";
