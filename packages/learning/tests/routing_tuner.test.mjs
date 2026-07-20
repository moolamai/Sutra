/**
 * Learned routing re-ranker behind feature flag.
 * Run: pnpm --filter @moolam/learning run build && node --experimental-strip-types --test packages/learning/tests/routing_tuner.test.mjs
 *
 * Harness surface is imported from TypeScript source (strip-types) so this
 * suite does not depend on a full runtime-harness package emit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RoutingTunerContractError,
  rankB8RoutingCandidates,
  rerankRoutingCandidates,
} from "../dist/routing_tuner.js";
import {
  LEARNED_ROUTING_FLAG,
  createLearnedRoutingReranker,
  rerankRoutingWithFeatureFlag,
} from "../../runtime-harness/src/routing/learned_reranker.ts";

const CANDIDATES = Object.freeze([
  { candidateId: "ret.low", kind: "retrieval", score: 0.4 },
  { candidateId: "guide.mid", kind: "guidance", score: 0.6 },
  { candidateId: "ret.high", kind: "retrieval", score: 0.9 },
]);

test("flag-off equals B8 order byte-for-byte", () => {
  const events = [];
  const baseline = rankB8RoutingCandidates(CANDIDATES);
  const flagged = rerankRoutingCandidates({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      features: { intent_match: 0.8, recency: 0.2 },
    },
    enabled: false,
    onTelemetry: (event) => events.push(event),
  });
  const harness = createLearnedRoutingReranker({ enabled: false }).rerank({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      features: { intent_match: 0.8, recency: 0.2 },
    },
  });

  assert.deepEqual(
    flagged.orderedCandidateIds,
    baseline.map((c) => c.candidateId),
  );
  assert.deepEqual(flagged.candidates, baseline);
  assert.equal(flagged.orderChanged, false);
  assert.equal(flagged.enabled, false);
  assert.deepEqual(harness.orderedCandidateIds, flagged.orderedCandidateIds);
  assert.deepEqual(harness.candidates, flagged.candidates);
  assert.equal(harness.path, "champion");
  assert.equal(harness.flag, LEARNED_ROUTING_FLAG);
  assert.ok(events.every((event) => event.outcome === "passthrough"));
  assert.ok(!JSON.stringify(events).includes("intent"));
});

test("flag-on re-ranks within B8 set only; empty falls through", () => {
  const events = [];
  const baseline = rankB8RoutingCandidates(CANDIDATES);
  const tuned = rerankRoutingWithFeatureFlag({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      // Prefer the lowest B8 scorer so order must change without inventing ids.
      features: { "prefer.ret.low": 1 },
    },
    enabled: true,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(tuned.enabled, true);
  assert.equal(tuned.orderChanged, true);
  assert.equal(tuned.path, "challenger");
  assert.equal(tuned.candidates.length, baseline.length);
  assert.equal(tuned.orderedCandidateIds[0], "ret.low");
  assert.deepEqual(
    [...tuned.orderedCandidateIds].sort(),
    [...baseline.map((c) => c.candidateId)].sort(),
  );
  for (const id of tuned.orderedCandidateIds) {
    assert.ok(baseline.some((c) => c.candidateId === id));
  }

  const empty = rerankRoutingCandidates({
    candidates: [],
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "self-hosted",
    },
    enabled: true,
  });
  assert.deepEqual(empty.orderedCandidateIds, []);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.orderChanged, false);

  assert.ok(events.some((event) => event.subjectId === "subj.routing"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("subject scope, locality, capacity, and MoE map optionality", () => {
  assert.throws(
    () =>
      rerankRoutingCandidates({
        candidates: CANDIDATES,
        context: {
          subjectId: "subj.other",
          deviceId: "dev.routing",
          locality: "on-device",
        },
        expectedSubjectId: "subj.routing",
      }),
    (error) =>
      error instanceof RoutingTunerContractError &&
      error.obligation === "routing_tuner.subject_scope",
  );

  assert.throws(
    () =>
      rerankRoutingCandidates({
        candidates: CANDIDATES,
        context: {
          subjectId: "subj.routing",
          locality: "remote",
        },
      }),
    (error) =>
      error instanceof RoutingTunerContractError &&
      error.obligation === "routing_tuner.locality_forbidden",
  );

  assert.throws(
    () =>
      rankB8RoutingCandidates(
        Array.from({ length: 65 }, (_, i) => ({
          candidateId: `c.${i}`,
          kind: "retrieval",
          score: 0.5,
        })),
      ),
    (error) =>
      error instanceof RoutingTunerContractError &&
      error.obligation === "routing_tuner.capacity",
  );

  const dense = rerankRoutingCandidates({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
    },
    enabled: false,
  });
  assert.equal(dense.routerReplayMap, undefined);

  const moe = rerankRoutingCandidates({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      routerReplayMap: { intent: "route-a", fallback: "dense-slm" },
    },
    enabled: false,
  });
  assert.deepEqual(moe.routerReplayMap, {
    intent: "route-a",
    fallback: "dense-slm",
  });

  const first = createLearnedRoutingReranker({ enabled: true }).rerank({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      features: { intent_match: 0.7 },
    },
  });
  const replay = createLearnedRoutingReranker({ enabled: true }).rerank({
    candidates: CANDIDATES,
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "on-device",
      features: { intent_match: 0.7 },
    },
  });
  assert.deepEqual(replay, first);
});
