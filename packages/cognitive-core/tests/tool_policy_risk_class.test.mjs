/**
 * Risk-policy regression fixtures per risk class.
 *
 * Fixtures (task summary):
 *   - read passes without hook
 *   - write blocked until approval
 *   - critical blocked until confirm
 *   - denial and timeout paths each typed
 *
 * Run: pnpm --filter @moolam/cognitive-core test  (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_POLICY_MUST_CRITICAL,
  TOOL_POLICY_MUST_WRITE,
  TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT,
  TOOL_POLICY_OBLIGATION_HOOK_MISSING,
  TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
  ToolPolicyError,
  authorizeToolInvocation,
  createInMemoryAuditSink,
  defaultDenyToolPolicyHooks,
  invokeThroughToolPolicy,
  resolveRiskClass,
} from "../dist/index.js";

const SECRET = "SECRET_LEARNER_RISK_FIXTURE_MUST_NOT_LEAK";

function inv(toolName, invocationId = `inv-${toolName}`) {
  return {
    toolName,
    arguments: { probe: SECRET },
    invocationId,
  };
}

function toolsFor(descriptor) {
  const effect = { started: false, count: 0 };
  return {
    effect,
    tools: {
      list: () => [descriptor],
      invoke: async (i) => {
        effect.started = true;
        effect.count += 1;
        return {
          invocationId: i.invocationId,
          status: "ok",
          output: { ran: descriptor.name },
          latencyMs: 1,
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// read — Protects ToolDescriptor: "read": pure lookup, auto-executable
// ---------------------------------------------------------------------------

test("fixture read: passes without approval hooks; effect runs", async () => {
  const events = [];
  const { tools, effect } = toolsFor({
    name: "lookup",
    description: "read probe",
    parameters: {},
    riskClass: "read",
  });
  const result = await invokeThroughToolPolicy({
    subjectId: "subj-read",
    sessionId: "sess-read",
    deviceId: "dev-1",
    invocation: inv("lookup"),
    tools,
    hooks: defaultDenyToolPolicyHooks,
    deadlineMs: 500,
    emit: (e) => events.push(e),
  });
  assert.equal(result.status, "ok");
  assert.equal(effect.count, 1);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "allowed" &&
        e.riskClass === "read" &&
        e.subjectId === "subj-read" &&
        e.deviceId === "dev-1",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("fixture compute: mirrors read — auto without write/critical hooks", async () => {
  let writeHook = 0;
  const { tools, effect } = toolsFor({
    name: "calc",
    description: "compute probe",
    parameters: {},
    riskClass: "compute",
  });
  const result = await invokeThroughToolPolicy({
    subjectId: "subj-compute",
    sessionId: "sess-compute",
    invocation: inv("calc"),
    tools,
    hooks: {
      onWriteApproval: async () => {
        writeHook += 1;
        return true;
      },
    },
    deadlineMs: 500,
  });
  assert.equal(result.status, "ok");
  assert.equal(effect.count, 1);
  assert.equal(writeHook, 0, "read/compute must never block on write approval");
});

// ---------------------------------------------------------------------------
// write — Protects TOOL_POLICY_MUST_WRITE / ToolDescriptor write approval
// ---------------------------------------------------------------------------

test("fixture write: blocked until onWriteApproval affirms (effect ordering)", async () => {
  const order = [];
  const { tools, effect } = toolsFor({
    name: "mutate",
    description: "write probe",
    parameters: {},
    riskClass: "write",
  });
  assert.match(TOOL_POLICY_MUST_WRITE, /requires policy approval/);

  // Before approval: hard-stop when hook missing (no silent execute).
  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "subj-w",
        sessionId: "sess-w-block",
        invocation: inv("mutate"),
        tools,
        hooks: defaultDenyToolPolicyHooks,
        deadlineMs: 200,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING &&
      err.errorCode === "WRITE_HOOK_MISSING",
  );
  assert.equal(effect.started, false);

  const result = await invokeThroughToolPolicy({
    subjectId: "subj-w",
    sessionId: "sess-w-allow",
    invocation: inv("mutate", "inv-mutate-2"),
    tools,
    hooks: {
      onWriteApproval: async () => {
        order.push("approval");
        assert.equal(effect.started, false, "effect must not start before approval");
        return true;
      },
    },
    deadlineMs: 500,
    auditSink: createInMemoryAuditSink(),
  });
  order.push("effect");
  assert.equal(result.status, "ok");
  assert.deepEqual(order, ["approval", "effect"]);
  assert.equal(effect.count, 1);
});

test("fixture write: denial → typed status error, not thrown; no effect", async () => {
  const events = [];
  const { tools, effect } = toolsFor({
    name: "mutate",
    description: "write probe",
    parameters: {},
    riskClass: "write",
  });
  const result = await invokeThroughToolPolicy({
    subjectId: "subj-w-deny",
    sessionId: "sess-w-deny",
    invocation: inv("mutate"),
    tools,
    hooks: { onWriteApproval: async () => false },
    deadlineMs: 500,
    emit: (e) => events.push(e),
  });
  assert.equal(result.status, "error");
  assert.equal(result.output.code, "POLICY_DENIED");
  assert.equal(effect.started, false);
  assert.ok(events.some((e) => e.outcome === "denied" && e.riskClass === "write"));
});

test("fixture write: approval timeout → TOOL.POLICY_APPROVAL_TIMEOUT; no effect", async () => {
  const events = [];
  const { tools, effect } = toolsFor({
    name: "mutate",
    description: "write probe",
    parameters: {},
    riskClass: "write",
  });
  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "subj-w-to",
        sessionId: "sess-w-to",
        invocation: inv("mutate"),
        tools,
        hooks: {
          onWriteApproval: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return true;
          },
        },
        deadlineMs: 15,
        emit: (e) => events.push(e),
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT &&
      err.failureClass === "cap" &&
      err.errorCode === "WRITE_APPROVAL_TIMEOUT",
  );
  assert.equal(effect.started, false);
  assert.ok(
    events.some(
      (e) => e.outcome === "error" && e.errorCode === "WRITE_APPROVAL_TIMEOUT",
    ),
  );
});

// ---------------------------------------------------------------------------
// critical — Protects TOOL_POLICY_MUST_CRITICAL / human confirmation
// ---------------------------------------------------------------------------

test("fixture critical: blocked until onCriticalConfirm affirms", async () => {
  const { tools, effect } = toolsFor({
    name: "irreversible",
    description: "critical probe",
    parameters: {},
    riskClass: "critical",
  });
  assert.match(TOOL_POLICY_MUST_CRITICAL, /requires human approval/);

  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "subj-c",
        sessionId: "sess-c-block",
        invocation: inv("irreversible"),
        tools,
        hooks: {},
        deadlineMs: 200,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_HOOK_MISSING &&
      err.errorCode === "CRITICAL_HOOK_MISSING",
  );
  assert.equal(effect.started, false);

  const result = await invokeThroughToolPolicy({
    subjectId: "subj-c",
    sessionId: "sess-c-allow",
    invocation: inv("irreversible", "inv-c2"),
    tools,
    hooks: {
      onCriticalConfirm: async () => {
        assert.equal(effect.started, false);
        return true;
      },
    },
    deadlineMs: 500,
    auditSink: createInMemoryAuditSink(),
  });
  assert.equal(result.status, "ok");
  assert.equal(effect.count, 1);
});

test("fixture critical: denial → typed status error; timeout typed separately", async () => {
  const { tools, effect } = toolsFor({
    name: "irreversible",
    description: "critical probe",
    parameters: {},
    riskClass: "critical",
  });

  const denied = await invokeThroughToolPolicy({
    subjectId: "subj-c-deny",
    sessionId: "sess-c-deny",
    invocation: inv("irreversible"),
    tools,
    hooks: { onCriticalConfirm: async () => false },
    deadlineMs: 500,
  });
  assert.equal(denied.status, "error");
  assert.equal(denied.output.code, "POLICY_DENIED");
  assert.equal(effect.started, false);

  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "subj-c-to",
        sessionId: "sess-c-to",
        invocation: inv("irreversible", "inv-c-to"),
        tools,
        hooks: {
          onCriticalConfirm: async () => {
            await new Promise((r) => setTimeout(r, 80));
            return true;
          },
        },
        deadlineMs: 15,
      }),
    (err) =>
      err instanceof ToolPolicyError &&
      err.obligationId === TOOL_POLICY_OBLIGATION_APPROVAL_TIMEOUT &&
      err.errorCode === "CRITICAL_CONFIRM_TIMEOUT",
  );
  assert.equal(effect.started, false);
});

// ---------------------------------------------------------------------------
// fail-safe / sovereignty / concurrency
// ---------------------------------------------------------------------------

test("fixture missing riskClass: treat as write + advisory; no silent execute", async () => {
  const events = [];
  const resolved = resolveRiskClass({ riskClass: undefined });
  assert.equal(resolved.assumedWrite, true);
  assert.equal(resolved.riskClass, "write");

  const { tools, effect } = toolsFor({
    name: "mystery",
    description: "no class",
    parameters: {},
    // intentionally omit valid riskClass via authorize path with partial desc
  });
  // Override list entry to strip riskClass at authorize boundary.
  tools.list = () => [{ name: "mystery", description: "x", parameters: {} }];

  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "subj-assume",
        sessionId: "sess-assume",
        invocation: inv("mystery"),
        tools,
        hooks: defaultDenyToolPolicyHooks,
        deadlineMs: 200,
        emit: (e) => events.push(e),
      }),
    (err) => err instanceof ToolPolicyError,
  );
  assert.equal(effect.started, false);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "assumed_write" &&
        e.errorCode === TOOL_POLICY_OBLIGATION_RISK_ASSUMED_WRITE,
    ),
  );
});

test("fixture sovereignty: concurrent subjects keep policy events isolated", async () => {
  const events = [];
  const fence = async (subjectId) => {
    const { tools } = toolsFor({
      name: "lookup",
      description: "r",
      parameters: {},
      riskClass: "read",
    });
    return invokeThroughToolPolicy({
      subjectId,
      sessionId: `sess-${subjectId}`,
      invocation: inv("lookup", `inv-${subjectId}`),
      tools,
      hooks: {},
      deadlineMs: 500,
      emit: (e) => events.push(e),
    });
  };
  const [a, b] = await Promise.all([fence("subj-a"), fence("subj-b")]);
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
  assert.ok(events.some((e) => e.subjectId === "subj-a"));
  assert.ok(events.some((e) => e.subjectId === "subj-b"));
  assert.ok(
    events.every((e) => e.subjectId === "subj-a" || e.subjectId === "subj-b"),
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET_LEARNER/);
});

test("fixture replay: repeated write denial is idempotent (same typed error)", async () => {
  const { tools, effect } = toolsFor({
    name: "mutate",
    description: "w",
    parameters: {},
    riskClass: "write",
  });
  const hooks = { onWriteApproval: async () => false };
  const first = await invokeThroughToolPolicy({
    subjectId: "subj-replay",
    sessionId: "sess-replay",
    invocation: inv("mutate", "inv-r1"),
    tools,
    hooks,
    deadlineMs: 300,
  });
  const second = await invokeThroughToolPolicy({
    subjectId: "subj-replay",
    sessionId: "sess-replay",
    invocation: inv("mutate", "inv-r2"),
    tools,
    hooks,
    deadlineMs: 300,
  });
  assert.equal(first.status, "error");
  assert.equal(second.status, "error");
  assert.equal(first.output.code, second.output.code);
  assert.equal(effect.started, false);
});

test("fixture authorize: read never waits on write/critical hooks (direct)", async () => {
  let blocked = false;
  const out = await authorizeToolInvocation({
    subjectId: "subj-auth-read",
    sessionId: "sess-auth-read",
    invocation: inv("lookup"),
    descriptor: { name: "lookup", riskClass: "read" },
    hooks: {
      onWriteApproval: async () => {
        blocked = true;
        await new Promise((r) => setTimeout(r, 50));
        return true;
      },
      onCriticalConfirm: async () => {
        blocked = true;
        return true;
      },
    },
    deadlineMs: 500,
  });
  assert.equal(out.outcome, "allow");
  assert.equal(blocked, false);
});
