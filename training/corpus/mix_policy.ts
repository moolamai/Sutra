/**
 * Training mix policy — machine mirror of docs/learning/MIX_POLICY.md.
 *
 * Governance constants + corpus-manifest linter: RET zero weight, MEM thin,
 * repair-heavy ~50%, curriculum stage order. CI prove: golden green + red
 * violation fixtures.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CORPUS_CURRICULUM_STAGES,
  CORPUS_PACKAGE_ROOT,
  PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT,
  loadCorpusManifestFile,
  parseCorpusManifest,
  type CorpusCurriculumStage,
  type CorpusManifest,
} from "./build.js";
import { resolveCorpusRepoRoot } from "./decontaminate.js";

export const MIX_POLICY_DOC_RELPATH = "docs/learning/MIX_POLICY.md" as const;
export const MIX_POLICY_SIGNOFF_RELPATH =
  "docs/learning/MIX_POLICY_SIGNOFF.json" as const;
export const MIX_POLICY_SCHEMA_VERSION = "training.mix-policy.v1" as const;
export const MIX_POLICY_SIGNOFF_SCHEMA_VERSION =
  "training.mix-policy-signoff.v1" as const;

/** Target share for repair / failure / decision-graph stage. */
export const MIX_REPAIR_TARGET_WEIGHT = PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT;

/** Absolute tolerance around repair target before lint fails. */
export const MIX_REPAIR_TOLERANCE = 0.05;

/** Hard ceiling for MEM in the weight mix ("thin"). */
export const MIX_MEM_MAX_WEIGHT = 0.15;

/** RET never contributes to sampling weights. */
export const MIX_RET_WEIGHT = 0;

/** Fixed curriculum stage order (protocol → … → repair). */
export const MIX_CURRICULUM_STAGE_ORDER = CORPUS_CURRICULUM_STAGES;

/** Minimum distinct stakeholder roles required to ratify. */
export const MIX_POLICY_MIN_STAKEHOLDERS = 2;

/** Required stakeholder roles on the ratified sign-off. */
export const MIX_POLICY_REQUIRED_STAKEHOLDER_ROLES = Object.freeze([
  "track_c_corpus_owner",
  "learning_governance",
] as const);

/** Real pack lanes used as worked examples in MIX_POLICY.md. */
export const MIX_POLICY_EXAMPLE_PACK_IDS = Object.freeze([
  "pack.teacher.cbse-slice",
  "pack.doctor.formulary-sketch",
] as const);

export type MixPolicyFailureClass =
  | "ret_in_weights"
  | "mem_over_thin"
  | "repair_out_of_band"
  | "curriculum_mismatch"
  | "config"
  | "doc_missing"
  | "signoff_missing"
  | "signoff_incomplete"
  | "version_mismatch"
  | "promotion_blocked";

export type MixPolicyTelemetry = {
  event: "training.mix_policy";
  op:
    | "validate"
    | "prove_doc"
    | "compute_weights"
    | "lint"
    | "prove_lint"
    | "compute_version"
    | "signoff"
    | "promote"
    | "prove_ratify";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  manifestId?: string;
  packId?: string;
  laneCode?: string;
  mixPolicyVersion?: string;
  failureClass?: MixPolicyFailureClass;
  detail?: string;
};

/** Fixture directory for mix-policy lint prove (package-relative). */
export const MIX_POLICY_LINT_FIXTURE_DIR = "fixtures/mix_policy" as const;
export const MIX_POLICY_LINT_OK_REPAIR = "ok-repair-curriculum.json" as const;
export const MIX_POLICY_LINT_VIOLATION_RET = "violation-ret-in-weights.json" as const;
export const MIX_POLICY_LINT_VIOLATION_REPAIR =
  "violation-repair-out-of-band.json" as const;
export const MIX_POLICY_LINT_VIOLATION_VERSION =
  "violation-version-mismatch.json" as const;

export type MixModeWeights = {
  MEM: number;
  UND: number;
  RET: number;
};

export type MixStageWeights = Record<CorpusCurriculumStage, number>;

function emit(
  onTelemetry: ((e: MixPolicyTelemetry) => void) | undefined,
  partial: Omit<MixPolicyTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.mix_policy", ...partial });
}

function emptyStageWeights(): MixStageWeights {
  return {
    protocol: 0,
    tool_use: 0,
    domain_depth: 0,
    repair: 0,
  };
}

/**
 * Resolve repo-relative path to the committed mix policy document.
 */
export function resolveMixPolicyDocumentPath(
  packageRoot: string = CORPUS_PACKAGE_ROOT,
): string {
  return path.resolve(resolveCorpusRepoRoot(packageRoot), MIX_POLICY_DOC_RELPATH);
}

/**
 * Resolve repo-relative path to the stakeholder sign-off artifact.
 */
export function resolveMixPolicySignoffPath(
  packageRoot: string = CORPUS_PACKAGE_ROOT,
): string {
  return path.resolve(
    resolveCorpusRepoRoot(packageRoot),
    MIX_POLICY_SIGNOFF_RELPATH,
  );
}

/**
 * Prove the governance document is present and carries required headings.
 */
export function proveMixPolicyDocumentPresent(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | { ok: true; absPath: string; bytes: number }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass;
      detail: string;
    } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy";
  const absPath = resolveMixPolicyDocumentPath(options.packageRoot);

  if (!existsSync(absPath)) {
    emit(options.onTelemetry, {
      op: "prove_doc",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "doc_missing",
      detail: `missing ${MIX_POLICY_DOC_RELPATH}`,
    });
    return {
      ok: false,
      failureClass: "doc_missing",
      detail: `mix policy document missing: ${MIX_POLICY_DOC_RELPATH}`,
    };
  }

  const text = readFileSync(absPath, "utf8");
  const required = [
    "MIX_REPAIR_TARGET_WEIGHT",
    "MIX_MEM_MAX_WEIGHT",
    "pack.teacher.cbse-slice",
    "pack.doctor.formulary-sketch",
    "RET has zero weight",
    "Repair-heavy finales",
    "Ratification, version hash, and promotion",
    "mixPolicyVersion",
  ];
  for (const needle of required) {
    if (!text.includes(needle)) {
      emit(options.onTelemetry, {
        op: "prove_doc",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "doc_missing",
        detail: `document missing required marker: ${needle}`,
      });
      return {
        ok: false,
        failureClass: "doc_missing",
        detail: `MIX_POLICY.md missing required marker: ${needle}`,
      };
    }
  }

  emit(options.onTelemetry, {
    op: "prove_doc",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: `bytes=${Buffer.byteLength(text, "utf8")}`,
  });

  return {
    ok: true,
    absPath,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/**
 * Validate numeric mix weights against governance bands.
 * Idempotent pure check — safe under concurrent callers.
 */
export function assertMixPolicyWeights(
  input: {
    stageWeights?: Partial<MixStageWeights>;
    modeWeights?: Partial<MixModeWeights>;
    repairSourcesPresent?: boolean;
  },
  options: {
    subjectId?: string;
    deviceId?: string;
    manifestId?: string;
    packId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | { ok: true }
  | { ok: false; failureClass: MixPolicyFailureClass; detail: string } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy";

  const fail = (
    failureClass: MixPolicyFailureClass,
    detail: string,
  ): { ok: false; failureClass: MixPolicyFailureClass; detail: string } => {
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      ...(options.manifestId !== undefined
        ? { manifestId: options.manifestId }
        : {}),
      ...(options.packId !== undefined ? { packId: options.packId } : {}),
      failureClass,
      detail,
    });
    return { ok: false, failureClass, detail };
  };

  const mode: MixModeWeights = {
    MEM: input.modeWeights?.MEM ?? 0,
    UND: input.modeWeights?.UND ?? (input.modeWeights === undefined ? 1 : 0),
    RET: input.modeWeights?.RET ?? 0,
  };

  if (mode.RET !== MIX_RET_WEIGHT) {
    return fail(
      "ret_in_weights",
      `RET weight must be ${MIX_RET_WEIGHT} (got ${mode.RET})`,
    );
  }

  if (mode.MEM > MIX_MEM_MAX_WEIGHT) {
    return fail(
      "mem_over_thin",
      `MEM weight ${mode.MEM} exceeds thin cap ${MIX_MEM_MAX_WEIGHT}`,
    );
  }

  if (input.modeWeights !== undefined) {
    const modeSum = mode.MEM + mode.UND + mode.RET;
    if (Math.abs(modeSum - 1) > 1e-9) {
      return fail(
        "config",
        `mode weights must sum to 1 when set (got ${modeSum})`,
      );
    }
  }

  if (input.stageWeights !== undefined) {
    const stages: MixStageWeights = {
      ...emptyStageWeights(),
      ...input.stageWeights,
    };
    const stageSum =
      stages.protocol +
      stages.tool_use +
      stages.domain_depth +
      stages.repair;
    if (Math.abs(stageSum - 1) > 1e-9) {
      return fail(
        "config",
        `stageWeights must sum to 1 (got ${stageSum})`,
      );
    }

    const repairPresent = input.repairSourcesPresent === true;
    if (repairPresent) {
      const lo = MIX_REPAIR_TARGET_WEIGHT - MIX_REPAIR_TOLERANCE;
      const hi = MIX_REPAIR_TARGET_WEIGHT + MIX_REPAIR_TOLERANCE;
      if (stages.repair < lo || stages.repair > hi) {
        return fail(
          "repair_out_of_band",
          `repair weight ${stages.repair} outside [${lo}, ${hi}]`,
        );
      }
    }
  }

  emit(options.onTelemetry, {
    op: "validate",
    outcome: "ok",
    subjectId,
    deviceId,
    ...(options.manifestId !== undefined
      ? { manifestId: options.manifestId }
      : {}),
    ...(options.packId !== undefined ? { packId: options.packId } : {}),
    detail: `repairTarget=${MIX_REPAIR_TARGET_WEIGHT};memCap=${MIX_MEM_MAX_WEIGHT}`,
  });

  return { ok: true };
}

/**
 * Derive mode weight shares from a corpus manifest (weight-eligible modes only).
 * RET sources contribute 0 even if listed.
 */
export function computeModeWeightsFromManifest(
  manifest: CorpusManifest,
): MixModeWeights {
  const excluded = new Set(manifest.weightTrainingPolicy.excludeKnowledgeModes);
  let mem = 0;
  let und = 0;
  let total = 0;
  for (const src of manifest.sources) {
    if (src.knowledgeMode === "RET") continue;
    if (excluded.has(src.knowledgeMode)) continue;
    if (src.knowledgeMode === "MEM") {
      mem += 1;
      total += 1;
    } else if (src.knowledgeMode === "UND") {
      und += 1;
      total += 1;
    }
  }
  if (total < 1) {
    return { MEM: 0, UND: 1, RET: MIX_RET_WEIGHT };
  }
  return {
    MEM: mem / total,
    UND: und / total,
    RET: MIX_RET_WEIGHT,
  };
}

/**
 * Soft check: manifest curriculum stageOrder matches governance order.
 */
export function assertManifestCurriculumMatchesMixPolicy(
  manifest: CorpusManifest,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | { ok: true }
  | { ok: false; failureClass: MixPolicyFailureClass; detail: string } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy";

  if (manifest.curriculum === undefined) {
    return { ok: true };
  }

  const order = manifest.curriculum.stageOrder;
  if (
    order.length !== MIX_CURRICULUM_STAGE_ORDER.length ||
    order.some((s, i) => s !== MIX_CURRICULUM_STAGE_ORDER[i])
  ) {
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "curriculum_mismatch",
      detail: "curriculum.stageOrder must match MIX_CURRICULUM_STAGE_ORDER",
    });
    return {
      ok: false,
      failureClass: "curriculum_mismatch",
      detail: "curriculum.stageOrder must match MIX_CURRICULUM_STAGE_ORDER",
    };
  }

  const repairPresent = (manifest.curriculum.stageCounts.repair ?? 0) > 0;
  return assertMixPolicyWeights(
    {
      stageWeights: manifest.curriculum.stageWeights,
      modeWeights: computeModeWeightsFromManifest(manifest),
      repairSourcesPresent: repairPresent,
    },
    {
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    },
  );
}

/** Example stage weights documented for teacher/doctor when repair is present. */
export function exampleRepairHeavyStageWeights(): MixStageWeights {
  const others = (1 - MIX_REPAIR_TARGET_WEIGHT) / 3;
  return {
    protocol: others,
    tool_use: others,
    domain_depth: others,
    repair: MIX_REPAIR_TARGET_WEIGHT,
  };
}

export type EffectiveMixWeights = {
  modeWeights: MixModeWeights;
  /** Proportional weights from curriculumStage tags on weight-eligible sources. */
  stageWeightsFromTags: MixStageWeights;
  taggedWeightSourceCount: number;
  weightEligibleSourceCount: number;
  retSourceCount: number;
  repairSourcesPresent: boolean;
  laneCodes: string[];
};

/**
 * Compute effective mix weights from manifest lane tags / knowledge modes.
 * RET never receives weight mass (even when listed as retrieve-only sources).
 */
export function computeEffectiveMixWeightsFromManifest(
  manifest: CorpusManifest,
): EffectiveMixWeights {
  const excluded = new Set(manifest.weightTrainingPolicy.excludeKnowledgeModes);
  const stageCounts = emptyStageWeights();
  let taggedWeightSourceCount = 0;
  let weightEligibleSourceCount = 0;
  let retSourceCount = 0;

  for (const src of manifest.sources) {
    if (src.knowledgeMode === "RET") {
      retSourceCount += 1;
      continue;
    }
    if (excluded.has(src.knowledgeMode)) continue;
    weightEligibleSourceCount += 1;
    if (src.curriculumStage !== undefined) {
      stageCounts[src.curriculumStage] += 1;
      taggedWeightSourceCount += 1;
    }
  }

  const stageWeightsFromTags = emptyStageWeights();
  if (taggedWeightSourceCount > 0) {
    for (const stage of CORPUS_CURRICULUM_STAGES) {
      stageWeightsFromTags[stage] =
        stageCounts[stage] / taggedWeightSourceCount;
    }
  }

  return {
    modeWeights: computeModeWeightsFromManifest(manifest),
    stageWeightsFromTags,
    taggedWeightSourceCount,
    weightEligibleSourceCount,
    retSourceCount,
    repairSourcesPresent: stageCounts.repair > 0,
    laneCodes: [...manifest.laneCodes],
  };
}

export type MixPolicyLintOk = {
  ok: true;
  manifestId: string;
  effective: EffectiveMixWeights;
  subjectId: string;
  deviceId: string;
};

export type MixPolicyLintFail = {
  ok: false;
  failureClass: MixPolicyFailureClass;
  detail: string;
  manifestId?: string;
  subjectId: string;
  deviceId: string;
};

/**
 * Lint a corpus manifest against mix policy.
 * Idempotent pure check for a given manifest value.
 */
export function lintCorpusManifestMixPolicy(
  manifest: CorpusManifest,
  options: {
    subjectId?: string;
    deviceId?: string;
    packId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
): MixPolicyLintOk | MixPolicyLintFail {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.lint";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-lint";
  const manifestId = manifest.manifestId;

  const fail = (
    failureClass: MixPolicyFailureClass,
    detail: string,
  ): MixPolicyLintFail => {
    emit(options.onTelemetry, {
      op: "lint",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId,
      ...(options.packId !== undefined ? { packId: options.packId } : {}),
      failureClass,
      detail,
    });
    return {
      ok: false,
      failureClass,
      detail,
      manifestId,
      subjectId,
      deviceId,
    };
  };

  if (!manifest.weightTrainingPolicy.excludeKnowledgeModes.includes("RET")) {
    return fail(
      "ret_in_weights",
      "weightTrainingPolicy.excludeKnowledgeModes must include RET",
    );
  }

  const hasRetSource = manifest.sources.some((s) => s.knowledgeMode === "RET");
  const hasRetFilter = manifest.filters.some(
    (f) => f.kind === "exclude_ret_from_weights",
  );
  if (hasRetSource && !hasRetFilter) {
    return fail(
      "ret_in_weights",
      "RET-tagged sources require filters[].kind=exclude_ret_from_weights",
    );
  }

  const effective = computeEffectiveMixWeightsFromManifest(manifest);
  if (effective.modeWeights.RET !== MIX_RET_WEIGHT) {
    return fail(
      "ret_in_weights",
      `effective RET weight must be ${MIX_RET_WEIGHT} (got ${effective.modeWeights.RET})`,
    );
  }

  if (effective.modeWeights.MEM > MIX_MEM_MAX_WEIGHT) {
    return fail(
      "mem_over_thin",
      `effective MEM weight ${effective.modeWeights.MEM} exceeds thin cap ${MIX_MEM_MAX_WEIGHT}`,
    );
  }

  if (manifest.curriculum !== undefined) {
    const curriculumCheck = assertManifestCurriculumMatchesMixPolicy(manifest, {
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (!curriculumCheck.ok) {
      return fail(curriculumCheck.failureClass, curriculumCheck.detail);
    }
  } else if (effective.repairSourcesPresent) {
    // No curriculum block — enforce repair band from tag-proportional weights.
    const weightCheck = assertMixPolicyWeights(
      {
        stageWeights: effective.stageWeightsFromTags,
        modeWeights: effective.modeWeights,
        repairSourcesPresent: true,
      },
      {
        subjectId,
        deviceId,
        manifestId,
        ...(options.packId !== undefined ? { packId: options.packId } : {}),
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      },
    );
    if (!weightCheck.ok) {
      return fail(weightCheck.failureClass, weightCheck.detail);
    }
  } else {
    const modeOnly = assertMixPolicyWeights(
      { modeWeights: effective.modeWeights },
      {
        subjectId,
        deviceId,
        manifestId,
        ...(options.packId !== undefined ? { packId: options.packId } : {}),
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      },
    );
    if (!modeOnly.ok) {
      return fail(modeOnly.failureClass, modeOnly.detail);
    }
  }

  emit(options.onTelemetry, {
    op: "lint",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId,
    ...(options.packId !== undefined ? { packId: options.packId } : {}),
    detail: `lanes=${effective.laneCodes.length};weightEligible=${effective.weightEligibleSourceCount};retSources=${effective.retSourceCount}`,
  });

  return {
    ok: true,
    manifestId,
    effective,
    subjectId,
    deviceId,
  };
}

/**
 * Load + parse + lint a manifest file (validate-on-read).
 */
export function lintCorpusManifestMixPolicyFile(
  filePath: string,
  options: {
    subjectId?: string;
    deviceId?: string;
    packId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
): MixPolicyLintOk | MixPolicyLintFail {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.lint";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-lint";
  const loaded = loadCorpusManifestFile(filePath, {
    subjectId,
    deviceId,
  });
  if (!loaded.ok) {
    emit(options.onTelemetry, {
      op: "lint",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: loaded.message,
    });
    return {
      ok: false,
      failureClass: "config",
      detail: loaded.message,
      subjectId,
      deviceId,
    };
  }
  return lintCorpusManifestMixPolicy(loaded.value, options);
}

export type MixPolicyIdentity = {
  schemaVersion: typeof MIX_POLICY_SCHEMA_VERSION;
  repairTargetWeight: number;
  repairTolerance: number;
  memMaxWeight: number;
  retWeight: number;
  curriculumStageOrder: CorpusCurriculumStage[];
  docRelpath: typeof MIX_POLICY_DOC_RELPATH;
  docSha256: string;
};

export type MixPolicyStakeholder = {
  role: string;
  attestorId: string;
  signedAt: string;
};

export type MixPolicyChangelogEntry = {
  mixPolicyVersion: string;
  date: string;
  summary: string;
};

export type MixPolicySignoff = {
  schemaVersion: typeof MIX_POLICY_SIGNOFF_SCHEMA_VERSION;
  status: "ratified";
  mixPolicyVersion: string;
  stakeholders: MixPolicyStakeholder[];
  changelog: MixPolicyChangelogEntry[];
};

function isSha256Version(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

/**
 * Compute the content-addressed mix policy version from doc + numeric law.
 * Idempotent for a given document byte content.
 */
export function computeMixPolicyVersion(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | {
      ok: true;
      mixPolicyVersion: string;
      docSha256: string;
      identity: MixPolicyIdentity;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.version";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-version";
  const absPath = resolveMixPolicyDocumentPath(options.packageRoot);

  if (!existsSync(absPath)) {
    emit(options.onTelemetry, {
      op: "compute_version",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "doc_missing",
      detail: `missing ${MIX_POLICY_DOC_RELPATH}`,
    });
    return {
      ok: false,
      failureClass: "doc_missing",
      detail: `mix policy document missing: ${MIX_POLICY_DOC_RELPATH}`,
      subjectId,
      deviceId,
    };
  }

  const docText = readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
  const docSha256 = createHash("sha256").update(docText, "utf8").digest("hex");
  const identity: MixPolicyIdentity = {
    schemaVersion: MIX_POLICY_SCHEMA_VERSION,
    repairTargetWeight: MIX_REPAIR_TARGET_WEIGHT,
    repairTolerance: MIX_REPAIR_TOLERANCE,
    memMaxWeight: MIX_MEM_MAX_WEIGHT,
    retWeight: MIX_RET_WEIGHT,
    curriculumStageOrder: [...MIX_CURRICULUM_STAGE_ORDER],
    docRelpath: MIX_POLICY_DOC_RELPATH,
    docSha256,
  };
  const canonical = `${JSON.stringify(identity)}\n`;
  const mixPolicyVersion = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;

  emit(options.onTelemetry, {
    op: "compute_version",
    outcome: "ok",
    subjectId,
    deviceId,
    mixPolicyVersion,
    detail: `docSha256=${docSha256}`,
  });

  return {
    ok: true,
    mixPolicyVersion,
    docSha256,
    identity,
    subjectId,
    deviceId,
  };
}

/**
 * Load + validate the stakeholder sign-off artifact (boundary validate-on-read).
 */
export function loadMixPolicySignoff(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | {
      ok: true;
      signoff: MixPolicySignoff;
      absPath: string;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.signoff";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-signoff";
  const absPath = resolveMixPolicySignoffPath(options.packageRoot);

  if (!existsSync(absPath)) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_missing",
      detail: `missing ${MIX_POLICY_SIGNOFF_RELPATH}`,
    });
    return {
      ok: false,
      failureClass: "signoff_missing",
      detail: `mix policy sign-off missing: ${MIX_POLICY_SIGNOFF_RELPATH}`,
      subjectId,
      deviceId,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    const detail = `sign-off JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail,
    });
    return { ok: false, failureClass: "config", detail, subjectId, deviceId };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: "sign-off must be a JSON object",
      subjectId,
      deviceId,
    };
  }

  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== MIX_POLICY_SIGNOFF_SCHEMA_VERSION) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: "sign-off schemaVersion mismatch",
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: `sign-off schemaVersion must be ${MIX_POLICY_SIGNOFF_SCHEMA_VERSION}`,
      subjectId,
      deviceId,
    };
  }
  if (obj.status !== "ratified") {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: "sign-off status must be ratified",
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: "sign-off status must be ratified",
      subjectId,
      deviceId,
    };
  }
  if (
    typeof obj.mixPolicyVersion !== "string" ||
    !isSha256Version(obj.mixPolicyVersion)
  ) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: "sign-off mixPolicyVersion must be sha256:<64 hex>",
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: "sign-off mixPolicyVersion must be sha256:<64 hex>",
      subjectId,
      deviceId,
    };
  }
  if (!Array.isArray(obj.stakeholders) || obj.stakeholders.length < MIX_POLICY_MIN_STAKEHOLDERS) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: `sign-off requires ≥ ${MIX_POLICY_MIN_STAKEHOLDERS} stakeholders`,
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: `sign-off requires ≥ ${MIX_POLICY_MIN_STAKEHOLDERS} stakeholders`,
      subjectId,
      deviceId,
    };
  }
  if (!Array.isArray(obj.changelog) || obj.changelog.length < 1) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: "sign-off changelog must include ≥ 1 entry",
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: "sign-off changelog must include ≥ 1 entry",
      subjectId,
      deviceId,
    };
  }

  const stakeholders: MixPolicyStakeholder[] = [];
  for (const row of obj.stakeholders) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return {
        ok: false,
        failureClass: "signoff_incomplete",
        detail: "stakeholder row must be an object",
        subjectId,
        deviceId,
      };
    }
    const s = row as Record<string, unknown>;
    if (
      typeof s.role !== "string" ||
      typeof s.attestorId !== "string" ||
      typeof s.signedAt !== "string" ||
      !s.role.trim() ||
      !s.attestorId.trim() ||
      !s.signedAt.trim()
    ) {
      return {
        ok: false,
        failureClass: "signoff_incomplete",
        detail: "stakeholder requires role, attestorId, signedAt",
        subjectId,
        deviceId,
      };
    }
    stakeholders.push({
      role: s.role.trim(),
      attestorId: s.attestorId.trim(),
      signedAt: s.signedAt.trim(),
    });
  }

  const roles = new Set(stakeholders.map((s) => s.role));
  for (const required of MIX_POLICY_REQUIRED_STAKEHOLDER_ROLES) {
    if (!roles.has(required)) {
      emit(options.onTelemetry, {
        op: "signoff",
        outcome: "error",
        subjectId,
        deviceId,
        failureClass: "signoff_incomplete",
        detail: `missing required stakeholder role: ${required}`,
      });
      return {
        ok: false,
        failureClass: "signoff_incomplete",
        detail: `missing required stakeholder role: ${required}`,
        subjectId,
        deviceId,
      };
    }
  }

  const changelog: MixPolicyChangelogEntry[] = [];
  for (const row of obj.changelog) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return {
        ok: false,
        failureClass: "signoff_incomplete",
        detail: "changelog row must be an object",
        subjectId,
        deviceId,
      };
    }
    const c = row as Record<string, unknown>;
    if (
      typeof c.mixPolicyVersion !== "string" ||
      typeof c.date !== "string" ||
      typeof c.summary !== "string" ||
      !c.summary.trim()
    ) {
      return {
        ok: false,
        failureClass: "signoff_incomplete",
        detail: "changelog entry requires mixPolicyVersion, date, summary",
        subjectId,
        deviceId,
      };
    }
    changelog.push({
      mixPolicyVersion: c.mixPolicyVersion,
      date: c.date,
      summary: c.summary.trim(),
    });
  }

  const signoff: MixPolicySignoff = {
    schemaVersion: MIX_POLICY_SIGNOFF_SCHEMA_VERSION,
    status: "ratified",
    mixPolicyVersion: obj.mixPolicyVersion,
    stakeholders,
    changelog,
  };

  emit(options.onTelemetry, {
    op: "signoff",
    outcome: "ok",
    subjectId,
    deviceId,
    mixPolicyVersion: signoff.mixPolicyVersion,
    detail: `stakeholders=${stakeholders.length};changelog=${changelog.length}`,
  });

  return { ok: true, signoff, absPath, subjectId, deviceId };
}

/**
 * Assert sign-off is ratified and matches the live policy version hash.
 */
export function assertMixPolicySignoff(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | {
      ok: true;
      mixPolicyVersion: string;
      signoff: MixPolicySignoff;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.signoff";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-signoff";
  const versioned = computeMixPolicyVersion({
    ...(options.packageRoot !== undefined
      ? { packageRoot: options.packageRoot }
      : {}),
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!versioned.ok) {
    return versioned;
  }

  const loaded = loadMixPolicySignoff({
    ...(options.packageRoot !== undefined
      ? { packageRoot: options.packageRoot }
      : {}),
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!loaded.ok) {
    return loaded;
  }

  if (loaded.signoff.mixPolicyVersion !== versioned.mixPolicyVersion) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      mixPolicyVersion: versioned.mixPolicyVersion,
      failureClass: "version_mismatch",
      detail: "sign-off mixPolicyVersion does not match live policy hash",
    });
    return {
      ok: false,
      failureClass: "version_mismatch",
      detail: `sign-off version ${loaded.signoff.mixPolicyVersion} ≠ live ${versioned.mixPolicyVersion}`,
      subjectId,
      deviceId,
    };
  }

  const head = loaded.signoff.changelog[0];
  if (head === undefined || head.mixPolicyVersion !== versioned.mixPolicyVersion) {
    emit(options.onTelemetry, {
      op: "signoff",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "signoff_incomplete",
      detail: "changelog head must record current mixPolicyVersion",
    });
    return {
      ok: false,
      failureClass: "signoff_incomplete",
      detail: "changelog head must record current mixPolicyVersion",
      subjectId,
      deviceId,
    };
  }

  return {
    ok: true,
    mixPolicyVersion: versioned.mixPolicyVersion,
    signoff: loaded.signoff,
    subjectId,
    deviceId,
  };
}

/**
 * Promotion gate: lint green + ratified sign-off + manifest.mixPolicyVersion match.
 */
export function assertMixPolicyPromotion(
  manifest: CorpusManifest,
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    packId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | {
      ok: true;
      mixPolicyVersion: string;
      manifestId: string;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
      manifestId?: string;
    } {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.promote";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-promote";
  const manifestId = manifest.manifestId;

  const fail = (
    failureClass: MixPolicyFailureClass,
    detail: string,
  ): {
    ok: false;
    failureClass: MixPolicyFailureClass;
    detail: string;
    subjectId: string;
    deviceId: string;
    manifestId: string;
  } => {
    emit(options.onTelemetry, {
      op: "promote",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId,
      ...(options.packId !== undefined ? { packId: options.packId } : {}),
      failureClass,
      detail,
    });
    return { ok: false, failureClass, detail, subjectId, deviceId, manifestId };
  };

  const linted = lintCorpusManifestMixPolicy(manifest, {
    subjectId,
    deviceId,
    ...(options.packId !== undefined ? { packId: options.packId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!linted.ok) {
    return fail(
      linted.failureClass === "ret_in_weights" ||
        linted.failureClass === "repair_out_of_band" ||
        linted.failureClass === "mem_over_thin" ||
        linted.failureClass === "curriculum_mismatch"
        ? linted.failureClass
        : "promotion_blocked",
      `promotion blocked by mix lint: ${linted.detail}`,
    );
  }

  const recorded = manifest.mixPolicyVersion;
  if (recorded === undefined || recorded.trim() === "") {
    return fail(
      "promotion_blocked",
      "manifest.mixPolicyVersion required for promotion",
    );
  }
  if (recorded === "latest" || !isSha256Version(recorded)) {
    return fail(
      "version_mismatch",
      "manifest.mixPolicyVersion must be sha256:<64 hex> (not floating)",
    );
  }

  const signed = assertMixPolicySignoff({
    ...(options.packageRoot !== undefined
      ? { packageRoot: options.packageRoot }
      : {}),
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!signed.ok) {
    return fail(
      signed.failureClass === "version_mismatch" ||
        signed.failureClass === "signoff_missing" ||
        signed.failureClass === "signoff_incomplete" ||
        signed.failureClass === "doc_missing"
        ? signed.failureClass
        : "promotion_blocked",
      signed.detail,
    );
  }

  if (recorded !== signed.mixPolicyVersion) {
    return fail(
      "version_mismatch",
      `manifest.mixPolicyVersion ${recorded} ≠ ratified ${signed.mixPolicyVersion}`,
    );
  }

  emit(options.onTelemetry, {
    op: "promote",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId,
    mixPolicyVersion: signed.mixPolicyVersion,
    ...(options.packId !== undefined ? { packId: options.packId } : {}),
    detail: "lint+signoff+version match",
  });

  return {
    ok: true,
    mixPolicyVersion: signed.mixPolicyVersion,
    manifestId,
    subjectId,
    deviceId,
  };
}

export function assertMixPolicyPromotionFile(
  filePath: string,
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    packId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
): ReturnType<typeof assertMixPolicyPromotion> {
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.promote";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-promote";
  const loaded = loadCorpusManifestFile(filePath, { subjectId, deviceId });
  if (!loaded.ok) {
    emit(options.onTelemetry, {
      op: "promote",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "config",
      detail: loaded.message,
    });
    return {
      ok: false,
      failureClass: "config",
      detail: loaded.message,
      subjectId,
      deviceId,
    };
  }
  return assertMixPolicyPromotion(loaded.value, options);
}

/**
 * CI prove: sign-off ratified, version matches live hash, promotion green + red.
 */
export function proveMixPolicyRatification(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
):
  | {
      ok: true;
      mixPolicyVersion: string;
      subjectId: string;
      deviceId: string;
    }
  | {
      ok: false;
      failureClass: MixPolicyFailureClass | "prove";
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const packageRoot = options.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.ratify";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-ratify";

  const fail = (
    failureClass: MixPolicyFailureClass | "prove",
    detail: string,
  ) => {
    emit(options.onTelemetry, {
      op: "prove_ratify",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: failureClass === "prove" ? "config" : failureClass,
      detail,
    });
    return { ok: false as const, failureClass, detail, subjectId, deviceId };
  };

  const first = assertMixPolicySignoff({
    packageRoot,
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  const second = assertMixPolicySignoff({ packageRoot, subjectId, deviceId });
  if (!first.ok) {
    return fail(first.failureClass, first.detail);
  }
  if (!second.ok || first.mixPolicyVersion !== second.mixPolicyVersion) {
    return fail("prove", "sign-off assert not idempotent");
  }

  const greenPath = path.join(
    packageRoot,
    MIX_POLICY_LINT_FIXTURE_DIR,
    MIX_POLICY_LINT_OK_REPAIR,
  );
  if (!existsSync(greenPath)) {
    return fail("config", `promotion green fixture missing: ${greenPath}`);
  }
  const promoted = assertMixPolicyPromotionFile(greenPath, {
    packageRoot,
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!promoted.ok) {
    return fail(promoted.failureClass, promoted.detail);
  }

  const redPath = path.join(
    packageRoot,
    MIX_POLICY_LINT_FIXTURE_DIR,
    MIX_POLICY_LINT_VIOLATION_VERSION,
  );
  if (!existsSync(redPath)) {
    return fail("config", `version mismatch fixture missing: ${redPath}`);
  }
  const blocked = assertMixPolicyPromotionFile(redPath, {
    packageRoot,
    subjectId,
    deviceId,
  });
  if (blocked.ok || blocked.failureClass !== "version_mismatch") {
    return fail(
      "prove",
      `expected version_mismatch on ${MIX_POLICY_LINT_VIOLATION_VERSION}, got ${blocked.ok ? "ok" : blocked.failureClass}`,
    );
  }

  emit(options.onTelemetry, {
    op: "prove_ratify",
    outcome: "ok",
    subjectId,
    deviceId,
    mixPolicyVersion: first.mixPolicyVersion,
    detail: "signoff+promote green/red",
  });

  return {
    ok: true,
    mixPolicyVersion: first.mixPolicyVersion,
    subjectId,
    deviceId,
  };
}

export type MixPolicyProveOk = {
  ok: true;
  greenCount: number;
  redCount: number;
  mixPolicyVersion?: string;
  subjectId: string;
  deviceId: string;
};

export type MixPolicyProveFail = {
  ok: false;
  failureClass: MixPolicyFailureClass | "prove";
  detail: string;
  subjectId: string;
  deviceId: string;
};

/**
 * CI prove: governance doc present; golden manifests lint green; seeded
 * violations fail with the expected failure class. Re-entrant / idempotent.
 */
export function proveMixPolicyLint(
  options: {
    packageRoot?: string;
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: MixPolicyTelemetry) => void;
  } = {},
): MixPolicyProveOk | MixPolicyProveFail {
  const packageRoot = options.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const subjectId = options.subjectId?.trim() || "subj.mix-policy.prove";
  const deviceId = options.deviceId?.trim() || "dev-mix-policy-prove";

  const fail = (
    failureClass: MixPolicyFailureClass | "prove",
    detail: string,
  ): MixPolicyProveFail => {
    emit(options.onTelemetry, {
      op: "prove_lint",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: failureClass === "prove" ? "config" : failureClass,
      detail,
    });
    return { ok: false, failureClass, detail, subjectId, deviceId };
  };

  const doc = proveMixPolicyDocumentPresent({
    packageRoot,
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!doc.ok) {
    return fail(doc.failureClass, doc.detail);
  }

  const greenPaths = [
    path.join(packageRoot, "fixtures", "valid", "minimal.json"),
    path.join(
      packageRoot,
      MIX_POLICY_LINT_FIXTURE_DIR,
      MIX_POLICY_LINT_OK_REPAIR,
    ),
  ];

  for (const greenPath of greenPaths) {
    if (!existsSync(greenPath)) {
      return fail("config", `green fixture missing: ${greenPath}`);
    }
    const first = lintCorpusManifestMixPolicyFile(greenPath, {
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    const second = lintCorpusManifestMixPolicyFile(greenPath, {
      subjectId,
      deviceId,
    });
    if (!first.ok) {
      return fail(
        first.failureClass,
        `green lint failed ${path.basename(greenPath)}: ${first.detail}`,
      );
    }
    if (!second.ok || first.manifestId !== second.manifestId) {
      return fail("prove", `green lint not idempotent: ${path.basename(greenPath)}`);
    }
  }

  const redCases: {
    file: string;
    expected: MixPolicyFailureClass;
  }[] = [
    {
      file: path.join(
        packageRoot,
        MIX_POLICY_LINT_FIXTURE_DIR,
        MIX_POLICY_LINT_VIOLATION_RET,
      ),
      expected: "ret_in_weights",
    },
    {
      file: path.join(
        packageRoot,
        MIX_POLICY_LINT_FIXTURE_DIR,
        MIX_POLICY_LINT_VIOLATION_REPAIR,
      ),
      expected: "repair_out_of_band",
    },
  ];

  for (const red of redCases) {
    if (!existsSync(red.file)) {
      return fail("config", `red fixture missing: ${red.file}`);
    }
    // Violations may fail corpus schema parse OR mix lint — load raw JSON and
    // parse with schema, then lint; RET exclusion failure is schema-level too.
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(red.file, "utf8"));
    } catch (err) {
      return fail(
        "config",
        `red fixture JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseCorpusManifest(raw, { subjectId, deviceId });
    if (!parsed.ok) {
      // Schema-level RET policy rejection counts as ret_in_weights for this prove.
      if (
        red.expected === "ret_in_weights" &&
        (parsed.failureClass === "ret_policy" ||
          parsed.message.toLowerCase().includes("ret"))
      ) {
        continue;
      }
      return fail(
        "prove",
        `red fixture ${path.basename(red.file)} failed schema before lint: ${parsed.message}`,
      );
    }

    const linted = lintCorpusManifestMixPolicy(parsed.value, {
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (linted.ok) {
      return fail(
        "prove",
        `red fixture ${path.basename(red.file)} unexpectedly passed lint`,
      );
    }
    if (linted.failureClass !== red.expected) {
      return fail(
        "prove",
        `red fixture ${path.basename(red.file)} expected ${red.expected}, got ${linted.failureClass}`,
      );
    }
  }

  emit(options.onTelemetry, {
    op: "prove_lint",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: `green=${greenPaths.length};red=${redCases.length}`,
  });

  const ratified = proveMixPolicyRatification({
    packageRoot,
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!ratified.ok) {
    return fail(ratified.failureClass, ratified.detail);
  }

  return {
    ok: true,
    greenCount: greenPaths.length,
    redCount: redCases.length,
    mixPolicyVersion: ratified.mixPolicyVersion,
    subjectId,
    deviceId,
  };
}

export function runProveMixPolicyLintCli(
  argv: string[],
  io: {
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  },
): number {
  void argv;
  const subjectId = "subj.mix-policy.prove.cli";
  const deviceId = "dev-mix-policy-prove-cli";
  const result = proveMixPolicyLint({
    packageRoot: CORPUS_PACKAGE_ROOT,
    subjectId,
    deviceId,
  });
  if (!result.ok) {
    io.stderr.write(
      `${JSON.stringify({
        outcome: "error",
        failureClass: result.failureClass,
        detail: result.detail,
        subjectId,
        deviceId,
      })}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `${JSON.stringify({
      outcome: "ok",
      greenCount: result.greenCount,
      redCount: result.redCount,
      mixPolicyVersion: result.mixPolicyVersion,
      subjectId,
      deviceId,
    })}\n`,
  );
  return 0;
}
