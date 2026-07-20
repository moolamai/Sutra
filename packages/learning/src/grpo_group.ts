/**
 * GRPO group sampling — assemble G=4–8 scored gym candidates per prompt (C4).
 *
 * Collects trajectory records + C3 critic scores into a group sharing one
 * promptId. Identical rewards → σ≈0 → group skipped (no divide-by-near-zero).
 * Advantage / clipped surrogate / LoRA weight updates are later slices.
 */

import {
  assertCriticScore,
  type CriticScore,
  type TrajectoryCritic,
} from "./critics/interface.js";
import {
  GRPO_GROUP_SIZE_MAX,
  GRPO_GROUP_SIZE_MIN,
  GRPO_SIGMA_EPSILON,
  shouldSkipGrpoGroupNearZeroSigma,
} from "./staleness_control.js";
import {
  TRAJECTORY_HASH_LIMIT,
  TRAJECTORY_ID_LIMIT,
  type TurnTrajectoryRecord,
} from "./trajectory_schema.js";

export const GRPO_GROUP_SCHEMA_VERSION = "grpo.group.v1" as const;

export type GrpoGroupFailureClass =
  | "grpo.group_size"
  | "grpo.prompt_mismatch"
  | "grpo.subject_scope"
  | "grpo.mixed_policy"
  | "grpo.mixed_critic_version"
  | "grpo.missing_policy_hash"
  | "grpo.floating_checkpoint"
  | "grpo.invalid_score"
  | "grpo.empty_group"
  | "grpo.section_limit"
  | "grpo.idempotent_conflict"
  | "grpo.sigma_skip";

export type GrpoGroupTelemetryEvent = {
  event:
    | "learning.grpo.group_sample"
    | "learning.grpo.group_skip"
    | "learning.grpo.critic_score";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  promptId?: string;
  groupSize?: number;
  policyCheckpointHash?: string;
  criticRubricId?: string;
  criticRubricVersion?: string;
  sigma?: number;
  meanReward?: number;
  skipped?: boolean;
  failureClass?: GrpoGroupFailureClass;
  idempotentReplay?: boolean;
};

export class GrpoGroupContractError extends Error {
  readonly obligation: GrpoGroupFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: GrpoGroupFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "GrpoGroupContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

/** One gym rollout candidate before / after critic scoring. */
export type GrpoRolloutCandidate = {
  subjectId: string;
  deviceId: string;
  /** Shared across the G group — one prompt / scenario key. */
  promptId: string;
  trajectoryId: string;
  policyCheckpointHash: string;
  /** Opaque trajectory record — never emitted as raw content in telemetry. */
  trajectory: TurnTrajectoryRecord;
};

export type GrpoScoredCandidate = GrpoRolloutCandidate & {
  score: CriticScore;
  reward: number;
};

export type GrpoGroupLineage = {
  corpusManifestId: string;
  baseCheckpointHash: string;
  criticRubricId: string;
  criticRubricVersion: string;
  hyperparametersId?: string;
  loraRank?: number;
  loraAlpha?: number;
};

export type GrpoGroupAdmitted = {
  admitted: true;
  skipped: false;
  schemaVersion: typeof GRPO_GROUP_SCHEMA_VERSION;
  promptId: string;
  subjectId: string;
  deviceId: string;
  groupSize: number;
  policyCheckpointHash: string;
  criticRubricId: string;
  criticRubricVersion: string;
  candidates: GrpoScoredCandidate[];
  rewards: number[];
  meanReward: number;
  sigma: number;
  lineage: GrpoGroupLineage;
};

export type GrpoGroupSkipped = {
  admitted: false;
  skipped: true;
  schemaVersion: typeof GRPO_GROUP_SCHEMA_VERSION;
  promptId: string;
  subjectId: string;
  deviceId: string;
  groupSize: number;
  policyCheckpointHash: string;
  criticRubricId: string;
  criticRubricVersion: string;
  rewards: number[];
  meanReward: number;
  sigma: number;
  failureClass: GrpoGroupFailureClass;
  detail: string;
  lineage: GrpoGroupLineage;
};

export type GrpoGroupResult = GrpoGroupAdmitted | GrpoGroupSkipped;

const groupDecisionCache = new Map<string, GrpoGroupResult>();

function assertOpaqueId(
  value: string,
  field: string,
  obligation: GrpoGroupFailureClass,
  subjectId?: string,
): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > TRAJECTORY_ID_LIMIT
  ) {
    throw new GrpoGroupContractError(`${field} required`, {
      obligation,
      ...(subjectId !== undefined ? { subjectId } : {}),
      failingSlice: field,
    });
  }
}

function assertPolicyHash(
  hash: string,
  subjectId?: string,
): string {
  if (typeof hash !== "string" || hash.length < 8 || hash.length > TRAJECTORY_HASH_LIMIT) {
    throw new GrpoGroupContractError("policyCheckpointHash required", {
      obligation: "grpo.missing_policy_hash",
      ...(subjectId !== undefined ? { subjectId } : {}),
    });
  }
  if (hash.toLowerCase() === "latest") {
    throw new GrpoGroupContractError(
      "floating policyCheckpointHash 'latest' forbidden",
      {
        obligation: "grpo.floating_checkpoint",
        ...(subjectId !== undefined ? { subjectId } : {}),
      },
    );
  }
  return hash;
}

/**
 * Score gym rollout candidates with a single C3 critic (one rubric version).
 */
export function scoreGrpoRolloutCandidates(
  candidates: readonly GrpoRolloutCandidate[],
  critic: TrajectoryCritic,
  opts?: { onTelemetry?: (e: GrpoGroupTelemetryEvent) => void },
): GrpoScoredCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new GrpoGroupContractError("GRPO scoring requires candidates", {
      obligation: "grpo.empty_group",
    });
  }
  if (candidates.length > GRPO_GROUP_SIZE_MAX) {
    throw new GrpoGroupContractError(
      `scoring batch exceeds GRPO max G=${GRPO_GROUP_SIZE_MAX}`,
      { obligation: "grpo.section_limit" },
    );
  }

  const scored: GrpoScoredCandidate[] = [];
  for (const c of candidates) {
    assertOpaqueId(c.subjectId, "subjectId", "grpo.subject_scope");
    assertOpaqueId(c.promptId, "promptId", "grpo.prompt_mismatch", c.subjectId);
    assertOpaqueId(
      c.trajectoryId,
      "trajectoryId",
      "grpo.section_limit",
      c.subjectId,
    );
    assertPolicyHash(c.policyCheckpointHash, c.subjectId);

    if (c.trajectory.subjectId !== c.subjectId) {
      throw new GrpoGroupContractError(
        "trajectory.subjectId must match candidate subjectId",
        {
          obligation: "grpo.subject_scope",
          subjectId: c.subjectId,
          deviceId: c.deviceId,
        },
      );
    }

    const score = critic.score(c.trajectory);
    try {
      assertCriticScore(score, critic.rubricVersion);
    } catch {
      throw new GrpoGroupContractError("critic score failed validation", {
        obligation: "grpo.invalid_score",
        subjectId: c.subjectId,
        deviceId: c.deviceId,
      });
    }
    if (score.rubricVersion !== critic.rubricVersion) {
      throw new GrpoGroupContractError(
        "critic score rubricVersion must match critic",
        {
          obligation: "grpo.mixed_critic_version",
          subjectId: c.subjectId,
          deviceId: c.deviceId,
          failingSlice: score.rubricVersion,
        },
      );
    }

    opts?.onTelemetry?.({
      event: "learning.grpo.critic_score",
      outcome: "ok",
      subjectId: c.subjectId,
      deviceId: c.deviceId,
      promptId: c.promptId,
      criticRubricId: critic.rubricId,
      criticRubricVersion: critic.rubricVersion,
    });

    scored.push({
      ...c,
      score,
      reward: score.total,
    });
  }
  return scored;
}

/**
 * Assemble a GRPO group: G∈[4,8], shared promptId / subject / policy hash /
 * critic version. Identical rewards → σ skip (not admitted for advantage).
 */
export function assembleGrpoGroup(input: {
  candidates: readonly GrpoScoredCandidate[];
  criticRubricId: string;
  criticRubricVersion: string;
  lineage: {
    corpusManifestId: string;
    baseCheckpointHash: string;
    hyperparametersId?: string;
    loraRank?: number;
    loraAlpha?: number;
  };
  groupId?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: GrpoGroupTelemetryEvent) => void;
}): GrpoGroupResult {
  const subjectId =
    input.subjectId ?? input.candidates[0]?.subjectId ?? "grpo";
  const deviceId = input.deviceId ?? input.candidates[0]?.deviceId ?? "ci";

  if (input.groupId !== undefined) {
    const cached = groupDecisionCache.get(input.groupId);
    if (cached) {
      input.onTelemetry?.({
        event: cached.skipped
          ? "learning.grpo.group_skip"
          : "learning.grpo.group_sample",
        outcome: cached.skipped ? "advisory" : "ok",
        subjectId: cached.subjectId,
        deviceId: cached.deviceId,
        promptId: cached.promptId,
        groupSize: cached.groupSize,
        policyCheckpointHash: cached.policyCheckpointHash,
        sigma: cached.sigma,
        meanReward: cached.meanReward,
        skipped: cached.skipped,
        idempotentReplay: true,
      });
      return cached;
    }
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new GrpoGroupContractError("GRPO group requires candidates", {
      obligation: "grpo.empty_group",
      subjectId,
      deviceId,
    });
  }

  const g = input.candidates.length;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    input.onTelemetry?.({
      event: "learning.grpo.group_sample",
      outcome: "fail",
      subjectId,
      deviceId,
      groupSize: g,
      failureClass: "grpo.group_size",
    });
    throw new GrpoGroupContractError(
      `GRPO group size must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}] — got ${g}`,
      { obligation: "grpo.group_size", subjectId, deviceId },
    );
  }

  assertOpaqueId(
    input.criticRubricId,
    "criticRubricId",
    "grpo.mixed_critic_version",
    subjectId,
  );
  assertOpaqueId(
    input.criticRubricVersion,
    "criticRubricVersion",
    "grpo.mixed_critic_version",
    subjectId,
  );
  assertOpaqueId(
    input.lineage.corpusManifestId,
    "corpusManifestId",
    "grpo.section_limit",
    subjectId,
  );
  const baseHash = assertPolicyHash(
    input.lineage.baseCheckpointHash,
    subjectId,
  );

  const promptId = input.candidates[0]!.promptId;
  const scopeSubject = input.candidates[0]!.subjectId;
  const policyHash = assertPolicyHash(
    input.candidates[0]!.policyCheckpointHash,
    scopeSubject,
  );

  for (const c of input.candidates) {
    if (!c.subjectId) {
      throw new GrpoGroupContractError("subjectId required", {
        obligation: "grpo.subject_scope",
        deviceId,
      });
    }
    if (c.subjectId !== scopeSubject) {
      throw new GrpoGroupContractError("cross-subject GRPO group refused", {
        obligation: "grpo.subject_scope",
        subjectId: c.subjectId,
        deviceId: c.deviceId,
        failingSlice: c.subjectId,
      });
    }
    if (c.promptId !== promptId) {
      throw new GrpoGroupContractError(
        "all G candidates must share the same promptId",
        {
          obligation: "grpo.prompt_mismatch",
          subjectId: c.subjectId,
          deviceId: c.deviceId,
          failingSlice: c.promptId,
        },
      );
    }
    if (c.policyCheckpointHash !== policyHash) {
      throw new GrpoGroupContractError(
        "mixed policyCheckpointHash within GRPO group",
        {
          obligation: "grpo.mixed_policy",
          subjectId: c.subjectId,
          deviceId: c.deviceId,
          failingSlice: c.policyCheckpointHash,
        },
      );
    }
    if (c.score.rubricVersion !== input.criticRubricVersion) {
      throw new GrpoGroupContractError(
        "never mix critic scores across rubric versions in one group",
        {
          obligation: "grpo.mixed_critic_version",
          subjectId: c.subjectId,
          deviceId: c.deviceId,
          failingSlice: c.score.rubricVersion,
        },
      );
    }
    try {
      assertCriticScore(c.score, input.criticRubricVersion);
    } catch {
      throw new GrpoGroupContractError("invalid critic score in group", {
        obligation: "grpo.invalid_score",
        subjectId: c.subjectId,
        deviceId: c.deviceId,
      });
    }
  }

  const rewards = input.candidates.map((c) => c.reward);
  const sigmaGate = shouldSkipGrpoGroupNearZeroSigma(rewards, {
    subjectId: scopeSubject,
    deviceId,
  });

  const lineage: GrpoGroupLineage = {
    corpusManifestId: input.lineage.corpusManifestId,
    baseCheckpointHash: baseHash,
    criticRubricId: input.criticRubricId,
    criticRubricVersion: input.criticRubricVersion,
    ...(input.lineage.hyperparametersId !== undefined
      ? { hyperparametersId: input.lineage.hyperparametersId }
      : {}),
    ...(input.lineage.loraRank !== undefined
      ? { loraRank: input.lineage.loraRank }
      : {}),
    ...(input.lineage.loraAlpha !== undefined
      ? { loraAlpha: input.lineage.loraAlpha }
      : {}),
  };

  if (sigmaGate.skip) {
    const skipped: GrpoGroupSkipped = {
      admitted: false,
      skipped: true,
      schemaVersion: GRPO_GROUP_SCHEMA_VERSION,
      promptId,
      subjectId: scopeSubject,
      deviceId,
      groupSize: g,
      policyCheckpointHash: policyHash,
      criticRubricId: input.criticRubricId,
      criticRubricVersion: input.criticRubricVersion,
      rewards,
      meanReward: sigmaGate.mean,
      sigma: sigmaGate.sigma,
      failureClass: "grpo.sigma_skip",
      detail: `σ=${sigmaGate.sigma} < ${GRPO_SIGMA_EPSILON} — group skipped (identical or near-identical critic scores)`,
      lineage,
    };

    input.onTelemetry?.({
      event: "learning.grpo.group_skip",
      outcome: "advisory",
      subjectId: scopeSubject,
      deviceId,
      promptId,
      groupSize: g,
      policyCheckpointHash: policyHash,
      criticRubricId: input.criticRubricId,
      criticRubricVersion: input.criticRubricVersion,
      sigma: sigmaGate.sigma,
      meanReward: sigmaGate.mean,
      skipped: true,
      failureClass: "grpo.sigma_skip",
    });

    if (input.groupId !== undefined) {
      groupDecisionCache.set(input.groupId, skipped);
      if (groupDecisionCache.size > 64) {
        const first = groupDecisionCache.keys().next().value as
          | string
          | undefined;
        if (first !== undefined) groupDecisionCache.delete(first);
      }
    }
    return skipped;
  }

  const admitted: GrpoGroupAdmitted = {
    admitted: true,
    skipped: false,
    schemaVersion: GRPO_GROUP_SCHEMA_VERSION,
    promptId,
    subjectId: scopeSubject,
    deviceId,
    groupSize: g,
    policyCheckpointHash: policyHash,
    criticRubricId: input.criticRubricId,
    criticRubricVersion: input.criticRubricVersion,
    candidates: [...input.candidates],
    rewards,
    meanReward: sigmaGate.mean,
    sigma: sigmaGate.sigma,
    lineage,
  };

  input.onTelemetry?.({
    event: "learning.grpo.group_sample",
    outcome: "ok",
    subjectId: scopeSubject,
    deviceId,
    promptId,
    groupSize: g,
    policyCheckpointHash: policyHash,
    criticRubricId: input.criticRubricId,
    criticRubricVersion: input.criticRubricVersion,
    sigma: sigmaGate.sigma,
    meanReward: sigmaGate.mean,
    skipped: false,
  });

  if (input.groupId !== undefined) {
    groupDecisionCache.set(input.groupId, admitted);
    if (groupDecisionCache.size > 64) {
      const first = groupDecisionCache.keys().next().value as
        | string
        | undefined;
      if (first !== undefined) groupDecisionCache.delete(first);
    }
  }

  return admitted;
}

/**
 * Sample + score + assemble in one call (injectable gym rollouts).
 */
export function sampleGrpoGroupFromRollouts(input: {
  candidates: readonly GrpoRolloutCandidate[];
  critic: TrajectoryCritic;
  lineage: {
    corpusManifestId: string;
    baseCheckpointHash: string;
    hyperparametersId?: string;
    loraRank?: number;
    loraAlpha?: number;
  };
  groupId?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: GrpoGroupTelemetryEvent) => void;
}): GrpoGroupResult {
  const g = input.candidates?.length ?? 0;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    const subjectId = input.subjectId ?? input.candidates?.[0]?.subjectId;
    const deviceId = input.deviceId ?? input.candidates?.[0]?.deviceId;
    input.onTelemetry?.({
      event: "learning.grpo.group_sample",
      outcome: "fail",
      subjectId: subjectId ?? "grpo",
      deviceId: deviceId ?? "ci",
      groupSize: g,
      failureClass: "grpo.group_size",
    });
    throw new GrpoGroupContractError(
      `GRPO group size must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}] — got ${g}`,
      {
        obligation: "grpo.group_size",
        ...(subjectId !== undefined ? { subjectId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
      },
    );
  }

  const scored = scoreGrpoRolloutCandidates(input.candidates, input.critic, {
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  return assembleGrpoGroup({
    candidates: scored,
    criticRubricId: input.critic.rubricId,
    criticRubricVersion: input.critic.rubricVersion,
    lineage: input.lineage,
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
}

/**
 * Micro-run: G synthetic gym-shaped rollouts → critic scores → assemble group.
 * Records lineage; never carries raw learner content in telemetry.
 * Pass a critic that differentiates candidates for admit; identical scores → σ skip.
 */
export function proveGrpoGroupSamplingMicroRun(input: {
  subjectId: string;
  deviceId: string;
  promptId: string;
  policyCheckpointHash: string;
  critic: TrajectoryCritic;
  groupSize?: number;
  corpusManifestId?: string;
  hyperparametersId?: string;
  loraRank?: number;
  loraAlpha?: number;
  onTelemetry?: (e: GrpoGroupTelemetryEvent) => void;
}): {
  ok: true;
  group: GrpoGroupResult;
  lineage: GrpoGroupLineage;
} {
  const g = input.groupSize ?? GRPO_GROUP_SIZE_MIN;
  if (g < GRPO_GROUP_SIZE_MIN || g > GRPO_GROUP_SIZE_MAX) {
    throw new GrpoGroupContractError(
      `micro-run groupSize must be in [${GRPO_GROUP_SIZE_MIN}, ${GRPO_GROUP_SIZE_MAX}]`,
      { obligation: "grpo.group_size", subjectId: input.subjectId },
    );
  }

  const candidates: GrpoRolloutCandidate[] = Array.from(
    { length: g },
    (_, i) => {
      const trajectoryId = `traj.grpo.micro.${i + 1}`;
      const trajectory: TurnTrajectoryRecord = {
        schemaVersion: "trajectory.v1",
        subjectId: input.subjectId,
        sessionId: `sess.grpo.${input.promptId}`,
        turnId: trajectoryId,
        deviceId: input.deviceId,
        capturedAt: "2026-07-16T12:00:00.000Z",
        locality: "on-device",
        consent: {
          optedIn: true,
          consentClass: "research",
          recordedAt: "2026-07-16T12:00:00.000Z",
        },
        stages: [
          { stage: "act", opCode: "tool.write", status: "ok" },
        ],
        policyCheckpointHash: input.policyCheckpointHash,
        rolloutSeed: i + 1,
      };
      return {
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        promptId: input.promptId,
        trajectoryId,
        policyCheckpointHash: input.policyCheckpointHash,
        trajectory,
      };
    },
  );

  const group = sampleGrpoGroupFromRollouts({
    candidates,
    critic: input.critic,
    lineage: {
      corpusManifestId: input.corpusManifestId ?? "corpus.grpo.micro.v1",
      baseCheckpointHash: input.policyCheckpointHash,
      ...(input.hyperparametersId !== undefined
        ? { hyperparametersId: input.hyperparametersId }
        : {}),
      ...(input.loraRank !== undefined ? { loraRank: input.loraRank } : {}),
      ...(input.loraAlpha !== undefined ? { loraAlpha: input.loraAlpha } : {}),
    },
    groupId: `group.micro.${input.subjectId}.${input.promptId}`,
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  return {
    ok: true,
    group,
    lineage: group.lineage,
  };
}

/** Test helper — clear idempotent group cache. */
export function resetGrpoGroupCache(): void {
  groupDecisionCache.clear();
}
