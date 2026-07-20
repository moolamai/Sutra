/**
 * Seeded guidance-eval scorer — suite gate, keyword tolerance, determinism.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GuidanceEvalScoreError,
  createSeededRng,
  deriveModelAssistSeed,
  loadTeacherScenarios,
  resolveScenarioSeed,
  scoreAgainstExpected,
  scoreScenario,
  scoreSuite,
  actualFromDecision,
  isFrictionSpike,
} from "../src/score.mjs";
import { routerActualFromScenario } from "../src/router_actual.mjs";
import { loadCommittedRubric } from "../src/validate.mjs";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR";

test("unit: seeded RNG is deterministic for fixed seed", () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  const other = createSeededRng(99);
  assert.notDeepEqual(seqA, [other(), other(), other()]);
});

test("unit: deriveModelAssistSeed is stable and scenario-scoped", () => {
  const s1 = deriveModelAssistSeed(42, "teacher/hold-mid-band-ratios");
  const s2 = deriveModelAssistSeed(42, "teacher/hold-mid-band-ratios");
  const s3 = deriveModelAssistSeed(42, "teacher/advance-fractions-to-ratios");
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

test("happy path: teacher suite scores ≥ failBelow via route_core actuals", async () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherScenarios();
  assert.ok(scenarios.length >= 8);
  const events = [];
  const summary = await scoreSuite({
    scenarios,
    rubric,
    throwOnSuiteFail: true,
    onTelemetry: (e) => events.push(e),
    getActual: (scenario) => routerActualFromScenario(scenario),
  });
  assert.equal(summary.ok, true);
  assert.ok(summary.mean >= rubric.failBelow, `mean=${summary.mean}`);
  assert.equal(summary.count, scenarios.length);
  assert.ok(events.some((e) => e.event === "guidance_eval.suite" && e.outcome === "ok"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: suite fails with score_regression when actuals are wrong", async () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherScenarios();
  const sample = scenarios.slice(0, 3);
  await assert.rejects(
    () =>
      scoreSuite({
        scenarios: sample,
        rubric,
        throwOnSuiteFail: true,
        getActual: (scenario) => ({
          routeAction: "advance",
          targetConceptId: "math.WRONG",
          mode: "exploratory",
          rationale: "deliberately wrong",
        }),
      }),
    (err) =>
      err instanceof GuidanceEvalScoreError &&
      err.failureClass === "score_regression",
  );
});

test("edge: keyword partial credit is tolerant (not exact-match flaky)", () => {
  const rubric = loadCommittedRubric();
  const expected = {
    routeAction: "hold",
    targetConceptId: "math.ratios",
    mode: "exploratory",
    rationaleKeywords: ["nominal", "Ratios", "missing-kw"],
  };
  const scored = scoreAgainstExpected(
    {
      routeAction: "hold",
      targetConceptId: "math.ratios",
      mode: "exploratory",
      rationale: "friction → nominal GUIDE concept='Ratios'",
    },
    expected,
    rubric,
  );
  assert.ok(scored.components.rationaleKeywords > 0);
  assert.ok(scored.components.rationaleKeywords < 1);
  assert.ok(scored.score >= rubric.failBelow);
});

test("edge: hesitation boundary scenario scores as hold via router actual", () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherScenarios();
  const boundary = scenarios.find(
    (s) => s.scenarioId === "teacher/hold-hesitation-boundary",
  );
  assert.ok(boundary);
  assert.equal(boundary.turnFriction.hesitationMs, 14999);
  assert.equal(isFrictionSpike(boundary.turnFriction), false);
  const actual = routerActualFromScenario(boundary);
  assert.equal(actual.routeAction, "hold");
  const row = scoreScenario(boundary, actual, rubric);
  assert.equal(row.ok, true);
  assert.equal(row.seed, resolveScenarioSeed(boundary, rubric));
  assert.ok(row.modelAssistSeed > 0);
});

test("edge: multi-weak remediate scenario scores via router actual", () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherScenarios();
  const multi = scenarios.find(
    (s) => s.scenarioId === "teacher/remediate-multi-weak-recurse",
  );
  assert.ok(multi);
  const actual = routerActualFromScenario(multi);
  assert.equal(actual.routeAction, "remediate");
  assert.equal(actual.targetConceptId, "math.ratios");
  const row = scoreScenario(multi, actual, rubric);
  assert.ok(row.score >= rubric.failBelow);
});

test("sovereignty: suite telemetry is subject-scoped per scenario", async () => {
  const { scenarios } = loadTeacherScenarios();
  const events = [];
  await scoreSuite({
    scenarios: scenarios.slice(0, 2),
    throwOnSuiteFail: false,
    onTelemetry: (e) => events.push(e),
    getActual: (scenario) => routerActualFromScenario(scenario),
  });
  const scoreEvents = events.filter((e) => e.event === "guidance_eval.score");
  assert.equal(scoreEvents.length, 2);
  assert.notEqual(scoreEvents[0].subjectId, scoreEvents[1].subjectId);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("unit: actualFromDecision maps remediate/advance/hold", () => {
  assert.equal(
    actualFromDecision(
      {
        nextConceptId: "math.fractions",
        mode: "prerequisite-remediation",
        rationale: "SPIKE",
      },
      "math.ratios",
      true,
    ).routeAction,
    "remediate",
  );
});

test("determinism: scoring same suite twice yields identical mean", async () => {
  const { scenarios } = loadTeacherScenarios();
  const slice = scenarios.slice(0, 4);
  const run = () =>
    scoreSuite({
      scenarios: slice,
      throwOnSuiteFail: false,
      getActual: (scenario) => routerActualFromScenario(scenario),
    });
  const a = await run();
  const b = await run();
  assert.equal(a.mean, b.mean);
  assert.deepEqual(
    a.results.map((r) => r.score),
    b.results.map((r) => r.score),
  );
  assert.deepEqual(
    a.results.map((r) => r.modelAssistSeed),
    b.results.map((r) => r.modelAssistSeed),
  );
});
