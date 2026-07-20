/**
 * Reference parser stub for golden-turn validation.
 *
 * Stand-in until B4 lands: consumes input chunks + subject-scoped context and
 * emits HarnessFrame[] that must match committed goldens byte-identically when
 * canonicalized. Not a public package export.
 */

import {
  parseToolCallEnvelopeJson,
  sortKeysDeep,
} from "../dist/index.js";

const MAX_CHUNKS = 64;
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
  locality: "on-device",
  aborted: false,
});
const STUB_TRUNCATION = Object.freeze({
  code: "STREAM_TRUNCATED",
  message: "peer closed before TURN_COMPLETE",
  recoverable: true,
});
const DEFAULT_TOOL_CALL_ID = "c1";

const THOUGHT_RE = /^<thought>([\s\S]*)<\/thought>$/;
const TOOL_FENCE_RE = /^```tool_call\n([\s\S]*?)\n```$/i;
const TRUNCATED_RE = /^<stream truncated>$/i;

/**
 * @typedef {{
 *   subjectId: string,
 *   correlationId: string,
 *   deviceId: string,
 *   coverage?: string[],
 * }} GoldenTurnParseContext
 */

/**
 * @typedef {{
 *   ok: true,
 *   frames: object[],
 *   subjectId: string,
 *   deviceId: string,
 * }} GoldenTurnParseAccepted
 */

/**
 * @typedef {{
 *   ok: false,
 *   failureClass:
 *     | "missing_subject"
 *     | "invalid_input"
 *     | "frame_budget_exceeded"
 *     | "schema_violation",
 *   issuePath: string,
 *   detail: string,
 *   subjectId: string | null,
 *   deviceId: string | null,
 * }} GoldenTurnParseRejected
 */

/**
 * Canonical JSON for a frame list (sorted keys, 2-space indent, trailing newline).
 * @param {unknown} frames
 */
export function canonicalizeFramesJson(frames) {
  return `${JSON.stringify(sortKeysDeep(frames), null, 2)}\n`;
}

/**
 * Consume raw stream chunks → HarnessFrame[] (reference stub).
 * Pure and idempotent for the same (input, context).
 *
 * @param {string[]} input
 * @param {GoldenTurnParseContext} context
 * @returns {GoldenTurnParseAccepted | GoldenTurnParseRejected}
 */
export function parseGoldenTurnStub(input, context) {
  const subjectId =
    typeof context?.subjectId === "string" ? context.subjectId : "";
  const deviceId =
    typeof context?.deviceId === "string" ? context.deviceId : null;
  const correlationId =
    typeof context?.correlationId === "string" ? context.correlationId : "";

  if (!subjectId) {
    return reject(
      "missing_subject",
      "subjectId",
      "subjectId required for parse scope",
      null,
      deviceId,
    );
  }
  if (!correlationId) {
    return reject(
      "invalid_input",
      "correlationId",
      "correlationId required",
      subjectId,
      deviceId,
    );
  }
  if (!Array.isArray(input) || input.length < 1) {
    return reject(
      "invalid_input",
      "input",
      "input must be a non-empty string[]",
      subjectId,
      deviceId,
    );
  }
  if (input.length > MAX_CHUNKS) {
    return reject(
      "frame_budget_exceeded",
      "input",
      `input exceeds ${MAX_CHUNKS} chunks`,
      subjectId,
      deviceId,
    );
  }
  for (const [i, chunk] of input.entries()) {
    if (typeof chunk !== "string") {
      return reject(
        "invalid_input",
        `input[${i}]`,
        "chunk must be a string",
        subjectId,
        deviceId,
      );
    }
  }

  const coverage = Array.isArray(context.coverage) ? context.coverage : [];
  const frames = [];
  let seq = 0;
  let pendingToolSuccess = null;
  let truncated = false;

  const push = (frame) => {
    if (frames.length >= MAX_FRAMES) {
      return reject(
        "frame_budget_exceeded",
        "expectedFrames",
        `frame budget ${MAX_FRAMES} exceeded`,
        subjectId,
        deviceId,
      );
    }
    frames.push({
      ...frame,
      sequenceIndex: seq++,
      correlationId,
      subjectId,
    });
    return null;
  };

  {
    const err = push({
      type: "SESSION_START",
      protocolVersion: STUB_PROTOCOL_VERSION,
      pinnedAt: STUB_PINNED_AT,
    });
    if (err) return err;
  }

  for (const chunk of input) {
    if (TRUNCATED_RE.test(chunk)) {
      truncated = true;
      pendingToolSuccess = null;
      break;
    }

    const thought = chunk.match(THOUGHT_RE);
    if (thought) {
      const err = push({ type: "THOUGHT_DELTA", delta: thought[1] });
      if (err) return err;
      continue;
    }

    const fence = chunk.match(TOOL_FENCE_RE);
    if (fence) {
      const body = fence[1];
      const parsed = parseToolCallEnvelopeJson(body);
      if (!parsed.ok) {
        const err = push({
          type: "TOOL_STATUS",
          toolCallId: DEFAULT_TOOL_CALL_ID,
          status: "error",
        });
        if (err) return err;
        continue;
      }
      const first = parsed.envelope[0];
      const toolCallId =
        typeof first?.callId === "string" && first.callId.length > 0
          ? first.callId
          : DEFAULT_TOOL_CALL_ID;
      const runErr = push({
        type: "TOOL_STATUS",
        toolCallId,
        status: "running",
      });
      if (runErr) return runErr;
      pendingToolSuccess = toolCallId;
      continue;
    }

    if (pendingToolSuccess) {
      const flush = push({
        type: "TOOL_STATUS",
        toolCallId: pendingToolSuccess,
        status: "success",
      });
      if (flush) return flush;
      pendingToolSuccess = null;
    }
    const ansErr = push({ type: "ANSWER_DELTA", delta: chunk });
    if (ansErr) return ansErr;
  }

  const advErr = push({
    type: "ADVISORY_ATTACH",
    advisory: { ...STUB_ADVISORY },
  });
  if (advErr) return advErr;

  if (truncated) {
    const herr = push({
      type: "HARNESS_ERROR",
      ...STUB_TRUNCATION,
    });
    if (herr) return herr;
  } else {
    if (pendingToolSuccess) {
      const flush = push({
        type: "TOOL_STATUS",
        toolCallId: pendingToolSuccess,
        status: "success",
      });
      if (flush) return flush;
      pendingToolSuccess = null;
    }
    if (coverage.includes("meter_tick")) {
      const meterErr = push({
        type: "METER_TICK",
        tick: { ...STUB_METER_TICK },
      });
      if (meterErr) return meterErr;
    }
    const turnId = correlationId.replace(/^corr-/, "turn-");
    const done = push({ type: "TURN_COMPLETE", turnId });
    if (done) return done;
  }

  if (frames.length > MAX_FRAMES) {
    return reject(
      "frame_budget_exceeded",
      "expectedFrames",
      `frame budget ${MAX_FRAMES} exceeded`,
      subjectId,
      deviceId,
    );
  }

  return {
    ok: true,
    frames,
    subjectId,
    deviceId: deviceId ?? "",
  };
}

/**
 * Parse golden input and return canonical frame JSON, or a typed reject.
 * @param {string[]} input
 * @param {GoldenTurnParseContext} context
 */
export function parseGoldenTurnStubCanonical(input, context) {
  const result = parseGoldenTurnStub(input, context);
  if (!result.ok) return result;
  return {
    ok: true,
    canonicalJson: canonicalizeFramesJson(result.frames),
    frames: result.frames,
    subjectId: result.subjectId,
    deviceId: result.deviceId,
  };
}

function reject(failureClass, issuePath, detail, subjectId, deviceId) {
  return {
    ok: false,
    failureClass,
    issuePath,
    detail,
    subjectId,
    deviceId,
  };
}
