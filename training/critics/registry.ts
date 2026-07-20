/**
 * Critic registry path (C3) — re-exports @moolam/learning registry + pack oracles.
 */
export {
  CRITIC_CONTENT_HASH_LIMIT,
  CRITIC_LINEAGE_PIN_LIMIT,
  CRITIC_LINEAGE_SCHEMA_VERSION,
  CRITIC_RUN_ID_LIMIT,
  CriticRegistry,
  canonicalizeCriticIdentity,
  computeCriticContentHash,
  criticRegistryKey,
  criticVersionMajor,
  getDefaultCriticRegistry,
  isBreakingRubricBump,
  resetDefaultCriticRegistry,
  type CriticLineagePin,
  type CriticManifestHook,
  type CriticRecalibrationAttestation,
  type CriticRegisterOptions,
  type CriticRegistryKey,
  type CriticVersionRecord,
  type TrainingCriticLineageRecord,
} from "@moolam/learning";

export {
  CRITIC_PACK_ORACLE_MANIFEST_SCHEMA_VERSION,
  PACK_ORACLE_KINDS,
  REFERENCE_PACK_ORACLE_MANIFESTS,
  createPackOracleCritic,
  loadPackOracleManifest,
  parsePackOracleManifest,
  registerPackOraclesFromManifest,
  registerReferencePackOracles,
  type PackOracleEntry,
  type PackOracleKind,
  type PackOracleManifest,
  type RegisterPackOraclesResult,
} from "@moolam/learning";
