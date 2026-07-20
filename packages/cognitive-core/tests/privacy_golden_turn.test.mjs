/**
 * Golden turn through CognitiveCore — span export privacy.
 * Run: pnpm --filter @moolam/cognitive-core test  (after build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InProcessEventBus } from "@moolam/runtime";
import {
  assertSpanExportPrivacy,
  assertTurnAttrKeysAllowed,
  createTurnInstrumentation,
  initObservability,
  shutdownObservability,
} from "@moolam/observability";
import { CognitiveCore } from "../dist/index.js";

/** Distinctive fixture content — must never appear in exported spans. */
const UTTERANCE =
  "GOLDEN_UTTER_QX7_LEARNER_SAID_THIS typewriter_seq_shift+a_ctrl+v_PIN_448812";
const MEMORY = "GOLDEN_MEM_PASSAGE_YZ9_PRIVATE_RECALL";
const KNOWLEDGE = "GOLDEN_KNOW_PASSAGE_AB3_CORPUS_SECRET";
const CHARTER = "GOLDEN_CHARTER_NO_EXPORT_99_sovereign_host_only";
const REPLY = "GOLDEN_MODEL_REPLY_MUST_STAY_LOCAL";
const TOOL_ARGS = '{"query":"GOLDEN_TOOL_ARGS_JSON_SECRET"}';
const CONCLUSION = "GOLDEN_REASONING_CONCLUSION_PRIVATE";

const PROBES = {
  forbiddenSubstrings: [
    "GOLDEN_UTTER_QX7_LEARNER_SAID_THIS",
    MEMORY,
    KNOWLEDGE,
    CHARTER,
    REPLY,
    TOOL_ARGS,
    CONCLUSION,
    "PIN_448812",
    "typewriter_seq_shift+a",
  ],
  forbiddenPatterns: [/PIN_\d{6}/, /GOLDEN_[A-Z_]+/],
};

function makeBindings(overrides = {}) {
  return {
    memory: {
      remember: async (item) => ({ ...item, id: "trace-golden" }),
      recall: async () => [
        {
          item: {
            id: "m-golden",
            subjectId: "s1",
            topicId: "demo",
            text: MEMORY,
            kind: "episodic",
            createdAt: "2026-01-01T00:00:00Z",
          },
          score: 0.9,
        },
      ],
      associate: async () => {},
      forget: async () => {},
      compact: async () => 0,
    },
    model: {
      descriptor: {
        modelId: "mock",
        contextWindow: 8192,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async () => ({ text: REPLY, finishReason: "stop" }),
      generateStream: async function* () {
        yield REPLY;
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async () => ({
        conclusion: CONCLUSION,
        confidence: 0.8,
        steps: [{ kind: "inference", statement: CONCLUSION, evidenceRefs: [0] }],
        unresolvedConstraints: [],
      }),
    },
    planning: {
      compose: async () => ({ planId: "p1", steps: [], rationale: "r" }),
      revise: async (plan) => plan,
      nextStep: () => null,
    },
    tools: {
      list: () => [{ toolId: "search_corpus", description: TOOL_ARGS }],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        status: "ok",
        output: TOOL_ARGS,
        latencyMs: 1,
      }),
    },
    knowledge: {
      sources: [],
      retrieve: async () => [
        {
          sourceId: "src",
          citation: "cite-golden",
          content: KNOWLEDGE,
          score: 0.7,
          asOf: "2026-01-01",
        },
      ],
    },
    ...overrides,
  };
}

const profile = {
  domainId: "demo",
  charter: CHARTER,
  refusals: [],
  languages: ["en"],
};

test("happy path: golden turn export carries no utterance/memory/keystroke content", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "cognitive-core-privacy-golden",
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });
  const core = new CognitiveCore(profile, makeBindings(), {
    turnInstrumentation: instr,
    eventBus: bus,
  });

  // Publish a tool outcome mid-turn via bus while the harness runs stages.
  const out = await core.turn({
    subjectId: "subj-golden",
    sessionId: "sess-golden",
    utterance: UTTERANCE,
  });
  assert.equal(out.declined, false);
  assert.equal(out.reply, REPLY);

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();
  await shutdownObservability();

  assert.ok(spans.some((s) => s.name === "sutra.turn"));
  for (const stage of [
    "perceive",
    "recall",
    "retrieve",
    "reason",
    "respond",
    "reflect",
  ]) {
    assert.ok(
      spans.some((s) => s.name === `sutra.turn.${stage}`),
      `missing ${stage}`,
    );
  }

  assertSpanExportPrivacy(spans, PROBES);
  assertTurnAttrKeysAllowed(spans);

  // Hard string scan of the full export blob (attributes + events + status).
  const blob = JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      events: s.events,
      status: s.status,
    })),
  );
  assert.doesNotMatch(blob, /GOLDEN_UTTER|GOLDEN_MEM|GOLDEN_KNOW|GOLDEN_CHARTER|GOLDEN_MODEL|GOLDEN_TOOL|GOLDEN_REASONING|PIN_448812/);
});

test("edge: mid-turn failure still closes children without embedding error utterance", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });
  const core = new CognitiveCore(
    profile,
    makeBindings({
      knowledge: {
        sources: [],
        retrieve: async () => {
          throw new Error(`retrieve failed with ${UTTERANCE}`);
        },
      },
    }),
    { turnInstrumentation: instr, eventBus: bus },
  );

  await assert.rejects(
    () =>
      core.turn({
        subjectId: "subj-fail",
        sessionId: "sess-fail",
        utterance: UTTERANCE,
      }),
    /retrieve failed/,
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();

  assertSpanExportPrivacy(spans, PROBES);
  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.status.code, 2);
  assert.doesNotMatch(String(root.status.message ?? ""), /GOLDEN_UTTER|PIN_/);
});

test("edge: decline path omits respond and still holds privacy invariants", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const bus = new InProcessEventBus();
  const instr = createTurnInstrumentation(obs, { eventBus: bus });
  const refusal = "legal-advice";
  const core = new CognitiveCore(
    {
      domainId: "clinical-support",
      charter: CHARTER,
      refusals: [refusal],
      languages: ["en"],
    },
    makeBindings({
      reasoning: {
        deliberate: async () => ({
          conclusion: CONCLUSION,
          confidence: 0,
          steps: [],
          unresolvedConstraints: [refusal],
        }),
      },
    }),
    { turnInstrumentation: instr, eventBus: bus },
  );

  const out = await core.turn({
    subjectId: "subj-decline",
    sessionId: "sess-decline",
    utterance: UTTERANCE,
  });
  assert.equal(out.declined, true);

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  instr.dispose();
  await obs.shutdown();

  assert.ok(!spans.some((s) => s.name === "sutra.turn.respond"));
  assertSpanExportPrivacy(spans, PROBES);
  assertTurnAttrKeysAllowed(spans);
});
