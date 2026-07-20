/**
 * Unit tests for the contract-mocks conformance CI gate prove script.
 * Run: node --test scripts/prove-mock-conformance-gate.test.mjs
 *
 * Full green→red→green path is exercised by `pnpm mocks:conformance:prove` in CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_SEED_OBLIGATION_ID,
  ensureBuilt,
  runSeededMockViolation,
} from "./prove-mock-conformance-gate.mjs";
import {
  MOCK_GATE_SUITE_LIMIT,
  ensureMockConformanceBuilt,
  runMockConformanceSuite,
} from "./check-mock-conformance.mjs";

test("happy path: mock suite matrix passes all nine contract registries", async () => {
  ensureMockConformanceBuilt();
  const result = await runMockConformanceSuite({
    subjectId: "subj-mock-gate-unit",
    deviceId: "dev-mock-gate-unit",
  });
  assert.equal(result.status, 0);
  assert.equal(result.failedSuites, 0);
  assert.equal(result.suiteCount, 9);
  assert.ok(result.passedSuites === 9);
});

test("seeded accept-oversized vision fails CK-06.1 with MUST visible", async () => {
  await ensureBuilt();
  const seeded = await runSeededMockViolation();
  assert.equal(seeded.status, 1);
  assert.match(seeded.combined, new RegExp(MOCK_SEED_OBLIGATION_ID));
  assert.match(seeded.combined, /MUST/i);
  assert.equal(MOCK_SEED_OBLIGATION_ID, "CK-06.1");
});

test("edge: seeded report names the size-limit obligation loudly", async () => {
  await ensureBuilt();
  const seeded = await runSeededMockViolation();
  const fail = seeded.report.verdicts.find(
    (v) => v.obligationId === MOCK_SEED_OBLIGATION_ID,
  );
  assert.ok(fail);
  assert.equal(fail.outcome, "fail");
  assert.equal(fail.attribution, "implementation");
  assert.match(fail.mustText ?? "", /MUST/);
  assert.ok(seeded.combined.length > 0);
});

test("edge: suite runner is bounded and subject-scoped", async () => {
  assert.ok(MOCK_GATE_SUITE_LIMIT >= 9);
  ensureMockConformanceBuilt();
  const full = await runMockConformanceSuite({
    subjectId: "subj-iso",
    deviceId: "dev-iso",
  });
  assert.equal(full.status, 0);
  assert.match(full.combined, /mock suite: memory/);
  assert.match(full.combined, /mock suite: runtime/);
  assert.equal(full.suiteCount, 9);
});
