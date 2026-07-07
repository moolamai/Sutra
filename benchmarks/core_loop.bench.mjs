// Core loop overhead: one CognitiveCore.turn() with instant bindings.
// Measures the reasoning-latency floor the infrastructure itself adds on
// top of whatever models/tools a deployment binds. Should stay well under
// a millisecond.
import { CognitiveCore } from "@moolam/sdk";
import { bench } from "./_shared/bench.mjs";

const instantBindings = {
  memory: {
    remember: async (item) => ({ ...item, id: "m" }),
    recall: async () => [{ item: { id: "m0", subjectId: "s", topicId: "t", text: "prior", kind: "episodic", createdAt: "2026-01-01" }, score: 1 }],
    associate: async () => {},
    forget: async () => {},
    compact: async () => 0,
  },
  model: {
    descriptor: { modelId: "instant", contextWindow: 8192, locality: "on-device", modalities: ["text"] },
    generate: async () => ({ text: "reply", finishReason: "stop" }),
    generateStream: async function* () {
      yield "reply";
    },
    embed: async () => new Float32Array(8),
  },
  reasoning: {
    deliberate: async () => ({
      conclusion: "c",
      confidence: 1,
      steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
      unresolvedConstraints: [],
    }),
  },
  planning: {
    compose: async () => ({ planId: "p", steps: [], rationale: "r" }),
    revise: async (p) => p,
    nextStep: () => null,
  },
  tools: { list: () => [], invoke: async (i) => ({ invocationId: i.invocationId, status: "ok", output: null, latencyMs: 0 }) },
  knowledge: {
    sources: [],
    retrieve: async () => [{ sourceId: "k", citation: "k#1", content: "passage", score: 1, asOf: "2026-01-01" }],
  },
};

const core = new CognitiveCore(
  { domainId: "bench", charter: "bench", refusals: [], languages: ["en"] },
  instantBindings,
);

await bench("core loop overhead per turn", () =>
  core.turn({ subjectId: "s", sessionId: "sess", utterance: "benchmark utterance" }),
  { warmup: 100, iterations: 1000 },
);
