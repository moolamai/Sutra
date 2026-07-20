/**
 * Unit tests for dependency-direction seed-violation prove .
 * Run: node --test scripts/prove-dependency-direction-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RULE_IDS,
  runSeededDependencyViolation,
  formatViolationEdges,
} from "./check-dependency-direction.mjs";
import {
  SEED_MATRIX,
  SEED_PHASE_LIMIT,
  assertExactSeedFailure,
  proveDependencyDirectionGate,
} from "./prove-dependency-direction-gate.mjs";

test("happy path: prove green→red×N→green for every rule", async () => {
  const result = await proveDependencyDirectionGate({
    subjectId: "subj-prove-unit",
    deviceId: "dev-prove-unit",
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.completionRecord.ok, true);
  assert.equal(result.completionRecord.seeds.length, SEED_MATRIX.length);
  assert.ok(result.completionRecord.typeOnlyImportsCountAsEdges);
  for (const seed of result.completionRecord.seeds) {
    assert.equal(seed.ok, true, seed.failure ?? seed.kind);
    assert.match(seed.exactFailure, /→/);
    assert.ok(seed.exactFailure.includes(seed.ruleId));
  }
});

test("SEED_MATRIX covers every RULE_IDS entry exactly once", () => {
  const covered = new Set(SEED_MATRIX.map((s) => s.ruleId));
  assert.equal(covered.size, SEED_MATRIX.length);
  for (const id of Object.values(RULE_IDS)) {
    assert.ok(covered.has(id), `missing prove seed for ${id}`);
  }
  assert.equal(SEED_PHASE_LIMIT, SEED_MATRIX.length);
  assert.ok(SEED_PHASE_LIMIT <= 8);
});

test("edge: type-only seed fails with exact contracts file→zod edge", async () => {
  const spec = SEED_MATRIX.find((s) => s.kind === "contracts-type-only");
  assert.ok(spec);
  const seeded = await runSeededDependencyViolation(spec.kind);
  const check = assertExactSeedFailure(spec, seeded);
  assert.equal(check.ok, true, check.failure);
  assert.match(check.line, /ck-01-contracts-import-nothing/);
  assert.match(check.line, /zod/i);
  assert.match(check.line, /→/);
});

test("edge: assertExactSeedFailure rejects unexpected green", () => {
  const spec = SEED_MATRIX[0];
  const check = assertExactSeedFailure(spec, {
    status: 0,
    violations: [],
    edgeText: "",
  });
  assert.equal(check.ok, false);
  assert.match(check.failure, /SEED_UNEXPECTED_GREEN/);
});

test("edge: assertExactSeedFailure rejects generic / mismatched edges", () => {
  const spec = SEED_MATRIX.find((s) => s.kind === "domains");
  const check = assertExactSeedFailure(spec, {
    status: 1,
    violations: [
      {
        rule: RULE_IDS.CONTRACTS_IMPORT_NOTHING,
        from: "packages/contracts/src/index.ts",
        to: "zod",
      },
    ],
    edgeText: formatViolationEdges([
      {
        rule: RULE_IDS.CONTRACTS_IMPORT_NOTHING,
        from: "packages/contracts/src/index.ts",
        to: "zod",
      },
    ]),
  });
  assert.equal(check.ok, false);
  assert.match(check.failure, /SEED_MISSING_EXACT_EDGE/);
});

test("sovereignty / subject-isolation: prove phases use distinct subjectIds", async () => {
  const result = await proveDependencyDirectionGate({
    subjectId: "subj-iso-prove-a",
    deviceId: "dev-iso-prove-a",
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.completionRecord.subjectId, "subj-iso-prove-a");
  assert.equal(result.completionRecord.deviceId, "dev-iso-prove-a");
  assert.notEqual(result.completionRecord.subjectId, "subj-iso-prove-b");
});

test("idempotency: replaying prove does not leave tree red", async () => {
  const first = await proveDependencyDirectionGate({
    subjectId: "subj-prove-idem-1",
    deviceId: "dev-prove-idem",
  });
  const second = await proveDependencyDirectionGate({
    subjectId: "subj-prove-idem-2",
    deviceId: "dev-prove-idem",
  });
  assert.equal(first.ok, true, first.failures.join("\n"));
  assert.equal(second.ok, true, second.failures.join("\n"));
  assert.equal(first.completionRecord.seeds.length, SEED_MATRIX.length);
  assert.equal(second.completionRecord.seeds.length, SEED_MATRIX.length);
});
