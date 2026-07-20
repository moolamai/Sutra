/**
 * Unit + integration coverage for field pilot execution.
 * Run (after pnpm build): node --test scripts/run-field-pilot-execution.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEVICE_MATRIX,
  OBLIGATIONS,
  PILOT_DAYS,
  assertSubjectDeviceIsolation,
  cloneDriverState,
  executeFieldPilotWindow,
  listFindingsFiles,
  memoryDriver,
  validatePilotFindings,
} from "./run-field-pilot-execution.mjs";

test("happy path: two-week matrix + findings + guidance routing", async () => {
  const result = await executeFieldPilotWindow({
    days: PILOT_DAYS,
    maxScenarios: 3,
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.dayReviews.length, PILOT_DAYS * DEVICE_MATRIX.length);
  assert.ok(result.syncGaps.length > 0, "offline device must leave sync gaps");
  assert.ok(result.restart.ok);
  assert.ok(result.restart.unsyncedAfterRestart > 0);
  assert.ok(result.routing.compared >= 1);
  assert.ok(result.findings.files.length >= 3);
});

test("edge: offline window keeps unsynced samples until markSynced", async () => {
  const result = await executeFieldPilotWindow({
    days: 3,
    skipRouting: true,
    skipFindings: true,
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
  const offlineGaps = result.syncGaps.filter(
    (g) => g.deviceId === "dev-android-mid-01",
  );
  assert.ok(offlineGaps.length >= 3);
  assert.ok(offlineGaps.every((g) => g.unsyncedCount >= 1));
});

test("edge: restart survival clones durable synced=0 rows", async () => {
  const driver = memoryDriver();
  driver.rows.set("hlc-1", {
    captured_at: "hlc-1",
    concept_id: "math.fractions",
    hesitation_ms: 100,
    input_velocity: 2,
    revision_count: 0,
    assistance_requested: 0,
    outcome: "correct",
    synced: 0,
  });
  const cloned = cloneDriverState(driver);
  assert.equal(cloned.rows.size, 1);
  assert.equal(cloned.rows.get("hlc-1").synced, 0);
  cloned.rows.get("hlc-1").synced = 1;
  assert.equal(driver.rows.get("hlc-1").synced, 0, "clone must not share mutability");
});

test("edge: same subjectId on two devices is rejected", () => {
  assert.throws(
    () =>
      assertSubjectDeviceIsolation([
        {
          profile: "android-mid",
          deviceId: "d1",
          subjectId: "same",
          syncAllowed: false,
        },
        {
          profile: "apple-silicon",
          deviceId: "d2",
          subjectId: "same",
          syncAllowed: true,
        },
      ]),
    (err) => err.obligation === OBLIGATIONS.CONCURRENT,
  );
});

test("sovereignty: findings validate requires subject scope + no trajectory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-findings-"));
  try {
    writeFileSync(
      path.join(dir, "2026-07-16-bad.md"),
      "# bad\nno scope fields\ntrajectoryExport: true\n",
      "utf8",
    );
    const result = validatePilotFindings({ findingsDir: dir });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.some(
        (f) =>
          f.includes(OBLIGATIONS.SUBJECT_SCOPE) ||
          f.includes(OBLIGATIONS.TRAJECTORY) ||
          f.includes(OBLIGATIONS.PRIVACY),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge: empty findings dir fails MISSING_FINDINGS", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sutra-pilot-empty-"));
  try {
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    const result = validatePilotFindings({ findingsDir: dir });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes(OBLIGATIONS.MISSING_FINDINGS)));
    assert.equal(listFindingsFiles(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
