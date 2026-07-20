/**
 * ModelInterface adapter over MlxSlmRuntime (Apple silicon / MLX + Metal).
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
  MlxSlmRuntime,
  createInProcessMlxMetalBackend,
  type MlxHostProbe,
  type MlxNativeBackend,
  type MlxSlmRuntimeOptions,
  type MlxTelemetryEvent,
} from "./mlx_runtime.js";

export type MlxModelAdapterOptions = Omit<SlmModelAdapterOptions, "locality">;

export type MlxModelAdapterBundle = {
  model: ModelInterface;
  runtime: MlxSlmRuntime;
};

export function createMlxModelAdapter(
  runtime: MlxSlmRuntime,
  options: MlxModelAdapterOptions,
): ModelInterface {
  const subjectId = options.subjectId?.trim() ?? "";
  if (!subjectId) {
    throw new SlmModelAdapterError(
      "createMlxModelAdapter requires subjectId (subject isolation)",
      {
        obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
        failureClass: "validation",
        errorCode: "SUBJECT_REQUIRED",
      },
    );
  }
  if (!runtime.isLoaded) {
    throw new SlmModelAdapterError(
      "MlxSlmRuntime must be load()'d before ModelInterface adapter",
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

export async function loadMlxModelAdapter(
  runtimeOptions: MlxSlmRuntimeOptions,
  adapterOptions: MlxModelAdapterOptions,
): Promise<MlxModelAdapterBundle> {
  const runtime = new MlxSlmRuntime(runtimeOptions);
  await runtime.load();
  const model = createMlxModelAdapter(runtime, adapterOptions);
  return { model, runtime };
}

export type CreateMlxModelAdapterHarnessOptions = {
  deviceId?: string;
  subjectId?: string;
  weightsPath: string;
  backend?: MlxNativeBackend;
  /** Defaults to darwin/arm64 so CI on Linux can certify the Apple profile. */
  hostProbe?: MlxHostProbe;
  emit?: (event: ChatPromptAssemblyEvent | SlmModelAdapterEvent) => void;
  onRuntimeTelemetry?: (event: MlxTelemetryEvent) => void;
};

/**
 * Factory for `runConformance({ registry: createModelObligationsRegistry() })`.
 */
export function createMlxModelAdapterHarnessFactory(
  options: CreateMlxModelAdapterHarnessOptions,
): (ctx?: { subjectId?: string }) => Promise<SlmModelAdapterHarness> {
  return async (ctx) => {
    const subjectId = (ctx?.subjectId ?? options.subjectId ?? "").trim();
    if (!subjectId) {
      throw new SlmModelAdapterError(
        "createMlxModelAdapterHarnessFactory requires subjectId",
        {
          obligationId: EDGE_PROMPT_OBLIGATION_SUBJECT,
          failureClass: "validation",
          errorCode: "SUBJECT_REQUIRED",
        },
      );
    }

    let networkAllowed = true;
    const hostProbe = options.hostProbe ?? {
      platform: "darwin",
      arch: "arm64",
    };
    const runtime = new MlxSlmRuntime({
      weightsPath: options.weightsPath,
      subjectId,
      hostProbe,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.backend !== undefined
        ? { backend: options.backend }
        : { backend: createInProcessMlxMetalBackend() }),
      ...(options.onRuntimeTelemetry
        ? { onTelemetry: options.onRuntimeTelemetry }
        : {}),
    });
    await runtime.load();

    const model = createMlxModelAdapter(runtime, {
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
