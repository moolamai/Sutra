/**
 * CAST-05 cold-start parity: playground routeTurnOnGraph matches shared goldens
 * (same bytes as Python TaskRouter / edge-agent coldstart harness).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateTaskGraphFromPackObject } from "@moolam/domain-loader";
import { routeTurnOnGraph } from "../app/console/route_core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.join(__dirname, "..");
const PACKS = path.join(
  PLAYGROUND,
  "..",
  "packages",
  "domain-loader",
  "fixtures",
  "packs",
);
const TEACHER_PACK = path.join(PACKS, "teacher-cbse-slice.json");
const GOLDENS = path.join(PACKS, "teacher-cbse-slice.coldstart-goldens.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_COLDSTART_PARITY";

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function graphFromLoaded(loaded) {
  const orderedConcepts = loaded.concepts.map((c) => ({
    conceptId: c.conceptId,
    title: c.title,
    prerequisites: [...c.prerequisites],
  }));
  const nodes = new Map(orderedConcepts.map((c) => [c.conceptId, c]));
  return {
    nodes,
    orderedConcepts,
    advanceThreshold: loaded.thresholds.advanceThreshold,
    remediateThreshold: loaded.thresholds.remediateThreshold,
  };
}

function graphFromInline(inline) {
  const orderedConcepts = inline.nodes.map((n) => ({
    conceptId: n.conceptId,
    title: n.title ?? n.conceptId,
    prerequisites: [...(n.prerequisites ?? [])],
  }));
  const nodes = new Map(orderedConcepts.map((c) => [c.conceptId, c]));
  return {
    nodes,
    orderedConcepts,
    advanceThreshold: inline.advanceThreshold ?? 0.85,
    remediateThreshold: inline.remediateThreshold ?? 0.4,
  };
}

function stateFromCase(c, deviceId) {
  const mastery = {};
  for (const [cid, ab] of Object.entries(c.mastery ?? {})) {
    mastery[cid] = {
      conceptId: cid,
      alpha: { [deviceId]: ab.alpha },
      beta: { [deviceId]: ab.beta },
      lastExercisedAt: `001700000000000:000000:${deviceId}`,
    };
  }
  return { mode: c.mode, mastery };
}

function graphForCase(caseRow, teacherGraph) {
  if (caseRow.inlineGraph) return graphFromInline(caseRow.inlineGraph);
  return teacherGraph;
}

test("unit: coldstart goldens present next to teacher pack", () => {
  assert.ok(existsSync(TEACHER_PACK));
  assert.ok(existsSync(GOLDENS));
  const goldens = loadJson(GOLDENS);
  assert.equal(goldens.schemaVersion, "teacher-cbse-slice.coldstart-goldens.v1");
  assert.equal(goldens.packFile, "teacher-cbse-slice.json");
  assert.ok(goldens.cases.length >= 4);
  assert.ok(goldens.cases.length <= 64);
});

test("parity: routeTurnOnGraph matches coldstart goldens", () => {
  const goldens = loadJson(GOLDENS);
  const loaded = hydrateTaskGraphFromPackObject(loadJson(TEACHER_PACK), {
    subjectId: "subj.cold.parity.boot",
    deviceId: "console-coldstart",
    onTelemetry: () => {},
  });
  assert.equal(goldens.packId, loaded.packId);
  const teacherGraph = graphFromLoaded(loaded);
  const deviceId = goldens.deviceId;

  for (const c of goldens.cases) {
    const graph = graphForCase(c, teacherGraph);
    const replays = c.replay ?? 1;
    assert.ok(replays >= 1 && replays <= 8);
    let prior = null;
    for (let i = 0; i < replays; i++) {
      const decision = routeTurnOnGraph(
        graph,
        stateFromCase(c, deviceId),
        c.friction,
      );
      assert.equal(
        decision.nextConceptId,
        c.expect.nextConceptId,
        `${c.id} nextConceptId`,
      );
      assert.equal(decision.mode, c.expect.mode, `${c.id} mode`);
      const rationale = decision.rationale.join(" | ");
      for (const needle of c.expect.rationaleIncludes ?? []) {
        assert.ok(
          rationale.includes(needle),
          `${c.id} missing rationale needle ${needle}: ${rationale}`,
        );
      }
      assert.ok(!rationale.includes(SECRET));
      if (prior) {
        assert.equal(decision.nextConceptId, prior.nextConceptId);
        assert.equal(decision.mode, prior.mode);
      }
      prior = decision;
    }
  }
});

test("sovereignty: coldstart golden subjectIds are distinct", () => {
  const goldens = loadJson(GOLDENS);
  const ids = goldens.cases.map((c) => c.subjectId);
  assert.equal(new Set(ids).size, ids.length);
});
