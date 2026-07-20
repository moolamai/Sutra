/**
 * ContextBudgetManager — context-window budget vs model card.
 *
 * Loads `contextWindow` from a model card (ModelDescriptor / SlmModelCard
 * shape), estimates tokens for chat messages + retrieval passages with a
 * documented heuristic (or optional card tokenizer), and exposes
 * {@link ContextBudgetManager.shouldCompact} at the 75% threshold.
 *
 * Recall / knowledge truncation ({@link ContextBudgetManager.truncateRecallAndKnowledge}):
 * drop lowest-score memories and passages first until the truncateable
 * budget fits under the compaction threshold. Never truncates
 * profile.refusals or active plan constraints.
 *
 * Headroom always includes the pending dynamic block for the current turn.
 * v1 does not LLM-summarize; compaction trigger wire lives in compaction.ts.
 *
 * Sovereignty: telemetry carries subject scope, modelId, and token counts
 * only — never message / passage / charter plaintext.
 */

import { createHash } from "node:crypto";
import type { ChatMessage, ModelDescriptor } from "@moolam/contracts";

/** Compaction trigger: fraction of model-card context window (epic default). */
export const CONTEXT_COMPACTION_THRESHOLD_DEFAULT = 0.75;

/**
 * Conservative window when the model card omits / invalidates contextWindow.
 * Hosts MUST treat {@link CONTEXT_ADVISORY_MISSING_WINDOW} as a deployment signal.
 */
export const CONTEXT_WINDOW_CONSERVATIVE_DEFAULT = 2048;

/**
 * Documented char→token heuristic (v1). Matches the static-prefix estimate
 * used by prompt-cache metering so turn accounting stays consistent.
 */
export const CONTEXT_CHARS_PER_TOKEN_ESTIMATE = 4;

/** Soft cap on messages estimated per measure (NFR — no unbounded walks). */
export const CONTEXT_MESSAGE_LIMIT = 256;

/** Soft cap on retrieval passages estimated per measure. */
export const CONTEXT_RETRIEVAL_LIMIT = 64;

/** Soft cap on recall memories estimated / truncated per turn. */
export const CONTEXT_MEMORY_LIMIT = 64;

/** Soft cap on UTF-16 code units per text field. */
export const CONTEXT_SECTION_CHAR_LIMIT = 32_768;

/** Advisory when contextWindow was missing/invalid and conservative default applied. */
export const CONTEXT_ADVISORY_MISSING_WINDOW =
  "missing_context_window" as const;

/** Golden corpus for 74% / 75% / 76% threshold boundary regressions. */
export const CONTEXT_BUDGET_THRESHOLD_FIXTURE_RELPATH =
  "fixtures/context-budget-threshold" as const;

export type ContextBudgetFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_model_card"
  | "invalid_messages"
  | "invalid_retrieval"
  | "invalid_memories"
  | "section_limit"
  | "message_limit"
  | "retrieval_limit"
  | "memory_limit";

export type ContextBudgetAdvisoryCode =
  typeof CONTEXT_ADVISORY_MISSING_WINDOW;

/**
 * Minimal model-card surface for window load. Accepts ModelDescriptor or
 * edge SlmModelCard fields; optional tokenizer overrides the heuristic.
 */
export type ContextModelCard = {
  modelId: string;
  /** Tokens the model will actually honor. Missing/invalid → conservative default. */
  contextWindow?: number;
  /**
   * Optional tokenizer. When provided, all estimates use it (per-text) so
   * turns stay consistent for a given card instance.
   */
  estimateTokens?: (text: string) => number;
};

export type ContextRetrievalPassage = {
  text: string;
  /** Higher = more relevant. Truncation drops lowest scores first. */
  score?: number;
  id?: string;
};

/** Recalled memory item — truncateable by score like knowledge passages. */
export type ContextMemoryItem = {
  text: string;
  /** Higher = more relevant. Truncation drops lowest scores first. */
  score?: number;
  id?: string;
  kind?: string;
};

export type ContextBudgetMeasureInput = {
  /** Assembled / history messages (system + turns). */
  messages?: readonly ChatMessage[];
  /** Retrieval passages competing for headroom. */
  retrieval?: readonly ContextRetrievalPassage[];
  /** Recalled memories competing for headroom. */
  memories?: readonly ContextMemoryItem[];
  /**
   * Pending dynamic block for the current turn (utterance / per-turn context).
   * Always included in tokensUsed / headroom.
   */
  pendingDynamicBlock?: string;
  /**
   * Protected texts that must remain in context (refusals, active plan
   * constraints). Counted in tokensUsed; never omitted from the estimate
   * and never truncated.
   */
  protectedTexts?: readonly string[];
};

export type ContextBudgetSnapshot = {
  subjectId: string;
  deviceId?: string;
  modelId: string;
  contextWindow: number;
  compactionThreshold: number;
  tokensUsed: number;
  headroom: number;
  utilization: number;
  shouldCompact: boolean;
  messageTokens: number;
  retrievalTokens: number;
  memoryTokens: number;
  pendingDynamicTokens: number;
  protectedTokens: number;
  usedConservativeDefault: boolean;
  advisory: ContextBudgetAdvisoryCode | null;
};

export type TruncateRecallKnowledgeInput = {
  memories?: readonly ContextMemoryItem[];
  retrieval?: readonly ContextRetrievalPassage[];
  messages?: readonly ChatMessage[];
  pendingDynamicBlock?: string;
  /** Extra protected strings (merged with refusals / activeConstraints). */
  protectedTexts?: readonly string[];
  /** profile.refusals — never truncated. */
  refusals?: readonly string[];
  /** Active plan constraint strings — never truncated. */
  activeConstraints?: readonly string[];
  /**
   * Max tokens for memories+retrieval after reserved (messages + protected +
   * pending). Default: floor(contextWindow × compactionThreshold) − reserved.
   */
  truncateableBudgetTokens?: number;
};

export type TruncateRecallKnowledgeAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  memoriesKept: ContextMemoryItem[];
  retrievalKept: ContextRetrievalPassage[];
  memoriesDropped: number;
  retrievalDropped: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Opaque hash of kept ids / drop counts — never content. */
  selectionHash: string;
  /** Always true on success — refusals/constraints retained. */
  protectedPreserved: true;
  truncateableBudgetTokens: number;
  reservedTokens: number;
  snapshot: ContextBudgetSnapshot;
};

export type TruncateRecallKnowledgeRejected = {
  ok: false;
  failureClass: ContextBudgetFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type TruncateRecallKnowledgeResult =
  | TruncateRecallKnowledgeAccepted
  | TruncateRecallKnowledgeRejected;

export type ContextBudgetTelemetryEvent = {
  event: "runtime.harness.context_budget";
  outcome: "ok" | "rejected";
  subjectId: string | null;
  deviceId?: string;
  action?:
    | "load_model_card"
    | "estimate"
    | "measure"
    | "should_compact"
    | "truncate";
  modelId?: string;
  contextWindow?: number;
  tokensUsed?: number;
  headroom?: number;
  utilization?: number;
  shouldCompact?: boolean;
  messageTokens?: number;
  retrievalTokens?: number;
  memoryTokens?: number;
  pendingDynamicTokens?: number;
  protectedTokens?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  memoriesDropped?: number;
  retrievalDropped?: number;
  selectionHash?: string;
  usedConservativeDefault?: boolean;
  advisory?: ContextBudgetAdvisoryCode;
  failureClass?: ContextBudgetFailureClass;
};

export type ContextBudgetManagerOptions = {
  subjectId: string;
  deviceId?: string;
  modelCard: ContextModelCard | ModelDescriptor;
  /** Fraction of window that triggers compaction (default 0.75). */
  compactionThreshold?: number;
  onTelemetry?: (event: ContextBudgetTelemetryEvent) => void;
};

export type ContextBudgetMeasureAccepted = {
  ok: true;
  snapshot: ContextBudgetSnapshot;
};

export type ContextBudgetMeasureRejected = {
  ok: false;
  failureClass: ContextBudgetFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type ContextBudgetMeasureResult =
  | ContextBudgetMeasureAccepted
  | ContextBudgetMeasureRejected;

/**
 * Resolve contextWindow from a model card. Missing/non-positive windows yield
 * the conservative default and an advisory — never an implicit infinite window.
 */
export function loadContextWindowFromModelCard(modelCard: ContextModelCard | ModelDescriptor): {
  modelId: string;
  contextWindow: number;
  usedConservativeDefault: boolean;
  advisory: ContextBudgetAdvisoryCode | null;
} {
  const modelId =
    typeof modelCard?.modelId === "string" ? modelCard.modelId.trim() : "";
  const raw = (modelCard as ContextModelCard)?.contextWindow;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return {
      modelId,
      contextWindow: Math.floor(raw),
      usedConservativeDefault: false,
      advisory: null,
    };
  }
  return {
    modelId,
    contextWindow: CONTEXT_WINDOW_CONSERVATIVE_DEFAULT,
    usedConservativeDefault: true,
    advisory: CONTEXT_ADVISORY_MISSING_WINDOW,
  };
}

/**
 * Documented heuristic token estimate. Stable across process restarts for
 * identical strings. Prefer card.estimateTokens when the host supplies one.
 */
export function estimateContextTextTokens(
  text: string,
  estimateTokens?: (text: string) => number,
): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  if (estimateTokens) {
    const n = estimateTokens(text);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.ceil(n);
  }
  return Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Subject-scoped context window budget tracker.
 */
export class ContextBudgetManager {
  readonly subjectId: string;
  readonly deviceId: string | undefined;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly compactionThreshold: number;
  readonly usedConservativeDefault: boolean;
  readonly advisory: ContextBudgetAdvisoryCode | null;

  private readonly estimateTokensFn:
    | ((text: string) => number)
    | undefined;
  private readonly onTelemetry:
    | ((event: ContextBudgetTelemetryEvent) => void)
    | undefined;
  private lastSnapshot: ContextBudgetSnapshot | undefined;

  constructor(options: ContextBudgetManagerOptions) {
    const subjectId =
      typeof options.subjectId === "string" ? options.subjectId.trim() : "";
    if (!subjectId) {
      throw new Error("ContextBudgetManager requires non-empty subjectId");
    }
    const loaded = loadContextWindowFromModelCard(options.modelCard);
    if (!loaded.modelId) {
      throw new Error("ContextBudgetManager requires non-empty modelCard.modelId");
    }
    const threshold =
      options.compactionThreshold ?? CONTEXT_COMPACTION_THRESHOLD_DEFAULT;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error(
        "ContextBudgetManager compactionThreshold must be in (0, 1]",
      );
    }

    this.subjectId = subjectId;
    this.deviceId =
      options.deviceId !== undefined ? options.deviceId : undefined;
    this.modelId = loaded.modelId;
    this.contextWindow = loaded.contextWindow;
    this.compactionThreshold = threshold;
    this.usedConservativeDefault = loaded.usedConservativeDefault;
    this.advisory = loaded.advisory;
    this.estimateTokensFn =
      typeof (options.modelCard as ContextModelCard).estimateTokens ===
      "function"
        ? (options.modelCard as ContextModelCard).estimateTokens
        : undefined;
    this.onTelemetry = options.onTelemetry;

    this.emit({
      outcome: "ok",
      action: "load_model_card",
      modelId: this.modelId,
      contextWindow: this.contextWindow,
      usedConservativeDefault: this.usedConservativeDefault,
      ...(this.advisory !== null ? { advisory: this.advisory } : {}),
    });
  }

  /** Last successful {@link measure} snapshot, if any. */
  get snapshot(): ContextBudgetSnapshot | undefined {
    return this.lastSnapshot;
  }

  /** tokensUsed from the last measure; 0 before first measure. */
  get tokensUsed(): number {
    return this.lastSnapshot?.tokensUsed ?? 0;
  }

  /** headroom from the last measure; full window before first measure. */
  get headroom(): number {
    return this.lastSnapshot?.headroom ?? this.contextWindow;
  }

  estimateText(text: string): number {
    return estimateContextTextTokens(text, this.estimateTokensFn);
  }

  /**
   * Estimate tokens for chat messages. Bounded by {@link CONTEXT_MESSAGE_LIMIT}.
   */
  estimateMessages(
    messages: readonly ChatMessage[],
  ):
    | { ok: true; tokens: number; count: number }
    | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } {
    if (!Array.isArray(messages)) {
      return {
        ok: false,
        failureClass: "invalid_messages",
        detail: "messages must be an array",
      };
    }
    if (messages.length > CONTEXT_MESSAGE_LIMIT) {
      return {
        ok: false,
        failureClass: "message_limit",
        detail: `messages exceed limit ${CONTEXT_MESSAGE_LIMIT}`,
      };
    }
    let tokens = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i]!;
      if (typeof msg?.content !== "string") {
        return {
          ok: false,
          failureClass: "invalid_messages",
          detail: `messages[${i}].content must be a string`,
        };
      }
      if (msg.content.length > CONTEXT_SECTION_CHAR_LIMIT) {
        return {
          ok: false,
          failureClass: "section_limit",
          detail: `messages[${i}].content exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
        };
      }
      tokens += this.estimateText(msg.content);
    }
    this.emit({
      outcome: "ok",
      action: "estimate",
      modelId: this.modelId,
      messageTokens: tokens,
    });
    return { ok: true, tokens, count: messages.length };
  }

  /**
   * Estimate tokens for retrieval passages. Bounded by
   * {@link CONTEXT_RETRIEVAL_LIMIT}.
   */
  estimateRetrieval(
    passages: readonly ContextRetrievalPassage[],
  ):
    | { ok: true; tokens: number; count: number }
    | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } {
    if (!Array.isArray(passages)) {
      return {
        ok: false,
        failureClass: "invalid_retrieval",
        detail: "retrieval must be an array",
      };
    }
    if (passages.length > CONTEXT_RETRIEVAL_LIMIT) {
      return {
        ok: false,
        failureClass: "retrieval_limit",
        detail: `retrieval exceeds limit ${CONTEXT_RETRIEVAL_LIMIT}`,
      };
    }
    let tokens = 0;
    for (let i = 0; i < passages.length; i += 1) {
      const p = passages[i]!;
      if (typeof p?.text !== "string") {
        return {
          ok: false,
          failureClass: "invalid_retrieval",
          detail: `retrieval[${i}].text must be a string`,
        };
      }
      if (p.text.length > CONTEXT_SECTION_CHAR_LIMIT) {
        return {
          ok: false,
          failureClass: "section_limit",
          detail: `retrieval[${i}].text exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
        };
      }
      tokens += this.estimateText(p.text);
    }
    this.emit({
      outcome: "ok",
      action: "estimate",
      modelId: this.modelId,
      retrievalTokens: tokens,
    });
    return { ok: true, tokens, count: passages.length };
  }

  /**
   * Estimate tokens for recalled memories. Bounded by
   * {@link CONTEXT_MEMORY_LIMIT}.
   */
  estimateMemories(
    memories: readonly ContextMemoryItem[],
  ):
    | { ok: true; tokens: number; count: number }
    | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } {
    if (!Array.isArray(memories)) {
      return {
        ok: false,
        failureClass: "invalid_memories",
        detail: "memories must be an array",
      };
    }
    if (memories.length > CONTEXT_MEMORY_LIMIT) {
      return {
        ok: false,
        failureClass: "memory_limit",
        detail: `memories exceed limit ${CONTEXT_MEMORY_LIMIT}`,
      };
    }
    let tokens = 0;
    for (let i = 0; i < memories.length; i += 1) {
      const item = memories[i]!;
      if (typeof item?.text !== "string") {
        return {
          ok: false,
          failureClass: "invalid_memories",
          detail: `memories[${i}].text must be a string`,
        };
      }
      if (item.text.length > CONTEXT_SECTION_CHAR_LIMIT) {
        return {
          ok: false,
          failureClass: "section_limit",
          detail: `memories[${i}].text exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
        };
      }
      tokens += this.estimateText(item.text);
    }
    this.emit({
      outcome: "ok",
      action: "estimate",
      modelId: this.modelId,
      memoryTokens: tokens,
    });
    return { ok: true, tokens, count: memories.length };
  }

  /**
   * Compute tokensUsed / headroom for the current turn.
   * Pending dynamic block is always included in the headroom calculation.
   */
  measure(input: ContextBudgetMeasureInput = {}): ContextBudgetMeasureResult {
    const messages = input.messages ?? [];
    const retrieval = input.retrieval ?? [];
    const memories = input.memories ?? [];
    const protectedTexts = input.protectedTexts ?? [];

    const msgEst = this.estimateMessages(messages);
    if (!msgEst.ok) {
      return this.rejectMeasure(msgEst.failureClass, msgEst.detail);
    }
    const retEst = this.estimateRetrieval(retrieval);
    if (!retEst.ok) {
      return this.rejectMeasure(retEst.failureClass, retEst.detail);
    }
    const memEst = this.estimateMemories(memories);
    if (!memEst.ok) {
      return this.rejectMeasure(memEst.failureClass, memEst.detail);
    }

    const protectedEst = this.estimateProtectedTexts(protectedTexts);
    if (!protectedEst.ok) {
      return this.rejectMeasure(protectedEst.failureClass, protectedEst.detail);
    }

    const pending =
      typeof input.pendingDynamicBlock === "string"
        ? input.pendingDynamicBlock
        : "";
    if (pending.length > CONTEXT_SECTION_CHAR_LIMIT) {
      return this.rejectMeasure(
        "section_limit",
        `pendingDynamicBlock exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
      );
    }
    const pendingDynamicTokens = this.estimateText(pending);

    const tokensUsed =
      msgEst.tokens +
      retEst.tokens +
      memEst.tokens +
      protectedEst.tokens +
      pendingDynamicTokens;
    const headroom = Math.max(0, this.contextWindow - tokensUsed);
    const utilization =
      this.contextWindow > 0 ? tokensUsed / this.contextWindow : 1;
    const shouldCompact =
      headroom === 0 || utilization >= this.compactionThreshold;

    const snapshot: ContextBudgetSnapshot = {
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      modelId: this.modelId,
      contextWindow: this.contextWindow,
      compactionThreshold: this.compactionThreshold,
      tokensUsed,
      headroom,
      utilization,
      shouldCompact,
      messageTokens: msgEst.tokens,
      retrievalTokens: retEst.tokens,
      memoryTokens: memEst.tokens,
      pendingDynamicTokens,
      protectedTokens: protectedEst.tokens,
      usedConservativeDefault: this.usedConservativeDefault,
      advisory: this.advisory,
    };
    this.lastSnapshot = snapshot;

    this.emit({
      outcome: "ok",
      action: "measure",
      modelId: this.modelId,
      contextWindow: this.contextWindow,
      tokensUsed,
      headroom,
      utilization,
      shouldCompact,
      messageTokens: msgEst.tokens,
      retrievalTokens: retEst.tokens,
      memoryTokens: memEst.tokens,
      pendingDynamicTokens,
      protectedTokens: protectedEst.tokens,
      usedConservativeDefault: this.usedConservativeDefault,
      ...(this.advisory !== null ? { advisory: this.advisory } : {}),
    });

    return { ok: true, snapshot };
  }

  /**
   * Drop lowest-score memories and knowledge passages until the truncateable
   * pool fits under the compaction-threshold budget. Never truncates
   * refusals or active plan constraints.
   */
  truncateRecallAndKnowledge(
    input: TruncateRecallKnowledgeInput = {},
  ): TruncateRecallKnowledgeResult {
    const memoriesIn = input.memories ?? [];
    const retrievalIn = input.retrieval ?? [];
    const messages = input.messages ?? [];
    const pending =
      typeof input.pendingDynamicBlock === "string"
        ? input.pendingDynamicBlock
        : "";

    const protectedMerged = mergeProtectedTexts({
      ...(input.protectedTexts !== undefined
        ? { protectedTexts: input.protectedTexts }
        : {}),
      ...(input.refusals !== undefined ? { refusals: input.refusals } : {}),
      ...(input.activeConstraints !== undefined
        ? { activeConstraints: input.activeConstraints }
        : {}),
    });
    if (!protectedMerged.ok) {
      return this.rejectTruncate(protectedMerged.failureClass, protectedMerged.detail);
    }

    const msgEst = this.estimateMessages(messages);
    if (!msgEst.ok) {
      return this.rejectTruncate(msgEst.failureClass, msgEst.detail);
    }
    const memEst = this.estimateMemories(memoriesIn);
    if (!memEst.ok) {
      return this.rejectTruncate(memEst.failureClass, memEst.detail);
    }
    const retEst = this.estimateRetrieval(retrievalIn);
    if (!retEst.ok) {
      return this.rejectTruncate(retEst.failureClass, retEst.detail);
    }
    const protectedEst = this.estimateProtectedTexts(protectedMerged.texts);
    if (!protectedEst.ok) {
      return this.rejectTruncate(protectedEst.failureClass, protectedEst.detail);
    }
    if (pending.length > CONTEXT_SECTION_CHAR_LIMIT) {
      return this.rejectTruncate(
        "section_limit",
        `pendingDynamicBlock exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
      );
    }
    const pendingDynamicTokens = this.estimateText(pending);
    const reservedTokens =
      msgEst.tokens + protectedEst.tokens + pendingDynamicTokens;

    const thresholdBudget = Math.floor(
      this.contextWindow * this.compactionThreshold,
    );
    const defaultTruncateable = Math.max(0, thresholdBudget - reservedTokens);
    let truncateableBudget = defaultTruncateable;
    if (input.truncateableBudgetTokens !== undefined) {
      if (
        !Number.isInteger(input.truncateableBudgetTokens) ||
        input.truncateableBudgetTokens < 0
      ) {
        return this.rejectTruncate(
          "invalid_retrieval",
          "truncateableBudgetTokens must be a non-negative integer",
        );
      }
      truncateableBudget = input.truncateableBudgetTokens;
    }

    const tokensBefore =
      reservedTokens + memEst.tokens + retEst.tokens;

    const scored = buildScoredTruncateCandidates(
      memoriesIn,
      retrievalIn,
      (text) => this.estimateText(text),
    );
    const truncated = truncateScoredCandidates(scored, truncateableBudget);

    const memoriesKept = truncated.kept
      .filter((c) => c.kind === "memory")
      .sort((a, b) => a.index - b.index)
      .map((c) => memoriesIn[c.index]!);
    const retrievalKept = truncated.kept
      .filter((c) => c.kind === "retrieval")
      .sort((a, b) => a.index - b.index)
      .map((c) => retrievalIn[c.index]!);

    const memoriesDropped = memoriesIn.length - memoriesKept.length;
    const retrievalDropped = retrievalIn.length - retrievalKept.length;
    const tokensAfter =
      reservedTokens + truncated.keptTokens;

    const selectionHash = hashTruncateSelection({
      memoryIds: memoriesKept.map((m, i) => m.id ?? `m${i}`),
      retrievalIds: retrievalKept.map((p, i) => p.id ?? `p${i}`),
      memoriesDropped,
      retrievalDropped,
      tokensBefore,
      tokensAfter,
      truncateableBudgetTokens: truncateableBudget,
    });

    // Refuse if any protected string was somehow absent from the merged set
    // we counted (invariant: protected set is exactly what we reserved).
    const protectedPreserved = protectedMerged.texts.every(
      (t) => typeof t === "string",
    );
    if (!protectedPreserved) {
      return this.rejectTruncate(
        "invalid_messages",
        "protected texts must be preserved under truncation",
      );
    }

    const measured = this.measure({
      messages,
      memories: memoriesKept,
      retrieval: retrievalKept,
      pendingDynamicBlock: pending,
      protectedTexts: protectedMerged.texts,
    });
    if (!measured.ok) {
      return this.rejectTruncate(measured.failureClass, measured.detail);
    }

    this.emit({
      outcome: "ok",
      action: "truncate",
      modelId: this.modelId,
      contextWindow: this.contextWindow,
      tokensBefore,
      tokensAfter,
      tokensUsed: measured.snapshot.tokensUsed,
      headroom: measured.snapshot.headroom,
      utilization: measured.snapshot.utilization,
      shouldCompact: measured.snapshot.shouldCompact,
      memoryTokens: measured.snapshot.memoryTokens,
      retrievalTokens: measured.snapshot.retrievalTokens,
      protectedTokens: measured.snapshot.protectedTokens,
      pendingDynamicTokens: measured.snapshot.pendingDynamicTokens,
      memoriesDropped,
      retrievalDropped,
      selectionHash,
    });

    return {
      ok: true,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      memoriesKept,
      retrievalKept,
      memoriesDropped,
      retrievalDropped,
      tokensBefore,
      tokensAfter,
      selectionHash,
      protectedPreserved: true,
      truncateableBudgetTokens: truncateableBudget,
      reservedTokens,
      snapshot: measured.snapshot,
    };
  }

  /**
   * Whether compaction should run before the next generate.
   * When `input` is omitted, uses the last {@link measure} snapshot
   * (false before first measure — hosts must measure first).
   */
  shouldCompact(input?: ContextBudgetMeasureInput): boolean {
    if (input !== undefined) {
      const measured = this.measure(input);
      if (!measured.ok) {
        this.emit({
          outcome: "rejected",
          action: "should_compact",
          failureClass: measured.failureClass,
          shouldCompact: false,
        });
        return false;
      }
      this.emit({
        outcome: "ok",
        action: "should_compact",
        modelId: this.modelId,
        shouldCompact: measured.snapshot.shouldCompact,
        tokensUsed: measured.snapshot.tokensUsed,
        headroom: measured.snapshot.headroom,
        utilization: measured.snapshot.utilization,
      });
      return measured.snapshot.shouldCompact;
    }
    const flag = this.lastSnapshot?.shouldCompact ?? false;
    this.emit({
      outcome: "ok",
      action: "should_compact",
      modelId: this.modelId,
      shouldCompact: flag,
      ...(this.lastSnapshot !== undefined
        ? {
            tokensUsed: this.lastSnapshot.tokensUsed,
            headroom: this.lastSnapshot.headroom,
            utilization: this.lastSnapshot.utilization,
          }
        : {}),
    });
    return flag;
  }

  private estimateProtectedTexts(
    protectedTexts: readonly string[],
  ):
    | { ok: true; tokens: number }
    | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } {
    if (!Array.isArray(protectedTexts)) {
      return {
        ok: false,
        failureClass: "invalid_messages",
        detail: "protectedTexts must be an array",
      };
    }
    if (protectedTexts.length > CONTEXT_MESSAGE_LIMIT) {
      return {
        ok: false,
        failureClass: "message_limit",
        detail: `protectedTexts exceed limit ${CONTEXT_MESSAGE_LIMIT}`,
      };
    }
    let tokens = 0;
    for (let i = 0; i < protectedTexts.length; i += 1) {
      const text = protectedTexts[i];
      if (typeof text !== "string") {
        return {
          ok: false,
          failureClass: "invalid_messages",
          detail: `protectedTexts[${i}] must be a string`,
        };
      }
      if (text.length > CONTEXT_SECTION_CHAR_LIMIT) {
        return {
          ok: false,
          failureClass: "section_limit",
          detail: `protectedTexts[${i}] exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
        };
      }
      tokens += this.estimateText(text);
    }
    return { ok: true, tokens };
  }

  private rejectMeasure(
    failureClass: ContextBudgetFailureClass,
    detail: string,
  ): ContextBudgetMeasureRejected {
    this.emit({
      outcome: "rejected",
      action: "measure",
      failureClass,
      modelId: this.modelId,
    });
    return {
      ok: false,
      failureClass,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
    };
  }

  private rejectTruncate(
    failureClass: ContextBudgetFailureClass,
    detail: string,
  ): TruncateRecallKnowledgeRejected {
    this.emit({
      outcome: "rejected",
      action: "truncate",
      failureClass,
      modelId: this.modelId,
    });
    return {
      ok: false,
      failureClass,
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      detail,
    };
  }

  private emit(
    partial: Omit<
      ContextBudgetTelemetryEvent,
      "event" | "subjectId" | "deviceId"
    >,
  ): void {
    this.onTelemetry?.({
      event: "runtime.harness.context_budget",
      subjectId: this.subjectId,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
      ...partial,
    });
  }
}

type ScoredTruncateCandidate = {
  kind: "memory" | "retrieval";
  index: number;
  score: number;
  tokens: number;
  id: string;
};

function mergeProtectedTexts(input: {
  protectedTexts?: readonly string[];
  refusals?: readonly string[];
  activeConstraints?: readonly string[];
}):
  | { ok: true; texts: string[] }
  | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushAll = (
    arr: readonly string[] | undefined,
    label: string,
  ):
    | { ok: true }
    | { ok: false; failureClass: ContextBudgetFailureClass; detail: string } => {
    if (arr === undefined) return { ok: true };
    if (!Array.isArray(arr)) {
      return {
        ok: false,
        failureClass: "invalid_messages",
        detail: `${label} must be an array`,
      };
    }
    for (let i = 0; i < arr.length; i += 1) {
      const text = arr[i];
      if (typeof text !== "string") {
        return {
          ok: false,
          failureClass: "invalid_messages",
          detail: `${label}[${i}] must be a string`,
        };
      }
      if (text.length > CONTEXT_SECTION_CHAR_LIMIT) {
        return {
          ok: false,
          failureClass: "section_limit",
          detail: `${label}[${i}] exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
        };
      }
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    return { ok: true };
  };
  for (const [arr, label] of [
    [input.protectedTexts, "protectedTexts"],
    [input.refusals, "refusals"],
    [input.activeConstraints, "activeConstraints"],
  ] as const) {
    const r = pushAll(arr, label);
    if (!r.ok) return r;
  }
  if (out.length > CONTEXT_MESSAGE_LIMIT) {
    return {
      ok: false,
      failureClass: "message_limit",
      detail: `protected texts exceed limit ${CONTEXT_MESSAGE_LIMIT}`,
    };
  }
  return { ok: true, texts: out };
}

/**
 * Build scored truncate candidates. Exported for unit determinism checks.
 */
export function buildScoredTruncateCandidates(
  memories: readonly ContextMemoryItem[],
  retrieval: readonly ContextRetrievalPassage[],
  estimateTokens: (text: string) => number,
): ScoredTruncateCandidate[] {
  const out: ScoredTruncateCandidate[] = [];
  for (let i = 0; i < memories.length; i += 1) {
    const m = memories[i]!;
    out.push({
      kind: "memory",
      index: i,
      score: typeof m.score === "number" && Number.isFinite(m.score) ? m.score : 0,
      tokens: estimateTokens(m.text),
      id: typeof m.id === "string" && m.id.trim() ? m.id.trim() : `m${i}`,
    });
  }
  for (let i = 0; i < retrieval.length; i += 1) {
    const p = retrieval[i]!;
    out.push({
      kind: "retrieval",
      index: i,
      score: typeof p.score === "number" && Number.isFinite(p.score) ? p.score : 0,
      tokens: estimateTokens(p.text),
      id: typeof p.id === "string" && p.id.trim() ? p.id.trim() : `p${i}`,
    });
  }
  return out;
}

/**
 * Drop lowest-score candidates first until kept tokens ≤ budget.
 * Tie-break: lower score, then memory before retrieval, then higher index.
 */
export function truncateScoredCandidates(
  candidates: readonly ScoredTruncateCandidate[],
  budgetTokens: number,
): { kept: ScoredTruncateCandidate[]; keptTokens: number } {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const ordered = [...candidates].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score; // drop low score first
    if (a.kind !== b.kind) return a.kind === "memory" ? -1 : 1;
    return b.index - a.index; // drop later items first on ties
  });

  const dropped = new Set<string>();
  let total = candidates.reduce((n, c) => n + c.tokens, 0);
  for (const c of ordered) {
    if (total <= budget) break;
    const key = `${c.kind}:${c.index}`;
    if (dropped.has(key)) continue;
    dropped.add(key);
    total -= c.tokens;
  }

  const kept = candidates.filter((c) => !dropped.has(`${c.kind}:${c.index}`));
  const keptTokens = kept.reduce((n, c) => n + c.tokens, 0);
  return { kept, keptTokens };
}

function hashTruncateSelection(payload: {
  memoryIds: string[];
  retrievalIds: string[];
  memoriesDropped: number;
  retrievalDropped: number;
  tokensBefore: number;
  tokensAfter: number;
  truncateableBudgetTokens: number;
}): string {
  const canonical = JSON.stringify({
    memoriesDropped: payload.memoriesDropped,
    memoryIds: [...payload.memoryIds].sort(),
    retrievalDropped: payload.retrievalDropped,
    retrievalIds: [...payload.retrievalIds].sort(),
    tokensAfter: payload.tokensAfter,
    tokensBefore: payload.tokensBefore,
    truncateableBudgetTokens: payload.truncateableBudgetTokens,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Golden case locking context-budget threshold / truncation boundaries. */
export type GoldenContextBudgetCase = {
  id: string;
  /** Spec / epic signal this golden protects (product language — not a task id). */
  specId: string;
  protects: string;
  kind: "measure" | "truncate" | "missing_window";
  subjectId: string;
  deviceId?: string;
  modelCard: ContextModelCard;
  input?: {
    messages?: ChatMessage[];
    pendingDynamicBlock?: string;
    protectedTexts?: string[];
    memories?: ContextMemoryItem[];
    retrieval?: ContextRetrievalPassage[];
    refusals?: string[];
    activeConstraints?: string[];
    truncateableBudgetTokens?: number;
  };
  expected: {
    shouldCompact?: boolean;
    tokensUsed?: number;
    headroom?: number;
    utilization?: number;
    pendingDynamicTokens?: number;
    contextWindow?: number;
    usedConservativeDefault?: boolean;
    advisory?: ContextBudgetAdvisoryCode | null;
    protectedPreserved?: boolean;
    memoriesDropped?: number;
    retrievalDropped?: number;
    memoriesKeptCount?: number;
    retrievalKeptCount?: number;
    protectedTokens?: number;
  };
};

export type GoldenContextBudgetCorpus = {
  description: string;
  cases: GoldenContextBudgetCase[];
};

export type GoldenContextBudgetAccepted = {
  ok: true;
  caseId: string;
  subjectId: string;
  deviceId?: string;
  kind: GoldenContextBudgetCase["kind"];
  shouldCompact?: boolean;
  canonicalExpectationJson: string;
  expectedCanonicalExpectationJson: string;
  telemetry: ContextBudgetTelemetryEvent[];
};

export type GoldenContextBudgetRejected = {
  ok: false;
  failureClass: ContextBudgetFailureClass | "expectation_mismatch" | "canonical_drift";
  subjectId: string | null;
  deviceId?: string;
  caseId?: string;
  detail: string;
  canonicalExpectationJson?: string;
  expectedCanonicalExpectationJson?: string;
};

export type GoldenContextBudgetResult =
  | GoldenContextBudgetAccepted
  | GoldenContextBudgetRejected;

/**
 * Canonical JSON of the threshold expectation surface for golden byte compare.
 */
export function canonicalizeContextBudgetExpectationJson(
  surface: Record<string, unknown>,
): string {
  return `${JSON.stringify(sortKeysDeepLocal(surface), null, 2)}\n`;
}

function sortKeysDeepLocal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeepLocal);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeepLocal(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Replay one threshold golden through {@link ContextBudgetManager}.
 * Asserts 74% stays cold; 75% / 76% signal compaction; refusals survive truncation.
 */
export function replayContextBudgetThresholdCase(
  fixtureCase: GoldenContextBudgetCase,
): GoldenContextBudgetResult {
  const caseId =
    typeof fixtureCase.id === "string" ? fixtureCase.id.trim() : "";
  const subjectId =
    typeof fixtureCase.subjectId === "string"
      ? fixtureCase.subjectId.trim()
      : "";
  if (!caseId) {
    return {
      ok: false,
      failureClass: "invalid_model_card",
      subjectId: subjectId || null,
      detail: "golden context-budget case requires non-empty id",
    };
  }
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      caseId,
      detail: "golden context-budget case requires non-empty subjectId",
    };
  }

  const telemetry: ContextBudgetTelemetryEvent[] = [];
  let manager: ContextBudgetManager;
  try {
    manager = new ContextBudgetManager({
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      modelCard: fixtureCase.modelCard,
      onTelemetry: (e) => {
        telemetry.push(e);
      },
    });
  } catch (err) {
    return {
      ok: false,
      failureClass: "invalid_model_card",
      subjectId,
      caseId,
      detail: err instanceof Error ? err.message : "failed to construct manager",
    };
  }

  let actualFull: Record<string, unknown>;

  if (fixtureCase.kind === "missing_window") {
    actualFull = {
      contextWindow: manager.contextWindow,
      usedConservativeDefault: manager.usedConservativeDefault,
      advisory: manager.advisory,
    };
  } else if (fixtureCase.kind === "measure") {
    const measured = manager.measure({
      messages: fixtureCase.input?.messages ?? [],
      pendingDynamicBlock: fixtureCase.input?.pendingDynamicBlock ?? "",
      ...(fixtureCase.input?.protectedTexts !== undefined
        ? { protectedTexts: fixtureCase.input.protectedTexts }
        : {}),
      ...(fixtureCase.input?.memories !== undefined
        ? { memories: fixtureCase.input.memories }
        : {}),
      ...(fixtureCase.input?.retrieval !== undefined
        ? { retrieval: fixtureCase.input.retrieval }
        : {}),
    });
    if (!measured.ok) {
      return {
        ok: false,
        failureClass: measured.failureClass,
        subjectId: measured.subjectId,
        ...(measured.deviceId !== undefined
          ? { deviceId: measured.deviceId }
          : {}),
        caseId,
        detail: measured.detail,
      };
    }
    actualFull = {
      shouldCompact: measured.snapshot.shouldCompact,
      tokensUsed: measured.snapshot.tokensUsed,
      headroom: measured.snapshot.headroom,
      utilization: measured.snapshot.utilization,
      pendingDynamicTokens: measured.snapshot.pendingDynamicTokens,
      usedConservativeDefault: measured.snapshot.usedConservativeDefault,
      advisory: measured.snapshot.advisory,
    };
  } else if (fixtureCase.kind === "truncate") {
    const truncated = manager.truncateRecallAndKnowledge({
      messages: fixtureCase.input?.messages ?? [],
      pendingDynamicBlock: fixtureCase.input?.pendingDynamicBlock ?? "",
      ...(fixtureCase.input?.refusals !== undefined
        ? { refusals: fixtureCase.input.refusals }
        : {}),
      ...(fixtureCase.input?.activeConstraints !== undefined
        ? { activeConstraints: fixtureCase.input.activeConstraints }
        : {}),
      ...(fixtureCase.input?.protectedTexts !== undefined
        ? { protectedTexts: fixtureCase.input.protectedTexts }
        : {}),
      ...(fixtureCase.input?.memories !== undefined
        ? { memories: fixtureCase.input.memories }
        : {}),
      ...(fixtureCase.input?.retrieval !== undefined
        ? { retrieval: fixtureCase.input.retrieval }
        : {}),
      ...(fixtureCase.input?.truncateableBudgetTokens !== undefined
        ? {
            truncateableBudgetTokens:
              fixtureCase.input.truncateableBudgetTokens,
          }
        : {}),
    });
    if (!truncated.ok) {
      return {
        ok: false,
        failureClass: truncated.failureClass,
        subjectId: truncated.subjectId,
        ...(truncated.deviceId !== undefined
          ? { deviceId: truncated.deviceId }
          : {}),
        caseId,
        detail: truncated.detail,
      };
    }
    actualFull = {
      protectedPreserved: truncated.protectedPreserved,
      memoriesDropped: truncated.memoriesDropped,
      retrievalDropped: truncated.retrievalDropped,
      memoriesKeptCount: truncated.memoriesKept.length,
      retrievalKeptCount: truncated.retrievalKept.length,
      protectedTokens: truncated.snapshot.protectedTokens,
      shouldCompact: truncated.snapshot.shouldCompact,
    };
  } else {
    return {
      ok: false,
      failureClass: "invalid_model_card",
      subjectId,
      caseId,
      detail: `unknown golden kind: ${String((fixtureCase as { kind?: string }).kind)}`,
    };
  }

  // Compare only keys declared on the fixture expected surface.
  const expected = { ...fixtureCase.expected } as Record<string, unknown>;
  const actual: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    actual[key] = actualFull[key];
  }

  const canonicalExpectationJson =
    canonicalizeContextBudgetExpectationJson(actual);
  const expectedCanonicalExpectationJson =
    canonicalizeContextBudgetExpectationJson(expected);

  if (canonicalExpectationJson !== expectedCanonicalExpectationJson) {
    return {
      ok: false,
      failureClass: "canonical_drift",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId,
      detail: "context-budget threshold golden expectation byte drift",
      canonicalExpectationJson,
      expectedCanonicalExpectationJson,
    };
  }

  return {
    ok: true,
    caseId,
    subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
    kind: fixtureCase.kind,
    ...(typeof actualFull.shouldCompact === "boolean"
      ? { shouldCompact: actualFull.shouldCompact as boolean }
      : {}),
    canonicalExpectationJson,
    expectedCanonicalExpectationJson,
    telemetry,
  };
}
