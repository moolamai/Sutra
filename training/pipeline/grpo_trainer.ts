/**
 * GRPO trainer — group sampling, advantage/loss, LoRA PEFT update path (C4).
 * Group/advantage: @moolam/learning · Adapter update: sutra-bindings-slm
 */
export {
  GRPO_GROUP_SCHEMA_VERSION,
  GRPO_GROUP_SIZE_MAX,
  GRPO_GROUP_SIZE_MIN,
  GRPO_SIGMA_EPSILON,
  GrpoGroupContractError,
  assembleGrpoGroup,
  proveGrpoGroupSamplingMicroRun,
  resetGrpoGroupCache,
  sampleGrpoGroupFromRollouts,
  scoreGrpoRolloutCandidates,
  type GrpoGroupAdmitted,
  type GrpoGroupFailureClass,
  type GrpoGroupLineage,
  type GrpoGroupResult,
  type GrpoGroupSkipped,
  type GrpoGroupTelemetryEvent,
  type GrpoRolloutCandidate,
  type GrpoScoredCandidate,
} from "@moolam/learning";

export {
  GRPO_ADVANTAGE_SCHEMA_VERSION,
  GRPO_CLIP_EPSILON,
  GrpoAdvantageContractError,
  assertNoValueHead,
  clippedSurrogateTerm,
  computeClippedSurrogateLoss,
  computeGroupRelativeAdvantages,
  computeGrpoPolicyLossFromAdmittedGroup,
  importanceRatiosFromLikelihoods,
  proveGrpoAdvantageLossMicroRun,
  resetGrpoAdvantageCache,
  type ClippedSurrogateLoss,
  type ClippedSurrogateTerm,
  type GrpoAdvantageComputed,
  type GrpoAdvantageFailureClass,
  type GrpoAdvantageResult,
  type GrpoAdvantageSkipped,
  type GrpoAdvantageTelemetryEvent,
  type GrpoPolicyLossFromGroup,
} from "@moolam/learning";

export {
  LORA_CONFIG_SCHEMA_VERSION,
  LORA_DEFAULT_ALPHA,
  LORA_DEFAULT_RANK,
  LORA_LINEAGE_CLIP_EPSILON,
  assertLoraAdapterOnlyConfig,
  defaultLoraConfig,
  type LoraConfig,
} from "./lora_config.js";

export {
  ADAPTER_DELTA_BYTE_LIMIT,
  ADAPTER_DELTA_SCHEMA_VERSION,
  ADAPTER_TRAIN_SEAM_VERSION,
  AdapterTrainContractError,
  LORA_DEFAULT_CLIP_EPSILON,
  LoraAdapterTrainer,
  assertAdapterOnlyUpdate,
  contentAddressDelta,
  pinAdapterTrainLineage,
  proveLoraAdapterUpdateMicroRun,
  synthesizeLoraAdapterDeltaBytes,
  validateLoraUpdateConfig,
  type AdapterDeltaArtifact,
  type AdapterTrainFailureClass,
  type AdapterTrainLineagePin,
  type AdapterTrainTelemetryEvent,
  type LoraAdapterUpdateResult,
  type LoraUpdateConfig,
} from "sutra-bindings-slm";
