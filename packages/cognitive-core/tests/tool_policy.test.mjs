/**
 * Tool_policy unit tests (risk-class routing + hooks).
 * Run: pnpm --filter @moolam/cognitive-core test (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK_CLASS_ROUTING,
  TOOL_POLICY_MUST_CRITICAL,
  TOOL_POLICY_MUST_WRITE,
  TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT,
  TOOL_POLICY_OBLIGATION_HOOK_MISSING,
  TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
  ToolPolicyError,
  authorizeToolInvocation,
  createToolPolicy,
  defaultDenyToolPolicyHooks,
  invokeThroughToolPolicy,
  resolveRiskClass,
  routeForRiskClass,
} from "../dist/index.js";

const SECRET_ARGS = { secret: "SECRET_LEARNER_ARG_MUST_NOT_LEAK" };

function inv(name = "lookup") {
  return {
    toolName: name,
    arguments: SECRET_ARGS,
    invocationId: `inv-${name}`,
  };
}

test("routing table: read/compute auto; write/critical require affirmative", () => {
  assert.equal(RISK_CLASS_ROUTING.read.mode, "auto");
  assert.equal(RISK_CLASS_ROUTING.compute.mode, "auto");
  assert.equal(RISK_CLASS_ROUTING.write.requiresAffirmative, true);
  assert.equal(RISK_CLASS_ROUTING.critical.requiresAffirmative, true);
  assert.equal(routeForRiskClass("write").hook, "onWriteApproval");
  assert.equal(routeForRiskClass("critical").hook, "onCriticalConfirm");
  assert.match(TOOL_POLICY_MUST_WRITE, /requires policy approval/);
  assert.match(TOOL_POLICY_MUST_CRITICAL, /requires human approval/);
});

test("happy path: read executes without write/critical hooks", async () => {
  const events = [];
  let readCalls = 0;
  let writeCalls = 0;
  let criticalCalls = 0;
  const out = await authorizeToolInvocation({
    subjectId: "anika-k",
    sessionId: "sess-1",
    invocation: inv("lookup"),
    descriptor: { name: "lookup", riskClass: "read" },
    hooks: {
      onReadExecute: async () => {
        readCalls += 1;
      },
      onWriteApproval: async () => {
        writeCalls += 1;
        return true;
      },
      onCriticalConfirm: async () => {
        criticalCalls += 1;
        return true;
      },
    },
    deadlineMs: 1_000,
    emit: (e) => events.push(e),
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.riskClass, "read");
  assert.equal(readCalls, 1);
  assert.equal(writeCalls, 0);
  assert.equal(criticalCalls, 0);
  assert.ok(events.some((e) => e.outcome === "allowed" && e.riskClass === "read"));
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("happy path: compute mirrors read (auto, onReadExecute only)", async () => {
  let readCalls = 0;
  const out = await authorizeToolInvocation({
    subjectId: "anika-k",
    sessionId: "sess-c",
    invocation: inv("calc"),
    descriptor: { name: "calc", riskClass: "compute" },
    hooks: {
      onReadExecute: async () => {
        readCalls += 1;
      },
    },
    deadlineMs: 500,
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.riskClass, "compute");
  assert.equal(readCalls, 1);
});

test("happy path: write allowed after onWriteApproval affirms", async () => {
  let effectArmed = false;
  const out = await authorizeToolInvocation({
    subjectId: "anika-k",
    sessionId: "sess-w",
    invocation: inv("mutate"),
    descriptor: { name: "mutate", riskClass: "write" },
    hooks: {
      onWriteApproval: async () => {
        effectArmed = true;
        return true;
      },
    },
    deadlineMs: 1_000,
  });
  assert.equal(out.outcome, "allow");
  assert.equal(effectArmed, true);
});

test("happy path: critical allowed after onCriticalConfirm affirms", async () => {
  const out = await authorizeToolInvocation({
    subjectId: "anika-k",
    sessionId: "sess-k",
    invocation: inv("irreversible"),
    descriptor: { name: "irreversible", riskClass: "critical" },
    hooks: {
      onCriticalConfirm: async () => true,
    },
    deadlineMs: 1_000,
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.riskClass, "critical");
});

test("edge: write without onWriteApproval hard-stops (no silent execute)", async () => {
  await assert.rejects(
    () =>
      authorizeToolInvocation({
        subjectId: "anika-k",
        sessionId: "sess-miss",
        invocation: inv("mutate"),
        descriptor: { name: "mutate", riskClass: "write" },
        hooks: defaultDenyToolPolicyHooks,
        deadlineMs: 500,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING &&
      err.failureClass === "config" &&
      err.errorCode === "WRITE_HOOK_MISSING",
  );
});

test("edge: critical without onCriticalConfirm hard-stops", async () => {
  await assert.rejects(
    () =>
      authorizeToolInvocation({
        subjectId: "anika-k",
        sessionId: "sess-miss-c",
        invocation: inv("boom"),
        descriptor: { name: "boom", riskClass: "critical" },
        hooks: {},
        deadlineMs: 500,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING &&
      err.errorCode === "CRITICAL_HOOK_MISSING",
  );
});

test("edge: denied write approval returns ToolResult denied (not thrown)", async () => {
  const events = [];
  const out = await authorizeToolInvocation({
    subjectId: "anika-k",
    sessionId: "sess-deny",
    invocation: inv("mutate"),
    descriptor: { name: "mutate", riskClass: "write" },
    hooks: {
      onWriteApproval: async () => false,
    },
    deadlineMs: 500,
    emit: (e) => events.push(e),
  });
  assert.equal(out.outcome, "deny");
  assert.equal(out.result.status, "denied");
  assert.equal(out.result.invocationId, "inv-mutate");
  assert.ok(events.some((e) => e.outcome === "denied"));
});

test("edge: approval after deadline → timeout; effect never started", async () => {
  let effectStarted = false;
  const events = [];
  await assert.rejects(
    () =>
      authorizeToolInvocation({
        subjectId: "anika-k",
        sessionId: "sess-to",
        invocation: inv("mutate"),
        descriptor: { name: "mutate", riskClass: "write" },
        hooks: {
          onWriteApproval: async () => {
            await new Promise((r) => setTimeout(r, 80));
            effectStarted = true;
            return true;
          },
        },
        deadlineMs: 15,
        emit: (e) => events.push(e),
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT &&
      err.failureClass === "cap",
  );
  // Approval may still resolve later; policy must not have returned allow.
  assert.equal(effectStarted, false);
  assert.ok(
    events.some(
      (e) => e.outcome === "error" && e.errorCode === "WRITE_APPROVAL_TIMEOUT",
    ),
  );
});

test("edge: missing riskClass treated as write + advisory", async () => {
  const events = [];
  const resolved = resolveRiskClass({});
  assert.equal(resolved.riskClass, "write");
  assert.equal(resolved.assumedWrite, true);

  await assert.rejects(
    () =>
      authorizeToolInvocation({
        subjectId: "anika-k",
        sessionId: "sess-assume",
        invocation: inv("mystery"),
        descriptor: { name: "mystery", riskClass: undefined },
        hooks: defaultDenyToolPolicyHooks,
        deadlineMs: 200,
        emit: (e) => events.push(e),
      }),
    (err) => err instanceof ToolPolicyError,
  );
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "assumed_write" &&
        e.errorCode === TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
    ),
  );
});

test("edge: null descriptor fails safe to write", async () => {
  const policy = createToolPolicy({
    onWriteApproval: async () => true,
  });
  const out = await policy.authorize({
    subjectId: "anika-k",
    sessionId: "sess-null",
    invocation: inv("unknown"),
    descriptor: null,
    deadlineMs: 500,
  });
  assert.equal(out.outcome, "allow");
  assert.equal(out.assumedWrite, true);
  assert.equal(out.riskClass, "write");
});

test("sovereignty: empty subjectId rejected; events never carry args", async () => {
  await assert.rejects(
    () =>
      authorizeToolInvocation({
        subjectId: "  ",
        sessionId: "s",
        invocation: inv(),
        descriptor: { name: "lookup", riskClass: "read" },
        hooks: {},
        deadlineMs: 100,
      }),
    /subjectId/,
  );
  const events = [];
  await authorizeToolInvocation({
    subjectId: "subj-a",
    sessionId: "sess-a",
    deviceId: "dev-1",
    invocation: inv(),
    descriptor: { name: "lookup", riskClass: "read" },
    hooks: {},
    deadlineMs: 100,
    emit: (e) => events.push(e),
  });
  assert.equal(events[0].deviceId, "dev-1");
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("violation fixture: defaultDeny hooks fail write obligation ID", async () => {
  const policy = createToolPolicy();
  await assert.rejects(
    () =>
      policy.authorize({
        subjectId: "anika-k",
        sessionId: "sess-v",
        invocation: inv("w"),
        descriptor: { name: "w", riskClass: "write" },
        deadlineMs: 100,
      }),
    (err) => err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING,
  );
});

test("RISKPOLI-002: invokeThroughToolPolicy read allows effect", async () => {
  let invokes = 0;
  const tools = {
    list: () => [
      {
        name: "lookup",
        description: "r",
        parameters: {},
        riskClass: "read",
      },
    ],
    invoke: async (i) => {
      invokes += 1;
      return {
        invocationId: i.invocationId,
        status: "ok",
        output: { ok: true },
        latencyMs: 1,
      };
    },
  };
  const result = await invokeThroughToolPolicy({
    subjectId: "anika-k",
    sessionId: "sess-gate",
    invocation: inv("lookup"),
    tools,
    hooks: {},
    deadlineMs: 500,
  });
  assert.equal(result.status, "ok");
  assert.equal(invokes, 1);
});

test("RISKPOLI-002: write denial maps to status error without invoke", async () => {
  let invokes = 0;
  const tools = {
    list: () => [
      {
        name: "mutate",
        description: "w",
        parameters: {},
        riskClass: "write",
      },
    ],
    invoke: async (i) => {
      invokes += 1;
      return {
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      };
    },
  };
  const result = await invokeThroughToolPolicy({
    subjectId: "anika-k",
    sessionId: "sess-deny-map",
    invocation: inv("mutate"),
    tools,
    hooks: { onWriteApproval: async () => false },
    deadlineMs: 500,
  });
  assert.equal(result.status, "error");
  assert.equal(result.output.code, "POLICY_DENIED");
  assert.equal(invokes, 0);
});

test("RISKPOLI-002: missing write hook hard-stops before effect", async () => {
  let invokes = 0;
  const tools = {
    list: () => [
      {
        name: "mutate",
        description: "w",
        parameters: {},
        riskClass: "write",
      },
    ],
    invoke: async (i) => {
      invokes += 1;
      return {
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      };
    },
  };
  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "anika-k",
        sessionId: "sess-hard",
        invocation: inv("mutate"),
        tools,
        hooks: defaultDenyToolPolicyHooks,
        deadlineMs: 200,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING,
  );
  assert.equal(invokes, 0);
});

test("RISKPOLI-002: act-stage folds denial as tool error for the model", async () => {
  const { formatToolCallFence, runActStage } = await import("../dist/index.js");
  const fence = formatToolCallFence({
    toolName: "mutate",
    arguments: {},
    callId: "d1",
  });
  let invokes = 0;
  const events = [];
  const out = await runActStage({
    subjectId: "anika-k",
    sessionId: "sess-act-deny",
    model: {
      descriptor: {
        modelId: "mock",
        contextWindow: 8,
        locality: "on-device",
        modalities: ["text"],
      },
      generate: async (messages) => {
        const tool = messages.find((m) => m.role === "tool");
        assert.ok(tool);
        assert.match(String(tool.content), /"status":"error"/);
        assert.match(String(tool.content), /POLICY_DENIED/);
        return { text: "acknowledged denial", finishReason: "stop" };
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
        invokes += 1;
        return {
          invocationId: i.invocationId,
          status: "ok",
          output: null,
          latencyMs: 0,
        };
      },
    },
    messages: [{ role: "user", content: "SECRET_UTTER" }],
    generation: { text: fence, finishReason: "tool-call" },
    policyHooks: { onWriteApproval: async () => false },
    emit: (e) => events.push(e),
  });
  assert.equal(out.generation.text, "acknowledged denial");
  assert.equal(invokes, 0);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_stage" &&
        e.toolStatus === "error",
    ),
  );
  assert.ok(
    events.some(
      (e) => e.event === "cognitive_core.tool_policy" && e.outcome === "denied",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_UTTER/);
});
