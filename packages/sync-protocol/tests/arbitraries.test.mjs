/**
 * HLC / shard / full CognitiveState arbitraries ( + 002).
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/arbitraries.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CI_ARBITRARY_SEED,
  CI_NUM_RUNS,
  deviceIdArb,
  hlcArb,
  equalHlcDifferentDevicesArb,
  gCounterShardsArb,
  conceptMasteryArb,
  frictionSampleArb,
  frictionSampleSetArb,
  cognitiveStateArb,
  replicaPairArb,
  assertArbitraryMatchesSchema,
  fc,
  hlcSchema,
  frictionSampleSchema,
  conceptMasterySchema,
  cognitiveStateSchema,
  emitArbitraryEvent,
} from "./arbitraries.mjs";
import { compareHLC } from "../dist/index.js";

const QUICK_RUNS = 200;

test("happy path: HLC arbitrary always matches hlcSchema (CI 10k seeded)", () => {
  assertArbitraryMatchesSchema("hlc", hlcArb(), hlcSchema, {
    numRuns: CI_NUM_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("happy path: ConceptMastery with G-Counter shards matches schema (CI 10k)", () => {
  assertArbitraryMatchesSchema("conceptMastery", conceptMasteryArb(), conceptMasterySchema, {
    numRuns: CI_NUM_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("happy path: FrictionSample matches schema (CI 10k)", () => {
  assertArbitraryMatchesSchema("frictionSample", frictionSampleArb(), frictionSampleSchema, {
    numRuns: CI_NUM_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("happy path: CognitiveState arbitrary always matches wire schema (CI 10k)", () => {
  assertArbitraryMatchesSchema("cognitiveState", cognitiveStateArb(), cognitiveStateSchema, {
    numRuns: CI_NUM_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("edge: equal physical+logical HLCs from different deviceIds are ordered by deviceId", () => {
  fc.assert(
    fc.property(equalHlcDifferentDevicesArb, ({ a, b, deviceA, deviceB }) => {
      assert.equal(hlcSchema.safeParse(a).success, true);
      assert.equal(hlcSchema.safeParse(b).success, true);
      const expected = deviceA < deviceB ? -1 : deviceA > deviceB ? 1 : 0;
      assert.equal(compareHLC(a, b), expected);
      assert.notEqual(a, b);
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitArbitraryEvent({
    kind: "equalHlcDifferentDevices",
    outcome: "ok",
    numRuns: QUICK_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("edge: G-Counter shards cover empty, single-shard, and multi-device cases", () => {
  const samples = fc.sample(gCounterShardsArb(), {
    num: 100,
    seed: CI_ARBITRARY_SEED,
  });
  const empty = samples.filter((s) => Object.keys(s).length === 0).length;
  const single = samples.filter((s) => Object.keys(s).length === 1).length;
  const multi = samples.filter((s) => Object.keys(s).length >= 2).length;
  assert.ok(empty > 0, "expected empty shard maps");
  assert.ok(single > 0, "expected single-shard maps");
  assert.ok(multi > 0, "expected multi-device shard maps");
  emitArbitraryEvent({
    kind: "gCounterShards.bias",
    outcome: "ok",
    empty,
    single,
    multi,
  });
});

test("edge: frictionSampleSetArb emits capturedAt collisions deliberately", () => {
  const sets = fc.sample(frictionSampleSetArb({ collisionBias: true }), {
    num: 100,
    seed: CI_ARBITRARY_SEED,
  });
  let collisions = 0;
  let empties = 0;
  for (const set of sets) {
    if (set.length === 0) empties += 1;
    for (const sample of set) {
      assert.equal(frictionSampleSchema.safeParse(sample).success, true);
    }
    const keys = set.map((s) => s.capturedAt);
    if (keys.length !== new Set(keys).size) collisions += 1;
  }
  assert.ok(empties > 0, "empty friction logs must be first-class");
  assert.ok(collisions > 0, "capturedAt collisions must be generated");
  emitArbitraryEvent({
    kind: "frictionSampleSet.collisions",
    outcome: "ok",
    empties,
    collisions,
    sampled: sets.length,
  });
});

test("edge: CognitiveState covers empty mastery and adversarial equal-HLC vectors", () => {
  const samples = fc.sample(
    cognitiveStateArb({ equalTimestampBias: true, emptyBias: true }),
    { num: 100, seed: CI_ARBITRARY_SEED },
  );
  const emptyMastery = samples.filter((s) => Object.keys(s.mastery).length === 0).length;
  let equalTsVectors = 0;
  for (const state of samples) {
    assert.equal(cognitiveStateSchema.safeParse(state).success, true);
    const entries = Object.values(state.stateVector);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const pa = a.slice(0, 22);
        const pb = b.slice(0, 22);
        if (pa === pb && a !== b) equalTsVectors += 1;
      }
    }
  }
  assert.ok(emptyMastery > 0, "empty mastery maps must be first-class");
  assert.ok(equalTsVectors > 0, "adversarial equal-HLC state vectors expected");
  emitArbitraryEvent({
    kind: "cognitiveState.bias",
    outcome: "ok",
    emptyMastery,
    equalTsVectors,
  });
});

test("edge: replicaPairArb overlap=none shares no mastery keys; full shares all", () => {
  fc.assert(
    fc.property(replicaPairArb({ overlap: "none", equalTimestampBias: true }), (pair) => {
      assert.equal(pair.left.subjectId, pair.right.subjectId);
      assert.equal(pair.subjectId, pair.left.subjectId);
      assert.equal(cognitiveStateSchema.safeParse(pair.left).success, true);
      assert.equal(cognitiveStateSchema.safeParse(pair.right).success, true);
      const leftKeys = Object.keys(pair.left.mastery);
      const rightKeys = Object.keys(pair.right.mastery);
      for (const k of leftKeys) assert.equal(rightKeys.includes(k), false);
      const ls = pair.left.stateVector.session;
      const rs = pair.right.stateVector.session;
      assert.ok(ls && rs);
      assert.equal(ls.slice(0, 22), rs.slice(0, 22));
      assert.notEqual(ls, rs);
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );

  fc.assert(
    fc.property(replicaPairArb({ overlap: "full", equalTimestampBias: false }), (pair) => {
      const leftKeys = Object.keys(pair.left.mastery).sort();
      const rightKeys = Object.keys(pair.right.mastery).sort();
      assert.deepEqual(leftKeys, rightKeys);
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );

  emitArbitraryEvent({
    kind: "replicaPair.overlap",
    outcome: "ok",
    numRuns: QUICK_RUNS,
    seed: CI_ARBITRARY_SEED,
  });
});

test("sovereignty: leaf gens omit subjectId; replica pairs never cross subjects", () => {
  fc.assert(
    fc.property(
      fc.tuple(conceptMasteryArb(), frictionSampleArb(), replicaPairArb()),
      ([mastery, sample, pair]) => {
        assert.equal("subjectId" in mastery, false);
        assert.equal("subjectId" in sample, false);
        assert.equal(pair.left.subjectId, pair.right.subjectId);
        assert.match(pair.left.subjectId, /^[a-z][a-z0-9_-]{2,32}$/);
      },
    ),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitArbitraryEvent({
    kind: "subjectIsolation.replicaPair",
    outcome: "ok",
    numRuns: QUICK_RUNS,
  });
});

test("deviceIdArb shrinks within the HLC wire alphabet", () => {
  fc.assert(
    fc.property(deviceIdArb, (id) => {
      assert.match(id, /^[A-Za-z0-9_-]{4,64}$/);
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
});
