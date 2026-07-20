/**
 * Per-stream harness frame buffer indexed by sequenceIndex.
 *
 * In-memory now; {@link StreamFrameBuffer} is the seam for a Redis-backed
 * implementation later. Retention is bounded — eviction sets a resync advisory.
 * Last-Event-ID resume attach/gap policy is layered in `streaming_turn.ts`.
 */

import {
  harnessFrameSchema,
  type HarnessFrame,
  type HarnessFrameType,
} from "@moolam/sync-protocol";

/** Default retention window (frames per stream). Soft NFR bound. */
export const STREAM_FRAME_BUFFER_RETENTION_DEFAULT = 128;

/** Hard ceiling — never retain more than the host stream budget. */
export const STREAM_FRAME_BUFFER_RETENTION_MAX = 256;

/** Advisory code when eviction or empty buffer forces client full resync. */
export const STREAM_BUFFER_RESYNC_ADVISORY = "RESYNC_REQUIRED" as const;

export type StreamBufferFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "schema_violation"
  | "stream_mismatch"
  | "gap"
  | "empty_buffer"
  | "retention_invalid";

export type StreamBufferTelemetryEvent = {
  event: "runtime.harness.buffer";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  streamId?: string;
  sequenceIndex?: number;
  frameType?: HarnessFrameType;
  failureClass?: StreamBufferFailureClass;
  advisory?: typeof STREAM_BUFFER_RESYNC_ADVISORY;
  retained?: number;
  evicted?: number;
};

export type StreamBufferAppendAccepted = {
  ok: true;
  subjectId: string;
  streamId: string;
  sequenceIndex: number;
  /** True when the same sequenceIndex was re-stored (idempotent re-delivery). */
  idempotentReplay: boolean;
  retained: number;
  /** True when oldest frames were dropped to stay in the retention window. */
  evictionOccurred: boolean;
  advisory: typeof STREAM_BUFFER_RESYNC_ADVISORY | null;
};

export type StreamBufferAppendRejected = {
  ok: false;
  failureClass: StreamBufferFailureClass;
  issuePath: string;
  detail: string;
  subjectId: string | null;
  streamId: string;
  deviceId?: string;
};

export type StreamBufferAppendResult =
  | StreamBufferAppendAccepted
  | StreamBufferAppendRejected;

export type StreamBufferReplayAccepted = {
  ok: true;
  subjectId: string;
  streamId: string;
  /** Frames with sequenceIndex > lastSeenSequenceIndex, ascending. */
  frames: HarnessFrame[];
};

export type StreamBufferReplayRejected = {
  ok: false;
  failureClass: Extract<
    StreamBufferFailureClass,
    "gap" | "empty_buffer" | "cross_subject" | "missing_subject" | "stream_mismatch"
  >;
  issuePath: string;
  detail: string;
  subjectId: string | null;
  streamId: string;
  advisory: typeof STREAM_BUFFER_RESYNC_ADVISORY;
  deviceId?: string;
};

export type StreamBufferReplayResult =
  | StreamBufferReplayAccepted
  | StreamBufferReplayRejected;

/**
 * Storage seam for per-stream frames. In-memory today; Redis later.
 */
export interface StreamFrameBuffer {
  readonly subjectId: string;
  readonly streamId: string;
  readonly deviceId: string | undefined;
  readonly retentionWindow: number;

  /** Frames currently retained. */
  readonly size: number;
  /** Lowest retained sequenceIndex, or null if empty. */
  readonly minSequenceIndex: number | null;
  /** Highest retained sequenceIndex, or null if empty. */
  readonly maxSequenceIndex: number | null;
  /** True after eviction trimmed the window (client may need full resync). */
  readonly resyncAdvisoryPending: boolean;

  append(frame: unknown): StreamBufferAppendResult;
  getBySequenceIndex(sequenceIndex: number): HarnessFrame | undefined;
  /**
   * Frames strictly after ``lastSeenSequenceIndex``.
   * GAP + RESYNC_REQUIRED when the next index is missing / was never issued /
   * was already evicted.
   */
  framesAfter(lastSeenSequenceIndex: number): StreamBufferReplayResult;
  clear(): void;
}

export type InMemoryStreamFrameBufferOptions = {
  subjectId: string;
  /** Stable per-connection / turn stream id (e.g. correlationId). */
  streamId: string;
  deviceId?: string;
  /**
   * Max frames retained. Oldest (lowest sequenceIndex) evicted first.
   * Clamped to [1, STREAM_FRAME_BUFFER_RETENTION_MAX].
   */
  retentionWindow?: number;
  onTelemetry?: (event: StreamBufferTelemetryEvent) => void;
};

/**
 * In-memory Map keyed by sequenceIndex with sliding retention.
 */
export class InMemoryStreamFrameBuffer implements StreamFrameBuffer {
  readonly subjectId: string;
  readonly streamId: string;
  readonly deviceId: string | undefined;
  readonly retentionWindow: number;

  private readonly bySequence = new Map<number, HarnessFrame>();
  private _resyncAdvisoryPending = false;
  private readonly onTelemetry:
    | ((event: StreamBufferTelemetryEvent) => void)
    | undefined;

  constructor(opts: InMemoryStreamFrameBufferOptions) {
    const subjectId =
      typeof opts.subjectId === "string" ? opts.subjectId.trim() : "";
    const streamId =
      typeof opts.streamId === "string" ? opts.streamId.trim() : "";
    if (!subjectId) {
      throw new Error("InMemoryStreamFrameBuffer requires non-empty subjectId");
    }
    if (!streamId) {
      throw new Error("InMemoryStreamFrameBuffer requires non-empty streamId");
    }
    const window =
      typeof opts.retentionWindow === "number" &&
      Number.isInteger(opts.retentionWindow)
        ? opts.retentionWindow
        : STREAM_FRAME_BUFFER_RETENTION_DEFAULT;
    if (window < 1 || window > STREAM_FRAME_BUFFER_RETENTION_MAX) {
      throw new Error(
        `retentionWindow must be in [1, ${STREAM_FRAME_BUFFER_RETENTION_MAX}]`,
      );
    }
    this.subjectId = subjectId;
    this.streamId = streamId;
    this.deviceId = opts.deviceId;
    this.retentionWindow = window;
    this.onTelemetry = opts.onTelemetry;
  }

  get size(): number {
    return this.bySequence.size;
  }

  get minSequenceIndex(): number | null {
    if (this.bySequence.size === 0) return null;
    return Math.min(...this.bySequence.keys());
  }

  get maxSequenceIndex(): number | null {
    if (this.bySequence.size === 0) return null;
    return Math.max(...this.bySequence.keys());
  }

  get resyncAdvisoryPending(): boolean {
    return this._resyncAdvisoryPending;
  }

  append(input: unknown): StreamBufferAppendResult {
    const parsed = harnessFrameSchema.safeParse(input);
    if (!parsed.success) {
      return this.rejectAppend(
        "schema_violation",
        "frame",
        "harnessFrameSchema rejected frame",
        null,
      );
    }
    const frame = parsed.data;
    if (frame.subjectId !== this.subjectId) {
      return this.rejectAppend(
        "cross_subject",
        "subjectId",
        "frame subjectId does not match buffer scope",
        this.subjectId,
      );
    }
    if (frame.correlationId !== this.streamId) {
      return this.rejectAppend(
        "stream_mismatch",
        "correlationId",
        "frame correlationId does not match buffer streamId",
        this.subjectId,
      );
    }

    const existing = this.bySequence.get(frame.sequenceIndex);
    if (existing !== undefined) {
      // Idempotent re-delivery: accept without side-effect mutation.
      this.telemetry({
        outcome: "ok",
        subjectId: this.subjectId,
        sequenceIndex: frame.sequenceIndex,
        frameType: frame.type,
        retained: this.bySequence.size,
      });
      return {
        ok: true,
        subjectId: this.subjectId,
        streamId: this.streamId,
        sequenceIndex: frame.sequenceIndex,
        idempotentReplay: true,
        retained: this.bySequence.size,
        evictionOccurred: false,
        advisory: null,
      };
    }

    this.bySequence.set(frame.sequenceIndex, frame);
    let evicted = 0;
    while (this.bySequence.size > this.retentionWindow) {
      const min = this.minSequenceIndex;
      if (min === null) break;
      this.bySequence.delete(min);
      evicted += 1;
      this._resyncAdvisoryPending = true;
    }

    const advisory = this._resyncAdvisoryPending
      ? STREAM_BUFFER_RESYNC_ADVISORY
      : null;
    this.telemetry({
      outcome: "ok",
      subjectId: this.subjectId,
      sequenceIndex: frame.sequenceIndex,
      frameType: frame.type,
      retained: this.bySequence.size,
      ...(evicted > 0 ? { evicted, advisory: STREAM_BUFFER_RESYNC_ADVISORY } : {}),
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      streamId: this.streamId,
      sequenceIndex: frame.sequenceIndex,
      idempotentReplay: false,
      retained: this.bySequence.size,
      evictionOccurred: evicted > 0,
      advisory,
    };
  }

  getBySequenceIndex(sequenceIndex: number): HarnessFrame | undefined {
    return this.bySequence.get(sequenceIndex);
  }

  framesAfter(lastSeenSequenceIndex: number): StreamBufferReplayResult {
    if (!this.subjectId) {
      return {
        ok: false,
        failureClass: "missing_subject",
        issuePath: "subjectId",
        detail: "subjectId required for replay scope",
        subjectId: null,
        streamId: this.streamId,
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      };
    }
    if (this.bySequence.size === 0) {
      // Server restart / cleared buffer — client must full resync.
      this.telemetry({
        outcome: "rejected",
        subjectId: this.subjectId,
        failureClass: "empty_buffer",
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        retained: 0,
      });
      return {
        ok: false,
        failureClass: "empty_buffer",
        issuePath: "buffer",
        detail: "buffer empty; full resync required",
        subjectId: this.subjectId,
        streamId: this.streamId,
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      };
    }

    if (!Number.isInteger(lastSeenSequenceIndex) || lastSeenSequenceIndex < -1) {
      return {
        ok: false,
        failureClass: "gap",
        issuePath: "lastSeenSequenceIndex",
        detail: "lastSeenSequenceIndex must be an integer >= -1",
        subjectId: this.subjectId,
        streamId: this.streamId,
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      };
    }

    const next = lastSeenSequenceIndex + 1;
    const min = this.minSequenceIndex!;
    const max = this.maxSequenceIndex!;

    // Resume from a sequence never issued on this stream.
    if (lastSeenSequenceIndex > max) {
      this.telemetry({
        outcome: "rejected",
        subjectId: this.subjectId,
        sequenceIndex: next,
        failureClass: "gap",
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        retained: this.bySequence.size,
      });
      return {
        ok: false,
        failureClass: "gap",
        issuePath: "sequenceIndex",
        detail: `sequenceIndex ${lastSeenSequenceIndex} never issued; full resync required`,
        subjectId: this.subjectId,
        streamId: this.streamId,
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      };
    }

    // Already at tip — idempotent empty replay (no duplicate side effects).
    if (lastSeenSequenceIndex === max) {
      this.telemetry({
        outcome: "ok",
        subjectId: this.subjectId,
        retained: this.bySequence.size,
      });
      return {
        ok: true,
        subjectId: this.subjectId,
        streamId: this.streamId,
        frames: [],
      };
    }

    // Next frame was evicted (retention slid past it).
    if (next < min) {
      this.telemetry({
        outcome: "rejected",
        subjectId: this.subjectId,
        sequenceIndex: next,
        failureClass: "gap",
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        retained: this.bySequence.size,
      });
      return {
        ok: false,
        failureClass: "gap",
        issuePath: "sequenceIndex",
        detail: `sequenceIndex ${next} evicted; full resync required`,
        subjectId: this.subjectId,
        streamId: this.streamId,
        advisory: STREAM_BUFFER_RESYNC_ADVISORY,
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      };
    }

    // Contiguous walk from next; any hole → GAP.
    const frames: HarnessFrame[] = [];
    for (let i = next; i <= max; i++) {
      const frame = this.bySequence.get(i);
      if (!frame) {
        this.telemetry({
          outcome: "rejected",
          subjectId: this.subjectId,
          sequenceIndex: i,
          failureClass: "gap",
          advisory: STREAM_BUFFER_RESYNC_ADVISORY,
          retained: this.bySequence.size,
        });
        return {
          ok: false,
          failureClass: "gap",
          issuePath: "sequenceIndex",
          detail: `gap at sequenceIndex ${i}; full resync required`,
          subjectId: this.subjectId,
          streamId: this.streamId,
          advisory: STREAM_BUFFER_RESYNC_ADVISORY,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        };
      }
      if (frame.subjectId !== this.subjectId) {
        return {
          ok: false,
          failureClass: "cross_subject",
          issuePath: "subjectId",
          detail: "buffered frame subject mismatch",
          subjectId: this.subjectId,
          streamId: this.streamId,
          advisory: STREAM_BUFFER_RESYNC_ADVISORY,
          ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        };
      }
      frames.push(frame);
    }

    this.telemetry({
      outcome: "ok",
      subjectId: this.subjectId,
      retained: this.bySequence.size,
      sequenceIndex: next,
    });
    return {
      ok: true,
      subjectId: this.subjectId,
      streamId: this.streamId,
      frames,
    };
  }

  clear(): void {
    this.bySequence.clear();
    this._resyncAdvisoryPending = true;
    this.telemetry({
      outcome: "ok",
      subjectId: this.subjectId,
      retained: 0,
      advisory: STREAM_BUFFER_RESYNC_ADVISORY,
    });
  }

  private rejectAppend(
    failureClass: StreamBufferFailureClass,
    issuePath: string,
    detail: string,
    subjectId: string | null,
  ): StreamBufferAppendRejected {
    const rejected: StreamBufferAppendRejected = {
      ok: false,
      failureClass,
      issuePath,
      detail,
      subjectId,
      streamId: this.streamId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
    this.telemetry({
      outcome: "rejected",
      subjectId,
      failureClass,
    });
    return rejected;
  }

  private telemetry(
    partial: Omit<StreamBufferTelemetryEvent, "event" | "streamId" | "deviceId"> &
      Partial<Pick<StreamBufferTelemetryEvent, "deviceId">>,
  ): void {
    if (!this.onTelemetry) return;
    this.onTelemetry({
      event: "runtime.harness.buffer",
      streamId: this.streamId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
    });
  }
}
