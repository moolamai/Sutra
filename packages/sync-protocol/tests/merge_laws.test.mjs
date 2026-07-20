/**
 * TS merge law suite ( + 002).
 * - 001: commutative / associative / idempotent (CI 10k seeded)
 * - 002: N-replica (3–5) permutation convergence + compaction handshake
 *
 * Counterexamples → fixtures/merge-laws/regression/
 * Run: pnpm --filter @moolam/sync-protocol build && node --test tests/merge_laws.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_ARBITRARY_SEED,
  CI_NUM_RUNS,
  cognitiveStateArb,
  replicaPairArb,
  subjectIdArb,
  fc,
  emitArbitraryEvent,
} from "./arbitraries.mjs";
import {
  canonicalizeState,
  makeMergeSafe,
  foldMerge,
  foldMergeWithCompactionHandshake,
  permuteReplicas,
  permuteFromSeed,
  applyCompactionHandshake,
} from "./merge_canon.mjs";
import {
  CrdtHarnessResolver,
  IrreconcilableStateError,
} from "../dist/crdt_harness_resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "../fixtures/merge-laws/regression");
const QUICK_RUNS = 200;

const mergeSafePairArb = (opts = {}) =>
  replicaPairArb(opts).map((pair) => ({
    ...pair,
    left: makeMergeSafe(pair.left),
    right: makeMergeSafe(pair.right),
  }));

/** Three replicas for the same subject (associativity). */
const mergeSafeTripleArb = fc
  .tuple(
    subjectIdArb,
    cognitiveStateArb({ emptyBias: true, equalTimestampBias: true }),
    cognitiveStateArb({ emptyBias: true, equalTimestampBias: true }),
    cognitiveStateArb({ emptyBias: true, equalTimestampBias: true }),
  )
  .map(([subjectId, a0, b0, c0]) => {
    const fix = (s) => makeMergeSafe({ ...s, subjectId });
    return { subjectId, a: fix(a0), b: fix(b0), c: fix(c0) };
  });

/**
 * 3–5 merge-safe replicas for one subjectId, plus several deterministic
 * permutations (identity + reverse + seeded shuffles).
 */
const replicaHistoryArb = fc
  .tuple(
    fc.integer({ min: 3, max: 5 }),
    subjectIdArb,
    fc.integer({ min: 0, max: 0xffffffff }),
  )
  .chain(([n, subjectId, seed]) =>
    fc
      .array(cognitiveStateArb({ emptyBias: true, equalTimestampBias: true }), {
        minLength: n,
        maxLength: n,
      })
      .map((raw) => {
        const replicas = raw.map((s) => makeMergeSafe({ ...s, subjectId }));
        const identity = Array.from({ length: n }, (_, i) => i);
        const reverse = [...identity].reverse();
        const orders = [
          identity,
          reverse,
          permuteFromSeed(n, seed),
          permuteFromSeed(n, seed ^ 0x9e3779b9),
          permuteFromSeed(n, seed + 1),
        ].filter(
          (p, i, all) =>
            all.findIndex((q) => q.join(",") === p.join(",")) === i,
        );
        return { subjectId, replicas, orders, n };
      }),
  );

function emitLawEvent(event) {
  process.stdout.write(
    `${JSON.stringify({ event: "crdt.merge.law", ...event })}\n`,
  );
}

/**
 * Persist a shrinking counterexample so merge bugs never evaporate.
 * @returns {string} fixture path
 */
export function persistCounterexample(law, payload) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const body = JSON.stringify(
    { law, savedAt: new Date().toISOString(), ...payload },
    null,
    2,
  );
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const file = path.join(FIXTURE_DIR, `${law}-${digest}.json`);
  writeFileSync(file, `${body}\n`, "utf8");
  emitLawEvent({
    outcome: "error",
    code: "MERGE_LAW_COUNTEREXAMPLE",
    law,
    fixture: path.relative(path.join(__dirname, ".."), file),
    subjectId: payload.subjectId ?? null,
  });
  return file;
}

function checkLaw(law, property, arb, opts = {}) {
  const numRuns = opts.numRuns ?? CI_NUM_RUNS;
  const seed = opts.seed ?? CI_ARBITRARY_SEED;
  const resolver = new CrdtHarnessResolver();
  const details = fc.check(fc.property(arb, (input) => property(resolver, input)), {
    numRuns,
    seed,
    verbose: false,
  });
  if (details.failed) {
    const input = Array.isArray(details.counterexample)
      ? details.counterexample[0]
      : details.counterexample;
    persistCounterexample(law, {
      subjectId: input?.subjectId ?? input?.left?.subjectId,
      input,
      error: details.error,
    });
    emitLawEvent({
      law,
      outcome: "error",
      code: "MERGE_LAW_VIOLATION",
      numRuns,
      seed,
    });
    assert.fail(
      `MERGE_LAW_VIOLATION:${law} after ${details.numRuns} runs (seed=${seed})`,
    );
  }
  emitLawEvent({
    law,
    outcome: "ok",
    numRuns: details.numRuns,
    seed,
  });
}

test("law: commutative — merge(a,b) ≡ merge(b,a) (CI 10k seeded)", () => {
  checkLaw(
    "commutative",
    (resolver, { left: a, right: b, subjectId }) => {
      assert.equal(a.subjectId, b.subjectId);
      assert.equal(a.subjectId, subjectId);
      const ab = resolver.merge(a, b).merged;
      const ba = resolver.merge(b, a).merged;
      return canonicalizeState(ab) === canonicalizeState(ba);
    },
    mergeSafePairArb({
      overlap: "partial",
      equalTimestampBias: true,
    }),
  );
});

test("law: associative — merge(a,merge(b,c)) ≡ merge(merge(a,b),c) (CI 10k)", () => {
  checkLaw(
    "associative",
    (resolver, { a, b, c, subjectId }) => {
      assert.equal(a.subjectId, subjectId);
      assert.equal(b.subjectId, subjectId);
      assert.equal(c.subjectId, subjectId);
      const left = resolver.merge(a, resolver.merge(b, c).merged).merged;
      const right = resolver.merge(resolver.merge(a, b).merged, c).merged;
      return canonicalizeState(left) === canonicalizeState(right);
    },
    mergeSafeTripleArb,
  );
});

test("law: idempotent — merge(a,a) ≡ a (CI 10k seeded)", () => {
  checkLaw(
    "idempotent",
    (resolver, a) => {
      const aa = resolver.merge(a, a).merged;
      return canonicalizeState(aa) === canonicalizeState(a);
    },
    cognitiveStateArb({ emptyBias: true, equalTimestampBias: true }).map(
      makeMergeSafe,
    ),
  );
});

test("law: convergence — permuted 3–5 replica folds agree (CI 10k seeded)", () => {
  checkLaw(
    "convergence",
    (resolver, { subjectId, replicas, orders }) => {
      assert.ok(replicas.length >= 3 && replicas.length <= 5);
      for (const r of replicas) assert.equal(r.subjectId, subjectId);
      const baselines = orders.map((order) =>
        canonicalizeState(foldMerge(resolver, permuteReplicas(replicas, order))),
      );
      return baselines.every((c) => c === baselines[0]);
    },
    replicaHistoryArb,
  );
});

test("law: compaction handshake mid-fold still converges (CI 10k seeded)", () => {
  checkLaw(
    "convergence.compaction",
    (resolver, { subjectId, replicas, orders }) => {
      assert.equal(replicas[0].subjectId, subjectId);
      const order = orders[0];
      const ordered = permuteReplicas(replicas, order);
      const pure = canonicalizeState(foldMerge(resolver, ordered));
      const { merged, compactedSampleTimestamps } =
        foldMergeWithCompactionHandshake(resolver, ordered, 1);
      assert.ok(Array.isArray(compactedSampleTimestamps));
      return pure === canonicalizeState(merged);
    },
    replicaHistoryArb,
  );
});

test("edge: empty/disjoint replicas still obey commutative", () => {
  const resolver = new CrdtHarnessResolver();
  fc.assert(
    fc.property(
      mergeSafePairArb({ overlap: "none", equalTimestampBias: false }),
      ({ left: a, right: b }) => {
        const ab = canonicalizeState(resolver.merge(a, b).merged);
        const ba = canonicalizeState(resolver.merge(b, a).merged);
        assert.equal(ab, ba);
      },
    ),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitLawEvent({
    law: "commutative",
    outcome: "ok",
    kind: "edge.disjoint",
    numRuns: QUICK_RUNS,
  });
});

test("edge: equal-HLC adversarial pairs remain commutative", () => {
  const resolver = new CrdtHarnessResolver();
  fc.assert(
    fc.property(
      mergeSafePairArb({ overlap: "full", equalTimestampBias: true }),
      ({ left: a, right: b }) => {
        assert.equal(
          canonicalizeState(resolver.merge(a, b).merged),
          canonicalizeState(resolver.merge(b, a).merged),
        );
      },
    ),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitLawEvent({
    law: "commutative",
    outcome: "ok",
    kind: "edge.equalHlc",
    numRuns: QUICK_RUNS,
  });
});

test("edge: replayed merge of already-folded state is idempotent", () => {
  const resolver = new CrdtHarnessResolver();
  fc.assert(
    fc.property(replicaHistoryArb, ({ replicas }) => {
      const folded = foldMerge(resolver, replicas);
      assert.equal(
        canonicalizeState(resolver.merge(folded, folded).merged),
        canonicalizeState(folded),
      );
      return true;
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitLawEvent({
    law: "convergence",
    outcome: "ok",
    kind: "edge.replayIdempotent",
    numRuns: QUICK_RUNS,
  });
});

test("edge: compaction handshake prunes only announced timestamps", () => {
  const resolver = new CrdtHarnessResolver();
  const { left, right } = fc.sample(
    mergeSafePairArb({ overlap: "partial", equalTimestampBias: false }),
    { num: 1, seed: CI_ARBITRARY_SEED },
  )[0];
  const mid = resolver.merge(left, right).merged;
  const compacted = mid.frictionLog.map((s) => s.capturedAt);
  const prunedLeft = applyCompactionHandshake(left, compacted);
  for (const s of prunedLeft.frictionLog) {
    assert.equal(compacted.includes(s.capturedAt), false);
  }
  assert.equal(
    canonicalizeState(resolver.merge(mid, prunedLeft).merged),
    canonicalizeState(mid),
  );
  emitLawEvent({
    law: "convergence.compaction",
    outcome: "ok",
    kind: "edge.handshakePrune",
    subjectId: left.subjectId,
    deviceId: left.deviceIds[0] ?? null,
    compacted: compacted.length,
  });
});

test("edge: regression fixture — colliding capturedAt is order-independent", () => {
  const resolver = new CrdtHarnessResolver();
  const seeded = path.join(FIXTURE_DIR, "friction-capturedAt-collision.json");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(seeded)) {
    const base = {
      protocolVersion: "1.0.0",
      subjectId: "subj-collision",
      deviceIds: ["dev-a", "dev-b"],
      activeConceptId: null,
      mode: "exploratory",
      mastery: {},
      profile: {
        ageBand: "adult",
        track: "math",
        language: "en",
        updatedAt: "000000000000001:000000:dev-a",
      },
      stateVector: { session: "000000000000001:000000:dev-a" },
    };
    const hlc = "000000001000000:000000:edge-fric";
    const left = {
      ...base,
      frictionLog: [
        {
          conceptId: "a00",
          hesitationMs: 0,
          inputVelocity: 0,
          revisionCount: 0,
          assistanceRequested: false,
          outcome: "correct",
          capturedAt: hlc,
        },
      ],
    };
    const right = {
      ...base,
      frictionLog: [
        {
          conceptId: "v-ref",
          hesitationMs: 9,
          inputVelocity: 1,
          revisionCount: 1,
          assistanceRequested: true,
          outcome: "incorrect",
          capturedAt: hlc,
        },
      ],
    };
    writeFileSync(
      seeded,
      `${JSON.stringify({ law: "commutative", note: "same capturedAt distinct payloads", left, right }, null, 2)}\n`,
    );
  }
  const { left, right } = JSON.parse(readFileSync(seeded, "utf8"));
  assert.equal(
    canonicalizeState(resolver.merge(left, right).merged),
    canonicalizeState(resolver.merge(right, left).merged),
  );
  emitLawEvent({
    law: "commutative",
    outcome: "ok",
    kind: "edge.regression.frictionCollision",
    subjectId: left.subjectId,
  });
});

test("edge: regression fixture — toString shard key is commutative", () => {
  const resolver = new CrdtHarnessResolver();
  const seeded = path.join(FIXTURE_DIR, "gcounter-tostring-shard.json");
  const { left, right } = JSON.parse(readFileSync(seeded, "utf8"));
  assert.equal(
    canonicalizeState(resolver.merge(left, right).merged),
    canonicalizeState(resolver.merge(right, left).merged),
  );
  const merged = resolver.merge(left, right).merged;
  assert.equal(merged.mastery["a.0"].alpha.toString, 0);
  emitLawEvent({
    law: "commutative",
    outcome: "ok",
    kind: "edge.regression.toStringShard",
    subjectId: left.subjectId,
  });
});

test("sovereignty: SUBJECT_MISMATCH refuses cross-subject merge", () => {
  const resolver = new CrdtHarnessResolver();
  fc.assert(
    fc.property(
      fc.tuple(
        cognitiveStateArb().map(makeMergeSafe),
        cognitiveStateArb().map(makeMergeSafe),
      ),
      ([a, b]) => {
        if (a.subjectId === b.subjectId) return true;
        assert.throws(
          () => resolver.merge(a, b),
          (err) =>
            err instanceof IrreconcilableStateError &&
            err.code === "SUBJECT_MISMATCH",
        );
        return true;
      },
    ),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitLawEvent({
    law: "subjectIsolation",
    outcome: "ok",
    code: "SUBJECT_MISMATCH",
    numRuns: QUICK_RUNS,
  });
});

test("sovereignty: convergence histories never cross subjects", () => {
  fc.assert(
    fc.property(replicaHistoryArb, ({ subjectId, replicas }) => {
      assert.ok(replicas.every((r) => r.subjectId === subjectId));
      return true;
    }),
    { numRuns: QUICK_RUNS, seed: CI_ARBITRARY_SEED },
  );
  emitLawEvent({
    law: "subjectIsolation",
    outcome: "ok",
    kind: "convergence.sameSubject",
    numRuns: QUICK_RUNS,
  });
});

test("observability: fixture directory ready for counterexample captures", () => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  assert.equal(existsSync(FIXTURE_DIR), true);
  emitArbitraryEvent({
    kind: "mergeLaws.fixtureDir",
    outcome: "ok",
    path: "fixtures/merge-laws/regression",
  });
});
