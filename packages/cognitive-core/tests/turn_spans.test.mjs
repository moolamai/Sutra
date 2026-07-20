/**
 * CognitiveCore.turn parent/child spans (metadata only).
 * Run: pnpm --filter @moolam/cognitive-core test  (after build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ALLOWED_TURN_ATTR_KEYS,
  TURN_STAGE_NAMES,
  createTurnInstrumentation,
  initObservability,
  shutdownObservability,
} from "@moolam/observability";
import { CognitiveCore } from "../dist/index.js";

function makeBindings(overrides = {}) {
  return {
    memory: {
      remember: async (item) => ({ ...item, id: "trace-1" }),
      recall: async () => [
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
      generate: async () => ({ text: "grounded reply", finishReason: "stop" }),
      generateStream: async function* () {
        yield "grounded reply";
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async () => ({
        conclusion: "conclusion",
        confidence: 0.8,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
        unresolvedConstraints: [],
      }),
    },
    planning: {
      compose: async () => ({ planId: "p1", steps: [], rationale: "r" }),
      revise: async (plan) => plan,
      nextStep: () => null,
    },
    tools: {
      list: () => [],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
    },
    knowledge: {
      sources: [],
      retrieve: async () => [
        {
          sourceId: "src",
          citation: "cite-1",
          content: "passage",
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
  charter: "You are a demo agent.",
  refusals: [],
  languages: ["en"],
};

test("happy path: turn produces full parent/child span tree (metadata only)", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
    serviceName: "cognitive-core-turn-spans",
  });
  const core = new CognitiveCore(profile, makeBindings(), {
    turnInstrumentation: createTurnInstrumentation(obs),
  });

  const out = await core.turn({
    subjectId: "subj-span-a",
    sessionId: "sess-span-1",
    utterance: "SECRET_UTTERANCE_MUST_NOT_APPEAR_IN_SPANS",
  });
  assert.equal(out.declined, false);
  assert.equal(out.reply, "grounded reply");

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();
  await shutdownObservability();

  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.attributes["sutra.subject_id"], "subj-span-a");
  assert.equal(root.attributes["sutra.session_id"], "sess-span-1");

  for (const stage of TURN_STAGE_NAMES) {
    const child = spans.find((s) => s.name === `sutra.turn.${stage}`);
    assert.ok(child, `missing stage ${stage}`);
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(child.attributes["sutra.stage"], stage);
  }

  const blob = JSON.stringify(spans.map((s) => s.attributes));
  assert.doesNotMatch(blob, /SECRET_UTTERANCE/);
  assert.doesNotMatch(blob, /prior context|passage|charter/i);
  for (const s of spans) {
    for (const key of Object.keys(s.attributes ?? {})) {
      assert.ok(
        ALLOWED_TURN_ATTR_KEYS.includes(/** @type {any} */ (key)),
        `unexpected attr ${key}`,
      );
    }
  }
});

test("edge: mid-turn stage failure marks root ERROR and closes children", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const core = new CognitiveCore(
    profile,
    makeBindings({
      reasoning: {
        deliberate: async () => {
          const err = new Error("boom-reason");
          err.code = "REASON_FAIL";
          throw err;
        },
      },
    }),
    { turnInstrumentation: createTurnInstrumentation(obs) },
  );

  await assert.rejects(
    () =>
      core.turn({
        subjectId: "subj-err",
        sessionId: "sess-err",
        utterance: "raw text must not leak",
      }),
    /boom-reason/,
  );

  await obs.forceFlush();
  const spans = capture.getFinishedSpans();
  await obs.shutdown();

  const root = spans.find((s) => s.name === "sutra.turn");
  assert.ok(root);
  assert.equal(root.status.code, 2);
  assert.match(String(root.status.message ?? ""), /stage_failed:reason/);
  assert.doesNotMatch(String(root.status.message ?? ""), /raw text/);
  const reason = spans.find((s) => s.name === "sutra.turn.reason");
  assert.ok(reason);
  assert.equal(reason.status.code, 2);
  assert.ok(reason.endTime[0] > 0 || reason.endTime[1] > 0);
  assert.ok(!spans.some((s) => s.name === "sutra.turn.respond"));
});

test("edge: decline omits respond span (no model.generate placeholder)", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const refusal = "legal-advice";
  const core = new CognitiveCore(
    {
      domainId: "clinical-support",
      charter: "CHARTER_SECRET",
      refusals: [refusal],
      languages: ["en"],
    },
    makeBindings({
      reasoning: {
        deliberate: async () => ({
          conclusion: "out of scope",
          confidence: 0,
          steps: [],
          unresolvedConstraints: [refusal],
        }),
      },
    }),
    { turnInstrumentation: createTurnInstrumentation(obs) },
  );

  const out = await core.turn({
    subjectId: "subj-decline",
    sessionId: "sess-decline",
    utterance: "secret lawsuit request",
  });
  assert.equal(out.declined, true);

  await obs.forceFlush();
  const names = capture.getFinishedSpans().map((s) => s.name);
  await obs.shutdown();

  assert.ok(names.includes("sutra.turn"));
  assert.ok(names.includes("sutra.turn.reason"));
  assert.ok(names.includes("sutra.turn.reflect"));
  assert.ok(!names.includes("sutra.turn.respond"));
  assert.doesNotMatch(JSON.stringify(names), /CHARTER_SECRET|lawsuit/);
});

test("sovereignty: concurrent subjects do not share turn trace ids", async () => {
  const capture = new InMemorySpanExporter();
  const obs = await initObservability({
    exporter: "noop",
    captureExporter: capture,
  });
  const instr = createTurnInstrumentation(obs);
  const coreA = new CognitiveCore(profile, makeBindings(), {
    turnInstrumentation: instr,
  });
  const coreB = new CognitiveCore(profile, makeBindings(), {
    turnInstrumentation: instr,
  });

  await Promise.all([
    coreA.turn({ subjectId: "subj-x", sessionId: "sx", utterance: "u1" }),
    coreB.turn({ subjectId: "subj-y", sessionId: "sy", utterance: "u2" }),
  ]);

  await obs.forceFlush();
  const roots = capture
    .getFinishedSpans()
    .filter((s) => s.name === "sutra.turn");
  await obs.shutdown();

  assert.equal(roots.length, 2);
  assert.notEqual(
    roots[0].spanContext().traceId,
    roots[1].spanContext().traceId,
  );
  const subjects = new Set(roots.map((r) => r.attributes["sutra.subject_id"]));
  assert.deepEqual([...subjects].sort(), ["subj-x", "subj-y"]);
});
