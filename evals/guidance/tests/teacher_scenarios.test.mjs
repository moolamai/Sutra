/**
 * Teacher CBSE-slice golden guidance scenarios (≥8) — corpus coverage & schema.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIOS_DIR,
  loadCommittedRubric,
  validateScenario,
  scoreAgainstExpected,
} from "../src/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEACHER_DIR = path.join(SCENARIOS_DIR, "teacher");
const MANIFEST = path.join(TEACHER_DIR, "manifest.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR";

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function loadTeacherCorpus() {
  const manifest = readJson(MANIFEST);
  const scenarios = manifest.scenarios.map((rel) => {
    const file = path.join(SCENARIOS_DIR, rel);
    assert.ok(existsSync(file), `missing ${rel}`);
    return { rel, scenario: readJson(file) };
  });
  return { manifest, scenarios };
}

test("unit: teacher manifest lists ≥8 scenarios on teacher-cbse-slice", () => {
  const { manifest, scenarios } = loadTeacherCorpus();
  assert.equal(manifest.packId, "teacher-cbse-slice");
  assert.ok(scenarios.length >= 8);
  assert.ok(scenarios.length <= loadCommittedRubric().bounds.maxScenarios);
});

test("happy path: every teacher golden validates against scenario-v1", () => {
  const { scenarios } = loadTeacherCorpus();
  for (const { rel, scenario } of scenarios) {
    const events = [];
    const result = validateScenario(scenario, {
      subjectId: scenario.subjectId,
      deviceId: scenario.deviceId,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, `${rel}: ${result.errors?.join("; ")}`);
    assert.equal(scenario.packId, "teacher-cbse-slice");
    assert.equal(scenario.packVersion, "1.0.0");
    assert.ok(
      ["advance", "remediate", "hold"].includes(scenario.expected.routeAction),
    );
    assert.ok(scenario.expected.targetConceptId);
    assert.ok(scenario.expected.rationaleKeywords.length >= 1);
    assert.equal(events[0].outcome, "ok");
    assert.equal(events[0].subjectId, scenario.subjectId);
  }
});

test("coverage: corpus includes advance, remediate, hold, hesitation-spike", () => {
  const { scenarios } = loadTeacherCorpus();
  const tags = new Set(scenarios.flatMap((s) => s.scenario.tags ?? []));
  for (const required of ["advance", "remediate", "hold", "hesitation-spike"]) {
    assert.ok(tags.has(required), `missing tag ${required}`);
  }
  const actions = new Set(
    scenarios.map((s) => s.scenario.expected.routeAction),
  );
  assert.ok(actions.has("advance"));
  assert.ok(actions.has("remediate"));
  assert.ok(actions.has("hold"));
});

test("edge: hysteresis + multi-weak-prereq scenarios are present", () => {
  const { scenarios } = loadTeacherCorpus();
  const byId = Object.fromEntries(
    scenarios.map((s) => [s.scenario.scenarioId, s.scenario]),
  );
  assert.ok(byId["teacher/hold-hesitation-boundary"]);
  assert.equal(
    byId["teacher/hold-hesitation-boundary"].turnFriction.hesitationMs,
    14999,
  );
  assert.ok(byId["teacher/remediate-multi-weak-recurse"]);
  assert.ok(
    (byId["teacher/remediate-multi-weak-recurse"].tags ?? []).includes(
      "multi-weak-prereq",
    ),
  );
});

test("sovereignty: distinct subjectIds; no raw content keys", () => {
  const { scenarios } = loadTeacherCorpus();
  const ids = scenarios.map((s) => s.scenario.subjectId);
  assert.equal(new Set(ids).size, ids.length);
  for (const { scenario } of scenarios) {
    const blob = JSON.stringify(scenario);
    assert.ok(!blob.includes(SECRET));
    assert.ok(!blob.includes("rawKeystrokes"));
    assert.ok(!("utterance" in scenario));
  }
});

test("observability: validate telemetry is subject-scoped", () => {
  const { scenarios } = loadTeacherCorpus();
  const events = [];
  for (const { scenario } of scenarios) {
    validateScenario(scenario, {
      subjectId: scenario.subjectId,
      deviceId: scenario.deviceId,
      onTelemetry: (e) => events.push(e),
    });
  }
  assert.equal(events.length, scenarios.length);
  for (const e of events) {
    assert.equal(e.outcome, "ok");
    assert.ok(e.subjectId.startsWith("subj.eval.teacher."));
  }
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("scalability: frictionHistory within rubric bounds", () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherCorpus();
  for (const { scenario } of scenarios) {
    assert.ok(
      scenario.frictionHistory.length <= rubric.bounds.maxFrictionHistory,
    );
  }
});

test("unit: self-score of expected decision meets failBelow (keyword budget)", () => {
  const rubric = loadCommittedRubric();
  const { scenarios } = loadTeacherCorpus();
  let sum = 0;
  for (const { scenario } of scenarios) {
    const rationale = scenario.expected.rationaleKeywords.join(" ");
    const scored = scoreAgainstExpected(
      {
        routeAction: scenario.expected.routeAction,
        targetConceptId: scenario.expected.targetConceptId,
        mode: scenario.expected.mode,
        rationale,
      },
      scenario.expected,
      rubric,
    );
    assert.equal(scored.score, 1, scenario.scenarioId);
    sum += scored.score;
  }
  const mean = sum / scenarios.length;
  assert.ok(mean >= rubric.failBelow);
});

test("unit: teacher dir has no stray json outside manifest", () => {
  const { manifest } = loadTeacherCorpus();
  const listed = new Set(
    manifest.scenarios.map((rel) => path.basename(rel)),
  );
  listed.add("manifest.json");
  for (const name of readdirSync(TEACHER_DIR)) {
    if (!name.endsWith(".json")) continue;
    assert.ok(listed.has(name), `unlisted file ${name}`);
  }
});
