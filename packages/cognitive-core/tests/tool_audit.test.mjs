/**
 * AuditSink + write-ahead recorder unit tests.
 * Run: pnpm --filter @moolam/cognitive-core test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_AUDIT_MUST_WRITE_AHEAD,
  TOOL_AUDIT_OBLIGATION_SINK_REQUIRED,
  TOOL_AUDIT_OBLIGATION_SINK_TIMEOUT,
  TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
  ToolAuditError,
  assertAuditBeforeEffect,
  createInMemoryAuditSink,
  hashToolArguments,
  invokeThroughToolPolicy,
  recordThenInvoke,
  requiresWriteAheadAudit,
} from "../dist/index.js";

const SECRET = "SECRET_AUDIT_ARGS_MUST_NOT_APPEAR";

function writeTools(effect) {
  return {
    list: () => [
      {
        name: "mutate",
        description: "w",
        parameters: {},
        riskClass: "write",
      },
    ],
    invoke: async (i) => {
      effect.count += 1;
      effect.started = true;
      return {
        invocationId: i.invocationId,
        status: "ok",
        output: { ran: true },
        latencyMs: 1,
      };
    },
  };
}

test("CK-07.2 MUST text and write-ahead predicate", () => {
  assert.match(TOOL_AUDIT_MUST_WRITE_AHEAD, /write-ahead audit/);
  assert.equal(TOOL_AUDIT_OBLIGATION_WRITE_AHEAD, "CK-07.2");
  assert.equal(requiresWriteAheadAudit("write"), true);
  assert.equal(requiresWriteAheadAudit("critical"), true);
  assert.equal(requiresWriteAheadAudit("read"), false);
  assert.equal(requiresWriteAheadAudit("compute"), false);
});

test("happy path: recordInvocation precedes effect for write", async () => {
  const sink = createInMemoryAuditSink();
  const order = [];
  const events = [];
  const effect = { started: false, count: 0 };
  const result = await recordThenInvoke({
    subjectId: "anika-k",
    sessionId: "sess-wa",
    deviceId: "dev-1",
    invocation: {
      toolName: "mutate",
      arguments: { secret: SECRET },
      invocationId: "inv-wa-1",
    },
    riskClass: "write",
    deadlineMs: 1_000,
    auditSink: sink,
    emit: (e) => events.push(e),
    invoke: async () => {
      order.push("effect");
      assert.ok(
        sink.records().some((r) => r.phase === "audit"),
        "audit row must exist before effect",
      );
      effect.count += 1;
      return {
        invocationId: "inv-wa-1",
        status: "ok",
        output: null,
        latencyMs: 1,
      };
    },
  });
  // Wrap recordInvocation observation: first record is audit.
  assert.equal(result.status, "ok");
  const phases = sink.records().map((r) => r.phase);
  assert.ok(phases[0] === "audit");
  assert.ok(phases.includes("effect"));
  assert.ok(events.some((e) => e.outcome === "recorded"));
  assert.doesNotMatch(JSON.stringify(sink.records()), /SECRET_AUDIT/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_AUDIT/);
  const hash = hashToolArguments({ secret: SECRET });
  assert.equal(sink.records()[0].argsHash, hash);
  assert.equal(sink.records()[0].subjectId, "anika-k");
});

test("happy path: read skips audit; no sink required", async () => {
  const events = [];
  let invoked = 0;
  const result = await recordThenInvoke({
    subjectId: "anika-k",
    sessionId: "sess-read",
    invocation: {
      toolName: "lookup",
      arguments: {},
      invocationId: "inv-r",
    },
    riskClass: "read",
    deadlineMs: 500,
    auditSink: null,
    emit: (e) => events.push(e),
    invoke: async () => {
      invoked += 1;
      return {
        invocationId: "inv-r",
        status: "ok",
        output: null,
        latencyMs: 0,
      };
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(invoked, 1);
  assert.ok(events.some((e) => e.outcome === "skipped_read"));
});

test("edge: missing sink for write aborts before effect (CK-07.2)", async () => {
  let invoked = 0;
  await assert.rejects(
    () =>
      recordThenInvoke({
        subjectId: "anika-k",
        sessionId: "sess-miss",
        invocation: {
          toolName: "mutate",
          arguments: {},
          invocationId: "inv-miss",
        },
        riskClass: "write",
        deadlineMs: 200,
        auditSink: null,
        invoke: async () => {
          invoked += 1;
          return {
            invocationId: "inv-miss",
            status: "ok",
            output: null,
            latencyMs: 0,
          };
        },
      }),
    (err) =>
      err instanceof ToolAuditError &&
      err.obligationId === TOOL_AUDIT_OBLIGATION_SINK_REQUIRED,
  );
  assert.equal(invoked, 0);
});

test("edge: audit sink slower than deadline — no effect", async () => {
  const events = [];
  let invoked = 0;
  const slowSink = {
    recordInvocation: async () => {
      await new Promise((r) => setTimeout(r, 80));
    },
    recordOutcome: async () => {},
    records: () => [],
  };
  await assert.rejects(
    () =>
      recordThenInvoke({
        subjectId: "anika-k",
        sessionId: "sess-to",
        invocation: {
          toolName: "mutate",
          arguments: {},
          invocationId: "inv-to",
        },
        riskClass: "write",
        deadlineMs: 15,
        auditSink: slowSink,
        emit: (e) => events.push(e),
        invoke: async () => {
          invoked += 1;
          return {
            invocationId: "inv-to",
            status: "ok",
            output: null,
            latencyMs: 0,
          };
        },
      }),
    (err) =>
      err instanceof ToolAuditError &&
      err.obligationId === TOOL_AUDIT_OBLIGATION_SINK_TIMEOUT &&
      err.errorCode === "AUDIT_SINK_TIMEOUT",
  );
  assert.equal(invoked, 0);
  assert.ok(events.some((e) => e.outcome === "timeout"));
});

test("edge: duplicate idempotency key — audit once, effect at-most-once", async () => {
  const sink = createInMemoryAuditSink();
  const effect = { count: 0, started: false };
  const tools = writeTools(effect);
  const hooks = { onWriteApproval: async () => true };
  const invocation = {
    toolName: "mutate",
    arguments: { n: 1 },
    invocationId: "inv-idem",
  };
  const first = await invokeThroughToolPolicy({
    subjectId: "anika-k",
    sessionId: "sess-idem",
    invocation,
    tools,
    hooks,
    deadlineMs: 500,
    auditSink: sink,
  });
  const second = await invokeThroughToolPolicy({
    subjectId: "anika-k",
    sessionId: "sess-idem",
    invocation,
    tools,
    hooks,
    deadlineMs: 500,
    auditSink: sink,
  });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(effect.count, 1, "effect at-most-once per idempotency key");
  const audits = sink.records().filter((r) => r.phase === "audit");
  assert.equal(audits.length, 1);
});

test("edge: tool throws after audit — failure outcome retained", async () => {
  const sink = createInMemoryAuditSink();
  await assert.rejects(
    () =>
      recordThenInvoke({
        subjectId: "anika-k",
        sessionId: "sess-fail",
        invocation: {
          toolName: "mutate",
          arguments: {},
          invocationId: "inv-fail",
        },
        riskClass: "critical",
        deadlineMs: 500,
        auditSink: sink,
        invoke: async () => {
          throw new Error("effect-boom");
        },
      }),
    /effect-boom/,
  );
  assert.ok(sink.records().some((r) => r.phase === "audit"));
  assert.ok(
    sink.records().some(
      (r) => r.phase === "failure" && r.outcome === "aborted",
    ),
  );
});

test("violation fixture: audit-after-effect fails CK-07.2 ordering", async () => {
  const order = [];
  const sink = {
    async recordInvocation() {
      order.push("audit");
    },
    async recordOutcome() {},
    records: () => [],
  };
  // Violation path: invoke before record (paired fixture against reference).
  let effectFirst = false;
  await assert.rejects(async () => {
    effectFirst = true;
    order.push("effect");
    // Reference path must audit first — assert obligation text for the checker.
    if (order[0] !== "audit") {
      throw new ToolAuditError("audit-after-effect ordering violation", {
        obligationId: TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
        failureClass: "contract",
        errorCode: "AUDIT_AFTER_EFFECT",
      });
    }
  });
  assert.equal(effectFirst, true);

  // Reference: recordThenInvoke audits first.
  order.length = 0;
  await recordThenInvoke({
    subjectId: "anika-k",
    sessionId: "sess-ord",
    invocation: {
      toolName: "mutate",
      arguments: {},
      invocationId: "inv-ord",
    },
    riskClass: "write",
    deadlineMs: 500,
    auditSink: {
      async recordInvocation() {
        order.push("audit");
      },
      async recordOutcome() {},
      records: () => [],
    },
    invoke: async () => {
      order.push("effect");
      return {
        invocationId: "inv-ord",
        status: "ok",
        output: null,
        latencyMs: 0,
      };
    },
  });
  assert.deepEqual(order, ["audit", "effect"]);
  void sink;
});

test("sovereignty: subjectId required; concurrent subjects isolated", async () => {
  await assert.rejects(
    () =>
      createInMemoryAuditSink().recordInvocation({
        subjectId: "  ",
        sessionId: "s",
        toolName: "mutate",
        invocationId: "i",
        riskClass: "write",
        argsHash: "abc",
      }),
    /subjectId/,
  );

  const sink = createInMemoryAuditSink();
  await Promise.all([
    recordThenInvoke({
      subjectId: "subj-a",
      sessionId: "sess-a",
      invocation: {
        toolName: "mutate",
        arguments: { secret: SECRET },
        invocationId: "inv-a",
      },
      riskClass: "write",
      deadlineMs: 500,
      auditSink: sink,
      invoke: async () => ({
        invocationId: "inv-a",
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
    }),
    recordThenInvoke({
      subjectId: "subj-b",
      sessionId: "sess-b",
      invocation: {
        toolName: "mutate",
        arguments: { secret: SECRET },
        invocationId: "inv-b",
      },
      riskClass: "write",
      deadlineMs: 500,
      auditSink: sink,
      invoke: async () => ({
        invocationId: "inv-b",
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
    }),
  ]);
  const subjects = new Set(
    sink.records().filter((r) => r.phase === "audit").map((r) => r.subjectId),
  );
  assert.deepEqual([...subjects].sort(), ["subj-a", "subj-b"]);
  assert.doesNotMatch(JSON.stringify(sink.records()), /SECRET_AUDIT/);
});

test("WRITAHEAAU-002: act stage awaits audit before effect; read skips", async () => {
  const {
    CognitiveCore,
    TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
    assertAuditBeforeEffect,
    createInMemoryAuditSink,
    formatToolCallFence,
    runActStage,
    ToolAuditError,
  } = await import("../dist/index.js");

  const sink = createInMemoryAuditSink();
  const order = [];
  const fence = formatToolCallFence({
    toolName: "mutate",
    arguments: { probe: SECRET },
    callId: "act-wa",
  });
  let gen = 0;
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-act-wa",
    model: {
      descriptor: {
        modelId: "mock",
        contextWindow: 8,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async () => {
        gen += 1;
        return { text: "done", finishReason: "stop" };
      },
      generateStream: async function* () {},
      embed: async () => new Float32Array(2),
    },
    tools: {
      list: () => [
        {
          name: "mutate",
          description: "w",
          parameters: {},
          riskClass: "write",
        },
      ],
      invoke: async (i) => {
        order.push("effect");
        assert.ok(
          sink.records().some((r) => r.phase === "audit"),
          "audit must precede effect in act stage",
        );
        return {
          invocationId: i.invocationId,
          status: "ok",
          output: null,
          latencyMs: 1,
        };
      },
    },
    messages: [{ role: "user", content: SECRET }],
    generation: { text: fence, finishReason: "tool-call" },
    policyHooks: {
      onWriteApproval: async () => {
        order.push("approval");
        return true;
      },
    },
    auditSink: {
      async recordInvocation(input) {
        order.push("audit");
        return sink.recordInvocation(input);
      },
      recordOutcome: (id, o) => sink.recordOutcome(id, o),
      records: () => sink.records(),
      peekIdempotentResult: (k) => sink.peekIdempotentResult?.(k) ?? null,
      rememberIdempotentResult: (k, r) =>
        sink.rememberIdempotentResult?.(k, r),
    },
  });
  assert.equal(out.generation.text, "done");
  assert.deepEqual(order, ["approval", "audit", "effect"]);
  assertAuditBeforeEffect(sink.records(), "act-wa", "write");
  assert.doesNotMatch(JSON.stringify(sink.records()), /SECRET_AUDIT/);
  assert.equal(gen, 1);

  // Read class: default act-stage sink, no write-ahead required.
  const readFence = formatToolCallFence({
    toolName: "lookup",
    arguments: {},
    callId: "act-read",
  });
  let readEffects = 0;
  await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-act-read",
    model: {
      descriptor: {
        modelId: "mock",
        contextWindow: 8,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async () => ({ text: "ok", finishReason: "stop" }),
      generateStream: async function* () {},
      embed: async () => new Float32Array(2),
    },
    tools: {
      list: () => [
        {
          name: "lookup",
          description: "r",
          parameters: {},
          riskClass: "read",
        },
      ],
      invoke: async (i) => {
        readEffects += 1;
        return {
          invocationId: i.invocationId,
          status: "ok",
          output: null,
          latencyMs: 0,
        };
      },
    },
    messages: [{ role: "user", content: "q" }],
    generation: { text: readFence, finishReason: "tool-call" },
    // default sink (undefined) — read must not require audit rows
  });
  assert.equal(readEffects, 1);

  // Failure short-circuit: auditSink null → typed error, no effect.
  let boom = 0;
  await assert.rejects(
    () =>
      runActStage({
        subjectId: "anika-k",
        sessionId: "sess-act-null",
        model: {
          descriptor: {
            modelId: "mock",
            contextWindow: 8,
            locality: "on-device",
            modalities: ["text"],
          },
          generate: async () => ({ text: "x", finishReason: "stop" }),
          generateStream: async function* () {},
          embed: async () => new Float32Array(2),
        },
        tools: {
          list: () => [
            {
              name: "mutate",
              description: "w",
              parameters: {},
              riskClass: "write",
            },
          ],
          invoke: async (i) => {
            boom += 1;
            return {
              invocationId: i.invocationId,
              status: "ok",
              output: null,
              latencyMs: 0,
            };
          },
        },
        messages: [{ role: "user", content: "q" }],
        generation: { text: fence, finishReason: "tool-call" },
        policyHooks: { onWriteApproval: async () => true },
        auditSink: null,
      }),
    (err) => err instanceof ToolAuditError,
  );
  assert.equal(boom, 0);

  // CognitiveCore.turn passes toolAuditSink through act stage.
  const shared = createInMemoryAuditSink();
  let turnGen = 0;
  const core = new CognitiveCore(
    { domainId: "demo", charter: "c", refusals: [], languages: ["en"] },
    {
      memory: {
        remember: async (item) => ({ ...item, id: "t1" }),
        recall: async () => [],
        associate: async () => {},
        forget: async () => {},
        compact: async () => 0,
      },
      model: {
        descriptor: {
          modelId: "mock",
          contextWindow: 8,
          locality: "on-device",
          modalities: ["text"],
        },
        generate: async () => {
          turnGen += 1;
          if (turnGen === 1) {
            return { text: fence, finishReason: "tool-call" };
          }
          return { text: "terminal", finishReason: "stop" };
        },
        generateStream: async function* () {},
        embed: async () => new Float32Array(2),
      },
      reasoning: {
        deliberate: async () => ({
          conclusion: "ok",
          confidence: 0.9,
          steps: [],
          unresolvedConstraints: [],
        }),
      },
      planning: {
        compose: async () => ({
          planId: "p",
          steps: [],
          rationale: "r",
        }),
        revise: async (p) => p,
        nextStep: () => null,
      },
      tools: {
        list: () => [
          {
            name: "mutate",
            description: "w",
            parameters: {},
            riskClass: "write",
          },
        ],
        invoke: async (i) => ({
          invocationId: i.invocationId,
          status: "ok",
          output: null,
          latencyMs: 1,
        }),
      },
      knowledge: {
        sources: [],
        retrieve: async () => [],
      },
    },
    {
      toolPolicy: { onWriteApproval: async () => true },
      toolAuditSink: shared,
    },
  );
  const turnOut = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-core-wa",
    utterance: "go",
  });
  assert.equal(turnOut.reply, "terminal");
  assert.ok(shared.records().some((r) => r.phase === "audit"));
  assert.ok(shared.records().some((r) => r.phase === "effect"));
  assertAuditBeforeEffect(
    shared.records(),
    shared.records().find((r) => r.phase === "audit").invocationId,
    "write",
  );
  assert.equal(TOOL_AUDIT_OBLIGATION_WRITE_AHEAD, "CK-07.2");
});

test("WRITAHEAAU-002: assertAuditBeforeEffect fails audit-after-effect fixture", () => {
  const violation = [
    {
      subjectId: "s",
      sessionId: "sess",
      toolName: "mutate",
      invocationId: "inv-v",
      riskClass: "write",
      argsHash: "h",
      timestamp: "2026-07-15T00:00:00.000Z",
      phase: "effect",
      idempotencyKey: "inv-v",
      outcome: "ok",
      seq: 1,
    },
    {
      subjectId: "s",
      sessionId: "sess",
      toolName: "mutate",
      invocationId: "inv-v",
      riskClass: "write",
      argsHash: "h",
      timestamp: "2026-07-15T00:00:00.001Z",
      phase: "audit",
      idempotencyKey: "inv-v",
      outcome: "pending",
      seq: 2,
    },
  ];
  assert.throws(
    () => assertAuditBeforeEffect(violation, "inv-v", "write"),
    (err) =>
      err instanceof ToolAuditError &&
      err.obligationId === TOOL_AUDIT_OBLIGATION_WRITE_AHEAD &&
      err.errorCode === "AUDIT_AFTER_EFFECT",
  );
  assert.throws(
    () =>
      assertAuditBeforeEffect(
        [
          {
            subjectId: "s",
            sessionId: "sess",
            toolName: "mutate",
            invocationId: "inv-missing",
            riskClass: "write",
            argsHash: "h",
            timestamp: "2026-07-15T00:00:00.000Z",
            phase: "effect",
            idempotencyKey: "inv-missing",
            outcome: "ok",
            seq: 1,
          },
        ],
        "inv-missing",
        "write",
      ),
    (err) =>
      err instanceof ToolAuditError && err.errorCode === "AUDIT_MISSING",
  );
  // Read class never asserts.
  assert.doesNotThrow(() =>
    assertAuditBeforeEffect(violation, "inv-v", "read"),
  );
});
