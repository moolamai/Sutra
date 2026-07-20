/**
 * MlxSlmRuntime — SlmRuntime over MLX + Metal on Apple silicon.
 *
 * Loads bundled MLX weights, exposes full generate / generateStream / embed,
 * and populates SlmModelCard languages from the export's BCP-47 list.
 * Intel Mac / non-Apple hosts fail load() with a typed unsupported-platform error.
 *
 * Streaming / deadline (this slice): AbortController races deadlineMs at the
 * native Metal seam; generateStream yields CK-03.2 token deltas (never
 * cumulative frames); finishReason maps to edge-agent expectations
 * (stop | length | deadline | aborted).
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Pinned MLX package revision recorded in Apple silicon certification reports. */
export const MLX_PINNED_REVISION = "0.22.0";

/** BCP-47 language tag pattern (loose — validates export card, not IETF registry). */
const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export type MlxHostProbe = {
  platform: string;
  arch: string;
};

export type MlxPlatformProbeResult =
  | {
      supported: true;
      appleSilicon: true;
      metalRequired: true;
      platform: string;
      arch: string;
    }
  | {
      supported: false;
      reason: "unsupported_platform";
      platform: string;
      arch: string;
      detail: string;
    };

/**
 * Apple silicon = darwin + arm64. Intel Mac / Linux / Windows → unsupported.
 */
export function probeMlxPlatform(
  host: MlxHostProbe = {
    platform: process.platform,
    arch: process.arch,
  },
): MlxPlatformProbeResult {
  const platform = host.platform;
  const arch = host.arch;
  if (platform === "darwin" && arch === "arm64") {
    return {
      supported: true,
      appleSilicon: true,
      metalRequired: true,
      platform,
      arch,
    };
  }
  return {
    supported: false,
    reason: "unsupported_platform",
    platform,
    arch,
    detail:
      platform === "darwin" && arch === "x64"
        ? "Intel Mac is not supported for MLX/Metal bindings (Apple silicon required)"
        : `MLX/Metal requires darwin/arm64 (got ${platform}/${arch})`,
  };
}

export type MlxModelCardFile = {
  modelId: string;
  contextWindow: number;
  quantization: string;
  memoryFootprintMiB: number;
  /** BCP-47 languages the MLX export supports. */
  languages: string[];
  embedDim: number;
  metalRequired?: boolean;
};

/** Sidecar: `<weightsPath>.card.json`. */
export function mlxCardSidecarPath(weightsPath: string): string {
  return `${weightsPath}.card.json`;
}

export function readMlxModelCardFile(weightsPath: string): MlxModelCardFile {
  const cardPath = mlxCardSidecarPath(weightsPath);
  if (!existsSync(cardPath)) {
    throw new SlmRuntimeInitError(
      `MLX model card sidecar missing at ${cardPath}`,
      { failureClass: "missing_weights", reason: "missing" },
    );
  }
  let raw: MlxModelCardFile;
  try {
    raw = JSON.parse(readFileSync(cardPath, "utf8")) as MlxModelCardFile;
  } catch (err) {
    throw new SlmRuntimeInitError(
      `MLX model card corrupt: ${err instanceof Error ? err.message : "parse"}`,
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (!raw.modelId?.trim()) {
    throw new SlmRuntimeInitError("MLX model card missing modelId", {
      failureClass: "corrupt_weights",
      reason: "corrupt",
    });
  }
  if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
    throw new SlmRuntimeInitError(
      "MLX model card must list at least one BCP-47 language",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  for (const lang of raw.languages) {
    if (typeof lang !== "string" || !BCP47_RE.test(lang)) {
      throw new SlmRuntimeInitError(
        `MLX model card language is not BCP-47: ${String(lang)}`,
        { failureClass: "corrupt_weights", reason: "corrupt" },
      );
    }
  }
  if (
    !Number.isFinite(raw.embedDim) ||
    raw.embedDim <= 0 ||
    !Number.isInteger(raw.embedDim)
  ) {
    throw new SlmRuntimeInitError("MLX model card embedDim invalid", {
      failureClass: "corrupt_weights",
      reason: "corrupt",
    });
  }
  if (
    !Number.isFinite(raw.memoryFootprintMiB) ||
    raw.memoryFootprintMiB <= 0
  ) {
    throw new SlmRuntimeInitError(
      "MLX model card memoryFootprintMiB must be a positive number",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  return raw;
}

export type MlxNativeHandle = { readonly id: string };

export type MlxGenerateNativeParams = {
  prompt: string;
  maxTokens: number;
  temperature: number;
  deadlineMs: number;
  /**
   * Native AbortController-equivalent. Metal backends MUST stop work when
   * aborted and report deadlineHit / end the stream — never hang the harness.
   */
  signal?: AbortSignal;
  nowMs?: () => number;
  stopSequences?: string[];
};

export type MlxGenerateNativeResult = {
  text: string;
  tokensEmitted: number;
  /** True when the backend stopped due to deadline / AbortSignal. */
  deadlineHit: boolean;
};

export interface MlxNativeBackend {
  readonly kind: "in-process" | "mlx-metal" | "ffi";
  load(
    weightsPath: string,
    card: MlxModelCardFile,
  ): Promise<{ handle: MlxNativeHandle; embedDim: number }>;
  unload(handle: MlxNativeHandle): Promise<void>;
  generate(
    handle: MlxNativeHandle,
    params: MlxGenerateNativeParams,
  ): Promise<MlxGenerateNativeResult>;
  /**
   * Yields CK-03.2 deltas (each chunk is new text only).
   * Stops cleanly when `params.signal` aborts or deadlineMs elapses.
   */
  generateStream(
    handle: MlxNativeHandle,
    params: MlxGenerateNativeParams,
  ): AsyncIterable<string>;
  embed(handle: MlxNativeHandle, text: string): Promise<Float32Array>;
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
 * Map native / wall-clock outcomes to {@link SlmGenerateResult.finishReason}
 * as edge-agent ModelInterface expects (aborted and deadline both cancel).
 */
export function mapMlxFinishReason(input: {
  deadlineHit: boolean;
  signalAborted: boolean;
  elapsedMs: number;
  deadlineMs: number;
  tokensEmitted: number;
  maxTokens: number;
}): SlmGenerateResult["finishReason"] {
  // Wall-clock / native deadline takes precedence (thermal throttle path).
  if (input.deadlineHit || input.elapsedMs > input.deadlineMs) {
    return "deadline";
  }
  // Cooperative cancel (e.g. unload) without a deadline breach.
  if (input.signalAborted) return "aborted";
  if (input.tokensEmitted >= input.maxTokens) return "length";
  return "stop";
}

function buildMlxText(params: MlxGenerateNativeParams): string {
  const max = Math.max(1, Math.min(params.maxTokens, 64));
  return `mlx:${params.prompt.length}:${max}`;
}

/**
 * Deterministic Metal stand-in for CI (runs on any host when platform probe
 * is stubbed to darwin/arm64). Production injects a real MLX/Metal backend.
 *
 * Deadline: races AbortSignal mid-wait (native abort seam). Streaming yields
 * token-sized CK-03.2 deltas and stops when the signal aborts.
 */
export function createInProcessMlxMetalBackend(
  opts: {
    streamChunkChars?: number;
    /** Simulate dtype change that MUST NOT alter embed length. */
    embedDtype?: "float16" | "float32";
  } = {},
): MlxNativeBackend {
  const streamChunkChars = opts.streamChunkChars ?? 2;
  const loaded = new Map<
    string,
    { card: MlxModelCardFile; embedDim: number; weightsPath: string }
  >();
  let seq = 0;

  return {
    kind: "in-process",

    async load(weightsPath, card) {
      const id = `mlx-h-${++seq}`;
      loaded.set(id, { card, embedDim: card.embedDim, weightsPath });
      return { handle: { id }, embedDim: card.embedDim };
    },

    async unload(handle) {
      loaded.delete(handle.id);
    },

    async generate(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("mlx generate on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();

      if (isAborted(params.signal)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }

      // Simulate Metal token cost; honor AbortSignal mid-wait (native abort).
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
        if (aborted) {
          // Distinguish wall-clock deadline vs cooperative unload cancel.
          return {
            text: "",
            tokensEmitted: 0,
            deadlineHit: deadlineBreached(started, params.deadlineMs, now),
          };
        }
        if (deadlineBreached(started, params.deadlineMs, now)) {
          return { text: "", tokensEmitted: 0, deadlineHit: true };
        }
      } else if (
        deadlineBreached(started, params.deadlineMs, now) ||
        now() - started + workMs > params.deadlineMs
      ) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }

      const text = buildMlxText(params);
      const tokensEmitted = Math.max(1, Math.min(params.maxTokens, 64) - 1);
      return { text, tokensEmitted, deadlineHit: false };
    },

    async *generateStream(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("mlx generateStream on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (
        isAborted(params.signal) ||
        deadlineBreached(started, params.deadlineMs, now)
      ) {
        return;
      }

      const full = buildMlxText(params);
      const step = Math.max(1, streamChunkChars);
      for (let i = 0; i < full.length; i += step) {
        if (
          isAborted(params.signal) ||
          deadlineBreached(started, params.deadlineMs, now)
        ) {
          return;
        }
        // True delta — incremental token slice, never cumulative restate.
        yield full.slice(i, i + step);
      }
    },

    async embed(handle, text) {
      const entry = loaded.get(handle.id);
      if (!entry) throw new Error("mlx embed on unloaded handle");
      // Dtype selection is a no-op for length — invariant: length === embedDim.
      void opts.embedDtype;
      const out = new Float32Array(entry.embedDim);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) >>> 0;
      for (let i = 0; i < out.length; i++) out[i] = ((h + i * 7) % 1009) / 1009;
      return out;
    },
  };
}

export type MlxSlmRuntimeOptions = {
  /** Path to bundled MLX weights; card at `<path>.card.json`. */
  weightsPath: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: MlxTelemetryEvent) => void;
  backend?: MlxNativeBackend;
  nowMs?: () => number;
  /**
   * Override host probe (tests). Defaults to process.platform / process.arch.
   * Intel Mac / non-Apple → load fails with typed unsupported_platform.
   */
  hostProbe?: MlxHostProbe;
};

export type MlxTelemetryOp =
  | "load"
  | "unload"
  | "generate"
  | "generateStream"
  | "embed"
  | "platform_probe";

export type MlxTelemetryEvent = {
  event: "bindings_slm.mlx";
  op: MlxTelemetryOp;
  outcome:
    | "ok"
    | "init_error"
    | "deadline"
    | "unsupported_platform";
  modelId: string;
  subjectId?: string;
  deviceId?: string;
  backendKind: MlxNativeBackend["kind"];
  platform?: string;
  arch?: string;
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

export class MlxSlmRuntime implements SlmRuntime {
  private loaded = false;
  private loadAttempts = 0;
  private handle: MlxNativeHandle | null = null;
  private embedDim: number | null = null;
  private cardState: SlmModelCard = { ...PLACEHOLDER_CARD };
  private readonly backend: MlxNativeBackend;
  private readonly nowMs: () => number;
  private activeAbort: AbortController | null = null;

  constructor(private readonly options: MlxSlmRuntimeOptions) {
    if (!options.weightsPath || !String(options.weightsPath).trim()) {
      throw new SlmRuntimeInitError("MlxSlmRuntime requires weightsPath", {
        failureClass: "config",
        reason: "config",
      });
    }
    this.backend = options.backend ?? createInProcessMlxMetalBackend();
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

  async load(): Promise<void> {
    this.loadAttempts += 1;
    if (this.loaded) {
      this.emit({ op: "load", outcome: "ok" });
      return;
    }

    const probe = probeMlxPlatform(this.options.hostProbe);
    this.emit({
      op: "platform_probe",
      outcome: probe.supported ? "ok" : "unsupported_platform",
      platform: probe.platform,
      arch: probe.arch,
      ...(probe.supported
        ? {}
        : {
            failureClass: "config" as const,
            obligationId: EDGE_SLM_LOAD_OBLIGATION,
            reason: "config" as const,
            detail: probe.detail,
          }),
    });
    if (!probe.supported) {
      throw this.failLoad("config", `unsupported_platform: ${probe.detail}`, {
        skipEmit: true,
      });
    }

    let modelCard: MlxModelCardFile;
    try {
      modelCard = readMlxModelCardFile(this.options.weightsPath);
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
        `MLX card read failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
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
        throw this.failLoad("missing", "MLX weights missing at path", {
          modelId: modelCard.modelId,
        });
      }
      throw this.failLoad(
        "corrupt",
        `MLX weights unreadable (${code || "io_error"})`,
        { modelId: modelCard.modelId },
      );
    }
    if (bytes.byteLength === 0) {
      throw this.failLoad("corrupt", "MLX weights file is empty", {
        modelId: modelCard.modelId,
      });
    }

    let loaded: { handle: MlxNativeHandle; embedDim: number };
    try {
      loaded = await this.backend.load(this.options.weightsPath, modelCard);
    } catch (err) {
      throw this.failLoad(
        "corrupt",
        `MLX/Metal load failed: ${err instanceof Error ? err.message : "unknown"}`,
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
      platform: probe.platform,
      arch: probe.arch,
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
        ...(params.stopSequences !== undefined
          ? { stopSequences: params.stopSequences }
          : {}),
      });
      const elapsed = Math.max(0, this.nowMs() - started);
      const finishReason = mapMlxFinishReason({
        deadlineHit: native.deadlineHit,
        signalAborted: controller.signal.aborted,
        elapsedMs: elapsed,
        deadlineMs: params.deadlineMs,
        tokensEmitted: native.tokensEmitted,
        maxTokens: params.maxTokens,
      });
      if (finishReason === "deadline" || finishReason === "aborted") {
        // Discard partial text on cancel (matches edge-agent ModelInterface).
        this.emit({
          op: "generate",
          outcome: "deadline",
          detail: finishReason,
        });
        return { text: "", tokensPerSecond: 0, finishReason };
      }
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
          ...(params.stopSequences !== undefined
            ? { stopSequences: params.stopSequences }
            : {}),
        }),
      )) {
        // Mid-stream deadline: keep prior deltas; drop current; abort Metal.
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

      if (
        controller.signal.aborted ||
        this.nowMs() - started > params.deadlineMs
      ) {
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
        `MlxSlmRuntime.${op} before successful load`,
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
    partial: Pick<MlxTelemetryEvent, "op" | "outcome"> &
      Partial<
        Pick<
          MlxTelemetryEvent,
          | "failureClass"
          | "obligationId"
          | "reason"
          | "deltaCount"
          | "detail"
          | "modelId"
          | "platform"
          | "arch"
        >
      >,
  ): void {
    const event: MlxTelemetryEvent = {
      event: "bindings_slm.mlx",
      modelId: partial.modelId ?? this.cardState.modelId,
      backendKind: this.backend.kind,
      ...partial,
    };
    const sid = this.options.subjectId?.trim();
    const did = this.options.deviceId?.trim();
    if (sid) event.subjectId = sid;
    if (did) event.deviceId = did;
    this.options.onTelemetry?.(event);
  }
}

/** Default bundled fixture path under macos/ (for docs / local smoke). */
export const MLX_APPLE_SILICON_FIXTURE_RELPATH =
  "macos/fixtures/apple-silicon-minimal.mlx";

export function mlxAppleSiliconFixturePath(): string {
  return path.join(PACKAGE_ROOT, MLX_APPLE_SILICON_FIXTURE_RELPATH);
}
