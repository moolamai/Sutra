/**
 * Promotion candidate registry: structural admission + golden/slice eval gates.
 * Run: pnpm --filter @moolam/learning run build && node --experimental-strip-types --test training/delivery/promotion_registry.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_PROMOTION_REGISTRY_SCHEMA_VERSION,
  PROMOTION_ADMISSION_SCHEMA_VERSION,
  PROMOTION_CANDIDATE_SCHEMA_VERSION,
  PROMOTION_C7_SAFETY_SUITE_ID,
  DeliveryPromotionRegistry,
  PromotionAdmissionError,
  PromotionCandidateRegistry,
  contentAddressPromotionArtifact,
  evaluatePromotionEvalGates,
  evaluatePromotionSafetyGate,
  promotionCandidateSchema,
  signPromotionLineageRef,
} from "./promotion_registry.ts";

const BASELINE_PIN = {
  registryHash: `sha256:${"b".repeat(64)}`,
  requiredSliceIds: ["teacher/en/b8", "doctor/en/b8"],
};

const KEY = "promotion-lineage-test-key-2026";
const SECRET = "RAW_LEARNER_CONTENT_MUST_NOT_LEAK";
const EVALUATED_AT = "2026-07-17T00:00:02.000Z";
const SAFETY_COMPLETED_AT = "2026-07-16T12:00:00.000Z";

function hash(char) {
  return `sha256:${char.repeat(64)}`;
}

function passingSafety(overrides = {}) {
  return {
    suiteId: PROMOTION_C7_SAFETY_SUITE_ID,
    verdict: "pass",
    completedAt: SAFETY_COMPLETED_AT,
    ...overrides,
  };
}

function candidateFixture(input = {}) {
  const subjectId = input.subjectId ?? "subj.promotion.ok";
  const deviceId = input.deviceId ?? "dev.promotion.ok";
  const artifactBytes =
    input.artifactBytes ?? Buffer.from("promotion-adapter-fixture");
  const adapterHash =
    input.adapterHash ?? contentAddressPromotionArtifact(artifactBytes);
  const signedAt = "2026-07-17T00:00:00.000Z";
  const lineageBase = {
    runId: "run.promotion.fixture",
    checkpointHash: "ckpt:sha256:promotionfixture01",
    adapterHash,
    corpusManifestHash: hash("c"),
    signedAt,
    signerId: "trainer.signer.fixture",
  };
  const lineageRef = {
    schemaVersion: "checkpoint.lineage.v1",
    ...lineageBase,
    signatureAlgorithm: "hmac-sha256",
    signature: signPromotionLineageRef(lineageBase, KEY),
  };
  const candidate = {
    schemaVersion: PROMOTION_CANDIDATE_SCHEMA_VERSION,
    candidateId: input.candidateId ?? "candidate.promotion.fixture",
    subjectId,
    deviceId,
    adapterHash,
    baseModelHash: "ckpt:sha256:promotionbase001",
    stage: input.stage ?? "fleet",
    locality: input.locality ?? "on-device",
    surgeryClasses: input.surgeryClasses ?? ["adapter"],
    lineageRef: input.lineageRef ?? lineageRef,
    evalVerdicts:
      input.evalVerdicts ??
      {
        schemaVersion: "promotion.eval-verdicts.v1",
        baselineRegistryHash: hash("b"),
        baselineFrozen: true,
        baselineDecontaminated: true,
        pinnedSeed: "seed.promotion.fixture",
        golden: {
          suiteId: "golden.promotion.fixture",
          suiteHash: hash("a"),
          passed: 12,
          total: 12,
          passRate: 1,
          completed: true,
        },
        slices: [
          {
            sliceId: "teacher/en/b8",
            baselineScore: 0.8,
            candidateScore: 0.84,
            tolerance: 0.02,
            verdict: "pass",
          },
          {
            sliceId: "doctor/en/b8",
            baselineScore: 0.75,
            candidateScore: 0.79,
            tolerance: 0.02,
            verdict: "pass",
          },
        ],
        safety: passingSafety(),
      },
    createdAt: "2026-07-17T00:00:01.000Z",
  };
  return { candidate, artifactBytes };
}

test("happy path: schema parses and admission is atomic + idempotent", () => {
  const deliveryEvents = [];
  const registryEvents = [];
  const { candidate, artifactBytes } = candidateFixture();
  const parsed = promotionCandidateSchema.safeParse(candidate);
  assert.equal(parsed.success, true);
  assert.equal(
    DELIVERY_PROMOTION_REGISTRY_SCHEMA_VERSION,
    "training.delivery.promotion-registry.v1",
  );

  const registry = new DeliveryPromotionRegistry({
    subjectId: candidate.subjectId,
    deviceId: candidate.deviceId,
    lineageVerificationKey: KEY,
    baselinePin: BASELINE_PIN,
    onTelemetry: (event) => deliveryEvents.push(event),
    onRegistryTelemetry: (event) => registryEvents.push(event),
  });
  const admitted = registry.admit({
    operationId: "op.promotion.admit.1",
    candidate,
    artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(
    admitted.record.schemaVersion,
    PROMOTION_ADMISSION_SCHEMA_VERSION,
  );
  assert.equal(admitted.record.status, "admitted");
  assert.equal(admitted.record.revision, 1);
  assert.equal(admitted.record.candidate.adapterHash, candidate.adapterHash);
  assert.equal(registry.revision, 1);
  assert.equal(registry.get(candidate.candidateId)?.status, "admitted");
  assert.equal(registry.list(1).length, 1);

  const replay = registry.admit({
    operationId: "op.promotion.admit.1",
    candidate,
    artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.record.idempotentReplay, true);
    assert.equal(replay.record.revision, 1);
  }
  assert.equal(registry.revision, 1);
  assert.ok(
    deliveryEvents.some(
      (event) =>
        event.event === "training.delivery.promotion_admission" &&
        event.outcome === "ok" &&
        event.adapterHash === candidate.adapterHash &&
        event.goldenPassRate === 1,
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.event === "learning.promotion_registry.safety_gate" &&
        event.outcome === "ok" &&
        event.safetyVerdict === "pass",
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.event === "learning.promotion_registry.golden_gate" &&
        event.outcome === "ok" &&
        event.goldenPassRate === 1,
    ),
  );
  assert.ok(
    registryEvents.some(
      (event) =>
        event.event === "learning.promotion_registry.admit" &&
        event.outcome === "ok",
    ),
  );
  assert.ok(
    !JSON.stringify([...deliveryEvents, ...registryEvents]).includes(SECRET),
  );
  assert.ok(
    [...deliveryEvents, ...registryEvents].every(
      (event) =>
        !("content" in event) &&
        !("utterance" in event) &&
        !("blob" in event) &&
        !("artifactBytes" in event),
    ),
  );
});

test("edge: artifact hash mismatch rejects before malformed eval attachment", () => {
  const { candidate } = candidateFixture({
    evalVerdicts: { malformed: SECRET },
  });
  const registry = new DeliveryPromotionRegistry({
    subjectId: candidate.subjectId,
    deviceId: candidate.deviceId,
    lineageVerificationKey: KEY,
  });
  const refused = registry.admit({
    operationId: "op.promotion.hash-mismatch",
    candidate,
    artifactBytes: Buffer.from("different-artifact-bytes"),
    expectedRevision: 0,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "promotion.adapter_hash_mismatch");
    assert.equal(refused.revision, 0);
  }
  assert.equal(registry.revision, 0);
  assert.equal(registry.list().length, 0);
});

test("edge: unsigned lineage, multi-surgery, and incomplete eval reject typed", () => {
  const base = candidateFixture();
  const registry = new DeliveryPromotionRegistry({
    subjectId: base.candidate.subjectId,
    deviceId: base.candidate.deviceId,
    lineageVerificationKey: KEY,
  });

  const unsigned = {
    ...base.candidate,
    candidateId: "candidate.promotion.unsigned",
    lineageRef: {
      ...base.candidate.lineageRef,
      signature: "",
    },
  };
  const unsignedResult = registry.admit({
    operationId: "op.promotion.unsigned",
    candidate: unsigned,
    artifactBytes: base.artifactBytes,
    expectedRevision: 0,
  });
  assert.equal(unsignedResult.ok, false);
  if (!unsignedResult.ok) {
    assert.equal(unsignedResult.reason, "promotion.lineage_unsigned");
  }

  const multi = candidateFixture({
    candidateId: "candidate.promotion.multi",
    surgeryClasses: ["adapter", "critic"],
  });
  const multiResult = registry.admit({
    operationId: "op.promotion.multi",
    candidate: multi.candidate,
    artifactBytes: multi.artifactBytes,
    expectedRevision: 0,
  });
  assert.equal(multiResult.ok, false);
  if (!multiResult.ok) {
    assert.equal(multiResult.reason, "promotion.attribution_void");
    assert.equal(multiResult.failingSlice, "adapter+critic");
  }

  const incomplete = candidateFixture({
    candidateId: "candidate.promotion.incomplete",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.incomplete",
      golden: {
        suiteId: "golden.incomplete",
        suiteHash: hash("a"),
        passed: 1,
        total: 1,
        passRate: 1,
        completed: true,
      },
      slices: [],
      safety: passingSafety(),
    },
  });
  const incompleteResult = registry.admit({
    operationId: "op.promotion.incomplete",
    candidate: incomplete.candidate,
    artifactBytes: incomplete.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(incompleteResult.ok, false);
  if (!incompleteResult.ok) {
    assert.equal(
      incompleteResult.reason,
      "promotion.eval_attachment_incomplete",
    );
    assert.match(incompleteResult.failingSlice ?? "", /evalVerdicts/);
  }
});

test("edge: subject isolation and optimistic revision reject without writes", () => {
  const fixture = candidateFixture();
  const registry = new DeliveryPromotionRegistry({
    subjectId: fixture.candidate.subjectId,
    deviceId: fixture.candidate.deviceId,
    lineageVerificationKey: KEY,
  });
  const cross = candidateFixture({
    candidateId: "candidate.promotion.cross",
    subjectId: "subj.other",
  });
  const crossResult = registry.admit({
    operationId: "op.promotion.cross",
    candidate: cross.candidate,
    artifactBytes: cross.artifactBytes,
    expectedRevision: 0,
  });
  assert.equal(crossResult.ok, false);
  if (!crossResult.ok) {
    assert.equal(crossResult.reason, "promotion.subject_scope");
  }

  const stale = registry.admit({
    operationId: "op.promotion.stale",
    candidate: fixture.candidate,
    artifactBytes: fixture.artifactBytes,
    expectedRevision: 1,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.reason, "promotion.stale_revision");
  }
  assert.equal(registry.revision, 0);

  const direct = new PromotionCandidateRegistry({
    subjectId: fixture.candidate.subjectId,
    deviceId: fixture.candidate.deviceId,
    lineageVerificationKey: KEY,
  });
  assert.throws(
    () =>
      direct.get({
        subjectId: "subj.other",
        candidateId: fixture.candidate.candidateId,
      }),
    (error) =>
      error instanceof PromotionAdmissionError &&
      error.obligation === "promotion.subject_scope",
  );
});

test("edge: partial golden suite rejects; aggregate-up slice-down names failing slice", () => {
  const events = [];
  const registry = new DeliveryPromotionRegistry({
    subjectId: "subj.promotion.ok",
    deviceId: "dev.promotion.ok",
    lineageVerificationKey: KEY,
    baselinePin: BASELINE_PIN,
    onRegistryTelemetry: (event) => events.push(event),
  });

  const partialGolden = candidateFixture({
    candidateId: "candidate.promotion.partial-golden",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.partial.golden",
      golden: {
        suiteId: "golden.partial",
        suiteHash: hash("a"),
        passed: 11,
        total: 12,
        passRate: 11 / 12,
        completed: true,
      },
      slices: [
        {
          sliceId: "teacher/en/b8",
          baselineScore: 0.8,
          candidateScore: 0.84,
          tolerance: 0.02,
          verdict: "pass",
        },
        {
          sliceId: "doctor/en/b8",
          baselineScore: 0.75,
          candidateScore: 0.79,
          tolerance: 0.02,
          verdict: "pass",
        },
      ],
      safety: passingSafety(),
    },
  });
  const partialResult = registry.admit({
    operationId: "op.promotion.partial-golden",
    candidate: partialGolden.candidate,
    artifactBytes: partialGolden.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(partialResult.ok, false);
  if (!partialResult.ok) {
    assert.equal(partialResult.reason, "promotion.golden_incomplete");
    assert.equal(partialResult.failingSlice, "golden.partial");
  }
  assert.equal(registry.revision, 0);

  // Doctor improves enough that the mean rises; teacher alone regresses → reject.
  const sliceRegressed = candidateFixture({
    candidateId: "candidate.promotion.slice-regress",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.slice.regress",
      golden: {
        suiteId: "golden.slice.regress",
        suiteHash: hash("a"),
        passed: 12,
        total: 12,
        passRate: 1,
        completed: true,
      },
      slices: [
        {
          sliceId: "teacher/en/b8",
          baselineScore: 0.8,
          candidateScore: 0.7,
          tolerance: 0.02,
          verdict: "fail",
        },
        {
          sliceId: "doctor/en/b8",
          baselineScore: 0.75,
          candidateScore: 0.95,
          tolerance: 0.02,
          verdict: "pass",
        },
      ],
      safety: passingSafety(),
    },
  });
  const candidateMean = (0.7 + 0.95) / 2;
  const baselineMean = (0.8 + 0.75) / 2;
  assert.ok(candidateMean > baselineMean, "aggregate improves by construction");

  const regressResult = registry.admit({
    operationId: "op.promotion.slice-regress",
    candidate: sliceRegressed.candidate,
    artifactBytes: sliceRegressed.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(regressResult.ok, false);
  if (!regressResult.ok) {
    assert.equal(regressResult.reason, "promotion.slice_regression");
    assert.equal(regressResult.failingSlice, "teacher/en/b8");
    assert.ok(typeof regressResult.metricDelta === "number");
    assert.ok(regressResult.metricDelta < 0);
    assert.match(regressResult.detail, /teacher\/en\/b8/);
  }
  assert.equal(registry.revision, 0);
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.promotion_registry.slice_gate" &&
        event.outcome === "fail" &&
        event.failingSlice === "teacher/en/b8" &&
        event.failureClass === "promotion.slice_regression",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));

  const gateOnly = evaluatePromotionEvalGates({
    evalVerdicts: sliceRegressed.candidate.evalVerdicts,
    baselinePin: BASELINE_PIN,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(gateOnly.ok, false);
  if (!gateOnly.ok) {
    assert.equal(gateOnly.reason, "promotion.slice_regression");
    assert.equal(gateOnly.failingSlice, "teacher/en/b8");
  }
});

test("edge: missing or stale C7 safety verdict refuses before golden scoring", () => {
  const events = [];
  const registry = new DeliveryPromotionRegistry({
    subjectId: "subj.promotion.ok",
    deviceId: "dev.promotion.ok",
    lineageVerificationKey: KEY,
    baselinePin: BASELINE_PIN,
    onRegistryTelemetry: (event) => events.push(event),
  });

  const missingSafety = candidateFixture({
    candidateId: "candidate.promotion.safety-missing",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.safety.missing",
      golden: {
        suiteId: "golden.safety.missing",
        suiteHash: hash("a"),
        passed: 12,
        total: 12,
        passRate: 1,
        completed: true,
      },
      slices: [
        {
          sliceId: "teacher/en/b8",
          baselineScore: 0.8,
          candidateScore: 0.84,
          tolerance: 0.02,
          verdict: "pass",
        },
        {
          sliceId: "doctor/en/b8",
          baselineScore: 0.75,
          candidateScore: 0.79,
          tolerance: 0.02,
          verdict: "pass",
        },
      ],
    },
  });
  const missingResult = registry.admit({
    operationId: "op.promotion.safety-missing",
    candidate: missingSafety.candidate,
    artifactBytes: missingSafety.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) {
    assert.equal(missingResult.reason, "promotion.safety_missing");
    assert.equal(missingResult.failingSlice, PROMOTION_C7_SAFETY_SUITE_ID);
  }

  const staleSafety = candidateFixture({
    candidateId: "candidate.promotion.safety-stale",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.safety.stale",
      golden: {
        suiteId: "golden.safety.stale",
        suiteHash: hash("a"),
        passed: 12,
        total: 12,
        passRate: 1,
        completed: true,
      },
      slices: [
        {
          sliceId: "teacher/en/b8",
          baselineScore: 0.8,
          candidateScore: 0.84,
          tolerance: 0.02,
          verdict: "pass",
        },
        {
          sliceId: "doctor/en/b8",
          baselineScore: 0.75,
          candidateScore: 0.79,
          tolerance: 0.02,
          verdict: "pass",
        },
      ],
      safety: passingSafety({
        completedAt: "2026-07-01T00:00:00.000Z",
      }),
    },
  });
  const staleResult = registry.admit({
    operationId: "op.promotion.safety-stale",
    candidate: staleSafety.candidate,
    artifactBytes: staleSafety.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) {
    assert.equal(staleResult.reason, "promotion.safety_stale");
    assert.equal(staleResult.failingSlice, PROMOTION_C7_SAFETY_SUITE_ID);
  }

  const failedSafety = candidateFixture({
    candidateId: "candidate.promotion.safety-failed",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: hash("b"),
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.safety.failed",
      golden: {
        suiteId: "golden.safety.failed",
        suiteHash: hash("a"),
        passed: 12,
        total: 12,
        passRate: 1,
        completed: true,
      },
      slices: [
        {
          sliceId: "teacher/en/b8",
          baselineScore: 0.8,
          candidateScore: 0.84,
          tolerance: 0.02,
          verdict: "pass",
        },
        {
          sliceId: "doctor/en/b8",
          baselineScore: 0.75,
          candidateScore: 0.79,
          tolerance: 0.02,
          verdict: "pass",
        },
      ],
      safety: passingSafety({ verdict: "fail" }),
    },
  });
  const failedResult = registry.admit({
    operationId: "op.promotion.safety-failed",
    candidate: failedSafety.candidate,
    artifactBytes: failedSafety.artifactBytes,
    expectedRevision: 0,
    admittedAt: EVALUATED_AT,
  });
  assert.equal(failedResult.ok, false);
  if (!failedResult.ok) {
    assert.equal(failedResult.reason, "promotion.safety_failed");
  }
  assert.equal(registry.revision, 0);

  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.promotion_registry.safety_gate" &&
        event.outcome === "fail" &&
        event.failureClass === "promotion.safety_missing",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.event === "learning.promotion_registry.safety_gate" &&
        event.outcome === "fail" &&
        event.failureClass === "promotion.safety_stale",
    ),
  );
  assert.ok(
    !events.some(
      (event) =>
        event.event === "learning.promotion_registry.golden_gate" &&
        event.candidateId === "candidate.promotion.safety-missing",
    ),
  );

  const direct = evaluatePromotionSafetyGate({
    evalVerdicts: missingSafety.candidate.evalVerdicts,
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(direct.ok, false);
  if (!direct.ok) {
    assert.equal(direct.reason, "promotion.safety_missing");
  }
  assert.ok(!JSON.stringify(events).includes(SECRET));
});
