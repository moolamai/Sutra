/**
 * Isolated LLM-judge lane — optional aspect-separated critic plugin (C3).
 *
 * Non-verifiable aspects only (`tone` | `clarity`). One aspect per call.
 * Hard denylist on verifiable domains. Outputs always pin judgeModelId.
 * Injected scorer — learning never opens network sockets for judging.
 *
 * Law: docs/learning/LLM_JUDGE_POLICY.md
 */

import type { TurnTrajectoryRecord } from "../trajectory_schema.js";
import {
  createCriticScore,
  type CriticScore,
  type TrajectoryCritic,
} from "./interface.js";
import {
  LLM_JUDGE_ALLOWED_ASPECTS,
  LLM_JUDGE_FORBIDDEN_DOMAINS,
  LLM_JUDGE_MAX_CALLS_PER_TURN,
  LlmJudgePolicyContractError,
  assertAllowedLlmJudgeAspect,
  assertLlmJudgeIdentityPinned,
  assertNotForbiddenLlmJudgeDomain,
  type LlmJudgeAspect,
  type LlmJudgePolicyFailureClass,
} from "./llm_judge_policy.js";

export const LLM_JUDGE_LANE_RUBRIC_PREFIX = "critic.llm-judge" as const;
export const LLM_JUDGE_SCORE_CLAMP_MIN = -1;
export const LLM_JUDGE_SCORE_CLAMP_MAX = 1;

export type LlmJudgeLaneTelemetryEvent = {
  event: "learning.critic.llm_judge_lane" | "learning.critic.llm_judge_policy";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  aspect?: LlmJudgeAspect;
  judgeModelId?: string;
  judgePromptVersion?: string;
  failureClass?: LlmJudgePolicyFailureClass;
  turnId?: string;
  idempotentReplay?: boolean;
};

export type LlmJudgeScoreInput = {
  aspect: LlmJudgeAspect;
  subjectId: string;
  deviceId: string;
  turnId: string;
  /** Opaque content hash only — never raw utterance / completion bodies. */
  contentHash?: string;
};

/**
 * Injected aspect scorer. Network / LLM live outside `@moolam/learning`.
 * Must return a finite number; lane clamps to [-1, 1].
 */
export type LlmJudgeAspectScoreFn = (input: LlmJudgeScoreInput) => number;

export type LlmJudgeAspectJudgment = {
  aspect: LlmJudgeAspect;
  score: number;
  judgeModelId: string;
  judgePromptVersion: string;
  subjectId: string;
  deviceId: string;
  turnId: string;
};

export type LlmJudgeAspectRequest = {
  subjectId: string;
  deviceId: string;
  turnId: string;
  aspect: string;
  contentHash?: string;
};

export type IsolatedLlmJudgeLane = {
  readonly judgeModelId: string;
  readonly judgePromptVersion: string;
  /** Score exactly one allowed aspect; rejects multi-aspect / denylist. */
  scoreAspect(req: LlmJudgeAspectRequest): Promise<LlmJudgeAspectJudgment>;
  /**
   * Separate calls for every allowed aspect (bounded ≤ LLM_JUDGE_MAX_CALLS_PER_TURN).
   * Never bundles aspects into one judge invocation.
   */
  scoreAllowedAspectsSeparately(
    req: Omit<LlmJudgeAspectRequest, "aspect">,
  ): Promise<LlmJudgeAspectJudgment[]>;
  /**
   * Optional TrajectoryCritic bound to a single aspect (aspect separation at construct).
   * Breakdown key is the aspect id; metadata pins live on the lane, not in breakdown.
   */
  createAspectCritic(aspect: LlmJudgeAspect): TrajectoryCritic & {
    judgeModelId: string;
    judgePromptVersion: string;
    aspect: LlmJudgeAspect;
  };
};

type CacheEntry = {
  judgment: LlmJudgeAspectJudgment;
};

function clampJudgeScore(raw: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new LlmJudgePolicyContractError(
      "LLM judge score must be a finite number",
      { obligation: "llm_judge.unpinned_identity" },
    );
  }
  return Math.min(
    LLM_JUDGE_SCORE_CLAMP_MAX,
    Math.max(LLM_JUDGE_SCORE_CLAMP_MIN, raw),
  );
}

function cacheKey(parts: {
  subjectId: string;
  turnId: string;
  aspect: LlmJudgeAspect;
  judgeModelId: string;
  judgePromptVersion: string;
}): string {
  return [
    parts.subjectId,
    parts.turnId,
    parts.aspect,
    parts.judgeModelId,
    parts.judgePromptVersion,
  ].join("\0");
}

function assertNoForbiddenBreakdownKeys(
  keys: string[],
  opts: {
    subjectId: string;
    deviceId: string;
    onTelemetry?: (e: LlmJudgeLaneTelemetryEvent) => void;
  },
): void {
  for (const key of keys) {
    if ((LLM_JUDGE_FORBIDDEN_DOMAINS as readonly string[]).includes(key)) {
      opts.onTelemetry?.({
        event: "learning.critic.llm_judge_lane",
        outcome: "fail",
        subjectId: opts.subjectId,
        deviceId: opts.deviceId,
        failureClass: "llm_judge.forbidden_domain",
      });
      throw new LlmJudgePolicyContractError(
        `LLM judge must not emit verifiable breakdown key '${key}'`,
        {
          obligation: "llm_judge.forbidden_domain",
          failingSlice: key,
          subjectId: opts.subjectId,
          deviceId: opts.deviceId,
        },
      );
    }
  }
}

/**
 * Reject bundled multi-aspect requests (policy J3).
 */
export function assertSingleLlmJudgeAspectCall(
  aspects: readonly string[],
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: LlmJudgeLaneTelemetryEvent) => void;
  },
): LlmJudgeAspect {
  if (aspects.length !== 1) {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_lane",
      outcome: "fail",
      subjectId: opts.subjectId ?? "llm-judge-lane",
      deviceId: opts.deviceId ?? "ci",
      failureClass: "llm_judge.multi_aspect_call",
    });
    throw new LlmJudgePolicyContractError(
      `LLM judge requires exactly one aspect per call (got ${aspects.length})`,
      {
        obligation: "llm_judge.multi_aspect_call",
        failingSlice: String(aspects.length),
        ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
        ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      },
    );
  }
  const only = aspects[0]!;
  return assertAllowedLlmJudgeAspect(only, {
    ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
}

/**
 * Create an optional isolated LLM-judge lane (not on the default GRPO path).
 */
export function createIsolatedLlmJudgeLane(opts: {
  judgeModelId: string;
  judgePromptVersion: string;
  scoreAspectFn: LlmJudgeAspectScoreFn;
  /** When set, every request must match this subject (cross-subject = defect). */
  expectedSubjectId?: string;
  onTelemetry?: (e: LlmJudgeLaneTelemetryEvent) => void;
}): IsolatedLlmJudgeLane {
  assertLlmJudgeIdentityPinned({
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    ...(opts.expectedSubjectId !== undefined
      ? { subjectId: opts.expectedSubjectId }
      : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const judgeModelId = opts.judgeModelId;
  const judgePromptVersion = opts.judgePromptVersion;
  const scoreAspectFn = opts.scoreAspectFn;
  const onTelemetry = opts.onTelemetry;
  const expectedSubjectId = opts.expectedSubjectId;

  /** Subject-scoped serial chains — no silent last-write-wins across aspects. */
  const subjectChains = new Map<string, Promise<unknown>>();
  /** Idempotent score pins. */
  const judgmentCache = new Map<string, CacheEntry>();

  function assertSubjectScope(
    subjectId: string,
    deviceId: string,
  ): void {
    if (!subjectId || subjectId.length === 0) {
      onTelemetry?.({
        event: "learning.critic.llm_judge_lane",
        outcome: "fail",
        subjectId: "unknown",
        deviceId,
        failureClass: "llm_judge.subject_scope",
      });
      throw new LlmJudgePolicyContractError("subjectId required for LLM judge", {
        obligation: "llm_judge.subject_scope",
        deviceId,
      });
    }
    if (
      expectedSubjectId !== undefined &&
      subjectId !== expectedSubjectId
    ) {
      onTelemetry?.({
        event: "learning.critic.llm_judge_lane",
        outcome: "fail",
        subjectId,
        deviceId,
        failureClass: "llm_judge.subject_scope",
      });
      throw new LlmJudgePolicyContractError(
        `cross-subject LLM judge refused (expected ${expectedSubjectId})`,
        {
          obligation: "llm_judge.subject_scope",
          failingSlice: subjectId,
          subjectId,
          deviceId,
        },
      );
    }
  }

  async function runUnderSubjectLock<T>(
    subjectId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prev = subjectChains.get(subjectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => gate);
    subjectChains.set(subjectId, chained);
    await prev.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (subjectChains.get(subjectId) === chained) {
        subjectChains.delete(subjectId);
      }
    }
  }

  async function scoreAspect(
    req: LlmJudgeAspectRequest,
  ): Promise<LlmJudgeAspectJudgment> {
    const subjectId = req.subjectId;
    const deviceId =
      typeof req.deviceId === "string" && req.deviceId.length > 0
        ? req.deviceId
        : "unknown";
    const turnId = req.turnId;

    assertSubjectScope(subjectId, deviceId);

    if (!turnId || turnId.length === 0) {
      throw new LlmJudgePolicyContractError(
        "turnId required for LLM judge aspect call",
        {
          obligation: "llm_judge.subject_scope",
          subjectId,
          deviceId,
        },
      );
    }

    // Denylist first — verifiable domains never enter the lane
    assertNotForbiddenLlmJudgeDomain(req.aspect, {
      subjectId,
      deviceId,
      ...(onTelemetry !== undefined ? { onTelemetry } : {}),
    });

    const aspect = assertSingleLlmJudgeAspectCall([req.aspect], {
      subjectId,
      deviceId,
      ...(onTelemetry !== undefined ? { onTelemetry } : {}),
    });

    return runUnderSubjectLock(subjectId, async () => {
      const key = cacheKey({
        subjectId,
        turnId,
        aspect,
        judgeModelId,
        judgePromptVersion,
      });
      const cached = judgmentCache.get(key);
      if (cached) {
        onTelemetry?.({
          event: "learning.critic.llm_judge_lane",
          outcome: "ok",
          subjectId,
          deviceId,
          aspect,
          judgeModelId,
          judgePromptVersion,
          turnId,
          idempotentReplay: true,
        });
        return cached.judgment;
      }

      const scoreInput: LlmJudgeScoreInput = {
        aspect,
        subjectId,
        deviceId,
        turnId,
        ...(req.contentHash !== undefined
          ? { contentHash: req.contentHash }
          : {}),
      };

      let raw: number;
      try {
        raw = scoreAspectFn(scoreInput);
      } catch (err) {
        onTelemetry?.({
          event: "learning.critic.llm_judge_lane",
          outcome: "fail",
          subjectId,
          deviceId,
          aspect,
          judgeModelId,
          judgePromptVersion,
          turnId,
          failureClass: "llm_judge.unpinned_identity",
        });
        if (err instanceof LlmJudgePolicyContractError) throw err;
        throw new LlmJudgePolicyContractError(
          `LLM judge scorer failed for aspect '${aspect}'`,
          {
            obligation: "llm_judge.unpinned_identity" satisfies LlmJudgePolicyFailureClass,
            subjectId,
            deviceId,
            failingSlice: aspect,
          },
        );
      }

      const score = clampJudgeScore(raw);
      assertNoForbiddenBreakdownKeys([aspect], {
        subjectId,
        deviceId,
        ...(onTelemetry !== undefined ? { onTelemetry } : {}),
      });

      const judgment: LlmJudgeAspectJudgment = {
        aspect,
        score,
        judgeModelId,
        judgePromptVersion,
        subjectId,
        deviceId,
        turnId,
      };

      judgmentCache.set(key, { judgment });

      onTelemetry?.({
        event: "learning.critic.llm_judge_lane",
        outcome: "ok",
        subjectId,
        deviceId,
        aspect,
        judgeModelId,
        judgePromptVersion,
        turnId,
      });

      return judgment;
    });
  }

  async function scoreAllowedAspectsSeparately(
    req: Omit<LlmJudgeAspectRequest, "aspect">,
  ): Promise<LlmJudgeAspectJudgment[]> {
    if (LLM_JUDGE_ALLOWED_ASPECTS.length > LLM_JUDGE_MAX_CALLS_PER_TURN) {
      throw new LlmJudgePolicyContractError(
        "allowed aspect set exceeds max calls per turn",
        { obligation: "llm_judge.multi_aspect_call" },
      );
    }
    const out: LlmJudgeAspectJudgment[] = [];
    // Separate sequential calls — never one bundled multi-aspect prompt
    for (const aspect of LLM_JUDGE_ALLOWED_ASPECTS) {
      out.push(
        await scoreAspect({
          subjectId: req.subjectId,
          deviceId: req.deviceId,
          turnId: req.turnId,
          aspect,
          ...(req.contentHash !== undefined
            ? { contentHash: req.contentHash }
            : {}),
        }),
      );
    }
    return out;
  }

  function createAspectCritic(aspect: LlmJudgeAspect): TrajectoryCritic & {
    judgeModelId: string;
    judgePromptVersion: string;
    aspect: LlmJudgeAspect;
  } {
    const pinnedAspect = assertAllowedLlmJudgeAspect(aspect, {
      ...(onTelemetry !== undefined ? { onTelemetry } : {}),
    });
    assertNotForbiddenLlmJudgeDomain(pinnedAspect, {
      ...(onTelemetry !== undefined ? { onTelemetry } : {}),
    });

    const rubricId = `${LLM_JUDGE_LANE_RUBRIC_PREFIX}.${pinnedAspect}`;
    const rubricVersion = judgePromptVersion;

    return {
      rubricId,
      rubricVersion,
      judgeModelId,
      judgePromptVersion,
      aspect: pinnedAspect,
      score(record: TurnTrajectoryRecord): CriticScore {
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

        assertSubjectScope(subjectId, deviceId);
        if (!turnId) {
          throw new LlmJudgePolicyContractError(
            "turnId required on trajectory for LLM judge critic",
            {
              obligation: "llm_judge.subject_scope",
              subjectId,
              deviceId,
            },
          );
        }

        const key = cacheKey({
          subjectId,
          turnId,
          aspect: pinnedAspect,
          judgeModelId,
          judgePromptVersion,
        });
        const cached = judgmentCache.get(key);
        if (cached) {
          const breakdown: Record<string, number> = {
            [pinnedAspect]: cached.judgment.score,
          };
          assertNoForbiddenBreakdownKeys(Object.keys(breakdown), {
            subjectId,
            deviceId,
            ...(onTelemetry !== undefined ? { onTelemetry } : {}),
          });
          onTelemetry?.({
            event: "learning.critic.llm_judge_lane",
            outcome: "ok",
            subjectId,
            deviceId,
            aspect: pinnedAspect,
            judgeModelId,
            judgePromptVersion,
            turnId,
            idempotentReplay: true,
          });
          return createCriticScore(breakdown, rubricVersion);
        }

        const scoreInput: LlmJudgeScoreInput = {
          aspect: pinnedAspect,
          subjectId,
          deviceId,
          turnId,
        };
        const raw = scoreAspectFn(scoreInput);
        const score = clampJudgeScore(raw);
        const breakdown: Record<string, number> = { [pinnedAspect]: score };
        assertNoForbiddenBreakdownKeys(Object.keys(breakdown), {
          subjectId,
          deviceId,
          ...(onTelemetry !== undefined ? { onTelemetry } : {}),
        });

        const judgment: LlmJudgeAspectJudgment = {
          aspect: pinnedAspect,
          score,
          judgeModelId,
          judgePromptVersion,
          subjectId,
          deviceId,
          turnId,
        };
        judgmentCache.set(key, { judgment });

        onTelemetry?.({
          event: "learning.critic.llm_judge_lane",
          outcome: "ok",
          subjectId,
          deviceId,
          aspect: pinnedAspect,
          judgeModelId,
          judgePromptVersion,
          turnId,
        });

        return createCriticScore(breakdown, rubricVersion);
      },
    };
  }

  return {
    judgeModelId,
    judgePromptVersion,
    scoreAspect,
    scoreAllowedAspectsSeparately,
    createAspectCritic,
  };
}
