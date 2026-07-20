/**
 * Gym snapshot store facade — clones cognitive state at GymEnv.reset().
 * Fleet assigns a unique isolated store instance per GymEnv / rollout.
 * Episode terminal tears down the snapshot unless export consent passes.
 */

import {
  allocatePerRolloutSnapshotStore,
  assertNoCrossRolloutRead,
  assertNoOrphanStoresAfterBurst,
  createSnapshotStoreFromEnv,
  getDefaultSnapshotStoreFleet,
  teardownAndReleaseRolloutStore,
  type CognitiveRolloutSnapshot,
  type SnapshotExportConsent,
  type SnapshotStoreRepository,
  type SnapshotTelemetry,
  type TeardownAtTerminalResult,
} from "@moolam/learning";

export type {
  CognitiveRolloutSnapshot,
  SnapshotExportConsent,
  SnapshotStoreRepository,
  SnapshotTelemetry,
  TeardownAtTerminalResult,
} from "@moolam/learning";

export {
  InMemorySnapshotStore,
  IsolatedRolloutSnapshotStore,
  SnapshotStoreFleet,
  allocatePerRolloutSnapshotStore,
  assertNoCrossRolloutRead,
  assertNoOrphanStoresAfterBurst,
  cloneCognitiveSnapshot,
  createSnapshotStoreFromEnv,
  genesisCognitiveSnapshot,
  getDefaultSnapshotStoreFleet,
  isSnapshotEmpty,
  teardownAndReleaseRolloutStore,
} from "@moolam/learning";

/** Soft re-export of backend env key for operators. */
export const GYM_SNAPSHOT_BACKEND_ENV = "GYM_SNAPSHOT_BACKEND";

/**
 * Resolve the store used by GymEnv.
 * Default: fleet-allocated unique per-rollout instance (never share across episodes).
 */
export function resolveGymSnapshotStore(options: {
  deviceId?: string;
  snapshotStore?: SnapshotStoreRepository;
  onTelemetry?: (e: SnapshotTelemetry) => void;
} = {}): SnapshotStoreRepository {
  if (options.snapshotStore) {
    return options.snapshotStore;
  }
  return createSnapshotStoreFromEnv({
    deviceId: options.deviceId ?? "dev-gym-snapshot",
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

/**
 * Explicit fleet allocate for rollout orchestration (unique store per episode).
 */
export function allocateGymRolloutSnapshotStore(options: {
  deviceId?: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
} = {}): SnapshotStoreRepository {
  const allocated = allocatePerRolloutSnapshotStore({
    deviceId: options.deviceId ?? "dev-gym-rollout",
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!allocated.ok) {
    throw new Error(`gym rollout store allocate failed: ${allocated.detail}`);
  }
  return allocated.store;
}

/**
 * Clone cognitive snapshot for a reset() episode bind.
 */
export function cloneSnapshotAtGymReset(input: {
  store: SnapshotStoreRepository;
  subjectId: string;
  deviceId: string;
  episodeId: string;
  template?: CognitiveRolloutSnapshot | null;
  onTelemetry?: (e: SnapshotTelemetry) => void;
}) {
  return input.store.cloneAtReset({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeId,
    ...(input.template !== undefined ? { template: input.template } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

/** Concurrent isolation prove for gym / CI. */
export function proveGymRolloutStoreIsolation(input: {
  subjectId: string;
  deviceId: string;
}): { ok: boolean; detail: string } {
  const a = allocateGymRolloutSnapshotStore({ deviceId: input.deviceId });
  const b = allocateGymRolloutSnapshotStore({ deviceId: input.deviceId });
  return assertNoCrossRolloutRead({
    storeA: a,
    storeB: b,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeA: "ep.gym.iso.a",
    episodeB: "ep.gym.iso.b",
  });
}

/**
 * Episode-terminal teardown: drop snapshot unless export consent passes;
 * release fleet slot so burst rollouts leave no orphans.
 */
export function discardGymSnapshotAtTerminal(input: {
  store: SnapshotStoreRepository;
  subjectId: string;
  deviceId: string;
  episodeId: string;
  consent?: SnapshotExportConsent | null;
  onTelemetry?: (e: SnapshotTelemetry) => void;
  /** When false, skip fleet release (injected non-fleet stores). Default true. */
  releaseFleet?: boolean;
}): TeardownAtTerminalResult & { released: boolean } {
  const releaseFleet = input.releaseFleet !== false;
  if (!releaseFleet || !input.store.rolloutId) {
    const torn = input.store.teardownAtTerminal({
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      episodeId: input.episodeId,
      ...(input.consent !== undefined ? { consent: input.consent } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
    return { ...torn, released: false };
  }
  return teardownAndReleaseRolloutStore({
    store: input.store,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    episodeId: input.episodeId,
    fleet: getDefaultSnapshotStoreFleet(),
    ...(input.consent !== undefined ? { consent: input.consent } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

/** Prove gym burst leaves no orphan fleet stores. */
export function proveGymNoOrphanStoresAfterBurst(input: {
  subjectId: string;
  deviceId: string;
}): { ok: boolean; detail: string } {
  return assertNoOrphanStoresAfterBurst({
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    burstSize: 8,
  });
}
