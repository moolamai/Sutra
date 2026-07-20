/**
 * Training delivery seam for promotion candidate admission.
 *
 * Keeps delivery orchestration thin: the learning package owns schema,
 * identity, lineage, isolation, eval gates, and idempotency contracts.
 * Callers load the C0 baseline registry and pass a pin into admission.
 */

import {
  PROMOTION_ADMISSION_SCHEMA_VERSION,
  PROMOTION_CANDIDATE_SCHEMA_VERSION,
  PROMOTION_C7_SAFETY_SUITE_ID,
  PROMOTION_SAFETY_VERDICT_MAX_AGE_MS,
  PromotionAdmissionError,
  PromotionCandidateRegistry,
  canonicalPromotionLineagePayload,
  contentAddressPromotionArtifact,
  evaluatePromotionEvalGates,
  evaluatePromotionSafetyGate,
  promotionCandidateSchema,
  signPromotionLineageRef,
  type PromotionAdmissionReason,
  type PromotionAdmissionResult,
  type PromotionBaselineRegistryPin,
  type PromotionCandidateRecord,
  type PromotionEvalGateResult,
  type PromotionRegistryTelemetryEvent,
} from "../../packages/learning/src/promotion_gate.ts";

export const DELIVERY_PROMOTION_REGISTRY_SCHEMA_VERSION =
  "training.delivery.promotion-registry.v1" as const;

export type DeliveryPromotionTelemetryEvent = {
  event: "training.delivery.promotion_admission";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  operationId: string;
  candidateId?: string;
  adapterHash?: string;
  stage?: PromotionCandidateRecord["stage"];
  revision?: number;
  idempotentReplay?: boolean;
  failureClass?: PromotionAdmissionReason;
  failingSlice?: string;
  metricDelta?: number;
  goldenPassRate?: number;
};

/**
 * Subject-scoped delivery facade over admission + golden/slice eval gates.
 * Pass `baselinePin` after loading the frozen C0 baseline registry.
 */
export class DeliveryPromotionRegistry {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly registry: PromotionCandidateRegistry;
  private readonly onTelemetry:
    | ((event: DeliveryPromotionTelemetryEvent) => void)
    | undefined;

  constructor(options: {
    subjectId: string;
    deviceId: string;
    lineageVerificationKey: string;
    /** C0 registry hash + required slice ids from the loaded baseline document. */
    baselinePin?: PromotionBaselineRegistryPin;
    onTelemetry?: (event: DeliveryPromotionTelemetryEvent) => void;
    onRegistryTelemetry?: (event: PromotionRegistryTelemetryEvent) => void;
  }) {
    this.subjectId = options.subjectId;
    this.deviceId = options.deviceId;
    this.onTelemetry = options.onTelemetry;
    this.registry = new PromotionCandidateRegistry({
      subjectId: options.subjectId,
      deviceId: options.deviceId,
      lineageVerificationKey: options.lineageVerificationKey,
      ...(options.baselinePin !== undefined
        ? { baselinePin: options.baselinePin }
        : {}),
      ...(options.onRegistryTelemetry !== undefined
        ? { onTelemetry: options.onRegistryTelemetry }
        : {}),
    });
  }

  get revision(): number {
    return this.registry.revision;
  }

  admit(input: {
    operationId: string;
    candidate: unknown;
    artifactBytes: Uint8Array;
    expectedRevision: number;
    admittedAt?: string;
  }): PromotionAdmissionResult {
    const result = this.registry.admit(input);
    if (result.ok) {
      this.onTelemetry?.({
        event: "training.delivery.promotion_admission",
        outcome: "ok",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        operationId: input.operationId,
        candidateId: result.record.candidate.candidateId,
        adapterHash: result.record.candidate.adapterHash,
        stage: result.record.candidate.stage,
        revision: result.record.revision,
        idempotentReplay: result.record.idempotentReplay,
        goldenPassRate: 1,
      });
    } else {
      this.onTelemetry?.({
        event: "training.delivery.promotion_admission",
        outcome: "fail",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        operationId: input.operationId,
        ...(result.candidateId !== undefined
          ? { candidateId: result.candidateId }
          : {}),
        revision: result.revision,
        failureClass: result.reason,
        ...(result.failingSlice !== undefined
          ? { failingSlice: result.failingSlice }
          : {}),
        ...(result.metricDelta !== undefined
          ? { metricDelta: result.metricDelta }
          : {}),
      });
    }
    return result;
  }

  get(candidateId: string) {
    return this.registry.get({
      subjectId: this.subjectId,
      candidateId,
    });
  }

  list(limit?: number) {
    return this.registry.list({
      subjectId: this.subjectId,
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}

const REFUSAL_INTEGRATION_KEY = "promotion-refusal-integration-key-26";
const REFUSAL_BASELINE_HASH = `sha256:${"b".repeat(64)}`;
const REFUSAL_EVALUATED_AT = "2026-07-17T04:00:02.000Z";
const REFUSAL_SAFETY_COMPLETED_AT = "2026-07-17T03:00:00.000Z";
const REFUSAL_BASELINE_PIN: PromotionBaselineRegistryPin = Object.freeze({
  registryHash: REFUSAL_BASELINE_HASH,
  requiredSliceIds: Object.freeze(["teacher/en/b8", "doctor/en/b8"]),
});

function refusalPassingSafety() {
  return {
    suiteId: PROMOTION_C7_SAFETY_SUITE_ID,
    verdict: "pass" as const,
    completedAt: REFUSAL_SAFETY_COMPLETED_AT,
  };
}

function refusalHash(char: string): `sha256:${string}` {
  return `sha256:${char.repeat(64)}`;
}

function buildRefusalIntegrationCandidate(input: {
  candidateId: string;
  subjectId?: string;
  deviceId?: string;
  artifactBytes?: Uint8Array;
  surgeryClasses?: string[];
  lineageRef?: Record<string, unknown>;
  evalVerdicts?: Record<string, unknown>;
}): { candidate: Record<string, unknown>; artifactBytes: Uint8Array } {
  const subjectId = input.subjectId ?? "subj.promotion.refusal.int";
  const deviceId = input.deviceId ?? "dev.promotion.refusal.int";
  const artifactBytes =
    input.artifactBytes ??
    new TextEncoder().encode("promotion-refusal-integration-adapter-v1");
  const adapterHash = contentAddressPromotionArtifact(artifactBytes);
  const signedAt = "2026-07-17T04:00:00.000Z";
  const lineageBase = {
    runId: "run.promotion.refusal.int",
    checkpointHash: "ckpt:sha256:promotionrefusal01",
    adapterHash,
    corpusManifestHash: refusalHash("c"),
    signedAt,
    signerId: "trainer.signer.refusal.int",
  };
  const lineageRef =
    input.lineageRef ??
    {
      schemaVersion: "checkpoint.lineage.v1",
      ...lineageBase,
      signatureAlgorithm: "hmac-sha256",
      signature: signPromotionLineageRef(lineageBase, REFUSAL_INTEGRATION_KEY),
    };
  const evalVerdicts =
    input.evalVerdicts ??
    {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: REFUSAL_BASELINE_HASH,
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.promotion.refusal.int",
      golden: {
        suiteId: "golden.promotion.refusal.int",
        suiteHash: refusalHash("a"),
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
      safety: refusalPassingSafety(),
    };
  return {
    artifactBytes,
    candidate: {
      schemaVersion: PROMOTION_CANDIDATE_SCHEMA_VERSION,
      candidateId: input.candidateId,
      subjectId,
      deviceId,
      adapterHash,
      baseModelHash: "ckpt:sha256:promotionrefusalbase",
      stage: "fleet",
      locality: "on-device",
      surgeryClasses: input.surgeryClasses ?? ["adapter"],
      lineageRef,
      evalVerdicts,
      createdAt: "2026-07-17T04:00:01.000Z",
    },
  };
}

export type PromotionRegistryRefusalIntegrationProof = {
  ok: true;
  missingGoldenRefused: boolean;
  sliceRegressionRefused: boolean;
  unsignedLineageRefused: boolean;
  twoSurgeryRefused: boolean;
  hashMismatchBeforeEval: boolean;
  provenAdmitted: boolean;
  subjectIsolated: boolean;
  idempotentReplay: boolean;
  failingSliceNamed: string;
  metricDelta: number;
  revisionAfterProven: number;
};

/**
 * Integration harness: named refusal fixtures + proven synthetic admit.
 * Callers assert telemetry separately; this function returns typed outcomes.
 */
export function provePromotionRegistryRefusalIntegration(opts?: {
  onTelemetry?: (event: DeliveryPromotionTelemetryEvent) => void;
  onRegistryTelemetry?: (event: PromotionRegistryTelemetryEvent) => void;
}): PromotionRegistryRefusalIntegrationProof {
  const registry = new DeliveryPromotionRegistry({
    subjectId: "subj.promotion.refusal.int",
    deviceId: "dev.promotion.refusal.int",
    lineageVerificationKey: REFUSAL_INTEGRATION_KEY,
    baselinePin: REFUSAL_BASELINE_PIN,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
    ...(opts?.onRegistryTelemetry !== undefined
      ? { onRegistryTelemetry: opts.onRegistryTelemetry }
      : {}),
  });

  const missingGolden = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.missing-golden",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: REFUSAL_BASELINE_HASH,
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.refusal.missing-golden",
      golden: {
        suiteId: "golden.refusal.missing",
        suiteHash: refusalHash("a"),
        passed: 10,
        total: 12,
        passRate: 10 / 12,
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
      safety: refusalPassingSafety(),
    },
  });
  const missingGoldenResult = registry.admit({
    operationId: "op.refusal.missing-golden",
    candidate: missingGolden.candidate,
    artifactBytes: missingGolden.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const missingGoldenRefused =
    !missingGoldenResult.ok &&
    missingGoldenResult.reason === "promotion.golden_incomplete";

  const sliceRegressed = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.slice-regress",
    evalVerdicts: {
      schemaVersion: "promotion.eval-verdicts.v1",
      baselineRegistryHash: REFUSAL_BASELINE_HASH,
      baselineFrozen: true,
      baselineDecontaminated: true,
      pinnedSeed: "seed.refusal.slice-regress",
      golden: {
        suiteId: "golden.refusal.slice",
        suiteHash: refusalHash("a"),
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
      safety: refusalPassingSafety(),
    },
  });
  const sliceResult = registry.admit({
    operationId: "op.refusal.slice-regress",
    candidate: sliceRegressed.candidate,
    artifactBytes: sliceRegressed.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const sliceRegressionRefused =
    !sliceResult.ok &&
    sliceResult.reason === "promotion.slice_regression" &&
    sliceResult.failingSlice === "teacher/en/b8" &&
    typeof sliceResult.metricDelta === "number" &&
    sliceResult.metricDelta < 0;
  const failingSliceNamed =
    !sliceResult.ok && sliceResult.failingSlice
      ? sliceResult.failingSlice
      : "";
  const metricDelta =
    !sliceResult.ok && typeof sliceResult.metricDelta === "number"
      ? sliceResult.metricDelta
      : 0;

  const unsignedBase = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.unsigned",
  });
  const unsigned = {
    ...unsignedBase.candidate,
    lineageRef: {
      ...(unsignedBase.candidate.lineageRef as Record<string, unknown>),
      signature: "",
    },
  };
  const unsignedResult = registry.admit({
    operationId: "op.refusal.unsigned",
    candidate: unsigned,
    artifactBytes: unsignedBase.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const unsignedLineageRefused =
    !unsignedResult.ok &&
    unsignedResult.reason === "promotion.lineage_unsigned";

  const twoSurgery = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.two-surgery",
    surgeryClasses: ["adapter", "critic"],
  });
  const twoSurgeryResult = registry.admit({
    operationId: "op.refusal.two-surgery",
    candidate: twoSurgery.candidate,
    artifactBytes: twoSurgery.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const twoSurgeryRefused =
    !twoSurgeryResult.ok &&
    twoSurgeryResult.reason === "promotion.attribution_void";

  // Hash mismatch must reject before malformed eval (with raw content) is parsed.
  const hashMismatchBase = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.hash-mismatch",
    evalVerdicts: {
      malformed: "RAW_LEARNER_CONTENT_MUST_NOT_LEAK",
    },
  });
  const hashMismatchResult = registry.admit({
    operationId: "op.refusal.hash-mismatch",
    candidate: hashMismatchBase.candidate,
    artifactBytes: new TextEncoder().encode("different-artifact-bytes"),
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const hashMismatchBeforeEval =
    !hashMismatchResult.ok &&
    hashMismatchResult.reason === "promotion.adapter_hash_mismatch" &&
    registry.revision === 0;

  const cross = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.cross-subject",
    subjectId: "subj.other.refusal",
  });
  const crossResult = registry.admit({
    operationId: "op.refusal.cross-subject",
    candidate: cross.candidate,
    artifactBytes: cross.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  let subjectIsolated =
    !crossResult.ok && crossResult.reason === "promotion.subject_scope";
  try {
    registry.get("candidate.does.not.exist");
    const foreign = new PromotionCandidateRegistry({
      subjectId: "subj.promotion.refusal.int",
      deviceId: "dev.promotion.refusal.int",
      lineageVerificationKey: REFUSAL_INTEGRATION_KEY,
      baselinePin: REFUSAL_BASELINE_PIN,
    });
    foreign.get({
      subjectId: "subj.other.refusal",
      candidateId: "candidate.refusal.proven",
    });
    subjectIsolated = false;
  } catch (error) {
    subjectIsolated =
      subjectIsolated &&
      error instanceof PromotionAdmissionError &&
      error.obligation === "promotion.subject_scope";
  }

  const proven = buildRefusalIntegrationCandidate({
    candidateId: "candidate.refusal.proven",
  });
  const admitted = registry.admit({
    operationId: "op.refusal.proven",
    candidate: proven.candidate,
    artifactBytes: proven.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const provenAdmitted =
    admitted.ok === true &&
    admitted.record.status === "admitted" &&
    admitted.record.revision === 1 &&
    registry.get(proven.candidate.candidateId as string)?.status ===
      "admitted";

  const replay = registry.admit({
    operationId: "op.refusal.proven",
    candidate: proven.candidate,
    artifactBytes: proven.artifactBytes,
    expectedRevision: 0,
    admittedAt: REFUSAL_EVALUATED_AT,
  });
  const idempotentReplay =
    replay.ok === true &&
    replay.record.idempotentReplay === true &&
    replay.record.revision === 1 &&
    registry.revision === 1;

  if (
    !(
      missingGoldenRefused &&
      sliceRegressionRefused &&
      unsignedLineageRefused &&
      twoSurgeryRefused &&
      hashMismatchBeforeEval &&
      provenAdmitted &&
      subjectIsolated &&
      idempotentReplay
    )
  ) {
    throw new Error(
      "promotion registry refusal integration proof incomplete",
    );
  }

  return {
    ok: true,
    missingGoldenRefused,
    sliceRegressionRefused,
    unsignedLineageRefused,
    twoSurgeryRefused,
    hashMismatchBeforeEval,
    provenAdmitted,
    subjectIsolated,
    idempotentReplay,
    failingSliceNamed,
    metricDelta,
    revisionAfterProven: registry.revision,
  };
}

export {
  PROMOTION_ADMISSION_SCHEMA_VERSION,
  PROMOTION_CANDIDATE_SCHEMA_VERSION,
  PROMOTION_C7_SAFETY_SUITE_ID,
  PROMOTION_SAFETY_VERDICT_MAX_AGE_MS,
  PromotionAdmissionError,
  PromotionCandidateRegistry,
  canonicalPromotionLineagePayload,
  contentAddressPromotionArtifact,
  evaluatePromotionEvalGates,
  evaluatePromotionSafetyGate,
  promotionCandidateSchema,
  signPromotionLineageRef,
};

export type {
  PromotionAdmissionReason,
  PromotionAdmissionResult,
  PromotionBaselineRegistryPin,
  PromotionCandidateRecord,
  PromotionEvalGateResult,
  PromotionRegistryTelemetryEvent,
};
