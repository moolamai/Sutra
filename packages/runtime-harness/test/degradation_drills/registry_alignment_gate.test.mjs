/**
 * Unit tests for the degradation-drill CI alignment gate prove helpers.
 * Run: node --test packages/runtime-harness/test/degradation_drills/registry_alignment_gate.test.mjs
 *
 * Full green→red→green path: node .../registry_alignment_gate.mjs (CI prove step).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPECTED_ROWS,
  SEED_MARKER,
  SEED_ROW_ID,
  checkRegistryDrillAlignment,
  ensureHarnessBuilt,
  formatSignalMismatchDiff,
  restoreExpectedSignalSeed,
  seedExpectedSignalDrift,
} from "./registry_alignment_gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_OVERRIDE = path.join(__dirname, ".expected_signals.seed.json");

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "runtime.harness.degradation_drill.gate.test", ...event })}\n`,
  );
}

test("happy path: alignment check green against A P6 registry + drill files", async () => {
  restoreExpectedSignalSeed();
  ensureHarnessBuilt();
  const result = await checkRegistryDrillAlignment({
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.bindingCount >= 6);
  assert.ok(result.rowCount >= 5);
  assert.ok(
    DEFAULT_EXPECTED_ROWS.some((r) => r.dependency === "model"),
  );
  assert.ok(DEFAULT_EXPECTED_ROWS.some((r) => r.dependency === "sync"));
  assert.ok(DEFAULT_EXPECTED_ROWS.some((r) => r.dependency === "tool"));
  emit({
    outcome: "ok",
    phase: "check-green",
    subjectId: "anika-k",
    deviceId: "ci-gate",
    bindingCount: result.bindingCount,
  });
});

test("edge: seed mutates expected signal then restore deletes override", () => {
  restoreExpectedSignalSeed();
  assert.equal(existsSync(SEED_OVERRIDE), false);
  try {
    seedExpectedSignalDrift();
    assert.equal(existsSync(SEED_OVERRIDE), true);
    const raw = readFileSync(SEED_OVERRIDE, "utf8");
    assert.match(raw, new RegExp(SEED_MARKER));
    assert.match(raw, new RegExp(SEED_ROW_ID.replace(":", ":")));
    assert.throws(() => seedExpectedSignalDrift(), /ALREADY_SEEDED/);
    emit({
      outcome: "ok",
      phase: "seed",
      subjectId: "anika-k",
      deviceId: "ci-gate",
      rowId: SEED_ROW_ID,
    });
  } finally {
    restoreExpectedSignalSeed();
  }
  assert.equal(existsSync(SEED_OVERRIDE), false);
  emit({
    outcome: "ok",
    phase: "restore",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
});

test("edge: seeded drift turns check red with unified diff in the log", async () => {
  restoreExpectedSignalSeed();
  ensureHarnessBuilt();
  try {
    seedExpectedSignalDrift();
    const result = await checkRegistryDrillAlignment();
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "signal_mismatch");
    assert.match(result.diff ?? "", /--- degradation-drill\//);
    assert.match(result.diff ?? "", /\+\+\+ degradation-drill\//);
    assert.match(result.diff ?? "", new RegExp(SEED_MARKER));
    assert.ok(!JSON.stringify(result).includes("learner"));
    emit({
      outcome: "ok",
      phase: "seeded-red",
      subjectId: "anika-k",
      deviceId: "ci-gate",
      failureClass: "signal_mismatch",
      rowId: SEED_ROW_ID,
    });
  } finally {
    restoreExpectedSignalSeed();
  }
  const green = await checkRegistryDrillAlignment();
  assert.equal(green.ok, true, green.detail);
});

test("edge: failing gate surface formatter includes unified diff markers", () => {
  const expected = {
    behavior: "queue",
    signalCode: "DEGRADE_QUEUE_AND_WARN",
  };
  const actual = {
    behavior: "queue",
    signalCode: SEED_MARKER,
  };
  const diff = formatSignalMismatchDiff(expected, actual, SEED_ROW_ID);
  assert.match(diff, /--- degradation-drill\/model:read\.expected\.json/);
  assert.match(diff, /\+\+\+ degradation-drill\/model:read\.actual\.json/);
  assert.match(diff, /@@ /);
  assert.match(diff, new RegExp(SEED_MARKER));
  emit({
    outcome: "ok",
    phase: "unified-diff",
    subjectId: "anika-k",
    deviceId: "ci-gate",
    failureClass: "signal_mismatch",
  });
});

test("sovereignty: gate telemetry uses opaque subjectId/deviceId — no content", async () => {
  restoreExpectedSignalSeed();
  const result = await checkRegistryDrillAlignment({
    subjectId: "subject-a",
    deviceId: "edge-ci",
  });
  assert.equal(result.ok, true);
  assert.equal(result.subjectId, "subject-a");
  assert.equal(result.deviceId, "edge-ci");
  assert.ok(result.subjectId !== "subject-b");
});
