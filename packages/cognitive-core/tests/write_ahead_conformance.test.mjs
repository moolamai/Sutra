/**
 * Write-ahead audit conformance against composed CognitiveCore.
 *
 * Runs B0 CK-07.2 (`createWriteAheadAuditObligationRegistry`) against a
 * ToolConformanceHarness whose `tools.invoke` routes through the same
 * `invokeThroughToolPolicy` + AuditSink path used by CognitiveCore.turn.
 * Seeded audit-after-effect fixture fails the obligation id.
 *
 * Run: pnpm --filter @moolam/cognitive-core test  (after build of
 * @moolam/cognitive-core and @moolam/contract-conformance)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MUST_WRITE_AHEAD_AUDIT,
  TOOL_OBLIGATION_IDS,
  TOOL_READ_PROBE_NAME,
  TOOL_WRITE_PROBE_NAME,
  createAuditAfterEffectToolHarnessFactory,
  createWriteAheadAuditObligationRegistry,
  runConformance,
} from "../../contract-conformance/dist/index.js";
import {
  CognitiveCore,
  TOOL_AUDIT_MUST_WRITE_AHEAD,
  TOOL_AUDIT_OBLIGATION_WRITE_AHEAD,
  ToolAuditError,
  assertAuditBeforeEffect,
  createInMemoryAuditSink,
  formatToolCallFence,
  invokeThroughToolPolicy,
} from "../dist/index.js";

const SECRET = "SECRET_CK072_COMPOSED_MUST_NOT_LEAK";

function writeProbeDescriptor() {
  return {
    name: TOOL_WRITE_PROBE_NAME,
    description: "CK-07.2 write probe (metadata tokens only)",
    parameters: {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
    },
    riskClass: "write",
  };
}

function readProbeDescriptor() {
  return {
    name: TOOL_READ_PROBE_NAME,
    description: "CK-07.2 read probe (write-ahead exempt)",
    parameters: {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
    },
    riskClass: "read",
  };
}

/**
 * ToolConformanceHarness: tools.invoke uses CognitiveCore's policy+audit stack
 * (invokeThroughToolPolicy → recordThenInvoke → effect).
 * Honors FactoryContext.subjectId when provided by runConformance.
 */
function createComposedCognitiveCoreToolHarnessFactory(opts = {}) {
  const defaultSubjectId = opts.subjectId ?? "subj-composed-ck072";
  const deviceId = opts.deviceId ?? "dev-composed";
  return (factoryCtx) => {
    const subjectId = factoryCtx?.subjectId ?? defaultSubjectId;
    const coreSink = createInMemoryAuditSink();
    const descriptors = [writeProbeDescriptor(), readProbeDescriptor()];
    const effectTools = {
      list: () => descriptors,
      invoke: async (invocation) => ({
        invocationId: invocation.invocationId,
        status: "ok",
        output: {
          echo:
            typeof invocation.arguments?.token === "string"
              ? invocation.arguments.token
              : null,
        },
        latencyMs: 1,
      }),
    };
    return {
      tools: {
        list: () => descriptors,
        async invoke(invocation, deadlineMs) {
          return invokeThroughToolPolicy({
            subjectId,
            sessionId: `sess.${subjectId.slice(0, 48)}`,
            deviceId,
            invocation,
            tools: effectTools,
            hooks: {
              onWriteApproval: async () => true,
              onCriticalConfirm: async () => true,
            },
            deadlineMs: deadlineMs ?? 1_000,
            auditSink: coreSink,
          });
        },
      },
      /** B0-shaped view of the cognitive-core AuditSink timeline. */
      auditSink: {
        records() {
          return coreSink
            .records()
            .filter((r) => r.phase === "audit" || r.phase === "effect")
            .map((r) => ({
              phase: r.phase,
              invocationId: r.invocationId,
              toolName: r.toolName,
              riskClass: r.riskClass,
              seq: r.seq,
            }));
        },
      },
      /** Test-only: full sink for sovereignty / raw-content asserts. */
      _coreSink: coreSink,
    };
  };
}

test("happy path: B0 CK-07.2 passes against composed CognitiveCore policy+audit path", async () => {
  assert.equal(TOOL_AUDIT_OBLIGATION_WRITE_AHEAD, "CK-07.2");
  assert.equal(TOOL_AUDIT_MUST_WRITE_AHEAD, MUST_WRITE_AHEAD_AUDIT);

  const events = [];
  const factory = createComposedCognitiveCoreToolHarnessFactory({
    subjectId: "subj-core-wa-good",
    deviceId: "dev-core-wa",
  });
  const report = await runConformance({
    registry: createWriteAheadAuditObligationRegistry(),
    factory,
    subjectId: "subj-core-wa-good",
    deviceId: "dev-core-wa",
    emit: (e) => events.push(e),
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.writeAheadAudit,
  );
  assert.equal(report.verdicts[0].mustText, MUST_WRITE_AHEAD_AUDIT);
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "pass" &&
        e.obligationId === "CK-07.2" &&
        typeof e.subjectId === "string" &&
        e.subjectId.startsWith("subj-core-wa-good") &&
        e.deviceId === "dev-core-wa",
    ),
  );

  const harness = factory();
  await harness.tools.invoke(
    {
      toolName: TOOL_WRITE_PROBE_NAME,
      arguments: { token: SECRET },
      invocationId: "inv.sov.probe",
    },
    500,
  );
  assert.doesNotMatch(JSON.stringify(harness._coreSink.records()), /SECRET_CK072/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_CK072/);
});

test("violation: seeded audit-after-effect fixture fails CK-07.2 exactly", async () => {
  const report = await runConformance({
    registry: createWriteAheadAuditObligationRegistry(),
    factory: createAuditAfterEffectToolHarnessFactory(),
    subjectId: "subj-audit-after-seeded",
    deviceId: "dev-seed",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.verdicts.length, 1);
  assert.equal(
    report.verdicts[0].obligationId,
    TOOL_OBLIGATION_IDS.writeAheadAudit,
  );
  assert.equal(report.verdicts[0].mustText, MUST_WRITE_AHEAD_AUDIT);
  assert.match(report.verdicts[0].message ?? "", /ordering|before|effect/i);
});

test("integration: CognitiveCore.turn write tool records audit before effect", async () => {
  const sink = createInMemoryAuditSink();
  const events = [];
  const fence = formatToolCallFence({
    toolName: TOOL_WRITE_PROBE_NAME,
    arguments: { token: "meta.ok" },
    callId: "turn-ck072",
  });
  let gen = 0;
  const core = new CognitiveCore(
    {
      domainId: "demo",
      charter: "composed agent",
      refusals: [],
      languages: ["en"],
    },
    {
      memory: {
        remember: async (item) => ({ ...item, id: "trace-ck072" }),
        recall: async () => [],
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
        generate: async () => {
          gen += 1;
          if (gen === 1) {
            return { text: fence, finishReason: "tool-call" };
          }
          return { text: "turn complete", finishReason: "stop" };
        },
        generateStream: async function* () {},
        embed: async () => new Float32Array(4),
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
          planId: "p-ck072",
          steps: [],
          rationale: "compose",
        }),
        revise: async (p) => p,
        nextStep: () => null,
      },
      tools: {
        list: () => [writeProbeDescriptor(), readProbeDescriptor()],
        invoke: async (i) => ({
          invocationId: i.invocationId,
          status: "ok",
          output: { ran: true },
          latencyMs: 1,
        }),
      },
      knowledge: {
        sources: [],
        retrieve: async () => [],
      },
    },
    {
      toolPolicy: {
        onWriteApproval: async () => true,
      },
      toolAuditSink: sink,
      emit: (e) => events.push(e),
    },
  );

  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-ck072-turn",
    utterance: SECRET,
  });
  assert.equal(out.reply, "turn complete");
  assert.ok(sink.records().some((r) => r.phase === "audit"));
  assert.ok(sink.records().some((r) => r.phase === "effect"));
  assertAuditBeforeEffect(sink.records(), "turn-ck072", "write");
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.tool_audit" &&
        e.outcome === "recorded" &&
        e.subjectId === "anika-k",
    ),
  );
  assert.doesNotMatch(JSON.stringify(sink.records()), /SECRET_CK072/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_CK072/);
});

test("edge: read probe through composed harness needs no audit rows", async () => {
  const harness = createComposedCognitiveCoreToolHarnessFactory({
    subjectId: "subj-read",
  })();
  const before = harness.auditSink.records().length;
  await harness.tools.invoke(
    {
      toolName: TOOL_READ_PROBE_NAME,
      arguments: { token: "r" },
      invocationId: "inv.read",
    },
    500,
  );
  const after = harness.auditSink.records().slice(before);
  assert.equal(
    after.filter((r) => r.phase === "audit").length,
    0,
    "read-class must not require write-ahead audit",
  );
});

test("edge: sink timeout on composed path aborts before effect", async () => {
  let effects = 0;
  const slowSink = {
    recordInvocation: async () => {
      await new Promise((r) => setTimeout(r, 80));
    },
    recordOutcome: async () => {},
    records: () => [],
  };
  await assert.rejects(
    () =>
      invokeThroughToolPolicy({
        subjectId: "anika-k",
        sessionId: "sess-to",
        invocation: {
          toolName: TOOL_WRITE_PROBE_NAME,
          arguments: { token: "t" },
          invocationId: "inv.to",
        },
        tools: {
          list: () => [writeProbeDescriptor()],
          invoke: async (i) => {
            effects += 1;
            return {
              invocationId: i.invocationId,
              status: "ok",
              output: null,
              latencyMs: 0,
            };
          },
        },
        hooks: { onWriteApproval: async () => true },
        deadlineMs: 15,
        auditSink: slowSink,
      }),
    (err) => err instanceof ToolAuditError,
  );
  assert.equal(effects, 0);
});

test("edge: duplicate idempotency through composed harness is at-most-once", async () => {
  const harness = createComposedCognitiveCoreToolHarnessFactory({
    subjectId: "subj-idem",
  })();
  let effects = 0;
  const orig = harness.tools.invoke.bind(harness.tools);
  // Replace underlying effect counter via a second factory instance with tracker.
  const sink = createInMemoryAuditSink();
  const descriptors = [writeProbeDescriptor()];
  const tools = {
    list: () => descriptors,
    invoke: async (invocation, deadlineMs) => {
      return invokeThroughToolPolicy({
        subjectId: "subj-idem",
        sessionId: "sess-idem",
        invocation,
        tools: {
          list: () => descriptors,
          invoke: async (i) => {
            effects += 1;
            return {
              invocationId: i.invocationId,
              status: "ok",
              output: null,
              latencyMs: 1,
            };
          },
        },
        hooks: { onWriteApproval: async () => true },
        deadlineMs: deadlineMs ?? 500,
        auditSink: sink,
      });
    },
  };
  const inv = {
    toolName: TOOL_WRITE_PROBE_NAME,
    arguments: { token: "idem" },
    invocationId: "inv.idem.shared",
  };
  await tools.invoke(inv, 500);
  await tools.invoke(inv, 500);
  assert.equal(effects, 1);
  assert.equal(
    sink.records().filter((r) => r.phase === "audit").length,
    1,
  );
  void harness;
  void orig;
});

test("edge: concurrent subjects keep composed audit rows isolated", async () => {
  const a = createComposedCognitiveCoreToolHarnessFactory({
    subjectId: "subj-a",
  })();
  const b = createComposedCognitiveCoreToolHarnessFactory({
    subjectId: "subj-b",
  })();
  await Promise.all([
    a.tools.invoke(
      {
        toolName: TOOL_WRITE_PROBE_NAME,
        arguments: { token: "a" },
        invocationId: "inv.a",
      },
      500,
    ),
    b.tools.invoke(
      {
        toolName: TOOL_WRITE_PROBE_NAME,
        arguments: { token: "b" },
        invocationId: "inv.b",
      },
      500,
    ),
  ]);
  const subjectsA = new Set(
    a._coreSink.records().map((r) => r.subjectId),
  );
  const subjectsB = new Set(
    b._coreSink.records().map((r) => r.subjectId),
  );
  assert.deepEqual([...subjectsA], ["subj-a"]);
  assert.deepEqual([...subjectsB], ["subj-b"]);
});
