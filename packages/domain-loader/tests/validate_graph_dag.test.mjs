/**
 * validateGraph() — Kahn topological check + ordered cycle path reporting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBLIGATIONS,
  topologicalSort,
  validateGraph,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures", "task-graph-v1");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_DAG_TELEMETRY";

function loadFixture(rel) {
  return JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8"));
}

test("happy path: validateGraph returns Kahn topologicalOrder", () => {
  const pack = loadFixture("valid/demo-dag.json");
  const events = [];
  const result = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.dag.valid",
      deviceId: "dev-dag-a",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.status, 0, result.combined);
  assert.ok(result.topologicalOrder);
  assert.equal(result.topologicalOrder.length, pack.concepts.length);
  // Prerequisites appear before dependents: fractions before ratios before percentages.
  const order = result.topologicalOrder;
  assert.ok(order.indexOf("math.fractions") < order.indexOf("math.ratios"));
  assert.ok(order.indexOf("math.ratios") < order.indexOf("math.percentages"));
  assert.ok(order.indexOf("sd.networking") < order.indexOf("sd.load-balancing"));

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "domain_loader.task_graph.dag");
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.dag.valid");
  assert.equal(events[0].deviceId, "dev-dag-a");
  assert.equal(events[0].phase, "topo");
});

test("edge: self-loop rejected as length-1 cycle with cyclePath", () => {
  const pack = loadFixture("invalid/self-loop.json");
  const events = [];
  const result = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.dag.self-loop",
      deviceId: "dev-dag",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.failureClass, "self_loop");
  assert.deepEqual(result.cyclePath, ["math.fractions", "math.fractions"]);
  assert.equal(events[0].failureClass, "self_loop");
  assert.equal(events[0].cyclePathLength, 2);
});

test("edge: missing prerequisite target fails before topo", () => {
  const pack = loadFixture("invalid/missing-target.json");
  const result = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.dag.missing",
      deviceId: "dev-dag",
      onTelemetry: () => {},
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.failureClass, "missing_edge_endpoint");
  assert.ok(
    result.violations.some((v) => v.obligation === OBLIGATIONS.MISSING_EDGE_ENDPOINT),
  );
});

test("edge: cycle reports ordered node ids forming the cycle", () => {
  const pack = loadFixture("invalid/cycle.json");
  const events = [];
  const result = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.dag.cycle",
      deviceId: "dev-dag",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.failureClass, "cycle");
  assert.ok(result.cyclePath && result.cyclePath.length >= 4);
  // Path closes: last id equals first.
  assert.equal(result.cyclePath[0], result.cyclePath[result.cyclePath.length - 1]);
  assert.match(
    result.combined,
    /a -> b -> c -> a|b -> c -> a -> b|c -> a -> b -> c/,
  );
  assert.equal(events[0].event, "domain_loader.task_graph.dag");
  assert.equal(events[0].failureClass, "cycle");
  assert.equal(events[0].cyclePathLength, result.cyclePath.length);
});

test("unit: topologicalSort succeeds on DAG and residuals on cycle", () => {
  const pack = loadFixture("valid/demo-dag.json");
  const ok = topologicalSort(
    pack.concepts.map((c) => c.conceptId),
    pack.edges,
  );
  assert.ok("order" in ok);
  assert.equal(ok.order.length, 6);

  const cyclic = loadFixture("invalid/cycle.json");
  const bad = topologicalSort(
    cyclic.concepts.map((c) => c.conceptId),
    cyclic.edges,
  );
  assert.ok("residual" in bad);
  assert.ok(bad.residual.length >= 2);
});

test("sovereignty: dag telemetry has subjectId/deviceId and never raw content", () => {
  const pack = loadFixture("valid/demo-dag.json");
  pack.concepts = pack.concepts.map((c, i) =>
    i === 0 ? { ...c, title: SECRET } : c,
  );
  const events = [];
  const result = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.dag.sovereign",
      deviceId: "dev-edge-dag",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(result.status, 0, result.combined);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
  assert.equal(events[0].subjectId, "subj.dag.sovereign");
  assert.equal(events[0].deviceId, "dev-edge-dag");
});

test("bounded scan: oversized input fails with distinct failureClass", () => {
  const result = validateGraph(
    {
      concepts: [
        { conceptId: "a", title: "A" },
        { conceptId: "b", title: "B" },
        { conceptId: "c", title: "C" },
      ],
      edges: [],
    },
    {
      subjectId: "subj.dag.bound",
      deviceId: "dev-dag",
      scanLimit: 2,
      onTelemetry: () => {},
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.failureClass, "bounded_scan");
});
