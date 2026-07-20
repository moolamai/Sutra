/**
 * Plan-stage integration tests (revision on reasoning failure).
 *
 * Mock planner through the full CognitiveCore.turn path:
 *   compose on first turn → persistence across sequential turns →
 *   revise on injected blocking constraint → rationale MUST change.
 *
 * Run: pnpm --filter @moolam/cognitive-core test  (after build)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CognitiveCore,
  PLAN_STAGE_OBLIGATION_RATIONALE,
  PlanStageError,
} from "../dist/index.js";

const SECRET_UTTERANCE = "SECRET_LEARNER_UTTERANCE_MUST_NOT_LEAK";

function makeIntegrationBindings(tracker, overrides = {}) {
  let deliberateTurn = 0;
  const planning = {
    compose: async (goals, context) => {
      tracker.ops.push("compose");
      tracker.composeContexts.push(String(context));
      assert.ok(goals.length >= 1);
      assert.doesNotMatch(String(context), /SECRET_LEARNER/);
      const plan = {
        planId: `plan-int-${++tracker.composeSeq}`,
        steps: goals.slice(0, 2).map((g, i) => ({
          stepId: `s${i + 1}`,
          goalId: g.goalId,
          action: `act:${g.goalId}`,
          dependsOn: i > 0 ? [`s${i}`] : [],
          status: i === 0 ? "active" : "pending",
        })),
        rationale: "compose-baseline",
      };
      tracker.lastPlan = plan;
      return plan;
    },
    revise: async (plan, event) => {
      tracker.ops.push(`revise:${event.severity}`);
      tracker.reviseObservations.push(event.observation);
      assert.ok(event.severity === "blocking" || event.severity === "invalidating");
      if (tracker.silentRevise) {
        return { ...plan, steps: [...plan.steps] };
      }
      const revised = {
        ...plan,
        rationale: `${plan.rationale}|rev#${++tracker.reviseSeq}:${event.severity}`,
        steps: plan.steps.map((s, i) =>
          i === 0
            ? { ...s, status: "active" }
            : { ...s, status: s.status === "done" ? "pending" : s.status },
        ),
      };
      tracker.lastPlan = revised;
      return revised;
    },
    nextStep: (plan) => plan.steps.find((s) => s.status === "active") ?? null,
  };

  return {
    memory: {
      remember: async (item) => ({ ...item, id: `trace-${++tracker.traceSeq}` }),
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
      generate: async () => {
        if (tracker.failGenerateOnce) {
          tracker.failGenerateOnce = false;
          const err = new Error("generate-partial-fail");
          err.code = "GENERATE_FAIL";
          throw err;
        }
        return { text: "grounded reply", finishReason: "stop" };
      },
      generateStream: async function* () {
        yield "grounded reply";
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async () => {
        deliberateTurn += 1;
        const script = tracker.reasonScript?.[deliberateTurn - 1];
        if (script) return script;
        return {
          conclusion: "ok",
          confidence: 0.85,
          steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
          unresolvedConstraints: [],
        };
      },
    },
    planning,
    tools: {
      list: () => [],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        status: "ok",
        output: null,
        latencyMs: 0,
      }),
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

function freshTracker(extra = {}) {
  return {
    ops: [],
    composeContexts: [],
    reviseObservations: [],
    composeSeq: 0,
    reviseSeq: 0,
    traceSeq: 0,
    lastPlan: null,
    silentRevise: false,
    failGenerateOnce: false,
    reasonScript: null,
    ...extra,
  };
}

const profile = {
  domainId: "demo",
  charter: "You are a demo agent.",
  refusals: [],
  languages: ["en"],
};

test("integration happy: compose on first turn populates AgentTurnOutput.plan", async () => {
  const tracker = freshTracker();
  const events = [];
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker), {
    emit: (e) => events.push(e),
  });

  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-persist",
    utterance: SECRET_UTTERANCE,
  });

  assert.equal(out.declined, false);
  assert.ok(out.plan);
  assert.equal(out.plan.planId, "plan-int-1");
  assert.equal(out.plan.rationale, "compose-baseline");
  assert.deepEqual(tracker.ops, ["compose"]);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.plan_stage" &&
        e.outcome === "composed" &&
        e.subjectId === "anika-k" &&
        e.sessionId === "sess-persist",
    ),
  );
  const blob = JSON.stringify(events);
  assert.doesNotMatch(blob, /SECRET_LEARNER/);
});

test("integration happy: activePlans persists across sequential turns (reuse)", async () => {
  const tracker = freshTracker();
  const events = [];
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker), {
    emit: (e) => events.push(e),
  });

  const t1 = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-seq",
    utterance: SECRET_UTTERANCE,
  });
  const t2 = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-seq",
    utterance: SECRET_UTTERANCE,
  });
  const t3 = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-seq",
    utterance: SECRET_UTTERANCE,
  });

  assert.equal(t1.plan?.planId, t2.plan?.planId);
  assert.equal(t2.plan?.planId, t3.plan?.planId);
  assert.equal(t1.plan?.rationale, t3.plan?.rationale);
  assert.deepEqual(tracker.ops, ["compose"]);
  assert.equal(
    events.filter((e) => e.event === "cognitive_core.plan_stage" && e.outcome === "reused")
      .length,
    2,
  );
});

test("integration: injected blocking unresolvedConstraints revises and updates rationale", async () => {
  const tracker = freshTracker({
    reasonScript: [
      {
        conclusion: "foundation-ok",
        confidence: 0.9,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
        unresolvedConstraints: [],
      },
      {
        // Non-refusal blocking signal — must not trip CK-10 decline.
        conclusion: "foundation-weak",
        confidence: 0.8,
        steps: [{ kind: "verification", statement: "gap", evidenceRefs: [0] }],
        unresolvedConstraints: ["curriculum.prerequisite.weak"],
      },
      {
        conclusion: "re-stabilized",
        confidence: 0.88,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [0] }],
        unresolvedConstraints: [],
      },
    ],
  });
  const events = [];
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker), {
    emit: (e) => events.push(e),
  });

  const first = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-block",
    utterance: SECRET_UTTERANCE,
  });
  const revised = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-block",
    utterance: SECRET_UTTERANCE,
  });
  const after = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-block",
    utterance: SECRET_UTTERANCE,
  });

  assert.equal(first.plan?.rationale, "compose-baseline");
  assert.ok(revised.plan?.rationale.includes("rev#1:blocking"));
  assert.notEqual(revised.plan?.rationale, first.plan?.rationale);
  // Persistence: post-revise turn reuses the revised plan (same rationale).
  assert.equal(after.plan?.rationale, revised.plan?.rationale);
  assert.deepEqual(tracker.ops, ["compose", "revise:blocking"]);
  assert.ok(
    events.some(
      (e) =>
        e.event === "cognitive_core.plan_stage" &&
        e.outcome === "revised" &&
        e.revisionSeverity === "blocking",
    ),
  );
  assert.equal(first.declined, false);
  assert.equal(revised.declined, false);
});

test("integration edge: informational / healthy reasoning does not force revise", async () => {
  const tracker = freshTracker({
    reasonScript: [
      {
        conclusion: "ok",
        confidence: 0.9,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [] }],
        unresolvedConstraints: [],
      },
      {
        conclusion: "still-ok",
        confidence: 0.7,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [] }],
        unresolvedConstraints: [],
      },
    ],
  });
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker));
  await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-info",
    utterance: "x",
  });
  await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-info",
    utterance: "y",
  });
  assert.deepEqual(tracker.ops, ["compose"]);
});

test("integration edge: silent revise violation fails CK-08.2 after compose", async () => {
  const tracker = freshTracker({
    silentRevise: true,
    reasonScript: [
      {
        conclusion: "ok",
        confidence: 0.9,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [] }],
        unresolvedConstraints: [],
      },
      {
        conclusion: "weak",
        confidence: 0.1,
        steps: [{ kind: "inference", statement: "s", evidenceRefs: [] }],
        unresolvedConstraints: [],
      },
    ],
  });
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker));
  await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-silent",
    utterance: "a",
  });
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-silent",
        utterance: "b",
      }),
    (err) =>
      err instanceof PlanStageError &&
      err.obligationId === PLAN_STAGE_OBLIGATION_RATIONALE,
  );
});

test("integration edge: partial failure after compose — plan survives for next turn", async () => {
  const tracker = freshTracker({ failGenerateOnce: true });
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker));

  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-partial",
        utterance: SECRET_UTTERANCE,
      }),
    /generate-partial-fail/,
  );
  assert.deepEqual(tracker.ops, ["compose"]);

  const recovered = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-partial",
    utterance: SECRET_UTTERANCE,
  });
  // Plan was written before generate failed — second turn reuses, no second compose.
  assert.equal(recovered.plan?.planId, "plan-int-1");
  assert.equal(recovered.plan?.rationale, "compose-baseline");
  assert.deepEqual(tracker.ops, ["compose"]);
});

test("integration edge: concurrent same-session turns serialize plan Map writes", async () => {
  const tracker = freshTracker();
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker));

  const results = await Promise.all([
    core.turn({
      subjectId: "anika-k",
      sessionId: "sess-race",
      utterance: "a",
    }),
    core.turn({
      subjectId: "anika-k",
      sessionId: "sess-race",
      utterance: "b",
    }),
    core.turn({
      subjectId: "anika-k",
      sessionId: "sess-race",
      utterance: "c",
    }),
  ]);

  assert.equal(tracker.ops.filter((o) => o === "compose").length, 1);
  assert.ok(results.every((r) => r.plan?.planId === "plan-int-1"));
  assert.ok(results.every((r) => r.plan?.rationale === "compose-baseline"));
});

test("integration edge: sessions stay isolated — no cross-session stale plans", async () => {
  const tracker = freshTracker();
  const core = new CognitiveCore(profile, makeIntegrationBindings(tracker));

  const a = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-a",
    utterance: "x",
  });
  const b = await core.turn({
    subjectId: "ravi-m",
    sessionId: "sess-b",
    utterance: "y",
  });
  assert.notEqual(a.plan?.planId, b.plan?.planId);

  const a2 = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-a",
    utterance: "x2",
  });
  assert.equal(a2.plan?.planId, a.plan?.planId);
  assert.equal(a2.plan?.rationale, a.plan?.rationale);
  assert.equal(tracker.ops.filter((o) => o === "compose").length, 2);
});
