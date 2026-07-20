/**
 * Playground engine must load the committed pack — no hardcoded τ / DEMO_GRAPH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphSemanticsFingerprint,
  hydrateTaskGraphFromPackObject,
} from "@moolam/domain-loader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.join(__dirname, "..");
const ENGINE = path.join(PLAYGROUND, "app", "console", "engine.ts");
const TEACHER_PACK = path.join(
  PLAYGROUND,
  "..",
  "packages",
  "domain-loader",
  "fixtures",
  "packs",
  "teacher-cbse-slice.json",
);

test("unit: engine.ts has no hardcoded ADVANCE_THRESHOLD or inline TASK_GRAPH array", () => {
  assert.ok(existsSync(ENGINE));
  const src = readFileSync(ENGINE, "utf8");
  assert.ok(
    !src.includes("export const ADVANCE_THRESHOLD = 0.85"),
    "must not hardcode ADVANCE_THRESHOLD",
  );
  assert.ok(
    !src.includes("export const REMEDIATE_THRESHOLD = 0.4"),
    "must not hardcode REMEDIATE_THRESHOLD",
  );
  assert.ok(
    !/export const TASK_GRAPH:\s*ConceptNode\[\]\s*=\s*\[/.test(src),
    "must not inline TASK_GRAPH array",
  );
  assert.ok(src.includes("hydrateTaskGraphFromPackObject"));
  assert.ok(src.includes("teacher-cbse-slice.json"));
  assert.ok(
    !src.includes('{ conceptId: "math.fractions", title: "Fractions"'),
    "must not inline demo concept rows",
  );
});

test("happy path: committed teacher pack hydrates with cloud-identical semantics shape", () => {
  const raw = JSON.parse(readFileSync(TEACHER_PACK, "utf8"));
  const loaded = hydrateTaskGraphFromPackObject(raw, {
    subjectId: "subj.playground.pack",
    deviceId: "console-test",
    onTelemetry: () => {},
  });
  assert.equal(loaded.packId, "teacher-cbse-slice");
  assert.equal(loaded.versionStamp, "teacher-cbse-slice@1.0.0");
  assert.equal(loaded.thresholds.advanceThreshold, 0.85);
  assert.equal(loaded.thresholds.remediateThreshold, 0.4);
  assert.ok(loaded.nodes["math.fractions"]);
  assert.ok(loaded.nodes["math.unitary_method"]);
  const fp = graphSemanticsFingerprint(loaded);
  assert.equal(fp.nodes.length, 6);
  assert.deepEqual(
    fp.nodes.find((n) => n.conceptId === "math.ratios")?.prerequisites,
    ["math.fractions"],
  );
});

test("edge: cyclic pack rejected for playground hydrate path", async () => {
  const { TaskGraphLoadError } = await import("@moolam/domain-loader");
  const cyclic = JSON.parse(
    readFileSync(
      path.join(
        PLAYGROUND,
        "..",
        "packages",
        "domain-loader",
        "fixtures",
        "golden-packs",
        "cyclic-reject.json",
      ),
      "utf8",
    ),
  );
  assert.throws(
    () =>
      hydrateTaskGraphFromPackObject(cyclic, {
        subjectId: "subj.playground.cycle",
        deviceId: "console-test",
        onTelemetry: () => {},
      }),
    (err) => err instanceof TaskGraphLoadError && err.failureClass === "cycle",
  );
});

test("edge: missing-node pack rejected", async () => {
  const { TaskGraphLoadError } = await import("@moolam/domain-loader");
  const missing = JSON.parse(
    readFileSync(
      path.join(
        PLAYGROUND,
        "..",
        "packages",
        "domain-loader",
        "fixtures",
        "golden-packs",
        "missing-node-reject.json",
      ),
      "utf8",
    ),
  );
  assert.throws(
    () =>
      hydrateTaskGraphFromPackObject(missing, {
        subjectId: "subj.playground.missing",
        deviceId: "console-test",
        onTelemetry: () => {},
      }),
    (err) =>
      err instanceof TaskGraphLoadError &&
      err.failureClass === "missing_edge_endpoint",
  );
});
