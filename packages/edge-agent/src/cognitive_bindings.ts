/**
 * @module cognitive_bindings
 *
 * ChatMessage[] → single SlmRuntime prompt string.
 * SlmRuntime ↔ ModelInterface (generate / stream / embed)
 *   with deadlineMs (+ optional AbortSignal) passthrough; stream deltas
 *   (CK-03.2).
 * On-device conformance SlmRuntime + ModelConformanceHarness
 *   factory; CK-03 + locality zero-egress proof in
 *   tests/model_adapter_conformance.test.mjs.
 * LocalVectorDb ↔ MemoryInterface (remember/recall/forget);
 *   kind mapping incl. semantic; CK-02 harness factory.
 * Kind-aware decay + correction pinning (see local_vector_db
 *   kindAwareDecayFactor / pinCorrectionsInWorkingSet); recall ordering tests.
 * CreateEdgeCognitiveBindings factory (memory/model +
 *   edge reasoning/planning/tools/knowledge stubs).
 * ConceptId→topicId remember wrap; coerce legacy SlmRuntime
 *   `descriptor` hosts so EdgeAgent.agentTurn can bind CognitiveCore.
 *
 * Invariants:
 *   - Identical inputs → identical prompt (B5 state-hash caching).
 *   - Empty messages → typed error (never call SlmRuntime).
 *   - Prompt / system budget exceeding contextWindow → typed overflow
 *     (never silent truncation).
 *   - Deadline abort propagates without hanging the turn.
 *   - Stream yields deltas, not cumulative text.
 *   - remember durable before resolve; recall subject-scoped.
 */

import type {
  AgentProfile,
  CognitiveBindings,
} from "@moolam/cognitive-core";
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  KnowledgeConnectorInterface,
  MemoryInterface,
  MemoryItem,
  MemoryKind,
  MemoryQuery,
  ModelDescriptor,
  ModelInterface,
  PlanningInterface,
  ReasoningInterface,
  ScoredMemoryItem,
  SpeechInterface,
  ToolInterface,
  VisionInterface,
} from "@moolam/contracts";
import type { HLCTimestamp } from "@moolam/sync-protocol";
import {
  EPISODIC_HALF_LIFE_DAYS,
  LocalVectorDb,
  createLocalVectorMemoryDriver,
  type VectorMemoryKind,
} from "./local_vector_db.js";
import type {
  SlmGenerateParams,
  SlmModelCard,
  SlmRuntime,
} from "./slm_runtime.js";

/** Empty ChatMessage[] before any local generate. */
export const EDGE_PROMPT_OBLIGATION_EMPTY = "EDGE.PROMPT_EMPTY_MESSAGES";

/** Assembled prompt (or system slice) exceeds SlmModelCard.contextWindow. */
export const EDGE_PROMPT_OBLIGATION_OVERFLOW = "EDGE.PROMPT_CONTEXT_OVERFLOW";

/** Runtime role not in the ChatMessage contract. */
export const EDGE_PROMPT_OBLIGATION_INVALID_ROLE = "EDGE.PROMPT_INVALID_ROLE";

/** subjectId required for sovereignty / isolation. */
export const EDGE_PROMPT_OBLIGATION_SUBJECT = "EDGE.PROMPT_SUBJECT_REQUIRED";

/** Stable section markers — do not localize (determinism). */
export const EDGE_PROMPT_ROLE_MARKERS = Object.freeze({
  system: "### system",
  user: "### user",
  assistant: "### assistant",
  tool: "### tool",
} as const);

/** Trailing cue inviting the next assistant turn (completion-style SLMs). */
export const EDGE_PROMPT_ASSISTANT_CUE = `${EDGE_PROMPT_ROLE_MARKERS.assistant}\n`;

const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Conservative token estimate: ceil(UTF-16 length / 4). Used only for
 * context-window gating — not billed usage.
 */
export function estimatePromptTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export type ChatPromptAssemblyEvent = {
  event: "edge_agent.chat_prompt_assembly";
  subjectId: string;
  deviceId?: string;
  outcome: "ok" | "empty" | "overflow" | "invalid_role" | "subject_required";
  messageCount: number;
  systemCount: number;
  toolCount: number;
  estimatedTokens: number;
  systemEstimatedTokens: number;
  contextWindow: number;
};

export type AssembleChatMessagesOptions = {
  /** From `SlmModelCard.contextWindow` — hard ceiling, no silent trim. */
  contextWindow: number;
  subjectId: string;
  deviceId?: string;
  /**
   * When true (default), append {@link EDGE_PROMPT_ASSISTANT_CUE} unless the
   * last message is already an empty assistant placeholder.
   */
  appendAssistantCue?: boolean;
  emit?: (event: ChatPromptAssemblyEvent) => void;
};

export class ChatPromptAssemblyError extends Error {
  readonly obligationId: string;
  readonly failureClass: "validation" | "contract" | "cap";
  readonly errorCode: string;

  constructor(
    message: string,
    opts: {
      obligationId: string;
      failureClass?: "validation" | "contract" | "cap";
      errorCode?: string;
    },
  ) {
    super(message);
    this.name = "ChatPromptAssemblyError";
    this.obligationId = opts.obligationId;
    this.failureClass = opts.failureClass ?? "validation";
    this.errorCode = opts.errorCode ?? opts.obligationId;
  }
}

function emitAssembly(
  options: AssembleChatMessagesOptions,
  partial: Omit<
    ChatPromptAssemblyEvent,
    "event" | "subjectId" | "deviceId" | "contextWindow"
  >,
): void {
  if (!options.emit) return;
  const event: ChatPromptAssemblyEvent = {
    event: "edge_agent.chat_prompt_assembly",
    subjectId: options.subjectId,
    outcome: partial.outcome,
    messageCount: partial.messageCount,
    systemCount: partial.systemCount,
    toolCount: partial.toolCount,
    estimatedTokens: partial.estimatedTokens,
    systemEstimatedTokens: partial.systemEstimatedTokens,
    contextWindow: options.contextWindow,
  };
  if (options.deviceId !== undefined) {
    event.deviceId = options.deviceId;
  }
  options.emit(event);
}

function formatMessageBlock(message: ChatMessage): string {
  const role = message.role;
  if (!KNOWN_ROLES.has(role)) {
    throw new ChatPromptAssemblyError(
      `unsupported ChatMessage role: ${String(role)}`,
      {
        obligationId: EDGE_PROMPT_OBLIGATION_INVALID_ROLE,
        failureClass: "validation",
        errorCode: "INVALID_ROLE",
      },
    );
  }
  const content =
    typeof message.content === "string" ? message.content : String(message.content ?? "");

  if (role === "tool") {
    const id =
      typeof message.toolCallId === "string" && message.toolCallId.length > 0
        ? message.toolCallId
        : "-";
    return `${EDGE_PROMPT_ROLE_MARKERS.tool} id=${id}\n${content}`;
  }
  return `${EDGE_PROMPT_ROLE_MARKERS[role]}\n${content}`;
}

/**
 * Map ChatMessage[] → one SlmRuntime prompt string.
 *
 * Deterministic for identical inputs. Never truncates on overflow.
 */
export function assembleChatMessagesToPrompt(
  messages: readonly ChatMessage[],
  options: AssembleChatMessagesOptions,
): string {
  const subjectId = options.subjectId?.trim() ?? "";
  if (!subjectId) {
    emitAssembly(options, {
      outcome: "subject_required",
      messageCount: Array.isArray(messages) ? messages.length : 0,
      systemCount: 0,
      toolCount: 0,
      estimatedTokens: 0,
      systemEstimatedTokens: 0,
    });
    throw new ChatPromptAssemblyError(
      "assembleChatMessagesToPrompt requires subjectId (subject isolation)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }

  const contextWindow = options.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new ChatPromptAssemblyError(
      "contextWindow must be a positive number (SlmModelCard.contextWindow)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_OVERFLOW,
        failureClass: "validation",
        errorCode: "CONTEXT_WINDOW_INVALID",
      },
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    emitAssembly(
      { ...options, subjectId },
      {
        outcome: "empty",
        messageCount: 0,
        systemCount: 0,
        toolCount: 0,
        estimatedTokens: 0,
        systemEstimatedTokens: 0,
      },
    );
    throw new ChatPromptAssemblyError(
      "ChatMessage[] is empty — refusing SlmRuntime prompt assembly",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_EMPTY,
        failureClass: "validation",
        errorCode: "EMPTY_MESSAGES",
      },
    );
  }

  let systemCount = 0;
  let toolCount = 0;
  const systemChunks: string[] = [];
  const blocks: string[] = [];

  try {
    for (const message of messages) {
      if (message.role === "system") {
        systemCount += 1;
        systemChunks.push(
          typeof message.content === "string"
            ? message.content
            : String(message.content ?? ""),
        );
      } else if (message.role === "tool") {
        toolCount += 1;
      }
      blocks.push(formatMessageBlock(message));
    }
  } catch (err) {
    if (err instanceof ChatPromptAssemblyError) {
      emitAssembly(
        { ...options, subjectId },
        {
          outcome: "invalid_role",
          messageCount: messages.length,
          systemCount,
          toolCount,
          estimatedTokens: 0,
          systemEstimatedTokens: 0,
        },
      );
    }
    throw err;
  }

  const appendCue = options.appendAssistantCue !== false;
  const last = messages[messages.length - 1]!;
  const alreadyOpenAssistant =
    last.role === "assistant" &&
    (typeof last.content !== "string" || last.content.length === 0);

  let prompt = blocks.join("\n\n");
  if (appendCue && !alreadyOpenAssistant) {
    prompt = `${prompt}\n\n${EDGE_PROMPT_ASSISTANT_CUE}`;
  }

  const systemEstimatedTokens = estimatePromptTokens(systemChunks.join("\n"));
  const estimatedTokens = estimatePromptTokens(prompt);

  if (systemEstimatedTokens > contextWindow || estimatedTokens > contextWindow) {
    emitAssembly(
      { ...options, subjectId },
      {
        outcome: "overflow",
        messageCount: messages.length,
        systemCount,
        toolCount,
        estimatedTokens,
        systemEstimatedTokens,
      },
    );
    throw new ChatPromptAssemblyError(
      systemEstimatedTokens > contextWindow
        ? `system messages estimate ${systemEstimatedTokens} tokens exceeds contextWindow ${contextWindow}`
        : `assembled prompt estimate ${estimatedTokens} tokens exceeds contextWindow ${contextWindow}`,
      {
        obligationId: EDGE_PROMPT_OBLIGATION_OVERFLOW,
        failureClass: "cap",
        errorCode: "CONTEXT_OVERFLOW",
      },
    );
  }

  emitAssembly(
    { ...options, subjectId },
    {
      outcome: "ok",
      messageCount: messages.length,
      systemCount,
      toolCount,
      estimatedTokens,
      systemEstimatedTokens,
    },
  );

  return prompt;
}

/* ── SlmRuntime → ModelInterface ─────────────────────────── * ──

/** Generate/stream aborted by deadlineMs or AbortSignal. */
export const EDGE_MODEL_OBLIGATION_DEADLINE = "EDGE.MODEL_DEADLINE";

/** Embed dimension changed after first measurement (CK-03.1). */
export const EDGE_MODEL_OBLIGATION_EMBED_DIM = "EDGE.MODEL_EMBED_DIM";

/** SlmRuntime card / load state invalid at adapter construction. */
export const EDGE_MODEL_OBLIGATION_INIT = "EDGE.MODEL_INIT";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TEMPERATURE = 0.4;

export type SlmModelAdapterEvent = {
  event: "edge_agent.slm_model_adapter";
  subjectId: string;
  deviceId?: string;
  op: "generate" | "generateStream" | "embed" | "init";
  outcome:
    | "ok"
    | "deadline"
    | "error"
    | "empty"
    | "overflow"
    | "embed_dim"
    | "init_error"
    | "aborted";
  locality: ModelDescriptor["locality"];
  finishReason?: GenerateResult["finishReason"];
  deltaCount?: number;
  embedDim?: number;
};

export type SlmModelAdapterOptions = {
  subjectId: string;
  deviceId?: string;
  /**
   * Declared locality for `ModelDescriptor`. Defaults to `on-device`
   * (sovereign edge). Hosts wrapping a remote OpenAI-compatible endpoint
   * MUST set `self-hosted` or `external-api` truthfully.
   */
  locality?: ModelDescriptor["locality"];
  /** When GenerateOptions.deadlineMs omitted. */
  defaultDeadlineMs?: number;
  /** Cooperative cancel; races with deadlineMs. */
  signal?: AbortSignal;
  emit?: (event: ChatPromptAssemblyEvent | SlmModelAdapterEvent) => void;
};

export class SlmModelAdapterError extends Error {
  readonly obligationId: string;
  readonly failureClass: "validation" | "contract" | "cap" | "downstream" | "config";
  readonly errorCode: string;

  constructor(
    message: string,
    opts: {
      obligationId: string;
      failureClass?: "validation" | "contract" | "cap" | "downstream" | "config";
      errorCode?: string;
    },
  ) {
    super(message);
    this.name = "SlmModelAdapterError";
    this.obligationId = opts.obligationId;
    this.failureClass = opts.failureClass ?? "downstream";
    this.errorCode = opts.errorCode ?? opts.obligationId;
  }
}

function emitAdapter(
  options: SlmModelAdapterOptions,
  locality: ModelDescriptor["locality"],
  partial: Omit<SlmModelAdapterEvent, "event" | "subjectId" | "deviceId" | "locality">,
): void {
  if (!options.emit) return;
  const event: SlmModelAdapterEvent = {
    event: "edge_agent.slm_model_adapter",
    subjectId: options.subjectId,
    op: partial.op,
    outcome: partial.outcome,
    locality,
  };
  if (options.deviceId !== undefined) event.deviceId = options.deviceId;
  if (partial.finishReason !== undefined) event.finishReason = partial.finishReason;
  if (partial.deltaCount !== undefined) event.deltaCount = partial.deltaCount;
  if (partial.embedDim !== undefined) event.embedDim = partial.embedDim;
  options.emit(event);
}

function resolveDeadlineMs(
  options: GenerateOptions | undefined,
  defaults: SlmModelAdapterOptions,
): number {
  const raw = options?.deadlineMs ?? defaults.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new SlmModelAdapterError("deadlineMs must be a positive number", {
      obligationId: EDGE_MODEL_OBLIGATION_DEADLINE,
      failureClass: "validation",
      errorCode: "DEADLINE_INVALID",
    });
  }
  return Math.min(Math.max(1, raw), 600_000);
}

function mapFinishReason(
  reason: "stop" | "length" | "deadline" | "aborted",
): GenerateResult["finishReason"] {
  if (reason === "length") return "length";
  if (reason === "deadline" || reason === "aborted") return "deadline";
  return "stop";
}

/**
 * Convert runtime stream frames into CK-03.2 deltas.
 * Cumulative prefixes → suffix-only; already-delta chunks passthrough.
 */
export async function* toStreamDeltas(
  frames: AsyncIterable<string>,
): AsyncGenerator<string, void, undefined> {
  let produced = "";
  for await (const frame of frames) {
    if (typeof frame !== "string" || frame.length === 0) continue;
    if (produced.length > 0 && frame.startsWith(produced)) {
      const delta = frame.slice(produced.length);
      if (delta.length === 0) continue;
      produced = frame;
      yield delta;
    } else {
      produced += frame;
      yield frame;
    }
  }
}

function buildSlmParams(
  prompt: string,
  options: GenerateOptions | undefined,
  deadlineMs: number,
): SlmGenerateParams {
  const params: SlmGenerateParams = {
    prompt,
    maxTokens:
      typeof options?.maxTokens === "number" && options.maxTokens > 0
        ? Math.min(options.maxTokens, 8_192)
        : DEFAULT_MAX_TOKENS,
    temperature:
      typeof options?.temperature === "number" && Number.isFinite(options.temperature)
        ? options.temperature
        : DEFAULT_TEMPERATURE,
    deadlineMs,
  };
  if (options?.stopSequences && options.stopSequences.length > 0) {
    params.stopSequences = options.stopSequences.slice(0, 16);
  }
  return params;
}

type DeadlineRaceResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "deadline" }
  | { kind: "aborted" };

function raceDeadlineOrAbort<T>(
  work: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<DeadlineRaceResult<T>> {
  if (signal?.aborted) {
    return Promise.resolve({ kind: "aborted" });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: DeadlineRaceResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "deadline" }), deadlineMs);
    const onAbort = () => finish({ kind: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish({ kind: "ok", value }),
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Wrap an SlmRuntime as ModelInterface: assemble ChatMessage[] → prompt,
 * honor deadlineMs / AbortSignal, stream CK-03.2 deltas, stable embed dim.
 */
export function createSlmModelAdapter(
  runtime: SlmRuntime,
  options: SlmModelAdapterOptions,
): ModelInterface {
  const subjectId = options.subjectId?.trim() ?? "";
  if (!subjectId) {
    throw new SlmModelAdapterError(
      "createSlmModelAdapter requires subjectId (subject isolation)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }
  if (!runtime || typeof runtime.generate !== "function") {
    emitAdapter(
      { ...options, subjectId },
      options.locality ?? "on-device",
      { op: "init", outcome: "init_error" },
    );
    throw new SlmModelAdapterError("SlmRuntime is unavailable", {
      obligationId: EDGE_MODEL_OBLIGATION_INIT,
      failureClass: "config",
      errorCode: "RUNTIME_UNAVAILABLE",
    });
  }
  const card = runtime.card;
  if (
    !card ||
    typeof card.modelId !== "string" ||
    card.modelId.trim().length === 0 ||
    !Number.isFinite(card.contextWindow) ||
    card.contextWindow <= 0
  ) {
    emitAdapter(
      { ...options, subjectId },
      options.locality ?? "on-device",
      { op: "init", outcome: "init_error" },
    );
    throw new SlmModelAdapterError(
      "SlmRuntime.card missing modelId or valid contextWindow",
      {
        obligationId: EDGE_MODEL_OBLIGATION_INIT,
        failureClass: "config",
        errorCode: "CARD_INVALID",
      },
    );
  }

  const locality: ModelDescriptor["locality"] = options.locality ?? "on-device";
  const descriptor: ModelDescriptor = {
    modelId: card.modelId,
    contextWindow: card.contextWindow,
    locality,
    modalities: ["text"],
  };

  const scoped: SlmModelAdapterOptions = { ...options, subjectId };
  let embedDim: number | null = null;

  const assemble = (messages: ChatMessage[]): string =>
    assembleChatMessagesToPrompt(messages, {
      contextWindow: card.contextWindow,
      subjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.emit
        ? {
            emit: (e: ChatPromptAssemblyEvent) => {
              options.emit?.(e);
            },
          }
        : {}),
    });

  return {
    get descriptor() {
      return descriptor;
    },

    async generate(messages, genOptions?: GenerateOptions): Promise<GenerateResult> {
      let prompt: string;
      try {
        prompt = assemble(messages);
      } catch (err) {
        if (err instanceof ChatPromptAssemblyError) {
          emitAdapter(scoped, locality, {
            op: "generate",
            outcome:
              err.obligationId === EDGE_PROMPT_OBLIGATION_EMPTY
                ? "empty"
                : err.obligationId === EDGE_PROMPT_OBLIGATION_OVERFLOW
                  ? "overflow"
                  : "error",
          });
        } else {
          emitAdapter(scoped, locality, { op: "generate", outcome: "error" });
        }
        throw err;
      }

      const deadlineMs = resolveDeadlineMs(genOptions, scoped);
      if (scoped.signal?.aborted) {
        emitAdapter(scoped, locality, {
          op: "generate",
          outcome: "aborted",
          finishReason: "deadline",
        });
        return { text: "", finishReason: "deadline" };
      }

      const params = buildSlmParams(prompt, genOptions, deadlineMs);
      try {
        const raced = await raceDeadlineOrAbort(
          runtime.generate(params),
          deadlineMs,
          scoped.signal,
        );
        if (raced.kind === "deadline" || raced.kind === "aborted") {
          emitAdapter(scoped, locality, {
            op: "generate",
            outcome: raced.kind === "aborted" ? "aborted" : "deadline",
            finishReason: "deadline",
          });
          return { text: "", finishReason: "deadline" };
        }
        const finishReason = mapFinishReason(raced.value.finishReason);
        emitAdapter(scoped, locality, {
          op: "generate",
          outcome: finishReason === "deadline" ? "deadline" : "ok",
          finishReason,
        });
        return {
          text: raced.value.text ?? "",
          finishReason,
          usage: {
            inputTokens: estimatePromptTokens(prompt),
            outputTokens: estimatePromptTokens(raced.value.text ?? ""),
          },
        };
      } catch (err) {
        emitAdapter(scoped, locality, { op: "generate", outcome: "error" });
        throw err;
      }
    },

    async *generateStream(
      messages: ChatMessage[],
      genOptions?: GenerateOptions,
    ): AsyncIterable<string> {
      let prompt: string;
      try {
        prompt = assemble(messages);
      } catch (err) {
        if (err instanceof ChatPromptAssemblyError) {
          emitAdapter(scoped, locality, {
            op: "generateStream",
            outcome:
              err.obligationId === EDGE_PROMPT_OBLIGATION_EMPTY
                ? "empty"
                : err.obligationId === EDGE_PROMPT_OBLIGATION_OVERFLOW
                  ? "overflow"
                  : "error",
          });
        } else {
          emitAdapter(scoped, locality, {
            op: "generateStream",
            outcome: "error",
          });
        }
        throw err;
      }

      const deadlineMs = resolveDeadlineMs(genOptions, scoped);
      if (scoped.signal?.aborted) {
        emitAdapter(scoped, locality, {
          op: "generateStream",
          outcome: "aborted",
          finishReason: "deadline",
          deltaCount: 0,
        });
        return;
      }

      const params = buildSlmParams(prompt, genOptions, deadlineMs);
      const started = Date.now();
      let deltaCount = 0;
      try {
        for await (const delta of toStreamDeltas(
          runtime.generateStream(params),
        )) {
          if (scoped.signal?.aborted) {
            emitAdapter(scoped, locality, {
              op: "generateStream",
              outcome: "aborted",
              finishReason: "deadline",
              deltaCount,
            });
            return;
          }
          if (Date.now() - started >= deadlineMs) {
            emitAdapter(scoped, locality, {
              op: "generateStream",
              outcome: "deadline",
              finishReason: "deadline",
              deltaCount,
            });
            return;
          }
          deltaCount += 1;
          yield delta;
        }
        emitAdapter(scoped, locality, {
          op: "generateStream",
          outcome: "ok",
          finishReason: "stop",
          deltaCount,
        });
      } catch (err) {
        emitAdapter(scoped, locality, {
          op: "generateStream",
          outcome: "error",
          deltaCount,
        });
        throw err;
      }
    },

    async embed(text: string): Promise<Float32Array> {
      try {
        const vector = await runtime.embed(text);
        const dim = vector.length;
        if (embedDim === null) {
          embedDim = dim;
        } else if (dim !== embedDim) {
          emitAdapter(scoped, locality, {
            op: "embed",
            outcome: "embed_dim",
            embedDim: dim,
          });
          throw new SlmModelAdapterError(
            `embed dimension ${dim} !== established ${embedDim}`,
            {
              obligationId: EDGE_MODEL_OBLIGATION_EMBED_DIM,
              failureClass: "contract",
              errorCode: "EMBED_DIM_MISMATCH",
            },
          );
        }
        emitAdapter(scoped, locality, {
          op: "embed",
          outcome: "ok",
          embedDim: dim,
        });
        return vector;
      } catch (err) {
        if (err instanceof SlmModelAdapterError) throw err;
        emitAdapter(scoped, locality, { op: "embed", outcome: "error" });
        throw err;
      }
    },
  };
}

/* ── CK-03 harness surface (on-device, zero network) ──────── * ──

/** Stable embed width for on-device conformance runtime (matches CK-03 probes). */
export const EDGE_CONFORMANCE_EMBED_DIM = 8;

/**
 * Deterministic assistant body derived from assembled prompt length — stream
 * delta concatenation MUST equal this string (CK-03.2).
 */
export function conformanceSlmAssistantText(prompt: string): string {
  return `probe.ck03.edge.delta.${prompt.length}`;
}

export type OnDeviceConformanceSlmRuntimeOptions = {
  card?: Partial<SlmModelCard>;
  /**
   * Violation fixture: issues third-party fetch during generate (locality liar).
   * Honest on-device path MUST leave this false.
   */
  egressDuringGenerate?: boolean;
  /** Third-party URL used when {@link egressDuringGenerate} is true. */
  egressUrl?: string;
};

/**
 * Pure on-device SlmRuntime for CK-03 / locality proof — no network unless
 * deliberately configured as a liar fixture.
 */
export function createOnDeviceConformanceSlmRuntime(
  options: OnDeviceConformanceSlmRuntimeOptions = {},
): SlmRuntime {
  const card: SlmModelCard = {
    modelId: "edge-ck03.conformance",
    contextWindow: 4096,
    quantization: "q4-test",
    memoryFootprintMiB: 64,
    languages: ["en"],
    ...options.card,
  };
  const egressUrl =
    options.egressUrl ?? "https://vendor.example/v1/infer";

  return {
    card,
    async load() {},
    async unload() {},
    async generate(params) {
      if (options.egressDuringGenerate) {
        await fetch(egressUrl, { method: "POST", body: "{}" });
      }
      const text = conformanceSlmAssistantText(params.prompt);
      return {
        text,
        tokensPerSecond: 120,
        finishReason: "stop",
      };
    },
    async *generateStream(params) {
      if (options.egressDuringGenerate) {
        await fetch(egressUrl, { method: "POST", body: "{}" });
      }
      const text = conformanceSlmAssistantText(params.prompt);
      const mid = Math.max(1, Math.floor(text.length / 2));
      yield text.slice(0, mid);
      yield text.slice(mid);
    },
    async embed(text: string) {
      const out = new Float32Array(EDGE_CONFORMANCE_EMBED_DIM);
      let h = 0;
      for (let i = 0; i < Math.min(text.length, 64); i++) {
        h = (h * 31 + text.charCodeAt(i)) >>> 0;
      }
      for (let i = 0; i < EDGE_CONFORMANCE_EMBED_DIM; i++) {
        out[i] = ((h + i * 17) % 1000) / 1000;
      }
      return out;
    },
  };
}

/** CK-03 ModelConformanceHarness shape (network deny seam). */
export type SlmModelAdapterHarness = {
  model: ModelInterface;
  isNetworkAllowed(): boolean;
  setNetworkAllowed(allowed: boolean): void;
};

export type CreateSlmModelAdapterHarnessOptions = {
  deviceId?: string;
  subjectId?: string;
  locality?: ModelDescriptor["locality"];
  createRuntime?: () => SlmRuntime;
  emit?: SlmModelAdapterOptions["emit"];
};

/**
 * Factory for `runConformance({ registry: createModelObligationsRegistry() })`.
 * Honors runner FactoryContext.subjectId when provided.
 */
export function createSlmModelAdapterHarnessFactory(
  options: CreateSlmModelAdapterHarnessOptions = {},
): (ctx?: { subjectId?: string }) => SlmModelAdapterHarness {
  return (ctx) => {
    const subjectId = (ctx?.subjectId ?? options.subjectId ?? "").trim();
    if (!subjectId) {
      throw new SlmModelAdapterError(
        "createSlmModelAdapterHarnessFactory requires subjectId",
        {
          obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
          failureClass: "validation",
          errorCode: "SUBJECT_REQUIRED",
        },
      );
    }
    let networkAllowed = true;
    const runtime =
      options.createRuntime?.() ?? createOnDeviceConformanceSlmRuntime();
    const model = createSlmModelAdapter(runtime, {
      subjectId,
      ...(options.deviceId !== undefined
        ? { deviceId: options.deviceId }
        : {}),
      locality: options.locality ?? "on-device",
      ...(options.emit ? { emit: options.emit } : {}),
    });
    return {
      model,
      isNetworkAllowed: () => networkAllowed,
      setNetworkAllowed: (allowed: boolean) => {
        networkAllowed = allowed;
      },
    };
  };
}

/* ── LocalVectorDb → MemoryInterface ─────────────────────── * ──

/** Empty / missing subjectId on memory ops. */
export const EDGE_MEMORY_OBLIGATION_SUBJECT = "EDGE.MEMORY_SUBJECT_REQUIRED";

/** Embedding dimension mismatch (store vs query / write). */
export const EDGE_MEMORY_OBLIGATION_EMBED_DIM = "EDGE.MEMORY_EMBED_DIM";

/** Bounded recall result set (NFR). */
export const EDGE_MEMORY_RECALL_LIMIT = 64;

/** Bounded scan overshoot when kind-filtering post-search. */
export const EDGE_MEMORY_SCAN_LIMIT = 256;

const MEMORY_KINDS = new Set<MemoryKind>([
  "correction",
  "milestone",
  "preference",
  "episodic",
  "semantic",
]);

export type LocalVectorMemoryEvent = {
  event: "edge_agent.local_vector_memory";
  subjectId: string;
  deviceId?: string;
  op: "remember" | "recall" | "forget" | "associate" | "compact" | "init";
  outcome: "ok" | "error" | "empty" | "embed_dim" | "subject_required";
  itemCount?: number;
  kind?: MemoryKind;
  /** How many correction hits were returned (pin signal). */
  correctionCount?: number;
  /** How many episodic hits were returned after decay. */
  episodicCount?: number;
};

export type LocalVectorMemoryAdapterOptions = {
  deviceId?: string;
  embed: (text: string) => Promise<Float32Array>;
  /** Injected clock for LocalVectorDb episodic decay (CK-02.2). */
  nowMs?: () => number;
  episodicHalfLifeDays?: number;
  emit?: (event: LocalVectorMemoryEvent) => void;
};

export class LocalVectorMemoryError extends Error {
  readonly obligationId: string;
  readonly failureClass: "validation" | "contract" | "config" | "downstream";
  readonly errorCode: string;

  constructor(
    message: string,
    opts: {
      obligationId: string;
      failureClass?: "validation" | "contract" | "config" | "downstream";
      errorCode?: string;
    },
  ) {
    super(message);
    this.name = "LocalVectorMemoryError";
    this.obligationId = opts.obligationId;
    this.failureClass = opts.failureClass ?? "validation";
    this.errorCode = opts.errorCode ?? opts.obligationId;
  }
}

function emitMemory(
  options: LocalVectorMemoryAdapterOptions,
  partial: Omit<LocalVectorMemoryEvent, "event" | "deviceId">,
): void {
  if (!options.emit) return;
  const event: LocalVectorMemoryEvent = {
    event: "edge_agent.local_vector_memory",
    subjectId: partial.subjectId,
    op: partial.op,
    outcome: partial.outcome,
  };
  if (options.deviceId !== undefined) event.deviceId = options.deviceId;
  if (partial.itemCount !== undefined) event.itemCount = partial.itemCount;
  if (partial.kind !== undefined) event.kind = partial.kind;
  if (partial.correctionCount !== undefined) {
    event.correctionCount = partial.correctionCount;
  }
  if (partial.episodicCount !== undefined) {
    event.episodicCount = partial.episodicCount;
  }
  options.emit(event);
}

function toVectorKind(kind: MemoryKind): VectorMemoryKind {
  if (!MEMORY_KINDS.has(kind)) {
    throw new LocalVectorMemoryError(`unsupported MemoryKind: ${String(kind)}`, {
      obligationId: "EDGE.MEMORY_INVALID_KIND",
      failureClass: "validation",
      errorCode: "INVALID_KIND",
    });
  }
  return kind;
}

function toMemoryItem(record: {
  id: string;
  subjectId: string;
  conceptId: string;
  text: string;
  kind: VectorMemoryKind;
  createdAt: string;
}): MemoryItem {
  return {
    id: record.id,
    subjectId: record.subjectId,
    topicId: record.conceptId,
    text: record.text,
    kind: record.kind,
    createdAt: record.createdAt,
  };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

async function withSubjectMemoryLock<T>(
  locks: Map<string, Promise<unknown>>,
  subjectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(subjectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  locks.set(subjectId, next);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(subjectId) === next) locks.delete(subjectId);
  }
}

/**
 * Adapt LocalVectorDb to MemoryInterface.
 * topicId ↔ conceptId; MemoryKind ↔ VectorMemoryKind (incl. semantic).
 * remember embeds via injected embed() and awaits durable upsert before resolve.
 */
export function createLocalVectorMemoryAdapter(
  db: LocalVectorDb,
  options: LocalVectorMemoryAdapterOptions,
): MemoryInterface {
  if (typeof options.embed !== "function") {
    throw new LocalVectorMemoryError("createLocalVectorMemoryAdapter requires embed()", {
      obligationId: "EDGE.MEMORY_EMBED_REQUIRED",
      failureClass: "config",
      errorCode: "EMBED_REQUIRED",
    });
  }

  const subjectLocks = new Map<string, Promise<unknown>>();

  return {
    async remember(item: Omit<MemoryItem, "id">): Promise<MemoryItem> {
      const subjectId = item.subjectId?.trim() ?? "";
      if (!subjectId) {
        emitMemory(options, {
          subjectId: "",
          op: "remember",
          outcome: "subject_required",
        });
        throw new LocalVectorMemoryError(
          "MemoryItem.subjectId is required (subject isolation)",
          {
            obligationId: EDGE_MEMORY_OBLIGATION_SUBJECT,
            failureClass: "validation",
            errorCode: "SUBJECT_REQUIRED",
          },
        );
      }
      const topicId = item.topicId?.trim() ?? "";
      if (!topicId) {
        throw new LocalVectorMemoryError("MemoryItem.topicId is required", {
          obligationId: "EDGE.MEMORY_TOPIC_REQUIRED",
          failureClass: "validation",
          errorCode: "TOPIC_REQUIRED",
        });
      }

      return withSubjectMemoryLock(subjectLocks, subjectId, async () => {
        try {
          const kind = toVectorKind(item.kind);
          const vector = await options.embed(item.text);
          const id = `mem-${crypto.randomUUID()}`;
          const createdAt = (item.createdAt?.trim() ||
            new Date().toISOString()) as HLCTimestamp;
          // Durable upsert BEFORE resolve (CK-02.1).
          await db.upsert({
            id,
            subjectId,
            conceptId: topicId,
            text: item.text,
            vector,
            kind,
            createdAt,
          });
          const stored: MemoryItem = {
            id,
            subjectId,
            topicId,
            text: item.text,
            kind: item.kind,
            createdAt,
            ...(item.relatedIds !== undefined
              ? { relatedIds: item.relatedIds }
              : {}),
            ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
          };
          emitMemory(options, {
            subjectId,
            op: "remember",
            outcome: "ok",
            itemCount: 1,
            kind: item.kind,
          });
          return stored;
        } catch (err) {
          if (err instanceof LocalVectorMemoryError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (/dimension/i.test(message)) {
            emitMemory(options, {
              subjectId,
              op: "remember",
              outcome: "embed_dim",
            });
            throw new LocalVectorMemoryError(message, {
              obligationId: EDGE_MEMORY_OBLIGATION_EMBED_DIM,
              failureClass: "contract",
              errorCode: "EMBED_DIM_MISMATCH",
            });
          }
          emitMemory(options, {
            subjectId,
            op: "remember",
            outcome: "error",
          });
          throw err;
        }
      });
    },

    async recall(query: MemoryQuery): Promise<ScoredMemoryItem[]> {
      const subjectId = query.subjectId?.trim() ?? "";
      if (!subjectId) {
        emitMemory(options, {
          subjectId: "",
          op: "recall",
          outcome: "subject_required",
        });
        throw new LocalVectorMemoryError(
          "MemoryQuery.subjectId is required (subject isolation)",
          {
            obligationId: EDGE_MEMORY_OBLIGATION_SUBJECT,
            failureClass: "validation",
            errorCode: "SUBJECT_REQUIRED",
          },
        );
      }

      const limit = Math.min(
        Math.max(1, query.limit ?? 16),
        EDGE_MEMORY_RECALL_LIMIT,
      );
      try {
        const vector = await options.embed(query.query);
        const fetchLimit =
          query.kinds !== undefined
            ? Math.min(EDGE_MEMORY_SCAN_LIMIT, Math.max(limit * 4, limit))
            : limit;
        const hits = await db.search(subjectId, vector, {
          ...(query.topicId !== undefined
            ? { conceptId: query.topicId }
            : {}),
          limit: fetchLimit,
        });

        let mapped: ScoredMemoryItem[] = hits.map((h) => ({
          item: toMemoryItem(h.record),
          score: clampScore(h.score),
        }));

        if (query.kinds !== undefined) {
          const allowed = new Set(query.kinds);
          mapped = mapped.filter((h) => allowed.has(h.item.kind));
        }

        const out = mapped.slice(0, limit);
        emitMemory(options, {
          subjectId,
          op: "recall",
          outcome: out.length === 0 ? "empty" : "ok",
          itemCount: out.length,
          correctionCount: out.filter((h) => h.item.kind === "correction")
            .length,
          episodicCount: out.filter((h) => h.item.kind === "episodic").length,
        });
        return out;
      } catch (err) {
        if (err instanceof LocalVectorMemoryError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (/dimension/i.test(message)) {
          emitMemory(options, {
            subjectId,
            op: "recall",
            outcome: "embed_dim",
          });
          throw new LocalVectorMemoryError(message, {
            obligationId: EDGE_MEMORY_OBLIGATION_EMBED_DIM,
            failureClass: "contract",
            errorCode: "EMBED_DIM_MISMATCH",
          });
        }
        emitMemory(options, {
          subjectId,
          op: "recall",
          outcome: "error",
        });
        throw err;
      }
    },

    async associate(_fromId: string, _toId: string, _relation: string): Promise<void> {
      // Pure vector store — graph edges are a no-op (MemoryInterface contract).
      emitMemory(options, {
        subjectId: "*",
        op: "associate",
        outcome: "ok",
        itemCount: 0,
      });
    },

    async forget(id: string): Promise<void> {
      const key = id?.trim() ?? "";
      if (!key) {
        throw new LocalVectorMemoryError("forget requires id", {
          obligationId: "EDGE.MEMORY_ID_REQUIRED",
          failureClass: "validation",
          errorCode: "ID_REQUIRED",
        });
      }
      await db.deleteById(key);
      emitMemory(options, {
        subjectId: "*",
        op: "forget",
        outcome: "ok",
        itemCount: 1,
      });
    },

    async compact(subjectId: string, olderThanDays: number): Promise<number> {
      const sid = subjectId?.trim() ?? "";
      if (!sid) {
        throw new LocalVectorMemoryError(
          "compact requires subjectId (subject isolation)",
          {
            obligationId: EDGE_MEMORY_OBLIGATION_SUBJECT,
            failureClass: "validation",
            errorCode: "SUBJECT_REQUIRED",
          },
        );
      }
      const days = Number.isFinite(olderThanDays)
        ? Math.max(0, olderThanDays)
        : 0;
      const cutoffMs = (options.nowMs?.() ?? Date.now()) - days * 86_400_000;
      const cutoff =
        `${String(Math.floor(cutoffMs)).padStart(15, "0")}:000000:compact` as HLCTimestamp;
      const n = await db.pruneEpisodicOlderThan(cutoff, sid);
      emitMemory(options, {
        subjectId: sid,
        op: "compact",
        outcome: "ok",
        itemCount: n,
      });
      return n;
    },
  };
}

/** CK-02 MemoryConformanceHarness shape. */
export type LocalVectorMemoryHarness = {
  memory: MemoryInterface;
  reinstantiate(): Promise<MemoryInterface>;
  nowMs(): number;
  setNowMs(ms: number): void;
};

export type CreateLocalVectorMemoryHarnessOptions = {
  deviceId?: string;
  embedDim?: number;
  episodicHalfLifeDays?: number;
  emit?: LocalVectorMemoryAdapterOptions["emit"];
};

/**
 * Shared durable substrate + injectable clock for CK-02 probes.
 * reinstantiate opens a fresh MemoryInterface over the same driver rows.
 */
export function createLocalVectorMemoryHarnessFactory(
  options: CreateLocalVectorMemoryHarnessOptions = {},
): () => LocalVectorMemoryHarness {
  const embedDim = options.embedDim ?? EDGE_CONFORMANCE_EMBED_DIM;
  const halfLifeDays = options.episodicHalfLifeDays ?? EPISODIC_HALF_LIFE_DAYS;

  return () => {
    let now = 1_700_000_000_000;
    const driver = createLocalVectorMemoryDriver();
    const embed = async (text: string): Promise<Float32Array> => {
      const out = new Float32Array(embedDim);
      let h = 0;
      for (let i = 0; i < Math.min(text.length, 96); i++) {
        h = (h * 31 + text.charCodeAt(i)) >>> 0;
      }
      for (let i = 0; i < embedDim; i++) {
        out[i] = ((h + i * 17) % 1000) / 1000;
      }
      // Make probe.decay.* tokens cluster for relevance fairness.
      if (text.includes("probe.decay")) {
        out[0] = 0.91;
        out[1] = 0.87;
      }
      return out;
    };

    const openDb = (): LocalVectorDb =>
      new LocalVectorDb(driver, {
        episodicHalfLifeDays: halfLifeDays,
        nowMs: () => now,
      });

    const openMemory = (db: LocalVectorDb): MemoryInterface =>
      createLocalVectorMemoryAdapter(db, {
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
        embed,
        nowMs: () => now,
        episodicHalfLifeDays: halfLifeDays,
        ...(options.emit ? { emit: options.emit } : {}),
      });

    const bootstrap = openDb();
    // In-memory driver treats CREATE as no-op; still honor the initialize seam.
    const initPromise = bootstrap.initialize();

    return {
      memory: openMemory(bootstrap),
      async reinstantiate() {
        await initPromise;
        const db = openDb();
        await db.initialize();
        return openMemory(db);
      },
      nowMs: () => now,
      setNowMs: (ms: number) => {
        now = ms;
      },
    };
  };
}

/* ── CognitiveBindings factory for EdgeAgent ───────────── * ──

/** subjectId / deviceId missing when assembling edge bindings. */
export const EDGE_BINDINGS_OBLIGATION_SUBJECT = "EDGE.BINDINGS_SUBJECT_REQUIRED";

export type EdgeCognitiveBindingsEvent = {
  event: "edge_agent.cognitive_bindings";
  subjectId: string;
  deviceId?: string;
  outcome: "ok" | "error" | "subject_required";
  domainId: string;
  hasActiveConcept: boolean;
  /** True when a SpeechInterface was injected into the binding set. */
  hasSpeech?: boolean;
  /** True when a VisionInterface was injected into the binding set. */
  hasVision?: boolean;
  servedLocally: true;
};

/**
 * Map edge conceptId (task-graph / mastery key) → MemoryInterface.topicId.
 * Empty / null → stable on-device default (never invent foreign ids).
 */
export function mapConceptIdToTopicId(
  conceptId: string | null | undefined,
): string {
  const trimmed = conceptId?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "edge.general";
}

/**
 * Map CognitiveState.profile.track (task-graph vocabulary) → AgentProfile.domainId.
 */
export function mapTrackToDomainId(track: string | null | undefined): string {
  const trimmed = track?.trim() ?? "";
  return trimmed.length > 0 ? `edge.${trimmed}` : "edge.offline";
}

type LegacySlmDescriptor = {
  modelId?: string;
  contextWindow?: number;
  quantization?: string;
  memoryFootprintMiB?: number;
  languages?: string[];
};

/**
 * Coerce host/test runtimes that still expose `descriptor` (pre-card) into a
 * full {@link SlmRuntime} for {@link createSlmModelAdapter}. Never invents
 * network paths — only fills card / stream / unload gaps locally.
 */
export function coerceSlmRuntimeForBindings(runtime: SlmRuntime): SlmRuntime {
  const r = runtime as SlmRuntime & { descriptor?: LegacySlmDescriptor };
  const src = r.card ?? r.descriptor;
  const card: SlmModelCard = {
    modelId: src?.modelId?.trim() || "edge-slm",
    contextWindow:
      typeof src?.contextWindow === "number" && src.contextWindow > 0
        ? src.contextWindow
        : 4096,
    quantization: src?.quantization?.trim() || "unknown",
    memoryFootprintMiB:
      typeof src?.memoryFootprintMiB === "number" &&
      Number.isFinite(src.memoryFootprintMiB)
        ? src.memoryFootprintMiB
        : 0,
    languages:
      Array.isArray(src?.languages) && src.languages.length > 0
        ? [...src.languages]
        : ["en"],
  };

  const generateStream: SlmRuntime["generateStream"] =
    typeof r.generateStream === "function"
      ? r.generateStream.bind(r)
      : async function* (params: SlmGenerateParams) {
          const result = await r.generate(params);
          if (result.text) yield result.text;
        };

  const unload: SlmRuntime["unload"] =
    typeof r.unload === "function" ? r.unload.bind(r) : async () => {};

  return {
    card,
    load: r.load.bind(r),
    unload,
    generate: r.generate.bind(r),
    generateStream,
    embed: r.embed.bind(r),
  };
}

/**
 * Prefer edge concept topicId on remember so CognitiveCore reflect episodes
 * land under the active concept (Core passes domainId by default).
 */
function wrapMemoryWithConceptTopic(
  memory: MemoryInterface,
  topicId: string,
): MemoryInterface {
  return {
    remember(item: Omit<MemoryItem, "id">): Promise<MemoryItem> {
      const effective =
        topicId !== "edge.general" ? topicId : item.topicId;
      return memory.remember({ ...item, topicId: effective });
    },
    recall: (query: MemoryQuery) => memory.recall(query),
    associate: (fromId, toId, relation) =>
      memory.associate(fromId, toId, relation),
    forget: (id) => memory.forget(id),
    compact: (subjectId, olderThanDays) =>
      memory.compact(subjectId, olderThanDays),
  };
}

export function createEdgeAgentProfile(input: {
  track: string;
  language: string;
  charter?: string;
  refusals?: string[];
}): AgentProfile {
  const language = input.language.trim() || "en";
  const domainId = mapTrackToDomainId(input.track);
  return {
    domainId,
    charter:
      input.charter?.trim() ||
      `You are an autonomous on-device cognitive agent for domain ${domainId}. Prefer local evidence; never claim external network access.`,
    refusals: input.refusals ?? [],
    languages: [language],
  };
}

function createEdgeReasoningStub(): ReasoningInterface {
  return {
    async deliberate(request) {
      const constraints = (request.constraints ?? []).slice(0, 32);
      const evidenceCount = Math.min(request.evidence.length, 16);
      return {
        conclusion:
          evidenceCount > 0
            ? `On-device conclusion grounded in ${evidenceCount} evidence item(s).`
            : "On-device conclusion with no retrieved evidence.",
        confidence: evidenceCount > 0 ? 0.72 : 0.55,
        steps: [
          {
            kind: "inference",
            statement: "Edge reasoning stub synthesized a local conclusion.",
            evidenceRefs:
              evidenceCount > 0
                ? Array.from({ length: Math.min(evidenceCount, 4) }, (_, i) => i)
                : [],
          },
        ],
        unresolvedConstraints: constraints,
      };
    },
  };
}

function createEdgePlanningStub(): PlanningInterface {
  return {
    async compose(goals, _context) {
      const steps = goals.slice(0, 8).map((g, i) => ({
        stepId: `edge-step-${i + 1}`,
        goalId: g.goalId,
        action: g.description.slice(0, 120),
        dependsOn: g.prerequisites.slice(0, 8),
        status: "pending" as const,
      }));
      return {
        planId: `edge-plan-${crypto.randomUUID().slice(0, 8)}`,
        steps,
        rationale: "edge-default-compose",
      };
    },
    async revise(plan, event) {
      return {
        ...plan,
        rationale: `edge-revise:${event.severity}:${event.observation.slice(0, 64)}`,
      };
    },
    nextStep(plan) {
      return plan.steps.find((s) => s.status === "pending") ?? null;
    },
  };
}

function createEdgeToolsStub(): ToolInterface {
  return {
    list: () => [],
    async invoke(invocation) {
      return {
        invocationId: invocation.invocationId,
        status: "error",
        output: { message: "no edge tools bound" },
        latencyMs: 0,
      };
    },
  };
}

function createEdgeKnowledgeStub(): KnowledgeConnectorInterface {
  return {
    sources: [
      {
        sourceId: "edge.bundled",
        title: "On-device bundled index",
        domain: "edge",
        locality: "bundled-offline",
        coverage: { from: "1970-01-01", to: "9999-12-31" },
      },
    ],
    async retrieve() {
      // Offline-first: empty passages beat fabricated remote hits.
      return [];
    },
  };
}

export type CreateEdgeCognitiveBindingsOptions = {
  subjectId: string;
  deviceId: string;
  runtime: SlmRuntime;
  /** Initialized LocalVectorDb (shared with EdgeAgent.vectorDb). */
  vectorDb: LocalVectorDb;
  /** CognitiveState.profile.track → domainId. */
  track: string;
  language: string;
  /** Active concept from router / friction → default topicId mapping. */
  activeConceptId?: string | null;
  locality?: ModelDescriptor["locality"];
  charter?: string;
  refusals?: string[];
  reasoning?: ReasoningInterface;
  planning?: PlanningInterface;
  tools?: ToolInterface;
  knowledge?: KnowledgeConnectorInterface;
  /**
   * Optional local STT/TTS (`SpeechInterface`). Injected into the edge
   * CognitiveBindings set; text-only agents omit this.
   */
  speech?: SpeechInterface;
  /**
   * Optional local VLM (`VisionInterface`). Injected into the edge
   * CognitiveBindings set; text-only agents omit this.
   */
  vision?: VisionInterface;
  /**
   * Default generate/stream deadline for the on-device model adapter (ms).
   */
  defaultDeadlineMs?: number;
  emit?: (
    event:
      | EdgeCognitiveBindingsEvent
      | ChatPromptAssemblyEvent
      | SlmModelAdapterEvent
      | LocalVectorMemoryEvent,
  ) => void;
};

export type EdgeCognitiveBindingsBundle = {
  bindings: CognitiveBindings;
  profile: AgentProfile;
  /** topicId derived from activeConceptId for remember/reflect paths. */
  topicId: string;
};

/**
 * Assemble CognitiveBindings from edge config + Slm/LocalVector adapters.
 * Does not call CognitiveCore.turn — wires the loop.
 */
export function createEdgeCognitiveBindings(
  options: CreateEdgeCognitiveBindingsOptions,
): EdgeCognitiveBindingsBundle {
  const subjectId = options.subjectId?.trim() ?? "";
  const deviceId = options.deviceId?.trim() ?? "";
  if (!subjectId || !deviceId) {
    options.emit?.({
      event: "edge_agent.cognitive_bindings",
      subjectId: subjectId || "",
      ...(deviceId ? { deviceId } : {}),
      outcome: "subject_required",
      domainId: mapTrackToDomainId(options.track),
      hasActiveConcept: false,
      servedLocally: true,
    });
    throw new SlmModelAdapterError(
      "createEdgeCognitiveBindings requires subjectId and deviceId",
      {
        obligationId: EDGE_BINDINGS_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }
  if (!options.runtime || typeof options.runtime.generate !== "function") {
    throw new SlmModelAdapterError("SlmRuntime is required for edge bindings", {
      obligationId: EDGE_MODEL_OBLIGATION_INIT,
      failureClass: "config",
      errorCode: "RUNTIME_REQUIRED",
    });
  }
  if (!options.vectorDb) {
    throw new LocalVectorMemoryError(
      "LocalVectorDb is required for edge bindings",
      {
        obligationId: "EDGE.BINDINGS_MEMORY_REQUIRED",
        failureClass: "config",
        errorCode: "MEMORY_REQUIRED",
      },
    );
  }

  const profile = createEdgeAgentProfile({
    track: options.track,
    language: options.language,
    ...(options.charter !== undefined ? { charter: options.charter } : {}),
    ...(options.refusals !== undefined ? { refusals: options.refusals } : {}),
  });
  const topicId = mapConceptIdToTopicId(options.activeConceptId);
  const runtime = coerceSlmRuntimeForBindings(options.runtime);

  const model = createSlmModelAdapter(runtime, {
    subjectId,
    deviceId,
    locality: options.locality ?? "on-device",
    ...(options.defaultDeadlineMs !== undefined
      ? { defaultDeadlineMs: options.defaultDeadlineMs }
      : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  });

  const baseMemory = createLocalVectorMemoryAdapter(options.vectorDb, {
    deviceId,
    embed: (text) => runtime.embed(text),
    ...(options.emit ? { emit: options.emit } : {}),
  });
  const memory = wrapMemoryWithConceptTopic(baseMemory, topicId);

  const bindings: CognitiveBindings = {
    memory,
    model,
    reasoning: options.reasoning ?? createEdgeReasoningStub(),
    planning: options.planning ?? createEdgePlanningStub(),
    tools: options.tools ?? createEdgeToolsStub(),
    knowledge: options.knowledge ?? createEdgeKnowledgeStub(),
    ...(options.speech ? { speech: options.speech } : {}),
    ...(options.vision ? { vision: options.vision } : {}),
  };

  options.emit?.({
    event: "edge_agent.cognitive_bindings",
    subjectId,
    deviceId,
    outcome: "ok",
    domainId: profile.domainId,
    hasActiveConcept: topicId !== "edge.general",
    hasSpeech: Boolean(options.speech),
    hasVision: Boolean(options.vision),
    servedLocally: true,
  });

  return { bindings, profile, topicId };
}
