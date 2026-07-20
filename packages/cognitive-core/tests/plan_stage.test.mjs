/**
 * Plan_stage compose / revise / reuse unit tests.
 * Run: node --test tests/plan_stage.test.mjs (after pnpm build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_STAGE_OBLIGATION_RATIONALE,
  PlanStageError,
  SessionPlanGate,
  derivePlanRevisionSignal,
  runPlanStage,
} from "../dist/index.js";

function goals() {
  return [
    {
      goalId: "g.basics",
      description: "Foundations",
      prerequisites: [],
      successCriterion: "ok.basics",
    },
    {
      goalId: "g.advanced",
      description: "Advanced",
      prerequisites: ["g.basics"],
      successCriterion: "ok.advanced",
    },
  ];
}

function reasoning(overrides = {}) {
  return {
    conclusion: "synthetic-conclusion-token",
    confidence: 0.85,
    steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
    unresolvedConstraints: [],
    ...overrides,
  };
}

function makePlanning(opts = {}) {
  const calls = [];
  const planning = {
    compose: async (g, context) => {
      calls.push({ op: "compose", goalCount: g.length, context });
      return {
        planId: "plan-1",
        steps: g.map((goal, i) => ({
          stepId: `s${i + 1}`,
          goalId: goal.goalId,
          action: `act:${goal.goalId}`,
          dependsOn: i > 0 ? [`s${i}`] : [],
          status: i === 0 ? "active" : "pending",
        })),
        rationale: "composed-v1",
      };
    },
    revise: async (plan, event) => {
      calls.push({ op: "revise", severity: event.severity });
      if (opts.silentRevise) {
        return { ...plan, steps: [...plan.steps] };
      }
      return {
        ...plan,
        rationale: `${plan.rationale}|rev:${event.severity}`,
        steps: plan.steps.map((s, i) =>
          i === 0 ? { ...s, status: "active" } : { ...s, status: "pending" },
        ),
      };
    },
    nextStep: () => null,
  };
  return { planning, calls };
}

test("happy path: first turn with no plan composes", async () => {
  const events = [];
  const { planning, calls } = makePlanning();
  const out = await runPlanStage({
    subjectId: "anika-k",
    sessionId: "sess-1",
    planning,
    reasoning: reasoning(),
    activePlan: null,
    goals: goals(),
    context: "domain:demo conclusion:synthetic",
    emit: (e) => events.push(e),
  });
  assert.equal(out.outcome, "composed");
  assert.equal(out.plan.planId, "plan-1");
  assert.equal(out.revised, false);
  assert.equal(calls[0].op, "compose");
  assert.equal(events[0].outcome, "composed");
  assert.equal(events[0].subjectId, "anika-k");
  assert.ok(!JSON.stringify(events).includes("hello"));
});

test("happy path: subsequent turn without blocking signal reuses plan", async () => {
  const { planning, calls } = makePlanning();
  const active = {
    planId: "plan-1",
    steps: [],
    rationale: "composed-v1",
  };
  const out = await runPlanStage({
    subjectId: "anika-k",
    sessionId: "sess-1",
    planning,
    reasoning: reasoning(),
    activePlan: active,
    goals: goals(),
    context: "domain:demo",
  });
  assert.equal(out.outcome, "reused");
  assert.equal(out.plan, active);
  assert.deepEqual(calls, []);
});

test("happy path: blocking unresolvedConstraints revises and updates rationale", async () => {
  const { planning, calls } = makePlanning();
  const active = {
    planId: "plan-1",
    steps: [
      {
        stepId: "s1",
        goalId: "g.basics",
        action: "a",
        dependsOn: [],
        status: "done",
      },
      {
        stepId: "s2",
        goalId: "g.advanced",
        action: "b",
        dependsOn: ["s1"],
        status: "active",
      },
    ],
    rationale: "composed-v1",
  };
  const out = await runPlanStage({
    subjectId: "anika-k",
    sessionId: "sess-1",
    planning,
    reasoning: reasoning({
      unresolvedConstraints: ["scope.refusal.token"],
      confidence: 0.9,
    }),
    activePlan: active,
    goals: goals(),
    context: "domain:demo",
  });
  assert.equal(out.outcome, "revised");
  assert.equal(out.revised, true);
  assert.notEqual(out.plan.rationale, "composed-v1");
  assert.equal(calls[0].op, "revise");
  assert.equal(calls[0].severity, "blocking");
});

test("edge: informational severity does not force revise", async () => {
  const { planning, calls } = makePlanning();
  const active = { planId: "p", steps: [], rationale: "r0" };
  const out = await runPlanStage({
    subjectId: "anika-k",
    sessionId: "sess-1",
    planning,
    reasoning: reasoning(),
    activePlan: active,
    goals: goals(),
    context: "ctx",
    revisionSignal: {
      observation: "note",
      severity: "informational",
    },
  });
  assert.equal(out.outcome, "reused");
  assert.deepEqual(calls, []);
});

test("edge: violation fixture — silent revise fails CK-08.2", async () => {
  const { planning } = makePlanning({ silentRevise: true });
  const active = { planId: "p", steps: [], rationale: "unchanged" };
  await assert.rejects(
    () =>
      runPlanStage({
        subjectId: "anika-k",
        sessionId: "sess-1",
        planning,
        reasoning: reasoning({ confidence: 0.1 }),
        activePlan: active,
        goals: goals(),
        context: "ctx",
      }),
    (err) => {
      assert.ok(err instanceof PlanStageError);
      assert.equal(err.obligationId, PLAN_STAGE_OBLIGATION_RATIONALE);
      assert.equal(err.failureClass, "contract");
      return true;
    },
  );
});

test("edge: derivePlanRevisionSignal maps low confidence to blocking", () => {
  const sig = derivePlanRevisionSignal(reasoning({ confidence: 0.1 }));
  assert.equal(sig?.severity, "blocking");
  assert.equal(derivePlanRevisionSignal(reasoning()), null);
});

test("edge: SessionPlanGate serializes same sessionId", async () => {
  const gate = new SessionPlanGate();
  const order = [];
  await Promise.all([
    gate.runExclusive("sess-a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
    }),
    gate.runExclusive("sess-a", async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("edge: subjectId required; empty goals on compose fail validation", async () => {
  const { planning } = makePlanning();
  await assert.rejects(
    () =>
      runPlanStage({
        subjectId: "  ",
        sessionId: "sess-1",
        planning,
        reasoning: reasoning(),
        activePlan: null,
        goals: goals(),
        context: "ctx",
      }),
    (err) => err instanceof PlanStageError && err.failureClass === "validation",
  );
  await assert.rejects(
    () =>
      runPlanStage({
        subjectId: "anika-k",
        sessionId: "sess-1",
        planning,
        reasoning: reasoning(),
        activePlan: null,
        goals: [],
        context: "ctx",
      }),
    (err) => err instanceof PlanStageError && err.failureClass === "validation",
  );
});
