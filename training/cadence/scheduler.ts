/**
 * Continuous cadence scheduler — collect → C3 score → C4 batch → C5 shadow →
 * canary → automated gate.
 *
 * Cron-driven state machine with per-stage timeouts, explicit skip on
 * insufficient trajectories, one-surgery enforcement, and human-review
 * expiry (never auto-promote on stale candidates).
 */

import {
  CADENCE_SURGERY_KINDS,
  assertHumanCannotOverrideFailingVerdict,
  createAutomatedRuntimeRejection,
  createAutomatedVerdictBundle,
  createExpiredVerdict,
  createSkipVerdict,
  type CadenceAutomatedVerdict,
  type CadenceCycleVerdict,
  type CadenceLineageEvidence,
  type CadenceRedTeamEvidence,
  type CadenceSurgeryKind,
  type CadenceVerdictBundle,
  type CadenceVerdictBundleTelemetryEvent,
} from "./verdict_bundle.ts";

export const CADENCE_SCHEDULER_SCHEMA_VERSION =
  "cadence.scheduler.v1" as const;

export const CADENCE_STAGES = Object.freeze([
  "collect",
  "score",
  "train",
  "shadow",
  "canary",
  "gate",
] as const);

export type CadenceStage = (typeof CADENCE_STAGES)[number];

export const CADENCE_DEFAULT_STAGE_TIMEOUT_MS = 5_000 as const;
export const CADENCE_MIN_TRAJECTORIES = 4 as const;
export const CADENCE_OPERATION_LIMIT = 256 as const;
export const CADENCE_SLICE_LIMIT = 64 as const;

export type CadenceFailureClass =
  | "cadence.invalid_input"
  | "cadence.missing_subject"
  | "cadence.cross_subject_denied"
  | "cadence.locality_forbidden"
  | "cadence.sovereignty"
  | "cadence.section_limit"
  | "cadence.downstream_timeout"
  | "cadence.idempotent_conflict"
  | "cadence.attribution_void"
  | "cadence.train_on_eval_void"
  | "cadence.partial_failure"
  | "cadence.capacity"
  | "cadence.human_override_forbidden"
  | "cadence.stage_failed";

export class CadenceSchedulerError extends Error {
  readonly obligation: CadenceFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly stage: CadenceStage | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CadenceFailureClass;
      subjectId?: string;
      deviceId?: string;
      stage?: CadenceStage;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "CadenceSchedulerError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.stage = meta.stage;
    this.failingSlice = meta.failingSlice;
  }
}

export type CadenceTelemetryEvent = {
  event: "learning.cadence.scheduler";
  outcome: "ok" | "rejected" | "skip" | "expired" | "idempotent_replay";
  subjectId: string;
  deviceId?: string;
  action?:
    | "cycle_start"
    | "stage"
    | "skip"
    | "gate"
    | "expire"
    | "cycle_complete";
  cycleId?: string;
  stage?: CadenceStage;
  surgeryKind?: CadenceSurgeryKind;
  failureClass?: CadenceFailureClass;
  failingSlice?: string;
  trajectoryCount?: number;
  verdict?: CadenceAutomatedVerdict;
};

export type CadenceEvalPin = {
  baselineRegistryHash: string;
  baselineFrozen: boolean;
  baselineDecontaminated: boolean;
  pinnedSeed: string;
};

export type CadenceSliceScore = {
  sliceId: string;
  championScore: number;
  challengerScore: number;
  tolerance: number;
  status?: "complete" | "pending";
};

export type CadenceVerdictEvidence = {
  lineage: CadenceLineageEvidence;
  redTeam: CadenceRedTeamEvidence;
};

export type CadenceCollectResult = {
  trajectoryCount: number;
  consentClass: "research" | "product-improve" | "personal";
};

export type CadenceScoreResult = {
  criticVersion: string;
  scoredCount: number;
};

export type CadenceTrainResult = {
  candidateId: string;
  checkpointHash: string;
};

export type CadenceShadowResult = {
  comparisonOk: boolean;
  failingSlice?: string;
};

export type CadenceCanaryResult = {
  status: "healthy" | "halted";
  failingSlice?: string;
};

export type CadenceStageHandlers = {
  collect: () => CadenceCollectResult | Promise<CadenceCollectResult>;
  score: () => CadenceScoreResult | Promise<CadenceScoreResult>;
  train: () => CadenceTrainResult | Promise<CadenceTrainResult>;
  shadow: () => CadenceShadowResult | Promise<CadenceShadowResult>;
  canary: () => CadenceCanaryResult | Promise<CadenceCanaryResult>;
};

export type CadenceCycleReport = {
  schemaVersion: typeof CADENCE_SCHEDULER_SCHEMA_VERSION;
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind | null;
  stagesCompleted: readonly CadenceStage[];
  verdict: CadenceCycleVerdict;
  candidateId: string | null;
  checkpointHash: string | null;
  evidenceBundle: CadenceVerdictBundle | null;
  idempotent: boolean;
};

const FORBIDDEN_CONTENT_KEY =
  /utterance|promptBody|replyBody|learnerContent|rawContent|secret/i;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

const cycleReceipts = new Map<string, CadenceCycleReport>();
const subjectLocks = new Set<string>();

function emit(
  onTelemetry: ((e: CadenceTelemetryEvent) => void) | undefined,
  event: CadenceTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function assertMetadataOnly(
  value: unknown,
  label: string,
  meta: { subjectId?: string; deviceId?: string } = {},
): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEY.test(key)) {
      throw new CadenceSchedulerError(
        `${label} forbids raw content field ${key}`,
        {
          obligation: "cadence.sovereignty",
          ...(meta.subjectId !== undefined
            ? { subjectId: meta.subjectId }
            : {}),
          ...(meta.deviceId !== undefined ? { deviceId: meta.deviceId } : {}),
        },
      );
    }
  }
}

function assertOneSurgeryKind(
  surgeryKind: CadenceSurgeryKind,
  surgeryKinds: readonly CadenceSurgeryKind[],
  meta: { subjectId: string; deviceId: string },
): void {
  if (!(CADENCE_SURGERY_KINDS as readonly string[]).includes(surgeryKind)) {
    throw new CadenceSchedulerError(`unknown surgery kind: ${surgeryKind}`, {
      obligation: "cadence.invalid_input",
      subjectId: meta.subjectId,
      deviceId: meta.deviceId,
    });
  }
  const distinct = new Set(surgeryKinds);
  if (distinct.size !== 1 || !distinct.has(surgeryKind)) {
    throw new CadenceSchedulerError(
      "one surgery type per cadence cycle — candidate touches multiple classes",
      {
        obligation: "cadence.attribution_void",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
      },
    );
  }
}

function assertEvalPin(
  pin: CadenceEvalPin,
  meta: { subjectId: string; deviceId: string },
): void {
  assertMetadataOnly(pin, "eval pin", meta);
  if (!HASH_RE.test(pin.baselineRegistryHash) || !ID_RE.test(pin.pinnedSeed)) {
    throw new CadenceSchedulerError(
      "eval pin requires registry hash and pinned seed",
      {
        obligation: "cadence.train_on_eval_void",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
      },
    );
  }
  if (!pin.baselineFrozen || !pin.baselineDecontaminated) {
    throw new CadenceSchedulerError(
      "gates require frozen, decontaminated baselines with pinned seeds",
      {
        obligation: "cadence.train_on_eval_void",
        subjectId: meta.subjectId,
        deviceId: meta.deviceId,
      },
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: CadenceStage,
  meta: { subjectId: string; deviceId: string },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(() => promise)
    .then(
      (value) => ({ kind: "ok" as const, value }),
      (error: unknown) => ({ kind: "err" as const, error }),
    );
  try {
    const raced = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      throw new CadenceSchedulerError(
        `cadence stage ${stage} timed out after ${timeoutMs}ms`,
        {
          obligation: "cadence.downstream_timeout",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
          stage,
        },
      );
    }
    if (raced.kind === "err") {
      if (raced.error instanceof CadenceSchedulerError) throw raced.error;
      throw new CadenceSchedulerError(
        `cadence stage ${stage} failed: ${
          raced.error instanceof Error ? raced.error.message : "unknown"
        }`,
        {
          obligation: "cadence.stage_failed",
          subjectId: meta.subjectId,
          deviceId: meta.deviceId,
          stage,
        },
      );
    }
    return raced.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rejectReport(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  stagesCompleted: readonly CadenceStage[];
  candidateId: string | null;
  checkpointHash: string | null;
  completedAt: string;
  failingSlice: string;
  stage: CadenceStage;
  onTelemetry?: (e: CadenceTelemetryEvent) => void;
  receiptKey: string;
}): CadenceCycleReport {
  const reject = createAutomatedRuntimeRejection({
    cycleId: input.cycleId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    surgeryKind: input.surgeryKind,
    verdict: "reject",
    completedAt: input.completedAt,
    failingSlice: input.failingSlice,
    stagesCompleted: input.stagesCompleted,
  });
  const report: CadenceCycleReport = {
    schemaVersion: CADENCE_SCHEDULER_SCHEMA_VERSION,
    cycleId: input.cycleId,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    locality: input.locality,
    surgeryKind: input.surgeryKind,
    stagesCompleted: Object.freeze([...input.stagesCompleted]),
    verdict: reject,
    candidateId: input.candidateId,
    checkpointHash: input.checkpointHash,
    evidenceBundle: null,
    idempotent: false,
  };
  cycleReceipts.set(input.receiptKey, report);
  emit(input.onTelemetry, {
    event: "learning.cadence.scheduler",
    outcome: "rejected",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    action: "gate",
    cycleId: input.cycleId,
    stage: input.stage,
    failingSlice: input.failingSlice,
    verdict: "reject",
    failureClass: "cadence.stage_failed",
  });
  return report;
}

/**
 * Run one cadence cycle: collect → score → train → shadow → canary → gate.
 */
export async function runCadenceCycle(input: {
  cycleId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  surgeryKinds: readonly CadenceSurgeryKind[];
  evalPin: CadenceEvalPin;
  sliceScores: readonly CadenceSliceScore[];
  evidence: CadenceVerdictEvidence;
  handlers: CadenceStageHandlers;
  minTrajectories?: number;
  stageTimeoutMs?: number;
  humanReviewDeadline?: string;
  now?: () => string;
  onTelemetry?: (e: CadenceTelemetryEvent) => void;
  onVerdictBundleTelemetry?: (e: CadenceVerdictBundleTelemetryEvent) => void;
}): Promise<CadenceCycleReport> {
  if (
    !ID_RE.test(input.cycleId) ||
    !ID_RE.test(input.subjectId) ||
    !ID_RE.test(input.deviceId)
  ) {
    throw new CadenceSchedulerError("cycle/subject/device ids must be stable", {
      obligation: "cadence.invalid_input",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }
  if (input.locality !== "on-device" && input.locality !== "self-hosted") {
    throw new CadenceSchedulerError("invalid locality", {
      obligation: "cadence.locality_forbidden",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }

  const meta = { subjectId: input.subjectId, deviceId: input.deviceId };
  if (
    input.evidence.lineage.subjectId !== input.subjectId ||
    input.evidence.lineage.deviceId !== input.deviceId ||
    input.evidence.redTeam.subjectId !== input.subjectId ||
    input.evidence.redTeam.deviceId !== input.deviceId ||
    input.evidence.lineage.locality !== input.locality ||
    input.evidence.redTeam.locality !== input.locality
  ) {
    throw new CadenceSchedulerError(
      "verdict evidence crosses the cadence subject or locality boundary",
      {
        obligation: "cadence.cross_subject_denied",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  assertOneSurgeryKind(input.surgeryKind, input.surgeryKinds, meta);
  assertEvalPin(input.evalPin, meta);

  const receiptKey = [input.cycleId, input.subjectId, input.deviceId].join("|");
  const prior = cycleReceipts.get(receiptKey);
  if (prior !== undefined) {
    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "idempotent_replay",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "cycle_complete",
      cycleId: input.cycleId,
      verdict: prior.verdict.verdict,
    });
    return { ...prior, idempotent: true };
  }

  if (subjectLocks.has(input.subjectId)) {
    throw new CadenceSchedulerError(
      "concurrent cadence cycle for the same subjectId is forbidden",
      {
        obligation: "cadence.idempotent_conflict",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }
  if (cycleReceipts.size >= CADENCE_OPERATION_LIMIT) {
    throw new CadenceSchedulerError("cadence cycle capacity exceeded", {
      obligation: "cadence.capacity",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }

  subjectLocks.add(input.subjectId);
  const stagesCompleted: CadenceStage[] = [];
  const timeoutMs = input.stageTimeoutMs ?? CADENCE_DEFAULT_STAGE_TIMEOUT_MS;
  const minTrajectories = input.minTrajectories ?? CADENCE_MIN_TRAJECTORIES;
  const completedAt = (input.now ?? (() => new Date().toISOString()))();
  let candidateId: string | null = null;
  let checkpointHash: string | null = null;
  let durableStageStarted = false;

  try {
    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "cycle_start",
      cycleId: input.cycleId,
      surgeryKind: input.surgeryKind,
    });

    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "collect",
    });
    const collected = await withTimeout(
      Promise.resolve(input.handlers.collect()),
      timeoutMs,
      "collect",
      meta,
    );
    assertMetadataOnly(collected, "collect result", meta);
    if (
      !Number.isInteger(collected.trajectoryCount) ||
      collected.trajectoryCount < 0
    ) {
      throw new CadenceSchedulerError("collect returned invalid trajectoryCount", {
        obligation: "cadence.invalid_input",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        stage: "collect",
      });
    }
    stagesCompleted.push("collect");
    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "collect",
      trajectoryCount: collected.trajectoryCount,
    });

    if (collected.trajectoryCount < minTrajectories) {
      const skip = createSkipVerdict({
        cycleId: input.cycleId,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        locality: input.locality,
        reason: "insufficient_trajectories",
        completedAt,
        stagesCompleted,
      });
      const report: CadenceCycleReport = {
        schemaVersion: CADENCE_SCHEDULER_SCHEMA_VERSION,
        cycleId: input.cycleId,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        locality: input.locality,
        surgeryKind: null,
        stagesCompleted: Object.freeze([...stagesCompleted]),
        verdict: skip,
        candidateId: null,
        checkpointHash: null,
        evidenceBundle: null,
        idempotent: false,
      };
      cycleReceipts.set(receiptKey, report);
      emit(input.onTelemetry, {
        event: "learning.cadence.scheduler",
        outcome: "skip",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        action: "skip",
        cycleId: input.cycleId,
        trajectoryCount: collected.trajectoryCount,
        verdict: "skip",
      });
      return report;
    }

    durableStageStarted = true;
    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "score",
    });
    const scored = await withTimeout(
      Promise.resolve(input.handlers.score()),
      timeoutMs,
      "score",
      meta,
    );
    assertMetadataOnly(scored, "score result", meta);
    stagesCompleted.push("score");

    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "train",
    });
    const trained = await withTimeout(
      Promise.resolve(input.handlers.train()),
      timeoutMs,
      "train",
      meta,
    );
    assertMetadataOnly(trained, "train result", meta);
    if (
      !ID_RE.test(trained.candidateId) ||
      !HASH_RE.test(trained.checkpointHash)
    ) {
      throw new CadenceSchedulerError(
        "train must return candidateId and checkpoint hash",
        {
          obligation: "cadence.invalid_input",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          stage: "train",
        },
      );
    }
    candidateId = trained.candidateId;
    checkpointHash = trained.checkpointHash;
    if (
      input.evidence.redTeam.candidateId !== candidateId ||
      input.evidence.lineage.checkpointHash !== checkpointHash
    ) {
      throw new CadenceSchedulerError(
        "candidate/checkpoint does not match supplied verdict evidence",
        {
          obligation: "cadence.cross_subject_denied",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          stage: "train",
        },
      );
    }
    stagesCompleted.push("train");

    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "shadow",
    });
    const shadowed = await withTimeout(
      Promise.resolve(input.handlers.shadow()),
      timeoutMs,
      "shadow",
      meta,
    );
    assertMetadataOnly(shadowed, "shadow result", meta);
    stagesCompleted.push("shadow");
    if (!shadowed.comparisonOk) {
      return rejectReport({
        cycleId: input.cycleId,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        locality: input.locality,
        surgeryKind: input.surgeryKind,
        stagesCompleted,
        candidateId,
        checkpointHash,
        completedAt,
        failingSlice: shadowed.failingSlice ?? "shadow.comparison",
        stage: "shadow",
        receiptKey,
        ...(input.onTelemetry !== undefined
          ? { onTelemetry: input.onTelemetry }
          : {}),
      });
    }

    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "canary",
    });
    const canaried = await withTimeout(
      Promise.resolve(input.handlers.canary()),
      timeoutMs,
      "canary",
      meta,
    );
    assertMetadataOnly(canaried, "canary result", meta);
    stagesCompleted.push("canary");
    if (canaried.status === "halted") {
      return rejectReport({
        cycleId: input.cycleId,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        locality: input.locality,
        surgeryKind: input.surgeryKind,
        stagesCompleted,
        candidateId,
        checkpointHash,
        completedAt,
        failingSlice: canaried.failingSlice ?? "canary.drift",
        stage: "canary",
        receiptKey,
        ...(input.onTelemetry !== undefined
          ? { onTelemetry: input.onTelemetry }
          : {}),
      });
    }

    if (input.humanReviewDeadline !== undefined) {
      const deadlineMs = Date.parse(input.humanReviewDeadline);
      const nowMs = Date.parse(completedAt);
      if (
        Number.isFinite(deadlineMs) &&
        Number.isFinite(nowMs) &&
        nowMs > deadlineMs
      ) {
        const expired = createExpiredVerdict({
          cycleId: input.cycleId,
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          locality: input.locality,
          surgeryKind: input.surgeryKind,
          completedAt,
          stagesCompleted,
        });
        const report: CadenceCycleReport = {
          schemaVersion: CADENCE_SCHEDULER_SCHEMA_VERSION,
          cycleId: input.cycleId,
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          locality: input.locality,
          surgeryKind: input.surgeryKind,
          stagesCompleted: Object.freeze([...stagesCompleted]),
          verdict: expired,
          candidateId,
          checkpointHash,
          evidenceBundle: null,
          idempotent: false,
        };
        cycleReceipts.set(receiptKey, report);
        emit(input.onTelemetry, {
          event: "learning.cadence.scheduler",
          outcome: "expired",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          action: "expire",
          cycleId: input.cycleId,
          verdict: "expired",
        });
        return report;
      }
    }

    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "stage",
      cycleId: input.cycleId,
      stage: "gate",
    });
    stagesCompleted.push("gate");
    const automated = createAutomatedVerdictBundle({
      cycleId: input.cycleId,
      candidateId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      surgeryKind: input.surgeryKind,
      surgeryKinds: input.surgeryKinds,
      createdAt: completedAt,
      lineage: input.evidence.lineage,
      evalPin: input.evalPin,
      slices: input.sliceScores,
      redTeam: input.evidence.redTeam,
      stagesCompleted,
      ...(input.onVerdictBundleTelemetry !== undefined
        ? { onTelemetry: input.onVerdictBundleTelemetry }
        : {}),
    });
    const verdict = automated.cycleVerdict;

    // Invariant check: reject cannot be human-overridden to promote.
    const override = assertHumanCannotOverrideFailingVerdict({
      automated: verdict,
      humanRequested: "promote",
    });
    if (!override.ok && verdict.verdict === "reject") {
      emit(input.onTelemetry, {
        event: "learning.cadence.scheduler",
        outcome: "rejected",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        action: "gate",
        cycleId: input.cycleId,
        failureClass: "cadence.human_override_forbidden",
        verdict: "reject",
      });
    }

    const report: CadenceCycleReport = {
      schemaVersion: CADENCE_SCHEDULER_SCHEMA_VERSION,
      cycleId: input.cycleId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      surgeryKind: input.surgeryKind,
      stagesCompleted: Object.freeze([...stagesCompleted]),
      verdict,
      candidateId,
      checkpointHash,
      evidenceBundle: automated.bundle,
      idempotent: false,
    };
    cycleReceipts.set(receiptKey, report);
    emit(input.onTelemetry, {
      event: "learning.cadence.scheduler",
      outcome: verdict.verdict === "reject" ? "rejected" : "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      action: "cycle_complete",
      cycleId: input.cycleId,
      stage: "gate",
      verdict: verdict.verdict,
      ...(verdict.failingSlice !== null
        ? { failingSlice: verdict.failingSlice }
        : {}),
    });
    return report;
  } catch (error) {
    if (durableStageStarted && !(error instanceof CadenceSchedulerError)) {
      throw new CadenceSchedulerError(
        `partial cadence failure after durable stage: ${
          error instanceof Error ? error.message : "unknown"
        }`,
        {
          obligation: "cadence.partial_failure",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          stage: stagesCompleted[stagesCompleted.length - 1],
        },
      );
    }
    throw error;
  } finally {
    subjectLocks.delete(input.subjectId);
  }
}

/** Clear cycle receipts + locks (tests only). */
export function resetCadenceSchedulerReceipts(): void {
  cycleReceipts.clear();
  subjectLocks.clear();
}

export const CADENCE_TEST_REGISTRY_SCHEMA_VERSION =
  "cadence.test-promotion-registry.v1" as const;
export const CADENCE_TEST_REGISTRY_LIMIT = 64 as const;
export const CADENCE_SYNTHETIC_TRAJECTORY_COUNT = 8 as const;

export type CadenceTestPromotedRecord = {
  schemaVersion: typeof CADENCE_TEST_REGISTRY_SCHEMA_VERSION;
  cycleId: string;
  candidateId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  surgeryKind: CadenceSurgeryKind;
  checkpointHash: string;
  promotedAt: string;
  evidenceReason: string;
  /** Count of synthetic consented trajectories feeding the cycle — never raw text. */
  trajectoryCount: number;
  revision: number;
};

export type CadenceTestRegistryTelemetryEvent = {
  event: "learning.cadence.test_registry";
  outcome: "ok" | "rejected" | "idempotent_replay";
  subjectId: string;
  deviceId: string;
  cycleId?: string;
  candidateId?: string;
  failureClass?: CadenceFailureClass;
};

/**
 * In-memory subject-scoped registry for synthetic cadence promotion proofs.
 * Only automated promote verdicts with evidence may admit; humans cannot force entry.
 */
export class CadenceTestPromotionRegistry {
  private readonly subjectId: string;
  private readonly deviceId: string;
  private readonly onTelemetry:
    | ((event: CadenceTestRegistryTelemetryEvent) => void)
    | undefined;
  private readonly byCandidate = new Map<string, CadenceTestPromotedRecord>();
  private revision = 0;

  constructor(options: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (event: CadenceTestRegistryTelemetryEvent) => void;
  }) {
    if (!ID_RE.test(options.subjectId) || !ID_RE.test(options.deviceId)) {
      throw new CadenceSchedulerError(
        "test registry requires stable subject/device ids",
        { obligation: "cadence.invalid_input" },
      );
    }
    this.subjectId = options.subjectId;
    this.deviceId = options.deviceId;
    this.onTelemetry = options.onTelemetry;
  }

  get currentRevision(): number {
    return this.revision;
  }

  admitFromCycleReport(input: {
    report: CadenceCycleReport;
    trajectoryCount: number;
  }):
    | { ok: true; record: CadenceTestPromotedRecord; idempotentReplay: boolean }
    | { ok: false; obligation: CadenceFailureClass } {
    const report = input.report;
    assertMetadataOnly(report, "cycle report", {
      subjectId: this.subjectId,
      deviceId: this.deviceId,
    });
    if (
      report.subjectId !== this.subjectId ||
      report.deviceId !== this.deviceId
    ) {
      this.onTelemetry?.({
        event: "learning.cadence.test_registry",
        outcome: "rejected",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        cycleId: report.cycleId,
        failureClass: "cadence.cross_subject_denied",
      });
      return { ok: false, obligation: "cadence.cross_subject_denied" };
    }
    if (
      report.verdict.verdict !== "promote" ||
      report.candidateId === null ||
      report.checkpointHash === null ||
      report.surgeryKind === null ||
      report.evidenceBundle === null ||
      report.evidenceBundle.verdict !== "promote"
    ) {
      this.onTelemetry?.({
        event: "learning.cadence.test_registry",
        outcome: "rejected",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
        cycleId: report.cycleId,
        failureClass: "cadence.human_override_forbidden",
      });
      return { ok: false, obligation: "cadence.human_override_forbidden" };
    }
    if (
      !Number.isInteger(input.trajectoryCount) ||
      input.trajectoryCount < CADENCE_MIN_TRAJECTORIES
    ) {
      return { ok: false, obligation: "cadence.invalid_input" };
    }

    const existing = this.byCandidate.get(report.candidateId);
    if (existing !== undefined) {
      if (
        existing.cycleId === report.cycleId &&
        existing.checkpointHash === report.checkpointHash
      ) {
        this.onTelemetry?.({
          event: "learning.cadence.test_registry",
          outcome: "idempotent_replay",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
          cycleId: report.cycleId,
          candidateId: report.candidateId,
        });
        return { ok: true, record: existing, idempotentReplay: true };
      }
      return { ok: false, obligation: "cadence.idempotent_conflict" };
    }
    if (this.byCandidate.size >= CADENCE_TEST_REGISTRY_LIMIT) {
      return { ok: false, obligation: "cadence.capacity" };
    }

    this.revision += 1;
    const record: CadenceTestPromotedRecord = Object.freeze({
      schemaVersion: CADENCE_TEST_REGISTRY_SCHEMA_VERSION,
      cycleId: report.cycleId,
      candidateId: report.candidateId,
      subjectId: report.subjectId,
      deviceId: report.deviceId,
      locality: report.locality,
      surgeryKind: report.surgeryKind,
      checkpointHash: report.checkpointHash,
      promotedAt: report.verdict.completedAt,
      evidenceReason: report.evidenceBundle.reason,
      trajectoryCount: input.trajectoryCount,
      revision: this.revision,
    });
    this.byCandidate.set(report.candidateId, record);
    this.onTelemetry?.({
      event: "learning.cadence.test_registry",
      outcome: "ok",
      subjectId: this.subjectId,
      deviceId: this.deviceId,
      cycleId: report.cycleId,
      candidateId: report.candidateId,
    });
    return { ok: true, record, idempotentReplay: false };
  }

  get(input: {
    subjectId: string;
    candidateId: string;
  }): CadenceTestPromotedRecord | undefined {
    if (input.subjectId !== this.subjectId) {
      throw new CadenceSchedulerError(
        "cross-subject test registry read denied",
        {
          obligation: "cadence.cross_subject_denied",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    return this.byCandidate.get(input.candidateId);
  }

  list(input: {
    subjectId: string;
    limit?: number;
  }): readonly CadenceTestPromotedRecord[] {
    if (input.subjectId !== this.subjectId) {
      throw new CadenceSchedulerError(
        "cross-subject test registry list denied",
        {
          obligation: "cadence.cross_subject_denied",
          subjectId: this.subjectId,
          deviceId: this.deviceId,
        },
      );
    }
    const limit = input.limit ?? CADENCE_TEST_REGISTRY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CADENCE_TEST_REGISTRY_LIMIT) {
      throw new CadenceSchedulerError("test registry list limit out of bounds", {
        obligation: "cadence.section_limit",
        subjectId: this.subjectId,
        deviceId: this.deviceId,
      });
    }
    return Object.freeze([...this.byCandidate.values()].slice(0, limit));
  }
}

const SYNTH_CHECKPOINT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SYNTH_REGISTRY =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SYNTH_MANIFEST =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SYNTH_SUITE =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const SYNTH_PARENT =
  "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SYNTH_BASE =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function synthEvidence(input: {
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  candidateId: string;
  checkpointHash?: string;
}): CadenceVerdictEvidence {
  const checkpointHash = input.checkpointHash ?? SYNTH_CHECKPOINT;
  return {
    lineage: {
      schemaVersion: "checkpoint.lineage.v1",
      runId: "run.cadence.synth.01",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      checkpointHash,
      parentCheckpointHash: SYNTH_PARENT,
      corpusManifestHash: SYNTH_MANIFEST,
      baseModelHash: SYNTH_BASE,
      signerId: "trainer.cadence.synth",
      signedAt: "2026-07-17T11:00:00.000Z",
      signature: "signed-cadence-synth-evidence-0001",
      verified: true,
    },
    redTeam: {
      suiteId: "candidate-red-team",
      suiteManifestHash: SYNTH_SUITE,
      candidateId: input.candidateId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      verdict: "pass",
      completedAt: "2026-07-17T11:30:00.000Z",
      failingScenarioIds: [],
    },
  };
}

function synthHandlers(input: {
  candidateId: string;
  trajectoryCount?: number;
  overrides?: Partial<CadenceStageHandlers>;
}): CadenceStageHandlers {
  const trajectoryCount =
    input.trajectoryCount ?? CADENCE_SYNTHETIC_TRAJECTORY_COUNT;
  return {
    collect: () => ({
      trajectoryCount,
      consentClass: "research",
    }),
    score: () => ({
      criticVersion: "critic.synth.v1",
      scoredCount: trajectoryCount,
    }),
    train: () => ({
      candidateId: input.candidateId,
      checkpointHash: SYNTH_CHECKPOINT,
    }),
    shadow: () => ({ comparisonOk: true }),
    canary: () => ({ status: "healthy" }),
    ...input.overrides,
  };
}

export type SyntheticCadenceIntegrationProof = {
  ok: true;
  promotedInRegistry: boolean;
  candidateId: string;
  rejectedFailingSlice: string;
  twoSurgeryRejected: boolean;
  skipEmitted: boolean;
  expiredWithoutPromote: boolean;
  trainOnEvalVoid: boolean;
  subjectIsolated: boolean;
  humanCannotOverrideReject: boolean;
  idempotentReplay: boolean;
  stagesCompleted: readonly CadenceStage[];
  registryRevision: number;
};

/**
 * End-to-end synthetic cadence proof: promote → test registry, named-slice
 * reject, and two-surgery attribution void in one integration session.
 */
export async function proveSyntheticCadenceCycleIntegration(opts?: {
  onTelemetry?: (event: CadenceTelemetryEvent) => void;
  onRegistryTelemetry?: (event: CadenceTestRegistryTelemetryEvent) => void;
  onVerdictBundleTelemetry?: (
    event: CadenceVerdictBundleTelemetryEvent,
  ) => void;
}): Promise<SyntheticCadenceIntegrationProof> {
  resetCadenceSchedulerReceipts();

  const subjectId = "subject.cadence.synth";
  const deviceId = "device.cadence.synth";
  const locality = "on-device" as const;
  const candidateId = "candidate.cadence.synth.promote";
  const evalPin: CadenceEvalPin = {
    baselineRegistryHash: SYNTH_REGISTRY,
    baselineFrozen: true,
    baselineDecontaminated: true,
    pinnedSeed: "seed.cadence.synth",
  };
  const greenSlices: CadenceSliceScore[] = [
    {
      sliceId: "teacher/en/b8",
      championScore: 0.88,
      challengerScore: 0.93,
      tolerance: 0.02,
    },
    {
      sliceId: "doctor/en/b8",
      championScore: 0.8,
      challengerScore: 0.86,
      tolerance: 0.02,
    },
  ];

  const registry = new CadenceTestPromotionRegistry({
    subjectId,
    deviceId,
    ...(opts?.onRegistryTelemetry !== undefined
      ? { onTelemetry: opts.onRegistryTelemetry }
      : {}),
  });

  const promoted = await runCadenceCycle({
    cycleId: "cycle.synth.promote",
    subjectId,
    deviceId,
    locality,
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin,
    sliceScores: greenSlices,
    evidence: synthEvidence({
      subjectId,
      deviceId,
      locality,
      candidateId,
    }),
    handlers: synthHandlers({ candidateId }),
    now: () => "2026-07-17T14:00:00.000Z",
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
    ...(opts?.onVerdictBundleTelemetry !== undefined
      ? { onVerdictBundleTelemetry: opts.onVerdictBundleTelemetry }
      : {}),
  });

  const admitted = registry.admitFromCycleReport({
    report: promoted,
    trajectoryCount: CADENCE_SYNTHETIC_TRAJECTORY_COUNT,
  });
  const replayed = registry.admitFromCycleReport({
    report: promoted,
    trajectoryCount: CADENCE_SYNTHETIC_TRAJECTORY_COUNT,
  });

  resetCadenceSchedulerReceipts();
  const rejectCandidate = "candidate.cadence.synth.regress";
  const rejected = await runCadenceCycle({
    cycleId: "cycle.synth.regress",
    subjectId,
    deviceId,
    locality,
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin,
    sliceScores: [
      {
        sliceId: "teacher/hi/b8",
        championScore: 0.9,
        challengerScore: 0.4,
        tolerance: 0.05,
      },
      {
        sliceId: "doctor/en/b8",
        championScore: 0.8,
        challengerScore: 0.85,
        tolerance: 0.02,
      },
    ],
    evidence: synthEvidence({
      subjectId,
      deviceId,
      locality,
      candidateId: rejectCandidate,
    }),
    handlers: synthHandlers({ candidateId: rejectCandidate }),
    now: () => "2026-07-17T14:01:00.000Z",
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  const rejectAdmit = registry.admitFromCycleReport({
    report: rejected,
    trajectoryCount: CADENCE_SYNTHETIC_TRAJECTORY_COUNT,
  });
  const override = assertHumanCannotOverrideFailingVerdict({
    automated: rejected.verdict,
    humanRequested: "promote",
  });

  resetCadenceSchedulerReceipts();
  let twoSurgeryRejected = false;
  try {
    await runCadenceCycle({
      cycleId: "cycle.synth.two-surgery",
      subjectId,
      deviceId,
      locality,
      surgeryKind: "adapter",
      surgeryKinds: ["adapter", "critic"],
      evalPin,
      sliceScores: greenSlices,
      evidence: synthEvidence({
        subjectId,
        deviceId,
        locality,
        candidateId: "candidate.cadence.synth.two",
      }),
      handlers: synthHandlers({
        candidateId: "candidate.cadence.synth.two",
      }),
      now: () => "2026-07-17T14:02:00.000Z",
    });
  } catch (error) {
    twoSurgeryRejected =
      error instanceof CadenceSchedulerError &&
      error.obligation === "cadence.attribution_void";
  }

  resetCadenceSchedulerReceipts();
  const skipped = await runCadenceCycle({
    cycleId: "cycle.synth.skip",
    subjectId,
    deviceId,
    locality,
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin,
    sliceScores: greenSlices,
    evidence: synthEvidence({
      subjectId,
      deviceId,
      locality,
      candidateId,
    }),
    handlers: synthHandlers({
      candidateId,
      trajectoryCount: 1,
    }),
    now: () => "2026-07-17T14:03:00.000Z",
  });

  resetCadenceSchedulerReceipts();
  const expired = await runCadenceCycle({
    cycleId: "cycle.synth.expired",
    subjectId,
    deviceId,
    locality,
    surgeryKind: "adapter",
    surgeryKinds: ["adapter"],
    evalPin,
    sliceScores: greenSlices,
    evidence: synthEvidence({
      subjectId,
      deviceId,
      locality,
      candidateId: "candidate.cadence.synth.expired",
    }),
    handlers: synthHandlers({
      candidateId: "candidate.cadence.synth.expired",
    }),
    humanReviewDeadline: "2026-07-01T00:00:00.000Z",
    now: () => "2026-07-17T14:04:00.000Z",
  });

  resetCadenceSchedulerReceipts();
  let trainOnEvalVoid = false;
  try {
    await runCadenceCycle({
      cycleId: "cycle.synth.void",
      subjectId,
      deviceId,
      locality,
      surgeryKind: "adapter",
      surgeryKinds: ["adapter"],
      evalPin: { ...evalPin, baselineFrozen: false },
      sliceScores: greenSlices,
      evidence: synthEvidence({
        subjectId,
        deviceId,
        locality,
        candidateId,
      }),
      handlers: synthHandlers({ candidateId }),
    });
  } catch (error) {
    trainOnEvalVoid =
      error instanceof CadenceSchedulerError &&
      error.obligation === "cadence.train_on_eval_void";
  }

  resetCadenceSchedulerReceipts();
  const otherSubject = "subject.cadence.synth.other";
  const otherCandidate = "candidate.cadence.synth.other";
  const other = await runCadenceCycle({
    cycleId: "cycle.synth.other",
    subjectId: otherSubject,
    deviceId,
    locality: "self-hosted",
    surgeryKind: "critic",
    surgeryKinds: ["critic"],
    evalPin,
    sliceScores: greenSlices,
    evidence: synthEvidence({
      subjectId: otherSubject,
      deviceId,
      locality: "self-hosted",
      candidateId: otherCandidate,
    }),
    handlers: synthHandlers({ candidateId: otherCandidate }),
    now: () => "2026-07-17T14:05:00.000Z",
  });
  const crossSubjectDenied = registry.admitFromCycleReport({
    report: other,
    trajectoryCount: CADENCE_SYNTHETIC_TRAJECTORY_COUNT,
  });
  let subjectIsolated = false;
  try {
    registry.get({ subjectId: otherSubject, candidateId: otherCandidate });
  } catch (error) {
    subjectIsolated =
      error instanceof CadenceSchedulerError &&
      error.obligation === "cadence.cross_subject_denied";
  }

  const listed = registry.list({ subjectId });
  return {
    ok: true,
    promotedInRegistry:
      admitted.ok === true &&
      admitted.idempotentReplay === false &&
      listed.length === 1 &&
      listed[0]?.candidateId === candidateId,
    candidateId,
    rejectedFailingSlice: rejected.verdict.failingSlice ?? "",
    twoSurgeryRejected,
    skipEmitted: skipped.verdict.verdict === "skip",
    expiredWithoutPromote:
      expired.verdict.verdict === "expired" &&
      expired.verdict.expiredForHumanReview === true,
    trainOnEvalVoid,
    subjectIsolated:
      subjectIsolated && crossSubjectDenied.ok === false,
    humanCannotOverrideReject:
      override.ok === false && rejectAdmit.ok === false,
    idempotentReplay:
      replayed.ok === true && replayed.idempotentReplay === true,
    stagesCompleted: promoted.stagesCompleted,
    registryRevision: registry.currentRevision,
  };
}

export { assertHumanCannotOverrideFailingVerdict, CADENCE_SURGERY_KINDS };
