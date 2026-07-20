/**
 * loadTaskGraph — TS load path: path → validated LoadedTaskGraph.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskGraphLoadError,
  fixturesRoot,
  goldenPacksRoot,
  graphSemanticsFingerprint,
  loadTaskGraph,
  loadTaskGraphFromObject,
  resolveThresholds,
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");
const VALID = path.join(goldenPacksRoot(), "valid-dag.json");
const CYCLIC = path.join(goldenPacksRoot(), "cyclic-reject.json");
const MISSING = path.join(goldenPacksRoot(), "missing-node-reject.json");
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_LOAD_TELEMETRY";

test("happy path: loadTaskGraph maps pack to ConceptNode/TaskGraph shape", () => {
  const events = [];
  const loaded = loadTaskGraph(VALID, {
    subjectId: "subj.load.valid",
    deviceId: "dev-load-a",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.packId, "golden-valid-dag");
  assert.equal(loaded.versionStamp, "golden-valid-dag@1.0.0");
  assert.equal(loaded.thresholds.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(loaded.thresholds.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
  assert.deepEqual(loaded.nodes["math.ratios"].prerequisites, ["math.fractions"]);
  assert.deepEqual(loaded.nodes["math.percentages"].prerequisites, ["math.ratios"]);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.load.valid");
  assert.equal(events[0].versionStamp, loaded.versionStamp);
});

test("edge: cyclic pack rejected at load with typed error", () => {
  assert.throws(
    () =>
      loadTaskGraph(CYCLIC, {
        subjectId: "subj.load.cycle",
        deviceId: "dev-load",
        onTelemetry: () => {},
      }),
    (err) =>
      err instanceof TaskGraphLoadError &&
      err.obligation.includes("cycle") &&
      Array.isArray(err.cyclePath),
  );
});

test("edge: missing node rejected at load", () => {
  assert.throws(
    () =>
      loadTaskGraph(MISSING, {
        subjectId: "subj.load.missing",
        deviceId: "dev-load",
        onTelemetry: () => {},
      }),
    (err) =>
      err instanceof TaskGraphLoadError &&
      err.obligation.includes("missing_edge_endpoint"),
  );
});

test("edge: missing thresholds fall back to pack defaults (never silent zero)", () => {
  const raw = JSON.parse(readFileSync(VALID, "utf8"));
  delete raw.thresholds;
  const loaded = loadTaskGraphFromObject(raw, {
    subjectId: "subj.load.thr",
    deviceId: "dev-load",
    onTelemetry: () => {},
  });
  assert.equal(loaded.thresholds.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(loaded.thresholds.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
  const zeroish = resolveThresholds({ advanceThreshold: 0, remediateThreshold: 0 });
  assert.equal(zeroish.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(zeroish.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
});

test("sovereignty: load telemetry never includes titles or learner content", () => {
  const raw = JSON.parse(readFileSync(VALID, "utf8"));
  raw.description = SECRET;
  raw.concepts[0].title = SECRET;
  const events = [];
  const loaded = loadTaskGraphFromObject(raw, {
    subjectId: "subj.load.sovereign",
    deviceId: "dev-edge",
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(loaded.versionStamp);
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes(SECRET));
  assert.equal(events[0].subjectId, "subj.load.sovereign");
});

test("invariant: domain-loader src never imports domains tree", () => {
  const srcDir = path.join(PKG_ROOT, "src");
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const body = readFileSync(path.join(srcDir, name), "utf8");
    assert.ok(
      !/from\s+['\"][^'\"]*domains[^'\"]*['\"]/.test(body),
      `${name} must not import domains tree`,
    );
    assert.ok(
      !/require\(\s*['\"][^'\"]*domains[^'\"]*['\"]\s*\)/.test(body),
      `${name} must not require domains tree`,
    );
  }
  assert.ok(fixturesRoot().includes("domain-loader"));
});

test("fingerprint: stable semantics for parity with Python", () => {
  const loaded = loadTaskGraph(VALID, {
    subjectId: "subj.load.fp",
    deviceId: "dev-load",
    onTelemetry: () => {},
  });
  const fp = graphSemanticsFingerprint(loaded);
  assert.equal(fp.packId, "golden-valid-dag");
  assert.equal(fp.nodes[0].conceptId, "math.fractions");
  assert.deepEqual(fp.nodes.find((n) => n.conceptId === "math.ratios")?.prerequisites, [
    "math.fractions",
  ]);
});
