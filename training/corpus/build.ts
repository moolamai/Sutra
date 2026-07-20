/**
 * Corpus manifest v1 — parse / validate / write boundary.
 *
 * Manifests are the sole source of truth for what enters training.
 * Validate on every write. RET is excluded from weight-training by
 * weightTrainingPolicy (not a post-hoc filter). Packages never import
 * domains/; sources are filesystem paths recorded in the manifest.
 *
 * Full deterministic shard build: `buildCorpusFromManifest` / CLI
 * (`scripts/build-corpus.mjs`) — read → filter → content-addressed shards.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  defaultBaselineRegistryRelpath,
  exactHashCheckDocuments,
  nearDupCheckAgainstBaselines,
  resolveCorpusBaselineRegistryPath,
  resolveCorpusRepoRoot,
  runFuzzyNearDupDedup,
  seedContaminatedCorpusWorkspace,
  verifyDecontamProofInBuildReport,
  type DecontamDocument,
  type DecontamProof,
  type FuzzyDedupDocument,
  type FuzzyDedupReport,
} from "./decontaminate.js";
import {
  LICENSE_LEDGER_BUILD_RELPATH,
  PROVENANCE_LICENSE_CLASSES,
  assembleBuildLicenseLedger,
  catalogFromManifestLicenseLedger,
  type CorpusExcludedShard,
  type ProvenanceConsentClass,
} from "./license_ledger.js";
import {
  loadBaselineRegistryDocumentFromFile,
  type BaselineRegistryDocument,
} from "@moolam/learning";

export const CORPUS_MANIFEST_SCHEMA_VERSION =
  "training.corpus-manifest.v1" as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Package root whether running from `build.ts` or compiled `dist/build.js`. */
export const CORPUS_PACKAGE_ROOT =
  path.basename(HERE) === "dist" ? path.resolve(HERE, "..") : HERE;

export const CORPUS_MANIFEST_JSON_SCHEMA_PATH = path.join(
  CORPUS_PACKAGE_ROOT,
  "manifest_schema.json",
);

/** Soft caps (NFR — bounded scans). */
export const CORPUS_SOURCES_LIMIT = 4096;
export const CORPUS_FILTERS_LIMIT = 64;
export const CORPUS_LANES_LIMIT = 64;
export const CORPUS_LICENSE_LEDGER_LIMIT = 512;
export const CORPUS_ID_MAX = 128;
export const CORPUS_PATH_MAX = 512;

export const CORPUS_KNOWLEDGE_MODES = Object.freeze([
  "MEM",
  "UND",
  "RET",
] as const);
export type CorpusKnowledgeMode = (typeof CORPUS_KNOWLEDGE_MODES)[number];

/** Aligns with @moolam/learning corpus shard consent classes. */
export const CORPUS_CONSENT_CLASSES = Object.freeze([
  "consented",
  "public",
  "synthetic",
  "government",
] as const);
export type CorpusConsentClass = (typeof CORPUS_CONSENT_CLASSES)[number];

export const CORPUS_FILTER_KINDS = Object.freeze([
  "exclude_unknown_license",
  "exclude_ret_from_weights",
  "exclude_eval_overlap",
  "near_duplicate_dedup",
  "custom",
] as const);

export type CorpusManifestFailureClass =
  | "schema"
  | "license"
  | "ret_policy"
  | "consent"
  | "lane"
  | "size"
  | "determinism"
  | "config"
  | "duplicate";

export type CorpusManifestTelemetry = {
  event: "training.corpus_manifest";
  op:
    | "parse"
    | "validate"
    | "write"
    | "canonical_bytes"
    | "build"
    | "filter"
    | "decontam"
    | "emit_shard"
    | "prove_rebuild"
    | "fuzzy_dedup"
    | "prove_decontam"
    | "license_ledger";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  manifestId?: string;
  failureClass?: CorpusManifestFailureClass | CorpusBuildFailureClass;
  detail?: string;
  sourceCount?: number;
  shardCount?: number;
};

export type CorpusBuildFailureClass =
  | CorpusManifestFailureClass
  | "source_missing"
  | "hash_mismatch"
  | "contamination"
  | "dedup"
  | "record_limit";

export class CorpusManifestError extends Error {
  readonly failureClass: CorpusManifestFailureClass;
  readonly code: string;
  readonly path?: string;

  constructor(
    message: string,
    failureClass: CorpusManifestFailureClass,
    extras?: { code?: string; path?: string },
  ) {
    super(message);
    this.name = "CorpusManifestError";
    this.failureClass = failureClass;
    this.code = extras?.code ?? failureClass;
    if (extras?.path !== undefined) this.path = extras.path;
  }
}

const idSchema = z.string().min(1).max(CORPUS_ID_MAX);
const pathSchema = z.string().min(1).max(CORPUS_PATH_MAX);
const sha256Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected sha256:<64 lowercase hex>");

/** Curriculum stage tags for SLM saturation ordering (pack SFT lanes). */
export const CORPUS_CURRICULUM_STAGES = Object.freeze([
  "protocol",
  "tool_use",
  "domain_depth",
  "repair",
] as const);
export type CorpusCurriculumStage = (typeof CORPUS_CURRICULUM_STAGES)[number];

export const PACK_SFT_CURRICULUM_SCHEMA_VERSION =
  "training.pack-sft-curriculum.v1" as const;

/** Target share for repair-heavy finales (~50% failures + decision-graphs). */
export const PACK_SFT_REPAIR_HEAVY_TARGET_WEIGHT = 0.5;

export const corpusCurriculumSchema = z.object({
  schemaVersion: z.literal(PACK_SFT_CURRICULUM_SCHEMA_VERSION),
  /** Fixed SLM stage order: protocol → tool_use → domain_depth → repair. */
  stageOrder: z
    .array(z.enum(CORPUS_CURRICULUM_STAGES))
    .length(CORPUS_CURRICULUM_STAGES.length),
  repairHeavyTargetWeight: z.number().min(0).max(1),
  stageCounts: z.object({
    protocol: z.number().int().min(0),
    tool_use: z.number().int().min(0),
    domain_depth: z.number().int().min(0),
    repair: z.number().int().min(0),
  }),
  stageWeights: z.object({
    protocol: z.number().min(0).max(1),
    tool_use: z.number().min(0).max(1),
    domain_depth: z.number().min(0).max(1),
    repair: z.number().min(0).max(1),
  }),
  /** Train order by stage then sourceId — semantic; not re-sorted on write. */
  orderedSourceIds: z.array(idSchema).min(1).max(CORPUS_SOURCES_LIMIT),
});

export type CorpusCurriculum = z.infer<typeof corpusCurriculumSchema>;

export const corpusSourceSchema = z.object({
  sourceId: idSchema,
  relpath: pathSchema,
  licenseId: idSchema,
  knowledgeMode: z.enum(CORPUS_KNOWLEDGE_MODES),
  laneCode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  contentHash: sha256Schema.optional(),
  /** Optional stage tag for pack SFT curriculum ordering. */
  curriculumStage: z.enum(CORPUS_CURRICULUM_STAGES).optional(),
});

export const corpusFilterSchema = z.object({
  filterId: idSchema,
  kind: z.enum(CORPUS_FILTER_KINDS),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const corpusDedupReportSchema = z.object({
  status: z.enum(["pending", "recorded"]),
  algorithm: z.enum(["sha256", "sha256+fuzzy"]),
  reportRelpath: pathSchema.optional(),
  fuzzyThreshold: z.number().min(0).max(1).optional(),
  /** Optional per-lane SimHash similarity overrides (0..1). */
  laneThresholds: z
    .record(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
      z.number().min(0).max(1),
    )
    .optional(),
});

export const corpusLicenseEntrySchema = z.object({
  licenseId: idSchema,
  spdxOrLabel: z.string().min(1).max(128),
  uri: pathSchema.optional(),
  /** Optional explicit class; otherwise inferred from spdxOrLabel at build. */
  licenseClass: z.enum(PROVENANCE_LICENSE_CLASSES).optional(),
});

export const corpusWeightTrainingPolicySchema = z.object({
  excludeKnowledgeModes: z
    .array(z.enum(CORPUS_KNOWLEDGE_MODES))
    .min(1)
    .max(3),
  requireKnownLicense: z.literal(true),
});

export const corpusDeterminismSchema = z.object({
  canonicalSort: z.literal(true),
  contentAddressedShards: z.literal(true),
  forbidWallClockInShardBytes: z.literal(true),
});

export const corpusDecontaminationProofSchema = z.object({
  status: z.enum(["pending", "recorded"]),
  baselineRegistryRelpath: pathSchema.optional(),
  reportRelpath: pathSchema.optional(),
});

export const corpusManifestSchema = z.object({
  schemaVersion: z.literal(CORPUS_MANIFEST_SCHEMA_VERSION),
  manifestId: z
    .string()
    .min(1)
    .max(CORPUS_ID_MAX)
    .regex(/^[A-Za-z0-9._:-]+$/),
  version: z.string().min(1).max(64),
  title: z.string().max(256).optional(),
  consentClass: z.enum(CORPUS_CONSENT_CLASSES),
  laneCodes: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    )
    .min(1)
    .max(CORPUS_LANES_LIMIT),
  knowledgeModes: z
    .array(z.enum(CORPUS_KNOWLEDGE_MODES))
    .min(1)
    .max(3),
  sources: z.array(corpusSourceSchema).min(1).max(CORPUS_SOURCES_LIMIT),
  filters: z.array(corpusFilterSchema).max(CORPUS_FILTERS_LIMIT),
  dedupReport: corpusDedupReportSchema,
  licenseLedger: z
    .array(corpusLicenseEntrySchema)
    .min(1)
    .max(CORPUS_LICENSE_LEDGER_LIMIT),
  weightTrainingPolicy: corpusWeightTrainingPolicySchema,
  determinism: corpusDeterminismSchema,
  decontaminationProof: corpusDecontaminationProofSchema.optional(),
  /** Optional SLM curriculum ordering metadata (pack SFT lanes). */
  curriculum: corpusCurriculumSchema.optional(),
  /**
   * Content-addressed mix policy version (sha256:…). Required for promotion;
   * must match the ratified sign-off hash.
   */
  mixPolicyVersion: sha256Schema.optional(),
});

export type CorpusManifest = z.infer<typeof corpusManifestSchema>;
export type CorpusSource = z.infer<typeof corpusSourceSchema>;

export type CorpusParseOk = { ok: true; value: CorpusManifest };
export type CorpusParseFail = {
  ok: false;
  message: string;
  failureClass: CorpusManifestFailureClass;
  path?: string;
};
export type CorpusParseResult = CorpusParseOk | CorpusParseFail;

function emit(
  onTelemetry: ((e: CorpusManifestTelemetry) => void) | undefined,
  partial: Omit<CorpusManifestTelemetry, "event">,
): void {
  onTelemetry?.({
    event: "training.corpus_manifest",
    ...partial,
  });
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sortedCopy<T>(values: readonly T[], key: (v: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Canonical JSON bytes for a validated manifest (deterministic rebuild identity).
 * Sorts arrays that the schema marks as canonically ordered.
 */
export function canonicalManifestBytes(manifest: CorpusManifest): Buffer {
  const normalized: CorpusManifest = {
    ...manifest,
    laneCodes: [...manifest.laneCodes].sort((a, b) => a.localeCompare(b)),
    knowledgeModes: [...manifest.knowledgeModes].sort((a, b) =>
      a.localeCompare(b),
    ),
    sources: sortedCopy(manifest.sources, (s) => s.sourceId),
    filters: sortedCopy(manifest.filters, (f) => f.filterId),
    licenseLedger: sortedCopy(manifest.licenseLedger, (l) => l.licenseId),
    weightTrainingPolicy: {
      ...manifest.weightTrainingPolicy,
      excludeKnowledgeModes: [
        ...manifest.weightTrainingPolicy.excludeKnowledgeModes,
      ].sort((a, b) => a.localeCompare(b)),
    },
    // curriculum.orderedSourceIds is semantic train order — preserve as-is.
    ...(manifest.curriculum !== undefined
      ? {
          curriculum: {
            ...manifest.curriculum,
            stageOrder: [...manifest.curriculum.stageOrder],
            orderedSourceIds: [...manifest.curriculum.orderedSourceIds],
            stageCounts: { ...manifest.curriculum.stageCounts },
            stageWeights: { ...manifest.curriculum.stageWeights },
          },
        }
      : {}),
  };
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function canonicalManifestSha256(manifest: CorpusManifest): string {
  return `sha256:${createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex")}`;
}

/**
 * Cross-field validation after Zod shape parse.
 */
export function validateCorpusManifestInvariants(
  manifest: CorpusManifest,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CorpusManifestTelemetry) => void;
  } = {},
): CorpusParseResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.manifest";
  const deviceId = options.deviceId?.trim() || "dev-corpus";

  if (!uniqueStrings(manifest.laneCodes)) {
    const fail: CorpusParseFail = {
      ok: false,
      message: "laneCodes must be unique",
      failureClass: "duplicate",
      path: "laneCodes",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "duplicate",
      detail: fail.message,
    });
    return fail;
  }

  if (!uniqueStrings(manifest.knowledgeModes)) {
    const fail: CorpusParseFail = {
      ok: false,
      message: "knowledgeModes must be unique",
      failureClass: "duplicate",
      path: "knowledgeModes",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "duplicate",
      detail: fail.message,
    });
    return fail;
  }

  const licenseIds = new Set(manifest.licenseLedger.map((l) => l.licenseId));
  if (licenseIds.size !== manifest.licenseLedger.length) {
    const fail: CorpusParseFail = {
      ok: false,
      message: "licenseLedger.licenseId values must be unique",
      failureClass: "duplicate",
      path: "licenseLedger",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "duplicate",
      detail: fail.message,
    });
    return fail;
  }

  const sourceIds = new Set<string>();
  const laneSet = new Set(manifest.laneCodes);
  const modeSet = new Set(manifest.knowledgeModes);

  for (let i = 0; i < manifest.sources.length; i++) {
    const src = manifest.sources[i]!;
    if (sourceIds.has(src.sourceId)) {
      const fail: CorpusParseFail = {
        ok: false,
        message: `duplicate sourceId: ${src.sourceId}`,
        failureClass: "duplicate",
        path: `sources[${i}].sourceId`,
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }
    sourceIds.add(src.sourceId);

    if (!licenseIds.has(src.licenseId)) {
      const fail: CorpusParseFail = {
        ok: false,
        message: `unknown licenseId (exclude): ${src.licenseId}`,
        failureClass: "license",
        path: `sources[${i}].licenseId`,
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "license",
        detail: fail.message,
      });
      return fail;
    }

    if (!laneSet.has(src.laneCode)) {
      const fail: CorpusParseFail = {
        ok: false,
        message: `source laneCode not declared in laneCodes: ${src.laneCode}`,
        failureClass: "lane",
        path: `sources[${i}].laneCode`,
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "lane",
        detail: fail.message,
      });
      return fail;
    }

    if (!modeSet.has(src.knowledgeMode)) {
      const fail: CorpusParseFail = {
        ok: false,
        message: `source knowledgeMode not declared in knowledgeModes: ${src.knowledgeMode}`,
        failureClass: "schema",
        path: `sources[${i}].knowledgeMode`,
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }
  }

  // L6: RET never enters weights — enforced by manifest policy, not post-hoc.
  if (!manifest.weightTrainingPolicy.excludeKnowledgeModes.includes("RET")) {
    const fail: CorpusParseFail = {
      ok: false,
      message:
        "weightTrainingPolicy.excludeKnowledgeModes must include RET (retrieval is not weights)",
      failureClass: "ret_policy",
      path: "weightTrainingPolicy.excludeKnowledgeModes",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "ret_policy",
      detail: fail.message,
    });
    return fail;
  }

  const hasRetSource = manifest.sources.some((s) => s.knowledgeMode === "RET");
  const hasRetFilter = manifest.filters.some(
    (f) => f.kind === "exclude_ret_from_weights",
  );
  if (hasRetSource && !hasRetFilter) {
    const fail: CorpusParseFail = {
      ok: false,
      message:
        "RET-tagged sources require filters[].kind=exclude_ret_from_weights",
      failureClass: "ret_policy",
      path: "filters",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "ret_policy",
      detail: fail.message,
    });
    return fail;
  }

  if (!manifest.weightTrainingPolicy.requireKnownLicense) {
    const fail: CorpusParseFail = {
      ok: false,
      message: "requireKnownLicense must be true",
      failureClass: "license",
      path: "weightTrainingPolicy.requireKnownLicense",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "license",
      detail: fail.message,
    });
    return fail;
  }

  if (
    !manifest.determinism.canonicalSort ||
    !manifest.determinism.contentAddressedShards ||
    !manifest.determinism.forbidWallClockInShardBytes
  ) {
    const fail: CorpusParseFail = {
      ok: false,
      message: "determinism flags must all be true for byte-identical rebuild",
      failureClass: "determinism",
      path: "determinism",
    };
    emit(options.onTelemetry, {
      op: "validate",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "determinism",
      detail: fail.message,
    });
    return fail;
  }

  if (manifest.curriculum !== undefined) {
    const cur = manifest.curriculum;
    const expectedOrder = [...CORPUS_CURRICULUM_STAGES];
    if (
      cur.stageOrder.length !== expectedOrder.length ||
      cur.stageOrder.some((s, i) => s !== expectedOrder[i])
    ) {
      const fail: CorpusParseFail = {
        ok: false,
        message:
          "curriculum.stageOrder must be protocol → tool_use → domain_depth → repair",
        failureClass: "schema",
        path: "curriculum.stageOrder",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }

    if (!uniqueStrings(cur.orderedSourceIds)) {
      const fail: CorpusParseFail = {
        ok: false,
        message: "curriculum.orderedSourceIds must be unique",
        failureClass: "duplicate",
        path: "curriculum.orderedSourceIds",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "duplicate",
        detail: fail.message,
      });
      return fail;
    }

    if (cur.orderedSourceIds.length !== manifest.sources.length) {
      const fail: CorpusParseFail = {
        ok: false,
        message:
          "curriculum.orderedSourceIds length must equal sources.length",
        failureClass: "schema",
        path: "curriculum.orderedSourceIds",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }

    for (const id of cur.orderedSourceIds) {
      if (!sourceIds.has(id)) {
        const fail: CorpusParseFail = {
          ok: false,
          message: `curriculum.orderedSourceIds references unknown sourceId: ${id}`,
          failureClass: "schema",
          path: "curriculum.orderedSourceIds",
        };
        emit(options.onTelemetry, {
          op: "validate",
          outcome: "error",
          subjectId,
          deviceId,
          manifestId: manifest.manifestId,
          failureClass: "schema",
          detail: fail.message,
        });
        return fail;
      }
    }

    for (const src of manifest.sources) {
      if (src.curriculumStage === undefined) {
        const fail: CorpusParseFail = {
          ok: false,
          message:
            "sources with curriculum metadata require curriculumStage on every source",
          failureClass: "schema",
          path: "sources.curriculumStage",
        };
        emit(options.onTelemetry, {
          op: "validate",
          outcome: "error",
          subjectId,
          deviceId,
          manifestId: manifest.manifestId,
          failureClass: "schema",
          detail: fail.message,
        });
        return fail;
      }
    }

    // Stage order must match tagged stages when sorted by stage then sourceId.
    const byId = new Map(manifest.sources.map((s) => [s.sourceId, s]));
    const expectedIds = [...manifest.sources]
      .sort((a, b) => {
        const ai = CORPUS_CURRICULUM_STAGES.indexOf(a.curriculumStage!);
        const bi = CORPUS_CURRICULUM_STAGES.indexOf(b.curriculumStage!);
        if (ai !== bi) return ai - bi;
        return a.sourceId.localeCompare(b.sourceId);
      })
      .map((s) => s.sourceId);
    if (expectedIds.some((id, i) => id !== cur.orderedSourceIds[i])) {
      const fail: CorpusParseFail = {
        ok: false,
        message:
          "curriculum.orderedSourceIds must follow stage order then sourceId",
        failureClass: "schema",
        path: "curriculum.orderedSourceIds",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }

    const counts = {
      protocol: 0,
      tool_use: 0,
      domain_depth: 0,
      repair: 0,
    };
    for (const id of cur.orderedSourceIds) {
      const stage = byId.get(id)!.curriculumStage!;
      counts[stage] += 1;
    }
    for (const stage of CORPUS_CURRICULUM_STAGES) {
      if (cur.stageCounts[stage] !== counts[stage]) {
        const fail: CorpusParseFail = {
          ok: false,
          message: `curriculum.stageCounts.${stage} mismatch (got ${cur.stageCounts[stage]}, expected ${counts[stage]})`,
          failureClass: "schema",
          path: `curriculum.stageCounts.${stage}`,
        };
        emit(options.onTelemetry, {
          op: "validate",
          outcome: "error",
          subjectId,
          deviceId,
          manifestId: manifest.manifestId,
          failureClass: "schema",
          detail: fail.message,
        });
        return fail;
      }
    }

    const weightSum =
      cur.stageWeights.protocol +
      cur.stageWeights.tool_use +
      cur.stageWeights.domain_depth +
      cur.stageWeights.repair;
    if (Math.abs(weightSum - 1) > 1e-9) {
      const fail: CorpusParseFail = {
        ok: false,
        message: `curriculum.stageWeights must sum to 1 (got ${weightSum})`,
        failureClass: "schema",
        path: "curriculum.stageWeights",
      };
      emit(options.onTelemetry, {
        op: "validate",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "schema",
        detail: fail.message,
      });
      return fail;
    }
  }

  emit(options.onTelemetry, {
    op: "validate",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: manifest.manifestId,
    sourceCount: manifest.sources.length,
  });

  return { ok: true, value: manifest };
}

/**
 * Parse + invariant-validate a corpus manifest value.
 */
export function parseCorpusManifest(
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CorpusManifestTelemetry) => void;
  } = {},
): CorpusParseResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.manifest";
  const deviceId = options.deviceId?.trim() || "dev-corpus";

  const parsed = corpusManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const fail: CorpusParseFail = {
      ok: false,
      message: issue?.message ?? "schema validation failed",
      failureClass: "schema",
      ...(issue?.path?.length
        ? { path: issue.path.map(String).join(".") }
        : {}),
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }

  emit(options.onTelemetry, {
    op: "parse",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: parsed.data.manifestId,
    sourceCount: parsed.data.sources.length,
  });

  return validateCorpusManifestInvariants(parsed.data, options);
}

export function loadCorpusManifestFile(
  filePath: string,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CorpusManifestTelemetry) => void;
  } = {},
): CorpusParseResult {
  if (!existsSync(filePath)) {
    const fail: CorpusParseFail = {
      ok: false,
      message: `manifest missing: ${filePath}`,
      failureClass: "config",
      path: filePath,
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId: options.subjectId?.trim() || "subj.corpus.manifest",
      deviceId: options.deviceId?.trim() || "dev-corpus",
      failureClass: "config",
      detail: fail.message,
    });
    return fail;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    const fail: CorpusParseFail = {
      ok: false,
      message: `manifest JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      failureClass: "schema",
      path: filePath,
    };
    emit(options.onTelemetry, {
      op: "parse",
      outcome: "error",
      subjectId: options.subjectId?.trim() || "subj.corpus.manifest",
      deviceId: options.deviceId?.trim() || "dev-corpus",
      failureClass: "schema",
      detail: fail.message,
    });
    return fail;
  }
  return parseCorpusManifest(raw, options);
}

/**
 * Validate on write: reject invalid manifests; write canonical bytes on success.
 * Idempotent for the same validated content (byte-identical output).
 */
export function writeCorpusManifest(
  filePath: string,
  input: unknown,
  options: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CorpusManifestTelemetry) => void;
  } = {},
): CorpusParseResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.manifest";
  const deviceId = options.deviceId?.trim() || "dev-corpus";
  const validated = parseCorpusManifest(input, options);
  if (!validated.ok) {
    emit(options.onTelemetry, {
      op: "write",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: validated.failureClass,
      detail: validated.message,
    });
    return validated;
  }

  const bytes = canonicalManifestBytes(validated.value);
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeFileSync(filePath, bytes);

  emit(options.onTelemetry, {
    op: "write",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: validated.value.manifestId,
    sourceCount: validated.value.sources.length,
  });
  emit(options.onTelemetry, {
    op: "canonical_bytes",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: validated.value.manifestId,
    detail: canonicalManifestSha256(validated.value),
  });

  return validated;
}

/** Knowledge modes eligible for weight training under this manifest. */
export function weightEligibleKnowledgeModes(
  manifest: CorpusManifest,
): CorpusKnowledgeMode[] {
  const excluded = new Set(manifest.weightTrainingPolicy.excludeKnowledgeModes);
  return CORPUS_KNOWLEDGE_MODES.filter((m) => !excluded.has(m));
}

export function assertCommittedManifestSchemaPresent(): void {
  if (!existsSync(CORPUS_MANIFEST_JSON_SCHEMA_PATH)) {
    throw new CorpusManifestError(
      `committed JSON schema missing: ${CORPUS_MANIFEST_JSON_SCHEMA_PATH}`,
      "config",
      { code: "schema_missing", path: CORPUS_MANIFEST_JSON_SCHEMA_PATH },
    );
  }
  const raw = JSON.parse(
    readFileSync(CORPUS_MANIFEST_JSON_SCHEMA_PATH, "utf8"),
  ) as { properties?: { schemaVersion?: { const?: string } } };
  if (raw.properties?.schemaVersion?.const !== CORPUS_MANIFEST_SCHEMA_VERSION) {
    throw new CorpusManifestError(
      "manifest_schema.json schemaVersion const drift",
      "schema",
      { code: "schema_drift" },
    );
  }
}

// ---------------------------------------------------------------------------
// Deterministic corpus builder (manifest → filters → shards + report)
// ---------------------------------------------------------------------------

export const CORPUS_SHARD_SCHEMA_VERSION = "training.corpus-shard.v1" as const;
export const CORPUS_BUILD_REPORT_SCHEMA_VERSION =
  "training.corpus-build-report.v1" as const;
export const CORPUS_RECORDS_PER_SOURCE_LIMIT = 4096;
export const CORPUS_BASELINE_ENTRY_SCAN_LIMIT = 4096;

export type CorpusSourceRecord = {
  docId: string;
  text: string;
};

export type CorpusShardDocument = {
  schemaVersion: typeof CORPUS_SHARD_SCHEMA_VERSION;
  shardId: string;
  mix: "weight" | "retrieve";
  consentClass: CorpusConsentClass;
  knowledgeMode: CorpusKnowledgeMode;
  laneCode: string;
  licenseId: string;
  sourceId: string;
  sourceRelpath: string;
  contentHash: string;
  records: CorpusSourceRecord[];
};

export type CorpusBuildShardEntry = {
  mix: "weight" | "retrieve";
  shardId: string;
  relpath: string;
  sourceId: string;
  knowledgeMode: CorpusKnowledgeMode;
  licenseId: string;
  contentHash: string;
  recordCount: number;
};

export type CorpusBuildReport = {
  schemaVersion: typeof CORPUS_BUILD_REPORT_SCHEMA_VERSION;
  manifestId: string;
  manifestVersion: string;
  manifestHash: string;
  /** Content hash of the emitted per-shard license ledger (manifest→ledger ref). */
  licenseLedgerHash: string;
  licenseLedgerRelpath: string;
  consentClass: CorpusConsentClass;
  weightShardCount: number;
  retrieveShardCount: number;
  excludedSourceIds: string[];
  /** Excluded sources/shards with typed reasons (unknown license, RET policy, …). */
  excludedShards: CorpusExcludedShard[];
  dedupDroppedDocIds: string[];
  dedup?: {
    status: "skipped" | "recorded";
    algorithm: "sha256" | "sha256+fuzzy";
    fuzzyThreshold?: number;
    laneThresholds?: Record<string, number>;
    reportRelpath?: string;
    droppedCount: number;
  };
  decontamination: {
    status: "skipped" | "passed";
    method?: "exact_hash" | "exact_hash+simhash_near_dup";
    baselineRegistryRelpath?: string;
    checkedHashCount: number;
    registryHashCount?: number;
    nearDupCheckedDocCount?: number;
  };
  shards: CorpusBuildShardEntry[];
};

export type CorpusBuildOk = {
  ok: true;
  outDir: string;
  report: CorpusBuildReport;
  reportRelpath: string;
  licenseLedgerRelpath: string;
  weightShardRelpaths: string[];
  retrieveShardRelpaths: string[];
};

export type CorpusBuildFail = {
  ok: false;
  message: string;
  failureClass: CorpusBuildFailureClass;
  path?: string;
};

export type CorpusBuildResult = CorpusBuildOk | CorpusBuildFail;

export type BuildCorpusOptions = {
  /** Directory containing the manifest file (for resolving relative source paths). */
  manifestDir?: string;
  /** Override package/repo root for baseline registry + absolute source roots. */
  packageRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CorpusManifestTelemetry) => void;
};

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256Prefixed(buf: Buffer | string): string {
  return `sha256:${sha256Hex(buf)}`;
}

function resolveSourcePath(
  relpath: string,
  manifestDir: string,
  packageRoot: string,
): string {
  if (path.isAbsolute(relpath)) return relpath;
  const fromManifest = path.resolve(manifestDir, relpath);
  if (existsSync(fromManifest)) return fromManifest;
  return path.resolve(packageRoot, relpath);
}

function parseJsonlRecords(
  bytes: Buffer,
  sourceId: string,
):
  | { ok: true; records: CorpusSourceRecord[] }
  | { ok: false; message: string; failureClass: CorpusBuildFailureClass } {
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > CORPUS_RECORDS_PER_SOURCE_LIMIT) {
    return {
      ok: false,
      message: `source ${sourceId} exceeds ${CORPUS_RECORDS_PER_SOURCE_LIMIT} records`,
      failureClass: "record_limit",
    };
  }
  const records: CorpusSourceRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch (err) {
      return {
        ok: false,
        message: `source ${sourceId} line ${i + 1} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        failureClass: "schema",
      };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { docId?: unknown }).docId !== "string" ||
      typeof (parsed as { text?: unknown }).text !== "string"
    ) {
      return {
        ok: false,
        message: `source ${sourceId} line ${i + 1} must have docId+text strings`,
        failureClass: "schema",
      };
    }
    records.push({
      docId: (parsed as { docId: string }).docId,
      text: (parsed as { text: string }).text,
    });
  }
  records.sort((a, b) => a.docId.localeCompare(b.docId));
  return { ok: true, records };
}

function canonicalShardBytes(shard: CorpusShardDocument): Buffer {
  // Stable key order via explicit object construction + JSON.stringify.
  const body = {
    schemaVersion: shard.schemaVersion,
    shardId: shard.shardId,
    mix: shard.mix,
    consentClass: shard.consentClass,
    knowledgeMode: shard.knowledgeMode,
    laneCode: shard.laneCode,
    licenseId: shard.licenseId,
    sourceId: shard.sourceId,
    sourceRelpath: shard.sourceRelpath,
    contentHash: shard.contentHash,
    records: shard.records,
  };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * Build corpus shards from a validated manifest.
 * RET sources emit under retrieve/ only — never weight/.
 * Two builds with the same inputs yield byte-identical shard trees.
 */
export function buildCorpusFromManifest(
  manifest: CorpusManifest,
  outDir: string,
  options: BuildCorpusOptions = {},
): CorpusBuildResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.build";
  const deviceId = options.deviceId?.trim() || "dev-corpus-build";
  const packageRoot = options.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const manifestDir = options.manifestDir ?? packageRoot;
  const filterKinds = new Set(manifest.filters.map((f) => f.kind));
  const excludedModes = new Set(
    manifest.weightTrainingPolicy.excludeKnowledgeModes,
  );

  emit(options.onTelemetry, {
    op: "build",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: manifest.manifestId,
    detail: "start",
    sourceCount: manifest.sources.length,
  });

  const sources = sortedCopy(manifest.sources, (s) => s.sourceId);
  const excludedSourceIds: string[] = [];
  const excludedShards: CorpusExcludedShard[] = [];
  const weightShards: { relpath: string; entry: CorpusBuildShardEntry; bytes: Buffer }[] =
    [];
  const retrieveShards: {
    relpath: string;
    entry: CorpusBuildShardEntry;
    bytes: Buffer;
  }[] = [];

  type PendingSource = {
    src: CorpusSource;
    actualHash: string;
    records: CorpusSourceRecord[];
  };
  const pending: PendingSource[] = [];

  let decontamStatus: "skipped" | "passed" = "skipped";
  let decontamProof: DecontamProof | undefined;
  let baselineRegistryRelpath: string | undefined;
  let baselineDocument: BaselineRegistryDocument | null = null;
  const decontamDocuments: DecontamDocument[] = [];
  const nearDupCandidates: {
    docId: string;
    text: string;
    laneCode: string;
  }[] = [];

  const fuzzyEnabled =
    manifest.dedupReport.algorithm === "sha256+fuzzy" ||
    filterKinds.has("near_duplicate_dedup");
  const fuzzyThreshold =
    manifest.dedupReport.fuzzyThreshold ?? 0.92;
  const laneThresholds = manifest.dedupReport.laneThresholds ?? {};

  const catalogResult = catalogFromManifestLicenseLedger(
    manifest.licenseLedger,
    { subjectId, deviceId },
  );
  if (!catalogResult.ok) {
    emit(options.onTelemetry, {
      op: "license_ledger",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "license",
      detail: catalogResult.message,
    });
    return {
      ok: false,
      message: catalogResult.message,
      failureClass: "license",
    };
  }
  const licenseCatalog = catalogResult.value;

  if (filterKinds.has("exclude_eval_overlap")) {
    baselineRegistryRelpath =
      manifest.decontaminationProof?.baselineRegistryRelpath ??
      defaultBaselineRegistryRelpath();
    const registryPath = resolveCorpusBaselineRegistryPath(
      baselineRegistryRelpath,
      packageRoot,
    );
    const loaded = loadBaselineRegistryDocumentFromFile(registryPath, {
      deviceId,
    });
    if (!loaded.ok) {
      emit(options.onTelemetry, {
        op: "decontam",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "contamination",
        detail: loaded.detail,
      });
      return {
        ok: false,
        message: loaded.detail,
        failureClass: "contamination",
      };
    }
    baselineDocument = loaded.document;
  }

  for (const src of sources) {
    // License filter: unknown already rejected at validate; keep explicit gate.
    if (
      filterKinds.has("exclude_unknown_license") &&
      !manifest.licenseLedger.some((l) => l.licenseId === src.licenseId)
    ) {
      excludedSourceIds.push(src.sourceId);
      excludedShards.push({
        sourceId: src.sourceId,
        reason: "unknown_license",
        licenseId: src.licenseId,
        detail: "licenseId not in manifest licenseLedger",
      });
      emit(options.onTelemetry, {
        op: "filter",
        outcome: "ok",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "license",
        detail: `excluded_unknown_license:${src.sourceId}`,
      });
      continue;
    }

    if (!licenseCatalog.some((c) => c.licenseId === src.licenseId)) {
      excludedSourceIds.push(src.sourceId);
      excludedShards.push({
        sourceId: src.sourceId,
        reason: "unresolvable_license_class",
        licenseId: src.licenseId,
        detail: "licenseId missing from resolved catalog",
      });
      emit(options.onTelemetry, {
        op: "filter",
        outcome: "ok",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "license",
        detail: `excluded_unresolvable_license:${src.sourceId}`,
      });
      continue;
    }

    const abs = resolveSourcePath(src.relpath, manifestDir, packageRoot);
    if (!existsSync(abs)) {
      const fail: CorpusBuildFail = {
        ok: false,
        message: `source missing: ${src.relpath}`,
        failureClass: "source_missing",
        path: src.relpath,
      };
      emit(options.onTelemetry, {
        op: "build",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "source_missing",
        detail: fail.message,
      });
      return fail;
    }

    const bytes = readFileSync(abs);
    const actualHash = sha256Prefixed(bytes);
    if (src.contentHash && src.contentHash !== actualHash) {
      const fail: CorpusBuildFail = {
        ok: false,
        message: `contentHash mismatch for ${src.sourceId}: manifest=${src.contentHash} actual=${actualHash}`,
        failureClass: "hash_mismatch",
        path: src.relpath,
      };
      emit(options.onTelemetry, {
        op: "build",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "hash_mismatch",
        detail: fail.message,
      });
      return fail;
    }

    const parsed = parseJsonlRecords(bytes, src.sourceId);
    if (!parsed.ok) {
      // Source-level exact-hash: file bytes match a registered eval artifact.
      if (baselineDocument) {
        const probe = exactHashCheckDocuments(
          baselineDocument,
          [{ docId: src.sourceId, contentHash: actualHash }],
          {
            baselineRegistryRelpath:
              baselineRegistryRelpath ?? defaultBaselineRegistryRelpath(),
            deviceId,
          },
        );
        if (!probe.ok) {
          emit(options.onTelemetry, {
            op: "decontam",
            outcome: "error",
            subjectId,
            deviceId,
            manifestId: manifest.manifestId,
            failureClass: "contamination",
            detail: probe.message,
          });
          return {
            ok: false,
            message: probe.message,
            failureClass: "contamination",
            path: src.relpath,
          };
        }
      }
      emit(options.onTelemetry, {
        op: "build",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: parsed.failureClass,
        detail: parsed.message,
      });
      return {
        ok: false,
        message: parsed.message,
        failureClass: parsed.failureClass,
      };
    }

    if (baselineDocument) {
      for (const rec of parsed.records) {
        decontamDocuments.push({
          docId: rec.docId,
          contentHash: actualHash,
        });
        decontamDocuments.push({
          docId: rec.docId,
          contentHash: sha256Prefixed(rec.text),
        });
        nearDupCandidates.push({
          docId: rec.docId,
          text: rec.text,
          laneCode: src.laneCode,
        });
      }
    }

    const mix: "weight" | "retrieve" = excludedModes.has(src.knowledgeMode)
      ? "retrieve"
      : "weight";

    // Policy: RET (and any excluded mode) never enters weight mix.
    if (src.knowledgeMode === "RET" && mix !== "retrieve") {
      const fail: CorpusBuildFail = {
        ok: false,
        message: "RET source must not enter weight mix",
        failureClass: "ret_policy",
        path: src.sourceId,
      };
      emit(options.onTelemetry, {
        op: "filter",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "ret_policy",
        detail: fail.message,
      });
      return fail;
    }

    if (
      filterKinds.has("exclude_ret_from_weights") &&
      src.knowledgeMode === "RET" &&
      mix === "weight"
    ) {
      excludedSourceIds.push(src.sourceId);
      excludedShards.push({
        sourceId: src.sourceId,
        reason: "ret_excluded_from_weights",
        licenseId: src.licenseId,
      });
      continue;
    }

    pending.push({
      src,
      actualHash,
      records: parsed.records,
    });
  }

  if (baselineDocument) {
    const checked = exactHashCheckDocuments(
      baselineDocument,
      decontamDocuments,
      {
        baselineRegistryRelpath:
          baselineRegistryRelpath ?? defaultBaselineRegistryRelpath(),
        deviceId,
      },
    );
    decontamProof = checked.proof;
    if (!checked.ok) {
      emit(options.onTelemetry, {
        op: "decontam",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "contamination",
        detail: checked.message,
      });
      return {
        ok: false,
        message: checked.message,
        failureClass: "contamination",
      };
    }

    // Near-dup vs baselines when fuzzy algorithm is declared (eval leakage).
    if (fuzzyEnabled) {
      const near = nearDupCheckAgainstBaselines({
        document: baselineDocument,
        repoRoot: resolveCorpusRepoRoot(packageRoot),
        documents: nearDupCandidates,
        baselineRegistryRelpath:
          baselineRegistryRelpath ?? defaultBaselineRegistryRelpath(),
        fuzzyThreshold,
        laneThresholds,
        deviceId,
        exactProof: checked.proof,
      });
      decontamProof = near.proof;
      if (!near.ok) {
        emit(options.onTelemetry, {
          op: "decontam",
          outcome: "error",
          subjectId,
          deviceId,
          manifestId: manifest.manifestId,
          failureClass: "contamination",
          detail: near.message,
        });
        return {
          ok: false,
          message: near.message,
          failureClass: "contamination",
        };
      }
    }

    decontamStatus = "passed";
    emit(options.onTelemetry, {
      op: "decontam",
      outcome: "ok",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      detail: `checked=${decontamProof.checkedHashCount};registry=${decontamProof.registryHashCount}`,
    });
  }

  let dedupDroppedDocIds: string[] = [];
  let dedupReportDoc: FuzzyDedupReport | undefined;
  const droppedSet = new Set<string>();

  if (fuzzyEnabled) {
    const fuzzyDocs: FuzzyDedupDocument[] = [];
    for (const p of pending) {
      for (const rec of p.records) {
        fuzzyDocs.push({
          docId: rec.docId,
          text: rec.text,
          laneCode: p.src.laneCode,
          contentHash: sha256Prefixed(rec.text),
        });
      }
    }
    const deduped = runFuzzyNearDupDedup(fuzzyDocs, {
      algorithm: manifest.dedupReport.algorithm,
      fuzzyThreshold,
      laneThresholds,
    });
    if (!deduped.ok) {
      emit(options.onTelemetry, {
        op: "fuzzy_dedup",
        outcome: "error",
        subjectId,
        deviceId,
        manifestId: manifest.manifestId,
        failureClass: "dedup",
        detail: deduped.message,
      });
      return {
        ok: false,
        message: deduped.message,
        failureClass: "dedup",
      };
    }
    dedupReportDoc = deduped.report;
    dedupDroppedDocIds = deduped.report.droppedDocIds;
    for (const id of dedupDroppedDocIds) droppedSet.add(id);
    emit(options.onTelemetry, {
      op: "fuzzy_dedup",
      outcome: "ok",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      detail: `dropped=${dedupDroppedDocIds.length};kept=${deduped.report.keptDocCount}`,
    });
  }

  for (const p of pending) {
    const records = fuzzyEnabled
      ? p.records.filter((r) => !droppedSet.has(r.docId))
      : p.records;
    if (records.length === 0) {
      excludedSourceIds.push(p.src.sourceId);
      excludedShards.push({
        sourceId: p.src.sourceId,
        reason: "empty_after_dedup",
        licenseId: p.src.licenseId,
      });
      continue;
    }

    const mix: "weight" | "retrieve" = excludedModes.has(p.src.knowledgeMode)
      ? "retrieve"
      : "weight";

    const provisional: Omit<CorpusShardDocument, "shardId"> = {
      schemaVersion: CORPUS_SHARD_SCHEMA_VERSION,
      mix,
      consentClass: manifest.consentClass,
      knowledgeMode: p.src.knowledgeMode,
      laneCode: p.src.laneCode,
      licenseId: p.src.licenseId,
      sourceId: p.src.sourceId,
      sourceRelpath: p.src.relpath.replace(/\\/g, "/"),
      contentHash: p.actualHash,
      records,
    };

    // Content-addressed id from body without shardId, then stamp shardId.
    const idHash = sha256Prefixed(
      JSON.stringify({
        ...provisional,
      }),
    );
    const shard: CorpusShardDocument = {
      ...provisional,
      shardId: idHash,
    };
    const shardBytes = canonicalShardBytes(shard);
    const fileHash = sha256Hex(shardBytes);
    const relpath = path.posix.join(mix, `sha256-${fileHash}.json`);
    const entry: CorpusBuildShardEntry = {
      mix,
      shardId: shard.shardId,
      relpath,
      sourceId: p.src.sourceId,
      knowledgeMode: p.src.knowledgeMode,
      licenseId: p.src.licenseId,
      contentHash: p.actualHash,
      recordCount: records.length,
    };

    if (mix === "weight") {
      weightShards.push({ relpath, entry, bytes: shardBytes });
    } else {
      retrieveShards.push({ relpath, entry, bytes: shardBytes });
    }

    emit(options.onTelemetry, {
      op: "emit_shard",
      outcome: "ok",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      detail: `${mix}:${p.src.sourceId}`,
    });
  }

  const emittedShardMetas = [...weightShards, ...retrieveShards].map((s) => ({
    shardId: s.entry.shardId,
    sourceId: s.entry.sourceId,
    licenseId: s.entry.licenseId,
    laneCode:
      pending.find((p) => p.src.sourceId === s.entry.sourceId)?.src.laneCode,
  }));

  const ledgerAssembled = assembleBuildLicenseLedger({
    manifestId: manifest.manifestId,
    catalog: licenseCatalog,
    shards: emittedShardMetas.map((s) => ({
      shardId: s.shardId,
      sourceId: s.sourceId,
      licenseId: s.licenseId,
      ...(s.laneCode !== undefined ? { laneCode: s.laneCode } : {}),
    })),
    consentClass: manifest.consentClass as ProvenanceConsentClass,
    locality: "on-device",
    subjectId,
    deviceId,
  });
  if (!ledgerAssembled.ok) {
    for (const sourceId of ledgerAssembled.unresolvedSourceIds) {
      if (!excludedSourceIds.includes(sourceId)) {
        excludedSourceIds.push(sourceId);
      }
      excludedShards.push({
        sourceId,
        reason: "unknown_license",
        detail: ledgerAssembled.message,
      });
    }
    emit(options.onTelemetry, {
      op: "license_ledger",
      outcome: "error",
      subjectId,
      deviceId,
      manifestId: manifest.manifestId,
      failureClass: "license",
      detail: ledgerAssembled.message,
    });
    return {
      ok: false,
      message: ledgerAssembled.message,
      failureClass: "license",
    };
  }

  const report: CorpusBuildReport = {
    schemaVersion: CORPUS_BUILD_REPORT_SCHEMA_VERSION,
    manifestId: manifest.manifestId,
    manifestVersion: manifest.version,
    manifestHash: canonicalManifestSha256(manifest),
    licenseLedgerHash: ledgerAssembled.value.contentHash,
    licenseLedgerRelpath: ledgerAssembled.value.relpath,
    consentClass: manifest.consentClass,
    weightShardCount: weightShards.length,
    retrieveShardCount: retrieveShards.length,
    excludedSourceIds: [...excludedSourceIds].sort((a, b) =>
      a.localeCompare(b),
    ),
    excludedShards: [...excludedShards].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId),
    ),
    dedupDroppedDocIds: [...dedupDroppedDocIds].sort((a, b) =>
      a.localeCompare(b),
    ),
    ...(dedupReportDoc
      ? {
          dedup: {
            status: "recorded" as const,
            algorithm: dedupReportDoc.algorithm,
            fuzzyThreshold: dedupReportDoc.fuzzyThreshold,
            laneThresholds: dedupReportDoc.laneThresholds,
            reportRelpath: "dedup-report.json",
            droppedCount: dedupReportDoc.droppedDocIds.length,
          },
        }
      : {
          dedup: {
            status: "skipped" as const,
            algorithm: manifest.dedupReport.algorithm,
            droppedCount: 0,
          },
        }),
    decontamination: {
      status: decontamStatus,
      ...(decontamProof
        ? {
            method: decontamProof.method,
            checkedHashCount: decontamProof.checkedHashCount,
            registryHashCount: decontamProof.registryHashCount,
            ...(decontamProof.nearDupCheckedDocCount !== undefined
              ? {
                  nearDupCheckedDocCount: decontamProof.nearDupCheckedDocCount,
                }
              : {}),
          }
        : { checkedHashCount: 0 }),
      ...(baselineRegistryRelpath
        ? { baselineRegistryRelpath }
        : {}),
    },
    shards: [...weightShards, ...retrieveShards]
      .map((s) => s.entry)
      .sort((a, b) => a.relpath.localeCompare(b.relpath)),
  };

  const reportBytes = Buffer.from(
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  // Write tree (deterministic paths + bytes).
  mkdirSync(outDir, { recursive: true });
  for (const s of [...weightShards, ...retrieveShards]) {
    const abs = path.join(outDir, ...s.relpath.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, s.bytes);
  }
  if (dedupReportDoc) {
    writeFileSync(
      path.join(outDir, "dedup-report.json"),
      `${JSON.stringify(dedupReportDoc, null, 2)}\n`,
      "utf8",
    );
  }
  writeFileSync(
    path.join(outDir, ledgerAssembled.value.relpath),
    ledgerAssembled.value.bytes,
  );
  const reportRelpath = "build-report.json";
  writeFileSync(path.join(outDir, reportRelpath), reportBytes);

  emit(options.onTelemetry, {
    op: "license_ledger",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: manifest.manifestId,
    detail: ledgerAssembled.value.contentHash,
    shardCount: ledgerAssembled.value.document.entries.length,
  });

  emit(options.onTelemetry, {
    op: "build",
    outcome: "ok",
    subjectId,
    deviceId,
    manifestId: manifest.manifestId,
    detail: "pass",
    shardCount: weightShards.length + retrieveShards.length,
    sourceCount: manifest.sources.length,
  });

  return {
    ok: true,
    outDir,
    report,
    reportRelpath,
    licenseLedgerRelpath: ledgerAssembled.value.relpath,
    weightShardRelpaths: weightShards.map((s) => s.relpath).sort(),
    retrieveShardRelpaths: retrieveShards.map((s) => s.relpath).sort(),
  };
}

export type BuildCorpusCliIo = {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

export type ParsedBuildCorpusCli = {
  help: boolean;
  manifestPath?: string;
  outDir?: string;
  packageRoot?: string;
  subjectId?: string;
  deviceId?: string;
  errors: string[];
};

export function parseBuildCorpusArgv(
  argv: readonly string[],
): ParsedBuildCorpusCli {
  const out: ParsedBuildCorpusCli = { help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "--manifest") {
      const v = argv[++i];
      if (!v) out.errors.push("--manifest requires a path");
      else out.manifestPath = v;
      continue;
    }
    if (a === "--out") {
      const v = argv[++i];
      if (!v) out.errors.push("--out requires a path");
      else out.outDir = v;
      continue;
    }
    if (a === "--package-root") {
      const v = argv[++i];
      if (!v) out.errors.push("--package-root requires a path");
      else out.packageRoot = v;
      continue;
    }
    if (a === "--subject-id") {
      const v = argv[++i];
      if (!v) out.errors.push("--subject-id requires a value");
      else out.subjectId = v;
      continue;
    }
    if (a === "--device-id") {
      const v = argv[++i];
      if (!v) out.errors.push("--device-id requires a value");
      else out.deviceId = v;
      continue;
    }
    out.errors.push(`unknown argument: ${a}`);
  }
  return out;
}

const BUILD_CORPUS_HELP = `Usage: build-corpus --manifest <path> --out <dir>

Read a corpus manifest, apply filters, emit content-addressed shards + build-report.json.
RET (and other excluded modes) go under retrieve/, never weight/.

  --manifest <path>   Corpus manifest JSON
  --out <dir>         Output directory for shards/ + build-report.json
  --package-root      Override training/corpus package root
  --subject-id        Telemetry subject scope
  --device-id         Telemetry device scope
  -h, --help          Show help
`;

/**
 * CLI: deterministic corpus build. Exit 0/1.
 */
export function runBuildCorpusCli(
  argv: readonly string[],
  io: BuildCorpusCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  const args = parseBuildCorpusArgv(argv);
  if (args.help) {
    io.stdout.write(BUILD_CORPUS_HELP);
    return 0;
  }
  if (args.errors.length) {
    io.stderr.write(`${args.errors.join("\n")}\n`);
    return 1;
  }
  if (!args.manifestPath || !args.outDir) {
    io.stderr.write("build-corpus: --manifest and --out are required\n");
    return 1;
  }

  const subjectId = args.subjectId ?? "subj.corpus.build.cli";
  const deviceId = args.deviceId ?? "dev-corpus-build-cli";
  const packageRoot = args.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const manifestPath = path.resolve(args.manifestPath);
  const loaded = loadCorpusManifestFile(manifestPath, {
    subjectId,
    deviceId,
  });
  if (!loaded.ok) {
    io.stderr.write(
      JSON.stringify({
        event: "training.corpus_manifest",
        op: "build",
        outcome: "error",
        failureClass: loaded.failureClass,
        message: loaded.message,
        subjectId,
        deviceId,
      }) + "\n",
    );
    return 1;
  }

  const result = buildCorpusFromManifest(loaded.value, path.resolve(args.outDir), {
    manifestDir: path.dirname(manifestPath),
    packageRoot,
    subjectId,
    deviceId,
  });

  if (!result.ok) {
    io.stderr.write(
      JSON.stringify({
        event: "training.corpus_manifest",
        op: "build",
        outcome: "error",
        failureClass: result.failureClass,
        message: result.message,
        subjectId,
        deviceId,
      }) + "\n",
    );
    return 1;
  }

  io.stdout.write(
    JSON.stringify({
      event: "training.corpus_manifest",
      op: "build",
      outcome: "ok",
      manifestId: result.report.manifestId,
      outDir: result.outDir,
      weightShardCount: result.report.weightShardCount,
      retrieveShardCount: result.report.retrieveShardCount,
      manifestHash: result.report.manifestHash,
      subjectId,
      deviceId,
    }) + "\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Byte-identical rebuild regression (golden ×2 + nondeterminism fixture)
// ---------------------------------------------------------------------------

export type CorpusTreeFile = { relpath: string; sha256: string };

export type CompareCorpusTreesResult =
  | { identical: true; files: CorpusTreeFile[] }
  | {
      identical: false;
      reason: string;
      leftOnly?: string[];
      rightOnly?: string[];
      mismatched?: string[];
    };

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, name.name);
      if (name.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Compare two corpus output trees by relative path + content sha256. */
export function compareCorpusOutTrees(
  leftDir: string,
  rightDir: string,
): CompareCorpusTreesResult {
  const leftFiles = listRelativeFiles(leftDir);
  const rightFiles = listRelativeFiles(rightDir);
  const leftSet = new Set(leftFiles);
  const rightSet = new Set(rightFiles);
  const leftOnly = leftFiles.filter((f) => !rightSet.has(f));
  const rightOnly = rightFiles.filter((f) => !leftSet.has(f));
  if (leftOnly.length || rightOnly.length) {
    return {
      identical: false,
      reason: "file set differs",
      ...(leftOnly.length ? { leftOnly } : {}),
      ...(rightOnly.length ? { rightOnly } : {}),
    };
  }
  const mismatched: string[] = [];
  const files: CorpusTreeFile[] = [];
  for (const rel of leftFiles) {
    const lb = readFileSync(path.join(leftDir, ...rel.split("/")));
    const rb = readFileSync(path.join(rightDir, ...rel.split("/")));
    const lh = sha256Prefixed(lb);
    const rh = sha256Prefixed(rb);
    files.push({ relpath: rel, sha256: lh });
    if (lh !== rh) mismatched.push(rel);
  }
  if (mismatched.length) {
    return {
      identical: false,
      reason: "content hash differs",
      mismatched,
    };
  }
  return { identical: true, files };
}

/**
 * Intentional nondeterminism fixture: stamp wall-clock into shard JSON so two
 * builds diverge. Used only by the rebuild prove (never production builds).
 */
export function poisonCorpusTreeWithWallClock(
  outDir: string,
  stampMs: number,
): number {
  let poisoned = 0;
  for (const rel of listRelativeFiles(outDir)) {
    if (!rel.endsWith(".json") || rel === "build-report.json") continue;
    const abs = path.join(outDir, ...rel.split("/"));
    const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<
      string,
      unknown
    >;
    raw.__nondeterministicBuiltAtMs = stampMs;
    writeFileSync(abs, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    poisoned += 1;
  }
  return poisoned;
}

export type ProveByteIdenticalRebuildOptions = {
  manifestPath?: string;
  packageRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CorpusManifestTelemetry) => void;
};

export type ProveByteIdenticalRebuildResult = {
  ok: boolean;
  goldenIdentical: boolean;
  nondeterminismDetected: boolean;
  retExcludedFromWeight: boolean;
  decontaminationPassed: boolean;
  failures: string[];
  fileCount?: number;
};

/**
 * Regression prove:
 * 1) Golden manifest built twice → byte-identical (green).
 * 2) Intentional wall-clock poison → trees differ (fixture fails identity check).
 * 3) RET remains outside weight mix; decontam green on golden.
 */
export function proveByteIdenticalRebuild(
  options: ProveByteIdenticalRebuildOptions = {},
): ProveByteIdenticalRebuildResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.prove.rebuild";
  const deviceId = options.deviceId?.trim() || "dev-corpus-prove";
  const packageRoot = options.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const manifestPath =
    options.manifestPath ??
    path.join(packageRoot, "fixtures", "valid", "minimal.json");
  const failures: string[] = [];

  emit(options.onTelemetry, {
    op: "prove_rebuild",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "start",
  });

  const loaded = loadCorpusManifestFile(manifestPath, {
    subjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!loaded.ok) {
    failures.push(`manifest load failed: ${loaded.message}`);
    emit(options.onTelemetry, {
      op: "prove_rebuild",
      outcome: "error",
      subjectId,
      deviceId,
      failureClass: loaded.failureClass,
      detail: loaded.message,
    });
    return {
      ok: false,
      goldenIdentical: false,
      nondeterminismDetected: false,
      retExcludedFromWeight: false,
      decontaminationPassed: false,
      failures,
    };
  }

  const dirA = mkdtempSync(path.join(tmpdir(), "corpus-rebuild-a-"));
  const dirB = mkdtempSync(path.join(tmpdir(), "corpus-rebuild-b-"));
  const dirPoisonA = mkdtempSync(path.join(tmpdir(), "corpus-poison-a-"));
  const dirPoisonB = mkdtempSync(path.join(tmpdir(), "corpus-poison-b-"));

  let goldenIdentical = false;
  let nondeterminismDetected = false;
  let retExcludedFromWeight = false;
  let decontaminationPassed = false;
  let fileCount: number | undefined;

  try {
    const buildOpts: BuildCorpusOptions = {
      packageRoot,
      manifestDir: path.dirname(manifestPath),
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    };

    const a = buildCorpusFromManifest(loaded.value, dirA, buildOpts);
    const b = buildCorpusFromManifest(loaded.value, dirB, buildOpts);
    if (!a.ok || !b.ok) {
      failures.push(
        `golden build failed: ${!a.ok ? a.message : ""} ${!b.ok ? b.message : ""}`.trim(),
      );
    } else {
      decontaminationPassed = a.report.decontamination.status === "passed";
      if (!decontaminationPassed) {
        failures.push("expected decontamination status=passed on golden build");
      }

      retExcludedFromWeight = a.weightShardRelpaths.every((rel) => {
        const shard = JSON.parse(
          readFileSync(path.join(dirA, ...rel.split("/")), "utf8"),
        ) as { knowledgeMode?: string; mix?: string };
        return shard.knowledgeMode !== "RET" && shard.mix === "weight";
      });
      if (a.retrieveShardRelpaths.length < 1) {
        // golden fixture includes RET — require retrieve shard present
        failures.push("expected at least one retrieve shard for RET source");
        retExcludedFromWeight = false;
      }
      if (!retExcludedFromWeight) {
        failures.push("RET leaked into weight mix shards");
      }

      const cmp = compareCorpusOutTrees(dirA, dirB);
      goldenIdentical = cmp.identical === true;
      if (cmp.identical) {
        fileCount = cmp.files.length;
      } else {
        failures.push(`golden rebuild not identical: ${cmp.reason}`);
      }
    }

    // Intentional nondeterminism fixture: poison each tree with different stamps.
    const p1 = buildCorpusFromManifest(loaded.value, dirPoisonA, buildOpts);
    const p2 = buildCorpusFromManifest(loaded.value, dirPoisonB, buildOpts);
    if (p1.ok && p2.ok) {
      poisonCorpusTreeWithWallClock(dirPoisonA, 1_700_000_000_001);
      poisonCorpusTreeWithWallClock(dirPoisonB, 1_700_000_000_002);
      const poisoned = compareCorpusOutTrees(dirPoisonA, dirPoisonB);
      nondeterminismDetected = poisoned.identical === false;
      if (!nondeterminismDetected) {
        failures.push(
          "nondeterminism fixture did not diverge — regression would miss wall-clock drift",
        );
      }
    } else {
      failures.push("poison baseline builds failed");
    }

    const ok =
      goldenIdentical &&
      nondeterminismDetected &&
      retExcludedFromWeight &&
      decontaminationPassed &&
      failures.length === 0;

    emit(options.onTelemetry, {
      op: "prove_rebuild",
      outcome: ok ? "ok" : "error",
      subjectId,
      deviceId,
      manifestId: loaded.value.manifestId,
      detail: ok
        ? "golden_identical+nondeterminism_detected"
        : (failures[0] ?? "prove_failed"),
      ...(fileCount !== undefined ? { shardCount: fileCount } : {}),
    });

    return {
      ok,
      goldenIdentical,
      nondeterminismDetected,
      retExcludedFromWeight,
      decontaminationPassed,
      failures,
      ...(fileCount !== undefined ? { fileCount } : {}),
    };
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirPoisonA, { recursive: true, force: true });
    rmSync(dirPoisonB, { recursive: true, force: true });
  }
}

/**
 * CLI for CI: exit 0 when golden rebuild is byte-identical and
 * the nondeterminism fixture is detected as divergent.
 */
export function runProveRebuildCli(
  argv: readonly string[],
  io: BuildCorpusCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.stdout.write(
      "Usage: prove-rebuild [--manifest <path>]\n\n" +
        "Build golden corpus twice (byte-identical) and prove intentional\n" +
        "nondeterminism fixture diverges.\n",
    );
    return 0;
  }

  let manifestPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      manifestPath = argv[++i];
    }
  }

  const subjectId = "subj.corpus.prove.cli";
  const deviceId = "dev-corpus-prove-cli";
  const result = proveByteIdenticalRebuild({
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    subjectId,
    deviceId,
  });

  const line = JSON.stringify({
    event: "training.corpus_manifest",
    op: "prove_rebuild",
    outcome: result.ok ? "ok" : "error",
    goldenIdentical: result.goldenIdentical,
    nondeterminismDetected: result.nondeterminismDetected,
    retExcludedFromWeight: result.retExcludedFromWeight,
    decontaminationPassed: result.decontaminationPassed,
    failures: result.failures,
    fileCount: result.fileCount,
    subjectId,
    deviceId,
  });

  if (result.ok) {
    io.stdout.write(`${line}\n`);
    return 0;
  }
  io.stderr.write(`${line}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Decontamination CI gate prove (seeded red → clean green + proof section)
// ---------------------------------------------------------------------------

export type ProveDecontaminationCiGateOptions = {
  packageRoot?: string;
  cleanManifestPath?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CorpusManifestTelemetry) => void;
};

export type ProveDecontaminationCiGateResult = {
  ok: boolean;
  contaminatedFailed: boolean;
  cleanPassed: boolean;
  proofPresent: boolean;
  registryHashCount?: number;
  offendingDocIds?: string[];
  failures: string[];
};

/**
 * CI prove:
 * 1) Seeded eval-overlap fixture build → must fail (contamination).
 * 2) Clean sample manifest build → must pass with decontamination proof.
 */
export function proveDecontaminationCiGate(
  options: ProveDecontaminationCiGateOptions = {},
): ProveDecontaminationCiGateResult {
  const subjectId = options.subjectId?.trim() || "subj.corpus.prove.decontam";
  const deviceId = options.deviceId?.trim() || "dev-corpus-prove-decontam";
  const packageRoot = options.packageRoot ?? CORPUS_PACKAGE_ROOT;
  const cleanManifestPath =
    options.cleanManifestPath ??
    path.join(packageRoot, "fixtures", "valid", "minimal.json");
  const failures: string[] = [];

  emit(options.onTelemetry, {
    op: "prove_decontam",
    outcome: "ok",
    subjectId,
    deviceId,
    detail: "start",
  });

  const repoRoot = resolveCorpusRepoRoot(packageRoot);
  const smokeAbs = path.join(
    repoRoot,
    "training",
    "eval",
    "fixtures",
    "smoke-baseline.json",
  );
  if (!existsSync(smokeAbs)) {
    failures.push(`smoke baseline missing: ${smokeAbs}`);
    emit(options.onTelemetry, {
      op: "prove_decontam",
      outcome: "error",
      subjectId,
      deviceId,
      detail: failures[0] ?? "smoke baseline missing",
    });
    return {
      ok: false,
      contaminatedFailed: false,
      cleanPassed: false,
      proofPresent: false,
      failures,
    };
  }

  const workspace = mkdtempSync(path.join(tmpdir(), "corpus-decontam-ci-"));
  let contaminatedFailed = false;
  let cleanPassed = false;
  let proofPresent = false;
  let registryHashCount: number | undefined;
  let offendingDocIds: string[] | undefined;

  try {
    const seeded = seedContaminatedCorpusWorkspace({
      workspaceRoot: workspace,
      evalArtifactAbsPath: smokeAbs,
      baselineRegistryRelpath: path.join(
        repoRoot,
        "training",
        "eval",
        "baseline_registry.json",
      ),
    });

    const contamLoaded = loadCorpusManifestFile(seeded.manifestPath, {
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (!contamLoaded.ok) {
      failures.push(`contaminated manifest load failed: ${contamLoaded.message}`);
    } else {
      const red = buildCorpusFromManifest(contamLoaded.value, seeded.outDir, {
        packageRoot: seeded.workspaceRoot,
        manifestDir: seeded.workspaceRoot,
        subjectId,
        deviceId,
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
      contaminatedFailed =
        red.ok === false && red.failureClass === "contamination";
      if (!contaminatedFailed) {
        failures.push(
          red.ok
            ? "seeded contamination unexpectedly built successfully"
            : `seeded contamination failed with ${red.failureClass}: ${red.message}`,
        );
      } else if (!red.ok) {
        const match = /offendingDocIds=\[([^\]]*)\]/.exec(red.message);
        if (match?.[1]) {
          offendingDocIds = match[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (!/train-on-eval|offendingDocIds/i.test(red.message)) {
          failures.push(
            "contaminated failure message missing train-on-eval / offendingDocIds",
          );
          contaminatedFailed = false;
        }
      }
    }

    const cleanLoaded = loadCorpusManifestFile(cleanManifestPath, {
      subjectId,
      deviceId,
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (!cleanLoaded.ok) {
      failures.push(`clean manifest load failed: ${cleanLoaded.message}`);
    } else {
      const greenOut = path.join(workspace, "out-clean");
      const green = buildCorpusFromManifest(cleanLoaded.value, greenOut, {
        packageRoot,
        manifestDir: path.dirname(cleanManifestPath),
        subjectId,
        deviceId,
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
      if (!green.ok) {
        failures.push(`clean build failed: ${green.message}`);
      } else {
        const baselineRel =
          green.report.decontamination.baselineRegistryRelpath ??
          defaultBaselineRegistryRelpath();
        const registryPath = resolveCorpusBaselineRegistryPath(
          baselineRel,
          packageRoot,
        );
        const registry = loadBaselineRegistryDocumentFromFile(registryPath, {
          deviceId,
        });
        if (!registry.ok) {
          failures.push(`registry load for proof check failed: ${registry.detail}`);
        } else {
          const proofCheck = verifyDecontamProofInBuildReport(
            registry.document,
            green.report.decontamination,
            {
              deviceId,
              requireNearDup:
                cleanLoaded.value.dedupReport.algorithm === "sha256+fuzzy",
            },
          );
          proofPresent = proofCheck.ok;
          if (proofCheck.ok) {
            registryHashCount = proofCheck.registryHashCount;
          } else {
            failures.push(proofCheck.message);
          }
        }
        cleanPassed =
          green.report.decontamination.status === "passed" && proofPresent;
        if (green.report.decontamination.status !== "passed") {
          failures.push("clean build missing decontamination status=passed");
        }
      }
    }

    const ok =
      contaminatedFailed &&
      cleanPassed &&
      proofPresent &&
      failures.length === 0;

    emit(options.onTelemetry, {
      op: "prove_decontam",
      outcome: ok ? "ok" : "error",
      subjectId,
      deviceId,
      detail: ok
        ? "contaminated_red+clean_green+proof"
        : (failures[0] ?? "prove_failed"),
      ...(registryHashCount !== undefined
        ? { shardCount: registryHashCount }
        : {}),
    });

    return {
      ok,
      contaminatedFailed,
      cleanPassed,
      proofPresent,
      failures,
      ...(registryHashCount !== undefined ? { registryHashCount } : {}),
      ...(offendingDocIds !== undefined ? { offendingDocIds } : {}),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * CLI for CI: exit 0 when seeded contamination fails and clean sample
 * passes with a decontamination proof section in the build report.
 */
export function runProveDecontamCli(
  argv: readonly string[],
  io: BuildCorpusCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.stdout.write(
      "Usage: prove-decontam [--manifest <clean-manifest>]\n\n" +
        "Seeded eval-overlap build must fail; clean sample must pass with\n" +
        "decontamination proof in the build report.\n",
    );
    return 0;
  }

  let cleanManifestPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      cleanManifestPath = argv[++i];
    }
  }

  const subjectId = "subj.corpus.prove.decontam.cli";
  const deviceId = "dev-corpus-prove-decontam-cli";
  const result = proveDecontaminationCiGate({
    ...(cleanManifestPath !== undefined ? { cleanManifestPath } : {}),
    subjectId,
    deviceId,
  });

  const line = JSON.stringify({
    event: "training.corpus_manifest",
    op: "prove_decontam",
    outcome: result.ok ? "ok" : "error",
    contaminatedFailed: result.contaminatedFailed,
    cleanPassed: result.cleanPassed,
    proofPresent: result.proofPresent,
    registryHashCount: result.registryHashCount,
    offendingDocIds: result.offendingDocIds,
    failures: result.failures,
    subjectId,
    deviceId,
  });

  if (result.ok) {
    io.stdout.write(`${line}\n`);
    return 0;
  }
  io.stderr.write(`${line}\n`);
  return 1;
}
