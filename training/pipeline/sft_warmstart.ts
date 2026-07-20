/**
 * SFT warmstart — published C4 pipeline path.
 * Source: training/corpus/sft_warmstart.ts
 *
 * Optional: wire C1 distillation grammar via createDistillationGrammarGate
 * when @moolam/training-distillation is available.
 */
export {
  SFT_ANCHORED_CHECKPOINT_SCHEMA_VERSION,
  SFT_EXAMPLE_LIMIT,
  SFT_WARMSTART_SCHEMA_VERSION,
  GRPO_JOB_SCHEMA_VERSION,
  SFT_ANCHOR_GATE_FIXTURE_DIR,
  SFT_ANCHOR_GATE_VIOLATION_UNANCHORED,
  SftWarmstartContractError,
  admitGrpoJobOrThrow,
  assertCorpusManifestHashFresh,
  assertSftCorpusPolicy,
  computeSupervisedLoss,
  defaultSftHarnessGrammarGate,
  filterSftExamplesForWarmstart,
  lintGrpoJobMidTrainAnchor,
  parseGrpoJobAdmissionRequest,
  proveMidTrainAnchorGateCi,
  proveSftWarmstartMicroRun,
  resetGrpoAdmitCache,
  resetSftWarmstartCache,
  runSftWarmstart,
  type GrpoJobAdmissionRequest,
  type GrpoJobLintFail,
  type GrpoJobLintOk,
  type GrpoJobLintResult,
  type SftAnchoredCheckpoint,
  type SftGrammarGateResult,
  type SftTraceGrammarGate,
  type SftTrainingExample,
  type SftWarmstartFailureClass,
  type SftWarmstartResult,
  type SftWarmstartTelemetryEvent,
} from "@moolam/training-corpus/sft-warmstart";
