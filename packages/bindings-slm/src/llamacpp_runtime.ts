/**
 * LlamaCppSlmRuntime — SlmRuntime over an injectable llama.cpp FFI seam.
 *
 * Model card fields are populated from parsed GGUF metadata (truthful weights),
 * not aspirational host config. Missing/corrupt GGUF → typed init error.
 *
 * Deadline: AbortController races wall-clock deadlineMs and is passed into the
 * native seam so generate/stream abort without hanging the harness thread.
 * Streaming: yields CK-03.2 deltas (defense-in-depth via toStreamDeltas).
 */

import { readFile } from "node:fs/promises";
import {
  EDGE_SLM_LOAD_OBLIGATION,
  toStreamDeltas,
  type SlmGenerateParams,
  type SlmGenerateResult,
  type SlmModelCard,
  type SlmRuntime,
  type SlmRuntimeInitFailureClass,
  SlmRuntimeInitError,
} from "@moolam/edge-agent";
import {
  LLAMA_CPP_PINNED_REVISION,
  parseGgufMetadata,
  type GgufMetadata,
} from "./gguf_metadata.js";
import {
  createInProcessLlamaCppBackend,
  type LlamaCppNativeBackend,
  type LlamaCppNativeHandle,
} from "./native_ffi.js";

export type LlamaCppSlmRuntimeOptions = {
  /** Absolute or relative path to a GGUF weights file. */
  weightsPath: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: LlamaCppTelemetryEvent) => void;
  /**
   * Native / FFI backend. Defaults to the in-process CI stand-in.
   * Production injects the real llama.cpp addon.
   */
  backend?: LlamaCppNativeBackend;
  /** Override wall clock (tests). */
  nowMs?: () => number;
};

export type LlamaCppTelemetryOp =
  | "load"
  | "unload"
  | "generate"
  | "generateStream"
  | "embed";

/** Metadata-only telemetry (never prompt / utterance bodies). */
export type LlamaCppTelemetryEvent = {
  event: "bindings_slm.llamacpp";
  op: LlamaCppTelemetryOp;
  outcome: "ok" | "init_error" | "deadline";
  modelId: string;
  subjectId?: string;
  deviceId?: string;
  backendKind: LlamaCppNativeBackend["kind"];
  pinnedRevision: string;
  failureClass?: SlmRuntimeInitFailureClass;
  obligationId?: string;
  reason?: "missing" | "corrupt" | "config";
  /** Stream deltas successfully flushed before deadline abort (if any). */
  deltaCount?: number;
};

const PLACEHOLDER_CARD: SlmModelCard = {
  modelId: "unloaded",
  contextWindow: 1,
  quantization: "unknown",
  memoryFootprintMiB: 1,
  languages: ["en"],
};

export class LlamaCppSlmRuntime implements SlmRuntime {
  private loaded = false;
  private loadAttempts = 0;
  private handle: LlamaCppNativeHandle | null = null;
  private embedDim: number | null = null;
  private cardState: SlmModelCard = { ...PLACEHOLDER_CARD };
  private readonly backend: LlamaCppNativeBackend;
  private readonly nowMs: () => number;
  /** Active generation abort — cancelled on unload / deadline breach. */
  private activeAbort: AbortController | null = null;

  constructor(private readonly options: LlamaCppSlmRuntimeOptions) {
    if (!options.weightsPath || !String(options.weightsPath).trim()) {
      throw new SlmRuntimeInitError("LlamaCppSlmRuntime requires weightsPath", {
        failureClass: "config",
        reason: "config",
      });
    }
    this.backend = options.backend ?? createInProcessLlamaCppBackend();
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get card(): SlmModelCard {
    return this.cardState;
  }

  get loadAttemptCount(): number {
    return this.loadAttempts;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get embeddingDimension(): number | null {
    return this.embedDim;
  }

  get pinnedRevision(): string {
    return LLAMA_CPP_PINNED_REVISION;
  }

  async load(): Promise<void> {
    this.loadAttempts += 1;
    if (this.loaded) {
      this.emit({ op: "load", outcome: "ok" });
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.options.weightsPath));
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw this.failLoad("missing", "GGUF weights missing at path");
      }
      throw this.failLoad(
        "corrupt",
        `GGUF weights unreadable (${code || "io_error"})`,
      );
    }

    if (bytes.byteLength === 0) {
      throw this.failLoad("corrupt", "GGUF weights file is empty");
    }

    let meta: GgufMetadata;
    try {
      meta = parseGgufMetadata(bytes, { weightsPath: this.options.weightsPath });
    } catch (err) {
      throw this.failLoad(
        "corrupt",
        `GGUF metadata parse failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    let loaded: { handle: LlamaCppNativeHandle; embedDim: number };
    try {
      loaded = await this.backend.load(this.options.weightsPath, meta);
    } catch (err) {
      throw this.failLoad(
        "corrupt",
        `native load failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    if (
      !Number.isFinite(loaded.embedDim) ||
      loaded.embedDim <= 0 ||
      !Number.isInteger(loaded.embedDim)
    ) {
      await this.backend.unload(loaded.handle).catch(() => undefined);
      throw this.failLoad("config", "native embed dimension invalid");
    }

    this.handle = loaded.handle;
    this.embedDim = loaded.embedDim;
    this.cardState = {
      modelId: meta.modelId,
      contextWindow: meta.contextWindow,
      quantization: meta.quantization,
      memoryFootprintMiB: meta.memoryFootprintMiB,
      languages: [...meta.languages],
    };
    this.loaded = true;
    this.emit({ op: "load", outcome: "ok" });
  }

  async unload(): Promise<void> {
    // Abort any in-flight native generation before releasing the handle.
    this.activeAbort?.abort();
    this.activeAbort = null;
    if (this.handle) {
      await this.backend.unload(this.handle);
    }
    this.handle = null;
    this.embedDim = null;
    this.cardState = { ...PLACEHOLDER_CARD };
    this.loaded = false;
    this.emit({ op: "unload", outcome: "ok" });
  }

  async generate(params: SlmGenerateParams): Promise<SlmGenerateResult> {
    this.requireLoaded("generate");
    this.assertDeadline(params.deadlineMs);

    const started = this.nowMs();
    const { controller, clear } = this.beginNativeAbort(params.deadlineMs);
    try {
      const native = await this.backend.generate(this.handle!, {
        prompt: params.prompt,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        deadlineMs: params.deadlineMs,
        signal: controller.signal,
        ...(params.stopSequences !== undefined
          ? { stopSequences: params.stopSequences }
          : {}),
        nowMs: this.nowMs,
      });

      const elapsed = Math.max(0, this.nowMs() - started);
      if (
        native.deadlineHit ||
        controller.signal.aborted ||
        elapsed > params.deadlineMs
      ) {
        // Partial output discarded on hard deadline (adapter policy).
        this.emit({ op: "generate", outcome: "deadline" });
        return { text: "", tokensPerSecond: 0, finishReason: "deadline" };
      }

      const finishReason: SlmGenerateResult["finishReason"] =
        native.tokensEmitted >= params.maxTokens ? "length" : "stop";
      this.emit({ op: "generate", outcome: "ok" });
      return {
        text: native.text,
        tokensPerSecond:
          elapsed > 0 ? (native.tokensEmitted / elapsed) * 1000 : 0,
        finishReason,
      };
    } finally {
      clear();
    }
  }

  async *generateStream(params: SlmGenerateParams): AsyncIterable<string> {
    this.requireLoaded("generateStream");
    this.assertDeadline(params.deadlineMs);

    const started = this.nowMs();
    const { controller, clear } = this.beginNativeAbort(params.deadlineMs);
    let deltaCount = 0;
    try {
      for await (const delta of toStreamDeltas(
        this.backend.generateStream(this.handle!, {
          prompt: params.prompt,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          deadlineMs: params.deadlineMs,
          signal: controller.signal,
          ...(params.stopSequences !== undefined
            ? { stopSequences: params.stopSequences }
            : {}),
          nowMs: this.nowMs,
        }),
      )) {
        if (
          controller.signal.aborted ||
          this.nowMs() - started > params.deadlineMs
        ) {
          controller.abort();
          this.emit({
            op: "generateStream",
            outcome: "deadline",
            deltaCount,
          });
          return;
        }
        deltaCount += 1;
        yield delta;
      }

      if (controller.signal.aborted || this.nowMs() - started > params.deadlineMs) {
        this.emit({
          op: "generateStream",
          outcome: "deadline",
          deltaCount,
        });
        return;
      }

      this.emit({
        op: "generateStream",
        outcome: deltaCount > 0 ? "ok" : "deadline",
        deltaCount,
      });
    } finally {
      clear();
    }
  }

  async embed(text: string): Promise<Float32Array> {
    this.requireLoaded("embed");
    const vector = await this.backend.embed(this.handle!, text);
    if (this.embedDim === null) {
      throw new SlmRuntimeInitError("embed dimension unset after load", {
        failureClass: "config",
        reason: "config",
      });
    }
    if (vector.length !== this.embedDim) {
      throw new SlmRuntimeInitError(
        `embed dimension drift: want ${this.embedDim} got ${vector.length}`,
        { failureClass: "config", reason: "config" },
      );
    }
    this.emit({ op: "embed", outcome: "ok" });
    return vector;
  }

  /**
   * Arm AbortController for native work. Wall-clock timer fires when the
   * host uses real time; injectable nowMs paths abort via explicit poll.
   */
  private beginNativeAbort(deadlineMs: number): {
    controller: AbortController;
    clear: () => void;
  } {
    this.activeAbort?.abort();
    const controller = new AbortController();
    this.activeAbort = controller;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only schedule a real timer when using wall clock — fake clocks poll via nowMs.
    if (!this.options.nowMs) {
      timer = setTimeout(() => {
        controller.abort();
      }, Math.max(1, deadlineMs));
    }

    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (this.activeAbort === controller) this.activeAbort = null;
    };
    return { controller, clear };
  }

  private requireLoaded(op: string): void {
    if (!this.loaded || !this.handle) {
      throw new SlmRuntimeInitError(
        `LlamaCppSlmRuntime.${op} before successful load`,
        { failureClass: "config", reason: "config" },
      );
    }
  }

  private assertDeadline(deadlineMs: number): void {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new SlmRuntimeInitError("deadlineMs must be a positive number", {
        failureClass: "config",
        reason: "config",
      });
    }
  }

  private failLoad(
    reason: "missing" | "corrupt" | "config",
    message: string,
  ): SlmRuntimeInitError {
    const failureClass: SlmRuntimeInitFailureClass =
      reason === "missing"
        ? "missing_weights"
        : reason === "corrupt"
          ? "corrupt_weights"
          : "config";
    const error = new SlmRuntimeInitError(message, { failureClass, reason });
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
    partial: Pick<LlamaCppTelemetryEvent, "op" | "outcome"> &
      Partial<
        Pick<
          LlamaCppTelemetryEvent,
          "failureClass" | "obligationId" | "reason" | "deltaCount"
        >
      >,
  ): void {
    const event: LlamaCppTelemetryEvent = {
      event: "bindings_slm.llamacpp",
      modelId: this.cardState.modelId,
      backendKind: this.backend.kind,
      pinnedRevision: LLAMA_CPP_PINNED_REVISION,
      ...partial,
    };
    const sid = this.options.subjectId?.trim();
    const did = this.options.deviceId?.trim();
    if (sid) event.subjectId = sid;
    if (did) event.deviceId = did;
    // Never put prompt / utterance content on the wire here.
    this.options.onTelemetry?.(event);
  }
}
