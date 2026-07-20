/**
 * SLM-scale pack SFT size gate and quality filter.
 *
 * First training jobs target hundreds of high-quality examples — not thousands
 * (and never 5k-class). Critic score floor filters distillation quality.
 * Lane size reports are emitted per pack (counts only — no raw content).
 */

import {
  CORPUS_CURRICULUM_STAGES,
  type CorpusCurriculumStage,
  type CorpusManifest,
} from "../build.js";

/** Hundreds-class ceiling for a pack SFT lane (not thousands). */
export const PACK_SFT_SLM_MAX_LANE_SOURCES = 999;

/**
 * Minimum accepted sources for a first training job gate
 * (hundreds-class floor).
 */
export const PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES = 100;

/** Explicit thousands reject threshold (inclusive). */
export const PACK_SFT_SLM_THOUSANDS_REJECT_AT = 1000;

/** Default critic quality floor (aligned with distillation critic). */
export const PACK_SFT_QUALITY_CRITIC_FLOOR = 0.6;

export const PACK_SFT_LANE_SIZE_REPORT_SCHEMA_VERSION =
  "training.pack-sft-lane-size-report.v1" as const;

export type PackSftSizeGateMode = "max_only" | "first_job";

export type PackSftSizeGateFailureClass =
  | "size_gate"
  | "quality_filter"
  | "config";

export type PackSftLaneSizeCounts = {
  sourceCount: number;
  byKind: Record<string, number>;
  byStage: Record<CorpusCurriculumStage, number>;
  distilledCount: number;
  consentedTrajectoryCount: number;
  belowCriticFloorCount: number;
};

export type PackSftLaneSizeReport = {
  schemaVersion: typeof PACK_SFT_LANE_SIZE_REPORT_SCHEMA_VERSION;
  packId: string;
  laneCode: string;
  manifestId?: string;
  counts: PackSftLaneSizeCounts;
  sizeGate: {
    mode: PackSftSizeGateMode;
    minSources: number;
    maxSources: number;
    thousandsRejectAt: number;
    outcome: "ok" | "error";
    failureClass?: PackSftSizeGateFailureClass;
    detail?: string;
  };
  qualityFilter: {
    criticFloor: number;
    outcome: "ok" | "error";
    excludedBelowFloor: number;
    detail?: string;
  };
};

export type PackSftMultiLaneSizeReport = {
  schemaVersion: "training.pack-sft-multi-lane-size-report.v1";
  lanes: PackSftLaneSizeReport[];
  totalSources: number;
};

export type SizeGateOk = { ok: true };
export type SizeGateFail = {
  ok: false;
  failureClass: PackSftSizeGateFailureClass;
  detail: string;
};

function emptyStageCounts(): Record<CorpusCurriculumStage, number> {
  return {
    protocol: 0,
    tool_use: 0,
    domain_depth: 0,
    repair: 0,
  };
}

/**
 * Assert SLM hundreds-not-thousands size bounds.
 * `max_only` — reject ≥ thousands / above hundreds ceiling.
 * `first_job` — also require ≥ hundreds floor.
 */
export function assertPackSftSlmSizeGate(
  sourceCount: number,
  options: {
    mode?: PackSftSizeGateMode;
    minSources?: number;
    maxSources?: number;
    thousandsRejectAt?: number;
  } = {},
): SizeGateOk | SizeGateFail {
  if (!Number.isFinite(sourceCount) || sourceCount < 0) {
    return {
      ok: false,
      failureClass: "config",
      detail: `invalid sourceCount=${String(sourceCount)}`,
    };
  }

  const mode = options.mode ?? "max_only";
  const maxSources = options.maxSources ?? PACK_SFT_SLM_MAX_LANE_SOURCES;
  const minSources = options.minSources ?? PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES;
  const thousandsRejectAt =
    options.thousandsRejectAt ?? PACK_SFT_SLM_THOUSANDS_REJECT_AT;

  if (sourceCount >= thousandsRejectAt) {
    return {
      ok: false,
      failureClass: "size_gate",
      detail: `lane sourceCount=${sourceCount} is thousands-class (reject ≥ ${thousandsRejectAt}); SLM first jobs stay hundreds-scale`,
    };
  }

  if (sourceCount > maxSources) {
    return {
      ok: false,
      failureClass: "size_gate",
      detail: `lane sourceCount=${sourceCount} exceeds SLM max ${maxSources} (hundreds-not-thousands)`,
    };
  }

  if (mode === "first_job" && sourceCount < minSources) {
    return {
      ok: false,
      failureClass: "size_gate",
      detail: `first training job requires ≥ ${minSources} sources (got ${sourceCount}); hundreds-class floor`,
    };
  }

  return { ok: true };
}

/**
 * Quality filter: distilled (and any scored) candidates must meet critic floor.
 * Unknown license / missing bytes are handled elsewhere — this is score-only.
 */
export function applyPackSftQualityFilter<
  T extends {
    sourceId: string;
    kind: string;
    criticScore?: number;
  },
>(
  candidates: readonly T[],
  options: { criticFloor?: number } = {},
): {
  accepted: T[];
  excluded: {
    sourceId: string;
    reason: "quality_filter";
    detail: string;
    criticScore?: number;
  }[];
  criticFloor: number;
} {
  const criticFloor = options.criticFloor ?? PACK_SFT_QUALITY_CRITIC_FLOOR;
  const accepted: T[] = [];
  const excluded: {
    sourceId: string;
    reason: "quality_filter";
    detail: string;
    criticScore?: number;
  }[] = [];

  // Bound scan (NFR).
  const capped = candidates.slice(0, PACK_SFT_SLM_MAX_LANE_SOURCES + 1);

  for (const cand of capped) {
    const needsScore =
      cand.kind === "distilled_trace" || cand.criticScore !== undefined;
    if (!needsScore) {
      accepted.push(cand);
      continue;
    }
    const score = cand.criticScore;
    if (typeof score !== "number" || Number.isNaN(score) || score < criticFloor) {
      excluded.push({
        sourceId: cand.sourceId,
        reason: "quality_filter",
        detail: `criticScore ${String(score)} < floor ${criticFloor}`,
        ...(typeof score === "number" ? { criticScore: score } : {}),
      });
      continue;
    }
    accepted.push(cand);
  }

  return { accepted, excluded, criticFloor };
}

export type LaneSizeSourceInput = {
  sourceId: string;
  kind?: string;
  curriculumStage?: CorpusCurriculumStage;
  criticScore?: number;
};

/**
 * Build a per-pack lane size + quality report (counts only).
 */
export function buildPackSftLaneSizeReport(input: {
  packId: string;
  laneCode: string;
  manifestId?: string;
  sources: readonly LaneSizeSourceInput[];
  mode?: PackSftSizeGateMode;
  criticFloor?: number;
  belowCriticFloorCount?: number;
  minSources?: number;
  maxSources?: number;
}): PackSftLaneSizeReport {
  const mode = input.mode ?? "max_only";
  const criticFloor = input.criticFloor ?? PACK_SFT_QUALITY_CRITIC_FLOOR;
  const maxSources = input.maxSources ?? PACK_SFT_SLM_MAX_LANE_SOURCES;
  const minSources = input.minSources ?? PACK_SFT_SLM_MIN_FIRST_JOB_SOURCES;

  const byKind: Record<string, number> = {};
  const byStage = emptyStageCounts();
  let distilledCount = 0;
  let consentedTrajectoryCount = 0;

  for (const src of input.sources.slice(0, maxSources + 1)) {
    const kind = src.kind ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === "distilled_trace") distilledCount += 1;
    if (kind === "consented_trajectory") consentedTrajectoryCount += 1;
    if (
      src.curriculumStage !== undefined &&
      (CORPUS_CURRICULUM_STAGES as readonly string[]).includes(src.curriculumStage)
    ) {
      byStage[src.curriculumStage] += 1;
    }
  }

  const sourceCount = input.sources.length;
  const sizeCheck = assertPackSftSlmSizeGate(sourceCount, {
    mode,
    minSources,
    maxSources,
  });

  const belowFloor = input.belowCriticFloorCount ?? 0;
  const qualityOk = belowFloor === 0;

  return {
    schemaVersion: PACK_SFT_LANE_SIZE_REPORT_SCHEMA_VERSION,
    packId: input.packId,
    laneCode: input.laneCode,
    ...(input.manifestId !== undefined ? { manifestId: input.manifestId } : {}),
    counts: {
      sourceCount,
      byKind,
      byStage,
      distilledCount,
      consentedTrajectoryCount,
      belowCriticFloorCount: belowFloor,
    },
    sizeGate: {
      mode,
      minSources,
      maxSources,
      thousandsRejectAt: PACK_SFT_SLM_THOUSANDS_REJECT_AT,
      outcome: sizeCheck.ok ? "ok" : "error",
      ...(!sizeCheck.ok
        ? {
            failureClass: sizeCheck.failureClass,
            detail: sizeCheck.detail,
          }
        : {}),
    },
    qualityFilter: {
      criticFloor,
      outcome: qualityOk ? "ok" : "error",
      excludedBelowFloor: belowFloor,
      ...(!qualityOk
        ? {
            detail: `${belowFloor} source(s) below critic floor ${criticFloor}`,
          }
        : {}),
    },
  };
}

/**
 * First-training-job readiness: hundreds floor + hundreds ceiling + quality ok.
 */
export function gatePackSftLaneForFirstTrainingJob(
  report: PackSftLaneSizeReport,
): SizeGateOk | SizeGateFail {
  if (report.qualityFilter.outcome !== "ok") {
    return {
      ok: false,
      failureClass: "quality_filter",
      detail:
        report.qualityFilter.detail ??
        "quality filter failed for first training job",
    };
  }

  const sized = assertPackSftSlmSizeGate(report.counts.sourceCount, {
    mode: "first_job",
    minSources: report.sizeGate.minSources,
    maxSources: report.sizeGate.maxSources,
    thousandsRejectAt: report.sizeGate.thousandsRejectAt,
  });
  if (!sized.ok) return sized;
  return { ok: true };
}

/**
 * Aggregate lane size reports across packs (deterministic packId sort).
 */
export function reportPackSftLaneSizes(
  lanes: readonly PackSftLaneSizeReport[],
): PackSftMultiLaneSizeReport {
  const sorted = [...lanes].sort((a, b) => a.packId.localeCompare(b.packId));
  return {
    schemaVersion: "training.pack-sft-multi-lane-size-report.v1",
    lanes: sorted,
    totalSources: sorted.reduce((n, l) => n + l.counts.sourceCount, 0),
  };
}

/**
 * Derive a lane size report from an assembled corpus manifest.
 * Source kinds are inferred from sourceId prefixes when kind metadata is absent.
 */
export function laneSizeReportFromManifest(
  manifest: CorpusManifest,
  options: {
    packId: string;
    mode?: PackSftSizeGateMode;
    criticFloor?: number;
    belowCriticFloorCount?: number;
    sourceKinds?: Record<string, string>;
  },
): PackSftLaneSizeReport {
  return buildPackSftLaneSizeReport({
    packId: options.packId,
    laneCode: manifest.laneCodes[0] ?? options.packId,
    manifestId: manifest.manifestId,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.criticFloor !== undefined
      ? { criticFloor: options.criticFloor }
      : {}),
    ...(options.belowCriticFloorCount !== undefined
      ? { belowCriticFloorCount: options.belowCriticFloorCount }
      : {}),
    sources: manifest.sources.map((s) => {
      const kind = options.sourceKinds?.[s.sourceId];
      return {
        sourceId: s.sourceId,
        ...(kind !== undefined ? { kind } : {}),
        ...(s.curriculumStage !== undefined
          ? { curriculumStage: s.curriculumStage }
          : {}),
      };
    }),
  });
}
