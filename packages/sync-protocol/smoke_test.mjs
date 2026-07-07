// Dependency-light smoke test for the TS CRDT resolver (run: node smoke_test.mjs)
import { CrdtHarnessResolver } from "./dist/crdt_harness_resolver.js";
import { HlcClock } from "./dist/hlc_clock.js";
import assert from "node:assert/strict";

const hlc = (ms, logical, device) =>
  `${String(ms).padStart(15, "0")}:${String(logical).padStart(6, "0")}:${device}`;

const makeState = (device, alpha, sessionMs) => ({
  protocolVersion: "1.0.0",
  subjectId: "anika-k",
  deviceIds: [device],
  activeConceptId: "math.ratios",
  mode: "exploratory",
  mastery: {
    "math.ratios": {
      conceptId: "math.ratios",
      alpha: { [device]: alpha },
      beta: { [device]: 1 },
      lastExercisedAt: hlc(sessionMs, 0, device),
    },
  },
  frictionLog: [
    {
      conceptId: "math.ratios",
      hesitationMs: 1200,
      inputVelocity: 3.2,
      revisionCount: 0,
      assistanceRequested: false,
      outcome: "correct",
      capturedAt: hlc(sessionMs, 1, device),
    },
  ],
  profile: {
    ageBand: "child",
    track: "cbse-class-7-maths",
    language: "hi-IN",
    updatedAt: hlc(sessionMs, 2, device),
  },
  stateVector: { session: hlc(sessionMs, 3, device) },
});

const resolver = new CrdtHarnessResolver();
const a = makeState("edge-aaaa", 3, 1_000_000);
const b = makeState("edge-bbbb", 5, 2_000_000);

const ab = resolver.merge(a, b).merged;
const ba = resolver.merge(b, a).merged;
assert.deepEqual(ab, ba, "merge must be commutative");
assert.deepEqual(resolver.merge(a, a).merged, a, "merge must be idempotent");
assert.deepEqual(ab.mastery["math.ratios"].alpha, { "edge-aaaa": 3, "edge-bbbb": 5 });
assert.equal(ab.frictionLog.length, 2);

const again = resolver.merge(ab, a);
assert.deepEqual(again.merged.mastery, ab.mastery);
assert.ok(again.advisories.some((adv) => adv.code === "DUPLICATE_SAMPLE_DROPPED"));

const clock = new HlcClock("edge-test");
const t1 = clock.tick();
const t2 = clock.tick();
assert.ok(t2 > t1, "HLC must be strictly monotonic");

console.log("TS CRDT resolver: commutative, idempotent, dedup, HLC monotonic OK");
