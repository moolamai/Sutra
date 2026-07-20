/**
 * Offline batch collector + bounded training window + e2e prove — published C4 path.
 * Source: packages/learning/src/batch_scheduler.ts · batch_training_window.ts · batch_e2e.ts
 * Config artifact: ./batch_config.json
 * Fixtures: ./batch_e2e/fixtures/
 */
export {
  OFFLINE_BATCH_CONFIG_RELPATH,
  OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT,
  OFFLINE_BATCH_SCAN_FILE_LIMIT_DEFAULT,
  OFFLINE_BATCH_WALL_CLOCK_MS_DEFAULT,
  OfflineBatchContractError,
  batchQueueRecordId,
  collectConsentedTrajectories,
  draftBatchTrajectoryForTests,
  loadOfflineBatchConfigFile,
  parseOfflineBatchConfig,
  proveBatchCollectorMicroRun,
  type CollectConsentedBatchResult,
  type OfflineBatchConfig,
  type OfflineBatchFailureClass,
  type OfflineBatchSkipReason,
  type OfflineBatchTelemetryEvent,
  type OfflineBatchVerdict,
} from "@moolam/learning";

export {
  OFFLINE_BATCH_CANDIDATE_SCHEMA_VERSION,
  OFFLINE_BATCH_MAX_TRAINING_STEPS_DEFAULT,
  OFFLINE_BATCH_TRAINING_WALL_CLOCK_MS_DEFAULT,
  createBatchWindowDifferentiatingCritic,
  proveBoundedTrainingWindowMicroRun,
  runBoundedTrainingWindow,
  type RunBoundedTrainingWindowResult,
  type TrainingWindowCandidate,
  type TrainingWindowStage,
  type TrainingWindowTelemetryEvent,
} from "@moolam/learning";

export {
  OFFLINE_BATCH_E2E_FIXTURES_RELPATH,
  OFFLINE_BATCH_E2E_FIXTURE_SCHEMA_VERSION,
  loadOfflineBatchE2EFixtureManifest,
  proveOfflineBatchModeE2E,
  runOfflineBatchModeE2E,
  type OfflineBatchE2EFixtureManifest,
  type OfflineBatchE2ERunResult,
} from "@moolam/learning";
