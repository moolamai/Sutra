/**
 * Learning constitution — machine mirror of docs/learning/CONSTITUTION.md.
 *
 * Encodes surgery classes, knowledge modes, promote comparator (ties reject),
 * and the one-surgery-per-stage promotion-candidate linter (L1).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Repo-relative constitution path. */
export const LEARNING_CONSTITUTION_RELPATH =
  "docs/learning/CONSTITUTION.md" as const;

/** Soft caps (NFR — bounded scans of laws / examples). */
export const CONSTITUTION_LAW_LIMIT = 32;
export const CONSTITUTION_EXAMPLE_LIMIT = 32;

/** Promotion-candidate manifest schema + fixture tree (one-surgery CI). */
export const PROMOTION_CANDIDATE_SCHEMA_VERSION =
  "promotion-candidate.v1" as const;
export const PROMOTION_CANDIDATE_FIXTURES_RELPATH =
  "training/eval/fixtures/promotion-candidates" as const;
export const PROMOTION_CANDIDATE_STAGE_ID_LIMIT = 128;
export const PROMOTION_CANDIDATE_DIGEST_LIMIT = 16;
export const PROMOTION_CANDIDATE_MANIFEST_BYTES_LIMIT = 32_768;

/** Committed CI fixtures — green must pass; red must fail attribution_void. */
export const PROMOTION_CANDIDATE_OK_FIXTURE = "ok-adapter-only.json" as const;
export const PROMOTION_CANDIDATE_VIOLATION_FIXTURE =
  "violation-multi-surgery.json" as const;

/** Kill-switch operator runbook (constitution L4). */
export const KILL_SWITCH_RUNBOOK_RELPATH =
  "docs/learning/KILL_SWITCH_RUNBOOK.md" as const;

/** Normative learned feature flags that must all be off after kill-switch. */
export const KILL_SWITCH_LEARNED_FLAGS = Object.freeze([
  "learned_adapter",
  "learned_critic",
  "learned_mix_policy",
  "learned_routing",
  "learned_compaction",
  "learned_healing",
] as const);

export type KillSwitchLearnedFlag = (typeof KILL_SWITCH_LEARNED_FLAGS)[number];

/** Monthly drill cadence (days) until C7 owns continuous schedule. */
export const KILL_SWITCH_DRILL_INTERVAL_DAYS = 30;

/** Soft cap on components touched in one kill-switch apply. */
export const KILL_SWITCH_COMPONENT_LIMIT = 16;

/** Canonical surgery component classes — one per stage (L1). */
export const SURGERY_COMPONENT_CLASSES = Object.freeze([
  "adapter",
  "critic",
  "mix",
  "policy",
] as const);

export type SurgeryComponentClass = (typeof SURGERY_COMPONENT_CLASSES)[number];

/** Knowledge modes — RET never enters weights (L6). */
export const KNOWLEDGE_MODES = Object.freeze(["MEM", "UND", "RET"] as const);

export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

/** Modes that may enter weights under consent + decontam. */
export const WEIGHT_ELIGIBLE_KNOWLEDGE_MODES = Object.freeze([
  "MEM",
  "UND",
] as const);

export type ConstitutionLawId =
  | "L1_one_surgery"
  | "L2_baseline_permanence"
  | "L3_full_gate_promotion"
  | "L4_kill_switch"
  | "L5_cross_subject"
  | "L6_ret_not_weights";

export type ConstitutionLaw = {
  id: ConstitutionLawId;
  /** Phrase that must appear in CONSTITUTION.md (case-sensitive substring). */
  requiredPhrase: string;
};

export const CONSTITUTION_LAWS = Object.freeze([
  {
    id: "L1_one_surgery",
    requiredPhrase: "One surgery per stage",
  },
  {
    id: "L2_baseline_permanence",
    requiredPhrase: "Baseline permanence",
  },
  {
    id: "L3_full_gate_promotion",
    requiredPhrase: "Ties do not promote",
  },
  {
    id: "L4_kill_switch",
    requiredPhrase: "Kill-switch law",
  },
  {
    id: "L5_cross_subject",
    requiredPhrase: "Cross-subject default-deny",
  },
  {
    id: "L6_ret_not_weights",
    requiredPhrase: "Retrieval is not weights",
  },
] as const satisfies readonly ConstitutionLaw[]);

export type ConstitutionWorkedExampleId =
  | "surgery_violation"
  | "promotion_tie_reject"
  | "promotion_strict_beat"
  | "kill_switch_drill"
  | "cross_subject_reject";

export type ConstitutionWorkedExample = {
  id: ConstitutionWorkedExampleId;
  /** Must appear in the markdown so examples stay real, not aspirational. */
  requiredPhrase: string;
  surgeryClasses: readonly SurgeryComponentClass[];
  /** Expected constitutional verdict for this scenario. */
  expectedVerdict: "promote" | "reject";
  failureClass?: ConstitutionFailureClass;
};

export type ConstitutionFailureClass =
  | "missing_constitution"
  | "schema_violation"
  | "law_gap"
  | "example_gap"
  | "attribution_void"
  | "tie_reject"
  | "slice_regression"
  | "cross_subject"
  | "ret_in_weights"
  | "kill_switch_partial"
  | "section_limit"
  | "missing_subject"
  | "missing_fixture"
  | "ci_prove_mismatch";

export const promotionCandidateManifestSchema = z.object({
  schemaVersion: z.literal(PROMOTION_CANDIDATE_SCHEMA_VERSION),
  stageId: z.string().min(1).max(PROMOTION_CANDIDATE_STAGE_ID_LIMIT),
  surgeryClasses: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(SURGERY_COMPONENT_CLASSES.length + 2),
  /** Fleet-scoped ops use null; subject-bound stages require a real id. */
  subjectId: z.union([z.string().min(1).max(128), z.null()]),
  locality: z.enum(["on-device", "self-hosted"]),
  deviceId: z.string().min(1).max(128).optional(),
  /**
   * Optional digests keyed by surgery class. Keys that are not in
   * surgeryClasses (or extra classes) void the candidate.
   */
  componentDigests: z
    .record(z.string(), z.string().min(1).max(256))
    .optional(),
});

export type PromotionCandidateManifest = z.infer<
  typeof promotionCandidateManifestSchema
>;

/**
 * Frozen worked examples — numbers / outcomes mirrored in CONSTITUTION.md §4–§6.
 */
export const CONSTITUTION_WORKED_EXAMPLES = Object.freeze([
  {
    id: "surgery_violation",
    requiredPhrase: "surgery violation",
    surgeryClasses: ["adapter", "critic"],
    expectedVerdict: "reject",
    failureClass: "attribution_void",
  },
  {
    id: "promotion_tie_reject",
    requiredPhrase: "tie → reject",
    surgeryClasses: ["adapter"],
    expectedVerdict: "reject",
    failureClass: "tie_reject",
  },
  {
    id: "promotion_strict_beat",
    requiredPhrase: "Happy promote",
    surgeryClasses: ["adapter"],
    expectedVerdict: "promote",
  },
  {
    id: "kill_switch_drill",
    requiredPhrase: "kill-switch drill",
    surgeryClasses: ["policy"],
    expectedVerdict: "reject",
    failureClass: "kill_switch_partial",
  },
  {
    id: "cross_subject_reject",
    requiredPhrase: "cross-subject reject",
    surgeryClasses: ["adapter"],
    expectedVerdict: "reject",
    failureClass: "cross_subject",
  },
] as const satisfies readonly ConstitutionWorkedExample[]);

export type ConstitutionTelemetryEvent = {
  event: "learning.governance";
  outcome: "ok" | "rejected" | "start";
  subjectId: string | null;
  deviceId?: string;
  action?:
    | "load_constitution"
    | "assert_coherent"
    | "one_surgery"
    | "promote_compare"
    | "knowledge_mode"
    | "lint_candidate"
    | "ci_prove"
    | "kill_switch"
    | "assert_kill_switch_runbook";
  failureClass?: ConstitutionFailureClass;
  lawId?: ConstitutionLawId;
  exampleId?: ConstitutionWorkedExampleId;
  stageId?: string;
  fixture?: string;
  componentsReverted?: readonly string[];
  remainingOn?: readonly string[];
};

function emit(
  onTelemetry: ((e: ConstitutionTelemetryEvent) => void) | undefined,
  event: ConstitutionTelemetryEvent,
): void {
  onTelemetry?.(event);
}

/**
 * Strict promote comparator (L3): challenger must beat champion; ties reject.
 */
export function challengerStrictlyBeatsChampion(
  challenger: number,
  champion: number,
): boolean {
  return (
    Number.isFinite(challenger) &&
    Number.isFinite(champion) &&
    challenger > champion
  );
}

/**
 * L1 helper: count distinct surgery classes (more than one → attribution void).
 */
export function countDistinctSurgeryClasses(
  classes: readonly string[] | undefined,
): number {
  if (!classes || classes.length === 0) return 0;
  return new Set(classes.map((c) => c.trim()).filter(Boolean)).size;
}

/**
 * Assert one surgery type per stage (constitution L1 — shared with promote lint).
 */
export function assertOneSurgeryPerStage(
  surgeryClasses: readonly string[] | undefined,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "attribution_void" | "schema_violation";
      detail: string;
    } {
  const subjectId = opts.subjectId ?? null;
  if (surgeryClasses === undefined || surgeryClasses.length === 0) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "one_surgery",
      failureClass: "schema_violation",
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "surgeryClasses required (exactly one component class)",
    };
  }
  const trimmed = surgeryClasses.map((c) => c.trim()).filter(Boolean);
  const distinct = countDistinctSurgeryClasses(trimmed);
  if (distinct !== 1) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "one_surgery",
      failureClass: "attribution_void",
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "attribution_void",
      detail:
        "one surgery type per stage — candidate touches multiple component classes",
    };
  }
  for (const cls of trimmed) {
    if (!(SURGERY_COMPONENT_CLASSES as readonly string[]).includes(cls)) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "one_surgery",
        failureClass: "schema_violation",
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `unknown surgery class: ${cls} (expected adapter|critic|mix|policy)`,
      };
    }
  }
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "one_surgery",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Lint one promotion-candidate manifest (constitution L1).
 * Rejects multi-class stages with attribution_void.
 */
export function lintPromotionCandidateManifest(
  raw: unknown,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    /** When set, manifest.subjectId must match (subject isolation). */
    expectedSubjectId?: string | null;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true; manifest: PromotionCandidateManifest }
  | {
      ok: false;
      failureClass: ConstitutionFailureClass;
      detail: string;
      stageId?: string;
      subjectId: string | null;
    } {
  const deviceId = opts.deviceId;
  const callerSubject =
    opts.subjectId !== undefined ? opts.subjectId : undefined;

  const parsed = promotionCandidateManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const subjectId = callerSubject ?? null;
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "lint_candidate",
      failureClass: "schema_violation",
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: parsed.error.issues[0]?.message ?? "invalid candidate manifest",
      subjectId,
    };
  }

  const manifest = parsed.data;
  const subjectId = manifest.subjectId;

  if (
    opts.expectedSubjectId !== undefined &&
    opts.expectedSubjectId !== manifest.subjectId
  ) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId: opts.expectedSubjectId,
      action: "lint_candidate",
      failureClass: "cross_subject",
      stageId: manifest.stageId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "cross_subject",
      detail: "candidate subjectId does not match caller scope",
      stageId: manifest.stageId,
      subjectId: opts.expectedSubjectId,
    };
  }

  // L1 cardinality / catalog first — primary one-surgery signal.
  const surgery = assertOneSurgeryPerStage(manifest.surgeryClasses, {
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (!surgery.ok) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "lint_candidate",
      failureClass: surgery.failureClass,
      stageId: manifest.stageId,
      ...(deviceId !== undefined ? { deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: surgery.failureClass,
      detail: surgery.detail,
      stageId: manifest.stageId,
      subjectId,
    };
  }

  if (
    manifest.componentDigests !== undefined &&
    Object.keys(manifest.componentDigests).length > PROMOTION_CANDIDATE_DIGEST_LIMIT
  ) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `componentDigests exceed ${PROMOTION_CANDIDATE_DIGEST_LIMIT}`,
      stageId: manifest.stageId,
      subjectId,
    };
  }

  if (manifest.componentDigests) {
    const digestClasses = Object.keys(manifest.componentDigests);
    const surgerySet = new Set(manifest.surgeryClasses);
    for (const key of digestClasses) {
      if (!surgerySet.has(key)) {
        emit(opts.onTelemetry, {
          event: "learning.governance",
          outcome: "rejected",
          subjectId,
          action: "lint_candidate",
          failureClass: "attribution_void",
          stageId: manifest.stageId,
          ...(deviceId !== undefined ? { deviceId } : {}),
        });
        return {
          ok: false,
          failureClass: "attribution_void",
          detail: `componentDigests key ${key} is not in surgeryClasses — multi-surgery / attribution void`,
          stageId: manifest.stageId,
          subjectId,
        };
      }
    }
    if (digestClasses.length > 1) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "lint_candidate",
        failureClass: "attribution_void",
        stageId: manifest.stageId,
        ...(deviceId !== undefined ? { deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "attribution_void",
        detail: "componentDigests touch more than one surgery class",
        stageId: manifest.stageId,
        subjectId,
      };
    }
  }

  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "lint_candidate",
    stageId: manifest.stageId,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
  return { ok: true, manifest };
}

/**
 * Load + lint a committed fixture under training/eval/fixtures/promotion-candidates/.
 */
export async function lintPromotionCandidateFixture(opts: {
  repoRoot: string;
  fixtureFile: string;
  deviceId?: string;
  expectedSubjectId?: string | null;
  onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
}): Promise<
  | { ok: true; manifest: PromotionCandidateManifest; fixtureFile: string }
  | {
      ok: false;
      failureClass: ConstitutionFailureClass;
      detail: string;
      stageId?: string;
      subjectId: string | null;
      fixtureFile: string;
    }
> {
  if (
    opts.fixtureFile.includes("..") ||
    opts.fixtureFile.includes("/") ||
    opts.fixtureFile.includes("\\") ||
    !opts.fixtureFile.endsWith(".json")
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "fixtureFile must be a bare *.json name",
      subjectId: null,
      fixtureFile: opts.fixtureFile,
    };
  }

  const abs = path.join(
    opts.repoRoot,
    PROMOTION_CANDIDATE_FIXTURES_RELPATH,
    opts.fixtureFile,
  );
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId: null,
      action: "lint_candidate",
      failureClass: "missing_fixture",
      fixture: opts.fixtureFile,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "missing_fixture",
      detail: `missing candidate fixture: ${opts.fixtureFile}`,
      subjectId: null,
      fixtureFile: opts.fixtureFile,
    };
  }

  if (text.length > PROMOTION_CANDIDATE_MANIFEST_BYTES_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `fixture exceeds ${PROMOTION_CANDIDATE_MANIFEST_BYTES_LIMIT} bytes`,
      subjectId: null,
      fixtureFile: opts.fixtureFile,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `fixture is not valid JSON: ${opts.fixtureFile}`,
      subjectId: null,
      fixtureFile: opts.fixtureFile,
    };
  }

  const linted = lintPromotionCandidateManifest(raw, {
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(opts.expectedSubjectId !== undefined
      ? { expectedSubjectId: opts.expectedSubjectId }
      : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (!linted.ok) {
    return { ...linted, fixtureFile: opts.fixtureFile };
  }
  return {
    ok: true,
    manifest: linted.manifest,
    fixtureFile: opts.fixtureFile,
  };
}

/**
 * CI prove: green fixture passes; seeded multi-surgery violation fails
 * with attribution_void. Idempotent (read-only).
 */
export async function proveOneSurgeryPromotionLint(opts: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
}): Promise<
  | { ok: true; greenStageId: string; redStageId: string }
  | {
      ok: false;
      failureClass: ConstitutionFailureClass;
      detail: string;
    }
> {
  const deviceId = opts.deviceId ?? "ci-one-surgery-prove";
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "start",
    subjectId: null,
    action: "ci_prove",
    deviceId,
  });

  const green = await lintPromotionCandidateFixture({
    repoRoot: opts.repoRoot,
    fixtureFile: PROMOTION_CANDIDATE_OK_FIXTURE,
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (!green.ok) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId: null,
      action: "ci_prove",
      failureClass: "ci_prove_mismatch",
      fixture: PROMOTION_CANDIDATE_OK_FIXTURE,
      deviceId,
    });
    return {
      ok: false,
      failureClass: "ci_prove_mismatch",
      detail: `green fixture unexpectedly failed: ${green.failureClass} — ${green.detail}`,
    };
  }

  const red = await lintPromotionCandidateFixture({
    repoRoot: opts.repoRoot,
    fixtureFile: PROMOTION_CANDIDATE_VIOLATION_FIXTURE,
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (red.ok) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId: null,
      action: "ci_prove",
      failureClass: "ci_prove_mismatch",
      fixture: PROMOTION_CANDIDATE_VIOLATION_FIXTURE,
      deviceId,
    });
    return {
      ok: false,
      failureClass: "ci_prove_mismatch",
      detail:
        "violation fixture unexpectedly passed — multi-surgery must fail CI",
    };
  }
  if (red.failureClass !== "attribution_void") {
    return {
      ok: false,
      failureClass: "ci_prove_mismatch",
      detail: `violation fixture must fail attribution_void, got ${red.failureClass}`,
    };
  }

  // Idempotent re-lint of green
  const greenAgain = await lintPromotionCandidateFixture({
    repoRoot: opts.repoRoot,
    fixtureFile: PROMOTION_CANDIDATE_OK_FIXTURE,
    deviceId,
  });
  if (!greenAgain.ok) {
    return {
      ok: false,
      failureClass: "ci_prove_mismatch",
      detail: "green fixture failed on idempotent re-lint",
    };
  }

  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId: null,
    action: "ci_prove",
    deviceId,
    fixture: PROMOTION_CANDIDATE_VIOLATION_FIXTURE,
  });

  return {
    ok: true,
    greenStageId: green.manifest.stageId,
    redStageId: red.stageId ?? "(violation)",
  };
}

/** RET must never be marked weight-eligible. */
export function assertKnowledgeModeWeightPolicy(
  mode: string,
  enterWeights: boolean,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | { ok: false; failureClass: "ret_in_weights" | "schema_violation"; detail: string } {
  const subjectId = opts.subjectId ?? null;
  if (!(KNOWLEDGE_MODES as readonly string[]).includes(mode)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `unknown knowledge mode: ${mode}`,
    };
  }
  if (mode === "RET" && enterWeights) {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "knowledge_mode",
      failureClass: "ret_in_weights",
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "ret_in_weights",
      detail: "RET knowledge must never enter model weights",
    };
  }
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "knowledge_mode",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Score-map compare for worked promotion examples (ties reject).
 */
export function assertFullGateStrictBeat(
  championScores: Readonly<Record<string, number>>,
  challengerScores: Readonly<Record<string, number>>,
  requiredSetIds: readonly string[],
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: "tie_reject" | "slice_regression" | "schema_violation";
      detail: string;
      setId: string;
    } {
  const subjectId = opts.subjectId ?? null;
  if (requiredSetIds.length > CONSTITUTION_EXAMPLE_LIMIT) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: `requiredSetIds exceed ${CONSTITUTION_EXAMPLE_LIMIT}`,
      setId: "(section_limit)",
    };
  }
  for (const setId of requiredSetIds) {
    const champion = championScores[setId];
    const challenger = challengerScores[setId];
    if (
      typeof champion !== "number" ||
      typeof challenger !== "number" ||
      !Number.isFinite(champion) ||
      !Number.isFinite(challenger)
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `scores missing for setId=${setId}`,
        setId,
      };
    }
    if (challenger === champion) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "promote_compare",
        failureClass: "tie_reject",
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "tie_reject",
        detail: `tie on setId=${setId} — ties do not promote`,
        setId,
      };
    }
    if (!challengerStrictlyBeatsChampion(challenger, champion)) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "promote_compare",
        failureClass: "slice_regression",
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "slice_regression",
        detail: `challenger regresses on setId=${setId}`,
        setId,
      };
    }
  }
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "promote_compare",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true };
}

export function resolveConstitutionPath(repoRoot: string): string {
  return path.join(repoRoot, LEARNING_CONSTITUTION_RELPATH);
}

/**
 * Load the committed constitution markdown (idempotent; no mutation).
 */
export async function loadConstitutionDocument(opts: {
  repoRoot: string;
  subjectId?: string | null;
  deviceId?: string;
  onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
}): Promise<
  | { ok: true; text: string; relpath: typeof LEARNING_CONSTITUTION_RELPATH }
  | {
      ok: false;
      failureClass: "missing_constitution";
      detail: string;
      subjectId: string | null;
    }
> {
  const subjectId = opts.subjectId ?? null;
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "start",
    subjectId,
    action: "load_constitution",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  const abs = resolveConstitutionPath(opts.repoRoot);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "load_constitution",
      failureClass: "missing_constitution",
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "missing_constitution",
      detail: `constitution missing at ${LEARNING_CONSTITUTION_RELPATH}`,
      subjectId,
    };
  }
  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "load_constitution",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true, text, relpath: LEARNING_CONSTITUTION_RELPATH };
}

/**
 * Assert CONSTITUTION.md encodes every law + worked example phrase.
 * Concurrent callers are safe (pure read / compare).
 */
export function assertConstitutionCoherent(
  text: string,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: ConstitutionFailureClass;
      detail: string;
      lawId?: ConstitutionLawId;
      exampleId?: ConstitutionWorkedExampleId;
    } {
  const subjectId = opts.subjectId ?? null;
  if (CONSTITUTION_LAWS.length > CONSTITUTION_LAW_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `law count exceeds ${CONSTITUTION_LAW_LIMIT}`,
    };
  }
  if (CONSTITUTION_WORKED_EXAMPLES.length > CONSTITUTION_EXAMPLE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `example count exceeds ${CONSTITUTION_EXAMPLE_LIMIT}`,
    };
  }

  for (const law of CONSTITUTION_LAWS) {
    if (!text.includes(law.requiredPhrase)) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "assert_coherent",
        failureClass: "law_gap",
        lawId: law.id,
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "law_gap",
        detail: `constitution missing law phrase: ${law.requiredPhrase}`,
        lawId: law.id,
      };
    }
  }

  for (const example of CONSTITUTION_WORKED_EXAMPLES) {
    if (!text.includes(example.requiredPhrase)) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "assert_coherent",
        failureClass: "example_gap",
        exampleId: example.id,
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "example_gap",
        detail: `constitution missing worked example: ${example.id}`,
        exampleId: example.id,
      };
    }
  }

  for (const cls of SURGERY_COMPONENT_CLASSES) {
    if (!text.includes(`\`${cls}\``) && !text.includes(cls)) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `constitution missing surgery class ${cls}`,
      };
    }
  }

  if (!text.includes("evaluateChampionChallengerGate")) {
    return {
      ok: false,
      failureClass: "example_gap",
      detail: "promotion walkthrough must cite evaluateChampionChallengerGate",
    };
  }

  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "assert_coherent",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true };
}

/** In-memory learned overlay — used to drill kill-switch semantics in tests. */
export type KillSwitchLearnedState = {
  flags: Record<KillSwitchLearnedFlag, boolean>;
  adapterPinned: boolean;
};

/** All learned flags on + adapter pinned (pre-kill state). */
export function createLearnedOnState(): KillSwitchLearnedState {
  const flags = {} as Record<KillSwitchLearnedFlag, boolean>;
  for (const f of KILL_SWITCH_LEARNED_FLAGS) {
    flags[f] = true;
  }
  return { flags, adapterPinned: true };
}

/** True when every learned flag is off and adapter pin is cleared. */
export function isKillSwitchBaseline(state: KillSwitchLearnedState): boolean {
  if (state.adapterPinned) return false;
  return KILL_SWITCH_LEARNED_FLAGS.every((f) => state.flags[f] === false);
}

/**
 * One audited kill-switch apply (constitution L4).
 * Idempotent when already baseline. Partial leave-on → kill_switch_partial.
 *
 * @param leaveOnFlags — test/edge only: simulate incomplete operator apply
 */
export function applyKillSwitch(
  state: KillSwitchLearnedState,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    leaveOnFlags?: readonly KillSwitchLearnedFlag[];
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | {
      ok: true;
      state: KillSwitchLearnedState;
      idempotent: boolean;
      componentsReverted: readonly SurgeryComponentClass[];
    }
  | {
      ok: false;
      failureClass: "kill_switch_partial" | "section_limit" | "missing_subject";
      detail: string;
      state: KillSwitchLearnedState;
      remainingOn: readonly string[];
    } {
  const subjectId = opts.subjectId === undefined ? null : opts.subjectId;
  // subjectId may be null (fleet) — empty string is invalid subject-bound scope
  if (opts.subjectId !== undefined && opts.subjectId !== null) {
    if (typeof opts.subjectId !== "string" || !opts.subjectId.trim()) {
      return {
        ok: false,
        failureClass: "missing_subject",
        detail: "subject-bound kill-switch requires non-empty subjectId",
        state,
        remainingOn: [],
      };
    }
  }

  const leaveOn = new Set(opts.leaveOnFlags ?? []);
  if (leaveOn.size > KILL_SWITCH_COMPONENT_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `leaveOnFlags exceed ${KILL_SWITCH_COMPONENT_LIMIT}`,
      state,
      remainingOn: [...leaveOn],
    };
  }

  const wasBaseline = isKillSwitchBaseline(state);
  const nextFlags = { ...state.flags };
  for (const f of KILL_SWITCH_LEARNED_FLAGS) {
    nextFlags[f] = leaveOn.has(f);
  }
  const next: KillSwitchLearnedState = {
    flags: nextFlags,
    adapterPinned: leaveOn.has("learned_adapter"),
  };

  if (!isKillSwitchBaseline(next)) {
    const remainingOn = KILL_SWITCH_LEARNED_FLAGS.filter((f) => next.flags[f]);
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "kill_switch",
      failureClass: "kill_switch_partial",
      remainingOn,
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "kill_switch_partial",
      detail: `kill-switch incomplete — still on: ${remainingOn.join(",")}`,
      state: next,
      remainingOn,
    };
  }

  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "kill_switch",
    componentsReverted: [...SURGERY_COMPONENT_CLASSES],
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });

  return {
    ok: true,
    state: next,
    idempotent: wasBaseline,
    componentsReverted: [...SURGERY_COMPONENT_CLASSES],
  };
}

export function resolveKillSwitchRunbookPath(repoRoot: string): string {
  return path.join(repoRoot, KILL_SWITCH_RUNBOOK_RELPATH);
}

export async function loadKillSwitchRunbook(opts: {
  repoRoot: string;
  subjectId?: string | null;
  deviceId?: string;
  onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
}): Promise<
  | { ok: true; text: string; relpath: typeof KILL_SWITCH_RUNBOOK_RELPATH }
  | {
      ok: false;
      failureClass: "missing_constitution";
      detail: string;
      subjectId: string | null;
    }
> {
  const subjectId = opts.subjectId ?? null;
  const abs = resolveKillSwitchRunbookPath(opts.repoRoot);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    emit(opts.onTelemetry, {
      event: "learning.governance",
      outcome: "rejected",
      subjectId,
      action: "assert_kill_switch_runbook",
      failureClass: "missing_constitution",
      ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "missing_constitution",
      detail: `kill-switch runbook missing at ${KILL_SWITCH_RUNBOOK_RELPATH}`,
      subjectId,
    };
  }
  return { ok: true, text, relpath: KILL_SWITCH_RUNBOOK_RELPATH };
}

/**
 * Assert the operator runbook encodes L4 procedure + verify + drill schedule.
 */
export function assertKillSwitchRunbookCoherent(
  text: string,
  opts: {
    subjectId?: string | null;
    deviceId?: string;
    onTelemetry?: (e: ConstitutionTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: ConstitutionFailureClass;
      detail: string;
    } {
  const subjectId = opts.subjectId ?? null;
  const required = [
    "Kill-switch operator runbook",
    "learning.governance.kill_switch",
    "kill_switch_partial",
    "learned_adapter",
    "learned_routing",
    "parity:check",
    "golden:replay",
    "Monthly",
    "RUNBOOK_KILL_SWITCH_FLAGS",
    "RUNBOOK_KILL_SWITCH_VERIFY",
    "RUNBOOK_KILL_SWITCH_DRILL",
    "idempotent",
    "subjectId",
  ] as const;

  for (const phrase of required) {
    if (!text.includes(phrase)) {
      emit(opts.onTelemetry, {
        event: "learning.governance",
        outcome: "rejected",
        subjectId,
        action: "assert_kill_switch_runbook",
        failureClass: "law_gap",
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "law_gap",
        detail: `kill-switch runbook missing phrase: ${phrase}`,
      };
    }
  }

  for (const flag of KILL_SWITCH_LEARNED_FLAGS) {
    if (!text.includes(flag)) {
      return {
        ok: false,
        failureClass: "law_gap",
        detail: `kill-switch runbook missing flag: ${flag}`,
      };
    }
  }

  if (!text.includes(String(KILL_SWITCH_DRILL_INTERVAL_DAYS)) && !text.includes("Monthly")) {
    return {
      ok: false,
      failureClass: "law_gap",
      detail: "kill-switch runbook missing drill cadence",
    };
  }

  emit(opts.onTelemetry, {
    event: "learning.governance",
    outcome: "ok",
    subjectId,
    action: "assert_kill_switch_runbook",
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
  return { ok: true };
}
