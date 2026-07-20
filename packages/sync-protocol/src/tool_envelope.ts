/**
 * Fenced-JSON tool-call envelope wire contract.
 *
 * Model-agnostic grammar: a single tool-call object or a non-empty array of
 * calls. Unknown keys are stripped at the boundary (never passthrough).
 * Repair-loop error codes are a closed enum — parsers emit them to the
 * correction loop, never free-text stack traces or argument bodies.
 */

import { z } from "zod";

/** Soft cap on parallel calls in one envelope (hot-path / NFR bound). */
export const TOOL_CALL_ENVELOPE_MAX_CALLS = 16 as const;

/**
 * One tool invocation entry inside a fenced envelope.
 * `arguments` is an object (possibly empty); never an array or primitive.
 */
export type ToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  /** Optional correlator — omit or non-empty string; never null. */
  callId?: string | undefined;
};

/** Envelope wire form: one object or a bounded non-empty array. */
export type ToolCallEnvelope = ToolCall | ToolCall[];

/**
 * Single-entry schema. Default Zod object behaviour strips unknown keys
 * (e.g. provider extras) — never silent passthrough of unvalidated fields.
 */
export const toolCallSchema = z
  .object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    callId: z.string().min(1).max(128).optional(),
  })
  .strip() satisfies z.ZodType<ToolCall>;

/**
 * Wire-boundary schema for the JSON body inside a tool_call fence.
 * Accepts exactly one object or one non-empty array of objects — not prose,
 * not null, not an empty array.
 */
export const toolCallEnvelopeSchema = z.union([
  toolCallSchema,
  z.array(toolCallSchema).min(1).max(TOOL_CALL_ENVELOPE_MAX_CALLS),
]) satisfies z.ZodType<ToolCallEnvelope>;

/** Normalize single|array form to a flat call list (post-parse). */
export function normalizeToolCallEnvelope(
  envelope: ToolCallEnvelope,
): ToolCall[] {
  return Array.isArray(envelope) ? envelope : [envelope];
}

/* ────────────────────────────────────────────────────────────────────────
 * Repair-loop error codes (closed enum) + structured payloads
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Closed set of codes the correction loop may receive.
 * Additive evolution only — new codes are new members, never renames.
 */
export const TOOL_ENVELOPE_ERROR_CODES = Object.freeze([
  "INVALID_JSON",
  "MISSING_FENCE",
  "MISSING_TOOL_NAME",
  "INVALID_ARGUMENTS",
  "INVALID_CALL_ID",
  "EMPTY_ENVELOPE",
  "TOO_MANY_CALLS",
  "AMBIGUOUS_ARRAY",
  "SCHEMA_VIOLATION",
  "SUBJECT_REQUIRED",
] as const);

export type ToolEnvelopeErrorCode = (typeof TOOL_ENVELOPE_ERROR_CODES)[number];

export const toolEnvelopeErrorCodeSchema = z.enum(TOOL_ENVELOPE_ERROR_CODES);

/**
 * Structured payload for the model correction loop / host telemetry.
 * `message` is a short, stable instruction — never a stack trace, never
 * tool argument bodies or learner content.
 */
export type ToolEnvelopeError = {
  code: ToolEnvelopeErrorCode;
  message: string;
  issuePath: string;
  /** Index into array form when the violation is call-specific. */
  callIndex?: number | undefined;
};

export const toolEnvelopeErrorSchema = z
  .object({
    code: toolEnvelopeErrorCodeSchema,
    message: z.string().min(1).max(256),
    issuePath: z.string().min(1),
    callIndex: z.number().int().nonnegative().optional(),
  })
  .strict() satisfies z.ZodType<ToolEnvelopeError>;

/** Per-code validation rule — what parsers check and when to emit. */
export type ToolEnvelopeValidationRule = {
  code: ToolEnvelopeErrorCode;
  /** When the rule fires (implementor checklist). */
  trigger: string;
  /** Stable correction-loop message (no stacks, no arg bodies). */
  message: string;
  /** Whether the model repair loop should retry after a fix. */
  repairable: boolean;
};

export const TOOL_ENVELOPE_VALIDATION_RULES: readonly ToolEnvelopeValidationRule[] =
  Object.freeze([
    {
      code: "INVALID_JSON",
      trigger: "Fence body fails JSON.parse",
      message: "tool-call fence body is not valid JSON",
      repairable: true,
    },
    {
      code: "MISSING_FENCE",
      trigger: "Model text has no ```tool_call / ```json fence",
      message: "tool-call finishReason without a fenced envelope",
      repairable: true,
    },
    {
      code: "MISSING_TOOL_NAME",
      trigger: "`toolName` absent, empty, or not a string",
      message: "each tool call requires a non-empty toolName string",
      repairable: true,
    },
    {
      code: "INVALID_ARGUMENTS",
      trigger: "`arguments` missing or not a plain object",
      message: "arguments must be a JSON object",
      repairable: true,
    },
    {
      code: "INVALID_CALL_ID",
      trigger: "`callId` present as null or empty string",
      message: "callId is optional but must be a non-empty string when set",
      repairable: true,
    },
    {
      code: "EMPTY_ENVELOPE",
      trigger: "Parsed JSON is an empty array",
      message: "tool-call envelope must contain at least one call",
      repairable: true,
    },
    {
      code: "TOO_MANY_CALLS",
      trigger: `Array length exceeds ${TOOL_CALL_ENVELOPE_MAX_CALLS}`,
      message: `tool-call envelope exceeds max of ${TOOL_CALL_ENVELOPE_MAX_CALLS} calls`,
      repairable: true,
    },
    {
      code: "AMBIGUOUS_ARRAY",
      trigger:
        "Root is an array but an element is not a plain object (nested arrays/primitives)",
      message: "array envelope elements must each be a tool-call object",
      repairable: true,
    },
    {
      code: "SCHEMA_VIOLATION",
      trigger: "Shape fails the wire schema for another reason",
      message: "tool-call envelope failed schema validation",
      repairable: true,
    },
    {
      code: "SUBJECT_REQUIRED",
      trigger: "Host parse invoked without a non-empty subjectId scope",
      message: "tool-call envelope parse requires a subjectId scope",
      repairable: false,
    },
  ]);

const RULE_BY_CODE: ReadonlyMap<ToolEnvelopeErrorCode, ToolEnvelopeValidationRule> =
  new Map(TOOL_ENVELOPE_VALIDATION_RULES.map((r) => [r.code, r]));

/** Look up the frozen validation rule for a code (throws on unknown — closed enum). */
export function toolEnvelopeRuleFor(
  code: ToolEnvelopeErrorCode,
): ToolEnvelopeValidationRule {
  const rule = RULE_BY_CODE.get(code);
  if (!rule) {
    throw new Error(`unknown ToolEnvelopeErrorCode: ${String(code)}`);
  }
  return rule;
}

export function makeToolEnvelopeError(
  code: ToolEnvelopeErrorCode,
  opts?: { issuePath?: string; callIndex?: number },
): ToolEnvelopeError {
  const rule = toolEnvelopeRuleFor(code);
  const err: ToolEnvelopeError = {
    code,
    message: rule.message,
    issuePath: opts?.issuePath ?? "(root)",
  };
  if (opts?.callIndex !== undefined) {
    err.callIndex = opts.callIndex;
  }
  return toolEnvelopeErrorSchema.parse(err);
}

/* ────────────────────────────────────────────────────────────────────────
 * Classification — map wire inputs / Zod issues → closed error codes
 * ──────────────────────────────────────────────────────────────────────── */

type ZodIssueLike = {
  code: string;
  path: PropertyKey[];
  message: string;
  errors?: ZodIssueLike[][];
};

function flattenIssuePaths(issues: readonly ZodIssueLike[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly ZodIssueLike[]) => {
    for (const issue of list) {
      if (issue.path?.length) out.push(...issue.path.map(String));
      if (Array.isArray(issue.errors)) {
        for (const branch of issue.errors) walk(branch);
      }
    }
  };
  walk(issues);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify an already-parsed JSON value against the envelope schema into a
 * closed repair-loop error (or null when valid).
 */
export function classifyToolEnvelopeValue(
  input: unknown,
): ToolEnvelopeError | null {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return makeToolEnvelopeError("EMPTY_ENVELOPE");
    }
    if (input.length > TOOL_CALL_ENVELOPE_MAX_CALLS) {
      return makeToolEnvelopeError("TOO_MANY_CALLS");
    }
    for (let i = 0; i < input.length; i++) {
      if (!isPlainObject(input[i])) {
        return makeToolEnvelopeError("AMBIGUOUS_ARRAY", {
          issuePath: String(i),
          callIndex: i,
        });
      }
    }
  }

  const parsed = toolCallEnvelopeSchema.safeParse(input);
  if (parsed.success) return null;

  const paths = flattenIssuePaths(parsed.error.issues);
  if (paths.includes("toolName")) {
    const idx = paths.findIndex((p) => p === "toolName");
    const prior =
      idx > 0 && /^\d+$/.test(paths[idx - 1]!) ? Number(paths[idx - 1]) : undefined;
    return makeToolEnvelopeError(
      "MISSING_TOOL_NAME",
      prior === undefined
        ? { issuePath: "toolName" }
        : { issuePath: "toolName", callIndex: prior },
    );
  }
  if (paths.includes("arguments")) {
    return makeToolEnvelopeError("INVALID_ARGUMENTS", {
      issuePath: "arguments",
    });
  }
  if (paths.includes("callId")) {
    return makeToolEnvelopeError("INVALID_CALL_ID", { issuePath: "callId" });
  }
  return makeToolEnvelopeError("SCHEMA_VIOLATION", {
    issuePath: paths[0] ?? "(root)",
  });
}

/**
 * Parse a fence-body string (contents inside ```tool_call) into an envelope
 * or a closed repair-loop error. Does not extract fences — that is host/B4.
 */
export function parseToolCallEnvelopeJson(
  jsonText: string,
):
  | { ok: true; envelope: ToolCall[] }
  | { ok: false; error: ToolEnvelopeError } {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: makeToolEnvelopeError("INVALID_JSON") };
  }
  const classified = classifyToolEnvelopeValue(value);
  if (classified) {
    return { ok: false, error: classified };
  }
  const envelope = normalizeToolCallEnvelope(
    toolCallEnvelopeSchema.parse(value),
  );
  return { ok: true, envelope };
}

/* ────────────────────────────────────────────────────────────────────────
 * Subject-scoped parse + observability (metadata only)
 * ──────────────────────────────────────────────────────────────────────── */

export type ToolEnvelopeParseAccepted = {
  outcome: "accepted";
  subjectId: string;
  deviceId?: string;
  callCount: number;
  toolNames: string[];
  envelope: ToolCall[];
};

export type ToolEnvelopeParseRejected = {
  outcome: "rejected";
  subjectId: string | null;
  deviceId?: string;
  /** Closed repair-loop code — never a stack trace. */
  errorCode: ToolEnvelopeErrorCode;
  error: ToolEnvelopeError;
};

export type ToolEnvelopeParseResult =
  | ToolEnvelopeParseAccepted
  | ToolEnvelopeParseRejected;

/**
 * Parse a tool-call envelope at the trust boundary.
 * Requires a non-empty `subjectId` (turn/session scope).
 * Telemetry / rejection payloads never include `arguments` bodies.
 */
export function parseToolCallEnvelope(
  input: unknown,
  opts: { subjectId: string; deviceId?: string },
): ToolEnvelopeParseResult {
  const deviceId = opts.deviceId;
  const subjectId = typeof opts.subjectId === "string" ? opts.subjectId : "";
  if (subjectId.length === 0) {
    const error = makeToolEnvelopeError("SUBJECT_REQUIRED", {
      issuePath: "subjectId",
    });
    return {
      outcome: "rejected",
      subjectId: null,
      ...(deviceId !== undefined ? { deviceId } : {}),
      errorCode: error.code,
      error,
    };
  }

  const classified = classifyToolEnvelopeValue(input);
  if (classified) {
    return {
      outcome: "rejected",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      errorCode: classified.code,
      error: classified,
    };
  }

  const envelope = normalizeToolCallEnvelope(
    toolCallEnvelopeSchema.parse(input),
  );
  return {
    outcome: "accepted",
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    callCount: envelope.length,
    toolNames: envelope.map((c) => c.toolName),
    envelope,
  };
}
