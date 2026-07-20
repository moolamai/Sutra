/**
 * GRPO group-relative advantage + PPO-style clipped surrogate loss (C4).
 *
 * A_i = (r_i − μ) / σ over exactly G candidates sharing one prompt.
 * σ < 1e−6 → group skipped (no divide-by-near-zero).
 * Policy loss: −mean(min(ρ A, clip(ρ, 1−ε, 1+ε) A)) with ε=0.2.
 * Pure policy gradient — no value head / critic baseline network.
 */

import {
  GRPO_GROUP_SIZE_MAX,
  GRPO_GROUP_SIZE_MIN,
  GRPO_SIGMA_EPSILON,
  shouldSkipGrpoGroupNearZeroSigma,
} from "./staleness_control.js";
import {
  computeImportanceRatio,
  STALENESS_EPSILON,
} from "./importance_ratio.js";
import {
  GRPO_GROUP_SCHEMA_VERSION,
  type GrpoGroupAdmitted,
  type GrpoGroupLineage,
  type GrpoGroupResult,
} from "./grpo_group.js";
import { TRAJECTORY_ID_LIMIT } from "./trajectory_schema.js";

/** Clip ε for the PPO-style surrogate (same numeric band as staleness ε). */
export const GRPO_CLIP_EPSILON = STALENESS_EPSILON; // 0.2

export const GRPO_ADVANTAGE_SCHEMA_VERSION = "grpo.advantage.v1" as const;

export type GrpoAdvantageFailureClass =
  | "grpo.advantage.sigma_skip"
  | "grpo.advantage.group_size"
  | "grpo.advantage.subject_scope"
  | "grpo.advantage.invalid_ratio"
  | "grpo.advantage.invalid_reward"
  | "grpo.advantage.empty"
  | "grpo.advantage.section_limit"
  | "grpo.advantage.value_head_forbidden"
  | "grpo.advantage.idempotent_conflict";

export type GrpoAdvantageTelemetryEvent = {
  event:
    | "learning.grpo.advantage"
    | "learning.grpo.surrogate_loss"
    | "learning.grpo.advantage_skip";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupSize?: number;
  meanReward?: number;
  sigma?: number;
  epsilon?: number;
  loss?: number;
  meanRatio?: number;
  skipped?: boolean;
  failureClass?: GrpoAdvantageFailureClass;
  /** Explicitly false — GRPO has no value network. */
  valueHead?: false;
  idempotentReplay?: boolean;
};

export class GrpoAdvantageContractError extends Error {
  readonly obligation: GrpoAdvantageFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: GrpoAdvantageFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "GrpoAdvantageContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type GrpoAdvantageVector = {
  advantages: number[];
  rewards: number[];
  meanReward: number;
  sigma: number;
  groupSize: number;
};

export type GrpoAdvantageSkipped = {
  skipped: true;
  computed: false;
  schemaVersion: typeof GRPO_ADVANTAGE_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupSize: number;
  meanReward: number;
  sigma: number;
  failureClass: GrpoAdvantageFailureClass;
  detail: string;
  valueHead: false;
};

export type GrpoAdvantageComputed = {
  skipped: false;
  computed: true;
  schemaVersion: typeof GRPO_ADVANTAGE_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupSize: number;
  meanReward: number;
  sigma: number;
  advantages: number[];
  rewards: number[];
  valueHead: false;
};

export type GrpoAdvantageResult = GrpoAdvantageComputed | GrpoAdvantageSkipped;

export type ClippedSurrogateTerm = {
  trajectoryId: string;
  ratio: number;
  advantage: number;
  unclipped: number;
  clipped: number;
  /** min(unclipped, clipped) — contribution before negation. */
  term: number;
};

export type ClippedSurrogateLoss = {
  schemaVersion: typeof GRPO_ADVANTAGE_SCHEMA_VERSION;
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupSize: number;
  epsilon: number;
  /** Scalar loss to minimize (negative mean surrogate). */
  loss: number;
  meanRatio: number;
  meanAdvantage: number;
  terms: ClippedSurrogateTerm[];
  valueHead: false;
  lineage?: GrpoGroupLineage;
};

const advantageDecisionCache = new Map<
  string,
  GrpoAdvantageResult | ClippedSurrogateLoss
>();

/**
 * Refuse any payload that tries to attach a value-head baseline.
 * GRPO is critic-free for the policy gradient (C3 trajectory critic ≠ value net).
 */
export function assertNoValueHead(
  payload: unknown,
  opts?: { subjectId?: string; deviceId?: string },
): void {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as Record<string, unknown>;
  for (const key of [
    "valueHead",
    "valueNetwork",
    "baselineValue",
    "vfCoef",
    "valueLoss",
  ]) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      // Allow explicit valueHead: false
      if (key === "valueHead" && obj[key] === false) continue;
      throw new GrpoAdvantageContractError(
        `GRPO forbids value-network field '${key}' — pure policy gradient only`,
        {
          obligation: "grpo.advantage.value_head_forbidden",
          ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
          ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
          failingSlice: key,
        },
      );
    }
  }
}

/**
 * Compute A_i = (r_i − μ) / σ. Returns skip when σ < 1e−6.
 */
export function computeGroupRelativeAdvantages(input: {
  rewards: readonly number[];
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupId?: string;
  onTelemetry?: (e: GrpoAdvantageTelemetryEvent) => void;
}): GrpoAdvantageResult {
  assertNoValueHead(input, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  if (!input.subjectId) {
    throw new GrpoAdvantageContractError("subjectId required", {
      obligation: "grpo.advantage.subject_scope",
    });
  }

  if (input.groupId !== undefined) {
    const cached = advantageDecisionCache.get(input.groupId);
    if (
      cached &&
      "computed" in cached &&
      (cached as GrpoAdvantageResult).schemaVersion ===
        GRPO_ADVANTAGE_SCHEMA_VERSION
    ) {
      const adv = cached as GrpoAdvantageResult;
      input.onTelemetry?.({
        event: adv.skipped
          ? "learning.grpo.advantage_skip"
          : "learning.grpo.advantage",
        outcome: adv.skipped ? "advisory" : "ok",
        subjectId: adv.subjectId,
        deviceId: adv.deviceId,
        ...(adv.promptId !== undefined ? { promptId: adv.promptId } : {}),
        groupSize: adv.groupSize,
        meanReward: adv.meanReward,
        sigma: adv.sigma,
        skipped: adv.skipped,
        valueHead: false,
        idempotentReplay: true,
      });
      return adv;
    }
  }

  if (!Array.isArray(input.rewards) || input.rewards.length === 0) {
    throw new GrpoAdvantageContractError("advantage requires rewards", {
      obligation: "grpo.advantage.empty",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
    });
  }

  const g = input.rewards.length;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    throw new GrpoAdvantageContractError(
      `advantage group size must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}]`,
      {
        obligation: "grpo.advantage.group_size",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  for (const r of input.rewards) {
    if (typeof r !== "number" || !Number.isFinite(r)) {
      throw new GrpoAdvantageContractError("rewards must be finite numbers", {
        obligation: "grpo.advantage.invalid_reward",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
    }
  }

  const gate = shouldSkipGrpoGroupNearZeroSigma(input.rewards, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  if (gate.skip) {
    const skipped: GrpoAdvantageSkipped = {
      skipped: true,
      computed: false,
      schemaVersion: GRPO_ADVANTAGE_SCHEMA_VERSION,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
      groupSize: g,
      meanReward: gate.mean,
      sigma: gate.sigma,
      failureClass: "grpo.advantage.sigma_skip",
      detail: `σ=${gate.sigma} < ${GRPO_SIGMA_EPSILON} — advantage skipped`,
      valueHead: false,
    };
    input.onTelemetry?.({
      event: "learning.grpo.advantage_skip",
      outcome: "advisory",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
      groupSize: g,
      meanReward: gate.mean,
      sigma: gate.sigma,
      skipped: true,
      failureClass: "grpo.advantage.sigma_skip",
      valueHead: false,
    });
    if (input.groupId !== undefined) {
      advantageDecisionCache.set(input.groupId, skipped);
      trimCache();
    }
    return skipped;
  }

  const advantages = input.rewards.map(
    (r) => (r - gate.mean) / gate.sigma,
  );
  const computed: GrpoAdvantageComputed = {
    skipped: false,
    computed: true,
    schemaVersion: GRPO_ADVANTAGE_SCHEMA_VERSION,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
    groupSize: g,
    meanReward: gate.mean,
    sigma: gate.sigma,
    advantages,
    rewards: [...input.rewards],
    valueHead: false,
  };

  input.onTelemetry?.({
    event: "learning.grpo.advantage",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
    groupSize: g,
    meanReward: gate.mean,
    sigma: gate.sigma,
    skipped: false,
    valueHead: false,
  });

  if (input.groupId !== undefined) {
    advantageDecisionCache.set(input.groupId, computed);
    trimCache();
  }
  return computed;
}

/**
 * Single PPO-style clipped surrogate contribution (before batch mean / negation).
 * term = min(ρ A, clip(ρ, 1−ε, 1+ε) A)
 */
export function clippedSurrogateTerm(
  ratio: number,
  advantage: number,
  epsilon: number = GRPO_CLIP_EPSILON,
): { unclipped: number; clipped: number; term: number } {
  if (
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    typeof advantage !== "number" ||
    !Number.isFinite(advantage) ||
    typeof epsilon !== "number" ||
    !Number.isFinite(epsilon) ||
    epsilon <= 0 ||
    epsilon >= 1
  ) {
    throw new GrpoAdvantageContractError(
      "ratio and advantage must be finite; ratio > 0; ε ∈ (0,1)",
      { obligation: "grpo.advantage.invalid_ratio" },
    );
  }
  const lo = 1 - epsilon;
  const hi = 1 + epsilon;
  const clippedRatio = Math.min(Math.max(ratio, lo), hi);
  const unclipped = ratio * advantage;
  const clipped = clippedRatio * advantage;
  return {
    unclipped,
    clipped,
    term: Math.min(unclipped, clipped),
  };
}

/**
 * Mean clipped surrogate loss (minimize): −mean(term_i).
 * No value-loss term — pure policy gradient.
 */
export function computeClippedSurrogateLoss(input: {
  ratios: readonly number[];
  advantages: readonly number[];
  trajectoryIds?: readonly string[];
  subjectId: string;
  deviceId: string;
  promptId?: string;
  epsilon?: number;
  lineage?: GrpoGroupLineage;
  lossId?: string;
  onTelemetry?: (e: GrpoAdvantageTelemetryEvent) => void;
}): ClippedSurrogateLoss {
  assertNoValueHead(input, {
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });

  if (!input.subjectId) {
    throw new GrpoAdvantageContractError("subjectId required", {
      obligation: "grpo.advantage.subject_scope",
    });
  }

  if (input.lossId !== undefined) {
    const cached = advantageDecisionCache.get(input.lossId);
    if (cached && "loss" in cached) {
      input.onTelemetry?.({
        event: "learning.grpo.surrogate_loss",
        outcome: "ok",
        subjectId: cached.subjectId,
        deviceId: cached.deviceId,
        ...(cached.promptId !== undefined ? { promptId: cached.promptId } : {}),
        groupSize: cached.groupSize,
        epsilon: cached.epsilon,
        loss: cached.loss,
        meanRatio: cached.meanRatio,
        valueHead: false,
        idempotentReplay: true,
      });
      return cached;
    }
  }

  if (
    !Array.isArray(input.ratios) ||
    !Array.isArray(input.advantages) ||
    input.ratios.length === 0 ||
    input.ratios.length !== input.advantages.length
  ) {
    throw new GrpoAdvantageContractError(
      "ratios and advantages must be non-empty and aligned",
      {
        obligation: "grpo.advantage.empty",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  const g = input.ratios.length;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    throw new GrpoAdvantageContractError(
      `surrogate group size must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}]`,
      {
        obligation: "grpo.advantage.group_size",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      },
    );
  }

  if (
    input.trajectoryIds !== undefined &&
    input.trajectoryIds.length !== g
  ) {
    throw new GrpoAdvantageContractError(
      "trajectoryIds must align with ratios when provided",
      {
        obligation: "grpo.advantage.section_limit",
        subjectId: input.subjectId,
      },
    );
  }

  const epsilon = input.epsilon ?? GRPO_CLIP_EPSILON;
  const terms: ClippedSurrogateTerm[] = [];
  let sumTerms = 0;
  let sumRatio = 0;
  let sumAdv = 0;

  for (let i = 0; i < g; i++) {
    const ratio = input.ratios[i]!;
    const advantage = input.advantages[i]!;
    const parts = clippedSurrogateTerm(ratio, advantage, epsilon);
    const trajectoryId =
      input.trajectoryIds?.[i] ??
      `cand.${i + 1}`;
    if (trajectoryId.length > TRAJECTORY_ID_LIMIT) {
      throw new GrpoAdvantageContractError("trajectoryId too long", {
        obligation: "grpo.advantage.section_limit",
        subjectId: input.subjectId,
      });
    }
    terms.push({
      trajectoryId,
      ratio,
      advantage,
      unclipped: parts.unclipped,
      clipped: parts.clipped,
      term: parts.term,
    });
    sumTerms += parts.term;
    sumRatio += ratio;
    sumAdv += advantage;
  }

  const loss: ClippedSurrogateLoss = {
    schemaVersion: GRPO_ADVANTAGE_SCHEMA_VERSION,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
    groupSize: g,
    epsilon,
    loss: -sumTerms / g,
    meanRatio: sumRatio / g,
    meanAdvantage: sumAdv / g,
    terms,
    valueHead: false,
    ...(input.lineage !== undefined ? { lineage: input.lineage } : {}),
  };

  input.onTelemetry?.({
    event: "learning.grpo.surrogate_loss",
    outcome: "ok",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.promptId !== undefined ? { promptId: input.promptId } : {}),
    groupSize: g,
    epsilon,
    loss: loss.loss,
    meanRatio: loss.meanRatio,
    valueHead: false,
  });

  if (input.lossId !== undefined) {
    advantageDecisionCache.set(input.lossId, loss);
    trimCache();
  }
  return loss;
}

export type GrpoPolicyLossFromGroup =
  | { ok: true; skipped: false; advantage: GrpoAdvantageComputed; loss: ClippedSurrogateLoss }
  | { ok: true; skipped: true; advantage: GrpoAdvantageSkipped; loss?: undefined };

/**
 * End-to-end: admitted GRPO group + per-candidate importance ratios → loss.
 * Skipped groups produce no loss (σ guard).
 */
export function computeGrpoPolicyLossFromAdmittedGroup(input: {
  group: GrpoGroupAdmitted;
  /** ρ_i = π_train(a|s) / π_rollout(a|s) per candidate (aligned). */
  ratios: readonly number[];
  epsilon?: number;
  lossId?: string;
  onTelemetry?: (e: GrpoAdvantageTelemetryEvent) => void;
}): GrpoPolicyLossFromGroup {
  assertNoValueHead(input, {
    subjectId: input.group.subjectId,
    deviceId: input.group.deviceId,
  });

  if (input.group.schemaVersion !== GRPO_GROUP_SCHEMA_VERSION) {
    throw new GrpoAdvantageContractError("unsupported GRPO group schema", {
      obligation: "grpo.advantage.section_limit",
      subjectId: input.group.subjectId,
    });
  }

  const advantage = computeGroupRelativeAdvantages({
    rewards: input.group.rewards,
    subjectId: input.group.subjectId,
    deviceId: input.group.deviceId,
    promptId: input.group.promptId,
    ...(input.lossId !== undefined
      ? { groupId: `${input.lossId}.adv` }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  if (advantage.skipped) {
    return { ok: true, skipped: true, advantage };
  }

  const loss = computeClippedSurrogateLoss({
    ratios: input.ratios,
    advantages: advantage.advantages,
    trajectoryIds: input.group.candidates.map((c) => c.trajectoryId),
    subjectId: input.group.subjectId,
    deviceId: input.group.deviceId,
    promptId: input.group.promptId,
    ...(input.epsilon !== undefined ? { epsilon: input.epsilon } : {}),
    lineage: input.group.lineage,
    ...(input.lossId !== undefined ? { lossId: input.lossId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  return { ok: true, skipped: false, advantage, loss };
}

/**
 * Build ratios from π_train / π_rollout likelihood pairs (validates via importance ratio).
 */
export function importanceRatiosFromLikelihoods(
  pairs: readonly { piTrain: number; piRollout: number }[],
  opts?: { subjectId?: string; deviceId?: string },
): number[] {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new GrpoAdvantageContractError("likelihood pairs required", {
      obligation: "grpo.advantage.empty",
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    });
  }
  if (pairs.length > GRPO_GROUP_SIZE_MAX) {
    throw new GrpoAdvantageContractError("too many likelihood pairs", {
      obligation: "grpo.advantage.section_limit",
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    });
  }
  return pairs.map((p) =>
    computeImportanceRatio(p.piTrain, p.piRollout, {
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    }),
  );
}

/**
 * Micro-run: admitted group → advantages → clipped surrogate loss with lineage.
 */
export function proveGrpoAdvantageLossMicroRun(input: {
  group: GrpoGroupResult;
  /** Likelihood pairs aligned to candidates; default near-on-policy ρ≈1. */
  likelihoods?: readonly { piTrain: number; piRollout: number }[];
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: GrpoAdvantageTelemetryEvent) => void;
}): GrpoPolicyLossFromGroup & { lineage?: GrpoGroupLineage } {
  if (!input.group.admitted || input.group.skipped) {
    const subjectId = input.subjectId ?? input.group.subjectId;
    const deviceId = input.deviceId ?? input.group.deviceId;
    const skipped: GrpoAdvantageSkipped = {
      skipped: true,
      computed: false,
      schemaVersion: GRPO_ADVANTAGE_SCHEMA_VERSION,
      subjectId,
      deviceId,
      promptId: input.group.promptId,
      groupSize: input.group.groupSize,
      meanReward: input.group.meanReward,
      sigma: input.group.sigma,
      failureClass: "grpo.advantage.sigma_skip",
      detail: "group was not admitted — advantage/loss skipped",
      valueHead: false,
    };
    input.onTelemetry?.({
      event: "learning.grpo.advantage_skip",
      outcome: "advisory",
      subjectId,
      deviceId,
      promptId: input.group.promptId,
      groupSize: input.group.groupSize,
      meanReward: input.group.meanReward,
      sigma: input.group.sigma,
      skipped: true,
      failureClass: "grpo.advantage.sigma_skip",
      valueHead: false,
    });
    return {
      ok: true,
      skipped: true,
      advantage: skipped,
      lineage: input.group.lineage,
    };
  }

  const admitted = input.group;
  const likelihoods =
    input.likelihoods ??
    admitted.candidates.map((_, i) => ({
      piTrain: 0.5 + i * 0.01,
      piRollout: 0.5,
    }));

  const ratios = importanceRatiosFromLikelihoods(likelihoods, {
    subjectId: admitted.subjectId,
    deviceId: admitted.deviceId,
  });

  const result = computeGrpoPolicyLossFromAdmittedGroup({
    group: admitted,
    ratios,
    lossId: `loss.micro.${admitted.subjectId}.${admitted.promptId}`,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  return { ...result, lineage: admitted.lineage };
}

function trimCache(): void {
  if (advantageDecisionCache.size > 64) {
    const first = advantageDecisionCache.keys().next().value as
      | string
      | undefined;
    if (first !== undefined) advantageDecisionCache.delete(first);
  }
}

/** Test helper — clear idempotent advantage/loss caches. */
export function resetGrpoAdvantageCache(): void {
  advantageDecisionCache.clear();
}
