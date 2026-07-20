/**
 * TrajectoryCritic contract — pack-pluggable deterministic reward critics (C3).
 *
 * Pure functions over TurnTrajectoryRecord with a versioned rubric.
 * Default path: no network, no LLM calls. Domain packs register oracles via
 * data/manifest hooks — packages/learning never imports domains/.
 *
 * Never LLM-judge verifiable outcomes; never persist raw keystrokes/utterances.
 */

import type { TurnTrajectoryRecord } from "../trajectory_schema.js";

/** Soft caps for breakdown maps (NFR — bounded result sets). */
export const CRITIC_BREAKDOWN_KEY_LIMIT = 64;
export const CRITIC_RUBRIC_ID_LIMIT = 128;
export const CRITIC_RUBRIC_VERSION_LIMIT = 64;

/**
 * Deterministic score from a TrajectoryCritic.
 * `total` MUST equal the sum of `breakdown` values (finite numbers only).
 * `rubricVersion` pins lineage — checkpoint training must not use "latest".
 */
export interface CriticScore {
  total: number;
  breakdown: Record<string, number>;
  rubricVersion: string;
}

/**
 * Pack-pluggable critic: pure `score` over a trajectory record.
 * Implementations MUST be deterministic for identical records.
 */
export interface TrajectoryCritic {
  rubricId: string;
  rubricVersion: string;
  score(record: TurnTrajectoryRecord): CriticScore;
}

export type CriticFailureClass =
  | "critic.invalid_rubric"
  | "critic.invalid_score"
  | "critic.reward_hack"
  | "critic.subject_scope"
  | "critic.not_registered"
  | "critic.determinism"
  | "critic.invalid_manifest"
  | "critic.pack_oracle_limit"
  | "critic.hash_mismatch"
  | "critic.recalibration_required"
  | "critic.lineage_invalid";

export type CriticTelemetryEvent = {
  event:
    | "learning.critic.score"
    | "learning.critic.register"
    | "learning.critic.validate"
    | "learning.critic.pack_oracle.load"
    | "learning.critic.pack_oracle.register"
    | "learning.critic.lineage"
    | "learning.critic.recalibrate";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  rubricId?: string;
  rubricVersion?: string;
  packId?: string;
  oracleKind?: string;
  /** Opaque sha256:<hex> — never raw rubric body / learner content. */
  contentHash?: string;
  runId?: string;
  failureClass?: CriticFailureClass;
  total?: number;
  /** Never learner content — component keys only. */
  breakdownKeys?: string[];
};

export class CriticContractError extends Error {
  readonly obligation: CriticFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CriticFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "CriticContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

/** Sum breakdown values with stable key order (determinism). */
export function sumBreakdown(breakdown: Record<string, number>): number {
  let total = 0;
  for (const key of Object.keys(breakdown).sort()) {
    const v = breakdown[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new CriticContractError(`breakdown[${key}] must be a finite number`, {
        obligation: "critic.invalid_score",
      });
    }
    total += v;
  }
  return total;
}

/**
 * Build a CriticScore whose total is the deterministic sum of breakdown.
 */
export function createCriticScore(
  breakdown: Record<string, number>,
  rubricVersion: string,
): CriticScore {
  if (
    typeof rubricVersion !== "string" ||
    rubricVersion.length === 0 ||
    rubricVersion.length > CRITIC_RUBRIC_VERSION_LIMIT
  ) {
    throw new CriticContractError("rubricVersion required and bounded", {
      obligation: "critic.invalid_rubric",
    });
  }
  const keys = Object.keys(breakdown);
  if (keys.length > CRITIC_BREAKDOWN_KEY_LIMIT) {
    throw new CriticContractError(
      `breakdown exceeds ${CRITIC_BREAKDOWN_KEY_LIMIT} keys`,
      { obligation: "critic.invalid_score" },
    );
  }
  const total = sumBreakdown(breakdown);
  return { total, breakdown: { ...breakdown }, rubricVersion };
}

/**
 * Validate score shape; throws CriticContractError on violation.
 */
export function assertCriticScore(
  score: CriticScore,
  expectedRubricVersion?: string,
): void {
  if (!score || typeof score !== "object") {
    throw new CriticContractError("score must be an object", {
      obligation: "critic.invalid_score",
    });
  }
  if (typeof score.rubricVersion !== "string" || !score.rubricVersion) {
    throw new CriticContractError("score.rubricVersion required", {
      obligation: "critic.invalid_rubric",
    });
  }
  if (
    expectedRubricVersion !== undefined &&
    score.rubricVersion !== expectedRubricVersion
  ) {
    throw new CriticContractError(
      `rubricVersion mismatch: score=${score.rubricVersion} critic=${expectedRubricVersion}`,
      { obligation: "critic.invalid_rubric" },
    );
  }
  const expected = sumBreakdown(score.breakdown ?? {});
  if (typeof score.total !== "number" || !Number.isFinite(score.total)) {
    throw new CriticContractError("score.total must be finite", {
      obligation: "critic.invalid_score",
    });
  }
  if (Math.abs(score.total - expected) > 1e-9) {
    throw new CriticContractError(
      `score.total (${score.total}) must equal sum(breakdown) (${expected})`,
      { obligation: "critic.invalid_score" },
    );
  }
}

/**
 * Degenerate / reward-hack patterns that MUST score ≤ 0 on the default path.
 * Explicit counter-check before rewarding format polish.
 *
 * Detection (any one is sufficient):
 * - missing subjectId / empty stages
 * - tool spam (>16 tool ids, or ≥8 tools with no successful stage)
 * - explicit suite marker: stage.opCode starts with `hack.`
 */
export function isRewardHackFixture(record: TurnTrajectoryRecord): boolean {
  if (!record?.subjectId || typeof record.subjectId !== "string") return true;
  const stages = record.stages;
  if (!Array.isArray(stages) || stages.length === 0) return true;

  // Explicit hack-suite markers (structured — never utterance bodies).
  if (
    stages.some(
      (s) =>
        typeof s.opCode === "string" && s.opCode.startsWith("hack."),
    )
  ) {
    return true;
  }

  const toolIds = record.toolCallIds ?? [];
  if (toolIds.length > 16) return true;
  const anyOk = stages.some((s) => s.status === "ok" || s.status === undefined);
  if (toolIds.length >= 8 && !anyOk) return true;
  return false;
}

/**
 * Contract-smoke critic — validates shape / anti-hack only.
 * Not the core rubric (CORERUBR); used to lock the TrajectoryCritic API.
 */
export function createContractSmokeCritic(opts?: {
  rubricId?: string;
  rubricVersion?: string;
  onTelemetry?: (e: CriticTelemetryEvent) => void;
}): TrajectoryCritic {
  const rubricId = opts?.rubricId ?? "critic.contract-smoke";
  const rubricVersion = opts?.rubricVersion ?? "1.0.0";
  const onTelemetry = opts?.onTelemetry;

  if (rubricId.length === 0 || rubricId.length > CRITIC_RUBRIC_ID_LIMIT) {
    throw new CriticContractError("rubricId out of bounds", {
      obligation: "critic.invalid_rubric",
    });
  }

  return {
    rubricId,
    rubricVersion,
    score(record: TurnTrajectoryRecord): CriticScore {
      const subjectId = record?.subjectId ?? "unknown";
      const deviceId = record?.deviceId ?? "unknown";

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

      if (isRewardHackFixture(record)) {
        const score = createCriticScore(
          { reward_hack_guard: 0 },
          rubricVersion,
        );
        onTelemetry?.({
          event: "learning.critic.score",
          outcome: "advisory",
          subjectId,
          deviceId,
          rubricId,
          rubricVersion,
          failureClass: "critic.reward_hack",
          total: 0,
          breakdownKeys: ["reward_hack_guard"],
        });
        return score;
      }

      const breakdown: Record<string, number> = {
        schema_ok: 0.25,
        stages_present: 0.25,
      };
      const score = createCriticScore(breakdown, rubricVersion);
      assertCriticScore(score, rubricVersion);
      onTelemetry?.({
        event: "learning.critic.score",
        outcome: "ok",
        subjectId,
        deviceId,
        rubricId,
        rubricVersion,
        total: score.total,
        breakdownKeys: Object.keys(score.breakdown).sort(),
      });
      return score;
    },
  };
}

/**
 * Assert two scores are byte-equal on total + sorted breakdown (determinism).
 */
export function assertDeterministicScores(
  a: CriticScore,
  b: CriticScore,
): void {
  assertCriticScore(a);
  assertCriticScore(b);
  if (a.rubricVersion !== b.rubricVersion || a.total !== b.total) {
    throw new CriticContractError("score totals or versions diverged", {
      obligation: "critic.determinism",
    });
  }
  const keysA = Object.keys(a.breakdown).sort();
  const keysB = Object.keys(b.breakdown).sort();
  if (keysA.join("\0") !== keysB.join("\0")) {
    throw new CriticContractError("breakdown keys diverged", {
      obligation: "critic.determinism",
    });
  }
  for (const k of keysA) {
    if (a.breakdown[k] !== b.breakdown[k]) {
      throw new CriticContractError(`breakdown[${k}] diverged`, {
        obligation: "critic.determinism",
      });
    }
  }
}
