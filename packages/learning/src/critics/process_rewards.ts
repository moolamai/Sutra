/**
 * Process-reward correction-cycle features + shaping (C3).
 *
 * Extracts repair depth + first-pass tool validity from trajectory records,
 * then shapes a bounded process component. Cap aligns with harness
 * MAX_CORRECTION_TURNS — retry loops cannot farm unbounded process signal.
 * |process| ≤ PROCESS_REWARD_ABS_CAP so core-rubric obligation (−2.0) always
 * dominates net total.
 *
 * Pure / deterministic. No network, no LLM, never persists utterance bodies.
 */

import {
  CriticContractError,
  assertCriticScore,
  createCriticScore,
  isRewardHackFixture,
  type CriticScore,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.js";
import type { TurnTrajectoryRecord } from "../trajectory_schema.js";

/**
 * Per-turn correction cap — MUST match
 * `packages/runtime-harness` MAX_CORRECTION_TURNS (B4 / CK-07).
 */
export const MAX_CORRECTION_TURNS = 8 as const;

/**
 * Dominance cap: |process| never exceeds this magnitude.
 * Core-rubric invariant/obligation is −2.0; human ACCEPTED is +1.0 —
 * process must remain strictly smaller so outcome truth dominates.
 * Aligns with harness PROCESS_REWARD_ABS_CAP.
 */
export const PROCESS_REWARD_ABS_CAP = 0.5 as const;

/** Modest first-pass tool validity bonus (≪ ACCEPTED +1.0). */
export const PROCESS_FIRST_PASS_BONUS = 0.25 as const;

/** Per-repair-depth penalty (clamped by PROCESS_REWARD_ABS_CAP). */
export const PROCESS_REPAIR_PENALTY_PER_DEPTH = 0.1 as const;

/**
 * Minimum process score when correction depth hits MAX_CORRECTION_TURNS —
 * no further farming by deeper retries.
 */
export const PROCESS_MIN_SCORE = -PROCESS_REWARD_ABS_CAP;

/** Outcome obligation magnitude used to prove dominance (core rubric). */
export const PROCESS_OUTCOME_OBLIGATION_PENALTY = -2.0 as const;

export const PROCESS_RUBRIC_ID = "critic.process-rewards" as const;
export const PROCESS_RUBRIC_VERSION = "1.0.0" as const;

/**
 * Repo-relative correction-loop process-reward fixtures (invalid→valid,
 * farming, cap breach, synthetic retry, reward-hack).
 */
export const PROCESS_REWARD_GOLDEN_FIXTURES_RELPATH =
  "training/critics/fixtures/process-rewards" as const;

export const PROCESS_REWARD_GOLDEN_BRANCHES = Object.freeze([
  "first_pass_valid",
  "invalid_then_valid",
  "retry_loop_farming",
  "cap_breach",
  "synthetic_retry",
  "reward_hack",
  "farming_plus_obligation",
] as const);

export type ProcessRewardFailureClass =
  | "process.missing_subject"
  | "process.invalid_depth"
  | "process.reward_hack"
  | "process.dominance_breach";

export type ProcessRewardTelemetryEvent = {
  event:
    | "learning.critic.process_features"
    | "learning.critic.process_score";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  turnId?: string;
  correctionDepth?: number;
  effectiveDepth?: number;
  cappedAtMax?: boolean;
  firstPassValidToolCall?: boolean;
  firstPassBonusEligible?: boolean;
  processTotal?: number;
  processCapped?: boolean;
  failureClass?: ProcessRewardFailureClass;
  breakdownKeys?: string[];
};

/**
 * Correction-cycle features for process-reward critics.
 * Structural twin of harness `CorrectionCycleFeatures`.
 */
export type CorrectionCycleFeatures = {
  subjectId: string;
  turnId: string;
  deviceId?: string;
  correctionDepth: number;
  maxCorrectionTurns: number;
  effectiveDepth: number;
  cappedAtMax: boolean;
  firstPassValidToolCall: boolean;
  firstPassBonusEligible: boolean;
  syntheticRetryAfterExhaustion: boolean;
};

export type ProcessRewardTrajectory = TurnTrajectoryRecord & {
  /** Explicit harness depth when present. */
  correctionDepth?: number;
  /** Alias used by core-rubric fixtures. */
  correctionCycleCount?: number;
  amendsTurnId?: string;
  /** Host escalated CORRECTION_EXHAUSTED on this (or prior) turn. */
  correctionExhausted?: boolean;
  /** Synthetic retry after cap escalation — never earns first-pass bonus. */
  syntheticRetryAfterExhaustion?: boolean;
};

export type ProcessRewardShaped = {
  total: number;
  breakdown: Record<string, number>;
  features: CorrectionCycleFeatures;
  /** True when raw shaping was clamped to PROCESS_REWARD_ABS_CAP. */
  dominanceCapped: boolean;
  /** True when floor applied for MAX_CORRECTION_TURNS exhaustion. */
  minScoreApplied: boolean;
};

export class ProcessRewardContractError extends Error {
  readonly obligation: ProcessRewardFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: ProcessRewardFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "ProcessRewardContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

/** Count repair / correct stages (bounded by stage list length). */
export function countRepairStages(record: ProcessRewardTrajectory): number {
  const stages = record.stages ?? [];
  let n = 0;
  for (const s of stages) {
    if (
      s.stage.includes("repair") ||
      s.stage.includes("correct") ||
      s.opCode?.includes("repair") === true ||
      s.opCode?.includes("correct") === true
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * Derive correction depth from trajectory telemetry fields.
 * Prefer explicit depth / cycle count; else repair stages + amendsTurnId.
 */
export function countCorrectionDepth(record: ProcessRewardTrajectory): number {
  if (
    typeof record.correctionDepth === "number" &&
    Number.isFinite(record.correctionDepth)
  ) {
    return Math.max(0, Math.floor(record.correctionDepth));
  }
  if (
    typeof record.correctionCycleCount === "number" &&
    Number.isFinite(record.correctionCycleCount)
  ) {
    return Math.max(0, Math.floor(record.correctionCycleCount));
  }
  let depth = countRepairStages(record);
  if (
    typeof record.amendsTurnId === "string" &&
    record.amendsTurnId.length > 0
  ) {
    depth = Math.max(depth, 1);
  }
  if (record.correctionExhausted === true) {
    depth = Math.max(depth, MAX_CORRECTION_TURNS);
  }
  return depth;
}

/**
 * First-pass valid tool call: zero prior repairs and at least one successful
 * tool-bearing stage (or toolCallIds with an ok stage).
 */
export function detectFirstPassValidToolCall(
  record: ProcessRewardTrajectory,
  correctionDepth: number,
): boolean {
  if (correctionDepth > 0) return false;
  if (record.syntheticRetryAfterExhaustion === true) return false;
  if (record.correctionExhausted === true) return false;
  if (isRewardHackFixture(record)) return false;

  const stages = record.stages ?? [];
  const toolOk = stages.some(
    (s) =>
      (s.status === "ok" || s.status === undefined) &&
      (s.opCode?.includes("tool") === true ||
        s.stage === "act" ||
        s.stage === "tool"),
  );
  if (toolOk) return true;

  const ids = record.toolCallIds ?? [];
  if (ids.length > 0 && ids.length <= 16) {
    return stages.some((s) => s.status === "ok" || s.status === undefined);
  }
  return false;
}

/**
 * Extract correction-cycle features from a trajectory record.
 * Respects MAX_CORRECTION_TURNS — depth above the cap is clamped; first-pass
 * bonus is ineligible when capped or on synthetic post-exhaustion retries.
 */
export function extractCorrectionCycleFeatures(
  record: ProcessRewardTrajectory,
  opts?: {
    maxCorrectionTurns?: number;
    onTelemetry?: (e: ProcessRewardTelemetryEvent) => void;
  },
): CorrectionCycleFeatures {
  const subjectId =
    typeof record?.subjectId === "string" && record.subjectId.length > 0
      ? record.subjectId
      : "";
  const deviceId =
    typeof record?.deviceId === "string" && record.deviceId.length > 0
      ? record.deviceId
      : "unknown";
  const turnId =
    typeof record?.turnId === "string" && record.turnId.length > 0
      ? record.turnId
      : "";

  if (!subjectId) {
    opts?.onTelemetry?.({
      event: "learning.critic.process_features",
      outcome: "fail",
      subjectId: "unknown",
      deviceId,
      failureClass: "process.missing_subject",
    });
    throw new ProcessRewardContractError("subjectId required on trajectory", {
      obligation: "process.missing_subject",
      deviceId,
    });
  }
  if (!turnId) {
    opts?.onTelemetry?.({
      event: "learning.critic.process_features",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "process.invalid_depth",
    });
    throw new ProcessRewardContractError("turnId required on trajectory", {
      obligation: "process.invalid_depth",
      subjectId,
      deviceId,
    });
  }

  const max =
    opts?.maxCorrectionTurns !== undefined
      ? opts.maxCorrectionTurns
      : MAX_CORRECTION_TURNS;
  if (!Number.isInteger(max) || max < 1 || max > 64) {
    throw new ProcessRewardContractError(
      "maxCorrectionTurns must be an integer in 1..64",
      {
        obligation: "process.invalid_depth",
        subjectId,
        deviceId,
      },
    );
  }

  const rawDepth = countCorrectionDepth(record);
  const cappedAtMax =
    rawDepth >= max || record.correctionExhausted === true;
  const effectiveDepth = Math.min(rawDepth, max);
  const synthetic = record.syntheticRetryAfterExhaustion === true;
  const hack = isRewardHackFixture(record);

  let firstPassValid = detectFirstPassValidToolCall(record, effectiveDepth);
  if (synthetic || cappedAtMax || hack) {
    firstPassValid = false;
  }
  const firstPassBonusEligible = firstPassValid;

  const features: CorrectionCycleFeatures = {
    subjectId,
    turnId,
    correctionDepth: rawDepth,
    maxCorrectionTurns: max,
    effectiveDepth,
    cappedAtMax,
    firstPassValidToolCall: firstPassValid,
    firstPassBonusEligible,
    syntheticRetryAfterExhaustion: synthetic,
  };
  if (record.deviceId !== undefined && record.deviceId.length > 0) {
    features.deviceId = record.deviceId;
  }

  opts?.onTelemetry?.({
    event: "learning.critic.process_features",
    outcome: hack ? "advisory" : "ok",
    subjectId,
    deviceId,
    turnId,
    correctionDepth: rawDepth,
    effectiveDepth,
    cappedAtMax,
    firstPassValidToolCall: firstPassValid,
    firstPassBonusEligible,
    ...(hack ? { failureClass: "process.reward_hack" as const } : {}),
  });

  return features;
}

/** Clamp a process total into [-PROCESS_REWARD_ABS_CAP, +PROCESS_REWARD_ABS_CAP]. */
export function clampProcessRewardMagnitude(raw: number): {
  total: number;
  dominanceCapped: boolean;
} {
  if (!Number.isFinite(raw)) {
    return { total: 0, dominanceCapped: true };
  }
  if (raw > PROCESS_REWARD_ABS_CAP) {
    return { total: PROCESS_REWARD_ABS_CAP, dominanceCapped: true };
  }
  if (raw < -PROCESS_REWARD_ABS_CAP) {
    return { total: -PROCESS_REWARD_ABS_CAP, dominanceCapped: true };
  }
  return { total: raw, dominanceCapped: false };
}

/**
 * Prove process cannot overturn an obligation penalty (dominance invariant).
 * Throws process.dominance_breach when |process| is too large.
 */
export function assertProcessDominatedByObligation(
  processTotal: number,
  obligationPenalty: number = PROCESS_OUTCOME_OBLIGATION_PENALTY,
): void {
  if (!Number.isFinite(processTotal) || !Number.isFinite(obligationPenalty)) {
    throw new ProcessRewardContractError(
      "process/obligation totals must be finite",
      { obligation: "process.dominance_breach" },
    );
  }
  if (Math.abs(processTotal) > PROCESS_REWARD_ABS_CAP + 1e-12) {
    throw new ProcessRewardContractError(
      `process |${processTotal}| exceeds dominance cap ${PROCESS_REWARD_ABS_CAP}`,
      { obligation: "process.dominance_breach" },
    );
  }
  if (obligationPenalty >= 0) {
    throw new ProcessRewardContractError(
      "obligationPenalty must be strictly negative",
      { obligation: "process.dominance_breach" },
    );
  }
  if (processTotal + obligationPenalty >= 0) {
    throw new ProcessRewardContractError(
      `process ${processTotal} + obligation ${obligationPenalty} must stay net negative`,
      { obligation: "process.dominance_breach" },
    );
  }
}

/**
 * Shape process reward from correction-cycle features.
 * - First-pass validity → modest +PROCESS_FIRST_PASS_BONUS
 * - Repeated repairs → −PROCESS_REPAIR_PENALTY_PER_DEPTH × depth
 * - At/above MAX_CORRECTION_TURNS (or synthetic retry) → PROCESS_MIN_SCORE
 * - Always clamp to PROCESS_REWARD_ABS_CAP
 */
export function shapeProcessReward(
  features: CorrectionCycleFeatures,
  opts?: {
    rewardHack?: boolean;
    onTelemetry?: (e: ProcessRewardTelemetryEvent) => void;
  },
): ProcessRewardShaped {
  const deviceId = features.deviceId ?? "unknown";

  if (opts?.rewardHack === true) {
    const shaped: ProcessRewardShaped = {
      total: 0,
      breakdown: { reward_hack_guard: 0 },
      features,
      dominanceCapped: false,
      minScoreApplied: false,
    };
    opts.onTelemetry?.({
      event: "learning.critic.process_score",
      outcome: "advisory",
      subjectId: features.subjectId,
      deviceId,
      turnId: features.turnId,
      processTotal: 0,
      failureClass: "process.reward_hack",
      breakdownKeys: ["reward_hack_guard"],
    });
    return shaped;
  }

  // Cap exhaustion / synthetic retry: minimum process score — no farming.
  if (features.cappedAtMax || features.syntheticRetryAfterExhaustion) {
    const shaped: ProcessRewardShaped = {
      total: PROCESS_MIN_SCORE,
      breakdown: { process_cap_floor: PROCESS_MIN_SCORE },
      features,
      dominanceCapped: true,
      minScoreApplied: true,
    };
    assertProcessDominatedByObligation(shaped.total);
    opts?.onTelemetry?.({
      event: "learning.critic.process_score",
      outcome: "ok",
      subjectId: features.subjectId,
      deviceId,
      turnId: features.turnId,
      correctionDepth: features.correctionDepth,
      effectiveDepth: features.effectiveDepth,
      cappedAtMax: features.cappedAtMax,
      processTotal: shaped.total,
      processCapped: true,
      breakdownKeys: ["process_cap_floor"],
    });
    return shaped;
  }

  const breakdown: Record<string, number> = {};
  let raw = 0;

  if (features.firstPassBonusEligible) {
    breakdown.first_pass_valid = PROCESS_FIRST_PASS_BONUS;
    raw += PROCESS_FIRST_PASS_BONUS;
  }

  if (features.effectiveDepth > 0) {
    const penalty =
      -PROCESS_REPAIR_PENALTY_PER_DEPTH * features.effectiveDepth;
    breakdown.repair_depth = penalty;
    raw += penalty;
  }

  if (Object.keys(breakdown).length === 0) {
    breakdown.process_neutral = 0;
  }

  const { total, dominanceCapped } = clampProcessRewardMagnitude(raw);
  // When clamped, replace breakdown with a single capped total so
  // CriticScore.total === sum(breakdown).
  const finalBreakdown = dominanceCapped
    ? { process_dominance_cap: total }
    : breakdown;

  const shaped: ProcessRewardShaped = {
    total,
    breakdown: finalBreakdown,
    features,
    dominanceCapped,
    minScoreApplied: false,
  };
  assertProcessDominatedByObligation(shaped.total);

  opts?.onTelemetry?.({
    event: "learning.critic.process_score",
    outcome: "ok",
    subjectId: features.subjectId,
    deviceId,
    turnId: features.turnId,
    correctionDepth: features.correctionDepth,
    effectiveDepth: features.effectiveDepth,
    cappedAtMax: features.cappedAtMax,
    firstPassValidToolCall: features.firstPassValidToolCall,
    firstPassBonusEligible: features.firstPassBonusEligible,
    processTotal: shaped.total,
    processCapped: dominanceCapped,
    breakdownKeys: Object.keys(finalBreakdown).sort(),
  });

  return shaped;
}

/**
 * Extract features and shape process reward for one trajectory.
 */
export function scoreProcessReward(
  record: ProcessRewardTrajectory,
  opts?: {
    maxCorrectionTurns?: number;
    onTelemetry?: (e: ProcessRewardTelemetryEvent) => void;
  },
): ProcessRewardShaped {
  const features = extractCorrectionCycleFeatures(record, opts);
  return shapeProcessReward(features, {
    rewardHack: isRewardHackFixture(record),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
}

/**
 * Pack-pluggable TrajectoryCritic for the process-reward component.
 */
export function createProcessRewardCritic(opts?: {
  onTelemetry?: (e: ProcessRewardTelemetryEvent | CriticTelemetryEvent) => void;
}): TrajectoryCritic {
  const onTelemetry = opts?.onTelemetry;
  const rubricId = PROCESS_RUBRIC_ID;
  const rubricVersion = PROCESS_RUBRIC_VERSION;

  return {
    rubricId,
    rubricVersion,
    score(record: TurnTrajectoryRecord): CriticScore {
      const subjectId =
        typeof record?.subjectId === "string" && record.subjectId.length > 0
          ? record.subjectId
          : "unknown";
      const deviceId =
        typeof record?.deviceId === "string" && record.deviceId.length > 0
          ? record.deviceId
          : "unknown";

      if (!record?.subjectId) {
        onTelemetry?.({
          event: "learning.critic.process_score",
          outcome: "fail",
          subjectId,
          deviceId,
          failureClass: "process.missing_subject",
        });
        throw new CriticContractError("subjectId required on trajectory", {
          obligation: "critic.subject_scope",
          subjectId,
          deviceId,
        });
      }

      const shaped = scoreProcessReward(record as ProcessRewardTrajectory, {
        ...(onTelemetry !== undefined
          ? {
              onTelemetry: (e: ProcessRewardTelemetryEvent) => onTelemetry(e),
            }
          : {}),
      });
      const score = createCriticScore(shaped.breakdown, rubricVersion);
      assertCriticScore(score, rubricVersion);
      return score;
    },
  };
}
