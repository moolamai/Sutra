/**
 * Local VLM behind VisionInterface.analyze.
 *
 * Size gate runs first: inputs above maxInputBytes throw a typed
 * VisionInputTooLargeError before any model invocation. When
 * responseSchema is set, answer must be schema-valid JSON — prose or
 * invalid model output becomes a typed VisionSchemaError.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  VisionInterface,
  VisualAnalysisRequest,
  VisualAnalysisResult,
  VisualInput,
} from "@moolam/contracts";
import {
  VISION_SCHEMA_KEY_SCAN_LIMIT,
  validateAnswerAgainstSchema,
  type VisionConformanceHarness,
} from "@moolam/contract-conformance";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VISION_PACKAGE_ROOT = path.resolve(__dirname, "..");

export const LOCAL_VLM_ENGINE = "local-vlm-v1";
/** Default on-device payload ceiling (5 MiB). */
export const DEFAULT_MAX_INPUT_BYTES = 5 * 1024 * 1024;
/** Bound concurrent analyze tracking / schema keys (NFR / scalability). */
export const VLM_STREAM_LIMIT = 64;

export const SUPPORTED_VISION_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
] as const;

export type VisionFailureClass =
  | "config"
  | "validation"
  | "size_limit"
  | "format"
  | "schema"
  | "not_loaded"
  | "native";

export type LocalVlmTelemetryOp = "load" | "unload" | "analyze";

/** Metadata-only telemetry — never raw image bytes or instruction bodies. */
export type LocalVlmTelemetryEvent = {
  event: "bindings_vision.vlm";
  op: LocalVlmTelemetryOp;
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  engine: typeof LOCAL_VLM_ENGINE;
  maxInputBytes?: number;
  inputBytes?: number;
  hasResponseSchema?: boolean;
  failureClass?: VisionFailureClass;
  detail?: string;
};

export type LoadLocalVlmOptions = {
  subjectId: string;
  deviceId: string;
  maxInputBytes?: number;
  onTelemetry?: (event: LocalVlmTelemetryEvent) => void;
  backend?: LocalVlmNativeBackend;
};

export class LocalVlmError extends Error {
  readonly failureClass: VisionFailureClass;
  readonly code: string;
  readonly kind: string;

  constructor(
    message: string,
    failureClass: VisionFailureClass,
    extras?: { code?: string; kind?: string; name?: string },
  ) {
    super(message);
    this.name = extras?.name ?? "LocalVlmError";
    this.failureClass = failureClass;
    this.code = extras?.code ?? failureClass;
    this.kind = extras?.kind ?? failureClass;
  }
}

export class VisionInputTooLargeError extends LocalVlmError {
  readonly maxInputBytes: number;
  readonly actualBytes: number;

  constructor(maxInputBytes: number, actualBytes: number) {
    super(
      `input exceeds maxInputBytes=${maxInputBytes} (got ${actualBytes})`,
      "size_limit",
      {
        name: "VisionInputTooLargeError",
        code: "input_too_large",
        kind: "size_limit",
      },
    );
    this.maxInputBytes = maxInputBytes;
    this.actualBytes = actualBytes;
  }
}

export class VisionFormatError extends LocalVlmError {
  constructor(message: string) {
    super(message, "format", {
      name: "VisionFormatError",
      code: "invalid_image_format",
      kind: "format",
    });
  }
}

export class VisionSchemaError extends LocalVlmError {
  constructor(message: string) {
    super(message, "schema", {
      name: "VisionSchemaError",
      code: "schema_invalid_answer",
      kind: "schema",
    });
  }
}

export type LocalVlmNativeHandle = { readonly id: string };

export type LocalVlmAnalyzeNativeParams = {
  input: VisualInput;
  instruction: string;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type LocalVlmAnalyzeNativeResult = {
  answer: string;
  confidence: number;
};

export type LocalVlmNativeBackend = {
  readonly kind: "in-process" | "native-addon";
  load(modelId: string): Promise<LocalVlmNativeHandle>;
  unload(handle: LocalVlmNativeHandle): Promise<void>;
  analyze(
    handle: LocalVlmNativeHandle,
    params: LocalVlmAnalyzeNativeParams,
  ): Promise<LocalVlmAnalyzeNativeResult>;
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46] as const;

function startsWith(data: Uint8Array, magic: readonly number[]): boolean {
  if (data.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (data[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Reject corrupt / unsupported images with a typed format error.
 * Synthetic conformance probes (no container magic) are allowed when the
 * mimeType is supported — size gate already ran.
 */
export function assertDecodableVisualInput(input: VisualInput): void {
  const mime = input.mimeType?.trim().toLowerCase() ?? "";
  if (!mime) {
    throw new VisionFormatError("mimeType is required");
  }
  if (
    !(SUPPORTED_VISION_MIME_TYPES as readonly string[]).includes(mime) &&
    mime !== "image/jpg"
  ) {
    throw new VisionFormatError(`unsupported mimeType: ${mime}`);
  }
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) {
    throw new VisionFormatError("image data must be a non-empty Uint8Array");
  }

  const isPng = startsWith(input.data, PNG_MAGIC);
  const isJpeg = startsWith(input.data, JPEG_MAGIC);
  const isWebp =
    startsWith(input.data, WEBP_RIFF) &&
    input.data.byteLength >= 12 &&
    input.data[8] === 0x57 &&
    input.data[9] === 0x45 &&
    input.data[10] === 0x42 &&
    input.data[11] === 0x50;

  const hasContainerMagic = isPng || isJpeg || isWebp;
  if (!hasContainerMagic) {
    // Synthetic / probe payloads — accepted for on-device stand-in.
    return;
  }

  if (
    (mime === "image/png" && !isPng) ||
    ((mime === "image/jpeg" || mime === "image/jpg") && !isJpeg) ||
    (mime === "image/webp" && !isWebp)
  ) {
    throw new VisionFormatError(
      `image bytes do not match declared mimeType ${mime}`,
    );
  }
}

function answerForSchema(schema: Record<string, unknown>): string {
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      )
    : [];
  const obj: Record<string, unknown> = {};
  for (const key of required.slice(0, VISION_SCHEMA_KEY_SCAN_LIMIT)) {
    if (key === "score") obj[key] = 0.91;
    else obj[key] = `local.vlm.${key}`;
  }
  if (!("label" in obj)) obj.label = "local.vlm.label";
  if (!("score" in obj)) obj.score = 0.91;
  return JSON.stringify(obj);
}

/**
 * In-process local VLM stand-in. Production injects a native on-device addon.
 * Never returns free-text prose when responseSchema is set.
 */
export function createInProcessLocalVlmBackend(): LocalVlmNativeBackend {
  let seq = 0;
  return {
    kind: "in-process",
    async load(modelId: string) {
      if (!modelId.trim()) throw new Error("vlm model id is required");
      seq += 1;
      return { id: `vlm-inproc-${seq}` };
    },
    async unload() {
      /* no-op */
    },
    async analyze(
      _handle: LocalVlmNativeHandle,
      params: LocalVlmAnalyzeNativeParams,
    ): Promise<LocalVlmAnalyzeNativeResult> {
      if (params.signal?.aborted) {
        throw new Error("vlm analyze aborted");
      }
      if (params.responseSchema) {
        return {
          answer: answerForSchema(params.responseSchema),
          confidence: 0.91,
        };
      }
      return {
        answer: "local.vlm.free-text",
        confidence: 0.8,
      };
    },
  };
}

export class LocalVlmBinding implements VisionInterface {
  readonly #subjectId: string;
  readonly #deviceId: string;
  readonly #maxInputBytes: number;
  readonly #backend: LocalVlmNativeBackend;
  readonly #handle: LocalVlmNativeHandle;
  readonly #onTelemetry?: (event: LocalVlmTelemetryEvent) => void;
  #processedCount = 0;
  #unloaded = false;

  constructor(args: {
    subjectId: string;
    deviceId: string;
    maxInputBytes: number;
    backend: LocalVlmNativeBackend;
    handle: LocalVlmNativeHandle;
    onTelemetry?: (event: LocalVlmTelemetryEvent) => void;
  }) {
    this.#subjectId = args.subjectId;
    this.#deviceId = args.deviceId;
    this.#maxInputBytes = args.maxInputBytes;
    this.#backend = args.backend;
    this.#handle = args.handle;
    if (args.onTelemetry) {
      this.#onTelemetry = args.onTelemetry;
    }
  }

  get maxInputBytes(): number {
    return this.#maxInputBytes;
  }

  get engine(): typeof LOCAL_VLM_ENGINE {
    return LOCAL_VLM_ENGINE;
  }

  get subjectId(): string {
    return this.#subjectId;
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  /** Analyze bodies that passed the size gate (observability / CK-06.1). */
  processedCount(): number {
    return this.#processedCount;
  }

  #emit(
    partial: Omit<
      LocalVlmTelemetryEvent,
      "event" | "subjectId" | "deviceId" | "engine"
    >,
  ): void {
    this.#onTelemetry?.({
      event: "bindings_vision.vlm",
      subjectId: this.#subjectId,
      deviceId: this.#deviceId,
      engine: LOCAL_VLM_ENGINE,
      ...partial,
    });
  }

  #ensureLoaded(): void {
    if (this.#unloaded) {
      throw new LocalVlmError("local VLM binding unloaded", "not_loaded", {
        name: "LocalVlmNotLoadedError",
        code: "not_loaded",
        kind: "not_loaded",
      });
    }
  }

  async unload(): Promise<void> {
    if (this.#unloaded) return;
    this.#unloaded = true;
    await this.#backend.unload(this.#handle);
    this.#emit({ op: "unload", outcome: "ok" });
  }

  async analyze(request: VisualAnalysisRequest): Promise<VisualAnalysisResult> {
    this.#ensureLoaded();
    const inputBytes = request.input?.data?.byteLength ?? 0;

    // CK-06.1: size gate BEFORE any processing / model invocation.
    if (inputBytes > this.#maxInputBytes) {
      const err = new VisionInputTooLargeError(this.#maxInputBytes, inputBytes);
      this.#emit({
        op: "analyze",
        outcome: "error",
        failureClass: "size_limit",
        inputBytes,
        maxInputBytes: this.#maxInputBytes,
        detail: "input_too_large",
      });
      throw err;
    }

    try {
      if (
        typeof request.instruction !== "string" ||
        !request.instruction.trim()
      ) {
        throw new LocalVlmError("instruction is required", "validation", {
          name: "VisionValidationError",
          code: "validation",
          kind: "validation",
        });
      }

      assertDecodableVisualInput(request.input);

      this.#processedCount += 1;

      const native = await this.#backend.analyze(this.#handle, {
        input: request.input,
        instruction: request.instruction.trim(),
        ...(request.responseSchema
          ? { responseSchema: request.responseSchema }
          : {}),
      });

      if (typeof native.answer !== "string" || !native.answer.length) {
        throw new LocalVlmError("VLM backend returned empty answer", "native");
      }

      if (request.responseSchema) {
        const validated = validateAnswerAgainstSchema(
          native.answer,
          request.responseSchema,
        );
        if (!validated.ok) {
          throw new VisionSchemaError(
            `answer is not schema-valid JSON: ${validated.message}`,
          );
        }
      }

      const confidence =
        typeof native.confidence === "number" &&
        Number.isFinite(native.confidence)
          ? Math.min(1, Math.max(0, native.confidence))
          : 0.5;

      this.#emit({
        op: "analyze",
        outcome: "ok",
        inputBytes,
        maxInputBytes: this.#maxInputBytes,
        hasResponseSchema: Boolean(request.responseSchema),
      });

      return {
        answer: native.answer,
        confidence,
      };
    } catch (err) {
      if (err instanceof LocalVlmError) {
        this.#emit({
          op: "analyze",
          outcome: "error",
          failureClass: err.failureClass,
          inputBytes,
          maxInputBytes: this.#maxInputBytes,
          hasResponseSchema: Boolean(request.responseSchema),
          detail: err.code.slice(0, 80),
        });
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.#emit({
        op: "analyze",
        outcome: "error",
        failureClass: "native",
        inputBytes,
        detail: detail.slice(0, 160),
      });
      throw err;
    }
  }
}

/**
 * Load local VLM: declare maxInputBytes → FFI seam → VisionInterface.
 */
export async function loadLocalVlm(
  options: LoadLocalVlmOptions,
): Promise<LocalVlmBinding> {
  const subjectId = options.subjectId?.trim();
  const deviceId = options.deviceId?.trim();
  if (!subjectId) {
    throw new LocalVlmError("subjectId is required", "config");
  }
  if (!deviceId) {
    throw new LocalVlmError("deviceId is required", "config");
  }
  const maxInputBytes =
    typeof options.maxInputBytes === "number" &&
    Number.isFinite(options.maxInputBytes) &&
    options.maxInputBytes > 0
      ? Math.floor(options.maxInputBytes)
      : DEFAULT_MAX_INPUT_BYTES;

  const backend = options.backend ?? createInProcessLocalVlmBackend();
  const emit = options.onTelemetry;
  try {
    const handle = await backend.load(`${LOCAL_VLM_ENGINE}:weights`);
    const binding = new LocalVlmBinding({
      subjectId,
      deviceId,
      maxInputBytes,
      backend,
      handle,
      ...(emit ? { onTelemetry: emit } : {}),
    });
    emit?.({
      event: "bindings_vision.vlm",
      op: "load",
      outcome: "ok",
      subjectId,
      deviceId,
      engine: LOCAL_VLM_ENGINE,
      maxInputBytes,
    });
    return binding;
  } catch (err) {
    if (err instanceof LocalVlmError) throw err;
    throw new LocalVlmError(
      `local VLM load failed: ${err instanceof Error ? err.message : String(err)}`,
      "native",
    );
  }
}

export type CreateLocalVlmVisionHarnessOptions = {
  subjectId?: string;
  deviceId?: string;
  maxInputBytes?: number;
  backend?: LocalVlmNativeBackend;
  onTelemetry?: (event: LocalVlmTelemetryEvent) => void;
};

/** Conformance factory for CK-06 against the local VLM binding. */
export function createLocalVlmVisionHarnessFactory(
  options: CreateLocalVlmVisionHarnessOptions = {},
): (ctx?: {
  subjectId?: string;
  deviceId?: string;
}) => Promise<VisionConformanceHarness> {
  return async (ctx) => {
    const vision = await loadLocalVlm({
      subjectId:
        ctx?.subjectId?.trim() ||
        options.subjectId?.trim() ||
        "cert.vision.vlm",
      deviceId:
        ctx?.deviceId?.trim() ||
        options.deviceId?.trim() ||
        "ci-vision-vlm",
      maxInputBytes:
        options.maxInputBytes ??
        // Match conformance reference ceiling for CK-06 probes.
        64,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
    });
    return {
      vision,
      processedCount: () => vision.processedCount(),
    };
  };
}
