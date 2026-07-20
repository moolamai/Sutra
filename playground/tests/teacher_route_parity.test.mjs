/**
 * Teacher CBSE-slice: playground routeTurnOnGraph matches committed route goldens
 * (same pack bytes + same cases as Python TaskRouter parity suite).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hydrateTaskGraphFromPackObject,
  TaskGraphLoadError,
} from "@moolam/domain-loader";
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
const GOLDENS = path.join(PACKS, "teacher-cbse-slice.route-goldens.json");
const ENGINE = path.join(PLAYGROUND, "app", "console", "engine.ts");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_PARITY_TELEMETRY";

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

test("unit: engine.ts boots teacher-cbse-slice pack (not demo-math-sd)", () => {
  assert.ok(existsSync(ENGINE));
  const src = readFileSync(ENGINE, "utf8");
  assert.ok(src.includes("teacher-cbse-slice.json"));
  assert.ok(!src.includes("demo-math-sd-slice.json"));
  assert.ok(src.includes("route_core.mjs"));
  assert.ok(src.includes("hydrateTaskGraphFromPackObject"));
});

test("happy path: teacher pack hydrates for playground", () => {
  const events = [];
  const raw = loadJson(TEACHER_PACK);
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: "subj.playground.teacher",
    deviceId: "console-test",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.packId, "teacher-cbse-slice");
  assert.equal(loaded.versionStamp, "teacher-cbse-slice@1.0.0");
  assert.equal(loaded.thresholds.advanceThreshold, 0.85);
  assert.ok(loaded.nodes["math.unitary_method"]);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.playground.teacher");
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("parity: playground routeTurnOnGraph matches route goldens on teacher pack", () => {
  const goldens = loadJson(GOLDENS);
  const loaded = hydrateTaskGraphFromPackObject(loadJson(TEACHER_PACK), {
    subjectId: "subj.parity.boot",
    deviceId: "console-parity",
    onTelemetry: () => {},
  });
  assert.equal(goldens.packId, loaded.packId);
  assert.equal(goldens.packVersion, "1.0.0");
  const graph = graphFromLoaded(loaded);
  const deviceId = goldens.deviceId;

  assert.ok(goldens.cases.length >= 4);
  assert.ok(goldens.cases.length <= 64, "bounded golden suite");

  for (const c of goldens.cases) {
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
  }
});

test("edge: cyclic teacher mutation rejected on playground hydrate", () => {
  const raw = loadJson(TEACHER_PACK);
  raw.edges.push({
    fromConceptId: "math.fractions",
    toConceptId: "math.unitary_method",
    type: "prerequisite",
  });
  assert.throws(
    () =>
      hydrateTaskGraphFromPackObject(raw, {
        subjectId: "subj.playground.cycle",
        deviceId: "console-test",
        onTelemetry: () => {},
      }),
    (err) => err instanceof TaskGraphLoadError && err.failureClass === "cycle",
  );
});

test("sovereignty: subjectIds in goldens are distinct (no cross-subject bleed)", () => {
  const goldens = loadJson(GOLDENS);
  const ids = goldens.cases.map((c) => c.subjectId);
  assert.equal(new Set(ids).size, ids.length);
});
