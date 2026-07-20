/**
 * FFI / native addon seam for llama.cpp.
 *
 * Production hosts inject a real native backend; CI uses
 * {@link createInProcessLlamaCppBackend} so the SlmRuntime contract stays
 * tested without linking libllama on every runner.
 *
 * Deadline semantics: pass an AbortSignal (AbortController-equivalent).
 * Backends MUST stop work when aborted and report deadlineHit / end the stream.
 * Streaming MUST yield CK-03.2 deltas (suffixes), never cumulative prefixes.
 */

import type { GgufMetadata } from "./gguf_metadata.js";

export type LlamaCppNativeHandle = { readonly id: string };

export type LlamaCppGenerateNativeParams = {
  prompt: string;
  maxTokens: number;
  temperature: number;
  deadlineMs: number;
  stopSequences?: string[];
  /**
   * Native AbortController-equivalent. When aborted, generate returns
   * deadlineHit and generateStream stops yielding further deltas.
   */
  signal?: AbortSignal;
  /** Wall clock; injectable for tests. */
  nowMs?: () => number;
};

export type LlamaCppGenerateNativeResult = {
  text: string;
  tokensEmitted: number;
  /** True when the backend aborted due to deadline / AbortSignal. */
  deadlineHit: boolean;
};

export interface LlamaCppNativeBackend {
  readonly kind: "in-process" | "native-addon" | "ffi" | "ollama";
  load(
    weightsPath: string,
    meta: GgufMetadata,
  ): Promise<{ handle: LlamaCppNativeHandle; embedDim: number }>;
  unload(handle: LlamaCppNativeHandle): Promise<void>;
  generate(
    handle: LlamaCppNativeHandle,
    params: LlamaCppGenerateNativeParams,
  ): Promise<LlamaCppGenerateNativeResult>;
  /**
   * Yields CK-03.2 deltas (each chunk is new text only).
   * Stops cleanly when `params.signal` aborts or deadlineMs elapses.
   */
  generateStream(
    handle: LlamaCppNativeHandle,
    params: LlamaCppGenerateNativeParams,
  ): AsyncIterable<string>;
  embed(handle: LlamaCppNativeHandle, text: string): Promise<Float32Array>;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function deadlineBreached(
  started: number,
  deadlineMs: number,
  now: () => number,
): boolean {
  return deadlineMs <= 0 || now() - started > deadlineMs;
}

/**
 * Deterministic in-process stand-in for llama.cpp.
 * Zero network — locality proof floor for CI.
 */
export function createInProcessLlamaCppBackend(
  opts: { defaultEmbedDim?: number; streamChunkChars?: number } = {},
): LlamaCppNativeBackend {
  const defaultEmbedDim = opts.defaultEmbedDim ?? 8;
  const streamChunkChars = opts.streamChunkChars ?? 2;
  const loaded = new Map<
    string,
    { meta: GgufMetadata; embedDim: number; weightsPath: string }
  >();
  let seq = 0;

  function buildText(params: LlamaCppGenerateNativeParams): string {
    const max = Math.max(1, Math.min(params.maxTokens, 64));
    return `ll:${params.prompt.length}:${max}`;
  }

  return {
    kind: "in-process",

    async load(weightsPath, meta) {
      const id = `llama-h-${++seq}`;
      const embedDim = defaultEmbedDim;
      loaded.set(id, { meta, embedDim, weightsPath });
      return { handle: { id }, embedDim };
    },

    async unload(handle) {
      loaded.delete(handle.id);
    },

    async generate(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("native generate on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();

      if (isAborted(params.signal)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }

      // Simulate token cost; honor AbortSignal mid-wait (native abort seam).
      const workMs = Math.min(params.deadlineMs + 50, 5 + params.prompt.length);
      if (params.signal) {
        const aborted = await new Promise<boolean>((resolve) => {
          if (params.signal!.aborted) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => resolve(false), workMs);
          params.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true },
          );
        });
        if (aborted || deadlineBreached(started, params.deadlineMs, now)) {
          return { text: "", tokensEmitted: 0, deadlineHit: true };
        }
      } else if (
        deadlineBreached(started, params.deadlineMs, now) ||
        now() - started + workMs > params.deadlineMs
      ) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }

      const text = buildText(params);
      const tokensEmitted = Math.max(1, Math.min(params.maxTokens, 64) - 1);
      return { text, tokensEmitted, deadlineHit: false };
    },

    async *generateStream(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("native generateStream on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
        return;
      }

      const full = buildText(params);
      const step = Math.max(1, streamChunkChars);
      for (let i = 0; i < full.length; i += step) {
        if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
          return;
        }
        // True delta — suffix only, never cumulative restate of prior text.
        yield full.slice(i, i + step);
      }
    },

    async embed(handle, text) {
      const entry = loaded.get(handle.id);
      if (!entry) throw new Error("native embed on unloaded handle");
      const dim = entry.embedDim;
      const out = new Float32Array(dim);
      let h = 0;
      for (let i = 0; i < text.length; i += 1) {
        h = (h * 31 + text.charCodeAt(i)) >>> 0;
      }
      for (let i = 0; i < dim; i += 1) {
        out[i] = ((h >> (i % 24)) & 0xff) / 255;
      }
      return out;
    },
  };
}
