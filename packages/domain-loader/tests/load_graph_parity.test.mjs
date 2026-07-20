/**
 * Byte-identical graph semantics: TS fingerprint must match committed golden expectation.
 * Python suite asserts the same file against the same pack bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  goldenPacksRoot,
  graphSemanticsFingerprint,
  loadTaskGraph,
} from "../dist/index.js";

const VALID = path.join(goldenPacksRoot(), "valid-dag.json");
const EXPECTED = path.join(goldenPacksRoot(), "valid-dag.semantics.json");

test("parity: TS semantics fingerprint matches committed golden expectation", () => {
  assert.ok(existsSync(EXPECTED), "valid-dag.semantics.json must be committed");
  const loaded = loadTaskGraph(VALID, {
    subjectId: "subj.parity.ts",
    deviceId: "dev-parity",
    onTelemetry: () => {},
  });
  const fp = graphSemanticsFingerprint(loaded);
  const expected = JSON.parse(readFileSync(EXPECTED, "utf8"));
  assert.deepEqual(fp, expected);
});
