/**
 * Golden pack fixtures — valid DAG, cyclic reject, missing-node reject.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  OBLIGATIONS,
  goldenPacksRoot,
  loadGoldenPackManifest,
  runGoldenPackCase,
  runGoldenPackSuite,
  validateGraph,
  validateTaskGraphPack,
} from "../dist/index.js";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK_FROM_GOLDEN_RUN";
const ROOT = goldenPacksRoot();

test("unit: golden-packs corpus is committed with required cases", () => {
  assert.ok(existsSync(path.join(ROOT, "manifest.json")));
  assert.ok(existsSync(path.join(ROOT, "README.md")));
  const manifest = loadGoldenPackManifest();
  assert.equal(manifest.schemaVersion, "task-graph-golden.v1");
  const ids = new Set(manifest.cases.map((c) => c.id));
  assert.ok(ids.has("valid-dag"));
  assert.ok(ids.has("cyclic-reject"));
  assert.ok(ids.has("missing-node-reject"));
  for (const c of manifest.cases) {
    assert.ok(existsSync(path.join(ROOT, c.file)), c.file);
  }
});

test("happy path: valid-dag golden accepts with pack thresholds", () => {
  const manifest = loadGoldenPackManifest();
  const valid = manifest.cases.find((c) => c.id === "valid-dag");
  assert.ok(valid);
  const events = [];
  const result = runGoldenPackCase(valid, {
    subjectId: "subj.golden.valid",
    deviceId: "dev-golden-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.packStatus, 0);
  assert.ok(events.some((e) => e.outcome === "ok"));
  assert.equal(events[0].subjectId, "subj.golden.valid");
  assert.equal(events[0].deviceId, "dev-golden-a");
});

test("edge: cyclic-reject golden fails with ordered cyclePath", () => {
  const manifest = loadGoldenPackManifest();
  const cyclic = manifest.cases.find((c) => c.id === "cyclic-reject");
  assert.ok(cyclic);
  const result = runGoldenPackCase(cyclic, {
    subjectId: "subj.golden.cycle",
    deviceId: "dev-golden",
    onTelemetry: () => {},
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.packStatus, 1);
  assert.ok(result.cyclePath && result.cyclePath.length >= 4);
  assert.equal(result.cyclePath[0], result.cyclePath[result.cyclePath.length - 1]);
  assert.equal(result.dagFailureClass, "cycle");
});

test("edge: missing-node-reject golden fails before router use", () => {
  const manifest = loadGoldenPackManifest();
  const missing = manifest.cases.find((c) => c.id === "missing-node-reject");
  assert.ok(missing);
  const result = runGoldenPackCase(missing, {
    subjectId: "subj.golden.missing",
    deviceId: "dev-golden",
    onTelemetry: () => {},
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.packStatus, 1);
  assert.equal(result.dagFailureClass, "missing_edge_endpoint");

  const pack = JSON.parse(
    readFileSync(path.join(ROOT, missing.file), "utf8"),
  );
  const direct = validateTaskGraphPack(pack, {
    subjectId: "subj.golden.missing-direct",
    deviceId: "dev-golden",
    onTelemetry: () => {},
  });
  assert.ok(
    direct.violations.some(
      (v) => v.obligation === OBLIGATIONS.MISSING_EDGE_ENDPOINT,
    ),
  );
});

test("edge: self-loop-reject golden is length-1 cycle", () => {
  const manifest = loadGoldenPackManifest();
  const self = manifest.cases.find((c) => c.id === "self-loop-reject");
  assert.ok(self);
  const result = runGoldenPackCase(self, {
    subjectId: "subj.golden.self-loop",
    deviceId: "dev-golden",
    onTelemetry: () => {},
  });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.cyclePath, ["math.fractions", "math.fractions"]);
});

test("suite: runGoldenPackSuite passes all committed goldens", () => {
  const suite = runGoldenPackSuite({
    subjectId: "subj.golden.suite",
    deviceId: "dev-golden-suite",
    onTelemetry: () => {},
  });
  assert.equal(suite.status, 0, suite.combined);
  assert.ok(suite.results.length >= 3);
});

test("sovereignty: golden runner telemetry never includes raw learner content", () => {
  const pack = JSON.parse(
    readFileSync(path.join(ROOT, "valid-dag.json"), "utf8"),
  );
  pack.description = SECRET;
  pack.concepts[0].title = SECRET;
  const events = [];
  const result = validateTaskGraphPack(pack, {
    subjectId: "subj.golden.sovereign",
    deviceId: "dev-edge-golden",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(result.status, 0, result.combined);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
  assert.equal(events[0].subjectId, "subj.golden.sovereign");

  const dag = validateGraph(
    { concepts: pack.concepts, edges: pack.edges },
    {
      subjectId: "subj.golden.sovereign-dag",
      deviceId: "dev-edge-golden",
      onTelemetry: (e) => events.push(e),
    },
  );
  assert.equal(dag.status, 0);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("bounded: golden suite size is manifest-bounded (no unbounded scan)", () => {
  const manifest = loadGoldenPackManifest();
  assert.ok(manifest.cases.length <= 64);
  for (const c of manifest.cases) {
    const pack = JSON.parse(readFileSync(path.join(ROOT, c.file), "utf8"));
    assert.ok(pack.concepts.length <= 4096);
    assert.ok(pack.edges.length <= 16384);
  }
});
