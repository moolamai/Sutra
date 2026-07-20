/**
 * StreamingTurnHost — B4 streaming turn protocol host.
 *
 * Frame types and Zod validation come from A P6
 * (`@moolam/sync-protocol` / `schemas/HarnessFrame.json`). This package
 * orchestrates turns; it does not redefine wire shapes.
 *
 * Typed emit helpers allocate monotonic sequenceIndex and validate against
 * the committed schema before buffering (SSE wire write is a later slice).
 */

import type { EventBusInterface } from "@moolam/contracts";
import {
  assertMonotonicSequence,
  harnessFrameSchema,
  parseHarnessFrame,
  parseMeterEvent,
  type HarnessErrorFrame,
  type HarnessFrame,
  type HarnessFrameType,
  type MeterEvent,
  type MeterTokenReconcileResult,
  type ProviderUsageReport,
  type SessionStartFrame,
  type SequenceGapSignal,
  type SyncAdvisory,
  type ToolStatusState,
  HARNESS_FRAME_TYPES,
} from "@moolam/sync-protocol";
import {
  STREAM_BUFFER_RESYNC_ADVISORY,
  type StreamBufferFailureClass,
  type StreamFrameBuffer,
} from "./stream_frame_buffer.js";
import {
  BudgetManager,
  runBudgetPreTurnGate,
  type BudgetPreTurnGateResult,
  type BudgetScope,
  type BudgetSpendChannels,
} from "./budget.js";
import {
  TurnMeter,
  assertTurnMeterSubjectScope,
  publishHarnessMeterSpine,
  reconcileMeterTokensWithinTolerance,
  type MeterTokenTolerance,
  type TurnMeterFailureClass,
  type TurnMeterFlushAccepted,
} from "./metering.js";
import type { ContextBudgetManager } from "./context_budget.js";
import {
  rehydrateSessionForTurn,
  type RehydrateSessionResult,
  type SessionDurableStore,
  type SessionDurableTelemetryEvent,
} from "./session_store.js";

/** HARNESS_ERROR.code when Last-Event-ID resume cannot replay losslessly. */
export const STREAM_RESUME_GAP_CODE = "SEQUENCE_GAP" as const;

/**
 * Committed A P6 schema path (repo-relative). Import types/runtime
 * validation via `@moolam/sync-protocol`; use this path for golden CI diffs.
 */
export const A_P6_HARNESS_FRAME_SCHEMA_PATH =
  "packages/sync-protocol/schemas/HarnessFrame.json" as const;

/** Soft cap on buffered frames per stream (NFR / hot-path bound). */
export const STREAMING_TURN_MAX_FRAMES = 256;

export const STREAMING_TURN_PROTOCOL_VERSION = "1.0.0";

/**
 * Default SSE heartbeat interval (seconds). Cloud host env override:
 * `SUTRA_SSE_HEARTBEAT_SECONDS`. Keep byte-identical with Python mirror.
 */
export const STREAMING_TURN_SSE_HEARTBEAT_SECONDS_DEFAULT = 15;

export type StreamingTurnFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "schema_violation"
  | "duplicate_sequence"
  | "sequence_gap"
  | "stream_already_terminated"
  | "stream_budget_exceeded"
  | "missing_terminal";

export type StreamResumeFailureClass =
  | "invalid_last_event_id"
  | "missing_buffer"
  | Extract<
      StreamBufferFailureClass,
      | "gap"
      | "empty_buffer"
      | "cross_subject"
      | "missing_subject"
      | "stream_mismatch"
    >;

/** Metadata-only stream telemetry (never thought/answer delta text). */
export type StreamingTurnEmitTelemetryEvent = {
  event: "runtime.harness.emit";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  correlationId?: string;
  frameType?: HarnessFrameType;
  sequenceIndex?: number;
  failureClass?: StreamingTurnFailureClass;
};

/** Metadata-only resume/reconnect telemetry (never frame payload text). */
export type StreamingTurnResumeTelemetryEvent = {
  event: "runtime.harness.resume";
  outcome: "ok" | "rejected";
  action: "fresh" | "replay" | "gap" | "reject";
  subjectId: string | null;
  deviceId?: string;
  correlationId?: string;
  lastSeenSequenceIndex?: number;
  replayCount?: number;
  failureClass?: StreamResumeFailureClass;
  advisory?: typeof STREAM_BUFFER_RESYNC_ADVISORY;
};

/** Metadata-only meter flush→emit outcomes (never token text payloads). */
export type StreamingTurnMeterEmitTelemetryEvent = {
  event: "runtime.harness.meter_emit";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  correlationId?: string;
  framesEmitted?: number;
  spinePublished?: number;
  discrepancy?: boolean;
  aborted?: boolean;
  replay?: boolean;
  failureClass?: FlushMeterFailureClass;
};

export type StreamingTurnRehydrateTelemetryEvent = {
  event: "runtime.harness.session_rehydrate";
  outcome: "ok" | "rejected" | "advisory";
  subjectId: string | null;
  sessionId: string | null;
  deviceId?: string;
  correlationId?: string;
  status?: "rehydrated" | "clean_session";
  skippedHistoryReplay?: true;
  correctionCount?: number;
  hasPlan?: boolean;
  hasSummary?: boolean;
  seededBudget?: boolean;
  failureClass?: string;
  advisory?: string;
};

export type StreamingTurnTelemetryEvent =
  | StreamingTurnEmitTelemetryEvent
  | StreamingTurnResumeTelemetryEvent
  | StreamingTurnMeterEmitTelemetryEvent
  | StreamingTurnBudgetGateTelemetryEvent
  | StreamingTurnRehydrateTelemetryEvent
  | SessionDurableTelemetryEvent;

export type GateBudgetBeforeModelUngated = {
  ok: true;
  proceed: true;
  decision: "allow";
  ungated: true;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
};

export type GateBudgetBeforeModelResult =
  | GateBudgetBeforeModelUngated
  | (BudgetPreTurnGateResult & {
      /** True when an open stream was terminated with HARNESS_ERROR. */
      streamTerminated?: boolean;
    });

export type LastEventIdParseAccepted =
  | { ok: true; kind: "absent" }
  | { ok: true; kind: "present"; lastSeenSequenceIndex: number };

export type LastEventIdParseRejected = {
  ok: false;
  failureClass: "invalid_last_event_id";
  detail: string;
};

export type LastEventIdParseResult =
  | LastEventIdParseAccepted
  | LastEventIdParseRejected;

export type StreamResumeFresh = {
  ok: true;
  action: "fresh";
  subjectId: string;
  streamId: string;
};

export type StreamResumeReplay = {
  ok: true;
  action: "replay";
  /** Attach only — do not restart in-flight tool execution. */
  attach: true;
  subjectId: string;
  streamId: string;
  lastSeenSequenceIndex: number;
  /** Frames with sequenceIndex > lastSeen (may be empty at tip). */
  frames: HarnessFrame[];
};

export type StreamResumeGap = {
  ok: false;
  action: "gap";
  subjectId: string | null;
  streamId: string;
  failureClass: StreamResumeFailureClass;
  advisory: typeof STREAM_BUFFER_RESYNC_ADVISORY;
  /** Terminal SEQUENCE_GAP frame for the wire; client must full resync. */
  gapFrame: HarnessErrorFrame;
  detail: string;
  lastSeenSequenceIndex?: number;
};

export type StreamResumeReject = {
  ok: false;
  action: "reject";
  subjectId: string | null;
  streamId: string;
  failureClass: StreamResumeFailureClass;
  detail: string;
  advisory?: typeof STREAM_BUFFER_RESYNC_ADVISORY;
};

export type StreamResumeResult =
  | StreamResumeFresh
  | StreamResumeReplay
  | StreamResumeGap
  | StreamResumeReject;

export type StreamingTurnHostOptions = {
  subjectId: string;
  correlationId: string;
  deviceId?: string;
  /** Optional session scope for P3 `harness.meter` spine payloads. */
  sessionId?: string;
  protocolVersion?: string;
  /** Optional sink for frames accepted onto the stream (SSE later). */
  onFrame?: (frame: HarnessFrame) => void;
  /** Optional metadata-only observability hook. */
  onTelemetry?: (event: StreamingTurnTelemetryEvent) => void;
  /**
   * Optional per-stream frame buffer (sequenceIndex index) for reconnect
   * replay. Must be scoped to the same subjectId + streamId(=correlationId).
   */
  frameBuffer?: StreamFrameBuffer;
  /**
   * Optional per-turn token collector (cached vs fresh split). Must be scoped
   * to the same subjectId. Use {@link flushMeter} to emit METER_TICK + spine.
   */
  turnMeter?: TurnMeter;
  /** Optional P3 EventBus for `harness.meter` publishes on flushMeter. */
  eventBus?: EventBusInterface;
  /**
   * Optional host BudgetManager. When set, call
   * {@link StreamingTurnHost.gateBudgetBeforeModel} before model invocation.
   */
  budgetManager?: BudgetManager;
  /**
   * Optional durable session store for {@link StreamingTurnHost.rehydrateSession}.
   * Loads profile / plan / compaction summary / corrections — no N-turn replay.
   */
  sessionStore?: SessionDurableStore;
  /**
   * Optional context-window budget manager seeded on rehydrate (distinct from
   * token {@link BudgetManager}).
   */
  contextBudget?: ContextBudgetManager;
};

/** Metadata-only budget gate outcomes (never prompt / completion text). */
export type StreamingTurnBudgetGateTelemetryEvent = {
  event: "runtime.harness.budget_gate";
  outcome: "ok" | "rejected" | "blocked";
  subjectId: string | null;
  deviceId?: string;
  correlationId?: string;
  decision?: "allow" | "throttle" | "hardStop";
  proceed?: boolean;
  advisoryCode?: string;
  harnessErrorCode?: string;
  remaining?: number;
  failureClass?: string;
};

export type FlushMeterFailureClass =
  | TurnMeterFailureClass
  | StreamingTurnFailureClass;

export type FlushMeterAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  events: MeterEvent[];
  framesEmitted: number;
  spinePublished: number;
  discrepancy: boolean;
  aborted: boolean;
  totalPromptTokens: number;
  replay?: boolean;
};

export type FlushMeterRejected = {
  ok: false;
  failureClass: FlushMeterFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
  framesEmitted?: number;
  spinePublished?: number;
};

export type FlushMeterResult = FlushMeterAccepted | FlushMeterRejected;

export type FlushMeterReconcileAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  flush: FlushMeterAccepted;
  reconcile: MeterTokenReconcileResult;
  discrepancy: boolean;
  totalPromptTokens: number;
};

export type FlushMeterReconcileRejected = {
  ok: false;
  failureClass: FlushMeterFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
  framesEmitted?: number;
  spinePublished?: number;
};

export type FlushMeterReconcileResult =
  | FlushMeterReconcileAccepted
  | FlushMeterReconcileRejected;

export type AttachTurnMeterAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
};

export type AttachTurnMeterRejected = {
  ok: false;
  failureClass: TurnMeterFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type AttachTurnMeterResult =
  | AttachTurnMeterAccepted
  | AttachTurnMeterRejected;

/** Payload body for typed emit — host fills sequenceIndex + scope ids. */
type EmitFrameBody =
  | { type: "SESSION_START"; protocolVersion: string; pinnedAt: string }
  | { type: "THOUGHT_DELTA"; delta: string }
  | { type: "ANSWER_DELTA"; delta: string }
  | {
      type: "TOOL_STATUS";
      toolCallId: string;
      status: ToolStatusState;
      detail?: string;
    }
  | { type: "ADVISORY_ATTACH"; advisory: SyncAdvisory }
  | { type: "METER_TICK"; tick: MeterEvent }
  | { type: "TURN_COMPLETE"; turnId: string }
  | {
      type: "HARNESS_ERROR";
      code: string;
      message: string;
      recoverable: boolean;
    };

export type StreamingTurnValidateAccepted = {
  ok: true;
  frame: HarnessFrame;
  subjectId: string;
  deviceId?: string;
};

export type StreamingTurnValidateRejected = {
  ok: false;
  failureClass: StreamingTurnFailureClass;
  issuePath: string;
  detail: string;
  subjectId: string | null;
  deviceId?: string;
};

export type StreamingTurnValidateResult =
  | StreamingTurnValidateAccepted
  | StreamingTurnValidateRejected;

/**
 * Subject-scoped streaming turn host with typed frame emitters.
 *
 * - Opens with SESSION_START; emit helpers per A P6 frame kind
 * - sequenceIndex allocator is contiguous and monotonic per stream
 * - Validates every frame against the committed schema before buffer/write
 * - Truncation / handler throw → terminateWithError (HARNESS_ERROR) before close
 */
export class StreamingTurnHost {
  readonly subjectId: string;
  readonly correlationId: string;
  readonly deviceId: string | undefined;
  readonly sessionId: string | undefined;
  readonly protocolVersion: string;

  private readonly frames: HarnessFrame[] = [];
  private nextSequenceIndex = 0;
  private terminated = false;
  private readonly onFrame: ((frame: HarnessFrame) => void) | undefined;
  private readonly onTelemetry:
    | ((event: StreamingTurnTelemetryEvent) => void)
    | undefined;
  private readonly frameBuffer: StreamFrameBuffer | undefined;
  private readonly eventBus: EventBusInterface | undefined;
  private readonly budgetManager: BudgetManager | undefined;
  private readonly sessionStore: SessionDurableStore | undefined;
  private readonly contextBudget: ContextBudgetManager | undefined;
  private turnMeter: TurnMeter | undefined;
  private meterFlushEmit: FlushMeterAccepted | undefined;
  private budgetReservationId: string | undefined;
  private lastRehydration: Extract<RehydrateSessionResult, { ok: true }> | undefined;

  /**
   * Parse Last-Event-ID and attach-replay from the host buffer, or emit a
   * SEQUENCE_GAP frame when lossless resume is impossible.
   *
   * On `action: "replay"`, callers must attach to the existing turn — never
   * restart an in-flight tool execution. On `action: "gap"`, open a new turn
   * (full resync); do not treat the gap as a tool retry.
   */
  resumeFromLastEventId(
    lastEventIdHeader: string | null | undefined,
  ): StreamResumeResult {
    return resolveStreamResume({
      lastEventIdHeader,
      buffer: this.frameBuffer,
      subjectId: this.subjectId,
      streamId: this.correlationId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      onTelemetry: (event) => this.onTelemetry?.(event),
    });
  }

  constructor(opts: StreamingTurnHostOptions) {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    const correlationId =
      typeof opts.correlationId === "string" ? opts.correlationId.trim() : "";
    if (!subjectId) {
      throw new Error("StreamingTurnHost requires non-empty subjectId");
    }
    if (!correlationId) {
      throw new Error("StreamingTurnHost requires non-empty correlationId");
    }
    if (opts.frameBuffer) {
      if (opts.frameBuffer.subjectId !== subjectId) {
        throw new Error(
          "frameBuffer.subjectId must match StreamingTurnHost subjectId",
        );
      }
      if (opts.frameBuffer.streamId !== correlationId) {
        throw new Error(
          "frameBuffer.streamId must match StreamingTurnHost correlationId",
        );
      }
    }
    this.subjectId = subjectId;
    this.correlationId = correlationId;
    this.deviceId = opts.deviceId;
    this.sessionId = opts.sessionId;
    this.protocolVersion =
      opts.protocolVersion ?? STREAMING_TURN_PROTOCOL_VERSION;
    this.onFrame = opts.onFrame;
    this.onTelemetry = opts.onTelemetry;
    this.frameBuffer = opts.frameBuffer;
    this.eventBus = opts.eventBus;
    this.budgetManager = opts.budgetManager;
    this.sessionStore = opts.sessionStore;
    this.contextBudget = opts.contextBudget;
    if (opts.contextBudget && opts.contextBudget.subjectId !== subjectId) {
      throw new Error(
        "contextBudget.subjectId must match StreamingTurnHost subjectId",
      );
    }
    if (opts.turnMeter) {
      const scope = assertTurnMeterSubjectScope(opts.turnMeter, subjectId);
      if (!scope.ok) {
        throw new Error(
          scope.failureClass === "missing_subject"
            ? "StreamingTurnHost requires non-empty subjectId for turnMeter"
            : "turnMeter.subjectId must match StreamingTurnHost subjectId",
        );
      }
      this.turnMeter = opts.turnMeter;
    }
  }

  /** Attached reconnect buffer, if any. */
  get buffer(): StreamFrameBuffer | undefined {
    return this.frameBuffer;
  }

  /** Attached TurnMeter collector, if any. */
  get meter(): TurnMeter | undefined {
    return this.turnMeter;
  }

  /** Attached BudgetManager, if any. */
  get budgets(): BudgetManager | undefined {
    return this.budgetManager;
  }

  /** Attached durable session store, if any. */
  get durableSessions(): SessionDurableStore | undefined {
    return this.sessionStore;
  }

  /** Last successful {@link rehydrateSession} result, if any. */
  get lastRehydrationResult():
    | Extract<RehydrateSessionResult, { ok: true }>
    | undefined {
    return this.lastRehydration;
  }

  /**
   * Resume from durable session state: load profile / plan / compaction
   * summary / corrections, seed context budget + dynamic block, skip full
   * history replay. Requires {@link StreamingTurnHostOptions.sessionStore}
   * and a non-empty {@link StreamingTurnHostOptions.sessionId}.
   */
  rehydrateSession(input: {
    utterance?: string;
    syncInFlight?: boolean;
    /** Injected clock for days-gap telemetry against durable updatedAtMs. */
    nowMs?: number;
  } = {}): RehydrateSessionResult {
    if (!this.sessionStore) {
      this.onTelemetry?.({
        event: "runtime.harness.session_rehydrate",
        outcome: "rejected",
        subjectId: this.subjectId,
        sessionId: this.sessionId ?? null,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        correlationId: this.correlationId,
        failureClass: "invalid_state",
      });
      return {
        ok: false,
        failureClass: "invalid_state",
        subjectId: this.subjectId,
        sessionId: this.sessionId ?? null,
        detail: "sessionStore required for rehydrateSession",
      };
    }
    const sessionId =
      typeof this.sessionId === "string" ? this.sessionId.trim() : "";
    if (!sessionId) {
      this.onTelemetry?.({
        event: "runtime.harness.session_rehydrate",
        outcome: "rejected",
        subjectId: this.subjectId,
        sessionId: null,
        correlationId: this.correlationId,
        failureClass: "missing_session",
      });
      return {
        ok: false,
        failureClass: "missing_session",
        subjectId: this.subjectId,
        sessionId: null,
        detail: "sessionId required for rehydrateSession",
      };
    }

    const result = rehydrateSessionForTurn({
      store: this.sessionStore,
      subjectId: this.subjectId,
      sessionId,
      ...(this.contextBudget !== undefined
        ? { budget: this.contextBudget }
        : {}),
      options: {
        ...(input.utterance !== undefined ? { utterance: input.utterance } : {}),
        ...(input.syncInFlight !== undefined
          ? { syncInFlight: input.syncInFlight }
          : {}),
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
        onTelemetry: (e) => this.onTelemetry?.(e),
      },
    });

    if (result.ok) {
      this.lastRehydration = result;
      this.onTelemetry?.({
        event: "runtime.harness.session_rehydrate",
        outcome: result.status === "clean_session" ? "advisory" : "ok",
        subjectId: result.subjectId,
        sessionId: result.sessionId,
        ...(result.deviceId !== undefined ? { deviceId: result.deviceId } : {}),
        correlationId: this.correlationId,
        status: result.status,
        skippedHistoryReplay: true,
        correctionCount: result.seed.correctionCount,
        hasPlan: result.seed.activePlan !== null,
        hasSummary: result.seed.compactionSummary !== null,
        seededBudget: result.contextBudgetSnapshot !== undefined,
        ...(result.advisory !== undefined
          ? { advisory: result.advisory }
          : {}),
      });
    } else {
      this.onTelemetry?.({
        event: "runtime.harness.session_rehydrate",
        outcome: "rejected",
        subjectId: result.subjectId,
        sessionId: result.sessionId,
        correlationId: this.correlationId,
        failureClass: result.failureClass,
      });
    }
    return result;
  }

  /** Active pre-turn reservation id, if gate held one. */
  get budgetReservationIdActive(): string | undefined {
    return this.budgetReservationId;
  }

  /**
   * Attach a subject-scoped TurnMeter. Cross-subject meters are rejected.
   * Replaces any previously attached meter for this host.
   */
  attachTurnMeter(meter: TurnMeter): AttachTurnMeterResult {
    const scope = assertTurnMeterSubjectScope(meter, this.subjectId);
    if (!scope.ok) {
      return {
        ok: false,
        failureClass: scope.failureClass,
        subjectId: scope.failureClass === "missing_subject" ? null : this.subjectId,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        detail:
          scope.failureClass === "cross_subject"
            ? "turnMeter.subjectId does not match stream scope"
            : "subjectId required for turn meter scope",
      };
    }
    this.turnMeter = meter;
    this.meterFlushEmit = undefined;
    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }

  /**
   * Pre-model budget gate. Must run before model invocation (not after).
   *
   * When a BudgetManager is attached: reserves estimated tokens, rejects
   * throttle/exceeded turns with a typed {@link BudgetAdvisory}, and — if the
   * stream already has frames — emits HARNESS_ERROR then terminates.
   * Without a BudgetManager the gate is a no-op allow.
   */
  async gateBudgetBeforeModel(
    estimatedTokens = 0,
  ): Promise<GateBudgetBeforeModelResult> {
    if (!this.budgetManager) {
      this.budgetGateTelemetry({
        outcome: "ok",
        decision: "allow",
        proceed: true,
      });
      return {
        ok: true,
        proceed: true,
        decision: "allow",
        ungated: true,
        subjectId: this.subjectId,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      };
    }

    const scope = this.budgetScope();
    const gated = await runBudgetPreTurnGate(
      this.budgetManager,
      scope,
      estimatedTokens,
    );

    if (!gated.ok) {
      this.budgetGateTelemetry({
        outcome: "rejected",
        proceed: false,
        failureClass: gated.failureClass,
      });
      return gated;
    }

    if (!gated.proceed) {
      let streamTerminated = false;
      if (this.frames.length > 0 && !this.terminated) {
        const term = this.terminateWithError(gated.harnessError);
        streamTerminated = term.ok;
      }
      this.budgetGateTelemetry({
        outcome: "blocked",
        decision: gated.decision,
        proceed: false,
        advisoryCode: gated.advisory.code,
        harnessErrorCode: gated.harnessError.code,
        remaining: gated.snapshot.remaining,
      });
      return { ...gated, streamTerminated };
    }

    this.budgetReservationId = gated.reservationId;
    this.budgetGateTelemetry({
      outcome: "ok",
      decision: "allow",
      proceed: true,
      remaining: gated.snapshot.remaining,
    });
    return gated;
  }

  /**
   * Commit the active pre-turn reservation after metering actual spend.
   * No-op when no reservation is held.
   */
  commitBudgetReservation(actual: BudgetSpendChannels):
    | { ok: true; subjectId: string; remaining: number }
    | {
        ok: false;
        failureClass: string;
        subjectId: string | null;
        detail: string;
      } {
    if (!this.budgetManager || !this.budgetReservationId) {
      return {
        ok: true,
        subjectId: this.subjectId,
        remaining: Number.POSITIVE_INFINITY,
      };
    }
    const committed = this.budgetManager.commitReservation(
      this.budgetScope(),
      this.budgetReservationId,
      actual,
    );
    if (!committed.ok) {
      return {
        ok: false,
        failureClass: committed.failureClass,
        subjectId: committed.subjectId,
        detail: committed.detail,
      };
    }
    this.budgetReservationId = undefined;
    return {
      ok: true,
      subjectId: this.subjectId,
      remaining: committed.snapshot.remaining,
    };
  }

  /**
   * Release the active pre-turn reservation (abort / failed turn with no spend).
   */
  releaseBudgetReservation():
    | { ok: true; subjectId: string }
    | {
        ok: false;
        failureClass: string;
        subjectId: string | null;
        detail: string;
      } {
    if (!this.budgetManager || !this.budgetReservationId) {
      return { ok: true, subjectId: this.subjectId };
    }
    const released = this.budgetManager.releaseReservation(
      this.budgetScope(),
      this.budgetReservationId,
    );
    if (!released.ok) {
      return {
        ok: false,
        failureClass: released.failureClass,
        subjectId: released.subjectId,
        detail: released.detail,
      };
    }
    this.budgetReservationId = undefined;
    return { ok: true, subjectId: this.subjectId };
  }

  /**
   * Flush the attached TurnMeter, schema-validate each tick, emit METER_TICK
   * frames, and publish P3 `harness.meter` spine events when an EventBus is
   * configured. Idempotent — replay returns the prior accepted emit result
   * without double-applying frames or spine publishes.
   */
  flushMeter(opts?: { aborted?: boolean }): FlushMeterResult {
    if (this.meterFlushEmit) {
      this.meterEmitTelemetry({
        outcome: "ok",
        framesEmitted: this.meterFlushEmit.framesEmitted,
        spinePublished: this.meterFlushEmit.spinePublished,
        discrepancy: this.meterFlushEmit.discrepancy,
        aborted: this.meterFlushEmit.aborted,
        replay: true,
      });
      return { ...this.meterFlushEmit, replay: true };
    }

    const meter = this.turnMeter;
    if (!meter) {
      return this.rejectMeterFlush(
        "missing_meter",
        "flushMeter requires an attached TurnMeter",
      );
    }

    const scope = assertTurnMeterSubjectScope(meter, this.subjectId);
    if (!scope.ok) {
      return this.rejectMeterFlush(
        scope.failureClass,
        scope.failureClass === "cross_subject"
          ? "turnMeter.subjectId does not match stream scope"
          : "subjectId required for turn meter scope",
      );
    }

    const flushed = meter.flush(
      opts?.aborted === true ? { aborted: true } : undefined,
    );
    if (!flushed.ok) {
      return this.rejectMeterFlush(flushed.failureClass, flushed.detail);
    }

    let framesEmitted = 0;
    for (const tick of flushed.events) {
      const boundary = parseMeterEvent(tick, {
        subjectId: this.subjectId,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      });
      if (boundary.outcome === "rejected") {
        return this.rejectMeterFlush(
          "schema_violation",
          `METER_TICK tick rejected: ${boundary.failureClass}`,
          framesEmitted,
          0,
        );
      }

      const emitted = this.emitMeterTick(boundary.event);
      if (!emitted.ok) {
        return this.rejectMeterFlush(
          emitted.failureClass,
          emitted.detail,
          framesEmitted,
          0,
        );
      }
      framesEmitted += 1;
    }

    let spinePublished = 0;
    if (this.eventBus) {
      const spine = publishHarnessMeterSpine(
        this.eventBus,
        flushed.events,
        {
          subjectId: this.subjectId,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
          ...(this.sessionId !== undefined
            ? { sessionId: this.sessionId }
            : {}),
        },
      );
      if (!spine.ok) {
        return this.rejectMeterFlush(
          spine.failureClass,
          spine.detail,
          framesEmitted,
          spine.published,
        );
      }
      spinePublished = spine.published;
    }

    const accepted = this.acceptMeterFlush(flushed, framesEmitted, spinePublished);
    this.meterFlushEmit = accepted;
    this.meterEmitTelemetry({
      outcome: "ok",
      framesEmitted,
      spinePublished,
      discrepancy: accepted.discrepancy,
      aborted: accepted.aborted,
    });
    return accepted;
  }

  /**
   * Flush meter ticks to the stream/spine, then reconcile totals against
   * provider-reported usage within the documented golden tolerance (default 0).
   */
  flushMeterAndReconcile(
    provider: ProviderUsageReport,
    opts?: { aborted?: boolean; tokenTolerance?: MeterTokenTolerance },
  ): FlushMeterReconcileResult {
    const meter = this.turnMeter;
    if (!meter) {
      return {
        ok: false,
        failureClass: "missing_meter",
        subjectId: this.subjectId,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        detail: "flushMeterAndReconcile requires an attached TurnMeter",
      };
    }

    if (!this.meterFlushEmit) {
      const set = meter.setProviderUsage(provider);
      if (!set.ok) {
        return {
          ok: false,
          failureClass: set.failureClass,
          subjectId: set.subjectId,
          ...(set.deviceId !== undefined ? { deviceId: set.deviceId } : {}),
          detail: set.detail,
        };
      }
    }

    const flush = this.flushMeter(
      opts?.aborted === true ? { aborted: true } : undefined,
    );
    if (!flush.ok) {
      return {
        ok: false,
        failureClass: flush.failureClass,
        subjectId: flush.subjectId,
        ...(flush.deviceId !== undefined ? { deviceId: flush.deviceId } : {}),
        detail: flush.detail,
        ...(flush.framesEmitted !== undefined
          ? { framesEmitted: flush.framesEmitted }
          : {}),
        ...(flush.spinePublished !== undefined
          ? { spinePublished: flush.spinePublished }
          : {}),
      };
    }

    const reconcile = reconcileMeterTokensWithinTolerance(
      {
        inputTokens: flush.events.reduce((n, e) => n + e.inputTokens, 0),
        outputTokens: flush.events.reduce((n, e) => n + e.outputTokens, 0),
        cachedInputTokens: flush.events.reduce(
          (n, e) => n + e.cachedInputTokens,
          0,
        ),
      },
      provider,
      opts?.tokenTolerance,
    );

    this.meterEmitTelemetry({
      outcome: "ok",
      framesEmitted: flush.framesEmitted,
      spinePublished: flush.spinePublished,
      discrepancy: flush.discrepancy || !reconcile.ok,
      aborted: flush.aborted,
      ...(flush.replay !== undefined ? { replay: flush.replay } : {}),
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      flush,
      reconcile,
      discrepancy: flush.discrepancy || !reconcile.ok,
      totalPromptTokens: flush.totalPromptTokens,
    };
  }

  /** Frame types frozen by A P6 — re-exported for host consumers. */
  static get frameTypes(): readonly HarnessFrameType[] {
    return HARNESS_FRAME_TYPES;
  }

  get sequenceLength(): number {
    return this.frames.length;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  /** Next sequenceIndex the allocator will assign (peek; does not consume). */
  peekNextSequenceIndex(): number {
    return this.nextSequenceIndex;
  }

  /** Snapshot of validated frames (copy — callers cannot mutate host buffer). */
  getFrames(): readonly HarnessFrame[] {
    return this.frames.slice();
  }

  /**
   * Build SESSION_START at the next allocated index (usually 0 on a fresh host).
   * Prefer {@link emitSessionStart} for validating onto the stream.
   */
  createSessionStart(
    pinnedAt: string = new Date().toISOString(),
  ): SessionStartFrame {
    return {
      type: "SESSION_START",
      sequenceIndex: this.nextSequenceIndex,
      correlationId: this.correlationId,
      subjectId: this.subjectId,
      protocolVersion: this.protocolVersion,
      pinnedAt,
    };
  }

  /* ── Typed emit helpers (sequenceIndex allocated internally) ───────── */

  emitSessionStart(
    pinnedAt: string = new Date().toISOString(),
  ): StreamingTurnValidateResult {
    return this.emitFrame({
      type: "SESSION_START",
      protocolVersion: this.protocolVersion,
      pinnedAt,
    });
  }

  emitThoughtDelta(delta: string): StreamingTurnValidateResult {
    return this.emitFrame({ type: "THOUGHT_DELTA", delta });
  }

  emitAnswerDelta(delta: string): StreamingTurnValidateResult {
    return this.emitFrame({ type: "ANSWER_DELTA", delta });
  }

  emitToolStatus(input: {
    toolCallId: string;
    status: ToolStatusState;
    detail?: string;
  }): StreamingTurnValidateResult {
    return this.emitFrame({
      type: "TOOL_STATUS",
      toolCallId: input.toolCallId,
      status: input.status,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    });
  }

  emitAdvisoryAttach(advisory: SyncAdvisory): StreamingTurnValidateResult {
    return this.emitFrame({ type: "ADVISORY_ATTACH", advisory });
  }

  emitMeterTick(tick: MeterEvent): StreamingTurnValidateResult {
    return this.emitFrame({ type: "METER_TICK", tick });
  }

  emitTurnComplete(turnId: string): StreamingTurnValidateResult {
    return this.emitFrame({ type: "TURN_COMPLETE", turnId });
  }

  emitHarnessError(input: {
    code: string;
    message: string;
    recoverable: boolean;
  }): StreamingTurnValidateResult {
    return this.emitFrame({
      type: "HARNESS_ERROR",
      code: input.code,
      message: input.message,
      recoverable: input.recoverable,
    });
  }

  /**
   * Terminal error wrapper: always emit HARNESS_ERROR before stream close.
   * Partial frames already on the stream remain valid. Idempotent reject if
   * the stream is already terminated.
   */
  terminateWithError(input: {
    code: string;
    message: string;
    recoverable: boolean;
  }): StreamingTurnValidateResult {
    if (this.terminated) {
      const rejected = reject(
        "stream_already_terminated",
        "stream",
        "stream already closed; cannot emit HARNESS_ERROR",
        this.subjectId,
        this.deviceId,
      );
      this.telemetry(rejected, "HARNESS_ERROR");
      return rejected;
    }
    // Drop unused reservation so aborted turns do not hold the shared budget.
    this.releaseBudgetReservation();
    // Partial spend must still attribute: emit METER_TICK + spine before close.
    if (this.turnMeter && !this.meterFlushEmit) {
      this.turnMeter.markAborted();
      const metered = this.flushMeter({ aborted: true });
      if (!metered.ok) {
        this.meterEmitTelemetry({
          outcome: "rejected",
          failureClass: metered.failureClass,
          framesEmitted: metered.framesEmitted ?? 0,
          spinePublished: metered.spinePublished ?? 0,
          aborted: true,
        });
      }
    }
    return this.emitHarnessError(input);
  }

  /**
   * Run a turn body; on throw, emit HARNESS_ERROR then rethrow.
   * Guarantees truncated/handler-thrown streams never close silently.
   */
  runGuarded(body: (host: StreamingTurnHost) => void): void {
    try {
      body(this);
    } catch (err) {
      if (!this.terminated) {
        this.terminateWithError({
          code: "HANDLER_THROWN",
          message:
            err instanceof Error
              ? err.message.slice(0, 256)
              : "turn handler threw",
          recoverable: true,
        });
      }
      throw err;
    }
  }

  /**
   * Validate a candidate frame against A P6 schema + this host's subject scope.
   * Metadata-only outcomes — never thought/answer delta text in telemetry.
   */
  validateForWire(input: unknown): StreamingTurnValidateResult {
    if (!this.subjectId) {
      return reject(
        "missing_subject",
        "subjectId",
        "subjectId required for stream scope",
        null,
        this.deviceId,
      );
    }

    const parsed = parseHarnessFrame(input, {
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    });
    if (parsed.outcome === "rejected") {
      return reject(
        parsed.failureClass === "missing_subject"
          ? "missing_subject"
          : "schema_violation",
        parsed.issuePath,
        `A P6 harness frame rejected: ${parsed.failureClass}`,
        parsed.subjectId,
        this.deviceId,
      );
    }

    if (parsed.frame.subjectId !== this.subjectId) {
      return reject(
        "cross_subject",
        "subjectId",
        "frame subjectId does not match stream scope",
        this.subjectId,
        this.deviceId,
      );
    }
    if (parsed.frame.correlationId !== this.correlationId) {
      return reject(
        "schema_violation",
        "correlationId",
        "frame correlationId does not match stream scope",
        this.subjectId,
        this.deviceId,
      );
    }

    // Double-check Zod path used by schema export pipeline.
    const zod = harnessFrameSchema.safeParse(parsed.frame);
    if (!zod.success) {
      return reject(
        "schema_violation",
        "frame",
        "harnessFrameSchema rejected frame",
        this.subjectId,
        this.deviceId,
      );
    }

    return {
      ok: true,
      frame: zod.data,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }

  /**
   * Append a validated frame to the stream buffer.
   * Enforces budget, termination, and contiguous sequenceIndex.
   */
  appendValidated(input: unknown): StreamingTurnValidateResult {
    if (this.terminated) {
      const rejected = reject(
        "stream_already_terminated",
        "stream",
        "cannot append after TURN_COMPLETE or HARNESS_ERROR",
        this.subjectId,
        this.deviceId,
      );
      this.telemetry(rejected);
      return rejected;
    }
    if (this.frames.length >= STREAMING_TURN_MAX_FRAMES) {
      const rejected = reject(
        "stream_budget_exceeded",
        "frames",
        `frame budget ${STREAMING_TURN_MAX_FRAMES} exceeded`,
        this.subjectId,
        this.deviceId,
      );
      this.telemetry(rejected);
      return rejected;
    }

    const validated = this.validateForWire(input);
    if (!validated.ok) {
      this.telemetry(validated);
      return validated;
    }

    const frame = validated.frame;
    if (frame.sequenceIndex !== this.nextSequenceIndex) {
      const rejected = reject(
        frame.sequenceIndex < this.nextSequenceIndex
          ? "duplicate_sequence"
          : "sequence_gap",
        "sequenceIndex",
        `expected sequenceIndex ${this.nextSequenceIndex}, got ${frame.sequenceIndex}`,
        this.subjectId,
        this.deviceId,
      );
      this.telemetry(rejected, frame.type, frame.sequenceIndex);
      return rejected;
    }

    this.frames.push(frame);
    this.nextSequenceIndex += 1;

    if (frame.type === "TURN_COMPLETE" || frame.type === "HARNESS_ERROR") {
      this.terminated = true;
    }

    // Replay buffer is best-effort; failures must not unwind a valid emit
    // (buffer telemetry carries failureClass). Side effects already happened.
    this.frameBuffer?.append(frame);

    this.onFrame?.(frame);
    this.telemetry(validated, frame.type, frame.sequenceIndex);
    return validated;
  }

  /**
   * Allocate the next sequenceIndex and emit a typed frame body.
   */
  private emitFrame(body: EmitFrameBody): StreamingTurnValidateResult {
    const sequenceIndex = this.nextSequenceIndex;
    const candidate = {
      ...body,
      sequenceIndex,
      correlationId: this.correlationId,
      subjectId: this.subjectId,
    };
    return this.appendValidated(candidate);
  }

  private acceptMeterFlush(
    flushed: TurnMeterFlushAccepted,
    framesEmitted: number,
    spinePublished: number,
  ): FlushMeterAccepted {
    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      events: flushed.events,
      framesEmitted,
      spinePublished,
      discrepancy: flushed.discrepancy,
      aborted: flushed.aborted,
      totalPromptTokens: flushed.totalPromptTokens,
    };
  }

  private rejectMeterFlush(
    failureClass: FlushMeterFailureClass,
    detail: string,
    framesEmitted?: number,
    spinePublished?: number,
  ): FlushMeterRejected {
    const rejected: FlushMeterRejected = {
      ok: false,
      failureClass,
      subjectId: failureClass === "missing_subject" ? null : this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
      ...(framesEmitted !== undefined ? { framesEmitted } : {}),
      ...(spinePublished !== undefined ? { spinePublished } : {}),
    };
    this.meterEmitTelemetry({
      outcome: "rejected",
      failureClass,
      framesEmitted: framesEmitted ?? 0,
      spinePublished: spinePublished ?? 0,
    });
    return rejected;
  }

  private meterEmitTelemetry(
    partial: Omit<
      StreamingTurnMeterEmitTelemetryEvent,
      "event" | "subjectId" | "deviceId" | "correlationId"
    > & { subjectId?: string | null },
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.meter_emit",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : this.subjectId,
      correlationId: this.correlationId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
    });
  }

  private budgetScope(): BudgetScope {
    return {
      subjectId: this.subjectId,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }

  private budgetGateTelemetry(
    partial: Omit<
      StreamingTurnBudgetGateTelemetryEvent,
      "event" | "subjectId" | "deviceId" | "correlationId"
    > & { subjectId?: string | null },
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.budget_gate",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : this.subjectId,
      correlationId: this.correlationId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
    });
  }

  private telemetry(
    result: StreamingTurnValidateResult,
    frameType?: HarnessFrameType,
    sequenceIndex?: number,
  ): void {
    if (!this.onTelemetry) return;
    const event: StreamingTurnEmitTelemetryEvent = {
      event: "runtime.harness.emit",
      outcome: result.ok ? "ok" : "rejected",
      subjectId: result.subjectId,
      correlationId: this.correlationId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...(frameType !== undefined ? { frameType } : {}),
      ...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
      ...(!result.ok ? { failureClass: result.failureClass } : {}),
    };
    this.onTelemetry(event);
  }

  /**
   * Assert the buffered stream has contiguous sequenceIndex values.
   */
  assertMonotonic():
    | { ok: true; subjectId: string }
    | (SequenceGapSignal & { failureClass: "sequence_gap" }) {
    const result = assertMonotonicSequence(this.frames);
    if (result.ok) {
      return { ok: true, subjectId: this.subjectId };
    }
    return { ...result, failureClass: "sequence_gap" as const };
  }

  /**
   * Scaffold close: streams must terminate with TURN_COMPLETE or HARNESS_ERROR.
   */
  assertTerminalPresent(): StreamingTurnValidateResult {
    if (!this.terminated) {
      return reject(
        "missing_terminal",
        "frames",
        "stream must end with TURN_COMPLETE or HARNESS_ERROR",
        this.subjectId,
        this.deviceId,
      );
    }
    const last = this.frames[this.frames.length - 1];
    if (
      !last ||
      (last.type !== "TURN_COMPLETE" && last.type !== "HARNESS_ERROR")
    ) {
      return reject(
        "missing_terminal",
        "frames",
        "last frame is not a terminal type",
        this.subjectId,
        this.deviceId,
      );
    }
    return {
      ok: true,
      frame: last,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }
}

function reject(
  failureClass: StreamingTurnFailureClass,
  issuePath: string,
  detail: string,
  subjectId: string | null,
  deviceId: string | undefined,
): StreamingTurnValidateRejected {
  return {
    ok: false,
    failureClass,
    issuePath,
    detail,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  };
}

/**
 * Parse the SSE `Last-Event-ID` header (decimal sequenceIndex string).
 * Absent / whitespace-only → fresh stream. Non-decimal → invalid.
 */
export function parseLastEventId(
  raw: string | null | undefined,
): LastEventIdParseResult {
  if (raw === null || raw === undefined) {
    return { ok: true, kind: "absent" };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      failureClass: "invalid_last_event_id",
      detail: "Last-Event-ID must be a decimal sequenceIndex string",
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, kind: "absent" };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      failureClass: "invalid_last_event_id",
      detail: `Last-Event-ID must be a non-negative decimal integer; got ${JSON.stringify(trimmed)}`,
    };
  }
  const lastSeenSequenceIndex = Number(trimmed);
  if (
    !Number.isSafeInteger(lastSeenSequenceIndex) ||
    lastSeenSequenceIndex < 0
  ) {
    return {
      ok: false,
      failureClass: "invalid_last_event_id",
      detail: "Last-Event-ID is not a safe non-negative integer",
    };
  }
  return { ok: true, kind: "present", lastSeenSequenceIndex };
}

/**
 * Build a terminal SEQUENCE_GAP HARNESS_ERROR for client full resync.
 * sequenceIndex is the first index that could not be replayed (or 0).
 */
export function buildSequenceGapFrame(opts: {
  subjectId: string;
  correlationId: string;
  sequenceIndex: number;
  detail: string;
}): HarnessErrorFrame {
  const frame: HarnessErrorFrame = {
    type: "HARNESS_ERROR",
    sequenceIndex: opts.sequenceIndex,
    correlationId: opts.correlationId,
    subjectId: opts.subjectId,
    code: STREAM_RESUME_GAP_CODE,
    message: `${opts.detail}; advisory=${STREAM_BUFFER_RESYNC_ADVISORY}`,
    recoverable: false,
  };
  const parsed = harnessFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(
      `SEQUENCE_GAP frame failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data as HarnessErrorFrame;
}

export type ResolveStreamResumeOptions = {
  lastEventIdHeader: string | null | undefined;
  /** Per-stream buffer to attach; null/undefined → gap when resume requested. */
  buffer: StreamFrameBuffer | null | undefined;
  subjectId: string;
  streamId: string;
  deviceId?: string;
  onTelemetry?: (event: StreamingTurnResumeTelemetryEvent) => void;
};

/**
 * Last-Event-ID resume decision: fresh open, lossless attach-replay, GAP, or reject.
 *
 * Replay is idempotent (same frames may be re-delivered). Callers must not
 * restart tools on `action: "replay"` — attach to existing turn state only.
 */
export function resolveStreamResume(
  opts: ResolveStreamResumeOptions,
): StreamResumeResult {
  const subjectId =
    typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
  const streamId =
    typeof opts.streamId === "string" ? opts.streamId.trim() : "";
  const deviceId = opts.deviceId;

  const emitResume = (
    partial: Omit<
      StreamingTurnResumeTelemetryEvent,
      "event" | "subjectId" | "deviceId" | "correlationId"
    > & { subjectId?: string | null },
  ): void => {
    if (!opts.onTelemetry) return;
    const event: StreamingTurnResumeTelemetryEvent = {
      event: "runtime.harness.resume",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : subjectId || null,
      outcome: partial.outcome,
      action: partial.action,
      ...(streamId ? { correlationId: streamId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(partial.lastSeenSequenceIndex !== undefined
        ? { lastSeenSequenceIndex: partial.lastSeenSequenceIndex }
        : {}),
      ...(partial.replayCount !== undefined
        ? { replayCount: partial.replayCount }
        : {}),
      ...(partial.failureClass !== undefined
        ? { failureClass: partial.failureClass }
        : {}),
      ...(partial.advisory !== undefined ? { advisory: partial.advisory } : {}),
    };
    opts.onTelemetry(event);
  };

  if (!subjectId) {
    const detail = "subjectId required for resume scope";
    emitResume({
      outcome: "rejected",
      action: "reject",
      subjectId: null,
      failureClass: "missing_subject",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "reject",
      subjectId: null,
      streamId: streamId || "",
      failureClass: "missing_subject",
      detail,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    };
  }

  if (!streamId) {
    const detail = "streamId required for resume scope";
    emitResume({
      outcome: "rejected",
      action: "reject",
      failureClass: "stream_mismatch",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "reject",
      subjectId,
      streamId: "",
      failureClass: "stream_mismatch",
      detail,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    };
  }

  const parsed = parseLastEventId(opts.lastEventIdHeader);
  if (!parsed.ok) {
    const gapFrame = buildSequenceGapFrame({
      subjectId,
      correlationId: streamId,
      sequenceIndex: 0,
      detail: parsed.detail,
    });
    emitResume({
      outcome: "rejected",
      action: "gap",
      failureClass: "invalid_last_event_id",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "gap",
      subjectId,
      streamId,
      failureClass: "invalid_last_event_id",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
      gapFrame,
      detail: parsed.detail,
    };
  }

  if (parsed.kind === "absent") {
    emitResume({ outcome: "ok", action: "fresh" });
    return { ok: true, action: "fresh", subjectId, streamId };
  }

  const lastSeenSequenceIndex = parsed.lastSeenSequenceIndex;

  if (!opts.buffer) {
    const detail =
      "no stream buffer available; full resync required (server restart or expired stream)";
    const gapFrame = buildSequenceGapFrame({
      subjectId,
      correlationId: streamId,
      sequenceIndex: lastSeenSequenceIndex + 1,
      detail,
    });
    emitResume({
      outcome: "rejected",
      action: "gap",
      lastSeenSequenceIndex,
      failureClass: "missing_buffer",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "gap",
      subjectId,
      streamId,
      failureClass: "missing_buffer",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
      gapFrame,
      detail,
      lastSeenSequenceIndex,
    };
  }

  if (opts.buffer.subjectId !== subjectId) {
    const detail = "buffer subjectId does not match resume subjectId";
    emitResume({
      outcome: "rejected",
      action: "reject",
      lastSeenSequenceIndex,
      failureClass: "cross_subject",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "reject",
      subjectId,
      streamId,
      failureClass: "cross_subject",
      detail,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    };
  }

  if (opts.buffer.streamId !== streamId) {
    const detail = "buffer streamId does not match resume streamId";
    emitResume({
      outcome: "rejected",
      action: "reject",
      lastSeenSequenceIndex,
      failureClass: "stream_mismatch",
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "reject",
      subjectId,
      streamId,
      failureClass: "stream_mismatch",
      detail,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    };
  }

  const replay = opts.buffer.framesAfter(lastSeenSequenceIndex);
  if (!replay.ok) {
    const detail = replay.detail;
    const gapFrame = buildSequenceGapFrame({
      subjectId: replay.subjectId ?? subjectId,
      correlationId: streamId,
      sequenceIndex: lastSeenSequenceIndex + 1,
      detail,
    });
    emitResume({
      outcome: "rejected",
      action: "gap",
      lastSeenSequenceIndex,
      failureClass: replay.failureClass,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
    return {
      ok: false,
      action: "gap",
      subjectId: replay.subjectId,
      streamId,
      failureClass: replay.failureClass,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
      gapFrame,
      detail,
      lastSeenSequenceIndex,
    };
  }

  emitResume({
    outcome: "ok",
    action: "replay",
    lastSeenSequenceIndex,
    replayCount: replay.frames.length,
  });
  return {
    ok: true,
    action: "replay",
    attach: true,
    subjectId: replay.subjectId,
    streamId: replay.streamId,
    lastSeenSequenceIndex,
    frames: replay.frames,
  };
}
