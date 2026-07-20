/**
 * Guidance eval CI gate — run.mjs + threshold.json.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  THRESHOLD_PATH,
  THRESHOLD_SCHEMA_VERSION,
  loadThreshold,
  validateThreshold,
  runGuidanceEvalGate,
  emitScenarioDiffs,
} from "../run.mjs";
import { loadCommittedRubric } from "../src/validate.mjs";
import { GuidanceEvalScoreError } from "../src/score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR";

test("unit: threshold.json exists with pinned tooling and teacher pack", () => {
  assert.ok(existsSync(THRESHOLD_PATH));
  const t = loadThreshold();
  assert.equal(t.schemaVersion, THRESHOLD_SCHEMA_VERSION);
  assert.equal(t.minAggregateScore, 0.85);
  assert.equal(t.packId, "teacher-cbse-slice");
  assert.ok(t.packPath.includes("teacher-cbse-slice.json"));
  assert.ok(!t.packPath.includes("demo-math-sd-slice"));
  assert.equal(t.tooling.node, "22");
  assert.equal(t.tooling.pnpm, "10.30.3");
  validateThreshold(t, loadCommittedRubric());
});

test("happy path: gate is green on committed teacher corpus", async () => {
  const result = await runGuidanceEvalGate({ emit: false });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.summary.mean >= result.threshold.minAggregateScore);
  assert.ok(result.summary.count >= 8);
  assert.equal(result.summary.failBelow, 0.85);
});

test("edge: intentionally broken threshold turns gate red with DIFF", async () => {
  const original = readFileSync(THRESHOLD_PATH, "utf8");
  try {
    const broken = JSON.parse(original);
    // Strict floor that a mismatched suite cannot meet.
    broken.minAggregateScore = 0.99;
    writeFileSync(THRESHOLD_PATH, JSON.stringify(broken, null, 2) + "\n");

    const chunks = [];
    const origErr = console.error;
    console.error = (...args) => {
      chunks.push(args.map(String).join(" "));
    };
    try {
      const result = await runGuidanceEvalGate({
        emit: true,
        getActual: () => ({
          routeAction: "advance",
          targetConceptId: "math.WRONG",
          mode: "exploratory",
          rationale: "seeded mismatch for red proof",
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.summary.mean < 0.99);
      const blob = chunks.join("\n");
      assert.match(blob, /guidance_eval\.diff/);
      assert.match(blob, /scenarioId/);
      assert.match(blob, /scoreDelta/);
      assert.match(blob, /expected/);
      assert.match(blob, /actual/);
      assert.match(blob, /math\.WRONG/);
      assert.ok(!blob.includes(SECRET));
    } finally {
      console.error = origErr;
    }
  } finally {
    writeFileSync(THRESHOLD_PATH, original);
  }
});

test("edge: threshold weaker than rubric.failBelow is rejected", () => {
  const rubric = loadCommittedRubric();
  const t = loadThreshold();
  t.minAggregateScore = 0.5;
  assert.throws(
    () => validateThreshold(t, rubric),
    (err) =>
      err instanceof GuidanceEvalScoreError &&
      err.failureClass === "threshold_invalid",
  );
});

test("edge: demo pack path is rejected (must use production teacher pack)", () => {
  const rubric = loadCommittedRubric();
  const t = loadThreshold();
  t.packPath = "packages/domain-loader/fixtures/packs/demo-math-sd-slice.json";
  assert.throws(
    () => validateThreshold(t, rubric),
    (err) =>
      err instanceof GuidanceEvalScoreError &&
      err.failureClass === "threshold_invalid",
  );
});

test("edge: wrong getActual emits DIFF without silent pass", async () => {
  const chunks = [];
  const origErr = console.error;
  console.error = (...args) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    const result = await runGuidanceEvalGate({
      emit: true,
      getActual: () => ({
        routeAction: "advance",
        targetConceptId: "math.WRONG",
        mode: "exploratory",
        rationale: "forced mismatch",
      }),
    });
    assert.equal(result.ok, false);
    const blob = chunks.join("\n");
    assert.match(blob, /guidance_eval\.diff/);
    assert.match(blob, /math\.WRONG/);
    assert.ok(!blob.includes(SECRET));
  } finally {
    console.error = origErr;
  }
});

test("sovereignty: gate telemetry never carries secret utterance marker", async () => {
  const result = await runGuidanceEvalGate({ emit: false });
  assert.ok(!JSON.stringify(result.events).includes(SECRET));
  assert.ok(
    result.events.some(
      (e) => e.event === "guidance_eval.gate" && e.outcome === "ok",
    ),
  );
});

test("unit: emitScenarioDiffs is a no-op for perfect rows", () => {
  const lines = [];
  const origErr = console.error;
  console.error = (s) => lines.push(String(s));
  try {
    emitScenarioDiffs({
      failBelow: 0.85,
      results: [
        {
          score: 1,
          subjectId: "subj.a",
          scenarioId: "perfect",
          actual: {
            routeAction: "hold",
            targetConceptId: "math.ratios",
            mode: "exploratory",
          },
          expected: {
            routeAction: "hold",
            targetConceptId: "math.ratios",
            mode: "exploratory",
          },
        },
      ],
    });
    assert.equal(lines.length, 0);
  } finally {
    console.error = origErr;
  }
});

test("scalability: gate scenario count within rubric bounds", async () => {
  const result = await runGuidanceEvalGate({ emit: false });
  const rubric = loadCommittedRubric();
  assert.ok(result.summary.count <= rubric.bounds.maxScenarios);
});

void __dirname;
void path;
