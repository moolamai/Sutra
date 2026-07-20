/**
 * ModelInterface obligations ( / CK-03).
 *
 * CK-03.1 — `embed` dimension MUST be stable per provider instance.
 * CK-03.2 — Streaming MUST yield deltas, not cumulative text
 *           (concatenation equals `generate` final text).
 * CK-03.3 — Providers MUST surface `locality` truthfully — probed against
 *           the harness network context (on-device / self-hosted must work
 *           when network is denied).
 *
 * Speech (CK-05) and Vision (CK-06) land in — out of scope.
 */

import type {
  ChatMessage,
  GenerateResult,
  ModelDescriptor,
  ModelInterface,
} from "@moolam/contracts";

import {
  ObligationRegistry,
  ObligationViolation,
  defineObligation,
  type Obligation,
  type ObligationContext,
} from "../registry.js";

/**
 * Verbatim MUST sentences from `packages/contracts/src/model.ts`.
 */
export const MUST_EMBED_DIMENSION_STABLE =
  "`embed` dimension MUST be stable per provider instance.";

export const MUST_STREAM_DELTAS =
  "Streaming MUST yield deltas, not cumulative text.";

export const MUST_LOCALITY_TRUTHFUL =
  "Providers MUST surface `locality` truthfully — sovereign deployments gate which localities are permitted per data class.";

export const MODEL_OBLIGATION_IDS = {
  embedDimensionStable: "CK-03.1",
  streamDeltas: "CK-03.2",
  localityTruthful: "CK-03.3",
} as const;

/**
 * B0 model obligation set selected by llama.cpp desktop certification profiles
 * (`bindings-slm certify --profile desktop`). Keep in sync with
 * `packages/bindings-slm/certification/desktop.profile.json` → obligations.b0Model.
 * CI job `llama-cpp-desktop-cert` uploads a JSON report whose
 * `obligationVerdicts[].obligationId` values MUST be this closed set on pass.
 * Full offline CognitiveCore turns additionally require those obligations
 * remain green while EdgeAgent runs with network denied.
 */
export const DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS = [
  MODEL_OBLIGATION_IDS.embedDimensionStable,
  MODEL_OBLIGATION_IDS.streamDeltas,
  MODEL_OBLIGATION_IDS.localityTruthful,
] as const;

/**
 * B0 model obligation set for ONNX mobile Android certification profiles
 * (`bindings-slm certify --profile android --adapter onnx`). Keep in sync with
 * `packages/bindings-slm/certification/android.profile.json` → obligations.b0Model.
 */
export const ANDROID_CERTIFICATION_MODEL_OBLIGATION_IDS =
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS;

/**
 * B0 model obligation set for MLX Apple silicon certification profiles
 * (`bindings-slm certify --profile apple-silicon --adapter mlx`). Keep in sync
 * with `packages/bindings-slm/certification/apple-silicon.profile.json`.
 */
export const APPLE_SILICON_CERTIFICATION_MODEL_OBLIGATION_IDS =
  DESKTOP_CERTIFICATION_MODEL_OBLIGATION_IDS;

/** Max stream chunks drained per probe (NFR / scalability). */
export const MODEL_STREAM_CHUNK_LIMIT = 64;

/** Embed calls per stability probe. */
export const MODEL_EMBED_PROBE_COUNT = 3;

/** Reference embedding width (metadata vectors only). */
export const MODEL_REFERENCE_EMBED_DIM = 8;

/**
 * Conformance surface for model providers.
 * Probe only through `descriptor` + `generate` / `generateStream` / `embed`.
 * Network deny drives CK-03.3 locality truthfulness.
 */
export interface ModelConformanceHarness {
  model: ModelInterface;
  /** When false, network-backed inference paths must not be required. */
  isNetworkAllowed(): boolean;
  setNetworkAllowed(allowed: boolean): void;
}

function subjectToken(subjectId: string): string {
  return subjectId
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

/** Subject-scoped probe messages — metadata tokens only, never learner content. */
export function buildModelProbeMessages(ctx: ObligationContext): ChatMessage[] {
  return [
    {
      role: "user",
      content: `probe.ck03.msg.${subjectToken(ctx.subjectId)}`,
    },
  ];
}

export function buildModelEmbedProbeTexts(ctx: ObligationContext): string[] {
  const tok = subjectToken(ctx.subjectId);
  return [
    `probe.ck03.embed.a.${tok}`,
    `probe.ck03.embed.b.${tok}`,
    `probe.ck03.embed.c.${tok}`,
  ].slice(0, MODEL_EMBED_PROBE_COUNT);
}

function withNetworkControl(
  model: ModelInterface,
): ModelConformanceHarness {
  let networkAllowed = true;
  return {
    model,
    isNetworkAllowed: () => networkAllowed,
    setNetworkAllowed: (allowed) => {
      networkAllowed = allowed;
    },
  };
}

function isLocalLocality(locality: ModelDescriptor["locality"]): boolean {
  return locality === "on-device" || locality === "self-hosted";
}

/**
 * True when a later frame restates prior accumulated text (cumulative streaming).
 */
export function isCumulativeStreamFrame(
  priorAccumulated: string,
  frame: string,
): boolean {
  if (priorAccumulated.length === 0) return false;
  if (frame.length <= priorAccumulated.length) return false;
  return frame.startsWith(priorAccumulated);
}

/** Drain an async iterable with a hard chunk cap. */
export async function collectStreamChunks(
  stream: AsyncIterable<string>,
  limit: number = MODEL_STREAM_CHUNK_LIMIT,
): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
    if (out.length >= limit) break;
  }
  return out;
}

export function defineEmbedDimensionStableObligation(): Obligation<ModelConformanceHarness> {
  return defineObligation({
    id: MODEL_OBLIGATION_IDS.embedDimensionStable,
    contract: "ModelInterface",
    mustText: MUST_EMBED_DIMENSION_STABLE,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const texts = buildModelEmbedProbeTexts(ctx);
      const dims: number[] = [];
      for (const text of texts) {
        let vec: Float32Array;
        try {
          vec = await impl.model.embed(text);
        } catch (err) {
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.embedDimensionStable,
            mustText: MUST_EMBED_DIMENSION_STABLE,
            contract: "ModelInterface",
            message: `embed() threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        if (!(vec instanceof Float32Array) || vec.length <= 0) {
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.embedDimensionStable,
            mustText: MUST_EMBED_DIMENSION_STABLE,
            contract: "ModelInterface",
            message: "embed() must return a non-empty Float32Array",
          });
        }
        dims.push(vec.length);
      }
      const first = dims[0]!;
      if (!dims.every((d) => d === first)) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.embedDimensionStable,
          mustText: MUST_EMBED_DIMENSION_STABLE,
          contract: "ModelInterface",
          message: `embed dimension unstable across calls: [${dims.join(", ")}]`,
        });
      }
    },
  });
}

export function defineStreamDeltasObligation(): Obligation<ModelConformanceHarness> {
  return defineObligation({
    id: MODEL_OBLIGATION_IDS.streamDeltas,
    contract: "ModelInterface",
    mustText: MUST_STREAM_DELTAS,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const messages = buildModelProbeMessages(ctx);
      let final: GenerateResult;
      try {
        final = await impl.model.generate(messages, { maxTokens: 64 });
      } catch (err) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
          mustText: MUST_STREAM_DELTAS,
          contract: "ModelInterface",
          message: `generate() threw before stream compare: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (typeof final.text !== "string" || final.text.length === 0) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
          mustText: MUST_STREAM_DELTAS,
          contract: "ModelInterface",
          message: "generate() returned empty text; cannot validate stream concatenation",
        });
      }

      let chunks: string[];
      try {
        chunks = await collectStreamChunks(
          impl.model.generateStream(messages, { maxTokens: 64 }),
        );
      } catch (err) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
          mustText: MUST_STREAM_DELTAS,
          contract: "ModelInterface",
          message: `generateStream() threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      if (chunks.length === 0) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
          mustText: MUST_STREAM_DELTAS,
          contract: "ModelInterface",
          message: "generateStream() yielded no chunks",
        });
      }

      let accumulated = "";
      for (let i = 0; i < chunks.length; i++) {
        const frame = chunks[i]!;
        if (typeof frame !== "string") {
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
            mustText: MUST_STREAM_DELTAS,
            contract: "ModelInterface",
            message: `stream chunk ${i} is not a string`,
          });
        }
        if (isCumulativeStreamFrame(accumulated, frame)) {
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
            mustText: MUST_STREAM_DELTAS,
            contract: "ModelInterface",
            message: `stream chunk ${i} is cumulative (restates prior text), not a delta`,
          });
        }
        accumulated += frame;
      }

      if (accumulated !== final.text) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.streamDeltas,
          mustText: MUST_STREAM_DELTAS,
          contract: "ModelInterface",
          message:
            "stream delta concatenation does not equal generate() final text",
        });
      }
    },
  });
}

export function defineLocalityTruthfulObligation(): Obligation<ModelConformanceHarness> {
  return defineObligation({
    id: MODEL_OBLIGATION_IDS.localityTruthful,
    contract: "ModelInterface",
    mustText: MUST_LOCALITY_TRUTHFUL,
    specIds: ["CK-03"],
    async check(impl, ctx) {
      const locality = impl.model.descriptor?.locality;
      if (
        locality !== "on-device" &&
        locality !== "self-hosted" &&
        locality !== "external-api"
      ) {
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
          mustText: MUST_LOCALITY_TRUTHFUL,
          contract: "ModelInterface",
          message: `descriptor.locality missing or invalid: ${String(locality)}`,
        });
      }

      const messages = buildModelProbeMessages(ctx);
      const embedText = buildModelEmbedProbeTexts(ctx)[0]!;

      if (isLocalLocality(locality)) {
        impl.setNetworkAllowed(false);
        try {
          const result = await impl.model.generate(messages, { maxTokens: 32 });
          if (typeof result.text !== "string" || result.text.length === 0) {
            throw new ObligationViolation({
              obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
              mustText: MUST_LOCALITY_TRUTHFUL,
              contract: "ModelInterface",
              message: `locality "${locality}" returned empty generate() while network denied`,
            });
          }
          const vec = await impl.model.embed(embedText);
          if (!(vec instanceof Float32Array) || vec.length <= 0) {
            throw new ObligationViolation({
              obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
              mustText: MUST_LOCALITY_TRUTHFUL,
              contract: "ModelInterface",
              message: `locality "${locality}" embed() failed while network denied`,
            });
          }
        } catch (err) {
          if (err instanceof ObligationViolation) throw err;
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
            mustText: MUST_LOCALITY_TRUTHFUL,
            contract: "ModelInterface",
            message: `locality "${locality}" required network (denied): ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        } finally {
          impl.setNetworkAllowed(true);
        }
        return;
      }

      // external-api: must succeed when network is allowed (declaration usable).
      impl.setNetworkAllowed(true);
      try {
        const result = await impl.model.generate(messages, { maxTokens: 32 });
        if (typeof result.text !== "string" || result.text.length === 0) {
          throw new ObligationViolation({
            obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
            mustText: MUST_LOCALITY_TRUTHFUL,
            contract: "ModelInterface",
            message:
              'locality "external-api" returned empty generate() while network allowed',
          });
        }
      } catch (err) {
        if (err instanceof ObligationViolation) throw err;
        throw new ObligationViolation({
          obligationId: MODEL_OBLIGATION_IDS.localityTruthful,
          mustText: MUST_LOCALITY_TRUTHFUL,
          contract: "ModelInterface",
          message: `locality "external-api" failed while network allowed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  });
}

export function registerEmbedDimensionStableObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineEmbedDimensionStableObligation());
  return registry;
}

export function registerStreamDeltasObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineStreamDeltasObligation());
  return registry;
}

export function registerLocalityTruthfulObligation(
  registry: ObligationRegistry,
): ObligationRegistry {
  registry.register(defineLocalityTruthfulObligation());
  return registry;
}

export function registerModelObligations(
  registry: ObligationRegistry,
): ObligationRegistry {
  registerEmbedDimensionStableObligation(registry);
  registerStreamDeltasObligation(registry);
  registerLocalityTruthfulObligation(registry);
  return registry;
}

export function createEmbedDimensionStableObligationRegistry(): ObligationRegistry {
  return registerEmbedDimensionStableObligation(new ObligationRegistry());
}

export function createStreamDeltasObligationRegistry(): ObligationRegistry {
  return registerStreamDeltasObligation(new ObligationRegistry());
}

export function createLocalityTruthfulObligationRegistry(): ObligationRegistry {
  return registerLocalityTruthfulObligation(new ObligationRegistry());
}

export function createModelObligationsRegistry(): ObligationRegistry {
  return registerModelObligations(new ObligationRegistry());
}

/* ── Reference / violation harness factories ── */

function referenceFinalText(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]?.content ?? "probe";
  return `probe.ck03.assistant.delta.${last.slice(0, 48)}`;
}

function stableEmbed(text: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 64); i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < dim; i++) {
    out[i] = ((h + i * 17) % 1000) / 1000;
  }
  return out;
}

type ModelFactoryOptions = {
  locality: ModelDescriptor["locality"];
  /** When set, alternate embed lengths to violate CK-03.1. */
  unstableEmbed: boolean;
  /** When true, stream cumulative frames (violate CK-03.2). */
  cumulativeStream: boolean;
  /** When true, on-device/self-hosted fails under network deny (violate CK-03.3). */
  localityLiar: boolean;
};

function createModelFactory(
  options: ModelFactoryOptions,
): () => ModelConformanceHarness {
  const descriptor: ModelDescriptor = {
    modelId: "probe.ck03.reference",
    contextWindow: 2048,
    locality: options.locality,
    modalities: ["text"],
  };

  return () => {
    const harness = withNetworkControl({
      get descriptor() {
        return descriptor;
      },
      async generate(messages) {
        if (options.localityLiar && !harness.isNetworkAllowed()) {
          throw new Error("network required");
        }
        if (
          options.locality === "external-api" &&
          !harness.isNetworkAllowed()
        ) {
          throw new Error("external-api requires network");
        }
        return {
          text: referenceFinalText(messages),
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *generateStream(messages) {
        if (options.localityLiar && !harness.isNetworkAllowed()) {
          throw new Error("network required");
        }
        if (
          options.locality === "external-api" &&
          !harness.isNetworkAllowed()
        ) {
          throw new Error("external-api requires network");
        }
        const final = referenceFinalText(messages);
        if (options.cumulativeStream) {
          // Cumulative frames: each restates prior text.
          const mid = Math.max(1, Math.floor(final.length / 2));
          yield final.slice(0, mid);
          yield final;
          return;
        }
        // Deltas whose concatenation equals final.
        const mid = Math.max(1, Math.floor(final.length / 2));
        yield final.slice(0, mid);
        yield final.slice(mid);
      },
      async embed(text) {
        if (options.localityLiar && !harness.isNetworkAllowed()) {
          throw new Error("network required");
        }
        if (
          options.locality === "external-api" &&
          !harness.isNetworkAllowed()
        ) {
          throw new Error("external-api requires network");
        }
        if (options.unstableEmbed) {
          const dim =
            text.includes(".embed.b.") || text.includes(".embed.c.")
              ? MODEL_REFERENCE_EMBED_DIM + 2
              : MODEL_REFERENCE_EMBED_DIM;
          return stableEmbed(text, dim);
        }
        return stableEmbed(text, MODEL_REFERENCE_EMBED_DIM);
      },
    });
    return harness;
  };
}

/**
 * Known-good on-device reference: stable embeds, delta stream, truthful locality.
 */
export function createStableModelHarnessFactory(): () => ModelConformanceHarness {
  return createModelFactory({
    locality: "on-device",
    unstableEmbed: false,
    cumulativeStream: false,
    localityLiar: false,
  });
}

/** Known-good self-hosted variant (still local under network deny). */
export function createSelfHostedModelHarnessFactory(): () => ModelConformanceHarness {
  return createModelFactory({
    locality: "self-hosted",
    unstableEmbed: false,
    cumulativeStream: false,
    localityLiar: false,
  });
}

/** Violation for CK-03.1: embed dimension changes across calls. */
export function createUnstableEmbedModelHarnessFactory(): () => ModelConformanceHarness {
  return createModelFactory({
    locality: "on-device",
    unstableEmbed: true,
    cumulativeStream: false,
    localityLiar: false,
  });
}

/** Violation for CK-03.2: stream yields cumulative frames. */
export function createCumulativeStreamModelHarnessFactory(): () => ModelConformanceHarness {
  return createModelFactory({
    locality: "on-device",
    unstableEmbed: false,
    cumulativeStream: true,
    localityLiar: false,
  });
}

/**
 * Violation for CK-03.3: declares on-device but requires network.
 */
export function createLocalityLiarModelHarnessFactory(): () => ModelConformanceHarness {
  return createModelFactory({
    locality: "on-device",
    unstableEmbed: false,
    cumulativeStream: false,
    localityLiar: true,
  });
}
