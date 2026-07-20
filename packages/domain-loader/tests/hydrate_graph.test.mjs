/**
 * hydrateTaskGraphFromPackObject — browser-safe pack load (no fs/AJV).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskGraphLoadError,
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
  hydrateTaskGraphFromPackObject,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(
  __dirname,
  "..",
  "fixtures",
  "packs",
  "demo-math-sd-slice.json",
);
const CYCLIC = path.join(
  __dirname,
  "..",
  "fixtures",
  "golden-packs",
  "cyclic-reject.json",
);
const SECRET = "LEARNER_UTTERANCE_MUST_NOT_APPEAR_IN_HYDRATE_TELEMETRY";

test("happy path: hydrate demo pack yields pack thresholds and nodes", () => {
  const events = [];
  const raw = JSON.parse(readFileSync(DEMO, "utf8"));
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: "subj.hydrate.valid",
    deviceId: "dev-hydrate",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(loaded.packId, "demo-math-sd-slice");
  assert.equal(loaded.versionStamp, "demo-math-sd-slice@1.0.0");
  assert.equal(loaded.thresholds.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(loaded.thresholds.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
  assert.deepEqual(loaded.nodes["math.ratios"].prerequisites, ["math.fractions"]);
  assert.equal(events[0].outcome, "ok");
  assert.equal(events[0].subjectId, "subj.hydrate.valid");
  assert.ok(!JSON.stringify(events).includes("Fractions"));
});

test("edge: hydrate rejects cyclic pack", () => {
  const raw = JSON.parse(readFileSync(CYCLIC, "utf8"));
  assert.throws(
    () =>
      hydrateTaskGraphFromPackObject(raw, {
        subjectId: "subj.hydrate.cycle",
        deviceId: "dev-hydrate",
        onTelemetry: () => {},
      }),
    (err) => err instanceof TaskGraphLoadError && err.failureClass === "cycle",
  );
});

test("edge: missing thresholds fall back (never silent zero)", () => {
  const raw = JSON.parse(readFileSync(DEMO, "utf8"));
  delete raw.thresholds;
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: "subj.hydrate.thr",
    deviceId: "dev-hydrate",
    onTelemetry: () => {},
  });
  assert.equal(loaded.thresholds.advanceThreshold, DEFAULT_ADVANCE_THRESHOLD);
  assert.equal(loaded.thresholds.remediateThreshold, DEFAULT_REMEDIATE_THRESHOLD);
});

test("sovereignty: hydrate telemetry never includes titles", () => {
  const raw = JSON.parse(readFileSync(DEMO, "utf8"));
  raw.concepts[0].title = SECRET;
  const events = [];
  hydrateTaskGraphFromPackObject(raw, {
    subjectId: "subj.hydrate.sov",
    deviceId: "dev-edge",
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(!JSON.stringify(events).includes(SECRET));
});
