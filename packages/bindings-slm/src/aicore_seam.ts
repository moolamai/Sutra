/**
 * Android AICore system-model seam — capability probe + SlmRuntime shim.
 *
 * probe() is side-effect free and safe before load(). When AICore is absent
 * or has no compatible ready model, createAicoreSlmRuntimeCandidate returns
 * null or UnavailableSlmRuntime; planEdgeSlmRuntimeLoad tries the next
 * candidate without crash loops.
 *
 * Production Android hosts inject a MediaPipe / AICore native backend; CI uses
 * the in-process stand-in under android/aicore/ fixtures.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Relative fixture used by the in-process capable probe stand-in. */
export const AICORE_CAPABLE_FIXTURE_RELPATH =
  "android/aicore/fixtures/capable.capability.json";

export const AICORE_ABSENT_FIXTURE_RELPATH =
  "android/aicore/fixtures/absent.capability.json";

export const AICORE_DOWNLOADING_FIXTURE_RELPATH =
  "android/aicore/fixtures/downloading.capability.json";

export const AICORE_SCENARIOS_DIR_RELPATH = "android/aicore/scenarios";

export function aicoreCapableFixturePath(
  packageRoot: string = PACKAGE_ROOT,
): string {
  return path.join(packageRoot, AICORE_CAPABLE_FIXTURE_RELPATH);
}

export function aicoreAbsentFixturePath(
  packageRoot: string = PACKAGE_ROOT,
): string {
  return path.join(packageRoot, AICORE_ABSENT_FIXTURE_RELPATH);
}

export function aicoreDownloadingFixturePath(
  packageRoot: string = PACKAGE_ROOT,
): string {
  return path.join(packageRoot, AICORE_DOWNLOADING_FIXTURE_RELPATH);
}

export function aicoreScenarioPath(
  scenarioId: string,
  packageRoot: string = PACKAGE_ROOT,
): string {
  return path.join(
    packageRoot,
    AICORE_SCENARIOS_DIR_RELPATH,
    `${scenarioId}.json`,
  );
}

/**
 * Load a committed AICore capability JSON fixture (side-effect free).
 */
export function loadAicoreCapabilityFixture(
  fixturePath: string,
): AicoreCapability {
  if (!existsSync(fixturePath)) {
    throw new SlmRuntimeInitError(
      `AICore capability fixture missing at ${fixturePath}`,
      { failureClass: "missing_weights", reason: "missing" },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (err) {
    throw new SlmRuntimeInitError(
      `AICore capability fixture corrupt: ${err instanceof Error ? err.message : "parse"}`,
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new SlmRuntimeInitError("AICore capability fixture root must be an object", {
      failureClass: "corrupt_weights",
      reason: "corrupt",
    });
  }
  const cap = raw as AicoreCapability;
  if (typeof cap.aicorePresent !== "boolean") {
    throw new SlmRuntimeInitError(
      "AICore capability fixture missing aicorePresent",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (typeof cap.onDeviceGenerationAvailable !== "boolean") {
    throw new SlmRuntimeInitError(
      "AICore capability fixture missing onDeviceGenerationAvailable",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (!Array.isArray(cap.models)) {
    throw new SlmRuntimeInitError(
      "AICore capability fixture models must be an array",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  return structuredClone(cap);
}

/** Device integration scenario (capable / absent / downloading). */
export type AicoreDeviceScenario = {
  scenarioId: string;
  description?: string;
  capabilityFixtureRelpath: string;
  expectSelectedCandidateId: "aicore" | "onnx-mobile";
  expectOnDeviceGenerationAvailable: boolean;
  expectAbsenceReason?:
    | "aicore_absent"
    | "no_compatible_model"
    | "model_downloading"
    | "unsupported_platform";
};

export function loadAicoreDeviceScenario(
  scenarioPath: string,
  packageRoot: string = PACKAGE_ROOT,
): {
  scenario: AicoreDeviceScenario;
  capability: AicoreCapability;
  capabilityFixtureAbs: string;
} {
  if (!existsSync(scenarioPath)) {
    throw new SlmRuntimeInitError(
      `AICore device scenario missing at ${scenarioPath}`,
      { failureClass: "missing_weights", reason: "missing" },
    );
  }
  let scenario: AicoreDeviceScenario;
  try {
    scenario = JSON.parse(
      readFileSync(scenarioPath, "utf8"),
    ) as AicoreDeviceScenario;
  } catch (err) {
    throw new SlmRuntimeInitError(
      `AICore device scenario corrupt: ${err instanceof Error ? err.message : "parse"}`,
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  if (!scenario.scenarioId?.trim() || !scenario.capabilityFixtureRelpath?.trim()) {
    throw new SlmRuntimeInitError(
      "AICore device scenario requires scenarioId and capabilityFixtureRelpath",
      { failureClass: "corrupt_weights", reason: "corrupt" },
    );
  }
  const capabilityFixtureAbs = path.join(
    packageRoot,
    scenario.capabilityFixtureRelpath,
  );
  const capability = loadAicoreCapabilityFixture(capabilityFixtureAbs);
  return { scenario, capability, capabilityFixtureAbs };
}

export type AicoreMemoryClass = "absent" | "low" | "mid" | "high";

export type AicoreModelReadiness = "ready" | "downloading" | "unavailable";

/** One system model advertised by AICore / MediaPipe LLM Inference. */
export type AicoreModelDescriptor = {
  modelId: string;
  contextWindow: number;
  memoryClass: Exclude<AicoreMemoryClass, "absent">;
  memoryFootprintMiB: number;
  quantization: string;
  languages: string[];
  embedDim: number;
  readiness: AicoreModelReadiness;
};

/**
 * Truthful capability surface from probe() — never assumes generation works.
 */
export type AicoreCapability = {
  /** AICore / MediaPipe LLM API present on this device. */
  aicorePresent: boolean;
  /** Compatible model ready for on-device generate/embed now. */
  onDeviceGenerationAvailable: boolean;
  /** Device / selected-model memory class (truthful for load planners). */
  memoryClass: AicoreMemoryClass;
  /** System model ids + context limits (empty when absent). */
  models: AicoreModelDescriptor[];
  /** Typed absence — hosts select another SlmRuntime candidate. */
  absenceReason?:
    | "aicore_absent"
    | "no_compatible_model"
    | "model_downloading"
    | "unsupported_platform";
  detail?: string;
};

export type AicoreHostProbe = {
  platform: string;
  /** Android API level when known; omitted on non-Android CI hosts. */
  apiLevel?: number;
};

export type AicoreNativeHandle = { readonly id: string };

export type AicoreGenerateNativeParams = {
  prompt: string;
  maxTokens: number;
  temperature: number;
  deadlineMs: number;
  signal?: AbortSignal;
  nowMs?: () => number;
  stopSequences?: string[];
};

export type AicoreGenerateNativeResult = {
  text: string;
  tokensEmitted: number;
  deadlineHit: boolean;
};

/**
 * Injectable AICore / MediaPipe backend. `probe` MUST be side-effect free
 * (no weight download, no session materialization).
 */
export interface AicoreNativeBackend {
  readonly kind: "in-process" | "aicore-mediapipe" | "ffi";
  probe(host: AicoreHostProbe): Promise<AicoreCapability>;
  load(model: AicoreModelDescriptor): Promise<{
    handle: AicoreNativeHandle;
    embedDim: number;
    card: SlmModelCard;
  }>;
  unload(handle: AicoreNativeHandle): Promise<void>;
  generate(
    handle: AicoreNativeHandle,
    params: AicoreGenerateNativeParams,
  ): Promise<AicoreGenerateNativeResult>;
  generateStream(
    handle: AicoreNativeHandle,
    params: AicoreGenerateNativeParams,
  ): AsyncIterable<string>;
  embed(handle: AicoreNativeHandle, text: string): Promise<Float32Array>;
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

export function mapAicoreFinishReason(input: {
  deadlineHit: boolean;
  signalAborted: boolean;
  elapsedMs: number;
  deadlineMs: number;
  tokensEmitted: number;
  maxTokens: number;
}): SlmGenerateResult["finishReason"] {
  if (input.deadlineHit || input.elapsedMs > input.deadlineMs) {
    return "deadline";
  }
  if (input.signalAborted) return "aborted";
  if (input.tokensEmitted >= input.maxTokens) return "length";
  return "stop";
}

function buildAicoreText(params: AicoreGenerateNativeParams): string {
  const max = Math.max(1, Math.min(params.maxTokens, 64));
  return `aicore:${params.prompt.length}:${max}`;
}

const CAPABLE_MODEL: AicoreModelDescriptor = {
  modelId: "gemini-nano-aicore",
  contextWindow: 4096,
  memoryClass: "mid",
  memoryFootprintMiB: 768,
  quantization: "int4-system",
  languages: ["en-IN", "hi-IN", "en"],
  embedDim: 8,
  readiness: "ready",
};

/**
 * Build a capability snapshot from an injectable model list (tests / Kotlin parity).
 */
export function buildAicoreCapability(input: {
  aicorePresent: boolean;
  models?: AicoreModelDescriptor[];
  unsupportedPlatform?: boolean;
  detail?: string;
}): AicoreCapability {
  if (input.unsupportedPlatform) {
    return {
      aicorePresent: false,
      onDeviceGenerationAvailable: false,
      memoryClass: "absent",
      models: [],
      absenceReason: "unsupported_platform",
      detail: input.detail ?? "AICore requires Android",
    };
  }
  if (!input.aicorePresent) {
    return {
      aicorePresent: false,
      onDeviceGenerationAvailable: false,
      memoryClass: "absent",
      models: [],
      absenceReason: "aicore_absent",
      detail: input.detail ?? "AICore / MediaPipe LLM API not present",
    };
  }
  const models = input.models ?? [];
  const ready = models.filter((m) => m.readiness === "ready");
  if (ready.length === 0) {
    const downloading = models.some((m) => m.readiness === "downloading");
    return {
      aicorePresent: true,
      onDeviceGenerationAvailable: false,
      memoryClass: models[0]?.memoryClass ?? "absent",
      models: [...models],
      absenceReason: downloading ? "model_downloading" : "no_compatible_model",
      detail:
        input.detail ??
        (downloading
          ? "AICore model still downloading"
          : "no compatible on-device model"),
    };
  }
  const primary = ready[0]!;
  return {
    aicorePresent: true,
    onDeviceGenerationAvailable: true,
    memoryClass: primary.memoryClass,
    models: [...models],
  };
}

/**
 * In-process MediaPipe/AICore stand-in for CI. Probe is side-effect free.
 */
export function createInProcessAicoreBackend(
  opts: {
    /** Override probe snapshot (absence / downloading / capable). */
    capability?: AicoreCapability;
    streamChunkChars?: number;
    /** Force embed length drift after load (tests). */
    embedDimOverride?: number;
  } = {},
): AicoreNativeBackend {
  const streamChunkChars = opts.streamChunkChars ?? 2;
  const loaded = new Map<
    string,
    { model: AicoreModelDescriptor; embedDim: number }
  >();
  let seq = 0;

  const defaultCapability = buildAicoreCapability({
    aicorePresent: true,
    models: [CAPABLE_MODEL],
  });

  return {
    kind: "in-process",

    async probe(_host) {
      return opts.capability
        ? structuredClone(opts.capability)
        : structuredClone(defaultCapability);
    },

    async load(model) {
      if (model.readiness === "downloading") {
        throw new SlmRuntimeInitError(
          `not_ready: AICore model ${model.modelId} still downloading`,
          { failureClass: "config", reason: "config" },
        );
      }
      if (model.readiness !== "ready") {
        throw new SlmRuntimeInitError(
          `no_compatible_model: ${model.modelId} readiness=${model.readiness}`,
          { failureClass: "config", reason: "config" },
        );
      }
      const embedDim = opts.embedDimOverride ?? model.embedDim;
      const id = `aicore-h-${++seq}`;
      loaded.set(id, { model, embedDim });
      return {
        handle: { id },
        embedDim,
        card: {
          modelId: model.modelId,
          contextWindow: model.contextWindow,
          quantization: model.quantization,
          memoryFootprintMiB: model.memoryFootprintMiB,
          languages: [...model.languages],
        },
      };
    },

    async unload(handle) {
      loaded.delete(handle.id);
    },

    async generate(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("aicore generate on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (isAborted(params.signal)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }
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
          return {
            text: "",
            tokensEmitted: 0,
            deadlineHit: deadlineBreached(started, params.deadlineMs, now),
          };
        }
      }
      if (deadlineBreached(started, params.deadlineMs, now)) {
        return { text: "", tokensEmitted: 0, deadlineHit: true };
      }
      const text = buildAicoreText(params);
      const tokensEmitted = Math.max(1, Math.min(params.maxTokens, 64) - 1);
      return { text, tokensEmitted, deadlineHit: false };
    },

    async *generateStream(handle, params) {
      if (!loaded.has(handle.id)) {
        throw new Error("aicore generateStream on unloaded handle");
      }
      const now = params.nowMs ?? (() => Date.now());
      const started = now();
      if (
        isAborted(params.signal) ||
        deadlineBreached(started, params.deadlineMs, now)
      ) {
        return;
      }
      const full = buildAicoreText(params);
      const step = Math.max(1, streamChunkChars);
      for (let i = 0; i < full.length; i += step) {
        if (
          isAborted(params.signal) ||
          deadlineBreached(started, params.deadlineMs, now)
        ) {
          return;
        }
        yield full.slice(i, i + step);
      }
    },

    async embed(handle, text) {
      const entry = loaded.get(handle.id);
      if (!entry) throw new Error("aicore embed on unloaded handle");
      const out = new Float32Array(entry.embedDim);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) >>> 0;
      for (let i = 0; i < out.length; i++) out[i] = ((h + i * 11) % 1009) / 1009;
      return out;
    },
  };
}

/**
 * In-process backend whose probe() returns a committed capability fixture.
 */
export function createInProcessAicoreBackendFromFixture(
  fixturePath: string,
  opts: { streamChunkChars?: number; embedDimOverride?: number } = {},
): AicoreNativeBackend {
  const capability = loadAicoreCapabilityFixture(fixturePath);
  return createInProcessAicoreBackend({
    capability,
    ...(opts.streamChunkChars !== undefined
      ? { streamChunkChars: opts.streamChunkChars }
      : {}),
    ...(opts.embedDimOverride !== undefined
      ? { embedDimOverride: opts.embedDimOverride }
      : {}),
  });
}

export type AicoreSlmRuntimeOptions = {
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: AicoreTelemetryEvent) => void;
  backend?: AicoreNativeBackend;
  nowMs?: () => number;
  /**
   * Host probe for platform truth. Non-Android → unsupported_platform absence
   * unless an injectable backend overrides probe().
   */
  hostProbe?: AicoreHostProbe;
  /**
   * Pin expected system modelId. OEM updates that change modelId → load reject
   * (embed graph / card mismatch), never silent dimension drift.
   */
  expectedModelId?: string;
  /** Pin expected embed dimension; mismatch at load is a hard error. */
  expectedEmbedDim?: number;
};

export type AicoreTelemetryOp =
  | "probe"
  | "load"
  | "unload"
  | "generate"
  | "generateStream"
  | "embed";

export type AicoreTelemetryEvent = {
  event: "bindings_slm.aicore";
  op: AicoreTelemetryOp;
  outcome:
    | "ok"
    | "init_error"
    | "deadline"
    | "absent"
    | "not_ready";
  modelId: string;
  subjectId?: string;
  deviceId?: string;
  backendKind: AicoreNativeBackend["kind"];
  aicorePresent?: boolean;
  onDeviceGenerationAvailable?: boolean;
  memoryClass?: AicoreMemoryClass;
  absenceReason?: AicoreCapability["absenceReason"];
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

/**
 * Side-effect-free capability probe (safe before any load()).
 */
export async function probeAicoreCapability(
  options: {
    backend?: AicoreNativeBackend;
    hostProbe?: AicoreHostProbe;
  } = {},
): Promise<AicoreCapability> {
  const host = options.hostProbe ?? defaultHostProbe();
  const backend = options.backend ?? createInProcessAicoreBackend();

  if (host.platform !== "android" && backend.kind === "aicore-mediapipe") {
    return buildAicoreCapability({
      aicorePresent: false,
      unsupportedPlatform: true,
      detail: `AICore requires Android (got ${host.platform})`,
    });
  }

  return backend.probe(host);
}

function defaultHostProbe(): AicoreHostProbe {
  // Node CI is never Android; tests inject hostProbe: { platform: "android" }.
  return {
    platform: process.platform === "android" ? "android" : process.platform,
  };
}

/**
 * SlmRuntime shim over Android AICore. Call probe() before load(); load()
 * binds a ready system model or throws typed absence / not_ready.
 */
export class AicoreSlmRuntime implements SlmRuntime {
  private loaded = false;
  private loadAttempts = 0;
  private handle: AicoreNativeHandle | null = null;
  private embedDim: number | null = null;
  private cardState: SlmModelCard = { ...PLACEHOLDER_CARD };
  private lastCapability: AicoreCapability | null = null;
  private readonly backend: AicoreNativeBackend;
  private readonly nowMs: () => number;
  private activeAbort: AbortController | null = null;

  constructor(private readonly options: AicoreSlmRuntimeOptions = {}) {
    this.backend = options.backend ?? createInProcessAicoreBackend();
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

  get lastProbe(): AicoreCapability | null {
    return this.lastCapability;
  }

  /**
   * Side-effect free. Declares system model ids, context limits, memory class,
   * and whether on-device generation is available.
   */
  async probe(): Promise<AicoreCapability> {
    const capability = await probeAicoreCapability({
      backend: this.backend,
      hostProbe: this.options.hostProbe ?? defaultHostProbe(),
    });
    this.lastCapability = capability;
    this.emit({
      op: "probe",
      outcome: capability.onDeviceGenerationAvailable
        ? "ok"
        : capability.absenceReason === "model_downloading"
          ? "not_ready"
          : "absent",
      aicorePresent: capability.aicorePresent,
      onDeviceGenerationAvailable: capability.onDeviceGenerationAvailable,
      memoryClass: capability.memoryClass,
      ...(capability.absenceReason
        ? { absenceReason: capability.absenceReason }
        : {}),
      ...(capability.detail ? { detail: capability.detail } : {}),
      modelId: capability.models[0]?.modelId ?? "none",
    });
    return capability;
  }

  async load(): Promise<void> {
    this.loadAttempts += 1;
    if (this.loaded) {
      this.emit({ op: "load", outcome: "ok" });
      return;
    }

    const capability = await this.probe();

    if (!capability.aicorePresent) {
      throw this.failLoad(
        "config",
        `aicore_absent: ${capability.detail ?? "AICore not present"}`,
        {
          outcome: "absent",
          detail: capability.absenceReason ?? "aicore_absent",
        },
      );
    }

    if (capability.absenceReason === "model_downloading") {
      throw this.failLoad(
        "config",
        `not_ready: ${capability.detail ?? "model still downloading"}`,
        {
          outcome: "not_ready",
          ...(capability.models[0]?.modelId
            ? { modelId: capability.models[0].modelId }
            : {}),
        },
      );
    }

    const ready = capability.models.filter((m) => m.readiness === "ready");
    if (!capability.onDeviceGenerationAvailable || ready.length === 0) {
      throw this.failLoad(
        "config",
        `no_compatible_model: ${capability.detail ?? "no ready system model"}`,
        {
          outcome: "absent",
          detail: capability.absenceReason ?? "no_compatible_model",
        },
      );
    }

    let model = ready[0]!;
    if (this.options.expectedModelId) {
      const pinned = ready.find(
        (m) => m.modelId === this.options.expectedModelId,
      );
      if (!pinned) {
        throw this.failLoad(
          "config",
          `modelId mismatch: expected ${this.options.expectedModelId} got [${ready.map((m) => m.modelId).join(",")}]`,
          {
            modelId: model.modelId,
            detail: "oem_model_update",
          },
        );
      }
      model = pinned;
    }

    let bound: {
      handle: AicoreNativeHandle;
      embedDim: number;
      card: SlmModelCard;
    };
    try {
      bound = await this.backend.load(model);
    } catch (err) {
      if (err instanceof SlmRuntimeInitError) {
        const notReady = /not_ready/i.test(err.message);
        this.emit({
          op: "load",
          outcome: notReady ? "not_ready" : "init_error",
          failureClass: err.failureClass,
          obligationId: err.obligationId,
          reason: err.reason,
          modelId: model.modelId,
          detail: err.message,
        });
        throw err;
      }
      throw this.failLoad(
        "corrupt",
        `AICore load failed: ${err instanceof Error ? err.message : "unknown"}`,
        { modelId: model.modelId },
      );
    }

    if (
      !Number.isFinite(bound.embedDim) ||
      bound.embedDim <= 0 ||
      !Number.isInteger(bound.embedDim)
    ) {
      await this.backend.unload(bound.handle).catch(() => undefined);
      throw this.failLoad("config", "native embed dimension invalid", {
        modelId: model.modelId,
      });
    }

    if (
      this.options.expectedEmbedDim !== undefined &&
      bound.embedDim !== this.options.expectedEmbedDim
    ) {
      await this.backend.unload(bound.handle).catch(() => undefined);
      throw this.failLoad(
        "config",
        `embed dimension mismatch: expected ${this.options.expectedEmbedDim} got ${bound.embedDim}`,
        { modelId: model.modelId, detail: "oem_embed_drift" },
      );
    }

    if (bound.embedDim !== model.embedDim) {
      await this.backend.unload(bound.handle).catch(() => undefined);
      throw this.failLoad(
        "config",
        `embed dimension probe rejected: card=${model.embedDim} native=${bound.embedDim}`,
        { modelId: model.modelId },
      );
    }

    this.handle = bound.handle;
    this.embedDim = bound.embedDim;
    this.cardState = { ...bound.card };
    this.loaded = true;
    this.emit({
      op: "load",
      outcome: "ok",
      modelId: bound.card.modelId,
      memoryClass: model.memoryClass,
      aicorePresent: true,
      onDeviceGenerationAvailable: true,
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
      const finishReason = mapAicoreFinishReason({
        deadlineHit: native.deadlineHit,
        signalAborted: controller.signal.aborted,
        elapsedMs: elapsed,
        deadlineMs: params.deadlineMs,
        tokensEmitted: native.tokensEmitted,
        maxTokens: params.maxTokens,
      });
      if (finishReason === "deadline" || finishReason === "aborted") {
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
        `AicoreSlmRuntime.${op} before successful load`,
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
    opts: {
      modelId?: string;
      skipEmit?: boolean;
      outcome?: AicoreTelemetryEvent["outcome"];
      detail?: string;
    } = {},
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
        outcome: opts.outcome ?? "init_error",
        failureClass,
        obligationId: EDGE_SLM_LOAD_OBLIGATION,
        reason,
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        detail: opts.detail ?? message,
      });
    }
    return error;
  }

  private emit(
    partial: Omit<AicoreTelemetryEvent, "event" | "backendKind" | "modelId"> & {
      modelId?: string;
    },
  ): void {
    const event: AicoreTelemetryEvent = {
      event: "bindings_slm.aicore",
      backendKind: this.backend.kind,
      modelId: partial.modelId ?? this.cardState.modelId,
      op: partial.op,
      outcome: partial.outcome,
      ...(this.options.subjectId !== undefined
        ? { subjectId: this.options.subjectId }
        : {}),
      ...(this.options.deviceId !== undefined
        ? { deviceId: this.options.deviceId }
        : {}),
      ...(partial.aicorePresent !== undefined
        ? { aicorePresent: partial.aicorePresent }
        : {}),
      ...(partial.onDeviceGenerationAvailable !== undefined
        ? {
            onDeviceGenerationAvailable: partial.onDeviceGenerationAvailable,
          }
        : {}),
      ...(partial.memoryClass !== undefined
        ? { memoryClass: partial.memoryClass }
        : {}),
      ...(partial.absenceReason !== undefined
        ? { absenceReason: partial.absenceReason }
        : {}),
      ...(partial.failureClass !== undefined
        ? { failureClass: partial.failureClass }
        : {}),
      ...(partial.obligationId !== undefined
        ? { obligationId: partial.obligationId }
        : {}),
      ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
      ...(partial.deltaCount !== undefined
        ? { deltaCount: partial.deltaCount }
        : {}),
      ...(partial.detail !== undefined ? { detail: partial.detail } : {}),
    };
    this.options.onTelemetry?.(event);
  }
}

/** Card for typed unavailable stand-in (never materializes weights). */
export const UNAVAILABLE_SLM_CARD: SlmModelCard = {
  modelId: "unavailable",
  contextWindow: 1,
  quantization: "none",
  memoryFootprintMiB: 1,
  languages: ["en"],
};

export type UnavailableSlmRuntimeOptions = {
  capability: AicoreCapability;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (event: AicoreTelemetryEvent) => void;
  /** Override card.modelId (defaults to unavailable / first probed model). */
  modelId?: string;
};

/**
 * Typed absence stand-in. Hosts / load planners detect this and try the next
 * SlmRuntime candidate — never crash-loop on generate().
 */
export class UnavailableSlmRuntime implements SlmRuntime {
  readonly kind = "unavailable" as const;
  readonly capability: AicoreCapability;
  readonly card: SlmModelCard;
  private loadAttempts = 0;

  constructor(private readonly options: UnavailableSlmRuntimeOptions) {
    this.capability = options.capability;
    this.card = {
      ...UNAVAILABLE_SLM_CARD,
      modelId:
        options.modelId ??
        options.capability.models[0]?.modelId ??
        UNAVAILABLE_SLM_CARD.modelId,
      memoryFootprintMiB:
        options.capability.models[0]?.memoryFootprintMiB ?? 1,
    };
  }

  get loadAttemptCount(): number {
    return this.loadAttempts;
  }

  get isLoaded(): boolean {
    return false;
  }

  get absenceReason(): AicoreCapability["absenceReason"] {
    return (
      this.capability.absenceReason ??
      (this.capability.aicorePresent
        ? "no_compatible_model"
        : "aicore_absent")
    );
  }

  async load(): Promise<void> {
    this.loadAttempts += 1;
    const reason = this.absenceReason ?? "aicore_absent";
    const message =
      reason === "model_downloading"
        ? `not_ready: ${this.capability.detail ?? "model still downloading"}`
        : `${reason}: ${this.capability.detail ?? "AICore unavailable"}`;
    const error = new SlmRuntimeInitError(message, {
      failureClass: "config",
      reason: "config",
    });
    this.options.onTelemetry?.({
      event: "bindings_slm.aicore",
      op: "load",
      outcome: reason === "model_downloading" ? "not_ready" : "absent",
      modelId: this.card.modelId,
      backendKind: "in-process",
      aicorePresent: this.capability.aicorePresent,
      onDeviceGenerationAvailable: false,
      memoryClass: this.capability.memoryClass,
      absenceReason: reason,
      failureClass: "config",
      obligationId: EDGE_SLM_LOAD_OBLIGATION,
      reason: "config",
      detail: message,
      ...(this.options.subjectId !== undefined
        ? { subjectId: this.options.subjectId }
        : {}),
      ...(this.options.deviceId !== undefined
        ? { deviceId: this.options.deviceId }
        : {}),
    });
    throw error;
  }

  async unload(): Promise<void> {
    // No-op — never materializes.
  }

  async generate(_params: SlmGenerateParams): Promise<SlmGenerateResult> {
    throw new SlmRuntimeInitError(
      "UnavailableSlmRuntime.generate: no on-device model (select another candidate)",
      { failureClass: "config", reason: "config" },
    );
  }

  async *generateStream(
    _params: SlmGenerateParams,
  ): AsyncIterable<string> {
    throw new SlmRuntimeInitError(
      "UnavailableSlmRuntime.generateStream: no on-device model (select another candidate)",
      { failureClass: "config", reason: "config" },
    );
  }

  async embed(_text: string): Promise<Float32Array> {
    throw new SlmRuntimeInitError(
      "UnavailableSlmRuntime.embed: no on-device model (select another candidate)",
      { failureClass: "config", reason: "config" },
    );
  }
}

export function isUnavailableSlmRuntime(
  runtime: SlmRuntime,
): runtime is UnavailableSlmRuntime {
  return (
    runtime instanceof UnavailableSlmRuntime ||
    (typeof runtime === "object" &&
      runtime !== null &&
      "kind" in runtime &&
      (runtime as { kind?: string }).kind === "unavailable")
  );
}

export type CreateAicoreCandidateOptions = AicoreSlmRuntimeOptions & {
  /**
   * When probe reports absent / not ready:
   * - `null` (default) — factory returns null
   * - `unavailable` — factory returns typed UnavailableSlmRuntime
   */
  onAbsent?: "null" | "unavailable";
};

/**
 * Probe then construct an AICore candidate. Does not load weights.
 * Absent / downloading / no compatible model → null or UnavailableSlmRuntime.
 */
export async function createAicoreSlmRuntimeCandidate(
  options: CreateAicoreCandidateOptions = {},
): Promise<AicoreSlmRuntime | UnavailableSlmRuntime | null> {
  const onAbsent = options.onAbsent ?? "null";
  const runtime = new AicoreSlmRuntime(options);
  const capability = await runtime.probe();

  if (capability.onDeviceGenerationAvailable) {
    return runtime;
  }

  if (onAbsent === "null") {
    return null;
  }

  return new UnavailableSlmRuntime({
    capability,
    ...(options.subjectId !== undefined ? { subjectId: options.subjectId } : {}),
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

export type EdgeSlmCandidate = {
  /** Stable id for observability (e.g. aicore, onnx-mobile). */
  id: string;
  /**
   * Produce a runtime, null (skip), or UnavailableSlmRuntime (skip).
   * MUST NOT hang; bounded work only.
   */
  create: () => Promise<SlmRuntime | null>;
};

export type EdgeSlmLoadSkipReason =
  | "null"
  | "unavailable"
  | "absent"
  | "not_ready"
  | "load_error";

export type EdgeSlmLoadSkip = {
  candidateId: string;
  reason: EdgeSlmLoadSkipReason;
  detail?: string;
};

export type EdgeSlmLoadPlan = {
  runtime: SlmRuntime;
  selectedCandidateId: string;
  skipped: EdgeSlmLoadSkip[];
};

export type EdgeSlmLoadPlanTelemetry = {
  event: "bindings_slm.slm_load_plan";
  op: "plan" | "try_candidate" | "skip" | "selected" | "exhausted";
  outcome: "ok" | "skip" | "fail";
  subjectId?: string;
  deviceId?: string;
  candidateId?: string;
  selectedCandidateId?: string;
  skipReason?: EdgeSlmLoadSkipReason;
  skippedCount?: number;
  detail?: string;
};

export class EdgeSlmLoadPlanError extends Error {
  override readonly name = "EdgeSlmLoadPlanError";
  readonly obligationId = EDGE_SLM_LOAD_OBLIGATION;
  readonly failureClass = "config" as const;
  readonly skipped: EdgeSlmLoadSkip[];

  constructor(message: string, skipped: EdgeSlmLoadSkip[]) {
    super(message);
    this.skipped = skipped;
  }
}

export type PlanEdgeSlmRuntimeLoadOptions = {
  subjectId?: string;
  deviceId?: string;
  /** Hard cap on candidates tried (default: candidates.length). */
  maxCandidates?: number;
  onTelemetry?: (event: EdgeSlmLoadPlanTelemetry) => void;
  /**
   * When true (default), call load() on a selected non-unavailable runtime.
   * Load failures that look like absence/not-ready skip to the next candidate.
   */
  loadSelected?: boolean;
};

function classifyLoadFailure(err: unknown): EdgeSlmLoadSkipReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not_ready/i.test(msg)) return "not_ready";
  if (
    /aicore_absent|no_compatible_model|unavailable|unsupported_platform/i.test(
      msg,
    )
  ) {
    return "absent";
  }
  return "load_error";
}

/**
 * Edge harness load planner: try candidates in order until one binds.
 * Null / UnavailableSlmRuntime / typed absence load errors → skip next.
 * Never retries unboundedly; never crash-loops on a single candidate.
 */
export async function planEdgeSlmRuntimeLoad(
  candidates: readonly EdgeSlmCandidate[],
  options: PlanEdgeSlmRuntimeLoadOptions = {},
): Promise<EdgeSlmLoadPlan> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new EdgeSlmLoadPlanError("planEdgeSlmRuntimeLoad requires candidates", []);
  }

  const max = Math.min(
    candidates.length,
    Math.max(1, options.maxCandidates ?? candidates.length),
  );
  const skipped: EdgeSlmLoadSkip[] = [];
  const loadSelected = options.loadSelected !== false;

  const emit = (
    partial: Omit<EdgeSlmLoadPlanTelemetry, "event"> &
      Partial<Pick<EdgeSlmLoadPlanTelemetry, "event">>,
  ): void => {
    options.onTelemetry?.({
      event: "bindings_slm.slm_load_plan",
      ...partial,
      ...(options.subjectId !== undefined
        ? { subjectId: options.subjectId }
        : {}),
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
  };

  emit({ op: "plan", outcome: "ok", skippedCount: 0 });

  for (let i = 0; i < max; i++) {
    const candidate = candidates[i]!;
    emit({
      op: "try_candidate",
      outcome: "ok",
      candidateId: candidate.id,
    });

    let runtime: SlmRuntime | null;
    try {
      runtime = await candidate.create();
    } catch (err) {
      const reason = classifyLoadFailure(err);
      const detail = err instanceof Error ? err.message : String(err);
      skipped.push({ candidateId: candidate.id, reason, detail });
      emit({
        op: "skip",
        outcome: "skip",
        candidateId: candidate.id,
        skipReason: reason,
        detail,
        skippedCount: skipped.length,
      });
      continue;
    }

    if (runtime === null) {
      skipped.push({ candidateId: candidate.id, reason: "null" });
      emit({
        op: "skip",
        outcome: "skip",
        candidateId: candidate.id,
        skipReason: "null",
        skippedCount: skipped.length,
      });
      continue;
    }

    if (isUnavailableSlmRuntime(runtime)) {
      const detail =
        runtime.capability.detail ??
        runtime.absenceReason ??
        "unavailable";
      skipped.push({
        candidateId: candidate.id,
        reason: "unavailable",
        detail,
      });
      emit({
        op: "skip",
        outcome: "skip",
        candidateId: candidate.id,
        skipReason: "unavailable",
        detail,
        skippedCount: skipped.length,
      });
      continue;
    }

    if (loadSelected) {
      try {
        await runtime.load();
      } catch (err) {
        const reason = classifyLoadFailure(err);
        const detail = err instanceof Error ? err.message : String(err);
        // Only soft-skip absence / not-ready; hard load_error also skips so
        // the planner can try the next engine (no crash loop on one candidate).
        skipped.push({ candidateId: candidate.id, reason, detail });
        emit({
          op: "skip",
          outcome: "skip",
          candidateId: candidate.id,
          skipReason: reason,
          detail,
          skippedCount: skipped.length,
        });
        try {
          await runtime.unload();
        } catch {
          // ignore unload after failed load
        }
        continue;
      }
    }

    emit({
      op: "selected",
      outcome: "ok",
      candidateId: candidate.id,
      selectedCandidateId: candidate.id,
      skippedCount: skipped.length,
    });
    return {
      runtime,
      selectedCandidateId: candidate.id,
      skipped: [...skipped],
    };
  }

  emit({
    op: "exhausted",
    outcome: "fail",
    skippedCount: skipped.length,
    detail: `no SlmRuntime candidate bound after ${max} attempt(s)`,
  });
  throw new EdgeSlmLoadPlanError(
    `no SlmRuntime candidate bound after ${max} attempt(s)`,
    skipped,
  );
}
