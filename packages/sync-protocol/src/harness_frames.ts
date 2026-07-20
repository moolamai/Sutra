/**
 * Streaming harness frame wire contract.
 *
 * Cognition moves as a sequence of typed frames — never raw provider tokens.
 * Every variant carries type, monotonic sequenceIndex, correlationId, and
 * subjectId. Additive evolution only: new frame types are new union members.
 */

import { z } from "zod";
import {
  syncAdvisorySchema,
  type SyncAdvisory,
} from "./contract.js";
import {
  meterEventSchema,
  type MeterEvent,
} from "./metering.js";

/* ────────────────────────────────────────────────────────────────────────
 * Frame union
 *
 * METER_TICK.tick is bound to MeterEvent from metering.ts — metadata only.
 * ──────────────────────────────────────────────────────────────────────── */

/** Tool-call lifecycle states on TOOL_STATUS frames. */
export type ToolStatusState = "pending" | "running" | "success" | "error";

export type SessionStartFrame = {
  type: "SESSION_START";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  protocolVersion: string;
  pinnedAt: string;
};

export type ThoughtDeltaFrame = {
  type: "THOUGHT_DELTA";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  delta: string;
};

export type AnswerDeltaFrame = {
  type: "ANSWER_DELTA";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  delta: string;
};

export type ToolStatusFrame = {
  type: "TOOL_STATUS";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  toolCallId: string;
  status: ToolStatusState;
  /** Optional status detail — omit or string; never null. */
  detail?: string | undefined;
};

export type AdvisoryAttachFrame = {
  type: "ADVISORY_ATTACH";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  advisory: SyncAdvisory;
};

export type MeterTickFrame = {
  type: "METER_TICK";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  tick: MeterEvent;
};

export type TurnCompleteFrame = {
  type: "TURN_COMPLETE";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  turnId: string;
};

export type HarnessErrorFrame = {
  type: "HARNESS_ERROR";
  sequenceIndex: number;
  correlationId: string;
  subjectId: string;
  code: string;
  message: string;
  recoverable: boolean;
};

/** Discriminated union of every harness stream frame. */
export type HarnessFrame =
  | SessionStartFrame
  | ThoughtDeltaFrame
  | AnswerDeltaFrame
  | ToolStatusFrame
  | AdvisoryAttachFrame
  | MeterTickFrame
  | TurnCompleteFrame
  | HarnessErrorFrame;

export const HARNESS_FRAME_TYPES = Object.freeze([
  "SESSION_START",
  "THOUGHT_DELTA",
  "ANSWER_DELTA",
  "TOOL_STATUS",
  "ADVISORY_ATTACH",
  "METER_TICK",
  "TURN_COMPLETE",
  "HARNESS_ERROR",
] as const);

export type HarnessFrameType = (typeof HARNESS_FRAME_TYPES)[number];

const harnessFrameCommons = {
  sequenceIndex: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
  subjectId: z.string().min(1),
} as const;

export const sessionStartFrameSchema = z
  .object({
    type: z.literal("SESSION_START"),
    ...harnessFrameCommons,
    protocolVersion: z.string().min(1),
    pinnedAt: z.string().min(1),
  })
  .strict() satisfies z.ZodType<SessionStartFrame>;

export const thoughtDeltaFrameSchema = z
  .object({
    type: z.literal("THOUGHT_DELTA"),
    ...harnessFrameCommons,
    delta: z.string(),
  })
  .strict() satisfies z.ZodType<ThoughtDeltaFrame>;

export const answerDeltaFrameSchema = z
  .object({
    type: z.literal("ANSWER_DELTA"),
    ...harnessFrameCommons,
    delta: z.string(),
  })
  .strict() satisfies z.ZodType<AnswerDeltaFrame>;

export const toolStatusFrameSchema = z
  .object({
    type: z.literal("TOOL_STATUS"),
    ...harnessFrameCommons,
    toolCallId: z.string().min(1),
    status: z.enum(["pending", "running", "success", "error"]),
    detail: z.string().optional(),
  })
  .strict() satisfies z.ZodType<ToolStatusFrame>;

export const advisoryAttachFrameSchema = z
  .object({
    type: z.literal("ADVISORY_ATTACH"),
    ...harnessFrameCommons,
    advisory: syncAdvisorySchema,
  })
  .strict() satisfies z.ZodType<AdvisoryAttachFrame>;

export const meterTickFrameSchema = z
  .object({
    type: z.literal("METER_TICK"),
    ...harnessFrameCommons,
    tick: meterEventSchema,
  })
  .strict() satisfies z.ZodType<MeterTickFrame>;

export const turnCompleteFrameSchema = z
  .object({
    type: z.literal("TURN_COMPLETE"),
    ...harnessFrameCommons,
    turnId: z.string().min(1),
  })
  .strict() satisfies z.ZodType<TurnCompleteFrame>;

export const harnessErrorFrameSchema = z
  .object({
    type: z.literal("HARNESS_ERROR"),
    ...harnessFrameCommons,
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean(),
  })
  .strict() satisfies z.ZodType<HarnessErrorFrame>;

/** Wire-boundary Zod schema — parse, never cast. */
export const harnessFrameSchema = z.discriminatedUnion("type", [
  sessionStartFrameSchema,
  thoughtDeltaFrameSchema,
  answerDeltaFrameSchema,
  toolStatusFrameSchema,
  advisoryAttachFrameSchema,
  meterTickFrameSchema,
  turnCompleteFrameSchema,
  harnessErrorFrameSchema,
]) satisfies z.ZodType<HarnessFrame>;

/* ────────────────────────────────────────────────────────────────────────
 * Observability — parse outcomes (metadata only; never raw deltas)
 * ──────────────────────────────────────────────────────────────────────── */

/** Distinct failure classes for harness frame boundary validation. */
export const HARNESS_FRAME_FAILURE_CLASSES = Object.freeze([
  "unknown_type",
  "missing_subject",
  "invalid_sequence",
  "optional_nullable_mismatch",
  "unrecognized_keys",
  "schema_violation",
] as const);

export type HarnessFrameFailureClass =
  (typeof HARNESS_FRAME_FAILURE_CLASSES)[number];

export type HarnessFrameParseAccepted = {
  outcome: "accepted";
  subjectId: string;
  deviceId?: string;
  type: HarnessFrameType;
  sequenceIndex: number;
  frame: HarnessFrame;
};

export type HarnessFrameParseRejected = {
  outcome: "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass: HarnessFrameFailureClass;
  /** Zod issue path joined with dots — field name only, never payload text. */
  issuePath: string;
};

export type HarnessFrameParseResult =
  | HarnessFrameParseAccepted
  | HarnessFrameParseRejected;

function classifyFailure(
  issues: readonly { code: string; path: PropertyKey[]; message: string }[],
): { failureClass: HarnessFrameFailureClass; issuePath: string } {
  const first = issues[0];
  const issuePath = first
    ? first.path.map(String).join(".") || "(root)"
    : "(root)";

  if (!first) {
    return { failureClass: "schema_violation", issuePath };
  }
  if (first.code === "unrecognized_keys") {
    return { failureClass: "unrecognized_keys", issuePath };
  }
  if (first.path[0] === "type") {
    return { failureClass: "unknown_type", issuePath: "type" };
  }
  if (first.path[0] === "subjectId") {
    return { failureClass: "missing_subject", issuePath: "subjectId" };
  }
  if (first.path[0] === "sequenceIndex") {
    return { failureClass: "invalid_sequence", issuePath: "sequenceIndex" };
  }
  // Optional field present as null (e.g. TOOL_STATUS.detail: null).
  if (
    first.path.includes("detail") &&
    (first.code === "invalid_type" || /null/i.test(first.message))
  ) {
    return {
      failureClass: "optional_nullable_mismatch",
      issuePath: first.path.map(String).join("."),
    };
  }
  return { failureClass: "schema_violation", issuePath };
}

/**
 * Parse a wire frame at the trust boundary and return a structured outcome
 * suitable for telemetry: subjectId + outcome class, never thought/answer
 * delta text or meter prompt content.
 */
export function parseHarnessFrame(
  input: unknown,
  opts?: { deviceId?: string },
): HarnessFrameParseResult {
  const deviceId = opts?.deviceId;
  const peekSubject =
    input !== null &&
    typeof input === "object" &&
    "subjectId" in input &&
    typeof (input as { subjectId: unknown }).subjectId === "string" &&
    (input as { subjectId: string }).subjectId.length > 0
      ? (input as { subjectId: string }).subjectId
      : null;

  const parsed = harnessFrameSchema.safeParse(input);
  if (parsed.success) {
    return {
      outcome: "accepted",
      subjectId: parsed.data.subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      type: parsed.data.type,
      sequenceIndex: parsed.data.sequenceIndex,
      frame: parsed.data,
    };
  }

  const { failureClass, issuePath } = classifyFailure(parsed.error.issues);
  return {
    outcome: "rejected",
    subjectId: peekSubject,
    ...(deviceId !== undefined ? { deviceId } : {}),
    failureClass,
    issuePath,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * SequenceIndex session invariant
 * ──────────────────────────────────────────────────────────────────────── */

export type SequenceGapSignal = {
  ok: false;
  code: "SEQUENCE_GAP";
  subjectId: string;
  expected: number;
  actual: number;
};

export type SequenceOk = { ok: true };

/**
 * Assert monotonic contiguous sequenceIndex within a single session stream.
 * Gaps require an explicit HARNESS_ERROR or the reconnect/replay protocol —
 * never silent skip.
 */
export function assertMonotonicSequence(
  frames: readonly Pick<HarnessFrame, "sequenceIndex" | "subjectId">[],
): SequenceOk | SequenceGapSignal {
  if (frames.length === 0) return { ok: true };
  let expected = frames[0]!.sequenceIndex;
  const subjectId = frames[0]!.subjectId;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    if (frame.sequenceIndex !== expected) {
      return {
        ok: false,
        code: "SEQUENCE_GAP",
        subjectId: frame.subjectId || subjectId,
        expected,
        actual: frame.sequenceIndex,
      };
    }
    expected += 1;
  }
  return { ok: true };
}
