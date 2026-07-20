/**
 * Replay A P6 golden-turn inputs through ToolCallParser and assemble
 * HarnessFrame[] for byte-identical comparison to committed expectedFrames.
 *
 * Parser is pure (no IO / no tool execution). Frame assembly mirrors the A P6
 * reference contract (session start, tool status, advisory, terminal).
 */

import {
  parseToolCallEnvelopeJson,
  sortKeysDeep,
  type GoldenTurnFixture,
  type HarnessFrame,
} from "@moolam/sync-protocol";
import {
  ToolCallParser,
  type ParseEvent,
  type ToolCallParserTelemetryEvent,
} from "./tool_call_parser.js";
import { unifiedDiff } from "./unified_diff.js";

const MAX_FRAMES = 64;
const STUB_PROTOCOL_VERSION = "1.0.0";
const STUB_PINNED_AT = "2026-07-15T00:00:00.000Z";
const STUB_ADVISORY = Object.freeze({
  code: "CLOCK_SKEW_CLAMPED",
  detail: "clamped remote physical",
});
const STUB_METER_TICK = Object.freeze({
  inputTokens: 12,
  outputTokens: 4,
  cachedInputTokens: 2,
  latencyMs: 35,
  modelId: "slm-local",
  locality: "on-device" as const,
  aborted: false,
});
const STUB_TRUNCATION = Object.freeze({
  code: "STREAM_TRUNCATED",
  message: "peer closed before TURN_COMPLETE",
  recoverable: true,
});
const DEFAULT_TOOL_CALL_ID = "c1";
const TRUNCATED_RE = /^<stream truncated>$/i;

export type GoldenReplayFailureClass =
  | "missing_subject"
  | "invalid_input"
  | "frame_budget_exceeded"
  | "canonical_drift"
  | "cross_subject";

export type GoldenReplayTelemetryEvent = {
  event: "runtime.harness.golden_replay";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  correlationId?: string;
  turnId?: string;
  frameCount?: number;
  failureClass?: GoldenReplayFailureClass;
};

export type GoldenReplayAccepted = {
  ok: true;
  frames: HarnessFrame[];
  canonicalJson: string;
  subjectId: string;
  deviceId: string;
  turnId: string;
};

export type GoldenReplayRejected = {
  ok: false;
  failureClass: GoldenReplayFailureClass;
  issuePath: string;
  detail: string;
  subjectId: string | null;
  deviceId: string | null;
  /** Unified diff when drift was detected (empty otherwise). */
  diff: string;
};

export type GoldenReplayResult = GoldenReplayAccepted | GoldenReplayRejected;

export type ReplayGoldenTurnOptions = {
  /**
   * When true (default), feed fixture.input as discrete chunks.
   * When false, join chunks and feed once (must match for purity).
   */
  chunked?: boolean;
  onTelemetry?: (event: GoldenReplayTelemetryEvent) => void;
  onParserTelemetry?: (event: ToolCallParserTelemetryEvent) => void;
};

/** Canonical JSON for a frame list (sorted keys, 2-space indent, trailing NL). */
export function canonicalizeFramesJson(frames: unknown): string {
  return `${JSON.stringify(sortKeysDeep(frames), null, 2)}\n`;
}

/**
 * Feed golden `input` through ToolCallParser, assemble HarnessFrames, and
 * return canonical JSON for byte-compare to `expectedFrames`.
 */
export function replayGoldenTurn(
  fixture: GoldenTurnFixture,
  opts: ReplayGoldenTurnOptions = {},
): GoldenReplayResult {
  const subjectId =
    typeof fixture.subjectId === "string" ? fixture.subjectId.trim() : "";
  const deviceId =
    typeof fixture.deviceId === "string" ? fixture.deviceId.trim() : "";
  const correlationId =
    typeof fixture.correlationId === "string"
      ? fixture.correlationId.trim()
      : "";
  const turnId = fixture.id;

  const emitTel = (
    partial: Omit<GoldenReplayTelemetryEvent, "event" | "subjectId"> & {
      subjectId?: string | null;
    },
  ): void => {
    if (!opts.onTelemetry) return;
    opts.onTelemetry({
      event: "runtime.harness.golden_replay",
      subjectId:
        partial.subjectId !== undefined ? partial.subjectId : subjectId || null,
      outcome: partial.outcome,
      ...(deviceId ? { deviceId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(partial.turnId !== undefined ? { turnId: partial.turnId } : { turnId }),
      ...(partial.frameCount !== undefined
        ? { frameCount: partial.frameCount }
        : {}),
      ...(partial.failureClass !== undefined
        ? { failureClass: partial.failureClass }
        : {}),
    });
  };

  if (!subjectId) {
    emitTel({
      outcome: "rejected",
      subjectId: null,
      failureClass: "missing_subject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      issuePath: "subjectId",
      detail: "subjectId required for golden replay scope",
      subjectId: null,
      deviceId: deviceId || null,
      diff: "",
    };
  }
  if (!correlationId) {
    emitTel({ outcome: "rejected", failureClass: "invalid_input" });
    return {
      ok: false,
      failureClass: "invalid_input",
      issuePath: "correlationId",
      detail: "correlationId required",
      subjectId,
      deviceId: deviceId || null,
      diff: "",
    };
  }
  if (!Array.isArray(fixture.input) || fixture.input.length < 1) {
    emitTel({ outcome: "rejected", failureClass: "invalid_input" });
    return {
      ok: false,
      failureClass: "invalid_input",
      issuePath: "input",
      detail: "input must be a non-empty string[]",
      subjectId,
      deviceId: deviceId || null,
      diff: "",
    };
  }

  const frames: HarnessFrame[] = [];
  let seq = 0;
  let pendingToolSuccess: string | null = null;
  let truncated = false;

  const push = (frame: Record<string, unknown>): GoldenReplayRejected | null => {
    if (frames.length >= MAX_FRAMES) {
      return {
        ok: false,
        failureClass: "frame_budget_exceeded",
        issuePath: "frames",
        detail: `frame budget ${MAX_FRAMES} exceeded`,
        subjectId,
        deviceId: deviceId || null,
        diff: "",
      };
    }
    const next = {
      ...frame,
      sequenceIndex: seq++,
      correlationId,
      subjectId,
    } as HarnessFrame;
    if (next.subjectId !== subjectId) {
      return {
        ok: false,
        failureClass: "cross_subject",
        issuePath: "subjectId",
        detail: "assembled frame subjectId mismatch",
        subjectId,
        deviceId: deviceId || null,
        diff: "",
      };
    }
    frames.push(next);
    return null;
  };

  {
    const err = push({
      type: "SESSION_START",
      protocolVersion: STUB_PROTOCOL_VERSION,
      pinnedAt: STUB_PINNED_AT,
    });
    if (err) {
      emitTel({ outcome: "rejected", failureClass: err.failureClass });
      return err;
    }
  }

  const parser = new ToolCallParser({
    subjectId,
    ...(deviceId ? { deviceId } : {}),
    ...(opts.onParserTelemetry ? { onTelemetry: opts.onParserTelemetry } : {}),
  });

  const applyEvents = (events: ParseEvent[]): GoldenReplayRejected | null => {
    for (const ev of events) {
      if (ev.type === "mode_change" || ev.type === "tool_buffer_delta") {
        continue;
      }
      if (ev.type === "violation") {
        // Truncation is handled before feed; other violations are protocol noise
        // for golden assembly (do not forward as answer).
        continue;
      }
      if (ev.type === "thought_delta") {
        const err = push({ type: "THOUGHT_DELTA", delta: ev.delta });
        if (err) return err;
        continue;
      }
      if (ev.type === "tool_buffer") {
        const parsed = parseToolCallEnvelopeJson(ev.body);
        if (!parsed.ok) {
          const err = push({
            type: "TOOL_STATUS",
            toolCallId: DEFAULT_TOOL_CALL_ID,
            status: "error",
          });
          if (err) return err;
          pendingToolSuccess = null;
          continue;
        }
        const first = parsed.envelope[0];
        const toolCallId =
          typeof first?.callId === "string" && first.callId.length > 0
            ? first.callId
            : DEFAULT_TOOL_CALL_ID;
        const err = push({
          type: "TOOL_STATUS",
          toolCallId,
          status: "running",
        });
        if (err) return err;
        pendingToolSuccess = toolCallId;
        continue;
      }
      if (ev.type === "answer_delta") {
        if (pendingToolSuccess) {
          const flush = push({
            type: "TOOL_STATUS",
            toolCallId: pendingToolSuccess,
            status: "success",
          });
          if (flush) return flush;
          pendingToolSuccess = null;
        }
        const err = push({ type: "ANSWER_DELTA", delta: ev.delta });
        if (err) return err;
      }
    }
    return null;
  };

  const chunks =
    opts.chunked === false ? [fixture.input.join("")] : fixture.input;

  for (const chunk of chunks) {
    if (TRUNCATED_RE.test(chunk)) {
      // Truncation sentinel is not parse input. Flush held close-fences first
      // (EOF completes `\n``` ` at chunk end), then drop pending success.
      truncated = true;
      const flushErr = applyEvents(parser.end());
      if (flushErr) {
        emitTel({ outcome: "rejected", failureClass: flushErr.failureClass });
        return flushErr;
      }
      pendingToolSuccess = null;
      break;
    }
    const err = applyEvents(parser.feed(chunk));
    if (err) {
      emitTel({ outcome: "rejected", failureClass: err.failureClass });
      return err;
    }
  }
  if (!truncated) {
    const endErr = applyEvents(parser.end());
    if (endErr) {
      emitTel({ outcome: "rejected", failureClass: endErr.failureClass });
      return endErr;
    }
  }

  {
    const err = push({
      type: "ADVISORY_ATTACH",
      advisory: { ...STUB_ADVISORY },
    });
    if (err) {
      emitTel({ outcome: "rejected", failureClass: err.failureClass });
      return err;
    }
  }

  if (truncated) {
    const err = push({
      type: "HARNESS_ERROR",
      ...STUB_TRUNCATION,
    });
    if (err) {
      emitTel({ outcome: "rejected", failureClass: err.failureClass });
      return err;
    }
  } else {
    if (pendingToolSuccess) {
      const flush = push({
        type: "TOOL_STATUS",
        toolCallId: pendingToolSuccess,
        status: "success",
      });
      if (flush) {
        emitTel({ outcome: "rejected", failureClass: flush.failureClass });
        return flush;
      }
      pendingToolSuccess = null;
    }
    if (fixture.coverage.includes("meter_tick")) {
      const err = push({
        type: "METER_TICK",
        tick: { ...STUB_METER_TICK },
      });
      if (err) {
        emitTel({ outcome: "rejected", failureClass: err.failureClass });
        return err;
      }
    }
    const doneTurnId = correlationId.replace(/^corr-/, "turn-");
    const err = push({ type: "TURN_COMPLETE", turnId: doneTurnId });
    if (err) {
      emitTel({ outcome: "rejected", failureClass: err.failureClass });
      return err;
    }
  }

  const canonicalJson = canonicalizeFramesJson(frames);
  const expectedJson = canonicalizeFramesJson(fixture.expectedFrames);
  if (canonicalJson !== expectedJson) {
    const diff = unifiedDiff(expectedJson, canonicalJson, {
      fromFile: `golden/${turnId}.expected.json`,
      toFile: `golden/${turnId}.actual.json`,
    });
    emitTel({
      outcome: "rejected",
      failureClass: "canonical_drift",
      frameCount: frames.length,
    });
    return {
      ok: false,
      failureClass: "canonical_drift",
      issuePath: "expectedFrames",
      detail: `GOLDEN_TURN_DRIFT:${turnId}`,
      subjectId,
      deviceId: deviceId || null,
      diff,
    };
  }

  emitTel({
    outcome: "ok",
    frameCount: frames.length,
  });
  return {
    ok: true,
    frames,
    canonicalJson,
    subjectId,
    deviceId,
    turnId,
  };
}

/**
 * Replay every fixture in a loaded corpus; first drift wins with unified diff.
 */
export function replayGoldenTurnCorpus(
  fixtures: readonly GoldenTurnFixture[],
  opts: ReplayGoldenTurnOptions = {},
): {
  ok: true;
  turnCount: number;
} | {
  ok: false;
  failureClass: GoldenReplayFailureClass;
  turnId: string;
  detail: string;
  diff: string;
  subjectId: string | null;
} {
  for (const fixture of fixtures) {
    const result = replayGoldenTurn(fixture, opts);
    if (!result.ok) {
      return {
        ok: false,
        failureClass: result.failureClass,
        turnId: fixture.id,
        detail: result.detail,
        diff: result.diff,
        subjectId: result.subjectId,
      };
    }
  }
  return { ok: true, turnCount: fixtures.length };
}
