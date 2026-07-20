/**
 * Durable session seed → activePlans restore (rehydration path).
 * Run: pnpm --filter @moolam/cognitive-core test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CognitiveCore,
  durableSeedFromRehydration,
} from "../dist/index.js";

function makeBindings() {
  return {
    memory: {
      remember: async (item) => ({ ...item, id: "trace-1" }),
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
      generate: async () => ({ text: "grounded reply", finishReason: "stop" }),
      generateStream: async function* () {
        yield "grounded reply";
      },
      embed: async () => new Float32Array(4),
    },
    reasoning: {
      deliberate: async () => ({
        conclusion: "conclusion",
        confidence: 0.8,
        steps: [],
        unresolvedConstraints: [],
      }),
    },
    planning: {
      compose: async (goals) => ({
        planId: "p-compose",
        steps: goals.slice(0, 1).map((g) => ({
          stepId: "s1",
          goalId: g.goalId,
          action: "act",
          dependsOn: [],
          status: "active",
        })),
        rationale: "r-compose",
      }),
      revise: async (plan) => plan,
      nextStep: () => null,
    },
    tools: {
      list: () => [],
      invoke: async (i) => ({
        invocationId: i.invocationId,
        ok: true,
        result: {},
      }),
    },
    knowledge: {
      retrieve: async () => [],
      upsert: async () => {},
    },
  };
}

const profile = {
  domainId: "math",
  charter: "Teach.",
  refusals: ["refusal:medical-advice"],
  languages: ["en"],
};

test("happy path: applyDurableSessionSeed restores plan without history replay", () => {
  const core = new CognitiveCore(profile, makeBindings());
  const plan = {
    planId: "plan-restored",
    rationale: "from durable tier",
    steps: [
      {
        stepId: "s1",
        goalId: "g1",
        action: "review",
        dependsOn: [],
        status: "active",
      },
    ],
  };
  const seed = durableSeedFromRehydration({
    subjectId: "anika-k",
    sessionId: "sess-1",
    activePlan: plan,
    correctionCount: 2,
  });
  const applied = core.applyDurableSessionSeed(seed);
  assert.equal(applied.ok, true);
  assert.equal(applied.skippedHistoryReplay, true);
  assert.equal(applied.planRestored, true);
  assert.equal(core.getActivePlan("sess-1")?.planId, "plan-restored");
});

test("sovereignty: turn rejects durableSeed with mismatched subjectId", async () => {
  const core = new CognitiveCore(profile, makeBindings());
  await assert.rejects(
    () =>
      core.turn({
        subjectId: "anika-k",
        sessionId: "sess-1",
        utterance: "hi",
        durableSeed: {
          subjectId: "other-learner",
          sessionId: "sess-1",
          activePlan: null,
        },
      }),
    /subjectId/,
  );
});

test("edge: turn with matching durableSeed accepts seed before loop", async () => {
  const core = new CognitiveCore(profile, makeBindings());
  const out = await core.turn({
    subjectId: "anika-k",
    sessionId: "sess-resume",
    utterance: "continue",
    durableSeed: {
      subjectId: "anika-k",
      sessionId: "sess-resume",
      activePlan: {
        planId: "plan-seeded",
        rationale: "resume",
        steps: [
          {
            stepId: "s1",
            goalId: "g1",
            action: "continue",
            dependsOn: [],
            status: "active",
          },
        ],
      },
    },
  });
  assert.equal(typeof out.reply, "string");
  assert.equal(out.declined, false);
  // Seed applied; plan stage may reuse or revise — session still has a plan.
  assert.ok(core.getActivePlan("sess-resume"));
});
