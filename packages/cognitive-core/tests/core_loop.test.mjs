// Unit test for the CognitiveCore loop with fully in-memory bindings.
// Run: node --test tests/  (after pnpm build)
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACT_STAGE_OBLIGATION_ENVELOPE,
  CognitiveCore,
  ToolStageError,
  formatToolCallFence,
} from "../dist/index.js";

function makeBindings(calls, reasoningOverride) {
  return {
    memory: {
      remember: async (item) => {
        calls.push("memory.remember");
        calls.push(item.metadata?.outcome ?? "remember");
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
    reasoning: reasoningOverride ?? {
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
      compose: async (goals, context) => {
        calls.push("planning.compose");
        assert.ok(goals.length >= 1, "compose must receive goals");
        assert.ok(!String(context).includes("hello"), "context must not carry utterance");
        return {
          planId: "p1",
          steps: goals.slice(0, 2).map((g, i) => ({
            stepId: `s${i + 1}`,
            goalId: g.goalId,
            action: `act:${g.goalId}`,
            dependsOn: i > 0 ? [`s${i}`] : [],
            status: i === 0 ? "active" : "pending",
          })),
          rationale: "r-compose",
        };
      },
      revise: async (plan, event) => {
        calls.push("planning.revise");
        return {
          ...plan,
          rationale: `${plan.rationale}|rev:${event.severity}`,
        };
      },
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
      ],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
    },
    knowledge: {
      sources: [],
      retrieve: async () => {
        calls.push("knowledge.retrieve");
        return [{ sourceId: "src", citation: "cite-1", content: "passage", score: 0.7, asOf: "2026-01-01" }];
      },
    },
  };
}

test("turn() runs recall, retrieve, reason, plan, generate, reflect in order", async () => {
  const calls = [];
  const events = [];
  const core = new CognitiveCore(
    { domainId: "demo", charter: "You are a demo agent.", refusals: [], languages: ["en"] },
    makeBindings(calls),
    { emit: (e) => events.push(e) },
  );
  const out = await core.turn({ subjectId: "s1", sessionId: "sess-1", utterance: "hello" });

  assert.equal(out.reply, "grounded reply");
  assert.deepEqual(out.citations, ["cite-1"]);
  assert.equal(out.traceRef, "trace-1");
  assert.ok(out.plan);
  assert.equal(out.plan.planId, "p1");
  assert.equal(out.plan.rationale, "r-compose");
  assert.equal(out.declined, false);
  assert.deepEqual(out.refusalCategories, []);
  assert.deepEqual(calls, [
    "memory.recall",
    "knowledge.retrieve",
    "reasoning.deliberate",
    "planning.compose",
    "model.generate",
    "memory.remember",
    "completed",
  ]);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.plan_stage" &&
        e.outcome === "composed" &&
        e.subjectId === "s1",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "completed" &&
        e.iteration === 0 &&
        e.subjectId === "s1",
    ),
  );
});

test("ACTSTAG-002: tool-call then stop — terminal reply, citations, tool events", async () => {
  const calls = [];
  const events = [];
  const rememberMeta = [];
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: { q: "synth" },
    callId: "call-h1",
  });
  let gen = 0;
  const bindings = makeBindings(calls);
  bindings.memory.remember = async (item) => {
    calls.push("memory.remember");
    calls.push(item.metadata?.outcome ?? "remember");
    rememberMeta.push(item.metadata);
    return { ...item, id: "trace-1" };
  };
  bindings.model.generate = async (messages) => {
    calls.push("model.generate");
    gen += 1;
    if (gen === 1) {
      return { text: fence, finishReason: "tool-call" };
    }
    assert.ok(messages.some((m) => m.role === "assistant"));
    assert.ok(messages.some((m) => m.role === "tool"));
    assert.equal(messages.filter((m) => m.role === "user").length, 1);
    assert.ok(
      !messages.some(
        (m) => m.role === "user" && String(m.content).includes("lookup"),
      ),
      "tool results must not append onto user content",
    );
    return { text: "after-tools reply", finishReason: "stop" };
  };
  bindings.tools.invoke = async (invocation) => {
    calls.push("tools.invoke");
    assert.equal(invocation.toolName, "lookup");
    assert.equal(invocation.invocationId, "call-h1");
    return {
      invocationId: invocation.invocationId,
      status: "ok",
      output: { echo: "lookup" },
      latencyMs: 1,
    };
  };

  const core = new CognitiveCore(
    { domainId: "demo", charter: "You are a demo agent.", refusals: [], languages: ["en"] },
    bindings,
    { emit: (e) => events.push(e) },
  );
  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-act",
    utterance: "SECRET_UTTER_MUST_NOT_IN_TOOL_EVENTS",
  });

  assert.equal(out.reply, "after-tools reply");
  assert.deepEqual(out.citations, ["cite-1"]);
  assert.equal(out.traceRef, "trace-1");
  assert.equal(out.declined, false);
  assert.ok(out.plan);
  assert.equal(calls.filter((c) => c === "model.generate").length, 2);
  assert.ok(calls.includes("tools.invoke"));
  assert.equal(rememberMeta[0]?.toolIterations, 1);
  assert.equal(rememberMeta[0]?.toolInvocations, 1);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "tool_loop" &&
        e.toolName === "lookup" &&
        e.subjectId === "anika-k",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "completed" &&
        e.iteration === 1,
    ),
  );
  assert.ok(
    events.every(
      (e) =>
        e.event !== "cognitive_core.tool_stage" ||
        !JSON.stringify(e).includes("SECRET_UTTER"),
    ),
    "tool_stage events must not include raw utterance",
  );
});

test("ACTSTAG-002: invalid tool-call envelope escalates (not silent skip)", async () => {
  const events = [];
  const bindings = makeBindings([]);
  bindings.model.generate = async () => ({
    text: "```tool_call\nnot-json{{{\n```",
    finishReason: "tool-call",
  });
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    bindings,
    { emit: (e) => events.push(e) },
  );
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "s1",
        sessionId: "sess-bad-env",
        utterance: "hello",
      }),
    (err) =>
      err instanceof ToolStageError &&
      err.obligationId === ACT_STAGE_OBLIGATION_ENVELOPE,
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.outcome === "error" &&
        e.failureClass === "validation",
    ),
  );
});

test("ACTSTAG-002: toolInvokeHook is used (no bare tools.invoke bypass)", async () => {
  const calls = [];
  const fence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "hook-1",
  });
  let gen = 0;
  let hookCalls = 0;
  let bareInvoke = 0;
  const bindings = makeBindings(calls);
  bindings.model.generate = async () => {
    calls.push("model.generate");
    gen += 1;
    if (gen === 1) return { text: fence, finishReason: "tool-call" };
    return { text: "done", finishReason: "stop" };
  };
  bindings.tools.invoke = async (invocation) => {
    bareInvoke += 1;
    return {
      invocationId: invocation.invocationId,
      status: "ok",
      output: null,
      latencyMs: 0,
    };
  };
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    bindings,
    {
      toolInvokeHook: async (invocation, deadlineMs, tools) => {
        hookCalls += 1;
        return tools.invoke(invocation, deadlineMs);
      },
    },
  );
  const out = await core.turn({
    subjectId: "s-hook",
    sessionId: "sess-hook",
    utterance: "x",
  });
  assert.equal(out.reply, "done");
  assert.equal(hookCalls, 1);
  assert.equal(bareInvoke, 1);
});

test("edge: second turn reuses active plan unless revise fires", async () => {
  const calls = [];
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    makeBindings(calls),
  );
  const first = await core.turn({
    subjectId: "s1",
    sessionId: "sess-reuse",
    utterance: "hello",
  });
  assert.equal(first.plan?.planId, "p1");
  const composeCount = calls.filter((c) => c === "planning.compose").length;
  assert.equal(composeCount, 1);

  const second = await core.turn({
    subjectId: "s1",
    sessionId: "sess-reuse",
    utterance: "hello again",
  });
  assert.equal(second.plan?.planId, "p1");
  assert.equal(second.plan?.rationale, first.plan?.rationale);
  assert.equal(calls.filter((c) => c === "planning.compose").length, 1);
  assert.equal(calls.filter((c) => c === "planning.revise").length, 0);
});

test("edge: low-confidence revises active plan and updates rationale", async () => {
  let turn = 0;
  const calls = [];
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    makeBindings(calls, {
      deliberate: async () => {
        turn += 1;
        calls.push("reasoning.deliberate");
        return {
          conclusion: "c",
          confidence: turn === 1 ? 0.9 : 0.1,
          steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
          unresolvedConstraints: [],
        };
      },
    }),
  );
  const first = await core.turn({
    subjectId: "s1",
    sessionId: "sess-rev",
    utterance: "a",
  });
  const second = await core.turn({
    subjectId: "s1",
    sessionId: "sess-rev",
    utterance: "b",
  });
  assert.equal(first.plan?.rationale, "r-compose");
  assert.ok(second.plan?.rationale.includes("rev:blocking"));
  assert.equal(calls.filter((c) => c === "planning.revise").length, 1);
});

test("edge: violation fixture — silent revise fails CK-08.2 on wire-up path", async () => {
  const { PLAN_STAGE_OBLIGATION_RATIONALE, PlanStageError } = await import(
    "../dist/index.js"
  );
  let turn = 0;
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    {
      ...makeBindings([]),
      reasoning: {
        deliberate: async () => {
          turn += 1;
          return {
            conclusion: "c",
            confidence: turn === 1 ? 0.9 : 0.05,
            steps: [{ kind: "inference", statement: "s", evidenceRefs: [] }],
            unresolvedConstraints: [],
          };
        },
      },
      planning: {
        compose: async () => ({
          planId: "px",
          steps: [],
          rationale: "frozen",
        }),
        revise: async (plan) => plan,
        nextStep: () => null,
      },
    },
  );
  await core.turn({ subjectId: "s1", sessionId: "sess-silent", utterance: "a" });
  await assert.rejects(
    () => core.turn({ subjectId: "s1", sessionId: "sess-silent", utterance: "b" }),
    (err) =>
      err instanceof PlanStageError &&
      err.obligationId === PLAN_STAGE_OBLIGATION_RATIONALE,
  );
});

test("edge: concurrent sessions do not share plans (subject/session isolation)", async () => {
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    makeBindings([]),
  );
  const [a, b] = await Promise.all([
    core.turn({ subjectId: "subj-a", sessionId: "sess-a", utterance: "x" }),
    core.turn({ subjectId: "subj-b", sessionId: "sess-b", utterance: "y" }),
  ]);
  assert.ok(a.plan);
  assert.ok(b.plan);
  // Same compose shape but Map keys differ — second turn on A must not see B.
  const a2 = await core.turn({
    subjectId: "subj-a",
    sessionId: "sess-a",
    utterance: "x2",
  });
  assert.equal(a2.plan?.planId, a.plan?.planId);
  assert.equal(a2.plan?.rationale, a.plan?.rationale);
});

test("decline path: unresolved refusal skips generate and explains without charter leak", async () => {
  const calls = [];
  const events = [];
  const refusal = "legal-advice";
  const charter = "SECRET_CHARTER_MUST_NOT_LEAK";
  const core = new CognitiveCore(
    {
      domainId: "clinical-support",
      charter,
      refusals: [refusal, "controlled-prescription"],
      languages: ["en"],
    },
    makeBindings(calls, {
      deliberate: async (request) => {
        calls.push("reasoning.deliberate");
        assert.deepEqual(request.constraints, [refusal, "controlled-prescription"]);
        return {
          conclusion: "Request asks for legal strategy outside clinical scope",
          confidence: 0.1,
          steps: [{ kind: "verification", statement: "refusal hit", evidenceRefs: [] }],
          unresolvedConstraints: [refusal],
        };
      },
    }),
    { emit: (e) => events.push(e) },
  );

  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-decline",
    utterance: "draft my lawsuit against the hospital",
  });

  assert.equal(out.declined, true);
  assert.deepEqual(out.refusalCategories, [refusal]);
  assert.match(out.reply, /decline/i);
  assert.match(out.reply, /legal-advice/);
  assert.doesNotMatch(out.reply, /SECRET_CHARTER/);
  assert.equal(out.citations.length, 0);
  assert.ok(!calls.includes("model.generate"), "decline must not call model.generate");
  assert.ok(calls.includes("declined") || calls.includes("memory.remember"));
  assert.ok(events.some((e) => e.outcome === "declined" && e.subjectId === "anika-k"));
});

test("edge: unresolved cannot-evaluate still declines (conservative)", async () => {
  const calls = [];
  const refusal = "partial-scope.out-of-domain";
  const core = new CognitiveCore(
    {
      domainId: "teacher",
      charter: "charter-hidden",
      refusals: [refusal],
      languages: ["en"],
    },
    makeBindings(calls, {
      deliberate: async () => ({
        conclusion: "Could not verify refusal boundary for mixed request",
        confidence: 0,
        steps: [{ kind: "assumption", statement: "unverifiable", evidenceRefs: [] }],
        unresolvedConstraints: [refusal],
      }),
    }),
  );
  const out = await core.turn({
    subjectId: "s-partial",
    sessionId: "sess-partial",
    utterance: "half classroom / half courtroom advice",
  });
  assert.equal(out.declined, true);
  assert.ok(out.reply.includes(refusal));
  assert.ok(!calls.includes("model.generate"));
});

test("edge: empty subjectId rejected (subject isolation)", async () => {
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    makeBindings([]),
  );
  await assert.rejects(
    () => core.turn({ subjectId: "  ", sessionId: "s", utterance: "x" }),
    /subjectId/,
  );
});
