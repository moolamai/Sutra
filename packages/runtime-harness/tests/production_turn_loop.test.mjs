/**
 * Production turn loop: parser + host + sandbox registry + correction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultGymToolRegistry,
  runProductionTurnLoop,
} from "../dist/production_turn_loop.js";

test("happy path: lookup tool invoke emits TOOL_STATUS success + TURN_COMPLETE", async () => {
  const events = [];
  const result = await runProductionTurnLoop({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    correlationId: "corr-ptl-01",
    turnId: "turn-ptl-01",
    seed: 1,
    chunks: [
      "<thought>consider</thought>",
      '```tool_call\n{"toolName":"lookup","arguments":{"query":"ratio"},"callId":"c1"}\n```',
      "A ratio compares quantities.",
    ],
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.toolInvocations >= 1);
  const types = result.frames.map((f) => f.type);
  assert.ok(types.includes("SESSION_START"));
  assert.ok(types.includes("THOUGHT_DELTA"));
  assert.ok(types.includes("TOOL_STATUS"));
  assert.ok(types.includes("ANSWER_DELTA"));
  assert.equal(types[types.length - 1], "TURN_COMPLETE");
  assert.ok(events.some((e) => e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes("consider"));
});

test("edge: truncated stream ends with HARNESS_ERROR STREAM_TRUNCATED", async () => {
  const result = await runProductionTurnLoop({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    correlationId: "corr-ptl-trunc",
    turnId: "turn-ptl-trunc",
    chunks: ["<thought>x</thought>", "<stream truncated>"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const last = result.frames[result.frames.length - 1];
  assert.equal(last.type, "HARNESS_ERROR");
  assert.equal(last.code, "STREAM_TRUNCATED");
});

test("edge: unknown tool yields TOOL_STATUS error via registry", async () => {
  const registry = createDefaultGymToolRegistry();
  const result = await runProductionTurnLoop({
    subjectId: "anika-k",
    deviceId: "edge-aaaa",
    correlationId: "corr-ptl-unk",
    turnId: "turn-ptl-unk",
    registry,
    chunks: [
      '```tool_call\n{"toolName":"nope","arguments":{},"callId":"c2"}\n```',
      "ok",
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const err = result.frames.find(
    (f) => f.type === "TOOL_STATUS" && f.status === "error",
  );
  assert.ok(err);
  assert.match(String(err.detail), /unknown_tool/);
});

function summarizeArgs(subjectId, content) {
  return {
    state: {
      subjectId,
      deviceId: "edge-aaaa",
      sessionId: "session-summarize-01",
      openConstraints: ["Keep citations."],
      citationRefs: ["source:ratio"],
    },
    modelCard: {
      modelId: "slm-summarize-test",
      contextWindow: 100,
    },
    context: {
      messages: [{ role: "user", content }],
    },
  };
}

function summarizeContext(subjectId, invocationId) {
  return {
    subjectId,
    deviceId: "edge-aaaa",
    invocationId,
    idempotencyKey: invocationId,
    deadlineMs: 100,
  };
}

test("learned summarize registration: flag, 75% trigger, fallback, isolation", async () => {
  const flagOff = createDefaultGymToolRegistry();
  const explicitlyOff = createDefaultGymToolRegistry({
    learnedSummarize: {
      enabled: false,
      summarize: async () => "must-not-run",
    },
  });
  assert.equal(
    JSON.stringify(explicitlyOff.list()),
    JSON.stringify(flagOff.list()),
    "flag-off registry must remain byte-identical",
  );
  assert.equal(flagOff.get("summarize_session_state"), undefined);

  const events = [];
  let calls = 0;
  const enabled = createDefaultGymToolRegistry({
    learnedSummarize: {
      enabled: true,
      summarize: async () => {
        calls += 1;
        return "learned compact summary";
      },
      onTelemetry: (event) => events.push(event),
    },
  });
  assert.equal(
    enabled.get("summarize_session_state")?.descriptor.riskClass,
    "compute",
  );

  const below = await enabled.runEffect(
    "summarize_session_state",
    summarizeArgs("anika-k", "x".repeat(292)),
    summarizeContext("anika-k", "summ-below"),
  );
  assert.equal(below.ok, true);
  assert.equal(below.compacted, false, "74% remains below trigger");
  assert.equal(below.route, "deterministic");
  assert.equal(calls, 0, "learned summarizer must not run below threshold");

  const atThreshold = await enabled.runEffect(
    "summarize_session_state",
    summarizeArgs("anika-k", "x".repeat(300)),
    summarizeContext("anika-k", "summ-at-threshold"),
  );
  assert.equal(atThreshold.ok, true);
  assert.equal(atThreshold.compacted, true, "75% triggers compaction");
  assert.equal(atThreshold.route, "learned");
  assert.equal(atThreshold.summary, "learned compact summary");
  assert.equal(calls, 1);

  const timeoutEvents = [];
  const timeoutRegistry = createDefaultGymToolRegistry({
    learnedSummarize: {
      enabled: true,
      timeoutMs: 5,
      summarize: async () => await new Promise(() => {}),
      onTelemetry: (event) => timeoutEvents.push(event),
    },
  });
  const fallback = await timeoutRegistry.runEffect(
    "summarize_session_state",
    summarizeArgs("anika-k", "x".repeat(300)),
    summarizeContext("anika-k", "summ-timeout"),
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.compacted, true);
  assert.equal(fallback.route, "deterministic");
  assert.equal(fallback.advisory, "learned_timeout");
  assert.match(fallback.summary, /SUTRA_COMPACTION_SUMMARY/);

  const crossSubject = await enabled.runEffect(
    "summarize_session_state",
    summarizeArgs("other-subject", "x".repeat(300)),
    summarizeContext("anika-k", "summ-cross-subject"),
  );
  assert.deepEqual(crossSubject, {
    ok: false,
    failureClass: "cross_subject",
    compacted: false,
  });

  assert.ok(
    events.some(
      (event) =>
        event.outcome === "skipped" &&
        event.subjectId === "anika-k" &&
        event.route === "deterministic",
    ),
  );
  assert.ok(
    timeoutEvents.some(
      (event) =>
        event.outcome === "fallback" &&
        event.failureClass === "learned_timeout",
    ),
  );
  const serialized = JSON.stringify([...events, ...timeoutEvents]);
  assert.ok(!serialized.includes("learned compact summary"));
  assert.ok(!serialized.includes("Keep citations."));
});
