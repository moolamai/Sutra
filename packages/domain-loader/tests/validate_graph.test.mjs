/**
 * validateTaskGraphPack — happy path, edge cases, sovereignty telemetry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
  prerequisitesByConcept,
  validateTaskGraphPack,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "task-graph-v1");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_TELEMETRY";

function loadFixture(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8"));
}

test("happy path: valid demo DAG validates with pack thresholds", () => {
  const events = [];
  const pack = loadFixture("valid/demo-dag.json");
  const result = validateTaskGraphPack(pack, {
    subjectId: "subj.graph.valid",
    deviceId: "dev-graph-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.status, 0, result.combined);
  assert.ok(result.pack);
  assert.equal(result.pack.thresholds.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(result.pack.thresholds.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
  assert.equal(result.pack.edges.length, 4);

  const prereqs = prerequisitesByConcept(result.pack);
  assert.deepEqual(prereqs.get("math.ratios"), ["math.fractions"]);
  assert.deepEqual(prereqs.get("math.percentages"), ["math.ratios"]);
  assert.deepEqual(prereqs.get("math.fractions"), []);

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.graph.valid");
  assert.equal(events[0].deviceId, "dev-graph-a");
  assert.equal(events[0].packId, "demo-math-sd-slice");
  assert.equal(events[0].conceptCount, 6);
  assert.equal(events[0].edgeCount, 4);
});

test("edge: self-loop rejected as length-1 cycle", () => {
  const result = validateTaskGraphPack(loadFixture("invalid/self-loop.json"), {
    subjectId: "subj.graph.self-loop",
    deviceId: "dev-graph",
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.SELF_LOOP),
    result.combined,
  );
  const self = result.violations.find((v) => v.obligation === OBLIGATIONS.SELF_LOOP);
  assert.deepEqual(self?.cyclePath, ["math.fractions", "math.fractions"]);
});

test("edge: missing prerequisite target concept id fails before router use", () => {
  const result = validateTaskGraphPack(loadFixture("invalid/missing-target.json"), {
    subjectId: "subj.graph.missing",
    deviceId: "dev-graph",
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_EDGE_ENDPOINT),
    result.combined,
  );
  assert.match(result.combined, /math\.fractions/);
});

test("edge: prerequisite cycle rejected with typed cycle path", () => {
  const result = validateTaskGraphPack(loadFixture("invalid/cycle.json"), {
    subjectId: "subj.graph.cycle",
    deviceId: "dev-graph",
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  const cycle = result.violations.find((v) => v.obligation === OBLIGATIONS.CYCLE);
  assert.ok(cycle, result.combined);
  assert.ok(cycle.cyclePath && cycle.cyclePath.length >= 3);
  assert.match(cycle.detail, /a -> b -> c -> a|b -> c -> a -> b|c -> a -> b -> c/);
});

test("edge: wrong schemaVersion fails schema obligation", () => {
  const result = validateTaskGraphPack(loadFixture("invalid/schema-version.json"), {
    subjectId: "subj.graph.schema",
    deviceId: "dev-graph",
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.every((v) => v.obligation === OBLIGATIONS.SCHEMA_INVALID),
  );
});

test("edge: remediateThreshold must be strictly below advanceThreshold", () => {
  const pack = loadFixture("valid/demo-dag.json");
  pack.thresholds = { advanceThreshold: 0.5, remediateThreshold: 0.5 };
  const result = validateTaskGraphPack(pack, {
    subjectId: "subj.graph.threshold",
    deviceId: "dev-graph",
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.THRESHOLD_ORDER),
  );
});

test("sovereignty: telemetry carries subjectId/deviceId and never raw content", () => {
  const events = [];
  const pack = loadFixture("valid/demo-dag.json");
  pack.description = SECRET;
  pack.concepts[0].title = SECRET;
  const result = validateTaskGraphPack(pack, {
    subjectId: "subj.graph.sovereign",
    deviceId: "dev-edge-1",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.status, 0, result.combined);
  assert.equal(events.length, 1);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
  assert.equal(events[0].subjectId, "subj.graph.sovereign");
  assert.equal(events[0].deviceId, "dev-edge-1");
  assert.equal(events[0].outcome, "ok");
});

test("bounded scan: oversized concept list fails BOUNDED_SCAN", () => {
  const pack = {
    schemaVersion: "task-graph.v1",
    packId: "huge",
    domainId: "teacher",
    version: "1.0.0",
    thresholds: { advanceThreshold: 0.85, remediateThreshold: 0.4 },
    concepts: [
      { conceptId: "a", title: "A" },
      { conceptId: "b", title: "B" },
      { conceptId: "c", title: "C" },
    ],
    edges: [],
  };
  const result = validateTaskGraphPack(pack, {
    subjectId: "subj.graph.bound",
    deviceId: "dev-graph",
    scanLimit: 2,
    onTelemetry: () => {},
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.BOUNDED_SCAN),
  );
});
