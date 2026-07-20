/**
 * Cadence cycle outcome types (promotion automation).
 *
 * Automated verdicts and immutable, metadata-only evidence bundles for human
 * review. Verdicts are derived from evidence; there is no API for a reviewer
 * to supply or override a promotion verdict.
 */

export const CADENCE_VERDICT_SCHEMA_VERSION =
  "cadence.cycle-verdict.v1" as const;

/** Automated verdicts — humans review evidence; they cannot hand-wave these. */
export const CADENCE_AUTOMATED_VERDICTS = Object.freeze([
  "promote",
  "reject",
  "defer",
  "skip",
  "expired",
] as const);

export type CadenceAutomatedVerdict =
  (typeof CADENCE_AUTOMATED_VERDICTS)[number];

export const CADENCE_SKIP_REASONS = Object.freeze([
  "insufficient_trajectories",
  "accelerator_unavailable",
] as const);

export type CadenceSkipReason = (typeof CADENCE_SKIP_REASONS)[number];

/**
 * One surgery kind per cadence cycle (constitution L1 for continuous loop).
 * Adapter XOR critic XOR behavioral flag — never two.
 */
export const CADENCE_SURGERY_KINDS = Object.freeze([
  "adapter",
  "critic",
  "behavioral_flag",
] as const);

export type CadenceSurgeryKind = (typeof CADENCE_SURGERY_KINDS)[number];

export const CADENCE_VERDICT_BUNDLE_SCHEMA_VERSION =
  "cadence.verdict-bundle.v1" as const;
export const CADENCE_VERDICT_BUNDLE_SLICE_LIMIT = 64 as const;
export const CADENCE_VERDICT_BUNDLE_FAILURE_LIMIT = 128 as const;

export type CadenceLineageEvidence = {
  schemaVersion: "checkpoint.lineage.v1";
  runId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  checkpointHash: string;
  parentCheckpointHash: string;
  corpusManifestHash: string;
  baseModelHash: string;
  signerId: string;
  signedAt: string;
  signature: string;
  verified: boolean;
};

export type CadenceRedTeamEvidence = {
  suiteId: string;
  suiteManifestHash: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  verdict: "pass" | "fail";
  completedAt: string;
  failingScenarioIds: readonly string[];
};

export type CadenceEvalPinEvidence = {
  baselineRegistryHash: string;
  baselineFrozen: boolean;
  baselineDecontaminated: boolean;
  pinnedSeed: string;
};

export type CadenceSliceEvidenceInput = {
  sliceId: string;
  championScore: number;
  challengerScore: number;
  tolerance: number;
  status?: "complete" | "pending";
};

export type CadenceSliceEvidence = CadenceSliceEvidenceInput & {
  status: "complete" | "pending";
  delta: number | null;
  verdict: "pass" | "fail" | "pending";
};

export type CadenceVerdictReason =
  | "all_gates_passed"
  | "slice_regression"
  | "slice_not_improved"
  | "evaluation_pending"
  | "red_team_failed"
  | "lineage_unverified";

export type CadenceVerdictBundleTelemetryEvent = {
  event: "learning.cadence.verdict_bundle";
  outcome: "promote" | "reject" | "defer" | "fail";
  subjectId: string;
  deviceId: string;
  cycleId: string;
  candidateId: string;
  reason?: CadenceVerdictReason;
  failingSlice?: string;
  failureClass?: CadenceVerdictBundleFailureClass;
};

export type CadenceVerdictBundleFailureClass =
  | "cadence.bundle_invalid"
  | "cadence.bundle_cross_subject"
  | "cadence.bundle_locality_forbidden"
  | "cadence.bundle_sovereignty"
  | "cadence.bundle_section_limit"
  | "cadence.bundle_attribution_void";

export class CadenceVerdictBundleError extends Error {
  readonly obligation: CadenceVerdictBundleFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CadenceVerdictBundleFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "CadenceVerdictBundleError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

export type CadenceVerdictBundle = {
  schemaVersion: typeof CADENCE_VERDICT_BUNDLE_SCHEMA_VERSION;
  cycleId: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  createdAt: string;
  lineage: Readonly<CadenceLineageEvidence>;
  evalPin: Readonly<CadenceEvalPinEvidence>;
  slices: readonly Readonly<CadenceSliceEvidence>[];
  redTeam: Readonly<CadenceRedTeamEvidence>;
  championChallenger: {
    improvedSlices: number;
    tiedSlices: number;
    regressedSlices: number;
    pendingSlices: number;
  };
  verdict: "promote" | "reject" | "defer";
  reason: CadenceVerdictReason;
  failingSlice: string | null;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_RE = /^[a-zA-Z0-9+/=_-]{16,512}$/;
const SLICE_RE =
  /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i;
const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;

function assertBundleMetadataOnly(
  value: unknown,
  meta: { subjectId: string; deviceId: string },
): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new CadenceVerdictBundleError(
        `verdict evidence forbids raw content field ${key}`,
        { obligation: "cadence.bundle_sovereignty", ...meta },
      );
    }
    assertBundleMetadataOnly(child, meta);
  }
}

function assertIdentity(
  value: {
    subjectId: string;
    deviceId: string;
    locality: "on-device" | "self-hosted";
  },
  expected: {
    subjectId: string;
    deviceId: string;
    locality: "on-device" | "self-hosted";
  },
): void {
  if (value.subjectId !== expected.subjectId || value.deviceId !== expected.deviceId) {
    throw new CadenceVerdictBundleError(
      "evidence identity does not match the cadence subject/device",
      {
        obligation: "cadence.bundle_cross_subject",
        subjectId: expected.subjectId,
        deviceId: expected.deviceId,
      },
    );
  }
  if (value.locality !== expected.locality) {
    throw new CadenceVerdictBundleError(
      "evidence locality does not match the cadence boundary",
      {
        obligation: "cadence.bundle_locality_forbidden",
        subjectId: expected.subjectId,
        deviceId: expected.deviceId,
      },
    );
  }
}

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

export type CadenceCycleVerdict = {
  schemaVersion: typeof CADENCE_VERDICT_SCHEMA_VERSION;
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind | null;
  verdict: CadenceAutomatedVerdict;
  completedAt: string;
  /** Named when automated gate rejects a regressed candidate. */
  failingSlice: string | null;
  skipReason: CadenceSkipReason | null;
  /**
   * True when human review deadline elapsed without approval —
   * stale candidates expire; never auto-promote.
   */
  expiredForHumanReview: boolean;
  stagesCompleted: readonly string[];
};

/**
 * Assert humans cannot turn any non-promote automated outcome into promotion.
 * Review acknowledges evidence; it never supplies a replacement verdict.
 */
export function assertHumanCannotOverrideFailingVerdict(input: {
  automated: CadenceCycleVerdict;
  humanRequested: CadenceAutomatedVerdict;
}):
  | { ok: true }
  | { ok: false; detail: string } {
  if (
    input.automated.verdict !== "promote" &&
    input.humanRequested === "promote"
  ) {
    return {
      ok: false,
      detail:
        "human review cannot override a non-promote automated verdict without a new candidate",
    };
  }
  return { ok: true };
}

export function createSkipVerdict(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  reason: CadenceSkipReason;
  completedAt: string;
  stagesCompleted: readonly string[];
}): CadenceCycleVerdict {
  return {
    schemaVersion: CADENCE_VERDICT_SCHEMA_VERSION,
    cycleId: input.cycleId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    surgeryKind: null,
    verdict: "skip",
    completedAt: input.completedAt,
    failingSlice: null,
    skipReason: input.reason,
    expiredForHumanReview: false,
    stagesCompleted: Object.freeze([...input.stagesCompleted]),
  };
}

export function createExpiredVerdict(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  completedAt: string;
  stagesCompleted: readonly string[];
}): CadenceCycleVerdict {
  return {
    schemaVersion: CADENCE_VERDICT_SCHEMA_VERSION,
    cycleId: input.cycleId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    surgeryKind: input.surgeryKind,
    verdict: "expired",
    completedAt: input.completedAt,
    failingSlice: null,
    skipReason: null,
    expiredForHumanReview: true,
    stagesCompleted: Object.freeze([...input.stagesCompleted]),
  };
}

function createGateVerdict(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  verdict: "promote" | "reject" | "defer";
  completedAt: string;
  failingSlice: string | null;
  stagesCompleted: readonly string[];
}): CadenceCycleVerdict {
  return {
    schemaVersion: CADENCE_VERDICT_SCHEMA_VERSION,
    cycleId: input.cycleId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    surgeryKind: input.surgeryKind,
    verdict: input.verdict,
    completedAt: input.completedAt,
    failingSlice: input.failingSlice,
    skipReason: null,
    expiredForHumanReview: false,
    stagesCompleted: Object.freeze([...input.stagesCompleted]),
  };
}

/**
 * Build the complete human-review artifact and derive its automated verdict.
 * A tie is not a promotion: every completed slice must improve on champion.
 */
export function createAutomatedVerdictBundle(input: {
  cycleId: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  surgeryKinds: readonly CadenceSurgeryKind[];
  createdAt: string;
  lineage: CadenceLineageEvidence;
  evalPin: CadenceEvalPinEvidence;
  slices: readonly CadenceSliceEvidenceInput[];
  redTeam: CadenceRedTeamEvidence;
  stagesCompleted: readonly string[];
  onTelemetry?: (event: CadenceVerdictBundleTelemetryEvent) => void;
}): { bundle: CadenceVerdictBundle; cycleVerdict: CadenceCycleVerdict } {
  const meta = { subjectId: input.subjectId, deviceId: input.deviceId };
  try {
    assertBundleMetadataOnly(input, meta);
    if (
      !ID_RE.test(input.cycleId) ||
      !ID_RE.test(input.candidateId) ||
      !ID_RE.test(input.subjectId) ||
      !ID_RE.test(input.deviceId) ||
      !ID_RE.test(input.lineage.runId) ||
      !ID_RE.test(input.lineage.signerId) ||
      !ID_RE.test(input.evalPin.pinnedSeed) ||
      !ID_RE.test(input.redTeam.suiteId)
    ) {
      throw new CadenceVerdictBundleError(
        "verdict bundle identifiers must be stable metadata ids",
        { obligation: "cadence.bundle_invalid", ...meta },
      );
    }
    if (
      input.locality !== "on-device" &&
      input.locality !== "self-hosted"
    ) {
      throw new CadenceVerdictBundleError("invalid bundle locality", {
        obligation: "cadence.bundle_locality_forbidden",
        ...meta,
      });
    }
    if (
      input.surgeryKinds.length !== 1 ||
      input.surgeryKinds[0] !== input.surgeryKind ||
      !CADENCE_SURGERY_KINDS.includes(input.surgeryKind)
    ) {
      throw new CadenceVerdictBundleError(
        "verdict evidence must describe exactly one surgery kind",
        { obligation: "cadence.bundle_attribution_void", ...meta },
      );
    }
    assertIdentity(input.lineage, input);
    assertIdentity(input.redTeam, input);
    if (input.redTeam.candidateId !== input.candidateId) {
      throw new CadenceVerdictBundleError(
        "red-team evidence belongs to another candidate",
        { obligation: "cadence.bundle_cross_subject", ...meta },
      );
    }
    if (
      input.lineage.schemaVersion !== "checkpoint.lineage.v1" ||
      input.lineage.checkpointHash.length < 8 ||
      input.lineage.parentCheckpointHash.length < 8 ||
      !HASH_RE.test(input.lineage.corpusManifestHash) ||
      input.lineage.baseModelHash.length < 8 ||
      !SIGNATURE_RE.test(input.lineage.signature) ||
      !Number.isFinite(Date.parse(input.lineage.signedAt)) ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      !Number.isFinite(Date.parse(input.redTeam.completedAt))
    ) {
      throw new CadenceVerdictBundleError(
        "lineage and red-team evidence must be complete and timestamped",
        { obligation: "cadence.bundle_invalid", ...meta },
      );
    }
    if (
      !HASH_RE.test(input.evalPin.baselineRegistryHash) ||
      !HASH_RE.test(input.redTeam.suiteManifestHash) ||
      !input.evalPin.baselineFrozen ||
      !input.evalPin.baselineDecontaminated
    ) {
      throw new CadenceVerdictBundleError(
        "bundle requires frozen decontaminated eval and hashed safety evidence",
        { obligation: "cadence.bundle_invalid", ...meta },
      );
    }
    if (
      input.slices.length < 1 ||
      input.slices.length > CADENCE_VERDICT_BUNDLE_SLICE_LIMIT ||
      input.redTeam.failingScenarioIds.length >
        CADENCE_VERDICT_BUNDLE_FAILURE_LIMIT
    ) {
      throw new CadenceVerdictBundleError(
        "verdict evidence exceeds bounded section limits",
        { obligation: "cadence.bundle_section_limit", ...meta },
      );
    }
    const failingScenarios = new Set(input.redTeam.failingScenarioIds);
    if (
      failingScenarios.size !== input.redTeam.failingScenarioIds.length ||
      input.redTeam.failingScenarioIds.some((id) => !ID_RE.test(id)) ||
      (input.redTeam.verdict === "pass" &&
        input.redTeam.failingScenarioIds.length !== 0) ||
      (input.redTeam.verdict === "fail" &&
        input.redTeam.failingScenarioIds.length === 0)
    ) {
      throw new CadenceVerdictBundleError(
        "red-team verdict and failing scenarios are inconsistent",
        { obligation: "cadence.bundle_invalid", ...meta },
      );
    }

    let improvedSlices = 0;
    let tiedSlices = 0;
    let regressedSlices = 0;
    let pendingSlices = 0;
    let failingSlice: string | null = null;
    const seenSlices = new Set<string>();
    const slices: CadenceSliceEvidence[] = input.slices.map((slice) => {
      if (!SLICE_RE.test(slice.sliceId) || seenSlices.has(slice.sliceId)) {
        throw new CadenceVerdictBundleError(
          `invalid or duplicate slice id: ${slice.sliceId}`,
          { obligation: "cadence.bundle_invalid", ...meta },
        );
      }
      seenSlices.add(slice.sliceId);
      const status = slice.status ?? "complete";
      if (status === "pending") {
        pendingSlices += 1;
        return freezeRecord({
          ...slice,
          status,
          delta: null,
          verdict: "pending" as const,
        });
      }
      if (
        !Number.isFinite(slice.championScore) ||
        !Number.isFinite(slice.challengerScore) ||
        !Number.isFinite(slice.tolerance) ||
        slice.championScore < 0 ||
        slice.championScore > 1 ||
        slice.challengerScore < 0 ||
        slice.challengerScore > 1 ||
        slice.tolerance < 0 ||
        slice.tolerance > 1
      ) {
        throw new CadenceVerdictBundleError(
          `invalid score evidence for slice ${slice.sliceId}`,
          { obligation: "cadence.bundle_invalid", ...meta },
        );
      }
      const delta = slice.challengerScore - slice.championScore;
      if (delta < -slice.tolerance - Number.EPSILON) {
        regressedSlices += 1;
        failingSlice ??= slice.sliceId;
        return freezeRecord({ ...slice, status, delta, verdict: "fail" as const });
      }
      if (delta <= Number.EPSILON) {
        tiedSlices += 1;
        return freezeRecord({
          ...slice,
          status,
          delta,
          verdict: "pending" as const,
        });
      }
      improvedSlices += 1;
      return freezeRecord({ ...slice, status, delta, verdict: "pass" as const });
    });

    let verdict: "promote" | "reject" | "defer";
    let reason: CadenceVerdictReason;
    if (!input.lineage.verified) {
      verdict = "reject";
      reason = "lineage_unverified";
    } else if (input.redTeam.verdict === "fail") {
      verdict = "reject";
      reason = "red_team_failed";
    } else if (regressedSlices > 0) {
      verdict = "reject";
      reason = "slice_regression";
    } else if (pendingSlices > 0) {
      verdict = "defer";
      reason = "evaluation_pending";
    } else if (tiedSlices > 0) {
      verdict = "defer";
      reason = "slice_not_improved";
    } else {
      verdict = "promote";
      reason = "all_gates_passed";
    }

    const bundle: CadenceVerdictBundle = Object.freeze({
      schemaVersion: CADENCE_VERDICT_BUNDLE_SCHEMA_VERSION,
      cycleId: input.cycleId,
      candidateId: input.candidateId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      surgeryKind: input.surgeryKind,
      createdAt: input.createdAt,
      lineage: freezeRecord(input.lineage),
      evalPin: freezeRecord(input.evalPin),
      slices: Object.freeze(slices),
      redTeam: Object.freeze({
        ...input.redTeam,
        failingScenarioIds: Object.freeze([
          ...input.redTeam.failingScenarioIds,
        ]),
      }),
      championChallenger: Object.freeze({
        improvedSlices,
        tiedSlices,
        regressedSlices,
        pendingSlices,
      }),
      verdict,
      reason,
      failingSlice,
    });
    const cycleVerdict = createGateVerdict({
      cycleId: input.cycleId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      surgeryKind: input.surgeryKind,
      verdict,
      completedAt: input.createdAt,
      failingSlice,
      stagesCompleted: input.stagesCompleted,
    });
    input.onTelemetry?.({
      event: "learning.cadence.verdict_bundle",
      outcome: verdict,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      cycleId: input.cycleId,
      candidateId: input.candidateId,
      reason,
      ...(failingSlice !== null ? { failingSlice } : {}),
    });
    return { bundle, cycleVerdict };
  } catch (error) {
    if (error instanceof CadenceVerdictBundleError) {
      input.onTelemetry?.({
        event: "learning.cadence.verdict_bundle",
        outcome: "fail",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        cycleId: input.cycleId,
        candidateId: input.candidateId,
        failureClass: error.obligation,
      });
    }
    throw error;
  }
}

/** Create the fixed reject verdict emitted by a failed shadow/canary gate. */
export function createAutomatedRuntimeRejection(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  completedAt: string;
  failingSlice: string;
  stagesCompleted: readonly string[];
}): CadenceCycleVerdict {
  return createGateVerdict({
    ...input,
    verdict: "reject",
  });
}
