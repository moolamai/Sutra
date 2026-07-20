/**
 * Edge cold-start gate helpers (CAST-05.1) — routing seam.
 * Run: node --test packages/edge-agent/tests/coldstart.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAST_05_1_OBLIGATION_ID,
  CAST_05_MIN_ROOT_FRICTION_SAMPLES,
  applyColdStartGate,
  coldStartBlocksAdvance,
  createEdgeColdStartRouter,
  evaluateColdStartRoute,
  listUnassessedRoots,
  masteryEvidenceCounts,
  rootConceptIdsFromNodes,
} from "../dist/coldstart.js";

test("happy path: unassessed roots block advance; diagnostic mode", () => {
  const events = [];
  const result = evaluateColdStartRoute(
    {
      subjectId: "subj-edge-cold",
      activeConceptId: "math.ratios",
      rootConceptIds: ["math.fractions"],
      frictionSampleCounts: { "math.fractions": 0 },
      masteryMeanByConcept: { "math.ratios": 0.99 },
    },
    (e) => events.push(e),
  );
  assert.equal(result.routeAction, "diagnostic-probe");
  assert.equal(result.mode, "diagnostic");
  assert.deepEqual(result.unassessedRootConceptIds, ["math.fractions"]);
  assert.equal(result.subjectId, "subj-edge-cold");
  assert.ok(
    events.some(
      (e) =>
        e.outcome === "block_advance" &&
        e.subjectId === "subj-edge-cold" &&
        e.event === "coldstart.gate" &&
        e.obligationId === CAST_05_1_OBLIGATION_ID,
    ),
  );
});

test("edge: applyColdStartGate quarantines advance with advisory", () => {
  const events = [];
  const gate = applyColdStartGate({
    subjectId: "subj-gate",
    rootConceptIds: ["root.a", "root.b"],
    frictionSampleCounts: {
      "root.a": CAST_05_MIN_ROOT_FRICTION_SAMPLES,
      "root.b": 1,
    },
    mode: "exploratory",
    wouldAdvance: true,
    deviceId: "dev-1",
    emit: (e) => events.push(e),
  });
  assert.equal(gate.blocked, true);
  assert.equal(gate.probeConceptId, "root.b");
  assert.equal(gate.mode, "diagnostic");
  assert.ok(gate.rationaleAdvisory?.includes(CAST_05_1_OBLIGATION_ID));
  assert.ok(events.some((e) => e.deviceId === "dev-1" && e.outcome === "block_advance"));
});

test("edge: partial assessment still blocks", () => {
  assert.equal(
    coldStartBlocksAdvance({
      rootConceptIds: ["a", "b"],
      frictionSampleCounts: {
        a: CAST_05_MIN_ROOT_FRICTION_SAMPLES,
        b: 1,
      },
    }),
    true,
  );
  assert.deepEqual(
    listUnassessedRoots(
      ["a", "b"],
      { a: CAST_05_MIN_ROOT_FRICTION_SAMPLES, b: 1 },
    ),
    ["b"],
  );
});

test("edge: all roots assessed allows advance on high mastery", () => {
  const router = createEdgeColdStartRouter();
  const result = router.route({
    subjectId: "subj-edge-ready",
    activeConceptId: "math.ratios",
    rootConceptIds: ["math.fractions"],
    frictionSampleCounts: {
      "math.fractions": CAST_05_MIN_ROOT_FRICTION_SAMPLES,
    },
    masteryMeanByConcept: { "math.ratios": 0.9 },
  });
  assert.equal(result.routeAction, "advance");
  assert.equal(result.mode, "exploratory");
  assert.deepEqual(result.unassessedRootConceptIds, []);
});

test("edge: masteryEvidenceCounts and rootConceptIdsFromNodes", () => {
  const counts = masteryEvidenceCounts({
    "math.fractions": { alpha: { d: 20 }, beta: { d: 1 } },
  });
  assert.equal(counts["math.fractions"], 21);
  assert.deepEqual(
    rootConceptIdsFromNodes([
      { conceptId: "math.fractions", prerequisites: [] },
      { conceptId: "math.ratios", prerequisites: ["math.fractions"] },
    ]),
    ["math.fractions"],
  );
});

test("edge: remediation mode is not overridden by cold-start retarget", () => {
  const gate = applyColdStartGate({
    subjectId: "subj-rem",
    rootConceptIds: ["root.a"],
    frictionSampleCounts: { "root.a": 0 },
    mode: "prerequisite-remediation",
    wouldAdvance: false,
  });
  assert.equal(gate.blocked, false);
  assert.equal(gate.mode, null);
  assert.equal(gate.rationaleAdvisory, null);
});

test("sovereignty: missing subjectId is a typed failure", () => {
  assert.throws(
    () =>
      evaluateColdStartRoute({
        subjectId: "",
        activeConceptId: "x",
        rootConceptIds: ["r"],
        frictionSampleCounts: {},
      }),
    /subject_missing/,
  );
});

test("catalog: obligation id stable", () => {
  assert.equal(CAST_05_1_OBLIGATION_ID, "CAST-05.1");
  assert.equal(CAST_05_MIN_ROOT_FRICTION_SAMPLES, 3);
});
