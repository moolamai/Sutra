/**
 * SLM pack-SFT curriculum ordering.
 *
 * Stage sequence: protocol → tool_use → domain_depth → repair-heavy finales.
 * Train order is documented in manifest `curriculum` metadata (canonical
 * source arrays remain sorted by sourceId for rebuild identity).
 */

import {
  CORPUS_CURRICULUM_STAGES,
  PACK_SFT_CURRICULUM_SCHEMA_VERSION,
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  type CorpusCurriculum,
  type CorpusCurriculumStage,
  type CorpusSource,
} from "../build.js";

export {
  PACK_SFT_CURRICULUM_SCHEMA_VERSION,
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
};

export const PACK_SFT_CURRICULUM_STAGE_ORDER = CORPUS_CURRICULUM_STAGES;

export type CurriculumTaggedSource = Pick<
  CorpusSource,
  "sourceId" | "curriculumStage"
> & {
  curriculumStage: CorpusCurriculumStage;
};

export type CurriculumOrderFail = {
  ok: false;
  failureClass: "curriculum_order" | "schema";
  detail: string;
};

export type CurriculumOrderOk = {
  ok: true;
  curriculum: CorpusCurriculum;
  orderedSources: CurriculumTaggedSource[];
};

function emptyCounts(): Record<CorpusCurriculumStage, number> {
  return {
    protocol: 0,
    tool_use: 0,
    domain_depth: 0,
    repair: 0,
  };
}

function emptyWeights(): Record<CorpusCurriculumStage, number> {
  return {
    protocol: 0,
    tool_use: 0,
    domain_depth: 0,
    repair: 0,
  };
}

/**
 * Sort sources: curriculum stage order, then sourceId (deterministic).
 */
export function orderSourcesByCurriculum<T extends CurriculumTaggedSource>(
  sources: readonly T[],
): T[] {
  return [...sources].sort((a, b) => {
    const ai = CORPUS_CURRICULUM_STAGES.indexOf(a.curriculumStage);
    const bi = CORPUS_CURRICULUM_STAGES.indexOf(b.curriculumStage);
    if (ai !== bi) return ai - bi;
    return a.sourceId.localeCompare(b.sourceId);
  });
}

/**
 * Repair-heavy sampling weights: when repair sources exist alongside earlier
 * stages, repair targets ~50%; remaining mass splits equally across other
 * non-empty stages. Otherwise weights are proportional to stage counts.
 */
export function computeRepairHeavyStageWeights(
  stageCounts: Record<CorpusCurriculumStage, number>,
  repairHeavyTargetWeight: number = PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
): Record<CorpusCurriculumStage, number> {
  const weights = emptyWeights();
  const total = CORPUS_CURRICULUM_STAGES.reduce(
    (n, s) => n + stageCounts[s],
    0,
  );
  if (total < 1) return weights;

  const present = CORPUS_CURRICULUM_STAGES.filter((s) => stageCounts[s] > 0);
  if (present.length === 1) {
    weights[present[0]!] = 1;
    return weights;
  }

  if (stageCounts.repair > 0 && present.length > 1) {
    const target = Math.min(1, Math.max(0, repairHeavyTargetWeight));
    weights.repair = target;
    const others = present.filter((s) => s !== "repair");
    const remaining = 1 - target;
    const each = remaining / others.length;
    for (const s of others) weights[s] = each;
    return weights;
  }

  for (const s of CORPUS_CURRICULUM_STAGES) {
    weights[s] = stageCounts[s] / total;
  }
  return weights;
}

/**
 * Build curriculum metadata for a pack SFT manifest lane.
 * Rejects missing stage tags (typed failure — never silent).
 */
export function buildPackSftCurriculumMetadata(
  sources: readonly {
    sourceId: string;
    curriculumStage?: CorpusCurriculumStage;
  }[],
  options: {
    repairHeavyTargetWeight?: number;
  } = {},
): CurriculumOrderOk | CurriculumOrderFail {
  if (sources.length < 1) {
    return {
      ok: false,
      failureClass: "curriculum_order",
      detail: "curriculum requires at least one source",
    };
  }

  const tagged: CurriculumTaggedSource[] = [];
  for (const src of sources) {
    if (src.curriculumStage === undefined) {
      return {
        ok: false,
        failureClass: "curriculum_order",
        detail: `missing curriculumStage on sourceId=${src.sourceId}`,
      };
    }
    tagged.push({
      sourceId: src.sourceId,
      curriculumStage: src.curriculumStage,
    });
  }

  const ordered = orderSourcesByCurriculum(tagged);
  const stageCounts = emptyCounts();
  for (const s of ordered) {
    stageCounts[s.curriculumStage] += 1;
  }

  const repairHeavyTargetWeight =
    options.repairHeavyTargetWeight ?? PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT;
  const stageWeights = computeRepairHeavyStageWeights(
    stageCounts,
    repairHeavyTargetWeight,
  );

  const curriculum: CorpusCurriculum = {
    schemaVersion: PACK_SFT_CURRICULUM_SCHEMA_VERSION,
    stageOrder: [...CORPUS_CURRICULUM_STAGES],
    repairHeavyTargetWeight,
    stageCounts,
    stageWeights,
    orderedSourceIds: ordered.map((s) => s.sourceId),
  };

  return { ok: true, curriculum, orderedSources: ordered };
}

/**
 * Assert curriculum.orderedSourceIds matches stage→sourceId sort.
 */
export function assertCurriculumOrdering(
  curriculum: CorpusCurriculum,
  sources: readonly {
    sourceId: string;
    curriculumStage?: CorpusCurriculumStage;
  }[],
): { ok: true } | CurriculumOrderFail {
  const built = buildPackSftCurriculumMetadata(sources, {
    repairHeavyTargetWeight: curriculum.repairHeavyTargetWeight,
  });
  if (!built.ok) return built;

  if (
    curriculum.orderedSourceIds.length !==
      built.curriculum.orderedSourceIds.length ||
    curriculum.orderedSourceIds.some(
      (id, i) => id !== built.curriculum.orderedSourceIds[i],
    )
  ) {
    return {
      ok: false,
      failureClass: "curriculum_order",
      detail: "orderedSourceIds diverge from protocol→…→repair stage sort",
    };
  }

  for (const stage of CORPUS_CURRICULUM_STAGES) {
    if (curriculum.stageOrder[CORPUS_CURRICULUM_STAGES.indexOf(stage)] !== stage) {
      return {
        ok: false,
        failureClass: "curriculum_order",
        detail: "stageOrder must be protocol → tool_use → domain_depth → repair",
      };
    }
  }

  return { ok: true };
}
