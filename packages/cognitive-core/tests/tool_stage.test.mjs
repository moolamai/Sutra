/**
 * Tool_stage unit tests (act-stage tool invocation loop).
 * Run: pnpm --filter @moolam/cognitive-core test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACT_STAGE_MAX_ITERATIONS,
  ACT_STAGE_OBLIGATION_ENVELOPE,
  ACT_STAGE_OBLIGATION_MAX_ITERATIONS,
  ToolStageError,
  formatToolCallFence,
  parseToolCallEnvelope,
  runActStage,
} from "../dist/index.js";

function makeModel(script) {
  let i = 0;
  return {
    descriptor: {
      modelId: "mock",
      contextWindow: 8192,
      locality: "on-device",
      modalities: ["text"],
    },
    generate: async (messages) => {
      const next = script[i] ?? script[script.length - 1];
      i += 1;
      if (typeof next === "function") return next(messages);
      return next;
    },
    generateStream: async function* () {
      yield "";
    },
    embed: async () => new Float32Array(2),
  };
}

function makeTools(tracker) {
  return {
    list: () => [
      {
        name: "lookup",
        description: "read",
        parameters: { type: "object" },
        riskClass: "read",
      },
    ],
    invoke: async (invocation) => {
      tracker.invokes.push({
        toolName: invocation.toolName,
        invocationId: invocation.invocationId,
        arguments: invocation.arguments,
      });
      return {
        invocationId: invocation.invocationId,
        status: "ok",
        output: { echo: invocation.toolName },
        latencyMs: 1,
      };
    },
  };
}

test("happy path: tool-call then stop folds structured tool messages", async () => {
  const tracker = { invokes: [] };
  const events = [];
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: { q: "synth" },
    callId: "call-1",
  });
  const model = makeModel([
    { text: "final answer", finishReason: "stop" },
  ]);
  const base = [
    { role: "system", content: "charter" },
    { role: "user", content: "SECRET_USER_UTTERANCE" },
  ];
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-1",
    model,
    tools: makeTools(tracker),
    messages: base,
    generation: { text: fence, finishReason: "tool-call" },
    emit: (e) => events.push(e),
  });

  assert.equal(out.generation.text, "final answer");
  assert.equal(out.generation.finishReason, "stop");
  assert.equal(out.iterations, 1);
  assert.equal(out.toolInvocations, 1);
  assert.equal(tracker.invokes[0].toolName, "lookup");
  assert.equal(tracker.invokes[0].invocationId, "call-1");

  const roles = out.messages.map((m) => m.role);
  assert.ok(roles.includes("assistant"));
  assert.ok(roles.includes("tool"));
  assert.equal(out.messages.filter((m) => m.role === "user").length, 1);
  const toolMsg = out.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.toolCallId, "call-1");
  assert.ok(!toolMsg.content.includes("SECRET_USER"));
  // Never append tool prose onto the user message.
  assert.equal(
    out.messages.find((m) => m.role === "user").content,
    "SECRET_USER_UTTERANCE",
  );
  assert.ok(
    events.some((e) => e.outcome === "tool_loop" && e.toolName === "lookup"),
  );
  assert.ok(events.some((e) => e.outcome === "completed"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_USER/);
});

test("happy path: multiple tool calls execute in declared order", async () => {
  const tracker = { invokes: [] };
  const fence = formatToolCallFence([
    { toolName: "lookup", arguments: { n: 1 }, callId: "a" },
    { toolName: "lookup", arguments: { n: 2 }, callId: "b" },
  ]);
  const model = makeModel([{ text: "done", finishReason: "stop" }]);
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-2",
    model,
    tools: makeTools(tracker),
    messages: [{ role: "user", content: "q" }],
    generation: { text: fence, finishReason: "tool-call" },
  });
  assert.deepEqual(
    tracker.invokes.map((i) => i.invocationId),
    ["a", "b"],
  );
  assert.equal(out.toolInvocations, 2);
  assert.equal(out.messages.filter((m) => m.role === "tool").length, 2);
});

test("edge: tool-call without valid fence fails ACT.ENVELOPE_INVALID", async () => {
  await assert.rejects(
    () =>
      runActStage({
        subjectId: "anika-k",
        sessionId: "sess-3",
        model: makeModel([]),
        tools: makeTools({ invokes: [] }),
        messages: [],
        generation: {
          text: "please call a tool somehow",
          finishReason: "tool-call",
        },
      }),
    (err) =>
      err instanceof ToolStageError &&
      err.obligationId === ACT_STAGE_OBLIGATION_ENVELOPE &&
      err.errorCode === "ENVELOPE_MISSING_FENCE",
  );
});

test("edge: stop with open pending stream buffer discards buffer (no invoke)", async () => {
  const tracker = { invokes: [] };
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-4",
    model: makeModel([]),
    tools: makeTools(tracker),
    messages: [{ role: "user", content: "q" }],
    generation: { text: "hello", finishReason: "stop" },
    pendingStreamBuffer: '{"toolName":"lookup","arguments":{}}',
  });
  assert.equal(out.discardedPendingBuffer, true);
  assert.equal(tracker.invokes.length, 0);
  assert.equal(out.toolInvocations, 0);
  assert.equal(out.generation.finishReason, "stop");
});

test("edge: exceeding maxIterations fails ACT.MAX_ITERATIONS", async () => {
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "loop",
  });
  const model = makeModel([
    { text: fence, finishReason: "tool-call" },
    { text: fence, finishReason: "tool-call" },
    { text: fence, finishReason: "tool-call" },
  ]);
  await assert.rejects(
    () =>
      runActStage({
        subjectId: "anika-k",
        sessionId: "sess-5",
        model,
        tools: makeTools({ invokes: [] }),
        messages: [{ role: "user", content: "q" }],
        generation: { text: fence, finishReason: "tool-call" },
        maxIterations: 1,
      }),
    (err) =>
      err instanceof ToolStageError &&
      err.obligationId === ACT_STAGE_OBLIGATION_MAX_ITERATIONS &&
      err.failureClass === "cap",
  );
});

test("edge: policy hook is the only invoke path (tools.invoke bypass forbidden)", async () => {
  const direct = { invokes: [] };
  const hooked = { invokes: [] };
  const tools = makeTools(direct);
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "h1",
  });
  await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-6",
    model: makeModel([{ text: "ok", finishReason: "stop" }]),
    tools,
    messages: [],
    generation: { text: fence, finishReason: "tool-call" },
    invokeHook: async (invocation, deadlineMs, t) => {
      hooked.invokes.push(invocation.toolName);
      return t.invoke(invocation, deadlineMs);
    },
  });
  assert.deepEqual(hooked.invokes, ["lookup"]);
  assert.equal(direct.invokes.length, 1);
});

test("parseToolCallEnvelope strips unknown keys and rejects prose", () => {
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: { a: 1 },
    callId: "c1",
    evil: "nope",
  });
  const parsed = parseToolCallEnvelope(fence);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].toolName, "lookup");
  assert.equal(parsed[0].callId, "c1");
  assert.equal("evil" in parsed[0], false);
  assert.throws(
    () => parseToolCallEnvelope("not a fence"),
    (err) => err.obligationId === ACT_STAGE_OBLIGATION_ENVELOPE,
  );
  assert.ok(ACT_STAGE_MAX_ITERATIONS >= 1);
});
