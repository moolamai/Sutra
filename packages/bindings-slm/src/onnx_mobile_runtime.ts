/**
 * OnnxSlmRuntime — SlmRuntime for ONNX Runtime Mobile (Android).
 *
 * Memory ceilings (this slice): configurable maxMemoryMiB (mid-range device
 * profile by default); load planner refuses before weight materialization when
 * the model card's declared peak RSS exceeds the device budget.
 */

import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Pinned ONNX Runtime Mobile version for Android certification reports. */
export const ONNX_RUNTIME_MOBILE_PINNED_VERSION = "1.17.3";

/** Quant formats certified for OnnxSlmRuntime (see android/SUPPORTED_QUANT_FORMATS.json). */
export const ONNX_MOBILE_SUPPORTED_QUANT_FORMATS = ["int4", "int8"] as const;

/** Default mid-range Android device profile shipped under android/. */
export const MID_RANGE_DEVICE_PROFILE_PATH = path.join(
  PACKAGE_ROOT,
  "android/device-profiles/mid-range.json",
);

export const ONNX_MOBILE_DEVICE_PROFILE_SCHEMA =
  "bindings-slm.device-profile.v1" as const;

export type OnnxMobileDeviceProfile = {
  schemaVersion: typeof ONNX_MOBILE_DEVICE_PROFILE_SCHEMA | string;
  profileId: string;
  platform: string;
  hardwareClass: string;
  maxMemoryMiB: number;
  description?: string;
  nfr?: { firstTokenP95Ms?: number; nfrId?: string };
};

export type OnnxMobileModelCardFile = {
  modelId: string;
  contextWindow: number;
  quantization: string;
  /** Declared peak RSS in MiB (not bare weight file size). */
  memoryFootprintMiB: number;
  languages: string[];
  embedDim: number;
  graphInputs?: string[];
  graphOutputs?: string[];
};

export type OnnxLoadPlan =
  | { allowed: true; declaredFootprintMiB: number; maxMemoryMiB: number }
  | {
      allowed: false;
      declaredFootprintMiB: number;
      maxMemoryMiB: number;
      modelId: string;
      message: string;
    };

/**
 * Edge-harness load planner: decide whether a model may materialize weights.
 * Rejects before ORT / native session creation when over the device ceiling.
 */
export function planOnnxMobileLoad(input: {
  declaredFootprintMiB: number;
  maxMemoryMiB: number;
  modelId: string;
}): OnnxLoadPlan {
  const { declaredFootprintMiB, maxMemoryMiB, modelId } = input;
  if (
    !Number.isFinite(declaredFootprintMiB) ||
    !Number.isFinite(maxMemoryMiB) ||
    declaredFootprintMiB <= 0 ||
    maxMemoryMiB <= 0
  ) {
    return {
      allowed: false,
      declaredFootprintMiB,
      maxMemoryMiB,
      modelId,
      message: `invalid memory budget (declared=${declaredFootprintMiB} max=${maxMemoryMiB})`,
    };
  }
  if (declaredFootprintMiB > maxMemoryMiB) {
    return {
      allowed: false,
      declaredFootprintMiB,
      maxMemoryMiB,
      modelId,
      message: `model ${modelId} memoryFootprintMiB=${declaredFootprintMiB} exceeds device ceiling maxMemoryMiB=${maxMemoryMiB}`,
    };
  }
  return { allowed: true, declaredFootprintMiB, maxMemoryMiB };
}

export function loadMidRangeDeviceProfile(
  profilePath: string = MID_RANGE_DEVICE_PROFILE_PATH,
): OnnxMobileDeviceProfile {
  if (!existsSync(profilePath)) {
    throw new SlmRuntimeInitError(
      `mid-range device profile missing at ${profilePath}`,
      { failureClass: "config", reason: "config" },
    );
  }
  const raw = JSON.parse(readFileSync(profilePath, "utf8")) as OnnxMobileDeviceProfile;
  if (
    !Number.isFinite(raw.maxMemoryMiB) ||
    raw.maxMemoryMiB <= 0 ||
    !Number.isInteger(raw.maxMemoryMiB)
  ) {
    throw new SlmRuntimeInitError(
      `device profile maxMemoryMiB invalid: ${String(raw.maxMemoryMiB)}`,
      { failureClass: "config", reason: "config" },
    );
  }
  return raw;
}

/** Sidecar path: `<weights>.card.json` — metadata only, never the weight bytes. */
export function onnxCardSidecarPath(weightsPath: string): string {
  return `${weightsPath}.card.json`;
}

export function readOnnxModelCardFile(
  weightsPath: string,
): OnnxMobileModelCardFile {
  const cardPath = onnxCardSidecarPath(weightsPath);
  if (!existsSync(cardPath)) {
    throw new SlmRuntimeInitError(
      `ONNX model card sidecar missing at ${cardPath}`,
      { failureClass: "missing_weights", reason: "missing" },
    );
  }
  let raw: OnnxMobileModelCardFile;
  try {
    raw = JSON.parse(readFileSync(cardPath, "utf8")) as OnnxMobileModelCardFile;
  } catch (err) {
    throw new SlmRuntimeInitError(
      `ONNX model card corrupt: ${err instanceof Error ? err.message : "parse"}`,
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (!raw.modelId?.trim()) {
    throw new SlmRuntimeInitError("ONNX model card missing modelId", {
      failureClass: "corrupt_weights",
      reason: "corrupt",
    });
  }
  if (
    !Number.isFinite(raw.memoryFootprintMiB) ||
    raw.memoryFootprintMiB <= 0
  ) {
    throw new SlmRuntimeInitError(
      "ONNX model card memoryFootprintMiB must be a positive number",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (
    !Number.isFinite(raw.embedDim) ||
    raw.embedDim <= 0 ||
    !Number.isInteger(raw.embedDim)
  ) {
    throw new SlmRuntimeInitError("ONNX model card embedDim invalid", {
      failureClass: "corrupt_weights",
      reason: "corrupt",
    });
  }
  return raw;
}

export type OnnxMobileNativeHandle = { readonly id: string };

export type OnnxMobileGenerateNativeParams = {
  prompt: string;
  maxTokens: number;
  temperature: number;
  deadlineMs: number;
  signal?: AbortSignal;
  nowMs?: () => number;
};

export type OnnxMobileGenerateNativeResult = {
  text: string;
  tokensEmitted: number;
  deadlineHit: boolean;
};

export interface OnnxMobileNativeBackend {
  readonly kind: "in-process" | "ort-mobile" | "jni";
  /**
   * Materialize session weights. Must only be called after the load planner
   * has allowed the declared footprint.
   */
  load(
    weightsPath: string,
    card: OnnxMobileModelCardFile,
  ): Promise<{ handle: OnnxMobileNativeHandle; embedDim: number }>;
  unload(handle: OnnxMobileNativeHandle): Promise<void>;
  generate(
    handle: OnnxMobileNativeHandle,
    params: OnnxMobileGenerateNativeParams,
  ): Promise<OnnxMobileGenerateNativeResult>;
  generateStream(
    handle: OnnxMobileNativeHandle,
    params: OnnxMobileGenerateNativeParams,
  ): AsyncIterable<string>;
  embed(handle: OnnxMobileNativeHandle, text: string): Promise<Float32Array>;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Deterministic in-process stand-in for ONNX Runtime Mobile (CI / desktop).
 * Tracks materialization so tests can prove ceiling rejects never reach load().
 */
export function createInProcessOnnxMobileBackend(
  opts: {
    defaultEmbedDim?: number;
    streamChunkChars?: number;
    onMaterialize?: (weightsPath: string) => void;
  } = {},
): OnnxMobileNativeBackend {
  const defaultEmbedDim = opts.defaultEmbedDim ?? 8;
  const streamChunkChars = opts.streamChunkChars ?? 2;
  const loaded = new Map<
    string,
    { card: OnnxMobileModelCardFile; embedDim: number; weightsPath: string }
  >();
  let seq = 0;

  return {
    kind: "in-process",

    async load(weightsPath, card) {
      opts.onMaterialize?.(weightsPath);
      const id = `onnx-h-${++seq}`;
      const embedDim = card.embedDim > 0 ? card.embedDim : defaultEmbedDim;
      loaded.set(id, { card, embedDim, weightsPath });
      return { handle: { id }, embedDim };
    },

    async unload(handle) {
      loaded.delete(handle.id);
    },

    async generate(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("onnx generate on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (isAborted(params.signal)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }
      const workMs = Math.min(params.deadlineMs + 50, 5 + params.prompt.length);
      const slice = Math.min(workMs, Math.max(1, params.deadlineMs));
      await new Promise<void>((resolve) => setTimeout(resolve, slice));
      if (isAborted(params.signal) || now() - started > params.deadlineMs) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }
      const max = Math.max(1, Math.min(params.maxTokens, 64));
      const text = `onnx:${params.prompt.length}:${max}`;
      return { text, tokensEmitted: max, deadlineHit: false };
    },

    async *generateStream(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("onnx generateStream on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      const max = Math.max(1, Math.min(params.maxTokens, 64));
      const full = `onnx:${params.prompt.length}:${max}`;
      for (let i = 0; i < full.length; i += streamChunkChars) {
        if (isAborted(params.signal) || now() - started > params.deadlineMs) {
          return;
        }
        yield full.slice(i, i + streamChunkChars);
      }
    },

    async embed(handle, text) {
      const entry = loaded.get(handle.id);
      if (!entry) throw new Error("onnx embed on unloaded handle");
      const out = new Float32Array(entry.embedDim);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
      for (let i = 0; i < out.length; i++) out[i] = ((h + i) % 997) / 997;
      return out;
    },
  };
}

export type OnnxExecutionProvider = "nnapi" | "gpu" | "cpu";

export type OnnxSlmRuntimeOptions = {
  /** Path to ONNX weights; card is read from `<path>.card.json`. */
  weightsPath: string;
  /**
   * Configurable memory ceiling (MiB). Overrides the device profile when set.
   * Defaults to the mid-range Android profile maxMemoryMiB.
   */
  maxMemoryMiB?: number;
  /** Device profile object or absolute path (defaults to android mid-range). */
  deviceProfile?: OnnxMobileDeviceProfile | string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: OnnxMobileTelemetryEvent) => void;
  backend?: OnnxMobileNativeBackend;
  nowMs?: () => number;
  /**
   * Preferred execution provider. When NNAPI/GPU is unavailable the in-process /
   * ORT path falls back to CPU (never silent hang).
   */
  preferredExecutionProvider?: OnnxExecutionProvider;
  /**
   * Required graph I/O tensor names. When set, load fails with a typed graph
   * error naming the first missing tensor (export-version mismatch).
   */
  requiredGraphInputs?: string[];
  requiredGraphOutputs?: string[];
};

export type OnnxMobileTelemetryOp =
  | "load"
  | "unload"
  | "generate"
  | "generateStream"
  | "embed"
  | "plan"
  | "ep_select";

export type OnnxMobileTelemetryEvent = {
  event: "bindings_slm.onnx_mobile";
  op: OnnxMobileTelemetryOp;
  outcome:
    | "ok"
    | "init_error"
    | "deadline"
    | "memory_ceiling_reject"
    | "graph_mismatch"
    | "cpu_fallback";
  modelId: string;
  subjectId?: string;
  deviceId?: string;
  backendKind: OnnxMobileNativeBackend["kind"];
  profileId?: string;
  maxMemoryMiB?: number;
  declaredFootprintMiB?: number;
  executionProvider?: OnnxExecutionProvider;
  failureClass?: SlmRuntimeInitFailureClass;
  obligationId?: string;
  reason?: "missing" | "corrupt" | "config";
  deltaCount?: number;
  detail?: string;
};

const PLACEHOLDER_CARD: SlmModelCard = {
  modelId: "unloaded",
  contextWindow: 1,
  quantization: "unknown",
  memoryFootprintMiB: 1,
  languages: ["en"],
};

export class OnnxSlmRuntime implements SlmRuntime {
  private loaded = false;
  private loadAttempts = 0;
  private handle: OnnxMobileNativeHandle | null = null;
  private embedDim: number | null = null;
  private cardState: SlmModelCard = { ...PLACEHOLDER_CARD };
  private readonly backend: OnnxMobileNativeBackend;
  private readonly nowMs: () => number;
  private readonly deviceProfile: OnnxMobileDeviceProfile;
  private readonly maxMemoryMiB: number;
  private activeAbort: AbortController | null = null;
  private executionProvider: OnnxExecutionProvider = "cpu";

  constructor(private readonly options: OnnxSlmRuntimeOptions) {
    if (!options.weightsPath || !String(options.weightsPath).trim()) {
      throw new SlmRuntimeInitError("OnnxSlmRuntime requires weightsPath", {
        failureClass: "config",
        reason: "config",
      });
    }
    this.backend = options.backend ?? createInProcessOnnxMobileBackend();
    this.nowMs = options.nowMs ?? (() => Date.now());

    if (typeof options.deviceProfile === "string") {
      this.deviceProfile = loadMidRangeDeviceProfile(options.deviceProfile);
    } else if (options.deviceProfile) {
      this.deviceProfile = options.deviceProfile;
    } else {
      this.deviceProfile = loadMidRangeDeviceProfile();
    }

    this.maxMemoryMiB =
      options.maxMemoryMiB !== undefined
        ? options.maxMemoryMiB
        : this.deviceProfile.maxMemoryMiB;

    if (
      !Number.isFinite(this.maxMemoryMiB) ||
      this.maxMemoryMiB <= 0 ||
      !Number.isInteger(this.maxMemoryMiB)
    ) {
      throw new SlmRuntimeInitError(
        `maxMemoryMiB must be a positive integer (got ${String(this.maxMemoryMiB)})`,
        { failureClass: "config", reason: "config" },
      );
    }
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

  get memoryCeilingMiB(): number {
    return this.maxMemoryMiB;
  }

  get profileId(): string {
    return this.deviceProfile.profileId;
  }

  get activeExecutionProvider(): OnnxExecutionProvider {
    return this.executionProvider;
  }

  /**
   * Resolve execution provider. NNAPI/GPU preference falls back to CPU when
   * the injectable backend is in-process (CI) or delegates are unavailable.
   */
  private resolveExecutionProvider(modelId: string): OnnxExecutionProvider {
    const preferred = this.options.preferredExecutionProvider ?? "cpu";
    if (preferred === "cpu") return "cpu";
    // In-process CI stand-in and hosts without NNAPI/GPU always CPU-fallback.
    if (this.backend.kind === "in-process") {
      this.emit({
        op: "ep_select",
        outcome: "cpu_fallback",
        modelId,
        executionProvider: "cpu",
        detail: `${preferred}_unavailable`,
      });
      return "cpu";
    }
    return preferred;
  }

  async load(): Promise<void> {
    this.loadAttempts += 1;
    if (this.loaded) {
      this.emit({ op: "load", outcome: "ok" });
      return;
    }

    // 1) Card sidecar only — never open weight bytes before planner allows.
    let modelCard: OnnxMobileModelCardFile;
    try {
      modelCard = readOnnxModelCardFile(this.options.weightsPath);
    } catch (err) {
      if (err instanceof SlmRuntimeInitError) {
        this.emit({
          op: "load",
          outcome: "init_error",
          failureClass: err.failureClass,
          obligationId: err.obligationId,
          reason: err.reason,
          detail: err.message,
        });
        throw err;
      }
      throw this.failLoad(
        "corrupt",
        `ONNX card read failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    // 2) Load planner — refuse before materialization when over budget.
    const plan = planOnnxMobileLoad({
      declaredFootprintMiB: modelCard.memoryFootprintMiB,
      maxMemoryMiB: this.maxMemoryMiB,
      modelId: modelCard.modelId,
    });
    this.emit({
      op: "plan",
      outcome: plan.allowed ? "ok" : "memory_ceiling_reject",
      modelId: modelCard.modelId,
      profileId: this.deviceProfile.profileId,
      maxMemoryMiB: this.maxMemoryMiB,
      declaredFootprintMiB: modelCard.memoryFootprintMiB,
      ...(plan.allowed
        ? {}
        : {
            failureClass: "config" as const,
            obligationId: EDGE_SLM_LOAD_OBLIGATION,
            reason: "config" as const,
            detail: plan.message,
          }),
    });
    if (!plan.allowed) {
      throw this.failLoad("config", plan.message, {
        modelId: modelCard.modelId,
        skipEmit: true,
      });
    }

    // Graph I/O names (export version mismatch) — still pre-materialization.
    const missingIn = (this.options.requiredGraphInputs ?? []).find(
      (n) => !(modelCard.graphInputs ?? []).includes(n),
    );
    if (missingIn) {
      this.emit({
        op: "load",
        outcome: "graph_mismatch",
        modelId: modelCard.modelId,
        failureClass: "config",
        obligationId: EDGE_SLM_LOAD_OBLIGATION,
        reason: "config",
        detail: `missing graph input tensor: ${missingIn}`,
      });
      throw this.failLoad(
        "config",
        `ONNX graph missing input tensor: ${missingIn}`,
        { modelId: modelCard.modelId, skipEmit: true },
      );
    }
    const missingOut = (this.options.requiredGraphOutputs ?? []).find(
      (n) => !(modelCard.graphOutputs ?? []).includes(n),
    );
    if (missingOut) {
      this.emit({
        op: "load",
        outcome: "graph_mismatch",
        modelId: modelCard.modelId,
        failureClass: "config",
        obligationId: EDGE_SLM_LOAD_OBLIGATION,
        reason: "config",
        detail: `missing graph output tensor: ${missingOut}`,
      });
      throw this.failLoad(
        "config",
        `ONNX graph missing output tensor: ${missingOut}`,
        { modelId: modelCard.modelId, skipEmit: true },
      );
    }

    // 3) Materialize weights only after planner allow.
    this.executionProvider = this.resolveExecutionProvider(modelCard.modelId);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.options.weightsPath));
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw this.failLoad("missing", "ONNX weights missing at path", {
          modelId: modelCard.modelId,
        });
      }
      throw this.failLoad(
        "corrupt",
        `ONNX weights unreadable (${code || "io_error"})`,
        { modelId: modelCard.modelId },
      );
    }
    if (bytes.byteLength === 0) {
      throw this.failLoad("corrupt", "ONNX weights file is empty", {
        modelId: modelCard.modelId,
      });
    }

    let loaded: { handle: OnnxMobileNativeHandle; embedDim: number };
    try {
      loaded = await this.backend.load(this.options.weightsPath, modelCard);
    } catch (err) {
      throw this.failLoad(
        "corrupt",
        `native ORT load failed: ${err instanceof Error ? err.message : "unknown"}`,
        { modelId: modelCard.modelId },
      );
    }

    if (
      !Number.isFinite(loaded.embedDim) ||
      loaded.embedDim <= 0 ||
      !Number.isInteger(loaded.embedDim)
    ) {
      await this.backend.unload(loaded.handle).catch(() => undefined);
      throw this.failLoad("config", "native embed dimension invalid", {
        modelId: modelCard.modelId,
      });
    }

    this.handle = loaded.handle;
    this.embedDim = loaded.embedDim;
    this.cardState = {
      modelId: modelCard.modelId,
      contextWindow: modelCard.contextWindow,
      quantization: modelCard.quantization,
      memoryFootprintMiB: modelCard.memoryFootprintMiB,
      languages: [...modelCard.languages],
    };
    this.loaded = true;
    this.emit({
      op: "load",
      outcome: "ok",
      modelId: modelCard.modelId,
      profileId: this.deviceProfile.profileId,
      maxMemoryMiB: this.maxMemoryMiB,
      declaredFootprintMiB: modelCard.memoryFootprintMiB,
      executionProvider: this.executionProvider,
    });
  }

  async unload(): Promise<void> {
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
        nowMs: this.nowMs,
      });
      const elapsed = Math.max(0, this.nowMs() - started);
      if (
        native.deadlineHit ||
        controller.signal.aborted ||
        elapsed > params.deadlineMs
      ) {
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

  private beginNativeAbort(deadlineMs: number): {
    controller: AbortController;
    clear: () => void;
  } {
    this.activeAbort?.abort();
    const controller = new AbortController();
    this.activeAbort = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
        `OnnxSlmRuntime.${op} before successful load`,
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
    opts: { modelId?: string; skipEmit?: boolean } = {},
  ): SlmRuntimeInitError {
    const failureClass: SlmRuntimeInitFailureClass =
      reason === "missing"
        ? "missing_weights"
        : reason === "corrupt"
          ? "corrupt_weights"
          : "config";
    const error = new SlmRuntimeInitError(message, { failureClass, reason });
    if (!opts.skipEmit) {
      this.emit({
        op: "load",
        outcome: "init_error",
        failureClass,
        obligationId: EDGE_SLM_LOAD_OBLIGATION,
        reason,
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        detail: message,
      });
    }
    return error;
  }

  private emit(
    partial: Pick<OnnxMobileTelemetryEvent, "op" | "outcome"> &
      Partial<
        Pick<
          OnnxMobileTelemetryEvent,
          | "failureClass"
          | "obligationId"
          | "reason"
          | "deltaCount"
          | "detail"
          | "modelId"
          | "profileId"
          | "maxMemoryMiB"
          | "declaredFootprintMiB"
          | "executionProvider"
        >
      >,
  ): void {
    const event: OnnxMobileTelemetryEvent = {
      event: "bindings_slm.onnx_mobile",
      modelId: partial.modelId ?? this.cardState.modelId,
      backendKind: this.backend.kind,
      profileId: this.deviceProfile.profileId,
      maxMemoryMiB: this.maxMemoryMiB,
      ...partial,
    };
    const sid = this.options.subjectId?.trim();
    const did = this.options.deviceId?.trim();
    if (sid) event.subjectId = sid;
    if (did) event.deviceId = did;
    this.options.onTelemetry?.(event);
  }
}
