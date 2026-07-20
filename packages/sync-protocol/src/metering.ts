/**
 * Per-turn metering event wire contract.
 *
 * Emitted as METER_TICK frame payloads (and later on the EventBus spine).
 * Metadata only — never raw prompt or completion text. Cached and fresh
 * input tokens are separate fields and must not be conflated in aggregates.
 *
 * Host throttling: `BudgetHook` — canonical interface lives in
 * `@moolam/contracts` (`budget.ts`); helpers below bind MeterEvent ticks.
 * Normative semantics: `docs/protocol/METERING.md`.
 */

import {
  BUDGET_DECISIONS,
  type BudgetDecision,
  type BudgetHook,
  type BudgetMeterTick,
  isBudgetDecision,
} from "@moolam/contracts";
import { z } from "zod";

/** Locality declaration on a meter tick — metadata only. */
export type MeterLocality = "on-device" | "self-hosted" | "external-api";

export const METER_LOCALITIES = Object.freeze([
  "on-device",
  "self-hosted",
  "external-api",
] as const satisfies readonly MeterLocality[]);

/**
 * Per-turn metering snapshot.
 *
 * - `inputTokens` — fresh (non-cached) input tokens
 * - `cachedInputTokens` — cache-hit input tokens (never folded into inputTokens)
 * - `aborted` — true when the turn ended before a natural TURN_COMPLETE;
 *   partial spend must still be accounted
 */
export interface MeterEvent {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
  modelId: string;
  locality: MeterLocality;
  aborted: boolean;
}

export const meterEventSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    modelId: z.string().min(1),
    locality: z.enum(["on-device", "self-hosted", "external-api"]),
    aborted: z.boolean(),
  })
  .strict() satisfies z.ZodType<MeterEvent>;

/** Provider-reported usage (golden-turn reconcile) — metadata counts only. */
export type ProviderUsageReport = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type MeterTokenReconcileResult =
  | { ok: true }
  | {
      ok: false;
      code: "TOKEN_MISMATCH";
      field: "inputTokens" | "outputTokens" | "cachedInputTokens";
      expected: number;
      actual: number;
    };

/**
 * Reconcile MeterEvent token fields with a provider usage report.
 * Compares cached and fresh input separately — never a single summed input.
 */
export function reconcileMeterTokens(
  meter: MeterEvent,
  provider: ProviderUsageReport,
): MeterTokenReconcileResult {
  if (meter.inputTokens !== provider.inputTokens) {
    return {
      ok: false,
      code: "TOKEN_MISMATCH",
      field: "inputTokens",
      expected: provider.inputTokens,
      actual: meter.inputTokens,
    };
  }
  if (meter.cachedInputTokens !== provider.cachedInputTokens) {
    return {
      ok: false,
      code: "TOKEN_MISMATCH",
      field: "cachedInputTokens",
      expected: provider.cachedInputTokens,
      actual: meter.cachedInputTokens,
    };
  }
  if (meter.outputTokens !== provider.outputTokens) {
    return {
      ok: false,
      code: "TOKEN_MISMATCH",
      field: "outputTokens",
      expected: provider.outputTokens,
      actual: meter.outputTokens,
    };
  }
  return { ok: true };
}

/** Field-wise sum for multi-tick aggregation (cached vs fresh stay distinct). */
export type MeterTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
};

export function sumMeterTokenTotals(events: readonly MeterEvent[]): MeterTokenTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let latencyMs = 0;
  for (const e of events) {
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cachedInputTokens += e.cachedInputTokens;
    latencyMs += e.latencyMs;
  }
  return { inputTokens, outputTokens, cachedInputTokens, latencyMs };
}

/** Distinct failure classes for meter payload boundary validation. */
export const METER_EVENT_FAILURE_CLASSES = Object.freeze([
  "missing_subject",
  "unrecognized_keys",
  "schema_violation",
  "content_leak",
] as const);

export type MeterEventFailureClass =
  (typeof METER_EVENT_FAILURE_CLASSES)[number];

export type MeterEventParseAccepted = {
  outcome: "accepted";
  subjectId: string;
  deviceId?: string;
  event: MeterEvent;
  aborted: boolean;
};

export type MeterEventParseRejected = {
  outcome: "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass: MeterEventFailureClass;
  issuePath: string;
};

export type MeterEventParseResult =
  | MeterEventParseAccepted
  | MeterEventParseRejected;

const CONTENT_LEAK_KEYS = new Set([
  "prompt",
  "completion",
  "text",
  "delta",
  "utterance",
  "arguments",
]);

function classifyMeterFailure(
  issues: readonly { code: string; path: PropertyKey[]; message: string }[],
  raw: unknown,
): { failureClass: MeterEventFailureClass; issuePath: string } {
  const first = issues[0];
  const issuePath = first
    ? first.path.map(String).join(".") || "(root)"
    : "(root)";

  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw as object).some((k) => CONTENT_LEAK_KEYS.has(k))
  ) {
    return { failureClass: "content_leak", issuePath };
  }
  if (first?.code === "unrecognized_keys") {
    return { failureClass: "unrecognized_keys", issuePath };
  }
  return { failureClass: "schema_violation", issuePath };
}

/**
 * Parse a MeterEvent at the trust boundary.
 * Requires a non-empty subjectId for scoping (ticks never float unscoped).
 * Outcome is metadata-only — never echoes prompt/completion bodies.
 */
export function parseMeterEvent(
  input: unknown,
  opts: { subjectId: string; deviceId?: string },
): MeterEventParseResult {
  const subjectId = opts.subjectId;
  const deviceId = opts.deviceId;

  if (typeof subjectId !== "string" || subjectId.length === 0) {
    return {
      outcome: "rejected",
      subjectId: null,
      ...(deviceId !== undefined ? { deviceId } : {}),
      failureClass: "missing_subject",
      issuePath: "subjectId",
    };
  }

  const parsed = meterEventSchema.safeParse(input);
  if (!parsed.success) {
    const { failureClass, issuePath } = classifyMeterFailure(
      parsed.error.issues,
      input,
    );
    return {
      outcome: "rejected",
      subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      failureClass,
      issuePath,
    };
  }

  return {
    outcome: "accepted",
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    event: parsed.data,
    aborted: parsed.data.aborted,
  };
}

/**
 * Bind a parsed MeterEvent to a subject-scoped BudgetHook tick.
 * Rejects empty subjectId (cross-subject gap).
 */
export function toBudgetMeterTick(
  meter: MeterEvent,
  scope: { subjectId: string; deviceId?: string; sessionId?: string },
): BudgetMeterTick {
  if (typeof scope.subjectId !== "string" || scope.subjectId.length === 0) {
    throw new TypeError("BudgetMeterTick requires a non-empty subjectId");
  }
  return {
    subjectId: scope.subjectId,
    ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
    inputTokens: meter.inputTokens,
    outputTokens: meter.outputTokens,
    cachedInputTokens: meter.cachedInputTokens,
    latencyMs: meter.latencyMs,
    modelId: meter.modelId,
    locality: meter.locality,
    aborted: meter.aborted,
  };
}

export type BudgetHookInvokeAccepted = {
  outcome: "accepted";
  subjectId: string;
  deviceId?: string;
  decision: BudgetDecision;
  aborted: boolean;
};

export type BudgetHookInvokeRejected = {
  outcome: "rejected";
  subjectId: string | null;
  deviceId?: string;
  failureClass: "missing_subject" | "invalid_decision";
  issuePath: string;
};

export type BudgetHookInvokeResult =
  | BudgetHookInvokeAccepted
  | BudgetHookInvokeRejected;

/**
 * Invoke a BudgetHook with a typed outcome for telemetry.
 * Never echoes prompt/completion; invalid decision strings are rejected.
 */
export async function invokeBudgetHook(
  hook: BudgetHook,
  tick: BudgetMeterTick,
  opts?: { deviceId?: string },
): Promise<BudgetHookInvokeResult> {
  const deviceId = opts?.deviceId ?? tick.deviceId;
  if (typeof tick.subjectId !== "string" || tick.subjectId.length === 0) {
    return {
      outcome: "rejected",
      subjectId: null,
      ...(deviceId !== undefined ? { deviceId } : {}),
      failureClass: "missing_subject",
      issuePath: "subjectId",
    };
  }

  const raw = await Promise.resolve(hook.onMeterTick(tick));
  if (!isBudgetDecision(raw)) {
    return {
      outcome: "rejected",
      subjectId: tick.subjectId,
      ...(deviceId !== undefined ? { deviceId } : {}),
      failureClass: "invalid_decision",
      issuePath: "decision",
    };
  }

  return {
    outcome: "accepted",
    subjectId: tick.subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    decision: raw,
    aborted: tick.aborted,
  };
}
