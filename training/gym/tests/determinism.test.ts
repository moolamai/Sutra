/**
 * Seeded clock + per-rollout RNG + retrieval order + sampling temperature.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createHarnessDeterminismContext,
  createPerRolloutRng,
  createSeededClock,
  GYM_RETRIEVAL_CANDIDATE_LIMIT,
  hashFrameSequenceCanonical,
  orderRetrievalBySeed,
  PROVE_RETRIEVAL_CANDIDATES,
  proveCrossProcessSeededEntropy,
  proveDeterminismInjection,
  proveDeterminismSampling,
  samplingParamsFromSeed,
  SEED_PROPAGATION_CONTRACT,
  snapshotSeededEntropy,
} from "../determinism.ts";
import { GymEnv } from "../env.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

test("happy path: same seed injects identical clock ISO and RNG prefix", () => {
  const events: object[] = [];
  const a = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.gym.det.unit",
    deviceId: "dev-gym-det-unit",
    scenarioId: "thought-answer-basic",
    onTelemetry: (e) => events.push(e),
  });
  const b = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.gym.det.unit",
    deviceId: "dev-gym-det-unit",
    scenarioId: "thought-answer-basic",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(a.context.clock.toIso(), b.context.clock.toIso());
  assert.equal(a.context.injectFingerprint, b.context.injectFingerprint);
  assert.deepEqual(a.context.sampling, b.context.sampling);

  const ra = a.context.rng.next("subj.gym.det.unit");
  const rb = b.context.rng.next("subj.gym.det.unit");
  assert.equal(typeof ra, "number");
  assert.equal(ra, rb);

  assert.ok(
    events.some(
      (e) =>
        (e as { op?: string; outcome?: string }).op === "inject" &&
        (e as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        (e as { op?: string }).op === "sample" &&
        typeof (e as { temperature?: number }).temperature === "number",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.equal(SEED_PROPAGATION_CONTRACT.version, 2);
});

test("edge: parallel rollouts do not bleed RNG state", () => {
  const left = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.gym.det.left",
    deviceId: "dev-gym-det",
  });
  const right = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.gym.det.right",
    deviceId: "dev-gym-det",
  });
  assert.equal(left.ok && right.ok, true);
  if (!left.ok || !right.ok) return;

  const r0 = right.context.rng.next("subj.gym.det.right");
  assert.equal(typeof r0, "number");

  left.context.rng.next("subj.gym.det.left");
  left.context.rng.next("subj.gym.det.left");
  left.context.clock.tick();
  left.context.clock.tick();

  const rightFresh = createHarnessDeterminismContext({
    seed: 99,
    subjectId: "subj.gym.det.right",
    deviceId: "dev-gym-det",
  });
  assert.equal(rightFresh.ok, true);
  if (!rightFresh.ok) return;
  const r0Again = rightFresh.context.rng.next("subj.gym.det.right");
  assert.equal(r0Again, r0);
});

test("edge: invalid seed rejected; clock tick is deterministic", () => {
  const bad = createHarnessDeterminismContext({
    seed: -1,
    subjectId: "subj.gym.det.unit",
    deviceId: "dev-gym-det-unit",
  });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.failureClass, "invalid_seed");

  const clock = createSeededClock(7);
  const t0 = clock.toIso();
  clock.tick();
  const t1 = clock.toIso();
  assert.notEqual(t0, t1);
  const clock2 = createSeededClock(7);
  clock2.tick();
  assert.equal(clock2.toIso(), t1);
});

test("sovereignty: cross-subject RNG draw is rejected", () => {
  const events: object[] = [];
  const rng = createPerRolloutRng({
    seed: 3,
    subjectId: "subj.gym.det.a",
    deviceId: "dev-gym-det",
    onTelemetry: (e) => events.push(e),
  });
  const cross = rng.next("subj.gym.det.b");
  assert.equal(typeof cross, "object");
  if (typeof cross === "number") return;
  assert.equal(cross.failureClass, "cross_subject");
  assert.ok(
    events.some(
      (e) =>
        (e as { failureClass?: string }).failureClass === "cross_subject",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("idempotent: GymEnv reset binds determinism; same seed → same frame hash", async () => {
  const events: object[] = [];
  const envA = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-det-hash",
    onTelemetry: (e) => events.push(e),
  });
  const envB = new GymEnv({
    subjectId: "anika-k",
    deviceId: "dev-gym-det-hash",
  });

  assert.equal(envA.reset("thought-answer-basic", 11).ok, true);
  assert.equal(envB.reset("thought-answer-basic", 11).ok, true);

  const detA = envA.getDeterminismContext();
  const detB = envB.getDeterminismContext();
  assert.ok(detA);
  assert.ok(detB);
  assert.equal(detA!.clock.toIso(), detB!.clock.toIso());
  assert.equal(detA!.seed, 11);
  assert.deepEqual(detA!.sampling, detB!.sampling);

  const stepA = await envA.step({ path: "turn_loop" });
  const stepB = await envB.step({ path: "turn_loop" });
  assert.equal(stepA.ok && stepB.ok, true, JSON.stringify({ stepA, stepB }));
  if (!stepA.ok || !stepB.ok) return;

  const hashA = await hashFrameSequenceCanonical(stepA.frames);
  const hashB = await hashFrameSequenceCanonical(stepB.frames);
  assert.equal(hashA, hashB);

  assert.ok(
    events.some(
      (e) =>
        (e as { detail?: string }).detail?.includes("determinism") ||
        (e as { detail?: string }).detail?.includes("seed"),
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: same seed yields identical retrieval order + sampling", () => {
  const events: object[] = [];
  const a = createHarnessDeterminismContext({
    seed: 17,
    subjectId: "subj.gym.det.order",
    deviceId: "dev-gym-det-order",
    scenarioId: "thought-answer-basic",
    onTelemetry: (e) => events.push(e),
  });
  const b = createHarnessDeterminismContext({
    seed: 17,
    subjectId: "subj.gym.det.order",
    deviceId: "dev-gym-det-order",
    scenarioId: "thought-answer-basic",
  });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  const orderA = orderRetrievalBySeed({
    context: a.context,
    subjectId: "subj.gym.det.order",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
    onTelemetry: (e) => events.push(e),
  });
  const orderB = orderRetrievalBySeed({
    context: b.context,
    subjectId: "subj.gym.det.order",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  assert.equal(orderA.ok && orderB.ok, true);
  if (!orderA.ok || !orderB.ok) return;
  assert.deepEqual(orderA.order, orderB.order);
  assert.deepEqual(
    samplingParamsFromSeed(17, "thought-answer-basic"),
    a.context.sampling,
  );
  assert.ok(events.some((e) => (e as { op?: string }).op === "order"));
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("edge: different seeds diverge retrieval tie-break; candidate limit enforced", () => {
  const c1 = createHarnessDeterminismContext({
    seed: 1,
    subjectId: "subj.gym.det.tie",
    deviceId: "dev-gym-det",
    scenarioId: "scen-a",
  });
  const c2 = createHarnessDeterminismContext({
    seed: 2,
    subjectId: "subj.gym.det.tie",
    deviceId: "dev-gym-det",
    scenarioId: "scen-a",
  });
  assert.equal(c1.ok && c2.ok, true);
  if (!c1.ok || !c2.ok) return;

  const tied = [
    { connectorId: "alpha", score: 0.9 },
    { connectorId: "beta", score: 0.9 },
    { connectorId: "gamma", score: 0.9 },
  ];
  const o1 = orderRetrievalBySeed({
    context: c1.context,
    subjectId: "subj.gym.det.tie",
    candidates: tied,
  });
  const o2 = orderRetrievalBySeed({
    context: c2.context,
    subjectId: "subj.gym.det.tie",
    candidates: tied,
  });
  assert.equal(o1.ok && o2.ok, true);
  if (!o1.ok || !o2.ok) return;
  // Same scores; seed-driven tie-break should differ across seeds.
  assert.notDeepEqual(o1.order, o2.order);
  assert.notDeepEqual(c1.context.sampling, c2.context.sampling);

  const over = orderRetrievalBySeed({
    context: c1.context,
    subjectId: "subj.gym.det.tie",
    candidates: Array.from(
      { length: GYM_RETRIEVAL_CANDIDATE_LIMIT + 1 },
      (_, i) => ({ connectorId: `x.${i}` }),
    ),
  });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.equal(over.failureClass, "candidate_limit");
});

test("sovereignty: cross-subject retrieval order rejected", () => {
  const events: object[] = [];
  const ctx = createHarnessDeterminismContext({
    seed: 5,
    subjectId: "subj.gym.det.a",
    deviceId: "dev-gym-det",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(ctx.ok, true);
  if (!ctx.ok) return;

  const cross = orderRetrievalBySeed({
    context: ctx.context,
    subjectId: "subj.gym.det.b",
    candidates: PROVE_RETRIEVAL_CANDIDATES,
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(cross.ok, false);
  if (cross.ok) return;
  assert.equal(cross.failureClass, "cross_subject");
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("reproducibility: two processes emit identical seeded entropy", () => {
  const proved = proveCrossProcessSeededEntropy();
  assert.equal(proved.ok, true, proved.detail);
});

test("proveDeterminismInjection + proveDeterminismSampling self-checks", () => {
  const inject = proveDeterminismInjection();
  assert.equal(inject.ok, true, inject.detail);
  const sample = proveDeterminismSampling();
  assert.equal(sample.ok, true, sample.detail);

  const snapCtx = createHarnessDeterminismContext({
    seed: 42,
    subjectId: "subj.prove.sample",
    deviceId: "dev-prove-sample",
    scenarioId: "thought-answer-basic",
  });
  assert.equal(snapCtx.ok, true);
  if (!snapCtx.ok) return;
  const snap = snapshotSeededEntropy({
    context: snapCtx.context,
    candidates: PROVE_RETRIEVAL_CANDIDATES,
  });
  assert.equal(snap.ok, true);
});
