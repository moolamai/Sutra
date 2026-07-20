/**
 * Act-stage integration tests (tool-call finishReason + folding).
 *
 * Mock model through the full CognitiveCore.turn path:
 *   tool-call → invoke → re-generate … → stop → reflect
 *   invalid envelope → structured error without reflect
 *
 * Run: pnpm --filter @moolam/cognitive-core test  (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACT_STAGE_MAX_ITERATIONS,
  ACT_STAGE_OBLIGATION_ENVELOPE,
  ACT_STAGE_OBLIGATION_MAX_ITERATIONS,
  CognitiveCore,
  ToolStageError,
  formatToolCallFence,
  runActStage,
} from "../dist/index.js";

const SECRET_UTTERANCE = "SECRET_LEARNER_UTTER_ACT_MUST_NOT_LEAK";

function freshTracker(extra = {}) {
  return {
    generateSeq: 0,
    generateScripts: null,
    invokeNames: [],
    rememberOutcomes: [],
    lastGenerateMessages: null,
    hookCalls: 0,
    ...extra,
  };
}

function makeActBindings(tracker, overrides = {}) {
  return {
    memory: {
      remember: async (item) => {
        tracker.rememberOutcomes.push(item.metadata?.outcome ?? "remember");
        return { ...item, id: `trace-act-${tracker.rememberOutcomes.length}` };
      },
      recall: async () => [
        {
          item: {
            id: "m1",
            subjectId: "anika-k",
            topicId: "demo",
            text: "prior",
            kind: "episodic",
            createdAt: "2026-07-15T00:00:00Z",
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
      generate: async (messages) => {
        tracker.generateSeq += 1;
        tracker.lastGenerateMessages = messages.map((m) => ({ ...m }));
        const script = tracker.generateScripts?.[tracker.generateSeq - 1];
        if (typeof script === "function") return script(messages);
        if (script) return script;
        return { text: "default-stop", finishReason: "stop" };
      },
      generateStream: async function* () {
        yield "stream";
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async () => ({
        conclusion: "ok",
        confidence: 0.85,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
        unresolvedConstraints: [],
      }),
    },
    planning: {
      compose: async (goals) => ({
        planId: "plan-act-int",
        steps: goals.slice(0, 1).map((g) => ({
          stepId: "s1",
          goalId: g.goalId,
          action: `act:${g.goalId}`,
          dependsOn: [],
          status: "active",
        })),
        rationale: "compose",
      }),
      revise: async (plan, event) => ({
        ...plan,
        rationale: `${plan.rationale}|rev:${event.severity}`,
      }),
      nextStep: () => null,
    },
    tools: {
      list: () => [
        {
          name: "lookup",
          description: "read",
          parameters: { type: "object" },
          riskClass: "read",
        },
        {
          name: "calc",
          description: "calc",
          parameters: { type: "object" },
          riskClass: "read",
        },
      ],
      invoke: async (invocation) => {
        tracker.invokeNames.push(invocation.toolName);
        return {
          invocationId: invocation.invocationId,
          status: "ok",
          output: { tool: invocation.toolName },
          latencyMs: 1,
        };
      },
    },
    knowledge: {
      sources: [],
      retrieve: async () => [
        {
          sourceId: "src",
          citation: "cite-1",
          content: "passage",
          score: 0.7,
          asOf: "2026-07-15",
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

test("integration happy: alternating tool-call then stop — invoke count, shape, reply", async () => {
  const tracker = freshTracker();
  const events = [];
  const fence1 = formatToolCallFence({
    toolName: "lookup",
    arguments: { q: 1 },
    callId: "c1",
  });
  const fence2 = formatToolCallFence({
    toolName: "calc",
    arguments: { q: 2 },
    callId: "c2",
  });
  tracker.generateScripts = [
    { text: fence1, finishReason: "tool-call" },
    { text: fence2, finishReason: "tool-call" },
    { text: "final folded reply", finishReason: "stop" },
  ];

  const core = new CognitiveCore(profile, makeActBindings(tracker), {
    emit: (e) => events.push(e),
  });
  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-alt",
    utterance: SECRET_UTTERANCE,
  });

  assert.equal(out.reply, "final folded reply");
  assert.deepEqual(out.citations, ["cite-1"]);
  assert.equal(out.traceRef, "trace-act-1");
  assert.equal(out.declined, false);
  assert.deepEqual(tracker.invokeNames, ["lookup", "calc"]);
  assert.equal(tracker.generateSeq, 3);
  assert.deepEqual(tracker.rememberOutcomes, ["completed"]);

  const msgs = tracker.lastGenerateMessages;
  assert.ok(msgs);
  assert.equal(msgs.filter((m) => m.role === "user").length, 1);
  assert.equal(msgs.filter((m) => m.role === "assistant").length, 2);
  assert.equal(msgs.filter((m) => m.role === "tool").length, 2);
  assert.equal(
    msgs.find((m) => m.role === "user").content.includes(SECRET_UTTERANCE),
    true,
  );
  assert.ok(
    !msgs.some(
      (m) => m.role === "user" && String(m.content).includes("lookup"),
    ),
    "tool results must not append onto user content",
  );
  const toolIds = msgs
    .filter((m) => m.role === "tool")
    .map((m) => m.toolCallId);
  assert.deepEqual(toolIds, ["c1", "c2"]);

  assert.equal(
    events.filter(
      (e) => e.event === "cognitive_core.tool_stage" && e.outcome === "tool_loop",
    ).length,
    2,
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "completed" &&
        e.iteration === 2 &&
        e.subjectId === "anika-k",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("integration happy: multiple tool calls in one envelope execute in order", async () => {
  const tracker = freshTracker();
  const fence = formatToolCallFence([
    { toolName: "lookup", arguments: { n: 1 }, callId: "a" },
    { toolName: "calc", arguments: { n: 2 }, callId: "b" },
    { toolName: "lookup", arguments: { n: 3 }, callId: "c" },
  ]);
  tracker.generateScripts = [
    { text: fence, finishReason: "tool-call" },
    { text: "multi done", finishReason: "stop" },
  ];
  const core = new CognitiveCore(profile, makeActBindings(tracker));
  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-multi",
    utterance: "q",
  });
  assert.equal(out.reply, "multi done");
  assert.deepEqual(tracker.invokeNames, ["lookup", "calc", "lookup"]);
  const toolMsgs = tracker.lastGenerateMessages.filter((m) => m.role === "tool");
  assert.deepEqual(
    toolMsgs.map((m) => m.toolCallId),
    ["a", "b", "c"],
  );
});

test("integration edge: invalid envelope escalates without reflect", async () => {
  const tracker = freshTracker();
  const events = [];
  tracker.generateScripts = [
    {
      text: "```tool_call\nnot-json{{{\n```",
      finishReason: "tool-call",
    },
  ];
  const core = new CognitiveCore(profile, makeActBindings(tracker), {
    emit: (e) => events.push(e),
  });
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-bad",
        utterance: SECRET_UTTERANCE,
      }),
    (err) =>
      err instanceof ToolStageError &&
      err.obligationId === ACT_STAGE_OBLIGATION_ENVELOPE,
  );
  assert.equal(tracker.invokeNames.length, 0);
  assert.deepEqual(tracker.rememberOutcomes, [], "reflect must not run");
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "error" &&
        e.failureClass === "validation" &&
        e.subjectId === "anika-k",
    ),
  );
  assert.ok(
    !events.some(
      (e) => e.event === "cognitive_core.turn" && e.outcome === "completed",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("integration edge: stop with open pending stream buffer discards (no invoke)", async () => {
  const invokes = [];
  const events = [];
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-buffer",
    model: {
      descriptor: {
        modelId: "mock",
        contextWindow: 8,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async () => {
        throw new Error("generate must not run on discard path");
      },
      generateStream: async function* () {},
      embed: async () => new Float32Array(2),
    },
    tools: {
      list: () => [],
      invoke: async (i) => {
        invokes.push(i.toolName);
        return {
          invocationId: i.invocationId,
          status: "ok",
          output: null,
          latencyMs: 0,
        };
      },
    },
    messages: [{ role: "user", content: SECRET_UTTERANCE }],
    generation: { text: "terminal", finishReason: "stop" },
    pendingStreamBuffer: '{"toolName":"lookup","arguments":{}}',
    emit: (e) => events.push(e),
  });
  assert.equal(out.discardedPendingBuffer, true);
  assert.equal(invokes.length, 0);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "buffer_discarded",
    ),
  );
});

test("integration edge: maxIterations escalates ACT.MAX_ITERATIONS", async () => {
  const tracker = freshTracker();
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "loop",
  });
  tracker.generateScripts = Array.from(
    { length: ACT_STAGE_MAX_ITERATIONS + 2 },
    () => ({ text: fence, finishReason: "tool-call" }),
  );
  const events = [];
  const core = new CognitiveCore(profile, makeActBindings(tracker), {
    emit: (e) => events.push(e),
  });
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-cap",
        utterance: "x",
      }),
    (err) =>
      err instanceof ToolStageError &&
      err.obligationId === ACT_STAGE_OBLIGATION_MAX_ITERATIONS &&
      err.failureClass === "cap",
  );
  assert.equal(tracker.invokeNames.length, ACT_STAGE_MAX_ITERATIONS);
  assert.deepEqual(tracker.rememberOutcomes, []);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "error" &&
        e.failureClass === "cap",
    ),
  );
});

test("integration edge: partial failure after invoke — no completed reflect", async () => {
  const tracker = freshTracker();
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "p1",
  });
  tracker.generateScripts = [
    { text: fence, finishReason: "tool-call" },
    () => {
      const err = new Error("downstream-generate-timeout");
      err.code = "TIMEOUT";
      throw err;
    },
  ];
  const core = new CognitiveCore(profile, makeActBindings(tracker));
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-partial",
        utterance: "x",
      }),
    /downstream-generate-timeout/,
  );
  assert.deepEqual(tracker.invokeNames, ["lookup"]);
  assert.deepEqual(tracker.rememberOutcomes, []);
});

test("integration edge: concurrent subjects keep tool events isolated", async () => {
  const events = [];
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "iso",
  });

  async function runSubject(subjectId, sessionId) {
    const tracker = freshTracker();
    tracker.generateScripts = [
      { text: fence, finishReason: "tool-call" },
      { text: `reply-${subjectId}`, finishReason: "stop" },
    ];
    const core = new CognitiveCore(profile, makeActBindings(tracker), {
      emit: (e) => events.push(e),
    });
    const out = await core.turn({
      subjectId,
      sessionId,
      utterance: SECRET_UTTERANCE,
    });
    return { out, tracker };
  }

  const [a, b] = await Promise.all([
    runSubject("subj-a", "sess-a"),
    runSubject("subj-b", "sess-b"),
  ]);
  assert.equal(a.out.reply, "reply-subj-a");
  assert.equal(b.out.reply, "reply-subj-b");
  assert.equal(a.tracker.invokeNames.length, 1);
  assert.equal(b.tracker.invokeNames.length, 1);

  const toolEvents = events.filter((e) => e.event === "cognitive_core.tool_stage");
  assert.ok(toolEvents.some((e) => e.subjectId === "subj-a"));
  assert.ok(toolEvents.some((e) => e.subjectId === "subj-b"));
  assert.ok(
    toolEvents.every((e) => e.subjectId === "subj-a" || e.subjectId === "subj-b"),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("integration: toolInvokeHook is required seam on turn path", async () => {
  const tracker = freshTracker();
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "hook",
  });
  tracker.generateScripts = [
    { text: fence, finishReason: "tool-call" },
    { text: "hooked", finishReason: "stop" },
  ];
  const core = new CognitiveCore(profile, makeActBindings(tracker), {
    toolInvokeHook: async (invocation, deadlineMs, tools) => {
      tracker.hookCalls += 1;
      return tools.invoke(invocation, deadlineMs);
    },
  });
  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-hook",
    utterance: "x",
  });
  assert.equal(out.reply, "hooked");
  assert.equal(tracker.hookCalls, 1);
  assert.deepEqual(tracker.invokeNames, ["lookup"]);
});
