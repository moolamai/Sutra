/**
 * Published process-rewards path (C3) — features + dominance-capped shaping.
 * Source of truth: packages/learning/src/critics/process_rewards.ts
 * Cap aligns with @moolam/runtime-harness MAX_CORRECTION_TURNS /
 * PROCESS_REWARD_ABS_CAP.
 */
export {
  MAX_CORRECTION_TURNS,
  PROCESS_FIRST_PASS_BONUS,
  PROCESS_MIN_SCORE,
  PROCESS_OUTCOME_OBLIGATION_PENALTY,
  PROCESS_REPAIR_PENALTY_PER_DEPTH,
  PROCESS_REWARD_ABS_CAP,
  PROCESS_REWARD_GOLDEN_BRANCHES,
  PROCESS_REWARD_GOLDEN_FIXTURES_RELPATH,
  PROCESS_RUBRIC_ID,
  PROCESS_RUBRIC_VERSION,
  ProcessRewardContractError,
  assertProcessDominatedByObligation,
  clampProcessRewardMagnitude,
  countCorrectionDepth,
  countRepairStages,
  createProcessRewardCritic,
  detectFirstPassValidToolCall,
  extractCorrectionCycleFeatures,
  scoreProcessReward,
  shapeProcessReward,
  type CorrectionCycleFeatures,
  type ProcessRewardFailureClass,
  type ProcessRewardShaped,
  type ProcessRewardTelemetryEvent,
  type ProcessRewardTrajectory,
} from "@moolam/learning";
