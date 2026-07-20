/**
 * ModelInterface adapter over LlamaCppSlmRuntime (B3 binding seam).
 *
 * Maps ChatMessage[] generate / generateStream / embed onto the native
 * SlmRuntime via {@link createSlmModelAdapter}. Locality is always
 * `on-device` so CognitiveCore / locality policy treat llama.cpp as a
 * sovereign edge brain. Runtime must be `load()`'d first so the model
 * card reflects truthful GGUF metadata.
 */

import type { ModelInterface } from "@moolam/contracts";
import {
  createSlmModelAdapter,
  EDGE_MODEL_OBLIGATION_INIT,
  EDGE_PROMPT_OBLIGATION_SUBJECT,
  SlmModelAdapterError,
  toStreamDeltas,
  type SlmModelAdapterEvent,
  type ChatPromptAssemblyEvent,
  type SlmModelAdapterHarness,
  type SlmModelAdapterOptions,
} from "@moolam/edge-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMinimalGguf } from "./gguf_metadata.js";
import {
  LlamaCppSlmRuntime,
  type LlamaCppSlmRuntimeOptions,
  type LlamaCppTelemetryEvent,
  type LlamaCppTelemetryOp,
} from "./llamacpp_runtime.js";
import {
  createInProcessLlamaCppBackend,
  type LlamaCppNativeBackend,
} from "./native_ffi.js";

export {
  LlamaCppSlmRuntime,
  type LlamaCppSlmRuntimeOptions,
  type LlamaCppTelemetryEvent,
  type LlamaCppTelemetryOp,
} from "./llamacpp_runtime.js";

export { toStreamDeltas };

/** Adapter options — locality is fixed to on-device (not caller-selectable). */
export type LlamaCppModelAdapterOptions = Omit<
  SlmModelAdapterOptions,
  "locality"
>;

export type LlamaCppModelAdapterBundle = {
  /** CognitiveCore-ready ModelInterface (locality: on-device). */
  model: ModelInterface;
  /** Underlying native runtime (load/unload / SlmRuntime). */
  runtime: LlamaCppSlmRuntime;
};

/**
 * Wrap a loaded {@link LlamaCppSlmRuntime} as {@link ModelInterface}.
 * Injectable as `bindings.model` for CognitiveCore.
 */
export function createLlamaCppModelAdapter(
  runtime: LlamaCppSlmRuntime,
  options: LlamaCppModelAdapterOptions,
): ModelInterface {
  const subjectId = options.subjectId?.trim() ?? "";
  if (!subjectId) {
    throw new SlmModelAdapterError(
      "createLlamaCppModelAdapter requires subjectId (subject isolation)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }
  if (!runtime.isLoaded) {
    throw new SlmModelAdapterError(
      "LlamaCppSlmRuntime must be load()'d before ModelInterface adapter",
      {
        obligationId: EDGE_MODEL_OBLIGATION_INIT,
        failureClass: "config",
        errorCode: "RUNTIME_NOT_LOADED",
      },
    );
  }
  // Sovereign native path — never advertise self-hosted/external-api for GGUF.
  return createSlmModelAdapter(runtime, {
    ...options,
    subjectId,
    locality: "on-device",
  });
}

/**
 * Construct, load GGUF weights, and return CognitiveCore-ready model + runtime.
 */
export async function loadLlamaCppModelAdapter(
  runtimeOptions: LlamaCppSlmRuntimeOptions,
  adapterOptions: LlamaCppModelAdapterOptions,
): Promise<LlamaCppModelAdapterBundle> {
  const runtime = new LlamaCppSlmRuntime(runtimeOptions);
  await runtime.load();
  const model = createLlamaCppModelAdapter(runtime, adapterOptions);
  return { model, runtime };
}

export type CreateLlamaCppModelAdapterHarnessOptions = {
  deviceId?: string;
  subjectId?: string;
  /** Override weights path (defaults to a minimal GGUF fixture). */
  weightsPath?: string;
  backend?: LlamaCppNativeBackend;
  emit?: (event: ChatPromptAssemblyEvent | SlmModelAdapterEvent) => void;
  onRuntimeTelemetry?: (event: LlamaCppTelemetryEvent) => void;
};

let cachedHarnessWeights: string | null = null;

function harnessGgufPath(): string {
  if (cachedHarnessWeights) return cachedHarnessWeights;
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-llama-ck03-"));
  const weightsPath = path.join(dir, "harness.gguf");
  writeFileSync(
    weightsPath,
    writeMinimalGguf({
      name: "phi-ck03-llama",
      contextLength: 4096,
      fileType: 15,
      languages: ["en"],
    }),
  );
  cachedHarnessWeights = weightsPath;
  return weightsPath;
}

/**
 * Factory for `runConformance({ registry: createModelObligationsRegistry() })`.
 * Returns a Promise harness (runner awaits factory results).
 */
export function createLlamaCppModelAdapterHarnessFactory(
  options: CreateLlamaCppModelAdapterHarnessOptions = {},
): (ctx?: { subjectId?: string }) => Promise<SlmModelAdapterHarness> {
  return async (ctx) => {
    const subjectId = (ctx?.subjectId ?? options.subjectId ?? "").trim();
    if (!subjectId) {
      throw new SlmModelAdapterError(
        "createLlamaCppModelAdapterHarnessFactory requires subjectId",
        {
          obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
          failureClass: "validation",
          errorCode: "SUBJECT_REQUIRED",
        },
      );
    }

    let networkAllowed = true;
    const weightsPath = options.weightsPath ?? harnessGgufPath();
    const runtime = new LlamaCppSlmRuntime({
      weightsPath,
      subjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.backend !== undefined
        ? { backend: options.backend }
        : { backend: createInProcessLlamaCppBackend() }),
      ...(options.onRuntimeTelemetry
        ? { onTelemetry: options.onRuntimeTelemetry }
        : {}),
    });
    await runtime.load();

    const model = createLlamaCppModelAdapter(runtime, {
      subjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
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
