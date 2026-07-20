/**
 * Committed trajectory JSON Schema export — drift gate + sovereignty metadata.
 * Run: pnpm --filter @moolam/learning test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRAJECTORY_COMMITTED_SCHEMA_RELPATH,
  checkTrajectorySchemaCommitted,
  exportTrajectorySchema,
  TrajectorySchemaExportError,
} from "../scripts/export-trajectory-schema.mjs";
import {
  TRAJECTORY_COMMITTED_SCHEMA_RELPATH as BARREL_RELPATH,
  TRAJECTORY_SCHEMA_VERSION,
} from "../dist/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const COMMITTED = path.join(REPO_ROOT, TRAJECTORY_COMMITTED_SCHEMA_RELPATH);

function log(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "learning.trajectory.schema.test", ...event })}\n`,
  );
}

test("barrel constants match exporter path + version", () => {
  assert.equal(BARREL_RELPATH, TRAJECTORY_COMMITTED_SCHEMA_RELPATH);
  assert.equal(TRAJECTORY_SCHEMA_VERSION, "trajectory.v1");
  assert.equal(TRAJECTORY_COMMITTED_SCHEMA_RELPATH, "schemas/trajectory/v1.json");
});

test("happy path: re-export matches committed schemas/trajectory/v1.json byte-for-byte", async () => {
  const result = await checkTrajectorySchemaCommitted({
    committedPath: COMMITTED,
  });
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, TRAJECTORY_SCHEMA_VERSION);
  log({
    outcome: "ok",
    case: "byte_match",
    digest: result.digest,
    subjectId: null,
    deviceId: "test",
  });
});

test("edge: two consecutive exports are byte-identical (determinism)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-traj-det-"));
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    const first = await exportTrajectorySchema({ outPath: a });
    const second = await exportTrajectorySchema({ outPath: b });
    assert.equal(first.body, second.body);
    assert.equal(first.digest, second.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge: drift detection fails loud when committed file differs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sutra-traj-drift-"));
  try {
    const drifted = path.join(dir, "v1.json");
    const committed = await readFile(COMMITTED, "utf8");
    await writeFile(drifted, `${committed.slice(0, -2)}\n`, "utf8");
    await assert.rejects(
      () => checkTrajectorySchemaCommitted({ committedPath: drifted }),
      (err) => {
        assert.ok(err instanceof TrajectorySchemaExportError);
        assert.equal(err.code, "SCHEMA_DRIFT");
        return true;
      },
    );
    log({
      outcome: "ok",
      case: "drift_loud",
      failureClass: "schema_drift",
      subjectId: null,
      deviceId: "test",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sovereignty: committed schema forbids keystrokes and keeps consent + subjectId", async () => {
  const doc = JSON.parse(await readFile(COMMITTED, "utf8"));
  assert.equal(doc.title, "TurnTrajectoryRecord");
  assert.equal(doc["x-trajectory-schema-version"], TRAJECTORY_SCHEMA_VERSION);
  assert.equal(doc["x-invariants"]?.keystrokesForbidden, true);
  assert.equal(doc["x-invariants"]?.consentRequired, true);
  assert.equal(
    doc["x-forward-compat"]?.routerReplayMap?.denseSlmMayOmit,
    true,
  );
  assert.ok(doc.properties?.consent);
  assert.ok(doc.properties?.subjectId);
  assert.equal(doc.properties?.keystrokes, undefined);
  const required = new Set(doc.required ?? []);
  assert.ok(required.has("consent"));
  assert.ok(required.has("subjectId"));
  assert.ok(!required.has("routerReplayMap"));
  log({
    outcome: "ok",
    case: "sovereignty_metadata",
    subjectId: null,
    deviceId: "test",
  });
});

test("changelog exists with W3 freeze entry for trajectory.v1", async () => {
  const changelog = await readFile(
    path.join(REPO_ROOT, "schemas/trajectory/CHANGELOG.md"),
    "utf8",
  );
  assert.match(changelog, /trajectory\.v1/);
  assert.match(changelog, /W3 freeze/);
  assert.match(changelog, /routerReplayMap/);
  assert.match(changelog, /policyCheckpointHash/);
});
