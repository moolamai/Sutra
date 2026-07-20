/**
 * Core rubric — deterministic rule critic over trajectory records (C3).
 *
 * Component weights (rubric v1.0.0), stacked additively:
 *   format_breach        −1.0  protocol / format breach
 *   invariant_violation  −2.0  invariant / obligation violation
 *   schema_failure       −1.0  schema validation failure
 *   human_accepted       +1.0  human_outcome_signal ACCEPTED
 *   human_rejected       −1.0  human_outcome_signal REJECTED
 *   clean_success        +0.5  clean uncorrected success (zero repair cycles)
 *
 * DISCARDED zeroes all positive reward components (penalties may remain).
 * Never LLM-judges verifiable outcomes. Reward-hack fixtures score exactly 0.
 */

import {
  attachOutcomeSignal,
  HUMAN_OUTCOME_SIGNALS,
  parseHumanOutcomeSignal,
  type FinalizedOutcomeBinding,
  type HumanOutcomeSignal,
  type TurnTrajectoryWithOutcome,
} from "../outcome_signal.js";
import {
  parseTurnTrajectoryRecord,
  type TurnTrajectoryRecord,
} from "../trajectory_schema.js";
import {
  CriticContractError,
  assertCriticScore,
  createCriticScore,
  isRewardHackFixture,
  type CriticScore,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.js";

export const CORE_RUBRIC_ID = "critic.core-rubric" as const;
export const CORE_RUBRIC_VERSION = "1.0.0" as const;

/**
 * Repo-relative golden trajectories — one fixture per rubric branch
 * (negative fixtures isolate a single violation condition).
 */
export const CORE_RUBRIC_GOLDEN_FIXTURES_RELPATH =
  "training/critics/fixtures/core-rubric" as const;

/** Branches covered by the golden suite (isolation + stack + labels). */
export const CORE_RUBRIC_GOLDEN_BRANCHES = Object.freeze([
  "format_breach",
  "invariant_violation",
  "schema_failure",
  "human_accepted+clean_success",
  "human_rejected",
  "human_discarded",
  "reward_hack",
  "clean_success_disqualified",
  "stack",
] as const);

/** Published component weights — stacked additively (no cap in v1.0.0). */
export const CORE_RUBRIC_WEIGHTS = Object.freeze({
  format_breach: -1.0,
  invariant_violation: -2.0,
  schema_failure: -1.0,
  human_accepted: 1.0,
  human_rejected: -1.0,
  clean_success: 0.5,
} as const);

export type CoreRubricComponent = keyof typeof CORE_RUBRIC_WEIGHTS;

/**
 * Trajectory input for the core rubric — TurnTrajectoryRecord plus C0
 * human_outcome_signal fields (from attachOutcomeSignal / ledger finalize).
 */
export type CoreRubricRecord = TurnTrajectoryRecord & {
  humanOutcomeSignal?: HumanOutcomeSignal;
  /** Linked correction after ACCEPTED — disqualifies clean_success. */
  amendsTurnId?: string;
  /** Explicit repair/correction cycle count; >0 disqualifies clean_success. */
  correctionCycleCount?: number;
  /** Opaque pre-abort frame types — never raw payloads. */
  preAbortFrameTypes?: readonly string[];
  abandonmentKind?: string;
};

/**
 * Validate and read human_outcome_signal from a C0-wired trajectory.
 * Throws typed contract error on unrecognized values (untrusted wire input).
 */
export function readHumanOutcomeSignal(
  record: CoreRubricRecord,
): HumanOutcomeSignal | undefined {
  if (record.humanOutcomeSignal === undefined) return undefined;
  const parsed = parseHumanOutcomeSignal(record.humanOutcomeSignal);
  if (!parsed.ok) {
    throw new CriticContractError(
      "human_outcome_signal must be ACCEPTED | REJECTED | DISCARDED",
      {
        obligation: "critic.invalid_score",
        subjectId: record.subjectId,
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      },
    );
  }
  return parsed.signal;
}

/**
 * Bind a finalized C0 outcome onto a trajectory for rubric scoring.
 * Enforces subjectId match (cross-subject attach is a defect).
 */
export function bindHumanOutcomeForRubric(
  record: TurnTrajectoryRecord,
  binding: FinalizedOutcomeBinding,
): TurnTrajectoryWithOutcome {
  if (!binding?.subjectId || binding.subjectId !== record.subjectId) {
    throw new CriticContractError(
      "outcome binding subjectId must match trajectory subjectId",
      {
        obligation: "critic.subject_scope",
        subjectId: record.subjectId,
        ...(record.deviceId !== undefined ? { deviceId: record.deviceId } : {}),
      },
    );
  }
  return attachOutcomeSignal(record, binding);
}

/**
 * Drop C0 outcome extensions before schema parse — they are additive on the
 * training trajectory and are not part of the strict wire schema object.
 */
function toSchemaProbe(record: CoreRubricRecord): unknown {
  const {
    humanOutcomeSignal: _signal,
    amendsTurnId: _amends,
    correctionCycleCount: _cycles,
    preAbortFrameTypes: _frames,
    abandonmentKind: _abandon,
    ...base
  } = record;
  return base;
}

/**
 * Protocol-format breach: floating checkpoint, forbidden content keys,
 * or stage-level format/protocol error markers.
 */
export function detectFormatBreach(record: CoreRubricRecord): boolean {
  const hash = record.policyCheckpointHash;
  if (typeof hash === "string" && hash.toLowerCase() === "latest") {
    return true;
  }
  const forbidden = [
    "keystrokes",
    "rawKeystrokes",
    "utterance",
    "prompt",
    "completion",
    "reply",
    "arguments",
    "toolArgs",
  ] as const;
  const bag = record as Record<string, unknown>;
  for (const key of forbidden) {
    if (key in bag) return true;
  }
  return record.stages.some(
    (s) =>
      (s.status === "error" || s.status === "aborted") &&
      (s.opCode?.includes("format") === true ||
        s.opCode?.includes("protocol") === true ||
        s.stage === "format" ||
        s.stage === "protocol"),
  );
}

/**
 * Invariant / obligation violation: declined consent, or stage markers.
 */
export function detectInvariantViolation(record: CoreRubricRecord): boolean {
  if (record.consent?.optedIn !== true) return true;
  return record.stages.some(
    (s) =>
      (s.status === "error" || s.status === "aborted") &&
      (s.opCode?.includes("invariant") === true ||
        s.opCode?.includes("obligation") === true ||
        s.stage === "invariant" ||
        s.stage === "obligation"),
  );
}

/**
 * Schema validation failure via the trajectory parse boundary (rule only).
 */
export function detectSchemaFailure(record: CoreRubricRecord): boolean {
  const parsed = parseTurnTrajectoryRecord(toSchemaProbe(record));
  if (!parsed.ok) {
    // Floating checkpoint is classified as format_breach, not schema.
    if (parsed.failureClass === "floating_checkpoint") return false;
    if (parsed.failureClass === "keystroke_forbidden") return false;
    if (parsed.failureClass === "missing_subject") return false;
    return true;
  }
  return false;
}

/**
 * Clean uncorrected success: all actionable stages ok, zero correction cycles.
 * One repair / amendsTurnId / correctionCycleCount>0 disqualifies the +0.5.
 */
export function detectCleanSuccess(record: CoreRubricRecord): boolean {
  if (record.amendsTurnId !== undefined && record.amendsTurnId.length > 0) {
    return false;
  }
  if (
    typeof record.correctionCycleCount === "number" &&
    record.correctionCycleCount > 0
  ) {
    return false;
  }
  if (
    record.stages.some(
      (s) =>
        s.stage.includes("repair") ||
        s.stage.includes("correct") ||
        s.opCode?.includes("repair") === true ||
        s.opCode?.includes("correct") === true,
    )
  ) {
    return false;
  }
  const actionable = record.stages.filter((s) => s.status !== "skipped");
  if (actionable.length === 0) return false;
  return actionable.every(
    (s) => s.status === "ok" || s.status === undefined,
  );
}

/** Remove every strictly positive component (DISCARDED semantics). */
export function zeroPositiveRewardComponents(
  breakdown: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const key of Object.keys(breakdown).sort()) {
    const v = breakdown[key]!;
    if (v > 0) continue;
    next[key] = v;
  }
  return next;
}

/**
 * Map trajectory fields → rubric breakdown (additive stack, no cap in v1).
 * Wires C0 human_outcome_signal: ACCEPTED / REJECTED / DISCARDED.
 * Pure / deterministic. Does not call network or LLM.
 */
export function scoreCoreRubricBreakdown(
  record: CoreRubricRecord,
): Record<string, number> {
  if (isRewardHackFixture(record)) {
    return { reward_hack_guard: 0 };
  }

  const breakdown: Record<string, number> = {};

  if (detectFormatBreach(record)) {
    breakdown.format_breach = CORE_RUBRIC_WEIGHTS.format_breach;
  }
  if (detectInvariantViolation(record)) {
    breakdown.invariant_violation = CORE_RUBRIC_WEIGHTS.invariant_violation;
  }
  if (detectSchemaFailure(record)) {
    breakdown.schema_failure = CORE_RUBRIC_WEIGHTS.schema_failure;
  }

  const signal = readHumanOutcomeSignal(record);

  if (signal === "ACCEPTED") {
    breakdown.human_accepted = CORE_RUBRIC_WEIGHTS.human_accepted;
  } else if (signal === "REJECTED") {
    breakdown.human_rejected = CORE_RUBRIC_WEIGHTS.human_rejected;
  }

  const hasPenalty =
    breakdown.format_breach !== undefined ||
    breakdown.invariant_violation !== undefined ||
    breakdown.schema_failure !== undefined ||
    breakdown.human_rejected !== undefined;

  // Process bonus only when outcome is ACCEPTED (or absent) and no penalties.
  // REJECTED/DISCARDED never receive clean_success (outcome truth dominates).
  if (!hasPenalty && signal !== "REJECTED" && signal !== "DISCARDED") {
    if (detectCleanSuccess(record)) {
      breakdown.clean_success = CORE_RUBRIC_WEIGHTS.clean_success;
    }
  }

  // DISCARDED zeroes all positive rewards; penalties (if any) remain.
  if (signal === "DISCARDED") {
    const zeroed = zeroPositiveRewardComponents(breakdown);
    zeroed.human_discarded = 0;
    return Object.keys(zeroed).length > 0 ? zeroed : { human_discarded: 0 };
  }

  if (Object.keys(breakdown).length === 0) {
    breakdown.neutral = 0;
  }
  return breakdown;
}

/**
 * Score one trajectory with the core rubric; returns CriticScore.
 */
export function scoreCoreRubric(record: CoreRubricRecord): CriticScore {
  return createCriticScore(
    scoreCoreRubricBreakdown(record),
    CORE_RUBRIC_VERSION,
  );
}

/**
 * Attach a finalized C0 outcome binding, then score with the core rubric.
 */
export function scoreCoreRubricWithOutcome(
  record: TurnTrajectoryRecord,
  binding: FinalizedOutcomeBinding,
): CriticScore {
  return scoreCoreRubric(bindHumanOutcomeForRubric(record, binding));
}

/**
 * Pack-pluggable TrajectoryCritic for the core rubric.
 */
export function createCoreRubricCritic(opts?: {
  onTelemetry?: (e: CriticTelemetryEvent) => void;
}): TrajectoryCritic {
  const onTelemetry = opts?.onTelemetry;
  const rubricId = CORE_RUBRIC_ID;
  const rubricVersion = CORE_RUBRIC_VERSION;

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
          event: "learning.critic.score",
          outcome: "fail",
          subjectId,
          deviceId,
          rubricId,
          rubricVersion,
          failureClass: "critic.subject_scope",
        });
        throw new CriticContractError("subjectId required on trajectory", {
          obligation: "critic.subject_scope",
          subjectId,
          deviceId,
        });
      }

      let score: CriticScore;
      try {
        score = scoreCoreRubric(record as CoreRubricRecord);
      } catch (err) {
        if (err instanceof CriticContractError) {
          onTelemetry?.({
            event: "learning.critic.score",
            outcome: "fail",
            subjectId,
            deviceId,
            rubricId,
            rubricVersion,
            failureClass: err.obligation,
          });
        }
        throw err;
      }
      assertCriticScore(score, rubricVersion);

      const hack = isRewardHackFixture(record);
      const signal = (record as CoreRubricRecord).humanOutcomeSignal;
      onTelemetry?.({
        event: "learning.critic.score",
        outcome: hack ? "advisory" : "ok",
        subjectId,
        deviceId,
        rubricId,
        rubricVersion,
        ...(hack ? { failureClass: "critic.reward_hack" as const } : {}),
        total: score.total,
        breakdownKeys: Object.keys(score.breakdown).sort(),
        // Enum only — never utterance / frame bodies.
        ...(typeof signal === "string" &&
        (HUMAN_OUTCOME_SIGNALS as readonly string[]).includes(signal)
          ? { oracleKind: `outcome:${signal}` }
          : {}),
      });
      return score;
    },
  };
}
