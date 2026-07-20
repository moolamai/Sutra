/**
 * Champion adapter rollback seam — one audited, byte-identical restore.
 *
 * Maintains the verified champion in an in-memory cache (hash + exact bytes).
 * Rollback restores that champion through the SlmRuntime adapter-load seam in a
 * single operation, never by re-download. Applies at turn boundaries with the
 * same pin rules as forward swap; pending forward swaps are cancelled first.
 */

import { createHash } from "node:crypto";
import {
  ADAPTER_LOAD_SEAM_VERSION,
  AdapterLoadContractError,
  SlmRuntimeAdapterLoader,
  type AdapterDeltaManifestView,
  type AdapterLoadApplyResult,
  type AppliedAdapterState,
} from "./adapter_load.js";

export const CHAMPION_ROLLBACK_SCHEMA_VERSION =
  "hot-swap.champion-rollback.v1" as const;

export const CHAMPION_ROLLBACK_OP_LIMIT = 64;

export type ChampionRollbackFailureClass =
  | "hot_swap.rollback.subject_scope"
  | "hot_swap.rollback.mid_turn_queued"
  | "hot_swap.rollback.op_conflict"
  | "hot_swap.rollback.op_limit"
  | "hot_swap.rollback.apply_failed"
  | "hot_swap.rollback.champion_corrupt"
  | "adapter.load.mid_turn_refuse";

export type ChampionRollbackTelemetryEvent = {
  event:
    | "bindings.hot_swap.champion_retain"
    | "bindings.hot_swap.rollback"
    | "bindings.hot_swap.rollback_queue"
    | "bindings.hot_swap.rollback_cancel_pending";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  operationId?: string;
  championContentHash?: string;
  oldContentHash?: string;
  newContentHash?: string;
  restoredTo?: "champion" | "base";
  cancelledPendingCount?: number;
  queued?: boolean;
  idempotentReplay?: boolean;
  failureClass?: ChampionRollbackFailureClass;
};

export class ChampionRollbackError extends Error {
  readonly obligation: ChampionRollbackFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly operationId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: ChampionRollbackFailureClass;
      subjectId?: string;
      deviceId?: string;
      operationId?: string;
    },
  ) {
    super(message);
    this.name = "ChampionRollbackError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.operationId = meta.operationId;
  }
}

/** Verified champion snapshot — bytes are the source of truth for restore. */
export type VerifiedChampionAdapter = {
  schemaVersion: typeof CHAMPION_ROLLBACK_SCHEMA_VERSION;
  contentHash: string;
  baseModelHash: string;
  manifest: AdapterDeltaManifestView;
  blob: Buffer;
  retainedAt: string;
};

/**
 * Structural gate so rollback can cancel a pending forward-swap queue without
 * reverse-importing harness types. Implemented by the turn-pinning seam.
 */
export type PendingForwardSwapGate = {
  readonly pendingCount: number;
  readonly activeSessionCount: number;
  cancelPendingSwaps(): {
    cancelledCount: number;
    cancelledContentHashes: ReadonlyArray<string>;
  };
};

export type ChampionRetainResult = {
  ok: true;
  champion: VerifiedChampionAdapter;
  idempotentReplay: boolean;
};

export type ChampionRollbackResult =
  | {
      ok: true;
      applied: true;
      restoredTo: "champion";
      operationId: string;
      oldContentHash: string | undefined;
      newContentHash: string;
      championContentHash: string;
      cancelledPendingCount: number;
      load: AdapterLoadApplyResult;
      restored: AppliedAdapterState;
      idempotentReplay: boolean;
      auditId: string;
    }
  | {
      ok: true;
      applied: true;
      restoredTo: "base";
      operationId: string;
      oldContentHash: string | undefined;
      newContentHash: undefined;
      championContentHash: undefined;
      cancelledPendingCount: number;
      idempotentReplay: boolean;
      auditId: string;
    }
  | {
      ok: true;
      applied: false;
      queued: true;
      operationId: string;
      activeSessionCount: number;
      cancelledPendingCount: number;
      championContentHash: string | undefined;
      idempotentReplay: boolean;
    };

/**
 * Maintains the champion verified cache and performs one-operation rollback.
 */
export class SlmRuntimeChampionRollback {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly loader: SlmRuntimeAdapterLoader;
  private readonly pendingGate: PendingForwardSwapGate | undefined;
  private readonly onTelemetry:
    | ((event: ChampionRollbackTelemetryEvent) => void)
    | undefined;
  private champion: VerifiedChampionAdapter | undefined;
  private queuedOperationId: string | undefined;
  private readonly byOperationId = new Map<string, ChampionRollbackResult>();

  constructor(options: {
    subjectId: string;
    deviceId: string;
    loader: SlmRuntimeAdapterLoader;
    pendingGate?: PendingForwardSwapGate;
    onTelemetry?: (event: ChampionRollbackTelemetryEvent) => void;
  }) {
    this.subjectId = requireId(options.subjectId, "subjectId");
    this.deviceId = requireId(options.deviceId, "deviceId");
    this.loader = options.loader;
    this.pendingGate = options.pendingGate;
    this.onTelemetry = options.onTelemetry;
  }

  get championSnapshot(): VerifiedChampionAdapter | undefined {
    return this.champion;
  }

  get hasQueuedRollback(): boolean {
    return this.queuedOperationId !== undefined;
  }

  /**
   * Retain the current verified active adapter as champion (exact bytes).
   * Call after a successful load that should become the restore target.
   */
  retainChampion(input: {
    subjectId: string;
    manifest: AdapterDeltaManifestView;
    retainedAt?: string;
  }): ChampionRetainResult {
    this.assertSubject(input.subjectId);
    if (input.manifest.subjectId !== this.subjectId) {
      throw new ChampionRollbackError(
        "champion retain subjectId must match seam subject",
        {
          obligation: "hot_swap.rollback.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }

    const active = this.loader.activeAdapter;
    if (!active) {
      throw new ChampionRollbackError(
        "cannot retain champion without an active verified adapter",
        {
          obligation: "hot_swap.rollback.champion_corrupt",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    if (active.contentHash !== input.manifest.contentHash) {
      throw new ChampionRollbackError(
        "manifest contentHash does not match active verified adapter",
        {
          obligation: "hot_swap.rollback.champion_corrupt",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }

    const existing = this.champion;
    if (
      existing &&
      existing.contentHash === active.contentHash &&
      existing.blob.equals(active.blob)
    ) {
      this.onTelemetry?.({
        event: "bindings.hot_swap.champion_retain",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        championContentHash: existing.contentHash,
        idempotentReplay: true,
      });
      return { ok: true, champion: existing, idempotentReplay: true };
    }

    const champion: VerifiedChampionAdapter = Object.freeze({
      schemaVersion: CHAMPION_ROLLBACK_SCHEMA_VERSION,
      contentHash: active.contentHash,
      baseModelHash: active.baseModelHash,
      manifest: Object.freeze({ ...input.manifest }),
      blob: Buffer.from(active.blob),
      retainedAt: input.retainedAt ?? new Date().toISOString(),
    });
    this.champion = champion;
    this.onTelemetry?.({
      event: "bindings.hot_swap.champion_retain",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      championContentHash: champion.contentHash,
      idempotentReplay: false,
    });
    return { ok: true, champion, idempotentReplay: false };
  }

  /**
   * Single audited rollback: cancel pending forward swaps, then restore the
   * champion byte-identically (or base when no champion). Mid-turn requests
   * queue until {@link flushQueuedRollback} at the turn boundary.
   */
  rollback(input: {
    subjectId: string;
    operationId?: string;
  }): ChampionRollbackResult {
    this.assertSubject(input.subjectId);
    const operationId =
      input.operationId?.trim() ||
      `rollback:${this.champion?.contentHash ?? "base"}:${this.byOperationId.size}`;

    const prior = this.byOperationId.get(operationId);
    if (prior) {
      const replayed = { ...prior, idempotentReplay: true as const };
      this.emitRollbackTelemetry(replayed, true);
      return replayed;
    }

    if (this.byOperationId.size >= CHAMPION_ROLLBACK_OP_LIMIT) {
      const first = this.byOperationId.keys().next().value;
      if (first !== undefined) this.byOperationId.delete(first);
    }

    const cancelledPendingCount = this.cancelPendingForwardSwaps();

    const activeSessions =
      this.pendingGate?.activeSessionCount ??
      (this.loader.hasInFlightTurn ? 1 : 0);
    if (activeSessions > 0 || this.loader.hasInFlightTurn) {
      this.queuedOperationId = operationId;
      const queued: ChampionRollbackResult = {
        ok: true,
        applied: false,
        queued: true,
        operationId,
        activeSessionCount: Math.max(
          activeSessions,
          this.loader.hasInFlightTurn ? 1 : 0,
        ),
        cancelledPendingCount,
        championContentHash: this.champion?.contentHash,
        idempotentReplay: false,
      };
      this.byOperationId.set(operationId, queued);
      this.onTelemetry?.({
        event: "bindings.hot_swap.rollback_queue",
        outcome: "advisory",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        operationId,
        queued: true,
        cancelledPendingCount,
        ...(this.champion !== undefined
          ? { championContentHash: this.champion.contentHash }
          : {}),
        failureClass: "hot_swap.rollback.mid_turn_queued",
      });
      return queued;
    }

    const applied = this.applyRollbackUnlocked(operationId, cancelledPendingCount);
    this.byOperationId.set(operationId, applied);
    return applied;
  }

  /**
   * Apply a previously queued rollback once every active session has completed
   * (TURN_COMPLETE / HARNESS_ERROR boundary).
   */
  flushQueuedRollback(input: {
    subjectId: string;
    operationId?: string;
  }): ChampionRollbackResult {
    this.assertSubject(input.subjectId);
    const operationId = input.operationId?.trim() || this.queuedOperationId;
    if (!operationId) {
      throw new ChampionRollbackError("no queued rollback to flush", {
        obligation: "hot_swap.rollback.op_conflict",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }

    const activeSessions =
      this.pendingGate?.activeSessionCount ??
      (this.loader.hasInFlightTurn ? 1 : 0);
    if (activeSessions > 0 || this.loader.hasInFlightTurn) {
      throw new ChampionRollbackError(
        "queued rollback still blocked by active turn pins",
        {
          obligation: "hot_swap.rollback.mid_turn_queued",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          operationId,
        },
      );
    }

    this.queuedOperationId = undefined;
    // Drop the queued placeholder so apply is not treated as idempotent replay.
    this.byOperationId.delete(operationId);
    const cancelledPendingCount = this.cancelPendingForwardSwaps();
    const applied = this.applyRollbackUnlocked(operationId, cancelledPendingCount);
    this.byOperationId.set(operationId, applied);
    return applied;
  }

  private applyRollbackUnlocked(
    operationId: string,
    cancelledPendingCount: number,
  ): ChampionRollbackResult {
    const oldContentHash = this.loader.activeContentHash;
    const auditId = `audit:${operationId}`;

    if (!this.champion) {
      clearLoaderActiveToBase(this.loader);
      const result: ChampionRollbackResult = {
        ok: true,
        applied: true,
        restoredTo: "base",
        operationId,
        oldContentHash,
        newContentHash: undefined,
        championContentHash: undefined,
        cancelledPendingCount,
        idempotentReplay: false,
        auditId,
      };
      this.emitRollbackTelemetry(result, false);
      return result;
    }

    // Integrity check — champion bytes must still match retained hash.
    const expected = this.champion.contentHash;
    const actualHash = contentHashOf(this.champion.blob);
    if (actualHash !== expected) {
      this.onTelemetry?.({
        event: "bindings.hot_swap.rollback",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        operationId,
        championContentHash: expected,
        failureClass: "hot_swap.rollback.champion_corrupt",
      });
      throw new ChampionRollbackError(
        "champion cache corrupted — refuse restore",
        {
          obligation: "hot_swap.rollback.champion_corrupt",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          operationId,
        },
      );
    }

    // Already on champion — idempotent no-op restore (still audited).
    if (
      this.loader.activeAdapter &&
      this.loader.activeAdapter.contentHash === this.champion.contentHash &&
      this.loader.activeAdapter.blob.equals(this.champion.blob)
    ) {
      const result: ChampionRollbackResult = {
        ok: true,
        applied: true,
        restoredTo: "champion",
        operationId,
        oldContentHash,
        newContentHash: this.champion.contentHash,
        championContentHash: this.champion.contentHash,
        cancelledPendingCount,
        load: {
          ok: true,
          seamVersion: ADAPTER_LOAD_SEAM_VERSION,
          applied: this.loader.activeAdapter,
          previousContentHash: undefined,
          idempotentReplay: true,
        },
        restored: this.loader.activeAdapter,
        idempotentReplay: true,
        auditId,
      };
      this.emitRollbackTelemetry(result, true);
      return result;
    }

    let load: AdapterLoadApplyResult;
    try {
      load = this.loader.loadAdapter({
        manifest: this.champion.manifest,
        blobBytes: this.champion.blob,
        loadId: `rollback:${operationId}`,
      });
    } catch (error) {
      if (
        error instanceof AdapterLoadContractError &&
        error.obligation === "adapter.load.mid_turn_refuse"
      ) {
        throw new ChampionRollbackError(
          "rollback refused while turn is pinned until TURN_COMPLETE",
          {
            obligation: "adapter.load.mid_turn_refuse",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
            operationId,
          },
        );
      }
      this.onTelemetry?.({
        event: "bindings.hot_swap.rollback",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        operationId,
        championContentHash: this.champion.contentHash,
        ...(oldContentHash !== undefined ? { oldContentHash } : {}),
        failureClass: "hot_swap.rollback.apply_failed",
      });
      throw new ChampionRollbackError(
        error instanceof Error
          ? `champion rollback apply failed: ${error.message}`
          : "champion rollback apply failed",
        {
          obligation: "hot_swap.rollback.apply_failed",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          operationId,
        },
      );
    }

    if (
      !load.applied.blob.equals(this.champion.blob) ||
      load.applied.contentHash !== this.champion.contentHash
    ) {
      throw new ChampionRollbackError(
        "rollback did not restore champion byte-identically",
        {
          obligation: "hot_swap.rollback.champion_corrupt",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          operationId,
        },
      );
    }

    const result: ChampionRollbackResult = {
      ok: true,
      applied: true,
      restoredTo: "champion",
      operationId,
      oldContentHash,
      newContentHash: load.applied.contentHash,
      championContentHash: this.champion.contentHash,
      cancelledPendingCount,
      load,
      restored: load.applied,
      idempotentReplay: load.idempotentReplay,
      auditId,
    };
    this.emitRollbackTelemetry(result, false);
    return result;
  }

  private cancelPendingForwardSwaps(): number {
    if (!this.pendingGate || this.pendingGate.pendingCount === 0) {
      return 0;
    }
    const cancelled = this.pendingGate.cancelPendingSwaps();
    this.onTelemetry?.({
      event: "bindings.hot_swap.rollback_cancel_pending",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      cancelledPendingCount: cancelled.cancelledCount,
    });
    return cancelled.cancelledCount;
  }

  private emitRollbackTelemetry(
    result: ChampionRollbackResult,
    idempotentReplay: boolean,
  ): void {
    if (!result.applied) {
      return;
    }
    this.onTelemetry?.({
      event: "bindings.hot_swap.rollback",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      operationId: result.operationId,
      restoredTo: result.restoredTo,
      cancelledPendingCount: result.cancelledPendingCount,
      idempotentReplay,
      ...(result.oldContentHash !== undefined
        ? { oldContentHash: result.oldContentHash }
        : {}),
      ...(result.restoredTo === "champion"
        ? {
            newContentHash: result.newContentHash,
            championContentHash: result.championContentHash,
          }
        : {}),
    });
  }

  private assertSubject(subjectId: string): void {
    if (requireId(subjectId, "subjectId") !== this.subjectId) {
      this.onTelemetry?.({
        event: "bindings.hot_swap.rollback",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        failureClass: "hot_swap.rollback.subject_scope",
      });
      throw new ChampionRollbackError(
        "cross-subject champion rollback access denied",
        {
          obligation: "hot_swap.rollback.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
  }
}

/**
 * Adapt the turn-pinning seam into a pending-forward-swap gate. Uses the
 * seam's pending queue storage so rollback can cancel without a re-download.
 */
export function pendingGateFromTurnPinningSeam(seam: {
  pendingCount: number;
  activeSessionCount: number;
}): PendingForwardSwapGate {
  const internal = seam as unknown as {
    pending: Array<{ contentHash: string }>;
    byEnqueueId: Map<string, unknown>;
    pendingCount: number;
    activeSessionCount: number;
  };
  return {
    get pendingCount() {
      return internal.pendingCount;
    },
    get activeSessionCount() {
      return internal.activeSessionCount;
    },
    cancelPendingSwaps() {
      const cancelledContentHashes = internal.pending.map((p) => p.contentHash);
      const cancelledCount = cancelledContentHashes.length;
      internal.pending.length = 0;
      internal.byEnqueueId.clear();
      return { cancelledCount, cancelledContentHashes };
    },
  };
}

function clearLoaderActiveToBase(loader: SlmRuntimeAdapterLoader): void {
  if (loader.hasInFlightTurn) {
    throw new ChampionRollbackError(
      "cannot clear to base while a turn is pinned",
      {
        obligation: "adapter.load.mid_turn_refuse",
      },
    );
  }
  const internal = loader as unknown as {
    active: AppliedAdapterState | undefined;
    previous: AppliedAdapterState | undefined;
  };
  internal.active = undefined;
  internal.previous = undefined;
}

function contentHashOf(blob: Buffer): string {
  return `sha256:${createHash("sha256").update(blob).digest("hex")}`;
}

function requireId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new ChampionRollbackError(`${field} required`, {
      obligation: "hot_swap.rollback.subject_scope",
    });
  }
  return trimmed;
}

/** CI job id for the adapter rollback golden drill. */
export const ADAPTER_ROLLBACK_DRILL_CI_JOB_ID =
  "protocol-conformance" as const;

/** Repo-relative path of the drill test suite run by CI. */
export const ADAPTER_ROLLBACK_DRILL_TEST_RELPATH =
  "training/delivery/rollback_drill.test.ts" as const;

/** Fixed golden utterance — never logs raw learner content in telemetry. */
export const ADAPTER_ROLLBACK_GOLDEN_UTTERANCE =
  "Explain consistent hashing simply." as const;

export type GoldenTurnAdapterOutput = {
  /** Deterministic reply bytes under the active adapter (or base). */
  text: string;
  /** Content hash of the reply bytes. */
  outputHash: string;
  /** Active adapter hash, or `base` when unloaded. */
  adapterPin: string;
};

/**
 * Deterministic golden-turn reply bound to the active adapter pin.
 * Same pin + utterance ⇒ identical bytes; challenger pin must diverge.
 */
export function renderGoldenTurnUnderAdapter(input: {
  utterance: string;
  adapterContentHash: string | undefined;
}): GoldenTurnAdapterOutput {
  const utterance = requireId(input.utterance, "utterance");
  const adapterPin = input.adapterContentHash?.trim() || "base";
  const digest = createHash("sha256")
    .update(utterance, "utf8")
    .update("\0", "utf8")
    .update(adapterPin, "utf8")
    .digest("hex");
  const text = `golden-turn:${adapterPin.slice(0, 24)}:${digest.slice(0, 40)}`;
  return {
    text,
    outputHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    adapterPin,
  };
}

export type ChampionRollbackGoldenDrillProof = {
  ok: true;
  subjectId: string;
  deviceId: string;
  championContentHash: string;
  challengerContentHash: string;
  baselineOutputHash: string;
  challengerOutputHash: string;
  restoredOutputHash: string;
  behaviourChanged: true;
  byteMatchAfterRollback: true;
  cancelledPendingCount: number;
  refused: ReadonlyArray<ChampionRollbackFailureClass | "adapter.load.base_mismatch">;
  ciJobId: typeof ADAPTER_ROLLBACK_DRILL_CI_JOB_ID;
  testRelPath: typeof ADAPTER_ROLLBACK_DRILL_TEST_RELPATH;
};

function fixtureDrillManifest(input: {
  subjectId: string;
  deviceId: string;
  baseModelHash: string;
  contentHash: string;
}): AdapterDeltaManifestView {
  return {
    schemaVersion: "adapter.delta.manifest.v1",
    contentHash: input.contentHash,
    baseModelHash: input.baseModelHash,
    precisionFormat: "int4",
    loraRank: 16,
    loraAlpha: 32,
    lineageRef: {
      schemaVersion: "checkpoint.lineage.v1",
      runId: "run.rollback.golden.drill",
      checkpointHash: "ckpt:sha256:rollbackgolden001",
      corpusManifestHash:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      criticVersions: [
        {
          rubricId: "core.format",
          rubricVersion: "1.0.0",
          contentHash:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
    },
    adapterBlobRef: `cas://${input.contentHash}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: "on-device",
  };
}

/**
 * CI-facing prove: champion baseline → challenger behaviour change →
 * turn-boundary rollback → golden-turn output byte-matches baseline.
 */
export function proveChampionRollbackGoldenDrillMicroRun(opts?: {
  onTelemetry?: (event: ChampionRollbackTelemetryEvent) => void;
}): ChampionRollbackGoldenDrillProof {
  const subjectId = "subj.rollback.golden.drill";
  const deviceId = "dev.rollback.golden.drill";
  const baseModelHash = "ckpt:sha256:rollbackgoldenbase";
  const utterance = ADAPTER_ROLLBACK_GOLDEN_UTTERANCE;
  const refused: Array<
    ChampionRollbackFailureClass | "adapter.load.base_mismatch"
  > = [];

  const blobChampion = Buffer.from("golden-drill-champion-bytes");
  const blobChallenger = Buffer.from("golden-drill-challenger-bytes");
  const blobPending = Buffer.from("golden-drill-pending-bytes");
  const hashChampion = contentHashOf(blobChampion);
  const hashChallenger = contentHashOf(blobChallenger);
  const hashPending = contentHashOf(blobPending);

  const manifestChampion = fixtureDrillManifest({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashChampion,
  });
  const manifestChallenger = fixtureDrillManifest({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashChallenger,
  });
  const manifestPending = fixtureDrillManifest({
    subjectId,
    deviceId,
    baseModelHash,
    contentHash: hashPending,
  });

  const loader = new SlmRuntimeAdapterLoader({
    subjectId,
    deviceId,
    baseModelHash,
    precisionFormat: "int4",
  });
  loader.loadAdapter({
    manifest: manifestChampion,
    blobBytes: blobChampion,
    loadId: "golden.load.champion",
  });

  // Lightweight pending gate (no hot_swap import — keeps this module leaf-safe).
  const pendingQueue: Array<{ contentHash: string }> = [];
  const pendingGate: PendingForwardSwapGate = {
    get pendingCount() {
      return pendingQueue.length;
    },
    get activeSessionCount() {
      return loader.hasInFlightTurn ? 1 : 0;
    },
    cancelPendingSwaps() {
      const cancelledContentHashes = pendingQueue.map((p) => p.contentHash);
      pendingQueue.length = 0;
      return { cancelledCount: cancelledContentHashes.length, cancelledContentHashes };
    },
  };

  const rollback = new SlmRuntimeChampionRollback({
    subjectId,
    deviceId,
    loader,
    pendingGate,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  rollback.retainChampion({ subjectId, manifest: manifestChampion });

  const baseline = renderGoldenTurnUnderAdapter({
    utterance,
    adapterContentHash: loader.activeContentHash,
  });

  loader.loadAdapter({
    manifest: manifestChallenger,
    blobBytes: blobChallenger,
    loadId: "golden.load.challenger",
  });
  const underChallenger = renderGoldenTurnUnderAdapter({
    utterance,
    adapterContentHash: loader.activeContentHash,
  });
  if (underChallenger.outputHash === baseline.outputHash) {
    throw new Error("challenger must change golden-turn output vs champion");
  }
  if (underChallenger.text === baseline.text) {
    throw new Error("challenger golden-turn text must diverge from baseline");
  }

  // Mid-turn pin + pending forward swap — rollback cancels queue and waits.
  loader.beginTurn("session.golden.drill.1");
  pendingQueue.push({ contentHash: hashPending });
  const queued = rollback.rollback({
    subjectId,
    operationId: "op.golden.drill.rollback",
  });
  if (!("queued" in queued) || queued.queued !== true) {
    throw new Error("expected mid-turn rollback to queue until TURN_COMPLETE");
  }
  if (queued.cancelledPendingCount !== 1 || pendingQueue.length !== 0) {
    throw new Error("pending forward swap must be cancelled during rollback");
  }
  if (loader.activeContentHash !== hashChallenger) {
    throw new Error("pinned turn must stay on challenger until boundary");
  }

  loader.completeTurn("session.golden.drill.1");
  const restored = rollback.flushQueuedRollback({
    subjectId,
    operationId: "op.golden.drill.rollback",
  });
  if (!restored.applied || restored.restoredTo !== "champion") {
    throw new Error("flush must restore champion adapter");
  }
  if (
    !loader.activeAdapter ||
    !loader.activeAdapter.blob.equals(blobChampion) ||
    loader.activeContentHash !== hashChampion
  ) {
    throw new Error("rollback must restore champion bytes identically");
  }

  const afterRollback = renderGoldenTurnUnderAdapter({
    utterance,
    adapterContentHash: loader.activeContentHash,
  });
  if (afterRollback.outputHash !== baseline.outputHash) {
    throw new Error("post-rollback golden-turn output must byte-match baseline");
  }
  if (afterRollback.text !== baseline.text) {
    throw new Error("post-rollback golden-turn text must byte-match baseline");
  }

  // Loud base mismatch after boundary — active champion untouched.
  try {
    loader.loadAdapter({
      manifest: fixtureDrillManifest({
        subjectId,
        deviceId,
        baseModelHash: "ckpt:sha256:wrongbasegolden001",
        contentHash: hashPending,
      }),
      blobBytes: blobPending,
    });
  } catch (error) {
    if (
      error instanceof AdapterLoadContractError &&
      error.obligation === "adapter.load.base_mismatch"
    ) {
      refused.push("adapter.load.base_mismatch");
    } else {
      throw error;
    }
  }
  if (loader.activeContentHash !== hashChampion) {
    throw new Error("base mismatch must not mutate champion after rollback");
  }

  // Subject isolation.
  try {
    rollback.rollback({
      subjectId: "subj.other.golden",
      operationId: "op.cross.subject",
    });
  } catch (error) {
    if (
      error instanceof ChampionRollbackError &&
      error.obligation === "hot_swap.rollback.subject_scope"
    ) {
      refused.push("hot_swap.rollback.subject_scope");
    } else {
      throw error;
    }
  }

  // Idempotent replay of the drill operation.
  const replay = rollback.rollback({
    subjectId,
    operationId: "op.golden.drill.rollback",
  });
  if (!replay.idempotentReplay) {
    throw new Error("drill rollback operationId must be idempotent");
  }

  if (!refused.includes("adapter.load.base_mismatch")) {
    throw new Error("expected base_mismatch refusal in golden drill");
  }
  if (!refused.includes("hot_swap.rollback.subject_scope")) {
    throw new Error("expected subject_scope refusal in golden drill");
  }

  return {
    ok: true,
    subjectId,
    deviceId,
    championContentHash: hashChampion,
    challengerContentHash: hashChallenger,
    baselineOutputHash: baseline.outputHash,
    challengerOutputHash: underChallenger.outputHash,
    restoredOutputHash: afterRollback.outputHash,
    behaviourChanged: true,
    byteMatchAfterRollback: true,
    cancelledPendingCount: queued.cancelledPendingCount,
    refused,
    ciJobId: ADAPTER_ROLLBACK_DRILL_CI_JOB_ID,
    testRelPath: ADAPTER_ROLLBACK_DRILL_TEST_RELPATH,
  };
}
