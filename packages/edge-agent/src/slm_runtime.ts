/**
 * @module slm_runtime
 *
 * Pluggable local inference boundary of the Edge Harness.
 *
 * The harness never links against a specific inference engine. Instead it
 * speaks `SlmRuntime`, and adapters bind that interface to whatever the
 * host device offers:
 *   - llama.cpp / GGUF   (`sutra-bindings-slm` LlamaCppSlmRuntime;
 *     ModelInterface via createLlamaCppModelAdapter / createSlmModelAdapter)
 *   - ONNX Runtime Mobile (quantized INT4/INT8 exports)
 *   - MediaPipe LLM Inference API (Android AICore)
 *   - Apple Foundation Models / MLX (iOS)
 *   - any localhost OpenAI-compatible server (Ollama, llamafile)
 *
 * CognitiveCore consumes ModelInterface. Pass a loaded LlamaCppSlmRuntime
 * into edge cognitive bindings, or call createLlamaCppModelAdapter and
 * inject the resulting model into the binding set.
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
 *
 * Streaming MUST yield CK-03.2 deltas (new text only), never cumulative
 * restatements of prior frames. Implementations SHOULD race an
 * AbortController-equivalent against `deadlineMs` at the native/FFI layer
 * so generation cannot hang the harness thread.
 */
export interface SlmRuntime {
  readonly card: SlmModelCard;
  /** Materialize weights into memory. Idempotent. */
  load(): Promise<void>;
  /** Release weights. The harness calls this under memory pressure. */
  unload(): Promise<void>;
  /** Single-shot generation within a strict deadline. */
  generate(params: SlmGenerateParams): Promise<SlmGenerateResult>;
  /** Streaming variant for word-by-word reply rendering (delta frames). */
  generateStream(params: SlmGenerateParams): AsyncIterable<string>;
  /** Embed text for the local vector store. Dimension must be stable. */
  embed(text: string): Promise<Float32Array>;
}

/** Init/load obligation named on typed failures (never silent catch-and-continue). */
export const EDGE_SLM_LOAD_OBLIGATION = "EDGE.SLM_LOAD";

/** Closed set of SlmRuntime load failure classes. */
export type SlmRuntimeInitFailureClass =
  | "missing_weights"
  | "corrupt_weights"
  | "config";

/**
 * Typed initialization/load failure for local model weights.
 * Hosts MUST surface this to the operator — never retry unboundedly.
 */
export class SlmRuntimeInitError extends Error {
  override readonly name = "SlmRuntimeInitError";
  readonly failureClass: SlmRuntimeInitFailureClass;
  readonly obligationId: string;
  readonly reason: "missing" | "corrupt" | "config";

  constructor(
    message: string,
    opts: {
      failureClass: SlmRuntimeInitFailureClass;
      reason: "missing" | "corrupt" | "config";
      obligationId?: string;
    },
  ) {
    super(message);
    this.failureClass = opts.failureClass;
    this.reason = opts.reason;
    this.obligationId = opts.obligationId ?? EDGE_SLM_LOAD_OBLIGATION;
  }
}

/** Metadata-only telemetry for SLM load/unload (never utterance/prompt bodies). */
export type SlmRuntimeTelemetryEvent = {
  event: "edge_agent.slm_runtime";
  op: "load" | "unload";
  outcome: "ok" | "init_error";
  modelId: string;
  subjectId?: string;
  deviceId?: string;
  failureClass?: SlmRuntimeInitFailureClass;
  obligationId?: string;
  reason?: "missing" | "corrupt" | "config";
};

/** Magic prefix for drill / on-disk weight fixtures (not a full GGUF parser). */
export const SLM_WEIGHTS_MAGIC = "SUTRA-WEIGHTS-v1";

export type LocalWeightSlmRuntimeOptions = {
  /** Absolute or relative path to on-disk model weights. */
  weightsPath: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: SlmRuntimeTelemetryEvent) => void;
  /**
   * Optional custom integrity check after magic-header validation.
   * Return false → corrupt_weights.
   */
  inspectWeights?: (bytes: Uint8Array) => boolean;
};

/**
 * File-backed SlmRuntime load seam used for edge degradation drills and
 * host deployments that materialize weights from disk before inference.
 *
 * Missing or corrupt weights → {@link SlmRuntimeInitError} once per `load()`
 * (no internal retry loop). Generation requires a prior successful load.
 */
export class LocalWeightSlmRuntime implements SlmRuntime {
  private loaded = false;
  private loadAttempts = 0;

  constructor(
    public readonly card: SlmModelCard,
    private readonly options: LocalWeightSlmRuntimeOptions,
  ) {
    if (!options.weightsPath || !String(options.weightsPath).trim()) {
      throw new SlmRuntimeInitError("LocalWeightSlmRuntime requires weightsPath", {
        failureClass: "config",
        reason: "config",
      });
    }
  }

  /** How many times `load()` has been invoked (crash-loop detection). */
  get loadAttemptCount(): number {
    return this.loadAttempts;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    this.loadAttempts += 1;
    if (this.loaded) {
      this.emit({ op: "load", outcome: "ok" });
      return;
    }

    const fs = await import("node:fs/promises");
    const path = this.options.weightsPath;

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path));
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw this.failLoad("missing", `model weights missing at path`);
      }
      throw this.failLoad(
        "corrupt",
        `model weights unreadable (${code || "io_error"})`,
      );
    }

    if (bytes.byteLength === 0) {
      throw this.failLoad("corrupt", "model weights file is empty");
    }

    const header = new TextDecoder().decode(
      bytes.subarray(0, Math.min(bytes.byteLength, SLM_WEIGHTS_MAGIC.length)),
    );
    if (header !== SLM_WEIGHTS_MAGIC) {
      throw this.failLoad("corrupt", "model weights magic header mismatch");
    }

    if (this.options.inspectWeights && !this.options.inspectWeights(bytes)) {
      throw this.failLoad("corrupt", "model weights failed integrity inspect");
    }

    this.loaded = true;
    this.emit({ op: "load", outcome: "ok" });
  }

  async unload(): Promise<void> {
    this.loaded = false;
    this.emit({ op: "unload", outcome: "ok" });
  }

  async generate(_params: SlmGenerateParams): Promise<SlmGenerateResult> {
    if (!this.loaded) {
      throw new SlmRuntimeInitError("SlmRuntime.generate before successful load", {
        failureClass: "config",
        reason: "config",
      });
    }
    // Reference: weights-validated stub; native adapters replace with real inference.
    return { text: "", tokensPerSecond: 0, finishReason: "stop" };
  }

  async *generateStream(params: SlmGenerateParams): AsyncIterable<string> {
    const result = await this.generate(params);
    if (result.text) yield result.text;
  }

  async embed(_text: string): Promise<Float32Array> {
    if (!this.loaded) {
      throw new SlmRuntimeInitError("SlmRuntime.embed before successful load", {
        failureClass: "config",
        reason: "config",
      });
    }
    return new Float32Array(8);
  }

  private failLoad(
    reason: "missing" | "corrupt",
    message: string,
  ): SlmRuntimeInitError {
    const failureClass =
      reason === "missing" ? "missing_weights" : "corrupt_weights";
    const error = new SlmRuntimeInitError(message, {
      failureClass,
      reason,
    });
    this.emit({
      op: "load",
      outcome: "init_error",
      failureClass,
      obligationId: EDGE_SLM_LOAD_OBLIGATION,
      reason,
    });
    return error;
  }

  private emit(
    partial: Pick<SlmRuntimeTelemetryEvent, "op" | "outcome"> &
      Partial<
        Pick<
          SlmRuntimeTelemetryEvent,
          "failureClass" | "obligationId" | "reason"
        >
      >,
  ): void {
    const event: SlmRuntimeTelemetryEvent = {
      event: "edge_agent.slm_runtime",
      modelId: this.card.modelId,
      ...partial,
    };
    const sid = this.options.subjectId?.trim();
    const did = this.options.deviceId?.trim();
    if (sid) event.subjectId = sid;
    if (did) event.deviceId = did;
    this.options.onTelemetry?.(event);
  }
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
