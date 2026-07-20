/**
 * ModelInterface adapter over OnnxSlmRuntime (Android / ONNX Runtime Mobile).
 * Locality is hard-fixed to on-device for B0/B1 certification.
 */

import type { ModelInterface } from "@moolam/contracts";
import {
  createSlmModelAdapter,
  EDGE_MODEL_OBLIGATION_INIT,
  EDGE_PROMPT_OBLIGATION_SUBJECT,
  SlmModelAdapterError,
  type ChatPromptAssemblyEvent,
  type SlmModelAdapterEvent,
  type SlmModelAdapterHarness,
  type SlmModelAdapterOptions,
} from "@moolam/edge-agent";
import {
  OnnxSlmRuntime,
  createInProcessOnnxMobileBackend,
  type OnnxMobileNativeBackend,
  type OnnxMobileTelemetryEvent,
  type OnnxSlmRuntimeOptions,
} from "./onnx_mobile_runtime.js";

export type OnnxModelAdapterOptions = Omit<SlmModelAdapterOptions, "locality">;

export type OnnxModelAdapterBundle = {
  model: ModelInterface;
  runtime: OnnxSlmRuntime;
};

export function createOnnxModelAdapter(
  runtime: OnnxSlmRuntime,
  options: OnnxModelAdapterOptions,
): ModelInterface {
  const subjectId = options.subjectId?.trim() ?? "";
  if (!subjectId) {
    throw new SlmModelAdapterError(
      "createOnnxModelAdapter requires subjectId (subject isolation)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }
  if (!runtime.isLoaded) {
    throw new SlmModelAdapterError(
      "OnnxSlmRuntime must be load()'d before ModelInterface adapter",
      {
        obligationId: EDGE_MODEL_OBLIGATION_INIT,
        failureClass: "config",
        errorCode: "RUNTIME_NOT_LOADED",
      },
    );
  }
  return createSlmModelAdapter(runtime, {
    ...options,
    subjectId,
    locality: "on-device",
  });
}

export async function loadOnnxModelAdapter(
  runtimeOptions: OnnxSlmRuntimeOptions,
  adapterOptions: OnnxModelAdapterOptions,
): Promise<OnnxModelAdapterBundle> {
  const runtime = new OnnxSlmRuntime(runtimeOptions);
  await runtime.load();
  const model = createOnnxModelAdapter(runtime, adapterOptions);
  return { model, runtime };
}

export type CreateOnnxModelAdapterHarnessOptions = {
  deviceId?: string;
  subjectId?: string;
  weightsPath: string;
  maxMemoryMiB?: number;
  backend?: OnnxMobileNativeBackend;
  emit?: (event: ChatPromptAssemblyEvent | SlmModelAdapterEvent) => void;
  onRuntimeTelemetry?: (event: OnnxMobileTelemetryEvent) => void;
};

/**
 * Factory for `runConformance({ registry: createModelObligationsRegistry() })`.
 */
export function createOnnxModelAdapterHarnessFactory(
  options: CreateOnnxModelAdapterHarnessOptions,
): (ctx?: { subjectId?: string }) => Promise<SlmModelAdapterHarness> {
  return async (ctx) => {
    const subjectId = (ctx?.subjectId ?? options.subjectId ?? "").trim();
    if (!subjectId) {
      throw new SlmModelAdapterError(
        "createOnnxModelAdapterHarnessFactory requires subjectId",
        {
          obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
          failureClass: "validation",
          errorCode: "SUBJECT_REQUIRED",
        },
      );
    }

    let networkAllowed = true;
    const runtime = new OnnxSlmRuntime({
      weightsPath: options.weightsPath,
      subjectId,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.maxMemoryMiB !== undefined
        ? { maxMemoryMiB: options.maxMemoryMiB }
        : {}),
      ...(options.backend !== undefined
        ? { backend: options.backend }
        : { backend: createInProcessOnnxMobileBackend() }),
      ...(options.onRuntimeTelemetry
        ? { onTelemetry: options.onRuntimeTelemetry }
        : {}),
    });
    await runtime.load();

    const model = createOnnxModelAdapter(runtime, {
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
