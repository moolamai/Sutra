/**
 * task-graph-v1 JSON schema presence and shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ADVANCE_THRESHOLD,
  DEFAULT_REMEDIATE_THRESHOLD,
  SCHEMA_VERSION,
  loadTaskGraphSchema,
  schemaPath,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(__dirname, "..", "schemas", "task-graph-v1.json");

test("unit: committed task-graph-v1 schema exists with locked schemaVersion", () => {
  assert.ok(existsSync(SCHEMA));
  assert.equal(schemaPath(), SCHEMA);
  const schema = loadTaskGraphSchema();
  assert.equal(schema.$id, "https://moolam.ai/schemas/task-graph-v1.json");
  assert.equal(schema.properties?.schemaVersion?.const, SCHEMA_VERSION);
  assert.ok(schema.$defs?.conceptNode);
  assert.ok(schema.$defs?.edge);
  assert.ok(schema.$defs?.thresholds);
  assert.equal(schema.$defs.edge.properties.type.const, "prerequisite");
  assert.deepEqual(schema.$defs.conceptNode.properties.ageFloor.enum, [
    "child",
    "adolescent",
    "adult",
  ]);
});

test("unit: schema thresholds align with task_router defaults", () => {
  assert.equal(DEFAULT_ADVANCE_THRESHOLD, 0.85);
  assert.equal(DEFAULT_REMEDIATE_THRESHOLD, 0.4);
  const raw = JSON.parse(readFileSync(SCHEMA, "utf8"));
  assert.ok(raw.$defs.thresholds.required.includes("advanceThreshold"));
  assert.ok(raw.$defs.thresholds.required.includes("remediateThreshold"));
});
