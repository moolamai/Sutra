/**
 * Knowledge / tool / planning reference mocks.
 *
 * Happy path: CK-09, CK-07, CK-08 conformance registries pass.
 * Edge: offline retrieve; write-ahead audit ordering; cyclic revise + rationale;
 * idempotent tool audit replay; concurrent subject-scoped tool invokes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeObligationsRegistry,
  createPlanningObligationsRegistry,
  createToolObligationsRegistry,
  runConformance,
} from "@moolam/contract-conformance";
import {
  TOOL_PROBE_WRITE,
  createKnowledgeMock,
  createKnowledgeMockHarnessFactory,
  createPlanningMock,
  createPlanningMockHarnessFactory,
  createToolMock,
  createToolMockHarnessFactory,
} from "../dist/index.js";

test("happy path: knowledge mock passes full CK-09 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createKnowledgeObligationsRegistry(),
    factory: createKnowledgeMockHarnessFactory({
      deviceId: "dev-mock-know",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-know",
    deviceId: "dev-mock-know",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
  assert.ok(
    events.some((e) => e.event === "contract_mocks.knowledge" && e.outcome === "ok"),
  );
});

test("happy path: tool mock passes full CK-07 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createToolObligationsRegistry(),
    factory: createToolMockHarnessFactory({
      deviceId: "dev-mock-tool",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-tool",
    deviceId: "dev-mock-tool",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 3);
  assert.ok(events.some((e) => e.event === "contract_mocks.tool" && e.outcome === "ok"));
});

test("happy path: planning mock passes full CK-08 registry", async () => {
  const events = [];
  const report = await runConformance({
    registry: createPlanningObligationsRegistry(),
    factory: createPlanningMockHarnessFactory({
      deviceId: "dev-mock-plan",
      emit: (e) => events.push(e),
    }),
    subjectId: "subj-mock-plan",
    deviceId: "dev-mock-plan",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, 2);
  assert.ok(
    events.some((e) => e.event === "contract_mocks.planning" && e.outcome === "ok"),
  );
});

test("edge: bundled-offline knowledge returns cited passages without network", async () => {
  const knowledge = createKnowledgeMock({
    sourceId: "corp.local",
    locality: "bundled-offline",
    passages: [
      { content: "probe.passage.a", asOf: "2024-01-01" },
      { content: "probe.passage.b", asOf: "2024-02-01" },
    ],
  });
  const hits = await knowledge.retrieve({ query: "probe.passage", limit: 4 });
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    assert.ok(h.citation.trim());
    assert.equal(h.sourceId, "corp.local");
    assert.ok(knowledge.sources.some((s) => s.sourceId === h.sourceId));
  }
});

test("edge: write-ahead audit precedes effect; replay is idempotent", async () => {
  const { tools, auditSink } = createToolMock({ deviceId: "dev-wa" });
  const write = tools.list().find((d) => d.name === TOOL_PROBE_WRITE);
  assert.ok(write);
  const invocation = {
    toolName: write.name,
    arguments: { token: "probe.token" },
    invocationId: "inv.wa.1",
  };
  await tools.invoke(invocation, 1_000);
  await tools.invoke(invocation, 1_000); // replay
  const rows = auditSink
    .records()
    .filter((r) => r.invocationId === "inv.wa.1");
  assert.equal(rows.length, 2, "idempotent: one audit + one effect");
  assert.equal(rows[0].phase, "audit");
  assert.equal(rows[1].phase, "effect");
  assert.ok(rows[0].seq < rows[1].seq);
});

test("edge: hang tool respects deadline with typed timeout (never throws)", async () => {
  const { tools } = createToolMock();
  const hang = tools.list().find((d) => d.name === "probe.ck07.3.hang");
  assert.ok(hang);
  const started = Date.now();
  const result = await tools.invoke(
    {
      toolName: hang.name,
      arguments: { token: "probe.hang" },
      invocationId: "inv.hang.1",
    },
    40,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.status, "error");
  assert.equal(result.output?.kind, "timeout");
  assert.ok(elapsed < 200);
});

test("edge: revise loops back and always updates rationale", async () => {
  const planning = createPlanningMock({ deviceId: "dev-plan" });
  const plan = await planning.compose(
    [
      {
        goalId: "g1",
        description: "foundation",
        prerequisites: [],
        successCriterion: "ok1",
      },
      {
        goalId: "g2",
        description: "later",
        prerequisites: ["g1"],
        successCriterion: "ok2",
      },
    ],
    "probe.context",
  );
  const advanced = {
    ...plan,
    steps: plan.steps.map((s, i) => ({
      ...s,
      status: i === 0 ? "done" : i === 1 ? "active" : s.status,
    })),
  };
  const beforeRationale = advanced.rationale;
  const revised = await planning.revise(advanced, {
    observation: "foundation weak",
    stepId: advanced.steps[1].stepId,
    severity: "invalidating",
  });
  assert.notEqual(revised.rationale, beforeRationale);
  assert.equal(revised.steps[0].status, "active");
  assert.ok(
    revised.steps[1].status === "pending" || revised.steps[1].status === "blocked",
  );
  const next = planning.nextStep(revised);
  assert.equal(next?.stepId, revised.steps[0].stepId);
});

test("edge: invalid tool args return schema error (never throw)", async () => {
  const { tools } = createToolMock();
  const d = tools.list()[0];
  assert.ok(d);
  const result = await tools.invoke(
    {
      toolName: d.name,
      arguments: {},
      invocationId: "inv.bad",
    },
    500,
  );
  assert.equal(result.status, "error");
  assert.equal(result.output?.kind, "schema");
});
