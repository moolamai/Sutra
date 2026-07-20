/**
 * Ollama HTTP backend for {@link LlamaCppNativeBackend}.
 *
 * Inference runs against a local Ollama daemon (loopback). GGUF on disk is still
 * parsed for truthful model-card metadata; generation and embeddings use Ollama.
 * CI keeps the in-process stand-in; opt in via examples/offline-edge:live.
 */

import type { GgufMetadata } from "./gguf_metadata.js";
import type {
  LlamaCppGenerateNativeParams,
  LlamaCppGenerateNativeResult,
  LlamaCppNativeBackend,
  LlamaCppNativeHandle,
} from "./native_ffi.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
/** Sub-1B default aligned with mid-range mobile ONNX targets (~0.5B class). */
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:0.5b";
/** Fallback when Ollama is started without `--embeddings` (generation still works). */
export const OLLAMA_DEFAULT_EMBED_DIM = 8;

export type OllamaReachability = {
  ok: true;
  baseUrl: string;
  model: string;
  modelsListed: number;
};

export type OllamaReachabilityError = {
  ok: false;
  baseUrl: string;
  model: string;
  reason: "unreachable" | "model_missing";
  detail: string;
};

export type OllamaLlamaCppBackendOptions = {
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type OllamaConfigFromEnv = {
  baseUrl: string;
  model: string;
};

export function resolveOllamaConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OllamaConfigFromEnv {
  const baseUrl = (
    env.SUTRA_OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL
  ).trim();
  const model = (env.SUTRA_OLLAMA_MODEL ?? OLLAMA_DEFAULT_MODEL).trim();
  if (!model) {
    throw new Error("SUTRA_OLLAMA_MODEL must be a non-empty Ollama model tag");
  }
  return { baseUrl, model };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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

type OllamaTagsResponse = {
  models?: Array<{ name?: string; model?: string }>;
};

type OllamaGenerateResponse = {
  response?: string;
  done?: boolean;
};

type OllamaEmbedResponse = {
  embedding?: number[];
};

function modelListed(tags: OllamaTagsResponse, model: string): boolean {
  const want = model.trim();
  for (const entry of tags.models ?? []) {
    const name = entry.name ?? entry.model ?? "";
    if (name === want || name.startsWith(`${want}:`)) return true;
    if (want.includes(":") && name.split(":")[0] === want.split(":")[0]) {
      return true;
    }
  }
  return false;
}

/**
 * Verify the Ollama daemon is up and lists the requested model.
 */
export async function probeOllamaReachable(
  options: OllamaConfigFromEnv & { fetchImpl?: typeof fetch },
): Promise<OllamaReachability | OllamaReachabilityError> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    return {
      ok: false,
      baseUrl,
      model: options.model,
      reason: "unreachable",
      detail:
        err instanceof Error
          ? err.message
          : "Ollama daemon not reachable on loopback",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      baseUrl,
      model: options.model,
      reason: "unreachable",
      detail: `GET /api/tags returned ${response.status}`,
    };
  }
  const tags = (await response.json()) as OllamaTagsResponse;
  const modelsListed = tags.models?.length ?? 0;
  if (!modelListed(tags, options.model)) {
    return {
      ok: false,
      baseUrl,
      model: options.model,
      reason: "model_missing",
      detail: `model '${options.model}' not in /api/tags (${modelsListed} listed). Run: ollama pull ${options.model}`,
    };
  }
  return { ok: true, baseUrl, model: options.model, modelsListed };
}

/**
 * Local Ollama binding — loopback HTTP only; production may swap for native FFI.
 */
export function createOllamaLlamaCppBackend(
  options: OllamaLlamaCppBackendOptions,
): LlamaCppNativeBackend {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  const model = options.model.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const loaded = new Map<
    string,
    {
      meta: GgufMetadata;
      embedDim: number;
      weightsPath: string;
      embeddingsApiSupported: boolean;
    }
  >();
  let seq = 0;

  function syntheticEmbed(text: string, dim: number): Float32Array {
    const out = new Float32Array(dim);
    let h = 0;
    for (let i = 0; i < text.length; i += 1) {
      h = (h * 31 + text.charCodeAt(i)) >>> 0;
    }
    for (let i = 0; i < dim; i += 1) {
      out[i] = ((h >> (i % 24)) & 0xff) / 255;
    }
    return out;
  }

  function embeddingsApiUnavailable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes("does not support embeddings") ||
      /\/api\/embeddings failed \((404|500)\)/.test(msg)
    );
  }

  async function postJson<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal !== undefined) {
      init.signal = signal;
    }
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Ollama ${path} failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  async function probeEmbedDim(
    signal?: AbortSignal,
  ): Promise<{ dim: number; apiSupported: boolean }> {
    try {
      const result = await postJson<OllamaEmbedResponse>(
        "/api/embeddings",
        { model, prompt: "dim-probe" },
        signal,
      );
      const dim = result.embedding?.length ?? 0;
      if (!Number.isFinite(dim) || dim <= 0) {
        throw new Error("Ollama embeddings returned empty vector");
      }
      return { dim, apiSupported: true };
    } catch (err) {
      if (embeddingsApiUnavailable(err)) {
        return { dim: OLLAMA_DEFAULT_EMBED_DIM, apiSupported: false };
      }
      throw err;
    }
  }

  return {
    kind: "ollama",

    async load(weightsPath, meta) {
      const id = `ollama-h-${++seq}`;
      const probe = await probeEmbedDim();
      loaded.set(id, {
        meta,
        embedDim: probe.dim,
        weightsPath,
        embeddingsApiSupported: probe.apiSupported,
      });
      return { handle: { id }, embedDim: probe.dim };
    },

    async unload(handle) {
      loaded.delete(handle.id);
    },

    async generate(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("Ollama generate on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      params.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await postJson<OllamaGenerateResponse>(
          "/api/generate",
          {
            model,
            prompt: params.prompt,
            stream: false,
            options: {
              temperature: params.temperature,
              num_predict: Math.max(1, Math.min(params.maxTokens, 512)),
              stop: params.stopSequences,
            },
          },
          controller.signal,
        );
        if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
          return { text: "", tokensEmitted: 0, deadlineHit: true };
        }
        const text = typeof result.response === "string" ? result.response : "";
        return {
          text,
          tokensEmitted: Math.max(1, text.length > 0 ? 1 : 0),
          deadlineHit: false,
        };
      } catch (err) {
        if (
          isAborted(params.signal) ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return { text: "", tokensEmitted: 0, deadlineHit: true };
        }
        throw err;
      } finally {
        params.signal?.removeEventListener("abort", onAbort);
      }
    },

    async *generateStream(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("Ollama generateStream on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
        return;
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      params.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetchImpl(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: params.prompt,
            stream: true,
            options: {
              temperature: params.temperature,
              num_predict: Math.max(1, Math.min(params.maxTokens, 512)),
              stop: params.stopSequences,
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Ollama stream failed (${response.status})`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          if (isAborted(params.signal) || deadlineBreached(started, params.deadlineMs, now)) {
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              const parsed = JSON.parse(line) as OllamaGenerateResponse;
              if (typeof parsed.response === "string" && parsed.response.length > 0) {
                yield parsed.response;
              }
            }
            newline = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        if (
          !isAborted(params.signal) &&
          !(err instanceof Error && err.name === "AbortError")
        ) {
          throw err;
        }
      } finally {
        params.signal?.removeEventListener("abort", onAbort);
      }
    },

    async embed(handle, text) {
      const entry = loaded.get(handle.id);
      if (!entry) throw new Error("Ollama embed on unloaded handle");
      if (!entry.embeddingsApiSupported) {
        return syntheticEmbed(text, entry.embedDim);
      }
      const result = await postJson<OllamaEmbedResponse>("/api/embeddings", {
        model,
        prompt: text,
      });
      const vector = result.embedding ?? [];
      if (vector.length === 0) {
        throw new Error("Ollama embeddings returned empty vector");
      }
      if (vector.length !== entry.embedDim) {
        throw new Error(
          `Ollama embed dimension drift: expected ${entry.embedDim}, got ${vector.length}`,
        );
      }
      return Float32Array.from(vector);
    },
  };
}
