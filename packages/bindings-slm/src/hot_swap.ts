/**
 * SlmRuntime turn-pinning + turn-boundary swap seam.
 *
 * The active adapter hash is captured when the first model token is emitted.
 * Mid-turn loads are refused. Pending verified deltas queue until every active
 * session on the subject reaches TURN_COMPLETE or HARNESS_ERROR; then the
 * latest queued delta is applied and a swap event emits old/new hashes.
 */

import {
  AdapterLoadContractError,
  SlmRuntimeAdapterLoader,
  type AdapterDeltaManifestView,
  type AdapterLoadApplyResult,
} from "./adapter_load.js";

export const HOT_SWAP_TURN_PIN_SCHEMA_VERSION =
  "hot-swap.turn-pin.v1" as const;

export const HOT_SWAP_SESSION_LIMIT = 64;
export const HOT_SWAP_PENDING_QUEUE_LIMIT = 16;

export type HotSwapPinFailureClass =
  | "hot_swap.pin.subject_scope"
  | "hot_swap.pin.session_required"
  | "hot_swap.pin.no_active_adapter"
  | "hot_swap.pin.checkpoint_conflict"
  | "hot_swap.pin.session_limit"
  | "hot_swap.pin.not_found"
  | "hot_swap.queue.limit"
  | "hot_swap.queue.empty"
  | "hot_swap.queue.idempotent_conflict"
  | "hot_swap.boundary.apply_failed";

export type HotSwapTerminalReason = "TURN_COMPLETE" | "HARNESS_ERROR";

export type HotSwapTurnPinTelemetryEvent = {
  event:
    | "bindings.hot_swap.turn_pin"
    | "bindings.hot_swap.load_refuse"
    | "bindings.hot_swap.queue_enqueue"
    | "bindings.hot_swap.boundary_wait"
    | "bindings.hot_swap.boundary_swap";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  sessionId?: string;
  pinnedContentHash?: string;
  oldContentHash?: string;
  newContentHash?: string;
  pendingCount?: number;
  activeSessionCount?: number;
  terminalReason?: HotSwapTerminalReason;
  idempotentReplay?: boolean;
  failureClass?: HotSwapPinFailureClass | "adapter.load.mid_turn_refuse";
};

export class HotSwapTurnPinError extends Error {
  readonly obligation: HotSwapPinFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly sessionId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: HotSwapPinFailureClass;
      subjectId?: string;
      deviceId?: string;
      sessionId?: string;
    },
  ) {
    super(message);
    this.name = "HotSwapTurnPinError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.sessionId = meta.sessionId;
  }
}

export type SessionCheckpointPin = {
  schemaVersion: typeof HOT_SWAP_TURN_PIN_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  sessionId: string;
  pinnedContentHash: string;
  pinnedAt: string;
};

export type FirstTokenPinResult = {
  ok: true;
  pin: SessionCheckpointPin;
  idempotentReplay: boolean;
};

export type PendingAdapterSwap = {
  enqueueId: string;
  contentHash: string;
  manifest: AdapterDeltaManifestView;
  blobBytes: Buffer;
  enqueuedAt: string;
};

export type BoundarySwapResult =
  | {
      ok: true;
      applied: false;
      waitingOnActiveSessions: number;
      pendingCount: number;
      terminalReason: HotSwapTerminalReason;
      sessionId: string;
      releasedPin: SessionCheckpointPin | undefined;
    }
  | {
      ok: true;
      applied: true;
      terminalReason: HotSwapTerminalReason;
      sessionId: string;
      releasedPin: SessionCheckpointPin | undefined;
      oldContentHash: string | undefined;
      newContentHash: string;
      discardedPendingCount: number;
      load: AdapterLoadApplyResult;
      idempotentReplay: boolean;
    }
  | {
      ok: true;
      applied: false;
      idle: true;
      terminalReason: HotSwapTerminalReason;
      sessionId: string;
      releasedPin: SessionCheckpointPin | undefined;
      pendingCount: 0;
    };

/**
 * Bindings-side authority for session checkpoint pins and turn-boundary swaps.
 */
export class SlmRuntimeTurnPinningSeam {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly loader: SlmRuntimeAdapterLoader;
  private readonly onTelemetry:
    | ((event: HotSwapTurnPinTelemetryEvent) => void)
    | undefined;
  private readonly pins = new Map<string, SessionCheckpointPin>();
  private readonly pending: PendingAdapterSwap[] = [];
  private readonly byEnqueueId = new Map<string, PendingAdapterSwap>();
  private readonly completedTerminals = new Map<string, HotSwapTerminalReason>();

  constructor(options: {
    subjectId: string;
    deviceId: string;
    loader: SlmRuntimeAdapterLoader;
    onTelemetry?: (event: HotSwapTurnPinTelemetryEvent) => void;
  }) {
    this.subjectId = requireId(options.subjectId, "subjectId");
    this.deviceId = requireId(options.deviceId, "deviceId");
    this.loader = options.loader;
    this.onTelemetry = options.onTelemetry;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeSessionCount(): number {
    return this.pins.size;
  }

  /**
   * Capture the active adapter at first token. Replays for the same session
   * return the original pin; they can never repin to a newer checkpoint.
   */
  pinAtFirstToken(input: {
    subjectId: string;
    sessionId: string;
    pinnedAt?: string;
  }): FirstTokenPinResult {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");
    const existing = this.pins.get(sessionId);
    const activeHash = this.loader.activeContentHash;

    if (existing) {
      if (activeHash !== undefined && existing.pinnedContentHash !== activeHash) {
        this.emitFailure(
          "hot_swap.pin.checkpoint_conflict",
          sessionId,
          existing.pinnedContentHash,
        );
        throw new HotSwapTurnPinError(
          "session already pinned to a different checkpoint",
          {
            obligation: "hot_swap.pin.checkpoint_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
            sessionId,
          },
        );
      }
      this.onTelemetry?.({
        event: "bindings.hot_swap.turn_pin",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
        pinnedContentHash: existing.pinnedContentHash,
        idempotentReplay: true,
      });
      return { ok: true, pin: existing, idempotentReplay: true };
    }

    if (this.pins.size >= HOT_SWAP_SESSION_LIMIT) {
      this.emitFailure("hot_swap.pin.session_limit", sessionId);
      throw new HotSwapTurnPinError("session checkpoint pin limit exceeded", {
        obligation: "hot_swap.pin.session_limit",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
      });
    }
    if (!activeHash) {
      this.emitFailure("hot_swap.pin.no_active_adapter", sessionId);
      throw new HotSwapTurnPinError(
        "cannot pin turn without an active verified adapter",
        {
          obligation: "hot_swap.pin.no_active_adapter",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          sessionId,
        },
      );
    }

    const loaderPin = this.loader.beginTurn(sessionId);
    if (loaderPin.pinnedContentHash !== activeHash) {
      throw new HotSwapTurnPinError(
        "loader checkpoint changed while establishing turn pin",
        {
          obligation: "hot_swap.pin.checkpoint_conflict",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          sessionId,
        },
      );
    }

    const pin: SessionCheckpointPin = Object.freeze({
      schemaVersion: HOT_SWAP_TURN_PIN_SCHEMA_VERSION,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      sessionId,
      pinnedContentHash: activeHash,
      pinnedAt: input.pinnedAt ?? new Date().toISOString(),
    });
    this.pins.set(sessionId, pin);
    this.completedTerminals.delete(sessionId);
    this.onTelemetry?.({
      event: "bindings.hot_swap.turn_pin",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      sessionId,
      pinnedContentHash: activeHash,
      idempotentReplay: false,
    });
    return { ok: true, pin, idempotentReplay: false };
  }

  getPinnedCheckpoint(input: {
    subjectId: string;
    sessionId: string;
  }): SessionCheckpointPin {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");
    const pin = this.pins.get(sessionId);
    if (!pin) {
      throw new HotSwapTurnPinError("session checkpoint pin not found", {
        obligation: "hot_swap.pin.not_found",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
      });
    }
    return pin;
  }

  /**
   * Route immediate load attempts through the loader. While any turn is
   * active, the loader returns its typed mid-turn refusal.
   */
  loadAdapter(input: {
    subjectId: string;
    manifest: AdapterDeltaManifestView;
    blobBytes: Uint8Array;
    loadId?: string;
  }): AdapterLoadApplyResult {
    this.assertSubject(input.subjectId);
    try {
      return this.loader.loadAdapter({
        manifest: input.manifest,
        blobBytes: input.blobBytes,
        ...(input.loadId !== undefined ? { loadId: input.loadId } : {}),
      });
    } catch (error) {
      if (
        error instanceof AdapterLoadContractError &&
        error.obligation === "adapter.load.mid_turn_refuse"
      ) {
        this.onTelemetry?.({
          event: "bindings.hot_swap.load_refuse",
          outcome: "fail",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          failureClass: "adapter.load.mid_turn_refuse",
        });
      }
      throw error;
    }
  }

  /**
   * Queue a verified adapter delta. While sessions are pinned the load is
   * deferred; with no active pins the latest queued delta applies immediately.
   */
  enqueuePendingSwap(input: {
    subjectId: string;
    manifest: AdapterDeltaManifestView;
    blobBytes: Uint8Array;
    enqueueId?: string;
    enqueuedAt?: string;
  }): {
    ok: true;
    queued: PendingAdapterSwap;
    pendingCount: number;
    appliedImmediately: boolean;
    load?: AdapterLoadApplyResult;
    idempotentReplay: boolean;
  } {
    this.assertSubject(input.subjectId);
    if (input.manifest.subjectId !== this.subjectId) {
      throw new HotSwapTurnPinError(
        "pending swap subjectId must match seam subject",
        {
          obligation: "hot_swap.pin.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }

    const enqueueId =
      input.enqueueId?.trim() ||
      `enqueue:${input.manifest.contentHash}:${this.pending.length}`;
    const prior = this.byEnqueueId.get(enqueueId);
    if (prior) {
      if (prior.contentHash !== input.manifest.contentHash) {
        throw new HotSwapTurnPinError(
          "enqueueId replay with divergent contentHash",
          {
            obligation: "hot_swap.queue.idempotent_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
          },
        );
      }
      this.onTelemetry?.({
        event: "bindings.hot_swap.queue_enqueue",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        newContentHash: prior.contentHash,
        pendingCount: this.pending.length,
        idempotentReplay: true,
      });
      return {
        ok: true,
        queued: prior,
        pendingCount: this.pending.length,
        appliedImmediately: false,
        idempotentReplay: true,
      };
    }

    if (this.pending.length >= HOT_SWAP_PENDING_QUEUE_LIMIT) {
      throw new HotSwapTurnPinError("pending swap queue limit exceeded", {
        obligation: "hot_swap.queue.limit",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }

    const queued: PendingAdapterSwap = Object.freeze({
      enqueueId,
      contentHash: input.manifest.contentHash,
      manifest: input.manifest,
      blobBytes: Buffer.from(input.blobBytes),
      enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
    });
    this.pending.push(queued);
    this.byEnqueueId.set(enqueueId, queued);
    this.onTelemetry?.({
      event: "bindings.hot_swap.queue_enqueue",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      newContentHash: queued.contentHash,
      pendingCount: this.pending.length,
      activeSessionCount: this.pins.size,
      idempotentReplay: false,
    });

    if (this.pins.size > 0) {
      return {
        ok: true,
        queued,
        pendingCount: this.pending.length,
        appliedImmediately: false,
        idempotentReplay: false,
      };
    }

    const applied = this.applyLatestPendingUnlocked("TURN_COMPLETE");
    return {
      ok: true,
      queued,
      pendingCount: this.pending.length,
      appliedImmediately: applied.applied === true,
      ...(applied.applied === true ? { load: applied.load } : {}),
      idempotentReplay: false,
    };
  }

  /**
   * Terminal boundary: release the session pin, then apply the latest pending
   * delta only when every active session on this subject has completed.
   */
  onTerminalBoundary(input: {
    subjectId: string;
    sessionId: string;
    reason: HotSwapTerminalReason;
  }): BoundarySwapResult {
    this.assertSubject(input.subjectId);
    const sessionId = requireId(input.sessionId, "sessionId");
    const priorTerminal = this.completedTerminals.get(sessionId);
    if (priorTerminal !== undefined && !this.pins.has(sessionId)) {
      // Idempotent terminal replay — wait / drain / idle like a fresh boundary.
      if (this.pins.size > 0) {
        this.onTelemetry?.({
          event: "bindings.hot_swap.boundary_wait",
          outcome: "advisory",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          sessionId,
          terminalReason: input.reason,
          activeSessionCount: this.pins.size,
          pendingCount: this.pending.length,
          idempotentReplay: true,
        });
        return {
          ok: true,
          applied: false,
          waitingOnActiveSessions: this.pins.size,
          pendingCount: this.pending.length,
          terminalReason: input.reason,
          sessionId,
          releasedPin: undefined,
        };
      }
      if (this.pending.length > 0) {
        return this.applyLatestPendingUnlocked(
          input.reason,
          sessionId,
          undefined,
        );
      }
      return {
        ok: true,
        applied: false,
        idle: true,
        terminalReason: input.reason,
        sessionId,
        releasedPin: undefined,
        pendingCount: 0,
      };
    }

    let releasedPin: SessionCheckpointPin | undefined;
    if (this.pins.has(sessionId)) {
      releasedPin = this.releaseTerminalPin({
        subjectId: this.subjectId,
        sessionId,
      });
    }
    this.completedTerminals.set(sessionId, input.reason);
    if (this.completedTerminals.size > HOT_SWAP_SESSION_LIMIT * 2) {
      const first = this.completedTerminals.keys().next().value;
      if (first !== undefined) this.completedTerminals.delete(first);
    }

    if (this.pins.size > 0) {
      this.onTelemetry?.({
        event: "bindings.hot_swap.boundary_wait",
        outcome: "advisory",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        sessionId,
        terminalReason: input.reason,
        activeSessionCount: this.pins.size,
        pendingCount: this.pending.length,
        ...(releasedPin !== undefined
          ? { pinnedContentHash: releasedPin.pinnedContentHash }
          : {}),
      });
      return {
        ok: true,
        applied: false,
        waitingOnActiveSessions: this.pins.size,
        pendingCount: this.pending.length,
        terminalReason: input.reason,
        sessionId,
        releasedPin,
      };
    }

    if (this.pending.length === 0) {
      return {
        ok: true,
        applied: false,
        idle: true,
        terminalReason: input.reason,
        sessionId,
        releasedPin,
        pendingCount: 0,
      };
    }

    return this.applyLatestPendingUnlocked(input.reason, sessionId, releasedPin);
  }

  /**
   * Terminal-pin release primitive. Prefer {@link onTerminalBoundary} when a
   * pending swap may need to apply.
   */
  releaseTerminalPin(input: {
    subjectId: string;
    sessionId: string;
  }): SessionCheckpointPin {
    this.assertSubject(input.subjectId);
    const pin = this.getPinnedCheckpoint(input);
    this.loader.completeTurn(pin.sessionId);
    this.pins.delete(pin.sessionId);
    return pin;
  }

  private applyLatestPendingUnlocked(
    terminalReason: HotSwapTerminalReason,
    sessionId?: string,
    releasedPin?: SessionCheckpointPin,
  ): BoundarySwapResult {
    if (this.pending.length === 0) {
      throw new HotSwapTurnPinError("pending swap queue empty", {
        obligation: "hot_swap.queue.empty",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }

    const discardedPendingCount = Math.max(0, this.pending.length - 1);
    const latest = this.pending[this.pending.length - 1]!;
    this.pending.length = 0;
    this.byEnqueueId.clear();

    const oldContentHash = this.loader.activeContentHash;
    let load: AdapterLoadApplyResult;
    try {
      load = this.loader.loadAdapter({
        manifest: latest.manifest,
        blobBytes: latest.blobBytes,
        loadId: `boundary:${latest.enqueueId}`,
      });
    } catch (error) {
      // Re-queue latest so a later boundary / idle enqueue can retry after fix.
      this.pending.push(latest);
      this.byEnqueueId.set(latest.enqueueId, latest);
      this.onTelemetry?.({
        event: "bindings.hot_swap.boundary_swap",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        terminalReason,
        ...(oldContentHash !== undefined ? { oldContentHash } : {}),
        newContentHash: latest.contentHash,
        failureClass: "hot_swap.boundary.apply_failed",
      });
      throw new HotSwapTurnPinError(
        error instanceof Error
          ? `boundary swap apply failed: ${error.message}`
          : "boundary swap apply failed",
        {
          obligation: "hot_swap.boundary.apply_failed",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
      );
    }

    this.onTelemetry?.({
      event: "bindings.hot_swap.boundary_swap",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      terminalReason,
      ...(oldContentHash !== undefined ? { oldContentHash } : {}),
      newContentHash: load.applied.contentHash,
      pendingCount: 0,
      activeSessionCount: 0,
      idempotentReplay: load.idempotentReplay,
    });

    return {
      ok: true,
      applied: true,
      terminalReason,
      sessionId: sessionId ?? "",
      releasedPin,
      oldContentHash,
      newContentHash: load.applied.contentHash,
      discardedPendingCount,
      load,
      idempotentReplay: load.idempotentReplay,
    };
  }

  private assertSubject(subjectId: string): void {
    if (requireId(subjectId, "subjectId") !== this.subjectId) {
      this.emitFailure("hot_swap.pin.subject_scope");
      throw new HotSwapTurnPinError(
        "cross-subject session checkpoint access denied",
        {
          obligation: "hot_swap.pin.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
  }

  private emitFailure(
    failureClass: HotSwapPinFailureClass,
    sessionId?: string,
    pinnedContentHash?: string,
  ): void {
    this.onTelemetry?.({
      event: "bindings.hot_swap.turn_pin",
      outcome: "fail",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(pinnedContentHash !== undefined ? { pinnedContentHash } : {}),
      failureClass,
    });
  }
}

function requireId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new HotSwapTurnPinError(`${field} required`, {
      obligation:
        field === "sessionId"
          ? "hot_swap.pin.session_required"
          : "hot_swap.pin.subject_scope",
    });
  }
  return trimmed;
}
