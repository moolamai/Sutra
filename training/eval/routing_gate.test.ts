/**
 * B8 guidance routing promotion gate.
 * Run: node --experimental-strip-types --test training/eval/routing_gate.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RoutingGateContractError,
  assembleB8GuidanceEvalSuite,
  runRoutingPromotionGate,
  type B8GuidanceEvalScenario,
  type RoutingGateCandidateEvaluator,
  type RoutingPromotionTelemetryEvent,
} from "../../packages/learning/src/routing_promotion.ts";
import {
  B8_GUIDANCE_MANIFEST_HASH,
  loadB8GuidanceRoutingSuite,
  proveFullRoutingGateCi,
  runB8GuidanceRoutingGate,
} from "./routing_gate.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUBJECT_ID = "subject.routing-gate";

function evaluator(options: {
  candidateId: string;
  score: number;
  subjectId?: string;
  locality?: "on-device" | "self-hosted";
  overrides?: Readonly<Record<string, number>>;
}): RoutingGateCandidateEvaluator {
  const subjectId = options.subjectId ?? SUBJECT_ID;
  return {
    candidateId: options.candidateId,
    subjectId,
    locality: options.locality ?? "on-device",
    evaluate(scenario) {
      return {
        scenarioId: scenario.scenarioId,
        subjectId,
        pinnedSeed: scenario.pinnedSeed,
        score: options.overrides?.[scenario.scenarioId] ?? options.score,
        evaluatedCaseIds: scenario.cases.map((entry) => entry.caseId),
      };
    },
  };
}

function champion(candidateId: string): RoutingGateCandidateEvaluator {
  return evaluator({
    candidateId,
    score: 0.8,
    overrides: { "lawyer-scope-refusal": 1 },
  });
}

test("known-good candidate promotes on every frozen B8 guidance scenario", async () => {
  const events: RoutingPromotionTelemetryEvent[] = [];
  const suite = loadB8GuidanceRoutingSuite({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
  });

  assert.equal(suite.frozen, true);
  assert.equal(suite.heldOut, true);
  assert.equal(suite.decontaminated, true);
  assert.equal(suite.excludeFromTrainingCorpora, true);
  assert.equal(suite.manifestContentHash, B8_GUIDANCE_MANIFEST_HASH);
  assert.deepEqual(
    suite.scenarios.map((scenario) => scenario.scenarioId),
    ["teacher-guidance-tone", "lawyer-scope-refusal"],
  );
  assert.deepEqual(
    suite.scenarios.map((scenario) => scenario.sliceId),
    ["teacher/en/b8", "lawyer/en/b8"],
  );

  const verdict = await runB8GuidanceRoutingGate({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    deviceId: "device.routing-gate",
    champion: champion("b8.champion"),
    challenger: evaluator({ candidateId: "routing.challenger", score: 1 }),
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(verdict.verdict, "promote");
  assert.equal(verdict.promoted, true);
  assert.ok(verdict.aggregateDelta > 0);
  assert.equal(verdict.scenarios.length, suite.scenarios.length);
  assert.equal(verdict.slices.length, 2);
  assert.deepEqual(verdict.failingScenarioIds, []);
  assert.ok(verdict.slices.every((slice) => slice.status !== "behind"));
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.routing_gate.verdict" &&
        event.verdict === "promote" &&
        event.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes("tone-warm"));
});

test("slice regression rejects even when aggregate improves and names slice", async () => {
  const verdict = await runB8GuidanceRoutingGate({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
    champion: champion("b8.champion"),
    challenger: evaluator({
      candidateId: "routing.regressed",
      score: 1,
      overrides: { "teacher-guidance-tone": 0.79 },
    }),
  });

  assert.equal(verdict.verdict, "reject");
  assert.equal(verdict.promoted, false);
  assert.equal(verdict.reason, "challenger_threshold_failed");
  assert.equal(verdict.failingSlice, "teacher/en/b8");
  assert.deepEqual(verdict.failingScenarioIds, ["teacher-guidance-tone"]);

  // Above threshold but below champion proves per-slice non-regression is
  // independent of aggregate accuracy.
  const suite = loadB8GuidanceRoutingSuite({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
  });
  const loweredThresholdSuite = {
    ...suite,
    scenarios: suite.scenarios.map((scenario) => ({
      ...scenario,
      threshold: 0.7,
    })),
  };
  const rebuilt = assembleB8GuidanceEvalSuite({
    subjectId: loweredThresholdSuite.subjectId,
    locality: loweredThresholdSuite.locality,
    manifestContentHash: loweredThresholdSuite.manifestContentHash,
    scenarios: loweredThresholdSuite.scenarios,
    trainingCorpusContentHashes: [],
    surgeryClasses: ["learned_routing"],
  });
  const sliceRegression = await runRoutingPromotionGate({
    suite: rebuilt,
    champion: evaluator({ candidateId: "b8.champion.2", score: 0.8 }),
    challenger: evaluator({
      candidateId: "routing.regressed.2",
      score: 1,
      overrides: { "teacher-guidance-tone": 0.79 },
    }),
    deviceId: "ci-routing-gate",
  });
  assert.equal(sliceRegression.verdict, "reject");
  assert.equal(sliceRegression.reason, "slice_regression");
  assert.equal(sliceRegression.failingSlice, "teacher/en/b8");
  assert.ok(sliceRegression.aggregateDelta > 0);
});

test("frozen eval contamination and multiple surgeries void the gate", () => {
  assert.throws(
    () =>
      loadB8GuidanceRoutingSuite({
        expectedSubjectId: SUBJECT_ID,
        locality: "on-device",
        trainingCorpusContentHashes: [B8_GUIDANCE_MANIFEST_HASH],
        repoRoot: REPO_ROOT,
      }),
    (error) =>
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.train_on_eval_void",
  );

  const scenario: B8GuidanceEvalScenario = {
    scenarioId: "guidance.fixture",
    sliceId: "teacher/en/b8",
    pinnedSeed: 1,
    rubricAspect: "tone",
    threshold: 0.8,
    cases: [{ caseId: "case.one", expectedOutcome: "pass" }],
    sourceContentHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.throws(
    () =>
      assembleB8GuidanceEvalSuite({
        subjectId: SUBJECT_ID,
        locality: "on-device",
        manifestContentHash:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scenarios: [scenario],
        trainingCorpusContentHashes: [],
        surgeryClasses: ["learned_routing", "compaction"],
      }),
    (error) =>
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.attribution_void",
  );
});

test("subject isolation, full-case evidence, timeout, and replay are enforced", async () => {
  const common = {
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device" as const,
    trainingCorpusContentHashes: [],
    repoRoot: REPO_ROOT,
  };
  await assert.rejects(
    () =>
      runB8GuidanceRoutingGate({
        ...common,
        champion: champion("b8.champion"),
        challenger: evaluator({
          candidateId: "routing.cross-subject",
          score: 1,
          subjectId: "subject.other",
        }),
      }),
    (error) =>
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.subject_scope",
  );

  const incomplete = evaluator({
    candidateId: "routing.incomplete",
    score: 1,
  });
  incomplete.evaluate = (scenario) => ({
    scenarioId: scenario.scenarioId,
    subjectId: SUBJECT_ID,
    pinnedSeed: scenario.pinnedSeed,
    score: 1,
    evaluatedCaseIds: [scenario.cases[0]!.caseId],
  });
  await assert.rejects(
    () =>
      runB8GuidanceRoutingGate({
        ...common,
        champion: champion("b8.complete"),
        challenger: incomplete,
      }),
    (error) =>
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.invalid_observation",
  );

  const never = evaluator({ candidateId: "routing.timeout", score: 1 });
  never.evaluate = () => new Promise(() => {});
  await assert.rejects(
    () =>
      runB8GuidanceRoutingGate({
        ...common,
        champion: champion("b8.fast"),
        challenger: never,
        timeoutMs: 10,
      }),
    (error) =>
      error instanceof RoutingGateContractError &&
      error.obligation === "routing_gate.downstream_timeout" &&
      error.failingSlice === "teacher/en/b8",
  );

  let evaluations = 0;
  const counted = evaluator({ candidateId: "routing.counted", score: 1 });
  const original = counted.evaluate;
  counted.evaluate = (scenario, signal) => {
    evaluations += 1;
    return original(scenario, signal);
  };
  const first = await runB8GuidanceRoutingGate({
    ...common,
    runId: "routing-run-replay",
    champion: champion("b8.replay"),
    challenger: counted,
  });
  const replay = await runB8GuidanceRoutingGate({
    ...common,
    runId: "routing-run-replay",
    champion: champion("b8.replay"),
    challenger: counted,
  });
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(evaluations, 2);
  assert.deepEqual(
    { ...replay, idempotentReplay: false },
    first,
  );
});

test("CI prove: equal-score tie reject; strict promote; slice regression names slice", async () => {
  const events: Array<{ event: string; outcome?: string; fixture?: string }> =
    [];
  const proved = await proveFullRoutingGateCi({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    deviceId: "ci-routing-gate-prove",
    repoRoot: REPO_ROOT,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(proved.ok, true);
  assert.equal(proved.replayOk, true);

  assert.equal(proved.flagOffParity.verdict, "reject");
  assert.equal(proved.flagOffParity.reason, "tie");
  assert.equal(proved.flagOffParity.aggregateDelta, 0);

  assert.equal(proved.seededPromote.verdict, "promote");
  assert.ok(proved.seededPromote.aggregateDelta > 0);

  assert.equal(proved.tieReject.verdict, "reject");
  assert.equal(proved.tieReject.reason, "tie");

  assert.equal(proved.sliceRegression.verdict, "reject");
  assert.equal(proved.sliceRegression.reason, "slice_regression");
  assert.equal(proved.sliceRegression.failingSlice, "teacher/en/b8");
  assert.ok(
    proved.sliceRegression.failingScenarioIds.includes(
      "teacher-guidance-tone",
    ),
  );

  const replay = await proveFullRoutingGateCi({
    expectedSubjectId: SUBJECT_ID,
    locality: "on-device",
    trainingCorpusContentHashes: [],
    deviceId: "ci-routing-gate-prove",
    repoRoot: REPO_ROOT,
  });
  assert.equal(
    replay.seededPromote.aggregateDelta,
    proved.seededPromote.aggregateDelta,
  );
  assert.equal(replay.sliceRegression.failingSlice, proved.sliceRegression.failingSlice);

  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.routing_gate.ci" && event.outcome === "ok",
    ),
  );
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("tone-warm"));
  assert.ok(!wire.includes("refuse-out-of-jurisdiction"));
});
