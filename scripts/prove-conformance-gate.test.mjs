/**
 * Unit tests for the conformance CI gate prove script.
 * Run: node --test scripts/prove-conformance-gate.test.mjs
 *
 * Full green→red→green path is exercised by `pnpm conformance:prove` in CI
 * (not duplicated here — that path re-runs the full package suites).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  SEED_OBLIGATION_ID,
  ensureBuilt,
  runSeededViolation,
} from "./prove-conformance-gate.mjs";

test("seeded volatile memory fails CK-02.1 with MUST visible", async () => {
  await ensureBuilt();
  const seeded = await runSeededViolation();
  assert.equal(seeded.status, 1);
  assert.match(seeded.combined, new RegExp(SEED_OBLIGATION_ID));
  assert.match(seeded.combined, /MUST/i);
  assert.equal(SEED_OBLIGATION_ID, "CK-02.1");
});

test("edge: seeded report names the durability obligation", async () => {
  await ensureBuilt();
  const seeded = await runSeededViolation();
  const fail = seeded.report.verdicts.find(
    (v) => v.obligationId === SEED_OBLIGATION_ID,
  );
  assert.ok(fail);
  assert.equal(fail.outcome, "fail");
  assert.equal(fail.attribution, "implementation");
  assert.match(fail.mustText ?? "", /MUST/);
});

test("edge: seeded report is non-empty and fails loudly", async () => {
  await ensureBuilt();
  const seeded = await runSeededViolation();
  assert.ok(seeded.combined.length > 0);
  assert.ok(seeded.report.failed >= 1);
});
