/**
 * CI wiring: extended training gates run in nightly, not PR TypeScript job.
 *
 * Run: node --test scripts/check-training-extended-ci.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractJobBlock,
  loadNightlyCi,
  loadPrCi,
} from "./ci-workflow-test-helpers.mjs";

const EXTENDED_STEP_PATTERNS = [
  /prove:rebuild/,
  /prove:decontam/,
  /prove:mix-policy/,
  /micro-run:prove/,
  /batch:prove/,
  /@moolam\/training-distillation test/,
];

test("happy path: training-extended job wires prove gates on nightly", () => {
  const nightly = loadNightlyCi();
  assert.match(nightly, /^  training-extended:/m);
  const block = extractJobBlock(nightly, "training-extended");
  assert.match(block, /pnpm install --frozen-lockfile/);
  assert.match(block, /pnpm build/);
  for (const pattern of EXTENDED_STEP_PATTERNS) {
    assert.match(block, pattern, `nightly missing ${pattern}`);
  }
  assert.match(nightly, /training\/\*\*/);
});

test("edge: PR TypeScript job keeps fast corpus + fixture gates only", () => {
  const pr = loadPrCi();
  const ts = extractJobBlock(pr, "build-test-typescript");
  assert.match(ts, /@moolam\/training-corpus test/);
  assert.match(ts, /fixtures:check/);
  assert.doesNotMatch(ts, /prove:rebuild/);
  assert.doesNotMatch(ts, /prove:decontam/);
  assert.doesNotMatch(ts, /prove:mix-policy/);
  assert.doesNotMatch(ts, /micro-run:prove/);
  assert.doesNotMatch(ts, /batch:prove/);
  assert.doesNotMatch(ts, /@moolam\/training-distillation/);
});
