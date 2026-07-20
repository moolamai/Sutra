/**
 * Champion/challenger routing comparison telemetry (shadow) + per-slice scores.
 * Run: pnpm --filter @moolam/learning run build && node --experimental-strip-types --test packages/learning/tests/routing_tuner_shadow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RoutingTunerContractError,
  compareRoutingChampionChallenger,
  createRoutingSliceScoreAccumulator,
  rankB8RoutingCandidates,
} from "../dist/routing_tuner.js";
import {
  createLearnedRoutingReranker,
  rerankRoutingWithFeatureFlag,
} from "../../runtime-harness/src/routing/learned_reranker.ts";

const CANDIDATES = Object.freeze([
  { candidateId: "ret.low", kind: "retrieval", score: 0.4 },
  { candidateId: "guide.mid", kind: "guidance", score: 0.6 },
  { candidateId: "ret.high", kind: "retrieval", score: 0.9 },
]);

const CONTEXT = Object.freeze({
  subjectId: "subj.routing",
  deviceId: "dev.routing",
  locality: "on-device",
  features: { "prefer.ret.low": 1 },
});

test("shadow serves champion byte-for-byte; logs challenger comparison", () => {
  const events = [];
  const baseline = rankB8RoutingCandidates(CANDIDATES);
  const compared = compareRoutingChampionChallenger({
    candidates: CANDIDATES,
    context: CONTEXT,
    sliceId: "pack.a/en/bind.1",
    observationId: "obs.shadow.1",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(compared.mode, "shadow");
  assert.equal(compared.servedPath, "champion");
  assert.deepEqual(compared.served.orderedCandidateIds, baseline.map((c) => c.candidateId));
  assert.deepEqual(compared.served.candidates, baseline);
  assert.equal(compared.orderChanged, true);
  assert.equal(compared.challengerOrderedIds[0], "ret.low");
  assert.equal(compared.championOrderedIds[0], "ret.high");
  assert.equal(compared.topMatch, false);

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "learning.routing_tuner.comparison");
  assert.equal(events[0].outcome, "shadow");
  assert.equal(events[0].servedPath, "champion");
  assert.equal(events[0].sliceId, "pack.a/en/bind.1");
  assert.ok(!JSON.stringify(events).includes("utterance"));

  const empty = compareRoutingChampionChallenger({
    candidates: [],
    context: {
      subjectId: "subj.routing",
      deviceId: "dev.routing",
      locality: "self-hosted",
    },
  });
  assert.deepEqual(empty.served.orderedCandidateIds, []);
  assert.equal(empty.orderChanged, false);
  assert.equal(empty.servedPath, "champion");
});

test("per-slice accumulation is subject-scoped, idempotent, and ties stay ties", () => {
  const scoreEvents = [];
  const accumulator = createRoutingSliceScoreAccumulator({
    expectedSubjectId: "subj.routing",
    onTelemetry: (event) => scoreEvents.push(event),
  });

  compareRoutingChampionChallenger({
    candidates: CANDIDATES,
    context: CONTEXT,
    sliceId: "pack.a/en/bind.1",
    observationId: "obs.1",
    championHit: true,
    challengerHit: true,
    accumulator,
  });
  compareRoutingChampionChallenger({
    candidates: CANDIDATES,
    context: CONTEXT,
    sliceId: "pack.a/en/bind.1",
    observationId: "obs.2",
    championHit: true,
    challengerHit: false,
    accumulator,
  });
  // Idempotent replay — must not double-count.
  const replay = compareRoutingChampionChallenger({
    candidates: CANDIDATES,
    context: CONTEXT,
    sliceId: "pack.a/en/bind.1",
    observationId: "obs.1",
    championHit: false,
    challengerHit: true,
    accumulator,
  });
  assert.equal(replay.idempotentReplay, true);

  const rows = accumulator.snapshot("subj.routing");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sampleCount, 2);
  assert.equal(rows[0].championHits, 2);
  assert.equal(rows[0].challengerHits, 1);
  assert.equal(rows[0].status, "behind");

  const gate = accumulator.scoresForGate("subj.routing");
  assert.equal(gate.championScores["pack.a/en/bind.1"], 1);
  assert.equal(gate.challengerScores["pack.a/en/bind.1"], 0.5);

  // Tie slice — equal hits ⇒ tie (does not promote).
  accumulator.record({
    subjectId: "subj.routing",
    deviceId: "dev.routing",
    sliceId: "pack.b/en/bind.1",
    observationId: "obs.tie.1",
    orderChanged: false,
    topMatch: true,
    championHit: true,
    challengerHit: true,
  });
  const tie = accumulator.snapshot("subj.routing").find(
    (row) => row.sliceId === "pack.b/en/bind.1",
  );
  assert.equal(tie.status, "tie");
  assert.equal(tie.delta, 0);

  assert.throws(
    () =>
      accumulator.record({
        subjectId: "subj.other",
        sliceId: "pack.a/en/bind.1",
        orderChanged: false,
        topMatch: true,
      }),
    (error) =>
      error instanceof RoutingTunerContractError &&
      error.obligation === "routing_tuner.subject_scope",
  );

  assert.ok(scoreEvents.some((event) => event.idempotentReplay === true));
  assert.ok(!JSON.stringify(scoreEvents).includes("prefer."));
});

test("harness shadow mode never serves challenger order", () => {
  const events = [];
  const accumulator = createRoutingSliceScoreAccumulator();
  const baseline = rankB8RoutingCandidates(CANDIDATES);
  const result = rerankRoutingWithFeatureFlag({
    candidates: CANDIDATES,
    context: CONTEXT,
    mode: "shadow",
    sliceId: "pack.a/en/bind.1",
    observationId: "obs.harness.1",
    championHit: false,
    challengerHit: true,
    accumulator,
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(result.mode, "shadow");
  assert.equal(result.path, "champion");
  assert.deepEqual(result.orderedCandidateIds, baseline.map((c) => c.candidateId));
  assert.equal(result.shadow?.orderChanged, true);
  assert.equal(result.shadow?.challengerOrderedIds[0], "ret.low");

  const reranker = createLearnedRoutingReranker({
    mode: "shadow",
    accumulator,
  });
  assert.equal(reranker.mode, "shadow");
  assert.equal(reranker.enabled, true);

  assert.ok(events.some((event) => event.outcome === "shadow"));
  assert.ok(events.every((event) => event.path === "champion"));
  assert.equal(
    accumulator.snapshot("subj.routing")[0]?.status,
    "ahead",
  );
});
