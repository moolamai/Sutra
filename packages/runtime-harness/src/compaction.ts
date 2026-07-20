/**
 * Deterministic context compaction: structured summary compiler + trigger wire.
 *
 * Extracts open constraints, verified facts, and citation refs from durable
 * memory + knowledge state and renders a fixed template. No LLM /
 * model-provider invoke path in v1 — silent omission of numeric constraints is the
 * failure mode being avoided.
 *
 * On {@link ContextBudgetManager.shouldCompact}, replace eligible live context
 * with the compiled summary, emit tokensBefore/After + summaryHash, and
 * re-estimate headroom.
 *
 * Second pass: if the summary still exceeds the host token budget, drop
 * episodic detail only (constraints / facts / citations stay verbatim).
 *
 * Sovereignty: telemetry carries subject scope, token counts, and summaryHash
 * only — never constraint / fact / citation plaintext.
 */

import { createHash } from "node:crypto";
import type { ChatMessage } from "@moolam/contracts";
import {
  CONTEXT_CHARS_PER_TOKEN_ESTIMATE,
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_SECTION_CHAR_LIMIT,
  ContextBudgetManager,
  estimateContextTextTokens,
  type ContextBudgetSnapshot,
  type ContextMemoryItem,
  type ContextModelCard,
  type ContextRetrievalPassage,
} from "./context_budget.js";

/** Golden corpus: post-compaction refusal / citation retention. */
export const COMPACTION_RETENTION_FIXTURE_RELPATH =
  "fixtures/compaction-retention" as const;

/** Marker strings — byte-stable, never localized. */
export const COMPACTION_SUMMARY_MARKERS = Object.freeze({
  open: "<<<SUTRA_COMPACTION_SUMMARY>>>",
  close: "<<<END_SUTRA_COMPACTION_SUMMARY>>>",
  constraints: "### open_constraints",
  facts: "### verified_facts",
  citations: "### citation_refs",
  episodic: "### episodic_detail",
  none: "(none)",
} as const);

/** Soft cap on items per extracted section. */
export const COMPACTION_SECTION_ITEM_LIMIT = 64;

/** Default max tokens for a compiled summary before second-pass episodic drop. */
export const COMPACTION_SUMMARY_TOKEN_LIMIT_DEFAULT = 512;

export type CompactionFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_state"
  | "section_limit"
  | "deferred_tool_loop";

export type CompactionMemoryItem = {
  text: string;
  /** "constraint" | "refusal" | "fact" | "verified" | "episodic" | other. */
  kind?: string;
  id?: string;
};

export type CompactionKnowledgeItem = {
  text: string;
  id?: string;
  sourceId?: string;
  /** Preferred citation ref when present. */
  citation?: string;
};

/**
 * Durable state projected for compaction. Hosts map CognitiveBindings memory
 * / knowledge into this shape — no live interface objects.
 */
export type CompactionDurableState = {
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  /** Open constraints (plan / refusals) — survive verbatim. */
  openConstraints?: readonly string[];
  /** Verified facts — survive verbatim. */
  verifiedFacts?: readonly string[];
  /** Citation refs — survive verbatim. */
  citationRefs?: readonly string[];
  /** Episodic detail — may be dropped on second-pass budget fit. */
  episodicDetail?: readonly string[];
  memories?: readonly CompactionMemoryItem[];
  knowledge?: readonly CompactionKnowledgeItem[];
};

export type CompactionExtractedSections = {
  openConstraints: string[];
  verifiedFacts: string[];
  citationRefs: string[];
  episodicDetail: string[];
};

export type CompactionTelemetryEvent = {
  event: "runtime.harness.compaction";
  outcome: "ok" | "rejected" | "deferred" | "skipped";
  subjectId: string | null;
  deviceId?: string;
  sessionId?: string;
  action?:
    | "extract"
    | "compile"
    | "second_pass"
    | "trigger"
    | "replace"
    | "re_estimate"
    | "skipped";
  tokensBefore?: number;
  tokensAfter?: number;
  headroomBefore?: number;
  headroomAfter?: number;
  summaryHash?: string;
  constraintCount?: number;
  factCount?: number;
  citationCount?: number;
  episodicCount?: number;
  episodicDropped?: boolean;
  emptyStub?: boolean;
  compacted?: boolean;
  idempotentReplay?: boolean;
  memoriesDropped?: number;
  retrievalDropped?: number;
  messagesDropped?: number;
  failureClass?: CompactionFailureClass;
};

/** Live context slice the host can swap after a compaction trigger. */
export type CompactionContextSlice = {
  messages: ChatMessage[];
  memories: ContextMemoryItem[];
  retrieval: ContextRetrievalPassage[];
  pendingDynamicBlock: string;
  protectedTexts: string[];
};

export type ApplyCompactionTriggerOptions = {
  toolLoopActive?: boolean;
  maxSummaryTokens?: number;
  estimateTokens?: (text: string) => number;
  onTelemetry?: (event: CompactionTelemetryEvent) => void;
  /**
   * When set, a second call with the same key and identical post-replace
   * context is treated as an idempotent replay (no double side-effect
   * semantics for hosts that track the key).
   */
  idempotencyKey?: string;
};

export type ApplyCompactionTriggerAccepted = {
  ok: true;
  /** True when a summary was compiled and eligible context was replaced. */
  compacted: boolean;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  summary?: string;
  summaryHash?: string;
  /** Context-window tokens before replace (or before skip). */
  tokensBefore: number;
  /** Context-window tokens after replace / re-estimate. */
  tokensAfter: number;
  headroomBefore: number;
  headroomAfter: number;
  snapshot: ContextBudgetSnapshot;
  context: CompactionContextSlice;
  sections?: CompactionExtractedSections;
  emptyStub?: boolean;
  episodicDropped?: boolean;
  memoriesDropped?: number;
  retrievalDropped?: number;
  messagesDropped?: number;
  idempotentReplay?: boolean;
  usedLlm: false;
};

export type ApplyCompactionTriggerDeferred = {
  ok: false;
  deferred: true;
  failureClass: "deferred_tool_loop";
  subjectId: string;
  deviceId?: string;
  detail: string;
};

export type ApplyCompactionTriggerRejected = {
  ok: false;
  deferred?: false;
  failureClass: Exclude<CompactionFailureClass, "deferred_tool_loop">;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type ApplyCompactionTriggerResult =
  | ApplyCompactionTriggerAccepted
  | ApplyCompactionTriggerDeferred
  | ApplyCompactionTriggerRejected;

const PROTECTED_MEMORY_KINDS = new Set([
  "constraint",
  "refusal",
  "fact",
  "verified",
]);

/** In-process last applied idempotency key → summaryHash (bounded). */
const COMPACTION_IDEMPOTENCY_CAP = 256;
const compactionIdempotency = new Map<string, string>();

export type CompileStructuredSummaryAccepted = {
  ok: true;
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  summary: string;
  summaryHash: string;
  tokensBefore: number;
  tokensAfter: number;
  sections: CompactionExtractedSections;
  emptyStub: boolean;
  episodicDropped: boolean;
  /** Always false — this path never calls a model. */
  usedLlm: false;
};

export type CompileStructuredSummaryDeferred = {
  ok: false;
  deferred: true;
  failureClass: "deferred_tool_loop";
  subjectId: string;
  deviceId?: string;
  detail: string;
};

export type CompileStructuredSummaryRejected = {
  ok: false;
  deferred?: false;
  failureClass: Exclude<CompactionFailureClass, "deferred_tool_loop">;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type CompileStructuredSummaryResult =
  | CompileStructuredSummaryAccepted
  | CompileStructuredSummaryDeferred
  | CompileStructuredSummaryRejected;

export type CompileStructuredSummaryOptions = {
  /**
   * When true, compaction is deferred (e.g. active tool loop) — typed
   * deferral, not a silent skip.
   */
  toolLoopActive?: boolean;
  /** Token budget for the compiled summary; triggers second-pass when exceeded. */
  maxSummaryTokens?: number;
  estimateTokens?: (text: string) => number;
  onTelemetry?: (event: CompactionTelemetryEvent) => void;
};

/**
 * Extract constraints / facts / citations / episodic lines from durable state.
 * Deterministic ordering: explicit lists first (host order), then derived
 * memory/knowledge items in input order, deduped by exact string.
 */
export function extractCompactionSections(
  state: CompactionDurableState,
):
  | { ok: true; sections: CompactionExtractedSections }
  | {
      ok: false;
      failureClass: Exclude<CompactionFailureClass, "deferred_tool_loop">;
      detail: string;
    } {
  const constraints = collectBounded(
    [
      ...(state.openConstraints ?? []),
      ...deriveFromMemories(state.memories, "match", ["constraint", "refusal"]),
    ],
    "openConstraints",
  );
  if (!constraints.ok) return constraints;

  const facts = collectBounded(
    [
      ...(state.verifiedFacts ?? []),
      ...deriveFromMemories(state.memories, "match", ["fact", "verified"]),
    ],
    "verifiedFacts",
  );
  if (!facts.ok) return facts;

  const citations = collectBounded(
    [
      ...(state.citationRefs ?? []),
      ...deriveCitations(state.knowledge),
    ],
    "citationRefs",
  );
  if (!citations.ok) return citations;

  const episodic = collectBounded(
    [
      ...(state.episodicDetail ?? []),
      ...deriveFromMemories(state.memories, "episodic"),
    ],
    "episodicDetail",
  );
  if (!episodic.ok) return episodic;

  return {
    ok: true,
    sections: {
      openConstraints: constraints.items,
      verifiedFacts: facts.items,
      citationRefs: citations.items,
      episodicDetail: episodic.items,
    },
  };
}

/**
 * Render the fixed compaction template. Sections with no items emit `(none)`.
 * Episodic section is omitted entirely when `includeEpisodic` is false
 * (second-pass budget fit).
 */
export function renderCompactionSummaryTemplate(
  sections: CompactionExtractedSections,
  opts?: { includeEpisodic?: boolean },
): string {
  const includeEpisodic = opts?.includeEpisodic !== false;
  const lines: string[] = [
    COMPACTION_SUMMARY_MARKERS.open,
    COMPACTION_SUMMARY_MARKERS.constraints,
    ...renderSectionLines(sections.openConstraints),
    COMPACTION_SUMMARY_MARKERS.facts,
    ...renderSectionLines(sections.verifiedFacts),
    COMPACTION_SUMMARY_MARKERS.citations,
    ...renderSectionLines(sections.citationRefs),
  ];
  if (includeEpisodic) {
    lines.push(COMPACTION_SUMMARY_MARKERS.episodic);
    lines.push(...renderSectionLines(sections.episodicDetail));
  }
  lines.push(COMPACTION_SUMMARY_MARKERS.close);
  return lines.join("\n");
}

/**
 * Compile a structured compaction summary from durable state.
 * Pure over inputs — no model provider call. Empty durable state yields a minimal stub.
 */
export function compileStructuredSummary(input: {
  state: CompactionDurableState;
  options?: CompileStructuredSummaryOptions;
}): CompileStructuredSummaryResult {
  const opts = input.options;
  const subjectId = trimStr(input.state?.subjectId);
  if (!subjectId) {
    opts?.onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: null,
      action: "compile",
      failureClass: "missing_subject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "state.subjectId required",
    };
  }

  if (opts?.toolLoopActive === true) {
    opts.onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "deferred",
      subjectId,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      ...(input.state.sessionId !== undefined
        ? { sessionId: input.state.sessionId }
        : {}),
      action: "compile",
      failureClass: "deferred_tool_loop",
    });
    return {
      ok: false,
      deferred: true,
      failureClass: "deferred_tool_loop",
      subjectId,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      detail:
        "compaction deferred until tool loop completes or abort",
    };
  }

  const extracted = extractCompactionSections(input.state);
  if (!extracted.ok) {
    opts?.onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      action: "extract",
      failureClass: extracted.failureClass,
    });
    return {
      ok: false,
      failureClass: extracted.failureClass,
      subjectId,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      detail: extracted.detail,
    };
  }

  const sections = extracted.sections;
  opts?.onTelemetry?.({
    event: "runtime.harness.compaction",
    outcome: "ok",
    subjectId,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    ...(input.state.sessionId !== undefined
      ? { sessionId: input.state.sessionId }
      : {}),
    action: "extract",
    constraintCount: sections.openConstraints.length,
    factCount: sections.verifiedFacts.length,
    citationCount: sections.citationRefs.length,
    episodicCount: sections.episodicDetail.length,
  });

  const estimate =
    opts?.estimateTokens ??
    ((text: string) => estimateContextTextTokens(text));
  const tokensBefore = estimateDurableStateTokens(input.state, estimate);

  let includeEpisodic = true;
  let summary = renderCompactionSummaryTemplate(sections, {
    includeEpisodic,
  });
  let tokensAfter = estimate(summary);
  let episodicDropped = false;

  const maxTokens =
    opts?.maxSummaryTokens ?? COMPACTION_SUMMARY_TOKEN_LIMIT_DEFAULT;
  if (
    !Number.isFinite(maxTokens) ||
    maxTokens < 1 ||
    !Number.isInteger(maxTokens)
  ) {
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId,
      detail: "maxSummaryTokens must be a positive integer",
    };
  }

  if (tokensAfter > maxTokens && sections.episodicDetail.length > 0) {
    includeEpisodic = false;
    episodicDropped = true;
    summary = renderCompactionSummaryTemplate(sections, {
      includeEpisodic: false,
    });
    tokensAfter = estimate(summary);
    opts?.onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "ok",
      subjectId,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      action: "second_pass",
      tokensBefore,
      tokensAfter,
      episodicDropped: true,
      constraintCount: sections.openConstraints.length,
      factCount: sections.verifiedFacts.length,
      citationCount: sections.citationRefs.length,
      episodicCount: 0,
    });
  }

  const emptyStub =
    sections.openConstraints.length === 0 &&
    sections.verifiedFacts.length === 0 &&
    sections.citationRefs.length === 0 &&
    (episodicDropped || sections.episodicDetail.length === 0);

  const summaryHash = createHash("sha256")
    .update(summary, "utf8")
    .digest("hex");

  opts?.onTelemetry?.({
    event: "runtime.harness.compaction",
    outcome: "ok",
    subjectId,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    ...(input.state.sessionId !== undefined
      ? { sessionId: input.state.sessionId }
      : {}),
    action: "compile",
    tokensBefore,
    tokensAfter,
    summaryHash,
    constraintCount: sections.openConstraints.length,
    factCount: sections.verifiedFacts.length,
    citationCount: sections.citationRefs.length,
    episodicCount: includeEpisodic ? sections.episodicDetail.length : 0,
    episodicDropped,
    emptyStub,
  });

  return {
    ok: true,
    subjectId,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    ...(input.state.sessionId !== undefined
      ? { sessionId: input.state.sessionId }
      : {}),
    summary,
    summaryHash,
    tokensBefore,
    tokensAfter,
    sections: {
      openConstraints: sections.openConstraints,
      verifiedFacts: sections.verifiedFacts,
      citationRefs: sections.citationRefs,
      episodicDetail: includeEpisodic ? sections.episodicDetail : [],
    },
    emptyStub,
    episodicDropped,
    usedLlm: false,
  };
}

function renderSectionLines(items: readonly string[]): string[] {
  if (items.length === 0) return [COMPACTION_SUMMARY_MARKERS.none];
  return items.map((item) => `- ${item}`);
}

function collectBounded(
  values: readonly string[],
  label: string,
):
  | { ok: true; items: string[] }
  | {
      ok: false;
      failureClass: Exclude<CompactionFailureClass, "deferred_tool_loop">;
      detail: string;
    } {
  if (values.length > CONTEXT_MESSAGE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `${label} input exceeds scan limit ${CONTEXT_MESSAGE_LIMIT}`,
    };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i];
    if (typeof raw !== "string") {
      return {
        ok: false,
        failureClass: "invalid_state",
        detail: `${label}[${i}] must be a string`,
      };
    }
    // Verbatim — do not trim (numeric constraints must survive unchanged).
    const text = raw;
    if (text.length === 0) continue;
    if (text.length > CONTEXT_SECTION_CHAR_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        detail: `${label} item exceeds ${CONTEXT_SECTION_CHAR_LIMIT} characters`,
      };
    }
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length > COMPACTION_SECTION_ITEM_LIMIT) {
      return {
        ok: false,
        failureClass: "section_limit",
        detail: `${label} exceeds item limit ${COMPACTION_SECTION_ITEM_LIMIT}`,
      };
    }
  }
  return { ok: true, items: out };
}

function deriveFromMemories(
  memories: readonly CompactionMemoryItem[] | undefined,
  mode: "match" | "episodic",
  kinds: readonly string[] = [],
): string[] {
  if (!Array.isArray(memories)) return [];
  if (memories.length > CONTEXT_MESSAGE_LIMIT) return [];
  const kindSet = new Set(kinds.map((k) => k.toLowerCase()));
  const protectedKinds = new Set([
    "constraint",
    "refusal",
    "fact",
    "verified",
  ]);
  const out: string[] = [];
  for (const item of memories) {
    if (typeof item?.text !== "string" || item.text.length === 0) continue;
    const kind =
      typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
    if (mode === "episodic") {
      if (kind && protectedKinds.has(kind)) continue;
      if (!kind || kind === "episodic") out.push(item.text);
      continue;
    }
    if (kind && kindSet.has(kind)) out.push(item.text);
  }
  return out;
}

function deriveCitations(
  knowledge: readonly CompactionKnowledgeItem[] | undefined,
): string[] {
  if (!Array.isArray(knowledge)) return [];
  const out: string[] = [];
  for (const item of knowledge) {
    if (typeof item?.citation === "string" && item.citation.length > 0) {
      out.push(item.citation);
      continue;
    }
    if (typeof item?.sourceId === "string" && item.sourceId.length > 0) {
      out.push(item.sourceId);
      continue;
    }
    if (typeof item?.id === "string" && item.id.length > 0) {
      out.push(item.id);
    }
  }
  return out;
}

function estimateDurableStateTokens(
  state: CompactionDurableState,
  estimate: (text: string) => number,
): number {
  let total = 0;
  const addAll = (arr: readonly string[] | undefined): void => {
    if (!arr) return;
    for (const t of arr) {
      if (typeof t === "string") total += estimate(t);
    }
  };
  addAll(state.openConstraints);
  addAll(state.verifiedFacts);
  addAll(state.citationRefs);
  addAll(state.episodicDetail);
  if (Array.isArray(state.memories)) {
    for (const m of state.memories) {
      if (typeof m?.text === "string") total += estimate(m.text);
    }
  }
  if (Array.isArray(state.knowledge)) {
    for (const k of state.knowledge) {
      if (typeof k?.text === "string") total += estimate(k.text);
      if (typeof k?.citation === "string") total += estimate(k.citation);
    }
  }
  return total;
}

function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Wire: when {@link ContextBudgetManager.shouldCompact} is true, compile a
 * structured summary, replace eligible live context with it, emit
 * tokensBefore/After + summaryHash, and re-estimate headroom.
 *
 * Eligible for replace: non-system chat turns, prior compaction summary
 * messages, episodic memories, and retrieval passages. Protected memory kinds
 * (constraint / refusal / fact / verified), other system messages, pending
 * dynamic block, and host protectedTexts are retained.
 */
export function applyCompactionTrigger(input: {
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
}): ApplyCompactionTriggerResult {
  const opts = input.options;
  const onTelemetry = opts?.onTelemetry;
  const stateSubject = trimStr(input.state?.subjectId);
  if (!stateSubject) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: null,
      action: "trigger",
      failureClass: "missing_subject",
    });
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      detail: "state.subjectId required",
    };
  }

  if (!(input.budget instanceof ContextBudgetManager)) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: stateSubject,
      action: "trigger",
      failureClass: "invalid_state",
    });
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId: stateSubject,
      detail: "budget must be a ContextBudgetManager",
    };
  }

  if (input.budget.subjectId !== stateSubject) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      action: "trigger",
      failureClass: "cross_subject",
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      detail: "ContextBudgetManager subjectId does not match state.subjectId",
    };
  }

  if (opts?.toolLoopActive === true) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "deferred",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      ...(input.state.sessionId !== undefined
        ? { sessionId: input.state.sessionId }
        : {}),
      action: "trigger",
      failureClass: "deferred_tool_loop",
    });
    return {
      ok: false,
      deferred: true,
      failureClass: "deferred_tool_loop",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      detail: "compaction deferred until tool loop completes or abort",
    };
  }

  const messagesIn = input.context?.messages ?? [];
  const memoriesIn = input.context?.memories ?? [];
  const retrievalIn = input.context?.retrieval ?? [];
  const pending =
    typeof input.context?.pendingDynamicBlock === "string"
      ? input.context.pendingDynamicBlock
      : "";
  const protectedIn = [...(input.context?.protectedTexts ?? [])];

  if (!Array.isArray(messagesIn) || messagesIn.length > CONTEXT_MESSAGE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      subjectId: stateSubject,
      detail: `messages must be an array of length ≤ ${CONTEXT_MESSAGE_LIMIT}`,
    };
  }

  const measureInput = {
    messages: messagesIn,
    memories: memoriesIn,
    retrieval: retrievalIn,
    pendingDynamicBlock: pending,
    protectedTexts: protectedIn,
  };

  const measured = input.budget.measure(measureInput);
  if (!measured.ok) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      action: "trigger",
      failureClass: "invalid_state",
    });
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      detail: measured.detail,
    };
  }

  const before = measured.snapshot;
  const should = input.budget.shouldCompact();
  if (!should) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "skipped",
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      ...(input.state.sessionId !== undefined
        ? { sessionId: input.state.sessionId }
        : {}),
      action: "skipped",
      compacted: false,
      tokensBefore: before.tokensUsed,
      tokensAfter: before.tokensUsed,
      headroomBefore: before.headroom,
      headroomAfter: before.headroom,
    });
    return {
      ok: true,
      compacted: false,
      subjectId: stateSubject,
      ...(input.state.deviceId !== undefined
        ? { deviceId: input.state.deviceId }
        : {}),
      ...(input.state.sessionId !== undefined
        ? { sessionId: input.state.sessionId }
        : {}),
      tokensBefore: before.tokensUsed,
      tokensAfter: before.tokensUsed,
      headroomBefore: before.headroom,
      headroomAfter: before.headroom,
      snapshot: before,
      context: {
        messages: [...messagesIn],
        memories: [...memoriesIn],
        retrieval: [...retrievalIn],
        pendingDynamicBlock: pending,
        protectedTexts: protectedIn,
      },
      usedLlm: false,
    };
  }

  const compileOptions: CompileStructuredSummaryOptions = {
    ...(opts?.maxSummaryTokens !== undefined
      ? { maxSummaryTokens: opts.maxSummaryTokens }
      : {}),
    ...(opts?.estimateTokens !== undefined
      ? { estimateTokens: opts.estimateTokens }
      : {}),
    ...(onTelemetry !== undefined ? { onTelemetry } : {}),
  };
  const compiled = compileStructuredSummary({
    state: input.state,
    options: compileOptions,
  });
  if (!compiled.ok) {
    if ("deferred" in compiled && compiled.deferred) {
      return compiled;
    }
    return compiled;
  }

  const replaced = replaceEligibleContextWithSummary({
    messages: messagesIn,
    memories: memoriesIn,
    retrieval: retrievalIn,
    pendingDynamicBlock: pending,
    protectedTexts: protectedIn,
    summary: compiled.summary,
  });

  const idemKey =
    typeof opts?.idempotencyKey === "string" && opts.idempotencyKey.trim()
      ? `${stateSubject}\0${opts.idempotencyKey.trim()}`
      : "";
  const priorHash = idemKey ? compactionIdempotency.get(idemKey) : undefined;
  const alreadyApplied =
    priorHash === compiled.summaryHash ||
    contextAlreadyHasSummary(messagesIn, compiled.summary);

  const reMeasured = input.budget.measure({
    messages: replaced.messages,
    memories: replaced.memories,
    retrieval: replaced.retrieval,
    pendingDynamicBlock: replaced.pendingDynamicBlock,
    protectedTexts: replaced.protectedTexts,
  });
  if (!reMeasured.ok) {
    onTelemetry?.({
      event: "runtime.harness.compaction",
      outcome: "rejected",
      subjectId: stateSubject,
      action: "re_estimate",
      failureClass: "invalid_state",
      summaryHash: compiled.summaryHash,
    });
    return {
      ok: false,
      failureClass: "invalid_state",
      subjectId: stateSubject,
      detail: reMeasured.detail,
    };
  }

  const after = reMeasured.snapshot;
  if (idemKey) {
    rememberIdempotency(idemKey, compiled.summaryHash);
  }

  onTelemetry?.({
    event: "runtime.harness.compaction",
    outcome: "ok",
    subjectId: stateSubject,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    ...(input.state.sessionId !== undefined
      ? { sessionId: input.state.sessionId }
      : {}),
    action: "replace",
    compacted: true,
    tokensBefore: before.tokensUsed,
    tokensAfter: after.tokensUsed,
    headroomBefore: before.headroom,
    headroomAfter: after.headroom,
    summaryHash: compiled.summaryHash,
    memoriesDropped: replaced.memoriesDropped,
    retrievalDropped: replaced.retrievalDropped,
    messagesDropped: replaced.messagesDropped,
    ...(alreadyApplied ? { idempotentReplay: true } : {}),
    constraintCount: compiled.sections.openConstraints.length,
    factCount: compiled.sections.verifiedFacts.length,
    citationCount: compiled.sections.citationRefs.length,
    episodicDropped: compiled.episodicDropped,
    emptyStub: compiled.emptyStub,
  });

  onTelemetry?.({
    event: "runtime.harness.compaction",
    outcome: "ok",
    subjectId: stateSubject,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    action: "re_estimate",
    compacted: true,
    tokensBefore: before.tokensUsed,
    tokensAfter: after.tokensUsed,
    headroomBefore: before.headroom,
    headroomAfter: after.headroom,
    summaryHash: compiled.summaryHash,
  });

  return {
    ok: true,
    compacted: true,
    subjectId: stateSubject,
    ...(input.state.deviceId !== undefined
      ? { deviceId: input.state.deviceId }
      : {}),
    ...(input.state.sessionId !== undefined
      ? { sessionId: input.state.sessionId }
      : {}),
    summary: compiled.summary,
    summaryHash: compiled.summaryHash,
    tokensBefore: before.tokensUsed,
    tokensAfter: after.tokensUsed,
    headroomBefore: before.headroom,
    headroomAfter: after.headroom,
    snapshot: after,
    context: {
      messages: replaced.messages,
      memories: replaced.memories,
      retrieval: replaced.retrieval,
      pendingDynamicBlock: replaced.pendingDynamicBlock,
      protectedTexts: replaced.protectedTexts,
    },
    sections: compiled.sections,
    emptyStub: compiled.emptyStub,
    episodicDropped: compiled.episodicDropped,
    memoriesDropped: replaced.memoriesDropped,
    retrievalDropped: replaced.retrievalDropped,
    messagesDropped: replaced.messagesDropped,
    ...(alreadyApplied ? { idempotentReplay: true } : {}),
    usedLlm: false,
  };
}

function contextAlreadyHasSummary(
  messages: readonly ChatMessage[],
  summary: string,
): boolean {
  for (const msg of messages) {
    if (
      msg?.role === "system" &&
      typeof msg.content === "string" &&
      msg.content === summary
    ) {
      return true;
    }
  }
  return false;
}

function rememberIdempotency(key: string, summaryHash: string): void {
  if (compactionIdempotency.size >= COMPACTION_IDEMPOTENCY_CAP) {
    const first = compactionIdempotency.keys().next().value;
    if (typeof first === "string") compactionIdempotency.delete(first);
  }
  compactionIdempotency.set(key, summaryHash);
}

function isCompactionSummaryMessage(content: string): boolean {
  return (
    content.includes(COMPACTION_SUMMARY_MARKERS.open) &&
    content.includes(COMPACTION_SUMMARY_MARKERS.close)
  );
}

function isProtectedMemoryKind(kind: unknown): boolean {
  if (typeof kind !== "string") return false;
  return PROTECTED_MEMORY_KINDS.has(kind.trim().toLowerCase());
}

function replaceEligibleContextWithSummary(input: {
  messages: readonly ChatMessage[];
  memories: readonly ContextMemoryItem[];
  retrieval: readonly ContextRetrievalPassage[];
  pendingDynamicBlock: string;
  protectedTexts: readonly string[];
  summary: string;
}): {
  messages: ChatMessage[];
  memories: ContextMemoryItem[];
  retrieval: ContextRetrievalPassage[];
  pendingDynamicBlock: string;
  protectedTexts: string[];
  memoriesDropped: number;
  retrievalDropped: number;
  messagesDropped: number;
} {
  const keptMessages: ChatMessage[] = [];
  let messagesDropped = 0;
  for (const msg of input.messages) {
    if (!msg || typeof msg.content !== "string") {
      messagesDropped += 1;
      continue;
    }
    if (msg.role === "system") {
      if (isCompactionSummaryMessage(msg.content)) {
        messagesDropped += 1;
        continue;
      }
      keptMessages.push({ role: "system", content: msg.content });
      continue;
    }
    // Eligible history (user / assistant / tool / other) → drop.
    messagesDropped += 1;
  }
  keptMessages.push({ role: "system", content: input.summary });

  const keptMemories: ContextMemoryItem[] = [];
  let memoriesDropped = 0;
  for (const mem of input.memories) {
    if (!mem || typeof mem.text !== "string") {
      memoriesDropped += 1;
      continue;
    }
    if (isProtectedMemoryKind(mem.kind)) {
      keptMemories.push({ ...mem });
      continue;
    }
    memoriesDropped += 1;
  }

  // Retrieval is truncateable / foldable into citation refs — drop all.
  const retrievalDropped = input.retrieval.length;

  return {
    messages: keptMessages,
    memories: keptMemories,
    retrieval: [],
    pendingDynamicBlock: input.pendingDynamicBlock,
    protectedTexts: [...input.protectedTexts],
    memoriesDropped,
    retrievalDropped,
    messagesDropped,
  };
}

/** Message that may use padTokens instead of inlining long filler content. */
export type GoldenCompactionMessage = {
  role: ChatMessage["role"];
  content?: string;
  /** Expand to padChar.repeat(padTokens × chars-per-token) at replay time. */
  padTokens?: number;
  padChar?: string;
};

export type GoldenCompactionRetentionCase = {
  id: string;
  /** Spec / epic signal this golden protects (product language — not a task id). */
  specId: string;
  protects: string;
  kind:
    | "trigger"
    | "second_pass"
    | "empty_stub"
    | "tool_loop_defer"
    | "cross_subject";
  subjectId: string;
  deviceId?: string;
  /** Budget subject override for cross_subject cases. */
  budgetSubjectId?: string;
  modelCard: ContextModelCard;
  state: CompactionDurableState;
  context?: {
    messages?: GoldenCompactionMessage[];
    memories?: ContextMemoryItem[];
    retrieval?: ContextRetrievalPassage[];
    pendingDynamicBlock?: string;
    protectedTexts?: string[];
  };
  options?: {
    toolLoopActive?: boolean;
    maxSummaryTokens?: number;
    idempotencyKey?: string;
  };
  /** Strings that MUST appear verbatim in the post-compaction summary. */
  mustRetainInSummary?: string[];
  /** Strings that MUST NOT appear in the summary (e.g. dropped episodic). */
  mustOmitFromSummary?: string[];
  /** Memory texts that MUST remain in post-compaction context.memories. */
  mustKeepMemoryTexts?: string[];
  expected: {
    compacted?: boolean;
    usedLlm?: false;
    deferred?: boolean;
    failureClass?: CompactionFailureClass | null;
    allMustRetainPresent?: boolean;
    allMustOmitAbsent?: boolean;
    protectedMemoriesKept?: boolean;
    retrievalCleared?: boolean;
    emptyStub?: boolean;
    episodicDropped?: boolean;
    summaryHash?: string;
  };
};

export type GoldenCompactionRetentionCorpus = {
  description: string;
  cases: GoldenCompactionRetentionCase[];
};

export type GoldenCompactionRetentionAccepted = {
  ok: true;
  caseId: string;
  subjectId: string;
  deviceId?: string;
  kind: GoldenCompactionRetentionCase["kind"];
  compacted?: boolean;
  summaryHash?: string;
  canonicalExpectationJson: string;
  expectedCanonicalExpectationJson: string;
  telemetry: CompactionTelemetryEvent[];
};

export type GoldenCompactionRetentionRejected = {
  ok: false;
  failureClass:
    | CompactionFailureClass
    | "expectation_mismatch"
    | "canonical_drift"
    | "invalid_fixture";
  subjectId: string | null;
  deviceId?: string;
  caseId?: string;
  detail: string;
  canonicalExpectationJson?: string;
  expectedCanonicalExpectationJson?: string;
};

export type GoldenCompactionRetentionResult =
  | GoldenCompactionRetentionAccepted
  | GoldenCompactionRetentionRejected;

/**
 * Canonical JSON of the retention expectation surface for golden byte compare.
 */
export function canonicalizeCompactionRetentionExpectationJson(
  surface: Record<string, unknown>,
): string {
  return `${JSON.stringify(sortKeysDeepCompaction(surface), null, 2)}\n`;
}

function sortKeysDeepCompaction(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeepCompaction);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeepCompaction(obj[key]);
    }
    return out;
  }
  return value;
}

function expandGoldenMessages(
  messages: readonly GoldenCompactionMessage[] | undefined,
):
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; detail: string } {
  if (messages === undefined) return { ok: true, messages: [] };
  if (!Array.isArray(messages)) {
    return { ok: false, detail: "context.messages must be an array" };
  }
  if (messages.length > CONTEXT_MESSAGE_LIMIT) {
    return {
      ok: false,
      detail: `context.messages exceed limit ${CONTEXT_MESSAGE_LIMIT}`,
    };
  }
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg.role !== "string") {
      return { ok: false, detail: `messages[${i}] invalid role` };
    }
    if (typeof msg.padTokens === "number") {
      if (!Number.isInteger(msg.padTokens) || msg.padTokens < 0) {
        return {
          ok: false,
          detail: `messages[${i}].padTokens must be a non-negative integer`,
        };
      }
      const ch =
        typeof msg.padChar === "string" && msg.padChar.length === 1
          ? msg.padChar
          : "x";
      out.push({
        role: msg.role,
        content: ch.repeat(msg.padTokens * CONTEXT_CHARS_PER_TOKEN_ESTIMATE),
      });
      continue;
    }
    if (typeof msg.content !== "string") {
      return {
        ok: false,
        detail: `messages[${i}] requires content or padTokens`,
      };
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return { ok: true, messages: out };
}

/**
 * Replay one post-compaction retention golden through
 * {@link applyCompactionTrigger} (or compile-only for second_pass).
 * Locks refusal / citation / numeric-constraint survival after forced compaction.
 */
export function replayCompactionRetentionCase(
  fixtureCase: GoldenCompactionRetentionCase,
): GoldenCompactionRetentionResult {
  const caseId =
    typeof fixtureCase.id === "string" ? fixtureCase.id.trim() : "";
  const subjectId =
    typeof fixtureCase.subjectId === "string"
      ? fixtureCase.subjectId.trim()
      : "";
  if (!caseId) {
    return {
      ok: false,
      failureClass: "invalid_fixture",
      subjectId: subjectId || null,
      detail: "golden compaction retention case requires non-empty id",
    };
  }
  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      subjectId: null,
      caseId,
      detail: "golden compaction retention case requires non-empty subjectId",
    };
  }

  const telemetry: CompactionTelemetryEvent[] = [];
  const onTelemetry = (e: CompactionTelemetryEvent): void => {
    telemetry.push(e);
  };

  const budgetSubject =
    typeof fixtureCase.budgetSubjectId === "string" &&
    fixtureCase.budgetSubjectId.trim()
      ? fixtureCase.budgetSubjectId.trim()
      : subjectId;

  let manager: ContextBudgetManager;
  try {
    manager = new ContextBudgetManager({
      subjectId: budgetSubject,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      modelCard: fixtureCase.modelCard,
    });
  } catch (err) {
    return {
      ok: false,
      failureClass: "invalid_fixture",
      subjectId,
      caseId,
      detail:
        err instanceof Error ? err.message : "failed to construct budget manager",
    };
  }

  const expanded = expandGoldenMessages(fixtureCase.context?.messages);
  if (!expanded.ok) {
    return {
      ok: false,
      failureClass: "invalid_fixture",
      subjectId,
      caseId,
      detail: expanded.detail,
    };
  }

  const state: CompactionDurableState = {
    ...fixtureCase.state,
    subjectId,
    ...(fixtureCase.deviceId !== undefined
      ? { deviceId: fixtureCase.deviceId }
      : {}),
  };

  let actualFull: Record<string, unknown>;

  if (fixtureCase.kind === "second_pass") {
    const compiled = compileStructuredSummary({
      state,
      options: {
        maxSummaryTokens: fixtureCase.options?.maxSummaryTokens ?? 64,
        onTelemetry,
      },
    });
    if (!compiled.ok) {
      return {
        ok: false,
        failureClass:
          "failureClass" in compiled
            ? compiled.failureClass
            : "invalid_state",
        subjectId,
        caseId,
        detail: "detail" in compiled ? compiled.detail : "compile failed",
      };
    }
    actualFull = buildRetentionSurface({
      summary: compiled.summary,
      summaryHash: compiled.summaryHash,
      compacted: true,
      usedLlm: false,
      deferred: false,
      failureClass: null,
      emptyStub: compiled.emptyStub,
      episodicDropped: compiled.episodicDropped,
      memories: [],
      retrieval: [],
      mustRetainInSummary: fixtureCase.mustRetainInSummary ?? [],
      mustOmitFromSummary: fixtureCase.mustOmitFromSummary ?? [],
      mustKeepMemoryTexts: fixtureCase.mustKeepMemoryTexts ?? [],
    });
  } else {
    const triggered = applyCompactionTrigger({
      budget: manager,
      state,
      context: {
        messages: expanded.messages,
        memories: fixtureCase.context?.memories ?? [],
        retrieval: fixtureCase.context?.retrieval ?? [],
        pendingDynamicBlock: fixtureCase.context?.pendingDynamicBlock ?? "",
        protectedTexts: fixtureCase.context?.protectedTexts ?? [],
      },
      options: {
        ...(fixtureCase.options?.toolLoopActive !== undefined
          ? { toolLoopActive: fixtureCase.options.toolLoopActive }
          : {}),
        ...(fixtureCase.options?.maxSummaryTokens !== undefined
          ? { maxSummaryTokens: fixtureCase.options.maxSummaryTokens }
          : {}),
        ...(fixtureCase.options?.idempotencyKey !== undefined
          ? { idempotencyKey: fixtureCase.options.idempotencyKey }
          : {}),
        onTelemetry,
      },
    });

    if (fixtureCase.kind === "tool_loop_defer") {
      actualFull = {
        compacted: false,
        usedLlm: false,
        deferred: triggered.ok === false && "deferred" in triggered && triggered.deferred === true,
        failureClass:
          triggered.ok === false ? triggered.failureClass : null,
      };
    } else if (fixtureCase.kind === "cross_subject") {
      actualFull = {
        compacted: false,
        usedLlm: false,
        deferred: false,
        failureClass:
          triggered.ok === false ? triggered.failureClass : null,
      };
    } else if (!triggered.ok) {
      return {
        ok: false,
        failureClass: triggered.failureClass,
        subjectId: triggered.subjectId,
        ...(triggered.deviceId !== undefined
          ? { deviceId: triggered.deviceId }
          : {}),
        caseId,
        detail: triggered.detail,
      };
    } else {
      actualFull = buildRetentionSurface({
        summary: triggered.summary ?? "",
        summaryHash: triggered.summaryHash ?? "",
        compacted: triggered.compacted,
        usedLlm: false,
        deferred: false,
        failureClass: null,
        emptyStub: triggered.emptyStub ?? false,
        episodicDropped: triggered.episodicDropped ?? false,
        memories: triggered.context.memories,
        retrieval: triggered.context.retrieval,
        mustRetainInSummary: fixtureCase.mustRetainInSummary ?? [],
        mustOmitFromSummary: fixtureCase.mustOmitFromSummary ?? [],
        mustKeepMemoryTexts: fixtureCase.mustKeepMemoryTexts ?? [],
      });
    }
  }

  const expected = { ...fixtureCase.expected } as Record<string, unknown>;
  const actual: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    actual[key] = actualFull[key];
  }

  const canonicalExpectationJson =
    canonicalizeCompactionRetentionExpectationJson(actual);
  const expectedCanonicalExpectationJson =
    canonicalizeCompactionRetentionExpectationJson(expected);

  if (canonicalExpectationJson !== expectedCanonicalExpectationJson) {
    return {
      ok: false,
      failureClass: "canonical_drift",
      subjectId,
      ...(fixtureCase.deviceId !== undefined
        ? { deviceId: fixtureCase.deviceId }
        : {}),
      caseId,
      detail: "compaction retention golden expectation byte drift",
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
    ...(typeof actualFull.compacted === "boolean"
      ? { compacted: actualFull.compacted as boolean }
      : {}),
    ...(typeof actualFull.summaryHash === "string"
      ? { summaryHash: actualFull.summaryHash as string }
      : {}),
    canonicalExpectationJson,
    expectedCanonicalExpectationJson,
    telemetry,
  };
}

function buildRetentionSurface(input: {
  summary: string;
  summaryHash: string;
  compacted: boolean;
  usedLlm: false;
  deferred: boolean;
  failureClass: CompactionFailureClass | null;
  emptyStub: boolean;
  episodicDropped: boolean;
  memories: readonly ContextMemoryItem[];
  retrieval: readonly ContextRetrievalPassage[];
  mustRetainInSummary: readonly string[];
  mustOmitFromSummary: readonly string[];
  mustKeepMemoryTexts: readonly string[];
}): Record<string, unknown> {
  const allMustRetainPresent = input.mustRetainInSummary.every((s) =>
    input.summary.includes(s),
  );
  const allMustOmitAbsent = input.mustOmitFromSummary.every(
    (s) => !input.summary.includes(s),
  );
  const memoryTexts = new Set(
    input.memories.map((m) => m.text).filter((t) => typeof t === "string"),
  );
  const protectedMemoriesKept = input.mustKeepMemoryTexts.every((t) =>
    memoryTexts.has(t),
  );
  return {
    compacted: input.compacted,
    usedLlm: input.usedLlm,
    deferred: input.deferred,
    failureClass: input.failureClass,
    allMustRetainPresent,
    allMustOmitAbsent,
    protectedMemoriesKept,
    retrievalCleared: input.retrieval.length === 0,
    emptyStub: input.emptyStub,
    episodicDropped: input.episodicDropped,
    summaryHash: input.summaryHash,
  };
}
