/**
 * Snapshot store factory — select backend from environment at startup;
 * log the active backend once.
 */

import { allocatePerRolloutSnapshotStore } from "./fleet.js";
import type {
  SnapshotBackendId,
  SnapshotStoreRepository,
  SnapshotTelemetry,
} from "./types.js";
import { SNAPSHOT_BACKENDS } from "./types.js";

let loggedBackend: SnapshotBackendId | null = null;

function logBackendOnce(
  backend: SnapshotBackendId,
  deviceId: string,
  onTelemetry?: (e: SnapshotTelemetry) => void,
): void {
  if (loggedBackend === backend) return;
  loggedBackend = backend;
  onTelemetry?.({
    event: "learning.snapshot_store",
    op: "backend_select",
    outcome: "ok",
    subjectId: null,
    deviceId,
    backend,
    detail: `snapshot store backend=${backend}`,
  });
  // Also surface once on stderr for operators (no content).
  process.stderr.write(
    `${JSON.stringify({
      event: "learning.snapshot_store",
      op: "backend_select",
      outcome: "ok",
      subjectId: null,
      deviceId,
      backend,
    })}\n`,
  );
}

/** Reset log-once latch (tests only). */
export function resetSnapshotBackendLogLatch(): void {
  loggedBackend = null;
}

export type CreateSnapshotStoreOptions = {
  env?: NodeJS.ProcessEnv;
  deviceId?: string;
  durableDir?: string;
  onTelemetry?: (e: SnapshotTelemetry) => void;
};

/**
 * Select snapshot repository from GYM_SNAPSHOT_BACKEND (default: memory).
 * Returns a unique per-rollout isolated store (fleet-allocated).
 * postgres is reserved for fleet scale — unavailable in this slice.
 */
export function createSnapshotStoreFromEnv(
  options: CreateSnapshotStoreOptions = {},
): SnapshotStoreRepository {
  const env = options.env ?? process.env;
  const deviceId = options.deviceId?.trim() || "dev-snapshot-factory";
  const raw = (env.GYM_SNAPSHOT_BACKEND ?? "memory").trim().toLowerCase();
  const backend = (
    SNAPSHOT_BACKENDS.includes(raw as SnapshotBackendId) ? raw : "memory"
  ) as SnapshotBackendId;

  logBackendOnce(backend, deviceId, options.onTelemetry);

  if (backend === "postgres") {
    // Loud failure — do not silently fall back (silent catch forbidden).
    throw new Error(
      "snapshot store backend=postgres is not available in this slice; use GYM_SNAPSHOT_BACKEND=memory",
    );
  }

  const durableDir =
    options.durableDir?.trim() ||
    env.GYM_SNAPSHOT_DURABLE_DIR?.trim() ||
    undefined;

  const allocated = allocatePerRolloutSnapshotStore({
    deviceId,
    ...(durableDir !== undefined ? { durableDir } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!allocated.ok) {
    throw new Error(`snapshot fleet allocate failed: ${allocated.detail}`);
  }
  return allocated.store;
}
