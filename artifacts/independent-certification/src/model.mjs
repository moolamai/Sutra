/**
 * Deterministic on-device model adapter — not sutra-bindings-slm.
 * Stable embeds, delta streams, truthful locality under network deny.
 */

const EMBED_DIM = 8;

function subjectToken(subjectId) {
  return String(subjectId)
    .replace(/[^A-Za-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".");
}

function stableEmbed(text, dim = EMBED_DIM) {
  const out = new Float32Array(dim);
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < dim; i++) {
    out[i] = ((h + i * 17) % 1000) / 1000;
  }
  return out;
}

function finalText(messages) {
  const last = messages?.at?.(-1)?.content ?? "probe";
  return `indep.delta.${String(last).slice(0, 48)}`;
}

/**
 * @param {{ locality?: "on-device"|"self-hosted"|"external-api", unstableEmbed?: boolean, cumulativeStream?: boolean, localityLiar?: boolean }} [options]
 */
export function createIndependentModel(options = {}) {
  const locality = options.locality ?? "on-device";
  const unstableEmbed = options.unstableEmbed === true;
  const cumulativeStream = options.cumulativeStream === true;
  const localityLiar = options.localityLiar === true;

  let networkAllowed = true;
  const descriptor = {
    modelId: "independent.cert.probe",
    contextWindow: 2048,
    locality,
    modalities: ["text"],
  };

  const model = {
    get descriptor() {
      return descriptor;
    },
    async generate(messages) {
      if (localityLiar && !networkAllowed) throw new Error("network required");
      if (locality === "external-api" && !networkAllowed) {
        throw new Error("external-api requires network");
      }
      return {
        text: finalText(messages),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async *generateStream(messages) {
      if (localityLiar && !networkAllowed) throw new Error("network required");
      if (locality === "external-api" && !networkAllowed) {
        throw new Error("external-api requires network");
      }
      const final = finalText(messages);
      if (cumulativeStream) {
        const mid = Math.max(1, Math.floor(final.length / 2));
        yield final.slice(0, mid);
        yield final;
        return;
      }
      const mid = Math.max(1, Math.floor(final.length / 2));
      yield final.slice(0, mid);
      yield final.slice(mid);
    },
    async embed(text) {
      if (localityLiar && !networkAllowed) throw new Error("network required");
      if (locality === "external-api" && !networkAllowed) {
        throw new Error("external-api requires network");
      }
      if (unstableEmbed) {
        const dim =
          text.includes(".embed.b.") || text.includes(".embed.c.")
            ? EMBED_DIM + 2
            : EMBED_DIM;
        return stableEmbed(text, dim);
      }
      return stableEmbed(text, EMBED_DIM);
    },
  };

  return {
    model,
    isNetworkAllowed: () => networkAllowed,
    setNetworkAllowed: (allowed) => {
      networkAllowed = allowed;
    },
    subjectToken,
  };
}
