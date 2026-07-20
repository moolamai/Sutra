/**
 * Published core rubric path (C3) — re-exports @moolam/learning core rubric.
 * Source of truth: packages/learning/src/critics/core_rubric.ts
 */
export {
  CORE_RUBRIC_GOLDEN_BRANCHES,
  CORE_RUBRIC_GOLDEN_FIXTURES_RELPATH,
  CORE_RUBRIC_ID,
  CORE_RUBRIC_VERSION,
  CORE_RUBRIC_WEIGHTS,
  bindHumanOutcomeForRubric,
  createCoreRubricCritic,
  detectCleanSuccess,
  detectFormatBreach,
  detectInvariantViolation,
  detectSchemaFailure,
  readHumanOutcomeSignal,
  scoreCoreRubric,
  scoreCoreRubricBreakdown,
  scoreCoreRubricWithOutcome,
  zeroPositiveRewardComponents,
  type CoreRubricComponent,
  type CoreRubricRecord,
} from "@moolam/learning";
