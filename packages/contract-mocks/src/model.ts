/**
 * Reference ModelInterface — stable embeds, delta streaming, truthful locality
 * (CK-03). Ported from examples/_shared/mocks.mjs with obligation-grade streams.
 *
 * @module model
 */

import type {
  ChatMessage,
  GenerateOptions,
  ModelDescriptor,
  ModelInterface,
} from "@moolam/contracts";

import { REFERENCE_EMBED_DIM, embedText } from "./embed.js";
import type { ContractMockEmit } from "./events.js";

export type ModelMockOptions = {
  /** Optional persona label for echo-style generate (examples). */
  persona?: string;
  descriptor?: Partial<ModelDescriptor>;
  deviceId?: string;
  /** Metadata subject token for observability (never raw content). */
  subjectId?: string;
  emit?: ContractMockEmit;
};

export type ModelMockHarness = {
  model: ModelInterface;
  isNetworkAllowed(): boolean;
  setNetworkAllowed(allowed: boolean): void;
};

function finalText(messages: ChatMessage[], persona: string): string {
  const user =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const grounding = messages.find((m) =>
    m.content.startsWith("Grounded conclusion"),
  )?.content;
  const grounded = grounding
    ? grounding.replace("Grounded conclusion (cite when used): ", "") + " "
    : "";
  if (persona) {
    return `[${persona}] ${grounded}(re: ${user.slice(0, 60)})`;
  }
  // Conformance-friendly deterministic body when no persona (delta concat).
  return `probe.ck03.assistant.delta.${user.slice(0, 48)}`;
}

/**
 * On-device (default) or self-hosted reference model.
 * Does not require network — locality is truthful under network deny.
 */
export function createModelMock(options: ModelMockOptions = {}): ModelInterface {
  const persona = options.persona ?? "";
  const deviceId = options.deviceId?.trim() || "dev-contract-mocks";
  const subjectId = options.subjectId?.trim() || "subj.contract-mocks";
  const emit = options.emit;
  const descriptor: ModelDescriptor = {
    modelId: options.descriptor?.modelId ?? "mock-slm",
    contextWindow: options.descriptor?.contextWindow ?? 8192,
    locality: options.descriptor?.locality ?? "on-device",
    modalities: options.descriptor?.modalities ?? ["text"],
  };

  if (descriptor.locality === "external-api") {
    // Reference floor for sovereign tests stays local — callers must opt deliberately.
    // Still constructable; generate will fail closed without network seam (see harness).
  }

  const model: ModelInterface = {
    get descriptor() {
      return descriptor;
    },

    async generate(messages, _options?: GenerateOptions) {
      try {
        const text = finalText(messages, persona);
        emit?.({
          event: "contract_mocks.model",
          op: "generate",
          subjectId,
          deviceId,
          outcome: "ok",
          locality: descriptor.locality,
        });
        return {
          text,
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: Math.max(1, text.length) },
        };
      } catch (err) {
        emit?.({
          event: "contract_mocks.model",
          op: "generate",
          subjectId,
          deviceId,
          outcome: "error",
          locality: descriptor.locality,
        });
        throw err;
      }
    },

    async *generateStream(messages, _options?: GenerateOptions) {
      try {
        const full = finalText(messages, persona);
        const mid = Math.max(1, Math.floor(full.length / 2));
        // Deltas — concatenation equals generate() final text (CK-03.2).
        yield full.slice(0, mid);
        yield full.slice(mid);
        emit?.({
          event: "contract_mocks.model",
          op: "generateStream",
          subjectId,
          deviceId,
          outcome: "ok",
          locality: descriptor.locality,
        });
      } catch (err) {
        emit?.({
          event: "contract_mocks.model",
          op: "generateStream",
          subjectId,
          deviceId,
          outcome: "error",
          locality: descriptor.locality,
        });
        throw err;
      }
    },

    async embed(text) {
      try {
        const v = embedText(text, REFERENCE_EMBED_DIM);
        emit?.({
          event: "contract_mocks.model",
          op: "embed",
          subjectId,
          deviceId,
          outcome: "ok",
          locality: descriptor.locality,
        });
        return v;
      } catch (err) {
        emit?.({
          event: "contract_mocks.model",
          op: "embed",
          subjectId,
          deviceId,
          outcome: "error",
          locality: descriptor.locality,
        });
        throw err;
      }
    },
  };

  return model;
}

/**
 * Conformance harness factory with network deny seam (CK-03.3).
 * On-device / self-hosted succeed when network is denied.
 */
export function createModelMockHarnessFactory(
  options: ModelMockOptions = {},
): () => ModelMockHarness {
  return () => {
    let networkAllowed = true;
    const model = createModelMock(options);
    return {
      model,
      isNetworkAllowed: () => networkAllowed,
      setNetworkAllowed: (allowed: boolean) => {
        networkAllowed = allowed;
      },
    };
  };
}

/** examples/_shared alias — persona framing for echo replies. */
export function makeModel(persona?: string): ModelInterface {
  return createModelMock({ persona: persona ?? "mock" });
}
