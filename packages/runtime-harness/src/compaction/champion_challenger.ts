/**
 * Unified compaction interface with champion/challenger swap.
 *
 * Champion is B5 deterministic compaction. Challenger is learned summarize.
 * Flag-off is champion-only (byte-for-byte B5). Flag-on may serve challenger
 * with champion fallback, or shadow-score challenger while serving champion.
 * Telemetry always names the path; content never leaves metadata events.
 */

import type { ChatMessage } from "@moolam/contracts";
import {
  CONTEXT_COMPACTION_THRESHOLD_DEFAULT,
  ContextBudgetManager,
  type ContextMemoryItem,
  type ContextModelCard,
  type ContextRetrievalPassage,
} from "../context_budget.js";
import {
  applyCompactionTrigger,
  type ApplyCompactionTriggerAccepted,
  type ApplyCompactionTriggerOptions,
  type ApplyCompactionTriggerResult,
  type CompactionDurableState,
} from "../compaction.js";

export const COMPACTION_SWAP_SCHEMA_VERSION =
  "runtime.harness.compaction-swap.v1" as const;

export const COMPACTION_CHALLENGER_TIMEOUT_MS_DEFAULT = 1_000;
export const COMPACTION_CHALLENGER_SUMMARY_CHAR_LIMIT = 64 * 1024;

export type CompactionPath = "champion" | "challenger";

/**
 * Serving modes for the unified compaction interface.
 * - champion: flag-off — B5 only
 * - challenger: flag-on serve — learned summarize with champion fallback
 * - shadow: eval before traffic — both paths; serve champion always
 */
export type CompactionServingMode = "champion" | "challenger" | "shadow";

export type CompactionSwapFailureClass =
  | "cross_subject"
  | "missing_subject"
  | "invalid_input"
  | "baseline_rejected"
  | "learned_timeout"
  | "learned_invalid_output";

export type CompactionSwapTelemetryEvent = {
  event: "runtime.harness.compaction_swap";
  outcome: "ok" | "fallback" | "rejected" | "skipped" | "shadow";
  subjectId: string | null;
  deviceId?: string;
  sessionId?: string;
  mode: CompactionServingMode;
  /** Path that produced the served result. */
  path: CompactionPath;
  /** Challenger observation when shadowing (never served). */
  challengerPath?: CompactionPath;
  compacted?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryHash?: string;
  challengerSummaryHash?: string;
  /** True when challenger produced a distinct non-empty summary (eval signal only). */
  challengerDistinct?: boolean;
  failureClass?: CompactionSwapFailureClass;
  idempotentReplay?: boolean;
};

export type CompactionSwapInput = {
  budget: ContextBudgetManager;
  state: CompactionDurableState;
  context?: {
    messages?: readonly ChatMessage[];
    memories?: readonly ContextMemoryItem[];
    retrieval?: readonly ContextRetrievalPassage[];
    pendingDynamicBlock?: string;
    protectedTexts?: readonly string[];
  };
  options?: ApplyCompactionTriggerOptions;
  invocationId?: string;
};

export type CompactionSwapAccepted = ApplyCompactionTriggerAccepted & {
  /**
   * Absent in flag-off champion mode so the result remains byte-identical to
   * B5. Path remains observable through compaction_swap telemetry.
   */
  path?: CompactionPath;
  mode?: CompactionServingMode;
  advisory?: CompactionSwapFailureClass;
  /** Present in shadow mode when challenger scored. */
  challengerCompacted?: boolean;
  challengerDistinct?: boolean;
  challengerSummaryHash?: string;
};

export type CompactionSwapResult =
  | CompactionSwapAccepted
  | Extract<ApplyCompactionTriggerResult, { ok: false }>;

export type CompactionChallengerSummarizer = (input: {
  state: CompactionDurableState;
  baseline: ApplyCompactionTriggerAccepted;
  invocationId?: string;
}) => Promise<string> | string;

/**
 * Unified compaction surface — both champion and challenger implement this.
 */
export interface CompactionInterface {
  readonly mode: CompactionServingMode;
  compact(input: CompactionSwapInput): Promise<CompactionSwapResult>;
}

export type CreateCompactionInterfaceSwapOptions = {
  /**
   * When false (default), mode is forced to champion — flag-off B5 path.
   * When true without explicit mode, defaults to challenger serve.
   */
  learnedEnabled?: boolean;
  /** Explicit serving mode; overrides learnedEnabled default mapping. */
  mode?: CompactionServingMode;
  summarize?: CompactionChallengerSummarizer;
  timeoutMs?: number;
  onTelemetry?: (event: CompactionSwapTelemetryEvent) => void;
};

function emit(
  sink: CreateCompactionInterfaceSwapOptions["onTelemetry"],
  event: Omit<CompactionSwapTelemetryEvent, "event">,
): void {
  sink?.({ event: "runtime.harness.compaction_swap", ...event });
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function resolveMode(
  options: CreateCompactionInterfaceSwapOptions,
): CompactionServingMode {
  if (options.mode !== undefined) return options.mode;
  return options.learnedEnabled === true ? "challenger" : "champion";
}

async function runChallengerSummary(input: {
  summarize: CompactionChallengerSummarizer;
  baseline: ApplyCompactionTriggerAccepted;
  state: CompactionDurableState;
  invocationId?: string;
  timeoutMs: number;
}): Promise<
  | { ok: true; summary: string }
  | { ok: false; failureClass: "learned_timeout" | "learned_invalid_output" }
> {
  const raced = await withTimeout(
    Promise.resolve(
      input.summarize({
        state: input.state,
        baseline: input.baseline,
        ...(input.invocationId !== undefined
          ? { invocationId: input.invocationId }
          : {}),
      }),
    ),
    input.timeoutMs,
  );
  if (!raced.ok) {
    return { ok: false, failureClass: "learned_timeout" };
  }
  if (
    typeof raced.value !== "string" ||
    raced.value.length === 0 ||
    raced.value.length > COMPACTION_CHALLENGER_SUMMARY_CHAR_LIMIT
  ) {
    return { ok: false, failureClass: "learned_invalid_output" };
  }
  return { ok: true, summary: raced.value };
}

function withChampionPath(
  baseline: ApplyCompactionTriggerAccepted,
  mode: CompactionServingMode,
  extra?: Partial<CompactionSwapAccepted>,
): CompactionSwapAccepted {
  if (mode === "champion" && extra === undefined) {
    // Do not clone with C6 fields: JSON bytes must match direct B5 output.
    return baseline;
  }
  return {
    ...baseline,
    path: "champion",
    mode,
    ...extra,
  };
}

/**
 * Build the feature-flagged compaction swap.
 * Flag-off (champion mode) never invokes a summarizer — B5 only.
 */
export function createCompactionInterfaceSwap(
  options: CreateCompactionInterfaceSwapOptions = {},
): CompactionInterface {
  const mode = resolveMode(options);
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : COMPACTION_CHALLENGER_TIMEOUT_MS_DEFAULT;
  const onTelemetry = options.onTelemetry;

  return {
    mode,
    async compact(input: CompactionSwapInput): Promise<CompactionSwapResult> {
      // B5 owns validation as well as compaction. Pre-validation here would
      // alter flag-off telemetry and violate byte parity.
      const baseline = applyCompactionTrigger({
        budget: input.budget,
        state: input.state,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
      });

      if (!baseline.ok) {
        emit(onTelemetry, {
          outcome: "rejected",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          ...(input.state.sessionId !== undefined
            ? { sessionId: input.state.sessionId }
            : {}),
          mode,
          path: "champion",
          failureClass:
            baseline.failureClass === "cross_subject"
              ? "cross_subject"
              : baseline.failureClass === "missing_subject"
                ? "missing_subject"
                : "baseline_rejected",
        });
        return baseline;
      }

      if (!baseline.compacted) {
        emit(onTelemetry, {
          outcome: "skipped",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          ...(input.state.sessionId !== undefined
            ? { sessionId: input.state.sessionId }
            : {}),
          mode,
          path: "champion",
          compacted: false,
          tokensBefore: baseline.tokensBefore,
          tokensAfter: baseline.tokensAfter,
          ...(baseline.idempotentReplay === true
            ? { idempotentReplay: true }
            : {}),
        });
        return withChampionPath(baseline, mode);
      }

      // Flag-off / champion-only: B5 result is authoritative and final.
      if (mode === "champion") {
        emit(onTelemetry, {
          outcome: "ok",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          ...(input.state.sessionId !== undefined
            ? { sessionId: input.state.sessionId }
            : {}),
          mode,
          path: "champion",
          compacted: true,
          tokensBefore: baseline.tokensBefore,
          tokensAfter: baseline.tokensAfter,
          ...(baseline.summaryHash !== undefined
            ? { summaryHash: baseline.summaryHash }
            : {}),
          ...(baseline.idempotentReplay === true
            ? { idempotentReplay: true }
            : {}),
        });
        return withChampionPath(baseline, mode);
      }

      if (typeof options.summarize !== "function") {
        emit(onTelemetry, {
          outcome: "fallback",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          mode,
          path: "champion",
          compacted: true,
          tokensBefore: baseline.tokensBefore,
          tokensAfter: baseline.tokensAfter,
          ...(baseline.summaryHash !== undefined
            ? { summaryHash: baseline.summaryHash }
            : {}),
          failureClass: "learned_invalid_output",
        });
        return withChampionPath(baseline, mode, {
          advisory: "learned_invalid_output",
        });
      }

      const challenger = await runChallengerSummary({
        summarize: options.summarize,
        baseline,
        state: input.state,
        ...(input.invocationId !== undefined
          ? { invocationId: input.invocationId }
          : {}),
        timeoutMs,
      });

      if (mode === "shadow") {
        // Eval before traffic: serve champion; challenger is observation only.
        // Ties / failures do not promote — serving path stays champion.
        const distinct =
          challenger.ok &&
          challenger.summary !== baseline.summary &&
          challenger.summary.length > 0;
        emit(onTelemetry, {
          outcome: "shadow",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          ...(input.state.sessionId !== undefined
            ? { sessionId: input.state.sessionId }
            : {}),
          mode,
          path: "champion",
          challengerPath: challenger.ok ? "challenger" : "champion",
          compacted: true,
          tokensBefore: baseline.tokensBefore,
          tokensAfter: baseline.tokensAfter,
          ...(baseline.summaryHash !== undefined
            ? { summaryHash: baseline.summaryHash }
            : {}),
          challengerDistinct: distinct,
          ...(challenger.ok
            ? {}
            : { failureClass: challenger.failureClass }),
        });
        return withChampionPath(baseline, mode, {
          challengerCompacted: challenger.ok,
          challengerDistinct: distinct,
          ...(challenger.ok === false
            ? { advisory: challenger.failureClass }
            : {}),
        });
      }

      // Challenger serve mode (flag-on): learned summary with champion fallback.
      if (!challenger.ok) {
        emit(onTelemetry, {
          outcome: "fallback",
          subjectId: input.state.subjectId,
          ...(input.state.deviceId !== undefined
            ? { deviceId: input.state.deviceId }
            : {}),
          ...(input.state.sessionId !== undefined
            ? { sessionId: input.state.sessionId }
            : {}),
          mode,
          path: "champion",
          compacted: true,
          tokensBefore: baseline.tokensBefore,
          tokensAfter: baseline.tokensAfter,
          ...(baseline.summaryHash !== undefined
            ? { summaryHash: baseline.summaryHash }
            : {}),
          failureClass: challenger.failureClass,
        });
        return withChampionPath(baseline, mode, {
          advisory: challenger.failureClass,
        });
      }

      // Never empty history — challenger summary already validated non-empty.
      const served: CompactionSwapAccepted = {
        ...baseline,
        summary: challenger.summary,
        path: "challenger",
        mode,
        usedLlm: false,
      };
      emit(onTelemetry, {
        outcome: "ok",
        subjectId: input.state.subjectId,
        ...(input.state.deviceId !== undefined
          ? { deviceId: input.state.deviceId }
          : {}),
        ...(input.state.sessionId !== undefined
          ? { sessionId: input.state.sessionId }
          : {}),
        mode,
        path: "challenger",
        compacted: true,
        tokensBefore: baseline.tokensBefore,
        tokensAfter: baseline.tokensAfter,
        ...(baseline.summaryHash !== undefined
          ? { summaryHash: baseline.summaryHash }
          : {}),
      });
      return served;
    },
  };
}

/**
 * Convenience: build a ContextBudgetManager pinned to the B5 75% threshold
 * and run the swap interface once.
 */
export async function compactViaInterfaceSwap(input: {
  swap: CompactionInterface;
  state: CompactionDurableState;
  modelCard: ContextModelCard;
  context?: CompactionSwapInput["context"];
  options?: ApplyCompactionTriggerOptions;
  invocationId?: string;
}): Promise<CompactionSwapResult> {
  const budget = new ContextBudgetManager({
    subjectId: input.state.subjectId,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    modelCard: input.modelCard,
    compactionThreshold: CONTEXT_COMPACTION_THRESHOLD_DEFAULT,
  });
  return input.swap.compact({
    budget,
    state: input.state,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.invocationId !== undefined
      ? { invocationId: input.invocationId }
      : {}),
  });
}
