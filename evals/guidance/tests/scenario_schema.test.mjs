/**
 * Guidance-eval scenario + rubric schema — format proofs for EVALSCEN-001.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUIDANCE_EVAL_ROOT,
  RUBRIC_PATH,
  SCENARIO_SCHEMA_PATH,
  RUBRIC_SCHEMA_PATH,
  SCENARIOS_DIR,
  SCENARIO_SCHEMA_VERSION,
  RUBRIC_SCHEMA_VERSION,
  validateScenario,
  validateRubric,
  loadCommittedRubric,
  scoreAgainstExpected,
  inferRouteAction,
} from "../src/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR";

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function listScenarioFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "invalid") continue;
      out.push(...listScenarioFiles(p));
    } else if (name.name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

test("unit: committed schemas and rubric exist with locked versions", () => {
  assert.ok(existsSync(SCENARIO_SCHEMA_PATH));
  assert.ok(existsSync(RUBRIC_SCHEMA_PATH));
  assert.ok(existsSync(RUBRIC_PATH));
  const scenarioSchema = readJson(SCENARIO_SCHEMA_PATH);
  const rubricSchema = readJson(RUBRIC_SCHEMA_PATH);
  assert.equal(
    scenarioSchema.properties.schemaVersion.const,
    SCENARIO_SCHEMA_VERSION,
  );
  assert.equal(
    rubricSchema.properties.schemaVersion.const,
    RUBRIC_SCHEMA_VERSION,
  );
  assert.deepEqual(
    scenarioSchema.$defs.expectedDecision.properties.routeAction.enum,
    ["advance", "remediate", "hold"],
  );
  assert.ok(scenarioSchema.$defs.frictionSample);
  assert.equal(
    scenarioSchema.$defs.frictionSample.additionalProperties,
    false,
  );
});

test("happy path: committed rubric validates and weights sum to 1", () => {
  const events = [];
  const rubric = loadCommittedRubric();
  const result = validateRubric(rubric, {
    subjectId: "subj.rubric.valid",
    deviceId: "dev-eval",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(rubric.failBelow, 0.85);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.rubric.valid");
  const sum =
    rubric.weights.routeAction +
    rubric.weights.targetConceptId +
    rubric.weights.mode +
    rubric.weights.rationaleKeywords;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("happy path: format-example scenarios validate", () => {
  const files = listScenarioFiles(SCENARIOS_DIR).filter((f) =>
    path.basename(f).startsWith("format-example-"),
  );
  assert.ok(files.length >= 2);
  for (const file of files) {
    const events = [];
    const raw = readJson(file);
    const result = validateScenario(raw, {
      subjectId: raw.subjectId,
      deviceId: raw.deviceId,
      onTelemetry: (e) => events.push(e),
    });
    assert.equal(result.ok, true, `${file}: ${result.errors?.join("; ")}`);
    assert.equal(events[0].outcome, "ok");
    assert.equal(events[0].subjectId, raw.subjectId);
  }
});

test("edge: missing routeAction rejected", () => {
  const raw = readJson(
    path.join(SCENARIOS_DIR, "invalid", "missing-route-action.json"),
  );
  const result = validateScenario(raw, {
    subjectId: "subj.eval.missing",
    deviceId: "dev-eval",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "schema_invalid");
});

test("edge: raw keystrokes field rejected (sovereignty)", () => {
  const raw = readJson(
    path.join(SCENARIOS_DIR, "invalid", "raw-keystrokes-forbidden.json"),
  );
  const events = [];
  const result = validateScenario(raw, {
    subjectId: "subj.eval.raw",
    deviceId: "dev-eval",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "schema_invalid");
  assert.equal(events[0].outcome, "fail");
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: rubric weight sum failure is distinct failureClass", () => {
  const rubric = structuredClone(loadCommittedRubric());
  rubric.weights.routeAction = 0.9;
  const result = validateRubric(rubric, {
    subjectId: "subj.rubric.bad",
    deviceId: "dev-eval",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "weight_sum");
});

test("happy path: partial score awards keyword fraction", () => {
  const rubric = loadCommittedRubric();
  const expected = {
    routeAction: "hold",
    targetConceptId: "math.ratios",
    mode: "exploratory",
    rationaleKeywords: ["hold", "0.85", "missing-kw"],
  };
  const perfect = scoreAgainstExpected(
    {
      routeAction: "hold",
      targetConceptId: "math.ratios",
      mode: "exploratory",
      rationale: "hold: τ_r=0.40 ≤ posterior < τ_a=0.85",
    },
    expected,
    rubric,
  );
  assert.ok(perfect.score >= rubric.failBelow);
  assert.equal(perfect.components.routeAction, 1);
  assert.ok(perfect.components.rationaleKeywords < 1);
  assert.ok(perfect.components.rationaleKeywords > 0);

  const miss = scoreAgainstExpected(
    {
      routeAction: "advance",
      targetConceptId: "math.fractions",
      mode: "exploratory",
      rationale: "advancing",
    },
    expected,
    rubric,
  );
  assert.ok(miss.score < rubric.failBelow);
});

test("unit: inferRouteAction maps remediate/advance/hold", () => {
  assert.equal(
    inferRouteAction({
      nextConceptId: "math.fractions",
      mode: "prerequisite-remediation",
      activeConceptId: "math.ratios",
      spiked: true,
    }),
    "remediate",
  );
  assert.equal(
    inferRouteAction({
      nextConceptId: "math.ratios",
      mode: "exploratory",
      activeConceptId: "math.fractions",
      spiked: false,
    }),
    "advance",
  );
  assert.equal(
    inferRouteAction({
      nextConceptId: "math.ratios",
      mode: "exploratory",
      activeConceptId: "math.ratios",
      spiked: false,
    }),
    "hold",
  );
});

test("sovereignty: format scenarios use distinct subjectIds", () => {
  const files = listScenarioFiles(SCENARIOS_DIR).filter((f) =>
    path.basename(f).startsWith("format-example-"),
  );
  const ids = files.map((f) => readJson(f).subjectId);
  assert.equal(new Set(ids).size, ids.length);
});

test("scalability: scenario + history counts within rubric bounds", () => {
  const rubric = loadCommittedRubric();
  const files = listScenarioFiles(SCENARIOS_DIR);
  assert.ok(files.length <= rubric.bounds.maxScenarios);
  for (const file of files) {
    const raw = readJson(file);
    assert.ok(
      (raw.frictionHistory?.length ?? 0) <= rubric.bounds.maxFrictionHistory,
    );
  }
  assert.ok(GUIDANCE_EVAL_ROOT.includes("guidance"));
});

test("observability: validate telemetry never carries titles as content leak check", () => {
  const raw = readJson(
    path.join(SCENARIOS_DIR, "format-example-hold-hysteresis.json"),
  );
  const events = [];
  validateScenario(raw, {
    subjectId: raw.subjectId,
    deviceId: raw.deviceId,
    onTelemetry: (e) => events.push(e),
  });
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
  assert.match(blob, /subjectId/);
  assert.match(blob, /deviceId/);
  assert.ok(!blob.includes("rawKeystrokes"));
});
