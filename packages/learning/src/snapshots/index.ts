export type {
  CloneAtResetInput,
  CloneAtResetResult,
  CognitiveRolloutSnapshot,
  DiscardSnapshotInput,
  DiscardSnapshotResult,
  GetSnapshotInput,
  GetSnapshotResult,
  PutSnapshotInput,
  PutSnapshotResult,
  SnapshotBackendId,
  SnapshotExportConsent,
  SnapshotFailureClass,
  SnapshotKnowledgeState,
  SnapshotMasteryState,
  SnapshotMemoryState,
  SnapshotStoreRepository,
  SnapshotTelemetry,
  TeardownAtTerminalInput,
  TeardownAtTerminalResult,
} from "./types.js";
export {
  SNAPSHOT_BACKENDS,
  SNAPSHOT_FRICTION_LIMIT,
  SNAPSHOT_KNOWLEDGE_ID_LIMIT,
  SNAPSHOT_MASTERY_CONCEPT_LIMIT,
  SNAPSHOT_STATE_VECTOR_KEY_LIMIT,
} from "./types.js";

export {
  assertSnapshotBounds,
  cloneCognitiveSnapshot,
  deepCloneValue,
  emptyKnowledge,
  emptyMastery,
  emptyMemory,
  genesisCognitiveSnapshot,
  isSnapshotEmpty,
  stateVectorsEqual,
} from "./deep_clone.js";

export {
  InMemorySnapshotStore,
  type InMemorySnapshotStoreOptions,
} from "./memory_repository.js";

export {
  createSnapshotStoreFromEnv,
  resetSnapshotBackendLogLatch,
  type CreateSnapshotStoreOptions,
} from "./factory.js";

export {
  SNAPSHOT_FLEET_ROLLOUT_LIMIT,
  IsolatedRolloutSnapshotStore,
  SnapshotStoreFleet,
  allocatePerRolloutSnapshotStore,
  assertNoCrossRolloutRead,
  assertNoOrphanStoresAfterBurst,
  getDefaultSnapshotStoreFleet,
  teardownAndReleaseRolloutStore,
  type AllocateRolloutStoreInput,
  type AllocateRolloutStoreResult,
} from "./fleet.js";

export {
  runTeardownAtTerminal,
  snapshotExportConsentPasses,
} from "./discard_teardown.js";
