/**
 * Staged rollout shadow scoring (C5).
 * Run: pnpm --filter @moolam/learning run build && node --experimental-strip-types --test training/delivery/staged_rollout.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CANARY_DRIFT_SCHEMA_VERSION,
  FLEET_ORCH_SCHEMA_VERSION,
  SHADOW_MIN_DOMAIN_PACK_COVERAGE,
  SHADOW_SCORING_SCHEMA_VERSION,
  STAGED_ROLLOUT_SCHEMA_VERSION,
  STAGED_ROLLOUT_SHADOW_STAGE,
  STAGED_ROLLOUT_CANARY_STAGE,
  STAGED_ROLLOUT_FLEET_STAGE,
  CanaryContractError,
  FleetOrchestratorError,
  FleetPromotionOrchestrator,
  StagedRolloutCanary,
  StagedRolloutFleetOrchestrator,
  ShadowScoringError,
  proveShadowScoringMicroRun,
  resetShadowScoringRunCache,
  runShadowScoringAgainstChampion,
  runStagedRolloutShadowScoring,
  runSyntheticFleetPromotionDemo,
} from "./staged_rollout.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";

function hashOpaque(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sample(input) {
  return {
    sampleId: input.sampleId,
    subjectId: input.subjectId,
    sliceId: input.sliceId,
    inputHash: hashOpaque(`input:${input.sampleId}`),
    championCriticScore: input.champion,
    championOutputHash: hashOpaque(input.championOut),
  };
}

test("happy path: shadow scores challenger ahead; user-facing stays champion-only", async () => {
  resetShadowScoringRunCache();
  const events = [];
  const shadowEvents = [];
  const subjectId = "subj.staged.shadow.ok";
  const deviceId = "dev.staged.shadow.ok";
  const samples = [
    sample({
      sampleId: "s1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.7,
      championOut: "serve-a",
    }),
    sample({
      sampleId: "s2",
      subjectId,
      sliceId: "doctor/en/b8",
      champion: 0.6,
      championOut: "serve-b",
    }),
  ];

  const result = await runStagedRolloutShadowScoring({
    subjectId,
    deviceId,
    runId: "run.staged.ok",
    samples,
    scoreChallenger: (s) => ({
      criticScore: s.championCriticScore + 0.12,
      outputHash: hashOpaque(`challenger:${s.sampleId}:${SECRET}`),
    }),
    onTelemetry: (e) => events.push(e),
    onShadowTelemetry: (e) => shadowEvents.push(e),
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, STAGED_ROLLOUT_SHADOW_STAGE);
  assert.equal(result.schemaVersion, STAGED_ROLLOUT_SCHEMA_VERSION);
  assert.equal(result.challengerServed, false);
  assert.equal(result.report.schemaVersion, SHADOW_SCORING_SCHEMA_VERSION);
  assert.equal(result.report.verdict, "challenger_ahead");
  assert.ok(result.report.domainPackCount >= SHADOW_MIN_DOMAIN_PACK_COVERAGE);
  assert.equal(result.userFacing.length, 2);
  assert.ok(result.userFacing.every((u) => u.source === "champion"));
  assert.equal(
    result.userFacing[0].outputHash,
    samples[0].championOutputHash,
  );
  assert.notEqual(
    result.report.challengerAuditHashes[0].outputHash,
    result.userFacing[0].outputHash,
  );

  const replay = await runStagedRolloutShadowScoring({
    subjectId,
    deviceId,
    runId: "run.staged.ok",
    samples,
    scoreChallenger: () => {
      throw new Error("idempotent replay must not re-score");
    },
  });
  assert.equal(replay.report.idempotentReplay, true);

  assert.ok(
    events.some(
      (e) =>
        e.event === "training.staged_rollout.shadow" &&
        e.servedChampionOnly === true &&
        e.verdict === "challenger_ahead",
    ),
  );
  assert.ok(
    shadowEvents.some(
      (e) => e.event === "learning.shadow_scoring.serve" && e.servedSource === "champion",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(shadowEvents).includes(SECRET));
  assert.ok(
    [...events, ...shadowEvents].every(
      (e) =>
        !("content" in e) &&
        !("utterance" in e) &&
        !("text" in e) &&
        !("blob" in e),
    ),
  );
});

test("edge: timeout holds champion; skew blocked; regression names failing slice", async () => {
  const proved = await proveShadowScoringMicroRun();
  assert.equal(proved.ok, true);
  assert.equal(proved.good.verdict, "challenger_ahead");
  assert.equal(proved.regressed.verdict, "challenger_behind");
  assert.equal(proved.regressed.failingSlice, "teacher/en/b8");
  assert.equal(proved.timedOut.verdict, "hold_champion");
  assert.equal(proved.timedOut.advisory, "shadow_timeout");
  assert.equal(proved.skewed.verdict, "hold_champion");
  assert.equal(proved.skewed.advisory, "coverage_skew");
  assert.equal(proved.refusedSubjectScope, true);

  resetShadowScoringRunCache();
  const subjectId = "subj.staged.shadow.surgery";
  const deviceId = "dev.staged.shadow.surgery";
  const multi = await runStagedRolloutShadowScoring({
    subjectId,
    deviceId,
    runId: "run.staged.surgery",
    samples: [
      sample({
        sampleId: "sx",
        subjectId,
        sliceId: "teacher/en/b8",
        champion: 0.5,
        championOut: "o",
      }),
      sample({
        sampleId: "sy",
        subjectId,
        sliceId: "doctor/en/b8",
        champion: 0.5,
        championOut: "p",
      }),
    ],
    surgeryClasses: ["adapter", "critic"],
    scoreChallenger: () => ({
      criticScore: 0.9,
      outputHash: hashOpaque("ignored"),
    }),
  });
  assert.equal(multi.report.verdict, "reject");
  assert.equal(multi.report.failureClass, "shadow.attribution_void");
  assert.equal(multi.challengerServed, false);
});

test("edge: cross-subject sample refused with typed obligation", async () => {
  resetShadowScoringRunCache();
  await assert.rejects(
    () =>
      runStagedRolloutShadowScoring({
        subjectId: "subj.staged.shadow.scope",
        deviceId: "dev.staged.shadow.scope",
        runId: "run.staged.scope",
        samples: [
          sample({
            sampleId: "sz",
            subjectId: "subj.other",
            sliceId: "teacher/en/b8",
            champion: 0.4,
            championOut: "z",
          }),
        ],
        scoreChallenger: () => ({
          criticScore: 0.4,
          outputHash: hashOpaque("z"),
        }),
      }),
    (error) =>
      error instanceof ShadowScoringError &&
      error.obligation === "shadow.subject_scope",
  );
});

function canaryConfig(overrides = {}) {
  return {
    cohortId: "cohort.canary.test",
    subjectFraction: 1,
    assignmentSeed: "seed:canary:pinned:001",
    baselineRegistryHash: hashOpaque("c0-frozen-baseline-registry"),
    baselineFrozen: true,
    baselineDecontaminated: true,
    surgeryClass: "adapter",
    minDomainPackCoverage: 2,
    slices: [
      { sliceId: "teacher/en/b8", score: 0.8, tolerance: 0.05 },
      { sliceId: "doctor/en/b8", score: 0.75, tolerance: 0.05 },
    ],
    ...overrides,
  };
}

test("canary: routes declared cohort at boundary and becomes healthy across slices", () => {
  const events = [];
  const canaryEvents = [];
  const deviceId = "dev.canary.ok";
  const rollout = new StagedRolloutCanary({
    config: canaryConfig(),
    deviceId,
    onTelemetry: (event) => events.push(event),
    onCanaryTelemetry: (event) => canaryEvents.push(event),
  });

  const route = rollout.routeAtTurnBoundary({
    operationId: "route.canary.ok.1",
    subjectId: "subj.canary.ok",
    deviceId,
    sessionId: "session.canary.ok.1",
    boundaryEvent: "TURN_COMPLETE",
  });
  assert.equal(route.schemaVersion, CANARY_DRIFT_SCHEMA_VERSION);
  assert.equal(route.route, "challenger");
  assert.equal(route.boundaryEvent, "TURN_COMPLETE");
  assert.equal(route.status, "collecting");

  const first = rollout.observeDrift({
    operationId: "drift.canary.ok.1",
    subjectId: "subj.canary.ok",
    deviceId,
    sliceId: "teacher/en/b8",
    score: 0.78,
  });
  assert.equal(first.status, "collecting");
  assert.equal(first.observedSliceCount, 1);

  const healthy = rollout.observeDrift({
    operationId: "drift.canary.ok.2",
    subjectId: "subj.canary.ok",
    deviceId,
    sliceId: "doctor/en/b8",
    score: 0.73,
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.domainPackCount, 2);
  assert.equal(healthy.requiredSliceCount, 2);
  assert.ok(healthy.metrics.every((metric) => !metric.breached));
  assert.equal(rollout.status, "healthy");
  assert.throws(
    () =>
      rollout.observeDrift({
        operationId: "drift.canary.ok.2",
        subjectId: "subj.canary.ok",
        deviceId,
        sliceId: "doctor/en/b8",
        score: 0.72,
      }),
    (error) =>
      error instanceof CanaryContractError &&
      error.obligation === "canary.observation_conflict",
  );

  const replay = rollout.routeAtTurnBoundary({
    operationId: "route.canary.ok.1",
    subjectId: "subj.canary.ok",
    deviceId,
    sessionId: "session.canary.ok.1",
    boundaryEvent: "TURN_COMPLETE",
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.route, "challenger");

  assert.ok(
    events.some(
      (event) =>
        event.event === "training.staged_rollout.canary_drift" &&
        event.status === "healthy" &&
        event.baselineRegistryHash ===
          canaryConfig().baselineRegistryHash,
    ),
  );
  assert.ok(
    canaryEvents.some(
      (event) =>
        event.event === "learning.canary.route" &&
        event.route === "challenger",
    ),
  );
  assert.ok(!JSON.stringify([...events, ...canaryEvents]).includes(SECRET));
  assert.ok(
    [...events, ...canaryEvents].every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("text" in event) &&
        !("blob" in event),
    ),
  );
});

test("canary edge: per-slice breach auto-halts and subsequent turns use champion", () => {
  const canaryEvents = [];
  const deviceId = "dev.canary.halt";
  const rollout = new StagedRolloutCanary({
    config: canaryConfig({ cohortId: "cohort.canary.halt" }),
    deviceId,
    onCanaryTelemetry: (event) => canaryEvents.push(event),
  });
  const subjectId = "subj.canary.halt";
  rollout.routeAtTurnBoundary({
    operationId: "route.canary.halt.1",
    subjectId,
    deviceId,
    sessionId: "session.canary.halt.1",
    boundaryEvent: "TURN_COMPLETE",
  });

  const halted = rollout.observeDrift({
    operationId: "drift.canary.halt.1",
    subjectId,
    deviceId,
    sliceId: "teacher/en/b8",
    score: 0.6,
  });
  assert.equal(halted.status, "halted");
  assert.equal(halted.failingSlice, "teacher/en/b8");
  assert.equal(halted.routeAfterWatch, "champion");
  assert.equal(halted.metrics[0].breached, true);

  const afterHalt = rollout.routeAtTurnBoundary({
    operationId: "route.canary.halt.2",
    subjectId,
    deviceId,
    sessionId: "session.canary.halt.2",
    boundaryEvent: "TURN_COMPLETE",
  });
  assert.equal(afterHalt.route, "champion");
  assert.equal(afterHalt.status, "halted");
  assert.ok(
    canaryEvents.some(
      (event) =>
        event.event === "learning.canary.halt" &&
        event.failingSlice === "teacher/en/b8" &&
        event.outcome === "fail",
    ),
  );
});

test("canary edge: boundary, baseline, and subject isolation fail typed", () => {
  assert.throws(
    () =>
      new StagedRolloutCanary({
        config: canaryConfig({ baselineFrozen: false }),
        deviceId: "dev.canary.invalid",
      }),
    (error) =>
      error instanceof CanaryContractError &&
      error.obligation === "canary.baseline_unfrozen",
  );
  assert.throws(
    () =>
      new StagedRolloutCanary({
        config: canaryConfig({ baselineDecontaminated: false }),
        deviceId: "dev.canary.invalid",
      }),
    (error) =>
      error instanceof CanaryContractError &&
      error.obligation === "canary.baseline_contaminated",
  );

  const deviceId = "dev.canary.scope";
  const rollout = new StagedRolloutCanary({
    config: canaryConfig({ cohortId: "cohort.canary.scope" }),
    deviceId,
  });
  assert.throws(
    () =>
      rollout.routeAtTurnBoundary({
        operationId: "route.canary.midturn",
        subjectId: "subj.canary.scope",
        deviceId,
        sessionId: "session.canary.scope",
        boundaryEvent: "TURN_START",
      }),
    (error) =>
      error instanceof CanaryContractError &&
      error.obligation === "canary.boundary_required",
  );
  assert.throws(
    () =>
      rollout.observeDrift({
        operationId: "drift.canary.cross",
        subjectId: "subj.not-assigned",
        deviceId,
        sliceId: "teacher/en/b8",
        score: 0.8,
      }),
    (error) =>
      error instanceof CanaryContractError &&
      error.obligation === "canary.subject_scope",
  );

  const championOnly = new StagedRolloutCanary({
    config: canaryConfig({
      cohortId: "cohort.canary.zero",
      subjectFraction: 0,
    }),
    deviceId,
  });
  const route = championOnly.routeAtTurnBoundary({
    operationId: "route.canary.zero",
    subjectId: "subj.canary.zero",
    deviceId,
    sessionId: "session.canary.zero",
    boundaryEvent: "TURN_COMPLETE",
  });
  assert.equal(route.route, "champion");
  assert.equal(route.subjectFraction, 0);
  assert.equal(STAGED_ROLLOUT_CANARY_STAGE, "staged-rollout.canary");
});

test("fleet e2e: known-good promotes shadow→canary→fleet; regressed names failing slice", async () => {
  resetShadowScoringRunCache();
  const events = [];
  const fleetEvents = [];
  const demo = await runSyntheticFleetPromotionDemo({
    onTelemetry: (event) => events.push(event),
    onFleetTelemetry: (event) => fleetEvents.push(event),
  });
  assert.equal(demo.ok, true);
  assert.equal(demo.challengerServedInShadow, false);
  assert.equal(demo.promoted.toStage, "fleet");
  assert.equal(demo.promoted.promoted, true);
  assert.equal(demo.promoted.fromStage, "canary");
  assert.equal(demo.rejected.toStage, "rejected");
  assert.equal(demo.rejected.promoted, false);
  assert.equal(demo.rejected.failingSlice, "teacher/en/b8");
  assert.equal(demo.rejected.failureClass, "fleet.shadow_behind");

  assert.ok(
    events.some(
      (event) =>
        event.event === "training.staged_rollout.fleet" &&
        event.toStage === "fleet" &&
        event.promoted === true &&
        event.goldenPassRate === 1,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "training.staged_rollout.fleet" &&
        event.toStage === "rejected" &&
        event.failingSlice === "teacher/en/b8",
    ),
  );
  assert.ok(
    fleetEvents.some(
      (event) =>
        event.event === "learning.fleet_orchestrator.transition" &&
        event.toStage === "fleet" &&
        event.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify([...events, ...fleetEvents]).includes(SECRET));
});

test("fleet edge: golden partial pass and subject isolation refuse promotion", async () => {
  resetShadowScoringRunCache();
  const subjectId = "subj.fleet.gates";
  const deviceId = "dev.fleet.gates";
  const shadowSamples = [
    sample({
      sampleId: "fg1",
      subjectId,
      sliceId: "teacher/en/b8",
      champion: 0.7,
      championOut: "fg-a",
    }),
    sample({
      sampleId: "fg2",
      subjectId,
      sliceId: "doctor/en/b8",
      champion: 0.65,
      championOut: "fg-b",
    }),
  ];
  const shadow = await runShadowScoringAgainstChampion({
    subjectId,
    deviceId,
    runId: "run.fleet.gates.shadow",
    samples: shadowSamples,
    scoreChallenger: (s) => ({
      criticScore: s.championCriticScore + 0.1,
      outputHash: hashOpaque(`c:${s.sampleId}`),
    }),
  });

  const orch = new StagedRolloutFleetOrchestrator({
    subjectId,
    deviceId,
    candidateId: "cand.fleet.gates",
    surgeryClass: "adapter",
  });
  const toCanary = orch.advanceFromShadow({
    operationId: "op.fleet.gates.shadow",
    subjectId,
    deviceId,
    shadow,
  });
  assert.equal(toCanary.toStage, "canary");
  assert.equal(orch.currentStage, "canary");

  const canary = new StagedRolloutCanary({
    config: canaryConfig({ cohortId: "cohort.fleet.gates" }),
    deviceId,
  });
  canary.routeAtTurnBoundary({
    operationId: "route.fleet.gates",
    subjectId,
    deviceId,
    sessionId: "session.fleet.gates",
    boundaryEvent: "TURN_COMPLETE",
  });
  canary.observeDrift({
    operationId: "drift.fleet.gates.1",
    subjectId,
    deviceId,
    sliceId: "teacher/en/b8",
    score: 0.86,
  });
  const healthy = canary.observeDrift({
    operationId: "drift.fleet.gates.2",
    subjectId,
    deviceId,
    sliceId: "doctor/en/b8",
    score: 0.81,
  });
  assert.equal(healthy.status, "healthy");

  const partialGolden = orch.advanceFromCanary({
    operationId: "op.fleet.gates.golden",
    subjectId,
    deviceId,
    canary: healthy,
    golden: {
      suiteId: "golden.partial",
      passRate: 0.9,
      passed: 9,
      total: 10,
    },
    baseline: {
      baselineRegistryHash: canaryConfig().baselineRegistryHash,
      baselineFrozen: true,
      baselineDecontaminated: true,
    },
  });
  assert.equal(partialGolden.promoted, false);
  assert.equal(partialGolden.toStage, "rejected");
  assert.equal(partialGolden.failureClass, "fleet.golden_incomplete");

  assert.throws(
    () =>
      FleetPromotionOrchestrator.assertOneSurgery(["adapter", "prompt"]),
    (error) =>
      error instanceof FleetOrchestratorError &&
      error.obligation === "fleet.attribution_void",
  );

  const scopeOrch = new StagedRolloutFleetOrchestrator({
    subjectId,
    deviceId,
    candidateId: "cand.fleet.scope",
    surgeryClass: "adapter",
  });
  assert.throws(
    () =>
      scopeOrch.advanceFromShadow({
        operationId: "op.fleet.scope",
        subjectId: "subj.other",
        deviceId,
        shadow,
      }),
    (error) =>
      error instanceof FleetOrchestratorError &&
      error.obligation === "fleet.subject_scope",
  );
  assert.equal(FLEET_ORCH_SCHEMA_VERSION, "learning.fleet-orchestrator.v1");
  assert.equal(STAGED_ROLLOUT_FLEET_STAGE, "staged-rollout.fleet");
});
