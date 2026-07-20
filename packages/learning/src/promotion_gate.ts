/**
 * Promotion candidate registry schema, structural admission, and eval gates.
 *
 * Admission proves artifact identity, signed C4 lineage, frozen eval evidence,
 * one-surgery attribution, locality, and subject scope — then enforces the C7
 * safety-suite precondition, 100% golden-suite pass, and independent per-slice
 * baseline non-regression.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PROMOTION_CANDIDATE_SCHEMA_VERSION =
  "promotion.candidate.v1" as const;
export const PROMOTION_ADMISSION_SCHEMA_VERSION =
  "promotion.admission.v1" as const;
export const PROMOTION_REGISTRY_ENTRY_LIMIT = 64;
export const PROMOTION_EVAL_SLICE_LIMIT = 64;
export const PROMOTION_OPERATION_LIMIT = 128;
/** C7 candidate-red-team suite id expected on every promotion attachment. */
export const PROMOTION_C7_SAFETY_SUITE_ID = "c7.candidate-red-team" as const;
/** Safety verdict older than this relative to evaluation time is stale. */
export const PROMOTION_SAFETY_VERDICT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type PromotionStage =
  | "candidate"
  | "shadow"
  | "canary"
  | "fleet";

export type PromotionAdmissionReason =
  | "promotion.schema_invalid"
  | "promotion.subject_scope"
  | "promotion.locality_forbidden"
  | "promotion.adapter_hash_mismatch"
  | "promotion.lineage_unsigned"
  | "promotion.lineage_signature_invalid"
  | "promotion.lineage_adapter_mismatch"
  | "promotion.eval_attachment_incomplete"
  | "promotion.baseline_unfrozen"
  | "promotion.baseline_contaminated"
  | "promotion.baseline_registry_mismatch"
  | "promotion.golden_incomplete"
  | "promotion.slice_regression"
  | "promotion.safety_missing"
  | "promotion.safety_incomplete"
  | "promotion.safety_failed"
  | "promotion.safety_stale"
  | "promotion.train_on_eval_void"
  | "promotion.attribution_void"
  | "promotion.stale_revision"
  | "promotion.idempotent_conflict"
  | "promotion.capacity";

export type PromotionRegistryTelemetryEvent = {
  event:
    | "learning.promotion_registry.validate"
    | "learning.promotion_registry.admit"
    | "learning.promotion_registry.reject"
    | "learning.promotion_registry.safety_gate"
    | "learning.promotion_registry.golden_gate"
    | "learning.promotion_registry.slice_gate";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  candidateId?: string;
  operationId?: string;
  adapterHash?: string;
  stage?: PromotionStage;
  revision?: number;
  idempotentReplay?: boolean;
  failureClass?: PromotionAdmissionReason;
  failingSlice?: string;
  metricDelta?: number;
  goldenPassRate?: number;
  safetyVerdict?: "pass" | "fail" | "pending";
};

export class PromotionAdmissionError extends Error {
  readonly obligation: PromotionAdmissionReason;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: PromotionAdmissionReason;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "PromotionAdmissionError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

const idSchema = z.string().regex(ID_RE);
const hashSchema = z.string().regex(HASH_RE);

const lineageRefSchema = z
  .object({
    schemaVersion: z.literal("checkpoint.lineage.v1"),
    runId: idSchema,
    checkpointHash: idSchema,
    adapterHash: hashSchema,
    corpusManifestHash: hashSchema,
    signedAt: z.string().datetime(),
    signerId: idSchema,
    signatureAlgorithm: z.literal("hmac-sha256"),
    signature: z.string().regex(SIGNATURE_RE),
  })
  .strict();

const goldenVerdictSchema = z
  .object({
    suiteId: idSchema,
    suiteHash: hashSchema,
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    passRate: z.number().min(0).max(1),
    completed: z.boolean(),
  })
  .strict();

const sliceVerdictSchema = z
  .object({
    sliceId: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) =>
          value.split("/").length === 3 &&
          !value.includes("..") &&
          !value.includes("\\"),
      ),
    baselineScore: z.number().min(0).max(1),
    candidateScore: z.number().min(0).max(1),
    tolerance: z.number().min(0).max(1),
    verdict: z.enum(["pass", "fail", "pending"]),
  })
  .strict();

const evalVerdictsSchema = z
  .object({
    schemaVersion: z.literal("promotion.eval-verdicts.v1"),
    baselineRegistryHash: hashSchema,
    baselineFrozen: z.boolean(),
    baselineDecontaminated: z.boolean(),
    pinnedSeed: idSchema,
    golden: goldenVerdictSchema,
    slices: z
      .array(sliceVerdictSchema)
      .min(1)
      .max(PROMOTION_EVAL_SLICE_LIMIT),
    /**
     * C7 candidate-red-team pre-gate verdict. Optional at parse so missing
     * attachments fail with a distinct safety_missing signal (not schema noise).
     */
    safety: z
      .object({
        suiteId: idSchema,
        verdict: z.enum(["pass", "fail", "pending"]),
        completedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const promotionCandidateSchema = z
  .object({
    schemaVersion: z.literal(PROMOTION_CANDIDATE_SCHEMA_VERSION),
    candidateId: idSchema,
    subjectId: idSchema,
    deviceId: idSchema,
    adapterHash: hashSchema,
    baseModelHash: idSchema,
    stage: z.enum(["candidate", "shadow", "canary", "fleet"]),
    locality: z.enum(["on-device", "self-hosted"]),
    surgeryClasses: z.array(idSchema).min(1).max(2),
    lineageRef: lineageRefSchema,
    evalVerdicts: evalVerdictsSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export type PromotionCandidateRecord = z.infer<
  typeof promotionCandidateSchema
>;

export type PromotionEvalVerdicts = PromotionCandidateRecord["evalVerdicts"];

export type PromotionAdmissionRecord = {
  schemaVersion: typeof PROMOTION_ADMISSION_SCHEMA_VERSION;
  candidate: PromotionCandidateRecord;
  status: "admitted";
  admittedAt: string;
  operationId: string;
  revision: number;
  idempotentReplay: boolean;
};

export type PromotionAdmissionResult =
  | { ok: true; record: PromotionAdmissionRecord }
  | {
      ok: false;
      reason: PromotionAdmissionReason;
      candidateId?: string;
      failingSlice?: string;
      /** candidateScore - floor (negative when below threshold). */
      metricDelta?: number;
      detail: string;
      revision: number;
    };

/**
 * C0 baseline registry pin for admission. Gates refuse when the attached
 * eval hash diverges or required slices are missing.
 */
export type PromotionBaselineRegistryPin = {
  registryHash: string;
  requiredSliceIds: ReadonlyArray<string>;
};

export type PromotionEvalGateResult =
  | {
      ok: true;
      goldenPassRate: 1;
      sliceCount: number;
    }
  | {
      ok: false;
      reason: PromotionAdmissionReason;
      failingSlice?: string;
      metricDelta?: number;
      detail: string;
      goldenPassRate?: number;
    };

type SubjectRegistry = {
  revision: number;
  byCandidateId: Map<string, PromotionAdmissionRecord>;
  byOperationId: Map<string, PromotionAdmissionResult>;
};

/**
 * Canonical signed fields. Eval verdicts are attached evidence but are not
 * part of C4 lineage identity; adapterHash binds lineage to artifact bytes.
 */
export function canonicalPromotionLineagePayload(input: {
  runId: string;
  checkpointHash: string;
  adapterHash: string;
  corpusManifestHash: string;
  signedAt: string;
  signerId: string;
}): string {
  return JSON.stringify({
    runId: input.runId,
    checkpointHash: input.checkpointHash,
    adapterHash: input.adapterHash,
    corpusManifestHash: input.corpusManifestHash,
    signedAt: input.signedAt,
    signerId: input.signerId,
  });
}

export function signPromotionLineageRef(
  input: {
    runId: string;
    checkpointHash: string;
    adapterHash: string;
    corpusManifestHash: string;
    signedAt: string;
    signerId: string;
  },
  verificationKey: string,
): `hmac-sha256:${string}` {
  const key = requireVerificationKey(verificationKey);
  return `hmac-sha256:${createHmac("sha256", key)
    .update(canonicalPromotionLineagePayload(input), "utf8")
    .digest("hex")}`;
}

export function contentAddressPromotionArtifact(
  artifactBytes: Uint8Array,
): `sha256:${string}` {
  if (artifactBytes.byteLength === 0) {
    throw new PromotionAdmissionError("adapter artifact must not be empty", {
      obligation: "promotion.adapter_hash_mismatch",
    });
  }
  return `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
}

/**
 * C7 safety-suite precondition. Red-team pass must be attached, green, and
 * fresh — missing/stale/failed verdicts refuse before golden/slice scoring.
 */
export function evaluatePromotionSafetyGate(input: {
  evalVerdicts: PromotionEvalVerdicts;
  evaluatedAt?: string;
  maxAgeMs?: number;
  requiredSuiteId?: string;
  subjectId?: string;
  deviceId?: string;
  candidateId?: string;
  onTelemetry?: (event: PromotionRegistryTelemetryEvent) => void;
}): PromotionEvalGateResult {
  const subjectId = input.subjectId ?? "(gate)";
  const deviceId = input.deviceId ?? "(gate)";
  const requiredSuiteId =
    input.requiredSuiteId ?? PROMOTION_C7_SAFETY_SUITE_ID;
  const maxAgeMs = input.maxAgeMs ?? PROMOTION_SAFETY_VERDICT_MAX_AGE_MS;
  const evaluatedAtMs = Date.parse(
    input.evaluatedAt ?? new Date().toISOString(),
  );
  const safety = input.evalVerdicts.safety;

  if (!safety) {
    input.onTelemetry?.({
      event: "learning.promotion_registry.safety_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failureClass: "promotion.safety_missing",
      failingSlice: requiredSuiteId,
    });
    return {
      ok: false,
      reason: "promotion.safety_missing",
      failingSlice: requiredSuiteId,
      detail: "C7 candidate-red-team safety verdict missing from eval attachment",
    };
  }

  if (safety.suiteId !== requiredSuiteId) {
    input.onTelemetry?.({
      event: "learning.promotion_registry.safety_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failureClass: "promotion.safety_missing",
      failingSlice: safety.suiteId,
      safetyVerdict: safety.verdict,
    });
    return {
      ok: false,
      reason: "promotion.safety_missing",
      failingSlice: safety.suiteId,
      detail:
        `safety suiteId ${safety.suiteId} is not the required C7 suite ` +
        requiredSuiteId,
    };
  }

  if (safety.verdict === "pending") {
    input.onTelemetry?.({
      event: "learning.promotion_registry.safety_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failureClass: "promotion.safety_incomplete",
      failingSlice: safety.suiteId,
      safetyVerdict: "pending",
    });
    return {
      ok: false,
      reason: "promotion.safety_incomplete",
      failingSlice: safety.suiteId,
      detail: "C7 safety verdict still pending — pre-gate red-team incomplete",
    };
  }

  if (safety.verdict === "fail") {
    input.onTelemetry?.({
      event: "learning.promotion_registry.safety_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failureClass: "promotion.safety_failed",
      failingSlice: safety.suiteId,
      safetyVerdict: "fail",
    });
    return {
      ok: false,
      reason: "promotion.safety_failed",
      failingSlice: safety.suiteId,
      detail: "C7 candidate-red-team safety suite failed",
    };
  }

  const completedAtMs = Date.parse(safety.completedAt);
  if (
    !Number.isFinite(evaluatedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs > evaluatedAtMs ||
    evaluatedAtMs - completedAtMs > maxAgeMs
  ) {
    input.onTelemetry?.({
      event: "learning.promotion_registry.safety_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failureClass: "promotion.safety_stale",
      failingSlice: safety.suiteId,
      safetyVerdict: safety.verdict,
    });
    return {
      ok: false,
      reason: "promotion.safety_stale",
      failingSlice: safety.suiteId,
      detail:
        `C7 safety verdict stale or not-yet-valid at evaluation time ` +
        `(completedAt=${safety.completedAt})`,
    };
  }

  input.onTelemetry?.({
    event: "learning.promotion_registry.safety_gate",
    outcome: "ok",
    subjectId,
    deviceId,
    ...(input.candidateId !== undefined
      ? { candidateId: input.candidateId }
      : {}),
    failingSlice: safety.suiteId,
    safetyVerdict: "pass",
  });
  return {
    ok: true,
    goldenPassRate: 1,
    sliceCount: 0,
  };
}

/**
 * C7 safety precondition + golden-suite + independent per-slice baseline gate.
 * Aggregate improvement never overrides a single-slice regression.
 */
export function evaluatePromotionEvalGates(input: {
  evalVerdicts: PromotionEvalVerdicts;
  baselinePin?: PromotionBaselineRegistryPin;
  evaluatedAt?: string;
  safetyMaxAgeMs?: number;
  requiredSafetySuiteId?: string;
  subjectId?: string;
  deviceId?: string;
  candidateId?: string;
  onTelemetry?: (event: PromotionRegistryTelemetryEvent) => void;
}): PromotionEvalGateResult {
  const evals = input.evalVerdicts;
  const subjectId = input.subjectId ?? "(gate)";
  const deviceId = input.deviceId ?? "(gate)";

  const safety = evaluatePromotionSafetyGate({
    evalVerdicts: evals,
    ...(input.evaluatedAt !== undefined
      ? { evaluatedAt: input.evaluatedAt }
      : {}),
    ...(input.safetyMaxAgeMs !== undefined
      ? { maxAgeMs: input.safetyMaxAgeMs }
      : {}),
    ...(input.requiredSafetySuiteId !== undefined
      ? { requiredSuiteId: input.requiredSafetySuiteId }
      : {}),
    subjectId,
    deviceId,
    ...(input.candidateId !== undefined
      ? { candidateId: input.candidateId }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!safety.ok) return safety;

  if (!evals.baselineFrozen) {
    return {
      ok: false,
      reason: "promotion.baseline_unfrozen",
      detail: "eval gates require frozen C0 baselines",
    };
  }
  if (!evals.baselineDecontaminated) {
    return {
      ok: false,
      reason: "promotion.baseline_contaminated",
      detail: "eval gates require decontaminated C0 baselines",
    };
  }
  if (!evals.pinnedSeed?.trim()) {
    return {
      ok: false,
      reason: "promotion.train_on_eval_void",
      detail: "pinned seed required — train-on-eval gates are void",
    };
  }

  if (input.baselinePin !== undefined) {
    if (evals.baselineRegistryHash !== input.baselinePin.registryHash) {
      return {
        ok: false,
        reason: "promotion.baseline_registry_mismatch",
        detail: "eval attachment baselineRegistryHash diverges from C0 pin",
      };
    }
    if (
      input.baselinePin.requiredSliceIds.length === 0 ||
      input.baselinePin.requiredSliceIds.length > PROMOTION_EVAL_SLICE_LIMIT
    ) {
      return {
        ok: false,
        reason: "promotion.eval_attachment_incomplete",
        detail: "C0 baseline pin requiredSliceIds out of bounds",
      };
    }
  }

  const golden = evals.golden;
  const goldenOk =
    golden.completed === true &&
    golden.passRate === 1 &&
    golden.passed === golden.total &&
    golden.total > 0 &&
    golden.passed > 0;
  input.onTelemetry?.({
    event: "learning.promotion_registry.golden_gate",
    outcome: goldenOk ? "ok" : "fail",
    subjectId,
    deviceId,
    ...(input.candidateId !== undefined
      ? { candidateId: input.candidateId }
      : {}),
    goldenPassRate: golden.passRate,
    ...(goldenOk
      ? {}
      : { failureClass: "promotion.golden_incomplete" as const }),
  });
  if (!goldenOk) {
    return {
      ok: false,
      reason: "promotion.golden_incomplete",
      detail:
        `golden suite incomplete: passed=${golden.passed}/${golden.total} ` +
        `passRate=${golden.passRate}`,
      goldenPassRate: golden.passRate,
      failingSlice: golden.suiteId,
    };
  }

  const bySlice = new Map(evals.slices.map((s) => [s.sliceId, s]));
  const required =
    input.baselinePin?.requiredSliceIds ??
    evals.slices.map((s) => s.sliceId);

  for (const sliceId of required) {
    const row = bySlice.get(sliceId);
    if (!row) {
      input.onTelemetry?.({
        event: "learning.promotion_registry.slice_gate",
        outcome: "fail",
        subjectId,
        deviceId,
        ...(input.candidateId !== undefined
          ? { candidateId: input.candidateId }
          : {}),
        failingSlice: sliceId,
        failureClass: "promotion.eval_attachment_incomplete",
      });
      return {
        ok: false,
        reason: "promotion.eval_attachment_incomplete",
        failingSlice: sliceId,
        detail: `missing independent slice score for ${sliceId}`,
      };
    }

    const floor = row.baselineScore - row.tolerance;
    const metricDelta = row.candidateScore - floor;
    const sliceOk =
      row.verdict === "pass" &&
      row.candidateScore + Number.EPSILON >= floor;

    input.onTelemetry?.({
      event: "learning.promotion_registry.slice_gate",
      outcome: sliceOk ? "ok" : "fail",
      subjectId,
      deviceId,
      ...(input.candidateId !== undefined
        ? { candidateId: input.candidateId }
        : {}),
      failingSlice: sliceId,
      metricDelta,
      ...(sliceOk
        ? {}
        : { failureClass: "promotion.slice_regression" as const }),
    });

    if (!sliceOk) {
      return {
        ok: false,
        reason: "promotion.slice_regression",
        failingSlice: sliceId,
        metricDelta,
        detail:
          `slice regression on ${sliceId}: candidate=${row.candidateScore} ` +
          `floor=${floor} delta=${metricDelta}`,
        goldenPassRate: 1,
      };
    }
  }

  return {
    ok: true,
    goldenPassRate: 1,
    sliceCount: required.length,
  };
}

/**
 * Bounded subject-scoped promotion registry with optimistic revision and
 * idempotent operation replay.
 */
export class PromotionCandidateRegistry {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly verificationKey: string;
  private readonly baselinePin: PromotionBaselineRegistryPin | undefined;
  private readonly onTelemetry:
    | ((event: PromotionRegistryTelemetryEvent) => void)
    | undefined;
  private readonly slot: SubjectRegistry = {
    revision: 0,
    byCandidateId: new Map(),
    byOperationId: new Map(),
  };

  constructor(options: {
    subjectId: string;
    deviceId: string;
    lineageVerificationKey: string;
    /** Optional C0 registry pin loaded by the delivery seam. */
    baselinePin?: PromotionBaselineRegistryPin;
    onTelemetry?: (event: PromotionRegistryTelemetryEvent) => void;
  }) {
    this.subjectId = requireId(options.subjectId, "subjectId");
    this.deviceId = requireId(options.deviceId, "deviceId");
    this.verificationKey = requireVerificationKey(
      options.lineageVerificationKey,
    );
    this.baselinePin = options.baselinePin
      ? Object.freeze({
          registryHash: requireHash(
            options.baselinePin.registryHash,
            "registryHash",
          ),
          requiredSliceIds: Object.freeze([
            ...options.baselinePin.requiredSliceIds.map((id) =>
              requireSliceId(id),
            ),
          ]),
        })
      : undefined;
    this.onTelemetry = options.onTelemetry;
  }

  get revision(): number {
    return this.slot.revision;
  }

  admit(input: {
    operationId: string;
    candidate: unknown;
    artifactBytes: Uint8Array;
    expectedRevision: number;
    admittedAt?: string;
  }): PromotionAdmissionResult {
    const operationId = requireId(input.operationId, "operationId");
    const replay = this.slot.byOperationId.get(operationId);
    if (replay) {
      if (
        replay.ok &&
        candidateIdFromUnknown(input.candidate) !==
          replay.record.candidate.candidateId
      ) {
        throw new PromotionAdmissionError(
          "operationId replay with divergent candidate",
          {
            obligation: "promotion.idempotent_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
          },
        );
      }
      if (replay.ok) {
        const replayed: PromotionAdmissionResult = {
          ok: true,
          record: {
            ...replay.record,
            idempotentReplay: true,
          },
        };
        this.emitAdmission(replayed, operationId);
        return replayed;
      }
      return replay;
    }

    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision !== this.slot.revision
    ) {
      return this.reject(
        operationId,
        "promotion.stale_revision",
        "stale expectedRevision rejected",
        candidateIdFromUnknown(input.candidate),
      );
    }

    // Artifact identity is checked before full eval attachment parsing.
    const rawAdapterHash = adapterHashFromUnknown(input.candidate);
    if (rawAdapterHash === undefined) {
      return this.reject(
        operationId,
        "promotion.schema_invalid",
        "candidate adapterHash missing or invalid",
        candidateIdFromUnknown(input.candidate),
      );
    }
    const measuredHash = contentAddressPromotionArtifact(input.artifactBytes);
    if (measuredHash !== rawAdapterHash) {
      return this.reject(
        operationId,
        "promotion.adapter_hash_mismatch",
        "artifact bytes do not match candidate adapterHash",
        candidateIdFromUnknown(input.candidate),
      );
    }
    const rawCandidate = input.candidate as Record<string, unknown>;
    const rawLocality = rawCandidate.locality;
    if (
      rawLocality !== "on-device" &&
      rawLocality !== "self-hosted"
    ) {
      return this.reject(
        operationId,
        "promotion.locality_forbidden",
        "candidate locality is not sovereign",
        candidateIdFromUnknown(input.candidate),
      );
    }
    const rawLineage =
      rawCandidate.lineageRef &&
      typeof rawCandidate.lineageRef === "object"
        ? (rawCandidate.lineageRef as Record<string, unknown>)
        : undefined;
    if (
      rawLineage === undefined ||
      typeof rawLineage.signature !== "string" ||
      rawLineage.signature.length === 0
    ) {
      return this.reject(
        operationId,
        "promotion.lineage_unsigned",
        "signed C4 lineage is mandatory",
        candidateIdFromUnknown(input.candidate),
      );
    }

    const parsed = promotionCandidateSchema.safeParse(input.candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const issuePath = issue?.path.join(".");
      const reason: PromotionAdmissionReason =
        issue?.path[0] === "evalVerdicts"
          ? "promotion.eval_attachment_incomplete"
          : "promotion.schema_invalid";
      return this.reject(
        operationId,
        reason,
        issue?.message ?? "candidate schema invalid",
        candidateIdFromUnknown(input.candidate),
        issuePath,
      );
    }
    const candidate = parsed.data;

    if (
      candidate.subjectId !== this.subjectId ||
      candidate.deviceId !== this.deviceId
    ) {
      return this.reject(
        operationId,
        "promotion.subject_scope",
        "candidate outside registry subject/device scope",
        candidate.candidateId,
      );
    }
    if (
      candidate.locality !== "on-device" &&
      candidate.locality !== "self-hosted"
    ) {
      return this.reject(
        operationId,
        "promotion.locality_forbidden",
        "candidate locality is not sovereign",
        candidate.candidateId,
      );
    }
    if (candidate.surgeryClasses.length !== 1) {
      return this.reject(
        operationId,
        "promotion.attribution_void",
        "one surgery type per stage required",
        candidate.candidateId,
        candidate.surgeryClasses.join("+"),
      );
    }
    if (!candidate.evalVerdicts.baselineFrozen) {
      return this.reject(
        operationId,
        "promotion.baseline_unfrozen",
        "eval attachment must use frozen C0 baselines",
        candidate.candidateId,
      );
    }
    if (!candidate.evalVerdicts.baselineDecontaminated) {
      return this.reject(
        operationId,
        "promotion.baseline_contaminated",
        "eval attachment must use decontaminated C0 baselines",
        candidate.candidateId,
      );
    }
    if (
      candidate.lineageRef.adapterHash !== candidate.adapterHash
    ) {
      return this.reject(
        operationId,
        "promotion.lineage_adapter_mismatch",
        "signed lineage adapterHash differs from candidate",
        candidate.candidateId,
      );
    }
    if (!candidate.lineageRef.signature) {
      return this.reject(
        operationId,
        "promotion.lineage_unsigned",
        "signed C4 lineage is mandatory",
        candidate.candidateId,
      );
    }
    if (!this.verifyLineage(candidate)) {
      return this.reject(
        operationId,
        "promotion.lineage_signature_invalid",
        "C4 lineage signature invalid",
        candidate.candidateId,
      );
    }

    const evaluatedAt = input.admittedAt ?? new Date().toISOString();
    const gates = evaluatePromotionEvalGates({
      evalVerdicts: candidate.evalVerdicts,
      ...(this.baselinePin !== undefined
        ? { baselinePin: this.baselinePin }
        : {}),
      evaluatedAt,
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      candidateId: candidate.candidateId,
      ...(this.onTelemetry !== undefined
        ? { onTelemetry: this.onTelemetry }
        : {}),
    });
    if (!gates.ok) {
      return this.reject(
        operationId,
        gates.reason,
        gates.detail,
        candidate.candidateId,
        gates.failingSlice,
        gates.metricDelta,
      );
    }

    const existing = this.slot.byCandidateId.get(candidate.candidateId);
    if (existing) {
      if (
        existing.candidate.adapterHash !== candidate.adapterHash ||
        existing.candidate.lineageRef.signature !==
          candidate.lineageRef.signature
      ) {
        throw new PromotionAdmissionError(
          "candidateId already admitted with divergent identity",
          {
            obligation: "promotion.idempotent_conflict",
            subjectId: this.subjectId,
            deviceId: this.deviceId,
          },
        );
      }
      const result: PromotionAdmissionResult = {
        ok: true,
        record: { ...existing, idempotentReplay: true },
      };
      this.slot.byOperationId.set(operationId, result);
      this.emitAdmission(result, operationId);
      return result;
    }
    if (
      this.slot.byCandidateId.size >= PROMOTION_REGISTRY_ENTRY_LIMIT
    ) {
      return this.reject(
        operationId,
        "promotion.capacity",
        `registry entry limit ${PROMOTION_REGISTRY_ENTRY_LIMIT} exceeded`,
        candidate.candidateId,
      );
    }

    const nextRevision = this.slot.revision + 1;
    const record: PromotionAdmissionRecord = Object.freeze({
      schemaVersion: PROMOTION_ADMISSION_SCHEMA_VERSION,
      candidate: Object.freeze(candidate),
      status: "admitted",
      admittedAt: input.admittedAt ?? new Date().toISOString(),
      operationId,
      revision: nextRevision,
      idempotentReplay: false,
    });
    // Single synchronous commit point after all validation.
    this.slot.byCandidateId.set(candidate.candidateId, record);
    this.slot.revision = nextRevision;
    const result: PromotionAdmissionResult = { ok: true, record };
    this.rememberOperation(operationId, result);
    this.emitAdmission(result, operationId);
    return result;
  }

  get(input: {
    subjectId: string;
    candidateId: string;
  }): PromotionAdmissionRecord | undefined {
    if (requireId(input.subjectId, "subjectId") !== this.subjectId) {
      throw new PromotionAdmissionError(
        "cross-subject promotion registry read denied",
        {
          obligation: "promotion.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    return this.slot.byCandidateId.get(
      requireId(input.candidateId, "candidateId"),
    );
  }

  list(input: {
    subjectId: string;
    limit?: number;
  }): ReadonlyArray<PromotionAdmissionRecord> {
    if (requireId(input.subjectId, "subjectId") !== this.subjectId) {
      throw new PromotionAdmissionError(
        "cross-subject promotion registry list denied",
        {
          obligation: "promotion.subject_scope",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    const limit = Math.min(
      Math.max(input.limit ?? PROMOTION_REGISTRY_ENTRY_LIMIT, 0),
      PROMOTION_REGISTRY_ENTRY_LIMIT,
    );
    return Object.freeze(
      [...this.slot.byCandidateId.values()].slice(0, limit),
    );
  }

  private verifyLineage(candidate: PromotionCandidateRecord): boolean {
    const expected = signPromotionLineageRef(
      candidate.lineageRef,
      this.verificationKey,
    );
    const supplied = Buffer.from(candidate.lineageRef.signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      supplied.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(supplied, expectedBytes)
    );
  }

  private reject(
    operationId: string,
    reason: PromotionAdmissionReason,
    detail: string,
    candidateId?: string,
    failingSlice?: string,
    metricDelta?: number,
  ): PromotionAdmissionResult {
    const result: PromotionAdmissionResult = {
      ok: false,
      reason,
      ...(candidateId !== undefined ? { candidateId } : {}),
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(metricDelta !== undefined ? { metricDelta } : {}),
      detail,
      revision: this.slot.revision,
    };
    this.rememberOperation(operationId, result);
    this.onTelemetry?.({
      event: "learning.promotion_registry.reject",
      outcome: "fail",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      operationId,
      ...(candidateId !== undefined ? { candidateId } : {}),
      failureClass: reason,
      ...(failingSlice !== undefined ? { failingSlice } : {}),
      ...(metricDelta !== undefined ? { metricDelta } : {}),
      revision: this.slot.revision,
    });
    return result;
  }

  private emitAdmission(
    result: Extract<PromotionAdmissionResult, { ok: true }>,
    operationId: string,
  ): void {
    this.onTelemetry?.({
      event: "learning.promotion_registry.admit",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      candidateId: result.record.candidate.candidateId,
      operationId,
      adapterHash: result.record.candidate.adapterHash,
      stage: result.record.candidate.stage,
      revision: result.record.revision,
      idempotentReplay: result.record.idempotentReplay,
      goldenPassRate: 1,
    });
  }

  private rememberOperation(
    operationId: string,
    result: PromotionAdmissionResult,
  ): void {
    this.slot.byOperationId.set(operationId, result);
    if (this.slot.byOperationId.size > PROMOTION_OPERATION_LIMIT) {
      const first = this.slot.byOperationId.keys().next().value;
      if (first !== undefined) this.slot.byOperationId.delete(first);
    }
  }
}

function adapterHashFromUnknown(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).adapterHash;
  return typeof value === "string" && HASH_RE.test(value)
    ? value
    : undefined;
}

function candidateIdFromUnknown(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).candidateId;
  return typeof value === "string" ? value : undefined;
}

function requireId(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!ID_RE.test(trimmed)) {
    throw new PromotionAdmissionError(`${field} invalid`, {
      obligation: "promotion.schema_invalid",
    });
  }
  return trimmed;
}

function requireHash(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!HASH_RE.test(trimmed)) {
    throw new PromotionAdmissionError(`${field} must be sha256:<64 hex>`, {
      obligation: "promotion.schema_invalid",
    });
  }
  return trimmed;
}

function requireSliceId(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    !trimmed ||
    trimmed.length > 128 ||
    trimmed.split("/").length !== 3 ||
    trimmed.includes("..") ||
    trimmed.includes("\\")
  ) {
    throw new PromotionAdmissionError("requiredSliceId invalid", {
      obligation: "promotion.schema_invalid",
      failingSlice: trimmed || "(empty)",
    });
  }
  return trimmed;
}

function requireVerificationKey(value: string): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 16 || key.length > 512) {
    throw new PromotionAdmissionError(
      "lineage verification key must be 16..512 chars",
      { obligation: "promotion.schema_invalid" },
    );
  }
  return key;
}
