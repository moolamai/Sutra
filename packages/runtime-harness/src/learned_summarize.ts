/**
 * Feature-gated learned session summarization tool.
 *
 * Delegates compaction through the champion/challenger CompactionInterface
 * swap: flag-off is B5 champion-only; flag-on serves the learned challenger
 * with deterministic fallback. Telemetry names the path without content.
 */

import type { ToolDescriptor } from "@moolam/contracts";
import {
  CONTEXT_MESSAGE_LIMIT,
  type ContextMemoryItem,
  type ContextModelCard,
  type ContextRetrievalPassage,
} from "./context_budget.js";
import {
  COMPACTION_SECTION_ITEM_LIMIT,
  type ApplyCompactionTriggerAccepted,
  type CompactionDurableState,
} from "./compaction.js";
import {
  compactViaInterfaceSwap,
  createCompactionInterfaceSwap,
  type CompactionChallengerSummarizer,
  type CompactionSwapTelemetryEvent,
} from "./compaction/champion_challenger.js";
import {
  InProcessFakeToolRegistry,
  type SandboxSeamContext,
} from "./sandbox_seam.js";

export const LEARNED_SUMMARIZE_TOOL_NAME =
  "summarize_session_state" as const;
export const LEARNED_SUMMARIZE_TIMEOUT_MS_DEFAULT = 1_000;
export const LEARNED_SUMMARIZE_OUTPUT_CHAR_LIMIT = 64 * 1024;

export type LearnedSummarizeFailureClass =
  | "invalid_input"
  | "cross_subject"
  | "baseline_rejected"
  | "learned_timeout"
  | "learned_invalid_output";

export type LearnedSummarizeTelemetryEvent = {
  event: "runtime.harness.learned_summarize";
  outcome: "ok" | "fallback" | "rejected" | "skipped";
  subjectId: string | null;
  deviceId?: string;
  invocationId?: string;
  route: "learned" | "deterministic";
  /** Champion/challenger path from the compaction interface swap. */
  path?: "champion" | "challenger";
  compacted?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  failureClass?: LearnedSummarizeFailureClass;
};

export type LearnedSummarizeRequest = {
  state: CompactionDurableState;
  modelCard: ContextModelCard;
  context: {
    messages: unknown[];
    memories?: ContextMemoryItem[];
    retrieval?: ContextRetrievalPassage[];
    pendingDynamicBlock?: string;
    protectedTexts?: string[];
  };
};

export type LearnedSummarizer = CompactionChallengerSummarizer;

export type RegisterLearnedSummarizeToolOptions = {
  enabled: boolean;
  summarize: LearnedSummarizer;
  timeoutMs?: number;
  onTelemetry?: (event: LearnedSummarizeTelemetryEvent) => void;
};

export const learnedSummarizeToolDescriptor: ToolDescriptor = Object.freeze({
  name: LEARNED_SUMMARIZE_TOOL_NAME,
  description:
    "Summarize subject-scoped session state at the deterministic compaction threshold",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["state", "modelCard", "context"],
    properties: {
      state: {
        type: "object",
        required: ["subjectId"],
        properties: {
          subjectId: { type: "string" },
          deviceId: { type: "string" },
          sessionId: { type: "string" },
          openConstraints: { type: "array", items: { type: "string" } },
          verifiedFacts: { type: "array", items: { type: "string" } },
          citationRefs: { type: "array", items: { type: "string" } },
          episodicDetail: { type: "array", items: { type: "string" } },
          memories: { type: "array", items: { type: "object" } },
          knowledge: { type: "array", items: { type: "object" } },
        },
      },
      modelCard: {
        type: "object",
        required: ["modelId", "contextWindow"],
        properties: {
          modelId: { type: "string" },
          contextWindow: { type: "number" },
        },
      },
      context: {
        type: "object",
        required: ["messages"],
        properties: {
          messages: { type: "array", items: { type: "object" } },
          memories: { type: "array", items: { type: "object" } },
          retrieval: { type: "array", items: { type: "object" } },
          pendingDynamicBlock: { type: "string" },
          protectedTexts: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  riskClass: "compute",
});

function emit(
  sink: RegisterLearnedSummarizeToolOptions["onTelemetry"],
  event: Omit<LearnedSummarizeTelemetryEvent, "event">,
): void {
  sink?.({ event: "runtime.harness.learned_summarize", ...event });
}

function mapSwapTelemetry(
  event: CompactionSwapTelemetryEvent,
): Omit<LearnedSummarizeTelemetryEvent, "event"> {
  const route =
    event.path === "challenger" ? ("learned" as const) : ("deterministic" as const);
  const failureClass =
    event.failureClass === "cross_subject" ||
    event.failureClass === "invalid_input" ||
    event.failureClass === "baseline_rejected" ||
    event.failureClass === "learned_timeout" ||
    event.failureClass === "learned_invalid_output"
      ? event.failureClass
      : undefined;
  return {
    outcome:
      event.outcome === "shadow"
        ? "ok"
        : event.outcome === "fallback"
          ? "fallback"
          : event.outcome === "rejected"
            ? "rejected"
            : event.outcome === "skipped"
              ? "skipped"
              : "ok",
    subjectId: event.subjectId,
    ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
    route,
    path: event.path,
    ...(event.compacted !== undefined ? { compacted: event.compacted } : {}),
    ...(event.tokensBefore !== undefined
      ? { tokensBefore: event.tokensBefore }
      : {}),
    ...(event.tokensAfter !== undefined
      ? { tokensAfter: event.tokensAfter }
      : {}),
    ...(failureClass !== undefined ? { failureClass } : {}),
  };
}

function validBoundedArray(value: unknown, limit: number): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= limit);
}

function parseRequest(
  args: Record<string, unknown>,
  context: SandboxSeamContext,
): { ok: true; request: LearnedSummarizeRequest } | {
  ok: false;
  failureClass: "invalid_input" | "cross_subject";
} {
  if (
    !args.state ||
    typeof args.state !== "object" ||
    !args.modelCard ||
    typeof args.modelCard !== "object" ||
    !args.context ||
    typeof args.context !== "object"
  ) {
    return { ok: false, failureClass: "invalid_input" };
  }

  const state = args.state as Record<string, unknown>;
  const modelCard = args.modelCard as Record<string, unknown>;
  const live = args.context as Record<string, unknown>;
  const subjectId =
    typeof state.subjectId === "string" ? state.subjectId.trim() : "";

  if (subjectId !== context.subjectId) {
    return { ok: false, failureClass: "cross_subject" };
  }
  if (
    !subjectId ||
    typeof modelCard.modelId !== "string" ||
    !Number.isFinite(modelCard.contextWindow) ||
    Number(modelCard.contextWindow) <= 0 ||
    !Array.isArray(live.messages) ||
    live.messages.length > CONTEXT_MESSAGE_LIMIT ||
    !validBoundedArray(live.memories, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(live.retrieval, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(live.protectedTexts, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.openConstraints, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.verifiedFacts, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.citationRefs, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.episodicDetail, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.memories, COMPACTION_SECTION_ITEM_LIMIT) ||
    !validBoundedArray(state.knowledge, COMPACTION_SECTION_ITEM_LIMIT)
  ) {
    return { ok: false, failureClass: "invalid_input" };
  }

  return {
    ok: true,
    request: {
      state: state as CompactionDurableState,
      modelCard: {
        modelId: modelCard.modelId,
        contextWindow: Math.floor(Number(modelCard.contextWindow)),
      },
      context: live as LearnedSummarizeRequest["context"],
    },
  };
}

/**
 * Register only when enabled. Disabled means the registry and deterministic B5
 * compaction path are unchanged.
 */
export function registerLearnedSummarizeTool(
  registry: InProcessFakeToolRegistry,
  options: RegisterLearnedSummarizeToolOptions,
): void {
  if (!options.enabled) return;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : LEARNED_SUMMARIZE_TIMEOUT_MS_DEFAULT;

  const swap = createCompactionInterfaceSwap({
    learnedEnabled: true,
    mode: "challenger",
    summarize: options.summarize,
    timeoutMs,
    onTelemetry: (event) => {
      emit(options.onTelemetry, {
        ...mapSwapTelemetry(event),
      });
    },
  });

  registry.register({
    descriptor: learnedSummarizeToolDescriptor,
    effect: async (args, context) => {
      const parsed = parseRequest(args, context);
      if (!parsed.ok) {
        emit(options.onTelemetry, {
          outcome: "rejected",
          subjectId: context.subjectId || null,
          ...(context.deviceId !== undefined
            ? { deviceId: context.deviceId }
            : {}),
          invocationId: context.invocationId,
          route: "deterministic",
          path: "champion",
          failureClass: parsed.failureClass,
        });
        return {
          ok: false,
          failureClass: parsed.failureClass,
          compacted: false,
        };
      }

      const result = await compactViaInterfaceSwap({
        swap,
        state: parsed.request.state,
        modelCard: parsed.request.modelCard,
        context: parsed.request.context as NonNullable<
          Parameters<typeof compactViaInterfaceSwap>[0]["context"]
        >,
        options:
          context.idempotencyKey !== undefined
            ? { idempotencyKey: context.idempotencyKey }
            : {},
        invocationId: context.invocationId,
      });

      if (!result.ok) {
        return {
          ok: false,
          failureClass: "baseline_rejected",
          compacted: false,
        };
      }

      if (!result.compacted) {
        return {
          ok: true,
          compacted: false,
          route: "deterministic",
          path: result.path,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        };
      }

      if (result.path === "challenger") {
        return {
          ok: true,
          compacted: true,
          route: "learned",
          path: "challenger",
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        };
      }

      return {
        ok: true,
        compacted: true,
        route: "deterministic",
        path: "champion",
        ...(result.advisory !== undefined
          ? { advisory: result.advisory }
          : {}),
        summary: result.summary,
        summaryHash: result.summaryHash,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      };
    },
  });
}

export type { ApplyCompactionTriggerAccepted };
