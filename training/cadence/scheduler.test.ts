/**
 * Cadence scheduler — collect → score → train → shadow → canary → gate.
 * Run: node --experimental-strip-types --test training/cadence/scheduler.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CadenceSchedulerError,
  runCadenceCycle as runCadenceCycleRaw,
  resetCadenceSchedulerReceipts,
  type CadenceEvalPin,
  type CadenceSliceScore,
  type CadenceStageHandlers,
  type CadenceVerdictEvidence,
} from "./scheduler.ts";
import {
  assertHumanCannotOverrideFailingVerdict,
  createAutomatedVerdictBundle,
  CadenceVerdictBundleError,
} from "./verdict_bundle.ts";

const DEVICE_ID = "device.cadence.01";
const SUBJECT_ID = "subject.cadence.01";
const CHECKPOINT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REGISTRY =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MANIFEST =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SUITE =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function verdictEvidence(input: {
  subjectId?: string;
  locality?: "on-device" | "self-hosted";
  candidateId?: string;
  checkpointHash?: string;
  redTeamVerdict?: "pass" | "fail";
} = {}): CadenceVerdictEvidence {
  const subjectId = input.subjectId ?? SUBJECT_ID;
  const locality = input.locality ?? "on-device";
  const candidateId = input.candidateId ?? "candidate.cadence.green";
  const checkpointHash = input.checkpointHash ?? CHECKPOINT;
  return {
    lineage: {
      schemaVersion: "checkpoint.lineage.v1",
      runId: "run.cadence.01",
      subjectId,
      deviceId: DEVICE_ID,
      locality,
      checkpointHash,
      parentCheckpointHash: `sha256:${"e".repeat(64)}`,
      corpusManifestHash: MANIFEST,
      baseModelHash: `sha256:${"f".repeat(64)}`,
      signerId: "trainer.cadence.01",
      signedAt: "2026-07-17T11:00:00.000Z",
      signature: "signed-cadence-evidence-0001",
      verified: true,
    },
    redTeam: {
      suiteId: "candidate-red-team",
      suiteManifestHash: SUITE,
      candidateId,
      subjectId,
      deviceId: DEVICE_ID,
      locality,
      verdict: input.redTeamVerdict ?? "pass",
      completedAt: "2026-07-17T11:30:00.000Z",
      failingScenarioIds:
        input.redTeamVerdict === "fail" ? ["scenario.injection.01"] : [],
    },
  };
}

type CycleInput = Parameters<typeof runCadenceCycleRaw>[0];
function runCadenceCycle(
  input: Omit<CycleInput, "evidence"> & { evidence?: CadenceVerdictEvidence },
) {
  return runCadenceCycleRaw({
    ...input,
    evidence: input.evidence ?? verdictEvidence({
      subjectId: input.subjectId,
      locality: input.locality,
    }),
  });
}

function evalPin(): CadenceEvalPin {
  return {
    baselineRegistryHash: REGISTRY,
    baselineFrozen: true,
    baselineDecontaminated: true,
    pinnedSeed: "seed.cadence.1",
  };
}

function greenSlices(): CadenceSliceScore[] {
  return [
    {
      sliceId: "teacher/en/b8",
      championScore: 0.9,
      challengerScore: 0.95,
      tolerance: 0.05,
    },
  ];
}

function greenHandlers(
  overrides: Partial<CadenceStageHandlers> = {},
): CadenceStageHandlers {
  return {
    collect: () => ({
      trajectoryCount: 8,
      consentClass: "research",
    }),
    score: () => ({ criticVersion: "critic.v1", scoredCount: 8 }),
    train: () => ({
      candidateId: "candidate.cadence.green",
      checkpointHash: CHECKPOINT,
    }),
    shadow: () => ({ comparisonOk: true }),
    canary: () => ({ status: "healthy" }),
    ...overrides,
  };
}

test("happy path: known-good candidate promotes through full pipeline", async () => {
  resetCadenceSchedulerReceipts();
  const events = [];
  const report = await runCadenceCycle({
    cycleId: "cycle.green",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers(),
    now: () => "2026-07-17T12:00:00.000Z",
    onTelemetry: (event) => events.push(event),
  });

  assert.equal(report.verdict.verdict, "promote");
  assert.equal(report.verdict.failingSlice, null);
  assert.deepEqual(
    [...report.stagesCompleted],
    ["collect", "score", "train", "shadow", "canary", "gate"],
  );
  assert.equal(report.candidateId, "candidate.cadence.green");
  assert.equal(report.evidenceBundle?.verdict, "promote");
  assert.equal(report.evidenceBundle?.redTeam.verdict, "pass");
  assert.equal(report.evidenceBundle?.lineage.verified, true);
  assert.equal(report.evidenceBundle?.championChallenger.improvedSlices, 1);
  assert.equal(report.idempotent, false);
  assert.ok(events.some((event) => event.action === "cycle_start"));
  assert.ok(events.some((event) => event.action === "cycle_complete"));
  assert.ok(!JSON.stringify(events).includes("utterance"));
});

test("edge: insufficient trajectories emit explicit skip; multi-surgery void", async () => {
  resetCadenceSchedulerReceipts();
  const skip = await runCadenceCycle({
    cycleId: "cycle.skip",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers({
      collect: () => ({ trajectoryCount: 1, consentClass: "research" }),
    }),
    now: () => "2026-07-17T12:01:00.000Z",
  });
  assert.equal(skip.verdict.verdict, "skip");
  assert.equal(skip.verdict.skipReason, "insufficient_trajectories");
  assert.deepEqual([...skip.stagesCompleted], ["collect"]);
  assert.equal(skip.candidateId, null);

  resetCadenceSchedulerReceipts();
  await assert.rejects(
    runCadenceCycle({
      cycleId: "cycle.multi",
      subjectId: SUBJECT_ID,
      deviceId: DEVICE_ID,
      locality: "on-device",
      surgeryKind: "adapter",
      surgeryKinds: ["adapter", "critic"],
      evalPin: evalPin(),
      sliceScores: greenSlices(),
      handlers: greenHandlers(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceSchedulerError);
      assert.equal(error.obligation, "cadence.attribution_void");
      return true;
    },
  );
});

test("edge: regressed slice rejects with named failingSlice; human cannot override", async () => {
  resetCadenceSchedulerReceipts();
  const report = await runCadenceCycle({
    cycleId: "cycle.regress",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "behavioral_flag",
    surgeryKinds: ["behavioral_flag"],
    evalPin: evalPin(),
    sliceScores: [
      {
        sliceId: "teacher/hi/b8",
        championScore: 0.9,
        challengerScore: 0.5,
        tolerance: 0.05,
      },
    ],
    handlers: greenHandlers({
      train: () => ({
        candidateId: "candidate.cadence.regress",
        checkpointHash: CHECKPOINT,
      }),
    }),
    evidence: verdictEvidence({ candidateId: "candidate.cadence.regress" }),
    now: () => "2026-07-17T12:02:00.000Z",
  });
  assert.equal(report.verdict.verdict, "reject");
  assert.equal(report.verdict.failingSlice, "teacher/hi/b8");

  const blocked = assertHumanCannotOverrideFailingVerdict({
    automated: report.verdict,
    humanRequested: "promote",
  });
  assert.equal(blocked.ok, false);

  const deferred = createAutomatedVerdictBundle({
    cycleId: "cycle.defer",
    candidateId: "candidate.cadence.green",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    createdAt: "2026-07-17T12:02:00.000Z",
    ...verdictEvidence(),
    evalPin: evalPin(),
    slices: [{ ...greenSlices()[0]!, status: "pending" }],
    stagesCompleted: ["gate"],
  });
  const blockDeferPromotion = assertHumanCannotOverrideFailingVerdict({
    automated: deferred.cycleVerdict,
    humanRequested: "promote",
  });
  assert.equal(blockDeferPromotion.ok, false);
  assert.equal(deferred.bundle.reason, "evaluation_pending");
});

test("edge: timeout, human-review expiry, train-on-eval void, idempotent replay", async () => {
  resetCadenceSchedulerReceipts();
  await assert.rejects(
    runCadenceCycle({
      cycleId: "cycle.timeout",
      subjectId: SUBJECT_ID,
      deviceId: DEVICE_ID,
      locality: "on-device",
      surgeryKind: "critic",
      surgeryKinds: ["critic"],
      evalPin: evalPin(),
      sliceScores: greenSlices(),
      stageTimeoutMs: 20,
      handlers: greenHandlers({
        score: () => new Promise(() => {}),
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceSchedulerError);
      assert.equal(error.obligation, "cadence.downstream_timeout");
      assert.equal(error.stage, "score");
      return true;
    },
  );

  resetCadenceSchedulerReceipts();
  const expired = await runCadenceCycle({
    cycleId: "cycle.expired",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    humanReviewDeadline: "2026-07-01T00:00:00.000Z",
    now: () => "2026-07-17T12:03:00.000Z",
    handlers: greenHandlers(),
  });
  assert.equal(expired.verdict.verdict, "expired");
  assert.equal(expired.verdict.expiredForHumanReview, true);

  resetCadenceSchedulerReceipts();
  await assert.rejects(
    runCadenceCycle({
      cycleId: "cycle.void",
      subjectId: SUBJECT_ID,
      deviceId: DEVICE_ID,
      locality: "on-device",
      surgeryKind: "adapter",
      surgeryKinds: ["adapter"],
      evalPin: {
        ...evalPin(),
        baselineFrozen: false,
      },
      sliceScores: greenSlices(),
      handlers: greenHandlers(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceSchedulerError);
      assert.equal(error.obligation, "cadence.train_on_eval_void");
      return true;
    },
  );

  resetCadenceSchedulerReceipts();
  const first = await runCadenceCycle({
    cycleId: "cycle.idem",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers(),
    now: () => "2026-07-17T12:04:00.000Z",
  });
  const second = await runCadenceCycle({
    cycleId: "cycle.idem",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers({
      collect: () => {
        throw new Error("must not re-collect on idempotent replay");
      },
    }),
    now: () => "2026-07-17T13:00:00.000Z",
  });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.verdict.completedAt, first.verdict.completedAt);
});

test("sovereignty: concurrent same-subject denied; cross-subject cycles isolated", async () => {
  resetCadenceSchedulerReceipts();
  let releaseCollect: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseCollect = resolve;
  });

  const slow = runCadenceCycle({
    cycleId: "cycle.a",
    subjectId: "subject.cadence.a",
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers({
      collect: async () => {
        await blocked;
        return { trajectoryCount: 8, consentClass: "research" };
      },
    }),
    now: () => "2026-07-17T12:05:00.000Z",
  });

  await assert.rejects(
    runCadenceCycle({
      cycleId: "cycle.a2",
      subjectId: "subject.cadence.a",
      deviceId: DEVICE_ID,
      locality: "on-device",
      surgeryKind: "adapter",
      surgeryKinds: ["adapter"],
      evalPin: evalPin(),
      sliceScores: greenSlices(),
      handlers: greenHandlers(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceSchedulerError);
      assert.equal(error.obligation, "cadence.idempotent_conflict");
      return true;
    },
  );

  const other = await runCadenceCycle({
    cycleId: "cycle.b",
    subjectId: "subject.cadence.b",
    deviceId: DEVICE_ID,
    locality: "self-hosted",
    surgeryKind: "critic",
    surgeryKinds: ["critic"],
    evalPin: evalPin(),
    sliceScores: greenSlices(),
    handlers: greenHandlers({
      train: () => ({
        candidateId: "candidate.cadence.b",
        checkpointHash: CHECKPOINT,
      }),
    }),
    evidence: verdictEvidence({
      subjectId: "subject.cadence.b",
      locality: "self-hosted",
      candidateId: "candidate.cadence.b",
    }),
    now: () => "2026-07-17T12:06:00.000Z",
  });
  assert.equal(other.verdict.verdict, "promote");
  assert.equal(other.subjectId, "subject.cadence.b");

  releaseCollect?.();
  const finished = await slow;
  assert.equal(finished.subjectId, "subject.cadence.a");
  assert.equal(finished.verdict.verdict, "promote");
});

test("evidence bundle derives red-team rejection and tie deferral", () => {
  const events = [];
  const rejected = createAutomatedVerdictBundle({
    cycleId: "cycle.safety-reject",
    candidateId: "candidate.cadence.green",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    createdAt: "2026-07-17T12:07:00.000Z",
    ...verdictEvidence({ redTeamVerdict: "fail" }),
    evalPin: evalPin(),
    slices: greenSlices(),
    stagesCompleted: ["collect", "score", "train", "shadow", "canary", "gate"],
    onTelemetry: (event) => events.push(event),
  });
  assert.equal(rejected.bundle.verdict, "reject");
  assert.equal(rejected.bundle.reason, "red_team_failed");
  assert.equal(rejected.cycleVerdict.verdict, "reject");
  assert.equal(Object.isFrozen(rejected.bundle), true);
  assert.equal(events[0]?.outcome, "reject");

  const tied = createAutomatedVerdictBundle({
    cycleId: "cycle.tie",
    candidateId: "candidate.cadence.green",
    subjectId: SUBJECT_ID,
    deviceId: DEVICE_ID,
    locality: "on-device",
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    createdAt: "2026-07-17T12:08:00.000Z",
    ...verdictEvidence(),
    evalPin: evalPin(),
    slices: [
      {
        sliceId: "teacher/en/b8",
        championScore: 0.9,
        challengerScore: 0.9,
        tolerance: 0.05,
      },
    ],
    stagesCompleted: ["gate"],
  });
  assert.equal(tied.bundle.verdict, "defer");
  assert.equal(tied.bundle.reason, "slice_not_improved");
});

test("evidence bundle rejects cross-subject and raw-content evidence", () => {
  const crossSubject = verdictEvidence();
  crossSubject.lineage.subjectId = "subject.other";
  assert.throws(
    () =>
      createAutomatedVerdictBundle({
        cycleId: "cycle.cross-subject",
        candidateId: "candidate.cadence.green",
        subjectId: SUBJECT_ID,
        deviceId: DEVICE_ID,
        locality: "on-device",
        surgeryKind: "adapter",
        surgeryKinds: ["adapter"],
        createdAt: "2026-07-17T12:09:00.000Z",
        ...crossSubject,
        evalPin: evalPin(),
        slices: greenSlices(),
        stagesCompleted: ["gate"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceVerdictBundleError);
      assert.equal(error.obligation, "cadence.bundle_cross_subject");
      return true;
    },
  );

  const contaminated = verdictEvidence() as CadenceVerdictEvidence & {
    rawContent: string;
  };
  contaminated.rawContent = "must never enter evidence";
  assert.throws(
    () =>
      createAutomatedVerdictBundle({
        cycleId: "cycle.raw-content",
        candidateId: "candidate.cadence.green",
        subjectId: SUBJECT_ID,
        deviceId: DEVICE_ID,
        locality: "on-device",
        surgeryKind: "adapter",
        surgeryKinds: ["adapter"],
        createdAt: "2026-07-17T12:10:00.000Z",
        ...contaminated,
        evalPin: evalPin(),
        slices: greenSlices(),
        stagesCompleted: ["gate"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof CadenceVerdictBundleError);
      assert.equal(error.obligation, "cadence.bundle_sovereignty");
      return true;
    },
  );
});
