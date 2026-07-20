/**
 * Unit tests for the golden-turn CI gate prove helpers.
 * Run: node --test scripts/prove-golden-turns-gate.test.mjs
 *
 * Full green→red→green path is exercised by `pnpm golden:turns:prove` in CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEED_MARKER,
  SEED_TURN_ID,
  ensureBuilt,
  restoreGoldenTurnCase,
  seedGoldenTurnDrift,
} from "./prove-golden-turns-gate.mjs";
import { unifiedDiff } from "../packages/sync-protocol/tests/golden_turn_unified_diff.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_CASE = path.join(
  __dirname,
  "..",
  "packages/sync-protocol/fixtures/golden-turns/thought-answer-basic.json",
);

function emit(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "golden.turn.prove.test", ...event })}\n`,
  );
}

test("happy path: seed mutates ANSWER_DELTA then restore is byte-identical", async () => {
  ensureBuilt();
  const before = readFileSync(SEED_CASE, "utf8");
  assert.doesNotMatch(before, new RegExp(SEED_MARKER));
  let original = null;
  try {
    original = await seedGoldenTurnDrift(SEED_CASE);
    const seeded = readFileSync(SEED_CASE, "utf8");
    assert.match(seeded, new RegExp(SEED_MARKER));
    assert.equal(SEED_TURN_ID, "thought-answer-basic");
    emit({
      outcome: "ok",
      phase: "seed",
      subjectId: "anika-k",
      deviceId: "ci-gate",
      turnId: SEED_TURN_ID,
    });
  } finally {
    if (original !== null) restoreGoldenTurnCase(original, SEED_CASE);
  }
  const after = readFileSync(SEED_CASE, "utf8");
  assert.equal(after, before);
  emit({
    outcome: "ok",
    phase: "restore",
    subjectId: "anika-k",
    deviceId: "ci-gate",
  });
});

test("edge: failing gate surface must include unified diff markers", () => {
  const expected = '{\n  "delta": "A ratio compares quantities."\n}\n';
  const actual = `{\n  "delta": "${SEED_MARKER}: intentionally broken expected"\n}\n`;
  const diff = unifiedDiff(expected, actual, {
    fromFile: `golden/${SEED_TURN_ID}.expected.json`,
    toFile: `golden/${SEED_TURN_ID}.actual.json`,
  });
  assert.match(diff, /--- golden\/thought-answer-basic\.expected\.json/);
  assert.match(diff, /\+\+\+ golden\/thought-answer-basic\.actual\.json/);
  assert.match(diff, /@@ /);
  assert.match(diff, new RegExp(SEED_MARKER));
  emit({
    outcome: "ok",
    phase: "unified-diff",
    subjectId: "anika-k",
    deviceId: "ci-gate",
    failureClass: "canonical_drift",
  });
});

test("edge: seed refuses double-seed (partial failure safety)", async () => {
  ensureBuilt();
  let original = null;
  try {
    original = await seedGoldenTurnDrift(SEED_CASE);
    await assert.rejects(
      () => seedGoldenTurnDrift(SEED_CASE),
      /ALREADY_SEEDED/,
    );
    emit({
      outcome: "ok",
      phase: "double-seed-rejected",
      subjectId: "anika-k",
      deviceId: "ci-gate",
      failureClass: "already_seeded",
    });
  } finally {
    if (original !== null) restoreGoldenTurnCase(original, SEED_CASE);
  }
});

test("sovereignty: prove telemetry stays metadata-only (no learner prose dump)", () => {
  const body = readFileSync(
    path.join(__dirname, "prove-golden-turns-gate.mjs"),
    "utf8",
  );
  assert.match(body, /subjectId/);
  assert.match(body, /deviceId/);
  assert.doesNotMatch(body, /raw prompt|completion text/i);
});
