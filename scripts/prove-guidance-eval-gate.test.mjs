/**
 * Unit + integration coverage for the guidance-eval red→green proof.
 * Run: node --test scripts/prove-guidance-eval-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SEED_MARKER,
  SEED_MIN_AGGREGATE,
  SEED_ROUTE_ACTION,
  SEED_SCENARIO_ID,
  seedBrokenThresholdRouting,
  restoreSeededFiles,
  proveGuidanceEvalGate,
} from "./prove-guidance-eval-gate.mjs";

const THRESHOLD_FIXTURE = {
  schemaVersion: "guidance-eval.threshold.v1",
  title: "test",
  minAggregateScore: 0.85,
  packId: "teacher-cbse-slice",
  packPath: "packages/domain-loader/fixtures/packs/teacher-cbse-slice.json",
  manifest: "teacher/manifest.json",
  tooling: { node: "22", pnpm: "10.30.3" },
};

const SCENARIO_FIXTURE = {
  schemaVersion: "guidance-eval.scenario.v1",
  scenarioId: SEED_SCENARIO_ID,
  subjectId: "subj.eval.teacher.advance.fractions",
  expected: {
    routeAction: "advance",
    targetConceptId: "math.ratios",
  },
};

test("seedBrokenThresholdRouting raises threshold and flips expected route", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-guidance-prove-"));
  const thresholdPath = path.join(dir, "threshold.json");
  const scenarioPath = path.join(dir, "scenario.json");
  try {
    writeFileSync(thresholdPath, JSON.stringify(THRESHOLD_FIXTURE, null, 2));
    writeFileSync(scenarioPath, JSON.stringify(SCENARIO_FIXTURE, null, 2));

    const originals = seedBrokenThresholdRouting({
      thresholdPath,
      scenarioPath,
    });
    const seededThreshold = JSON.parse(readFileSync(thresholdPath, "utf8"));
    const seededScenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

    assert.equal(seededThreshold.minAggregateScore, SEED_MIN_AGGREGATE);
    assert.equal(seededThreshold._seedMarker, SEED_MARKER);
    assert.equal(seededScenario.expected.routeAction, SEED_ROUTE_ACTION);
    assert.equal(seededScenario.subjectId, SCENARIO_FIXTURE.subjectId);

    restoreSeededFiles(originals, { thresholdPath, scenarioPath });
    assert.equal(
      JSON.parse(readFileSync(thresholdPath, "utf8")).minAggregateScore,
      0.85,
    );
    assert.equal(
      JSON.parse(readFileSync(scenarioPath, "utf8")).expected.routeAction,
      "advance",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedBrokenThresholdRouting rejects already-seeded tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-guidance-prove-"));
  const thresholdPath = path.join(dir, "threshold.json");
  const scenarioPath = path.join(dir, "scenario.json");
  try {
    writeFileSync(
      thresholdPath,
      JSON.stringify({ ...THRESHOLD_FIXTURE, _seedMarker: SEED_MARKER }),
    );
    writeFileSync(scenarioPath, JSON.stringify(SCENARIO_FIXTURE));
    assert.throws(
      () => seedBrokenThresholdRouting({ thresholdPath, scenarioPath }),
      /ALREADY_SEEDED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proveGuidanceEvalGate red→green with injectable runGate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-guidance-prove-"));
  const thresholdPath = path.join(dir, "threshold.json");
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(thresholdPath, JSON.stringify(THRESHOLD_FIXTURE, null, 2));
  writeFileSync(scenarioPath, JSON.stringify(SCENARIO_FIXTURE, null, 2));

  let calls = 0;
  const runGate = () => {
    calls += 1;
    if (calls === 1) {
      return { status: 0, stdout: "ok", stderr: "", combined: "ok" };
    }
    if (calls === 2) {
      const diff = JSON.stringify({
        event: "guidance_eval.diff",
        scenarioId: SEED_SCENARIO_ID,
        expected: { routeAction: SEED_ROUTE_ACTION },
        actual: { routeAction: "advance" },
        scoreDelta: -0.999,
      });
      return {
        status: 1,
        stdout: "",
        stderr: diff,
        combined: diff,
      };
    }
    return { status: 0, stdout: "ok", stderr: "", combined: "ok" };
  };

  try {
    const result = proveGuidanceEvalGate({
      thresholdPath,
      scenarioPath,
      runGate,
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
    assert.equal(
      JSON.parse(readFileSync(thresholdPath, "utf8")).minAggregateScore,
      0.85,
    );
    assert.ok(!readFileSync(thresholdPath, "utf8").includes(SEED_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proveGuidanceEvalGate fails when seeded gate stays green", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-guidance-prove-"));
  const thresholdPath = path.join(dir, "threshold.json");
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(thresholdPath, JSON.stringify(THRESHOLD_FIXTURE, null, 2));
  writeFileSync(scenarioPath, JSON.stringify(SCENARIO_FIXTURE, null, 2));

  const runGate = () => ({
    status: 0,
    stdout: "ok",
    stderr: "",
    combined: "ok",
  });

  try {
    const result = proveGuidanceEvalGate({
      thresholdPath,
      scenarioPath,
      runGate,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some((f) => f.includes("SEEDED_DRIFT_DID_NOT_FAIL")),
    );
    assert.ok(!readFileSync(thresholdPath, "utf8").includes(SEED_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proveGuidanceEvalGate fails when red has no DIFF", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-guidance-prove-"));
  const thresholdPath = path.join(dir, "threshold.json");
  const scenarioPath = path.join(dir, "scenario.json");
  writeFileSync(thresholdPath, JSON.stringify(THRESHOLD_FIXTURE, null, 2));
  writeFileSync(scenarioPath, JSON.stringify(SCENARIO_FIXTURE, null, 2));

  let calls = 0;
  const runGate = () => {
    calls += 1;
    if (calls === 1 || calls === 3) {
      return { status: 0, stdout: "ok", stderr: "", combined: "ok" };
    }
    return {
      status: 1,
      stdout: "",
      stderr: "fail silently",
      combined: "fail silently",
    };
  };

  try {
    const result = proveGuidanceEvalGate({
      thresholdPath,
      scenarioPath,
      runGate,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("SEEDED_DRIFT_NO_DIFF")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
