/**
 * @module slm_runtime
 *
 * Pluggable local inference boundary of the Edge Harness.
 *
 * The harness never links against a specific inference engine. Instead it
 * speaks `SlmRuntime`, and adapters bind that interface to whatever the
 * host device offers:
 *   - llama.cpp / GGUF   (Phi-3-mini, Gemma-2 2B, Qwen-2.5 1.5B, …)
 *   - ONNX Runtime Mobile (quantized INT4/INT8 exports)
 *   - MediaPipe LLM Inference API (Android AICore)
 *   - Apple Foundation Models / MLX (iOS)
 *   - any localhost OpenAI-compatible server (Ollama, llamafile)
 *
 * This is what makes the Edge Harness sovereign: a district deployment can
 * swap models and engines without touching a line of domain code.
 */

/** Declarative description of the local model an adapter has loaded. */
export interface SlmModelCard {
  /** e.g. "phi-3-mini-4k-instruct-q4_K_M" */
  modelId: string;
  /** Context window in tokens the adapter will actually honor. */
  contextWindow: number;
  /** Quantization descriptor, e.g. "Q4_K_M", "int4-awq", "fp16". */
  quantization: string;
  /** Rough on-device footprint in MiB, used by the harness's load planner. */
  memoryFootprintMiB: number;
  /** Languages the model operates competently in (BCP-47). */
  languages: string[];
}

export interface SlmGenerateParams {
  /** Fully-assembled prompt (the harness owns prompt construction). */
  prompt: string;
  maxTokens: number;
  temperature: number;
  /** Hard wall-clock budget; adapters MUST abort and flush on breach. */
  deadlineMs: number;
  stopSequences?: string[];
}

export interface SlmGenerateResult {
  text: string;
  /** Tokens emitted per second — fed into CAST as a device-health signal. */
  tokensPerSecond: number;
  finishReason: "stop" | "length" | "deadline" | "aborted";
}

/**
 * The single interface every local inference adapter implements.
 * Adapters must be side-effect free until `load()` is invoked so the
 * harness can enumerate candidates cheaply on constrained devices.
 */
export interface SlmRuntime {
  readonly card: SlmModelCard;
  /** Materialize weights into memory. Idempotent. */
  load(): Promise<void>;
  /** Release weights. The harness calls this under memory pressure. */
  unload(): Promise<void>;
  /** Single-shot generation within a strict deadline. */
  generate(params: SlmGenerateParams): Promise<SlmGenerateResult>;
  /** Streaming variant for word-by-word reply rendering. */
  generateStream(params: SlmGenerateParams): AsyncIterable<string>;
  /** Embed text for the local vector store. Dimension must be stable. */
  embed(text: string): Promise<Float32Array>;
}

/**
 * Adapter for any localhost OpenAI-compatible endpoint (Ollama, llamafile,
 * llama.cpp server). This is the reference adapter used by the Playground and
 * by desktop deployments; mobile targets ship their own native adapters.
 */
export class OpenAiCompatibleSlmRuntime implements SlmRuntime {
  constructor(
    public readonly card: SlmModelCard,
    private readonly baseUrl: string = "http://127.0.0.1:11434/v1",
  ) {}

  async load(): Promise<void> {
    // Warm the model by issuing a 1-token generation; Ollama-style servers
    // load weights lazily on first request.
    await this.generate({ prompt: " ", maxTokens: 1, temperature: 0, deadlineMs: 120_000 });
  }

  async unload(): Promise<void> {
    // OpenAI-compatible servers manage their own eviction; nothing to do.
  }

  async generate(params: SlmGenerateParams): Promise<SlmGenerateResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.deadlineMs);
    const startedAt = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.card.modelId,
          prompt: params.prompt,
          max_tokens: params.maxTokens,
          temperature: params.temperature,
          stop: params.stopSequences,
        }),
      });
      if (!res.ok) {
        throw new Error(`local SLM server returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        choices: { text: string; finish_reason: string }[];
        usage?: { completion_tokens?: number };
      };
      const choice = body.choices[0];
      if (!choice) throw new Error("local SLM server returned no choices");
      const elapsedS = (performance.now() - startedAt) / 1000;
      const tokens = body.usage?.completion_tokens ?? Math.ceil(choice.text.length / 4);
      return {
        text: choice.text,
        tokensPerSecond: elapsedS > 0 ? tokens / elapsedS : 0,
        finishReason: choice.finish_reason === "length" ? "length" : "stop",
      };
    } catch (err) {
      if (controller.signal.aborted) {
        return { text: "", tokensPerSecond: 0, finishReason: "deadline" };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async *generateStream(params: SlmGenerateParams): AsyncIterable<string> {
    // Reference implementation degrades to buffered generation; native
    // adapters override with true SSE/token streaming.
    const result = await this.generate(params);
    yield result.text;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.card.modelId, input: text }),
    });
    if (!res.ok) throw new Error(`embedding request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { data: { embedding: number[] }[] };
    const vector = body.data[0]?.embedding;
    if (!vector) throw new Error("embedding response contained no vector");
    return Float32Array.from(vector);
  }
}
