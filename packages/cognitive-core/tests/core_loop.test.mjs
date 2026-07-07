// Unit test for the CognitiveCore loop with fully in-memory bindings.
// Run: node --test tests/  (after pnpm build)
import test from "node:test";
import assert from "node:assert/strict";
import { CognitiveCore } from "../dist/index.js";

function makeBindings(calls) {
  return {
    memory: {
      remember: async (item) => {
        calls.push("memory.remember");
        return { ...item, id: "trace-1" };
      },
      recall: async () => {
        calls.push("memory.recall");
        return [
          {
            item: {
              id: "m1",
              subjectId: "s1",
              topicId: "demo",
              text: "prior context",
              kind: "episodic",
              createdAt: "2026-01-01T00:00:00Z",
            },
            score: 0.9,
          },
        ];
      },
      associate: async () => {},
      forget: async () => {},
      compact: async () => 0,
    },
    model: {
      descriptor: { modelId: "mock", contextWindow: 8192, locality: "on-device", modalities: ["text"] },
      generate: async (messages) => {
        calls.push("model.generate");
        assert.equal(messages[0].role, "system");
        return { text: "grounded reply", finishReason: "stop" };
      },
      generateStream: async function* () {
        yield "grounded reply";
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async (request) => {
        calls.push("reasoning.deliberate");
        assert.ok(request.evidence.length >= 2, "memory + knowledge evidence must both reach reasoning");
        return {
          conclusion: "conclusion",
          confidence: 0.8,
          steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
          unresolvedConstraints: [],
        };
      },
    },
    planning: {
      compose: async () => ({ planId: "p1", steps: [], rationale: "r" }),
      revise: async (plan) => plan,
      nextStep: () => null,
    },
    tools: { list: () => [], invoke: async (i) => ({ invocationId: i.invocationId, status: "ok", output: null, latencyMs: 0 }) },
    knowledge: {
      sources: [],
      retrieve: async () => {
        calls.push("knowledge.retrieve");
        return [{ sourceId: "src", citation: "cite-1", content: "passage", score: 0.7, asOf: "2026-01-01" }];
      },
    },
  };
}

test("turn() runs recall, retrieve, reason, generate, reflect in order", async () => {
  const calls = [];
  const core = new CognitiveCore(
    { domainId: "demo", charter: "You are a demo agent.", refusals: [], languages: ["en"] },
    makeBindings(calls),
  );
  const out = await core.turn({ subjectId: "s1", sessionId: "sess-1", utterance: "hello" });

  assert.equal(out.reply, "grounded reply");
  assert.deepEqual(out.citations, ["cite-1"]);
  assert.equal(out.traceRef, "trace-1");
  assert.equal(out.plan, null);
  assert.deepEqual(calls, [
    "memory.recall",
    "knowledge.retrieve",
    "reasoning.deliberate",
    "model.generate",
    "memory.remember",
  ]);
});
