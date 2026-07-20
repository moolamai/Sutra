/**
 * Teacher CBSE-slice task-graph pack — authored from domains/teacher inventory.
 * Validates DAG, thresholds, concept ⊆ domain inventory, load telemetry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskGraphLoadError,
  fixturesRoot,
  loadTaskGraph,
  loadTaskGraphFromObject,
  validateGraph,
  validateTaskGraphPack,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");
const REPO_ROOT = path.join(PKG_ROOT, "..", "..");
const PACK = path.join(fixturesRoot(), "packs", "teacher-cbse-slice.json");
const EPIC_PACK = path.join(
  REPO_ROOT,
  "packages",
  "cloud-orchestrator",
  "src",
  "sutra_orchestrator",
  "packs",
  "teacher-cbse-slice.json",
);
const INVENTORY = path.join(
  REPO_ROOT,
  "domains",
  "teacher",
  "data",
  "task-graph-concept-ids.json",
);

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_TEACHER_PACK_TELEMETRY";

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

test("happy path: teacher CBSE-slice pack validates as DAG with 0.85/0.40", () => {
  const events = [];
  const raw = readJson(PACK);
  const result = validateTaskGraphPack(raw, {
    subjectId: "subj.teacher.pack.valid",
    deviceId: "dev-teacher-pack",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.status, 0, result.combined);
  const dag = validateGraph(
    { concepts: raw.concepts, edges: raw.edges },
    {
      subjectId: "subj.teacher.pack.valid",
      deviceId: "dev-teacher-pack",
    },
  );
  assert.equal(dag.status, 0, dag.combined);
  assert.equal(raw.thresholds.advanceThreshold, 0.85);
  assert.equal(raw.thresholds.remediateThreshold, 0.4);
  assert.equal(raw.packId, "teacher-cbse-slice");
  assert.equal(raw.domainId, "teacher");
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.teacher.pack.valid");
});

test("invariant: every pack conceptId ⊆ teacher domain inventory", () => {
  const pack = readJson(PACK);
  const inventory = readJson(INVENTORY);
  const allowed = new Set(inventory.concepts.map((c) => c.conceptId));
  assert.equal(inventory.syntheticProbeNodes.length, 0);
  for (const c of pack.concepts) {
    assert.ok(
      allowed.has(c.conceptId),
      `conceptId ${c.conceptId} missing from domains/teacher inventory`,
    );
  }
  const expectedEdges = new Set(
    inventory.pedagogicalEdges.map((e) => `${e.from}->${e.requires}`),
  );
  for (const e of pack.edges) {
    assert.equal(e.type, "prerequisite");
    const key = `${e.fromConceptId}->${e.toConceptId}`;
    assert.ok(expectedEdges.has(key), `edge ${key} not in pedagogical inventory`);
  }
  assert.equal(pack.edges.length, inventory.pedagogicalEdges.length);
});

test("invariant: epic touchpoint pack bytes match fixtures pack", () => {
  const a = readFileSync(PACK, "utf8");
  const b = readFileSync(EPIC_PACK, "utf8");
  assert.equal(a, b, "epic teacher-cbse-slice.json must match fixtures pack");
});

test("happy path: loadTaskGraph maps pedagogical prerequisites", () => {
  const events = [];
  const loaded = loadTaskGraph(PACK, {
    subjectId: "subj.teacher.load",
    deviceId: "dev-teacher-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.packId, "teacher-cbse-slice");
  assert.equal(loaded.versionStamp, "teacher-cbse-slice@1.0.0");
  assert.equal(loaded.thresholds.advanceThreshold, 0.85);
  assert.equal(loaded.thresholds.remediateThreshold, 0.4);
  assert.deepEqual(loaded.nodes["math.ratios"].prerequisites, ["math.fractions"]);
  assert.deepEqual(loaded.nodes["math.equivalent_ratios"].prerequisites, [
    "math.ratios",
  ]);
  assert.deepEqual(
    [...loaded.nodes["math.simple_proportion"].prerequisites].sort(),
    ["math.equivalent_ratios", "math.ratios"],
  );
  assert.deepEqual(loaded.nodes["math.unitary_method"].prerequisites, [
    "math.simple_proportion",
  ]);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.teacher.load");
  assert.equal(events[0].deviceId, "dev-teacher-a");
});

test("edge: cyclic mutation of teacher pack rejected at load", () => {
  const raw = readJson(PACK);
  raw.edges.push({
    fromConceptId: "math.fractions",
    toConceptId: "math.unitary_method",
    type: "prerequisite",
  });
  assert.throws(
    () =>
      loadTaskGraphFromObject(raw, {
        subjectId: "subj.teacher.cycle",
        deviceId: "dev-teacher",
        onTelemetry: () => {},
      }),
    (err) =>
      err instanceof TaskGraphLoadError && err.obligation.includes("cycle"),
  );
});

test("edge: missing-node mutation of teacher pack rejected at load", () => {
  const raw = readJson(PACK);
  raw.edges.push({
    fromConceptId: "math.ratios",
    toConceptId: "math.unknown_probe",
    type: "prerequisite",
  });
  assert.throws(
    () =>
      loadTaskGraphFromObject(raw, {
        subjectId: "subj.teacher.missing",
        deviceId: "dev-teacher",
        onTelemetry: () => {},
      }),
    (err) =>
      err instanceof TaskGraphLoadError &&
      err.obligation.includes("missing_edge_endpoint"),
  );
});

test("sovereignty: load telemetry never carries raw learner content", () => {
  const events = [];
  loadTaskGraph(PACK, {
    subjectId: "subj.teacher.sov",
    deviceId: "dev-teacher",
    onTelemetry: (e) => events.push(e),
  });
  const blob = JSON.stringify(events);
  assert.equal(blob.includes(SECRET), false);
  assert.match(blob, /subjectId/);
  assert.match(blob, /deviceId/);
  assert.equal(events[0].subjectId, "subj.teacher.sov");
});

test("scalability: concept and edge counts stay within schema bounds", () => {
  const raw = readJson(PACK);
  assert.ok(raw.concepts.length >= 1 && raw.concepts.length <= 4096);
  assert.ok(raw.edges.length <= 16384);
});
