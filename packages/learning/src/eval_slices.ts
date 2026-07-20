/**
 * Frozen eval slices — taxonomy, naming, and registry→slice mapping.
 *
 * Slice dimensions: domainPackId / language / bindingId.
 * Gate reports use the slash form as failingSlice (never raw content).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BASELINE_SLICE_TAG_LIMIT,
  loadBaselineRegistry,
  type BaselineRegistryDocument,
  type BaselineRegistryEntry,
  resolveBaselineSourcePath,
} from "./baseline_registry.js";

export const EVAL_SLICE_TAXONOMY_SCHEMA_VERSION = "eval-slices.v1" as const;

/** Repo-relative committed taxonomy path. */
export const EVAL_SLICE_TAXONOMY_RELPATH =
  "training/eval/slices/taxonomy.json" as const;

/** Soft caps (NFR — bounded). */
export const EVAL_SLICE_LIMIT = 256;
export const EVAL_SLICE_ID_LIMIT = 192;

export type EvalSliceKey = {
  domainPackId: string;
  language: string;
  bindingId: string;
};

export type EvalSliceTaxonomyEntry = EvalSliceKey & {
  emptyMarker: boolean;
  note?: string;
};

export type EvalSliceNaming = {
  pattern: "{domainPackId}/{language}/{bindingId}";
  separator: "/";
  gateReportField: "failingSlice";
};

export type EvalSliceTaxonomyDocument = {
  schemaVersion: typeof EVAL_SLICE_TAXONOMY_SCHEMA_VERSION;
  naming: EvalSliceNaming;
  dimensions: {
    domainPackId: string[];
    language: string[];
    bindingId: string[];
  };
  slices: EvalSliceTaxonomyEntry[];
};

export type EvalSliceMapping = {
  sliceId: string;
  key: EvalSliceKey;
  emptyMarker: boolean;
  /** Latest-version baseline setIds mapped into this slice. */
  baselineSetIds: string[];
  /** Pinned seeds from mapped baselines (sorted, unique). */
  pinnedSeeds: number[];
  /**
   * Score tolerance for non-deterministic evals.
   * `null` = pinned exact path (no floating exact-match flakiness).
   */
  tolerance: number | null;
};

export type EvalSliceFailureClass =
  | "schema_violation"
  | "source_missing"
  | "path_escape"
  | "section_limit"
  | "empty_slice"
  | "missing_slice"
  | "cross_slice_contamination"
  | "slice_regression"
  | "timeout"
  | "runner_error"
  | "aggregate_only_forbidden"
  | "seed_missing"
  /** Registered pack/binding lacks a frozen slice with baselines. */
  | "coverage_incomplete";

export type EvalSliceTelemetryEvent = {
  event: "learning.eval_slices";
  outcome: "ok" | "rejected";
  /** Eval runners are fixture-scoped — never a learner subjectId. */
  subjectId: null;
  deviceId?: string;
  action?:
    | "load"
    | "validate"
    | "map"
    | "gate_lint"
    | "contamination_check"
    | "promote_gate"
    | "run_slice"
    | "run_suite"
    | "seed_inject"
    | "coverage_check";
  sliceId?: string;
  failureClass?: EvalSliceFailureClass;
  entryCount?: number;
  failingSlice?: string;
  pinnedSeed?: number;
  /** Named missing slices for CI reports (bounded). */
  missingSliceIds?: string[];
};

export const EVAL_SLICE_COVERAGE_SCHEMA_VERSION =
  "eval-slice-coverage.v1" as const;

/**
 * CI coverage report — missing slices are listed by slash-form name.
 * Empty-marker slices are tracked separately (not silently skipped).
 */
export type EvalSliceCoverageReport = {
  schemaVersion: typeof EVAL_SLICE_COVERAGE_SCHEMA_VERSION;
  coveredSliceIds: string[];
  missingSliceIds: string[];
  emptyMarkerSliceIds: string[];
  registryDomainPackIds: string[];
  registryBindingIds: string[];
  uncoveredDomainPackIds: string[];
  uncoveredBindingIds: string[];
};

export const EVAL_SLICE_RUN_SCHEMA_VERSION = "eval-slice-run.v1" as const;
export const EVAL_SLICE_RUNNER_POLICY_RELPATH =
  "training/eval/slices/runner-policy.json" as const;
export const EVAL_SLICE_RUNNER_POLICY_SCHEMA_VERSION =
  "eval-slice-runner-policy.v1" as const;

export const EVAL_SLICE_DEFAULT_TIMEOUT_MS = 5_000;
export const EVAL_SLICE_MAX_BASELINES_PER_SLICE = 64;

/** Deterministic RNG injected into stochastic eval components. */
export type PinnedSeedRng = {
  readonly seed: number;
  /** Uniform [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
};

export type SliceBaselineScoreInput = {
  sliceId: string;
  setId: string;
  pinnedSeed: number;
  rng: PinnedSeedRng;
  /** Always null for frozen eval fixtures (sovereignty). */
  subjectId: null;
  deviceId?: string;
};

export type SliceBaselineScoreFn = (
  input: SliceBaselineScoreInput,
) => Promise<
  | { ok: true; score: number }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
    }
>;

export type EvalSliceBaselineScore = {
  setId: string;
  score: number;
  pinnedSeed: number;
};

export type EvalSliceScoreResult = {
  sliceId: string;
  score: number;
  pinnedSeeds: number[];
  baselineScores: EvalSliceBaselineScore[];
  tolerance: number | null;
};

export type EvalSliceAggregate = {
  mean: number;
  min: number;
  max: number;
  sliceCount: number;
};

/**
 * Suite report — per-slice scores are primary; aggregate is derived only.
 * Construct via `buildEvalSliceRunReport` so aggregate-only is impossible.
 */
export type EvalSliceRunReport = {
  schemaVersion: typeof EVAL_SLICE_RUN_SCHEMA_VERSION;
  slices: EvalSliceScoreResult[];
  aggregate: EvalSliceAggregate;
};

export type EvalSliceRunnerPolicy = {
  schemaVersion: typeof EVAL_SLICE_RUNNER_POLICY_SCHEMA_VERSION;
  maxSlicesPerRun: number;
  maxBaselinesPerSlice: number;
  defaultTimeoutMs: number;
};

const dimToken = z.string().min(1).max(BASELINE_SLICE_TAG_LIMIT);

const sliceEntrySchema = z
  .object({
    domainPackId: dimToken,
    language: dimToken,
    bindingId: dimToken,
    emptyMarker: z.boolean(),
    note: z.string().max(256).optional(),
  })
  .strict();

export const evalSliceTaxonomyDocumentSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SLICE_TAXONOMY_SCHEMA_VERSION),
    naming: z
      .object({
        pattern: z.literal("{domainPackId}/{language}/{bindingId}"),
        separator: z.literal("/"),
        gateReportField: z.literal("failingSlice"),
      })
      .strict(),
    dimensions: z
      .object({
        domainPackId: z.array(dimToken).min(1).max(EVAL_SLICE_LIMIT),
        language: z.array(dimToken).min(1).max(64),
        bindingId: z.array(dimToken).min(1).max(64),
      })
      .strict(),
    slices: z.array(sliceEntrySchema).min(1).max(EVAL_SLICE_LIMIT),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const packs = new Set(doc.dimensions.domainPackId);
    const langs = new Set(doc.dimensions.language);
    const bindings = new Set(doc.dimensions.bindingId);
    const seen = new Set<string>();
    for (let i = 0; i < doc.slices.length; i += 1) {
      const s = doc.slices[i]!;
      if (!packs.has(s.domainPackId)) {
        ctx.addIssue({
          code: "custom",
          path: ["slices", i, "domainPackId"],
          message: `domainPackId=${s.domainPackId} not in dimensions`,
        });
      }
      if (!langs.has(s.language)) {
        ctx.addIssue({
          code: "custom",
          path: ["slices", i, "language"],
          message: `language=${s.language} not in dimensions`,
        });
      }
      if (!bindings.has(s.bindingId)) {
        ctx.addIssue({
          code: "custom",
          path: ["slices", i, "bindingId"],
          message: `bindingId=${s.bindingId} not in dimensions`,
        });
      }
      const id = formatSliceId(s);
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["slices", i],
          message: `duplicate sliceId=${id}`,
        });
      }
      seen.add(id);
    }
  });

function emit(
  onTelemetry: ((e: EvalSliceTelemetryEvent) => void) | undefined,
  event: EvalSliceTelemetryEvent,
): void {
  onTelemetry?.(event);
}

/** Canonical gate-report slice id. */
export function formatSliceId(key: EvalSliceKey): string {
  return `${key.domainPackId}/${key.language}/${key.bindingId}`;
}

/**
 * Parse a slash-form slice id. Rejects escapes and oversized tokens.
 */
export function parseSliceId(sliceId: string):
  | { ok: true; key: EvalSliceKey }
  | {
      ok: false;
      failureClass: "schema_violation";
      detail: string;
      failingSlice: string;
    } {
  if (
    !sliceId ||
    sliceId.length > EVAL_SLICE_ID_LIMIT ||
    sliceId.includes("..") ||
    sliceId.includes("\\") ||
    sliceId.startsWith("/") ||
    sliceId.endsWith("/")
  ) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "sliceId must be domainPackId/language/bindingId",
      failingSlice: sliceId || "(empty)",
    };
  }
  const parts = sliceId.split("/");
  if (parts.length !== 3 || parts.some((p) => !p || p.length > BASELINE_SLICE_TAG_LIMIT)) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "sliceId must be domainPackId/language/bindingId",
      failingSlice: sliceId,
    };
  }
  return {
    ok: true,
    key: {
      domainPackId: parts[0]!,
      language: parts[1]!,
      bindingId: parts[2]!,
    },
  };
}

/** Map registry sliceTags → slice key. */
export function sliceKeyFromRegistryEntry(
  entry: BaselineRegistryEntry,
): EvalSliceKey {
  return {
    domainPackId: entry.sliceTags.domainPack,
    language: entry.sliceTags.language,
    bindingId: entry.sliceTags.binding,
  };
}

export function parseEvalSliceTaxonomyDocument(input: unknown):
  | { ok: true; document: EvalSliceTaxonomyDocument }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
    } {
  const parsed = evalSliceTaxonomyDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: first?.message ?? "eval slice taxonomy schema_violation",
    };
  }
  const document: EvalSliceTaxonomyDocument = {
    schemaVersion: parsed.data.schemaVersion,
    naming: parsed.data.naming,
    dimensions: parsed.data.dimensions,
    slices: parsed.data.slices.map((s) => ({
      domainPackId: s.domainPackId,
      language: s.language,
      bindingId: s.bindingId,
      emptyMarker: s.emptyMarker,
      ...(s.note !== undefined ? { note: s.note } : {}),
    })),
  };
  return { ok: true, document };
}

export async function loadEvalSliceTaxonomy(options: {
  repoRoot: string;
  taxonomyPath?: string;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | { ok: true; document: EvalSliceTaxonomyDocument; taxonomyPath: string }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
    }
> {
  const rel = options.taxonomyPath ?? EVAL_SLICE_TAXONOMY_RELPATH;
  const resolved = resolveBaselineSourcePath(options.repoRoot, rel);
  if (!resolved.ok) {
    emit(options.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "path_escape",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "path_escape",
      detail: resolved.detail,
    };
  }

  let raw: string;
  try {
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    emit(options.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "source_missing",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "source_missing",
      detail: `taxonomy missing at ${rel}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    emit(options.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "load",
      failureClass: "schema_violation",
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: "taxonomy JSON parse failed",
    };
  }

  const parsed = parseEvalSliceTaxonomyDocument(json);
  if (!parsed.ok) {
    emit(options.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "validate",
      failureClass: parsed.failureClass,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    });
    return parsed;
  }

  emit(options.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "load",
    entryCount: parsed.document.slices.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return {
    ok: true,
    document: parsed.document,
    taxonomyPath: rel,
  };
}

function latestBySetId(
  document: BaselineRegistryDocument,
): BaselineRegistryEntry[] {
  const best = new Map<string, BaselineRegistryEntry>();
  for (const entry of document.entries) {
    const prior = best.get(entry.setId);
    if (!prior || entry.version > prior.version) {
      best.set(entry.setId, entry);
    }
  }
  return [...best.values()];
}

/**
 * Map registry entries onto taxonomy slices (latest version per setId).
 * Empty-marker slices with no baselines remain in the map with emptySetIds.
 */
export function mapRegistryToEvalSlices(
  registry: BaselineRegistryDocument,
  taxonomy: EvalSliceTaxonomyDocument,
  options: {
    deviceId?: string;
    onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
  } = {},
):
  | { ok: true; mappings: EvalSliceMapping[] }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice?: string;
    } {
  if (taxonomy.slices.length > EVAL_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `slices exceed ${EVAL_SLICE_LIMIT}`,
    };
  }

  const buckets = new Map<
    string,
    { entry: EvalSliceTaxonomyEntry; baselines: BaselineRegistryEntry[] }
  >();
  for (const slice of taxonomy.slices) {
    buckets.set(formatSliceId(slice), { entry: slice, baselines: [] });
  }

  for (const baseline of latestBySetId(registry)) {
    const key = sliceKeyFromRegistryEntry(baseline);
    const sliceId = formatSliceId(key);
    const bucket = buckets.get(sliceId);
    if (!bucket) {
      emit(options.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "map",
        sliceId,
        failureClass: "missing_slice",
        failingSlice: sliceId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "missing_slice",
        detail:
          `registry setId=${baseline.setId} maps to sliceId=${sliceId} ` +
          `which is absent from taxonomy`,
        failingSlice: sliceId,
      };
    }
    bucket.baselines.push(baseline);
  }

  const mappings: EvalSliceMapping[] = [];
  for (const [sliceId, bucket] of [...buckets.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const pinnedSeeds = [
      ...new Set(bucket.baselines.map((b) => b.pinnedSeed)),
    ].sort((a, b) => a - b);
    mappings.push({
      sliceId,
      key: {
        domainPackId: bucket.entry.domainPackId,
        language: bucket.entry.language,
        bindingId: bucket.entry.bindingId,
      },
      emptyMarker: bucket.entry.emptyMarker,
      baselineSetIds: bucket.baselines
        .map((b) => b.setId)
        .sort((a, b) => a.localeCompare(b)),
      pinnedSeeds,
      /** Deterministic frozen evals: no floating tolerance. */
      tolerance: null,
    });
  }

  emit(options.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "map",
    entryCount: mappings.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });

  return { ok: true, mappings };
}

/**
 * Gate definition linter: every referenced slice must have ≥1 baseline row.
 * Explicit emptyMarker slices fail when referenced (never silently skipped).
 */
export function assertGateSlicesHaveBaselines(
  mappings: readonly EvalSliceMapping[],
  requiredSliceIds: readonly string[],
  options: {
    deviceId?: string;
    onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
  } = {},
):
  | { ok: true }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      sliceId: string;
      failingSlice: string;
    } {
  if (requiredSliceIds.length > EVAL_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `required slices exceed ${EVAL_SLICE_LIMIT}`,
      sliceId: "(section_limit)",
      failingSlice: "(section_limit)",
    };
  }

  const byId = new Map(mappings.map((m) => [m.sliceId, m]));
  for (const sliceId of requiredSliceIds) {
    const parsed = parseSliceId(sliceId);
    if (!parsed.ok) {
      emit(options.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "gate_lint",
        sliceId,
        failureClass: parsed.failureClass,
        failingSlice: parsed.failingSlice,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: parsed.failureClass,
        detail: parsed.detail,
        sliceId,
        failingSlice: parsed.failingSlice,
      };
    }

    const mapping = byId.get(sliceId);
    if (!mapping) {
      emit(options.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "gate_lint",
        sliceId,
        failureClass: "missing_slice",
        failingSlice: sliceId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "missing_slice",
        detail: `gate references unknown sliceId=${sliceId}`,
        sliceId,
        failingSlice: sliceId,
      };
    }

    if (mapping.baselineSetIds.length === 0) {
      emit(options.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "gate_lint",
        sliceId,
        failureClass: "empty_slice",
        failingSlice: sliceId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "empty_slice",
        detail: mapping.emptyMarker
          ? `gate references empty-marker sliceId=${sliceId} with zero baselines`
          : `gate references sliceId=${sliceId} with zero baselines`,
        sliceId,
        failingSlice: sliceId,
      };
    }

    if (mapping.pinnedSeeds.length === 0) {
      emit(options.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "gate_lint",
        sliceId,
        failureClass: "schema_violation",
        failingSlice: sliceId,
        ...(options.deviceId !== undefined
          ? { deviceId: options.deviceId }
          : {}),
      });
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `sliceId=${sliceId} baselines lack pinned seeds`,
        sliceId,
        failingSlice: sliceId,
      };
    }
  }

  emit(options.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "gate_lint",
    entryCount: requiredSliceIds.length,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Cross-slice contamination: a training shard tagged for pack A must not
 * appear as an eval for pack B.
 */
export function assertNoCrossSliceContamination(input: {
  trainingShardDomainPackId: string;
  evalSliceId: string;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}):
  | { ok: true }
  | {
      ok: false;
      failureClass: "cross_slice_contamination" | "schema_violation";
      detail: string;
      failingSlice: string;
    } {
  const parsed = parseSliceId(input.evalSliceId);
  if (!parsed.ok) {
    return {
      ok: false,
      failureClass: "schema_violation",
      detail: parsed.detail,
      failingSlice: parsed.failingSlice,
    };
  }
  if (parsed.key.domainPackId !== input.trainingShardDomainPackId) {
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "contamination_check",
      sliceId: input.evalSliceId,
      failureClass: "cross_slice_contamination",
      failingSlice: input.evalSliceId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "cross_slice_contamination",
      detail:
        `cross-slice contamination: shard domainPackId=` +
        `${input.trainingShardDomainPackId} vs eval slice ${input.evalSliceId}`,
      failingSlice: input.evalSliceId,
    };
  }
  emit(input.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "contamination_check",
    sliceId: input.evalSliceId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });
  return { ok: true };
}

/**
 * Per-slice champion/challenger scores for freeze lanes.
 * Known-good promotes; regression names failingSlice.
 */
export function evaluateSlicePromotionGate(input: {
  mappings: readonly EvalSliceMapping[];
  requiredSliceIds: readonly string[];
  championScores: Readonly<Record<string, number>>;
  challengerScores: Readonly<Record<string, number>>;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}):
  | { ok: true; verdict: "promote" }
  | {
      ok: false;
      verdict: "reject";
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice: string;
    } {
  const lint = assertGateSlicesHaveBaselines(
    input.mappings,
    input.requiredSliceIds,
    {
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (!lint.ok) {
    return {
      ok: false,
      verdict: "reject",
      failureClass: lint.failureClass,
      detail: lint.detail,
      failingSlice: lint.failingSlice,
    };
  }

  const byId = new Map(input.mappings.map((m) => [m.sliceId, m]));
  for (const sliceId of input.requiredSliceIds) {
    const champion = input.championScores[sliceId];
    const challenger = input.challengerScores[sliceId];
    const mapping = byId.get(sliceId)!;
    if (
      typeof champion !== "number" ||
      typeof challenger !== "number" ||
      !Number.isFinite(champion) ||
      !Number.isFinite(challenger) ||
      champion < 0 ||
      champion > 1 ||
      challenger < 0 ||
      challenger > 1
    ) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "promote_gate",
        sliceId,
        failureClass: "schema_violation",
        failingSlice: sliceId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        verdict: "reject",
        failureClass: "schema_violation",
        detail: `scores for sliceId=${sliceId} must be finite in [0,1]`,
        failingSlice: sliceId,
      };
    }

    const floor =
      mapping.tolerance === null
        ? champion
        : champion - mapping.tolerance;
    if (challenger + Number.EPSILON < floor) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "promote_gate",
        sliceId,
        failureClass: "slice_regression",
        failingSlice: sliceId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        verdict: "reject",
        failureClass: "slice_regression",
        detail:
          `challenger regresses on sliceId=${sliceId} ` +
          `(challenger=${challenger} < floor=${floor})`,
        failingSlice: sliceId,
      };
    }
  }

  emit(input.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "promote_gate",
    entryCount: input.requiredSliceIds.length,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });
  return { ok: true, verdict: "promote" };
}

/**
 * Convenience: load taxonomy + map registry (metadata telemetry only).
 */
export async function buildEvalSliceMapping(options: {
  repoRoot: string;
  registry: BaselineRegistryDocument;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | {
      ok: true;
      taxonomy: EvalSliceTaxonomyDocument;
      mappings: EvalSliceMapping[];
    }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice?: string;
    }
> {
  const taxonomy = await loadEvalSliceTaxonomy({
    repoRoot: options.repoRoot,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!taxonomy.ok) {
    return taxonomy;
  }
  const mapped = mapRegistryToEvalSlices(
    options.registry,
    taxonomy.document,
    {
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    },
  );
  if (!mapped.ok) {
    return mapped;
  }
  return {
    ok: true,
    taxonomy: taxonomy.document,
    mappings: mapped.mappings,
  };
}

/** Path join helper for tests (taxonomy dir under repo). */
export function evalSlicesDir(repoRoot: string): string {
  return path.join(repoRoot, "training", "eval", "slices");
}

/**
 * Mulberry32 PRNG — seed injection for stochastic eval components.
 * Callers must use this instead of Math.random.
 */
export function createPinnedSeedRng(seed: number): PinnedSeedRng {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("pinned seed must be an integer in [0, 4294967295]");
  }
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error("nextInt maxExclusive must be a positive integer");
      }
      return Math.floor(next() * maxExclusive);
    },
  };
}

/** Mix a slice/baseline salt into a pinned seed without floating entropy. */
export function mixPinnedSeed(baseSeed: number, salt: string): number {
  let h = baseSeed >>> 0;
  for (let i = 0; i < salt.length; i += 1) {
    h = Math.imul(h ^ salt.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function deriveAggregateFromSliceScores(
  scores: readonly number[],
): EvalSliceAggregate {
  if (scores.length === 0) {
    return { mean: 0, min: 0, max: 0, sliceCount: 0 };
  }
  let sum = 0;
  let min = scores[0]!;
  let max = scores[0]!;
  for (const s of scores) {
    sum += s;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return {
    mean: sum / scores.length,
    min,
    max,
    sliceCount: scores.length,
  };
}

/**
 * Build a suite report. Aggregate is always derived from slices — refusing
 * aggregate-only construction encodes the submodule invariant.
 */
export function buildEvalSliceRunReport(
  slices: readonly EvalSliceScoreResult[],
):
  | { ok: true; report: EvalSliceRunReport }
  | {
      ok: false;
      failureClass: "aggregate_only_forbidden" | "section_limit" | "schema_violation";
      detail: string;
    } {
  if (slices.length === 0) {
    return {
      ok: false,
      failureClass: "aggregate_only_forbidden",
      detail:
        "aggregate-only reports forbidden — per-slice scores are required",
    };
  }
  if (slices.length > EVAL_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `slice results exceed ${EVAL_SLICE_LIMIT}`,
    };
  }
  for (const slice of slices) {
    if (
      !Number.isFinite(slice.score) ||
      slice.score < 0 ||
      slice.score > 1
    ) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `sliceId=${slice.sliceId} score must be finite in [0,1]`,
      };
    }
  }
  const sorted = [...slices].sort((a, b) =>
    a.sliceId.localeCompare(b.sliceId),
  );
  return {
    ok: true,
    report: {
      schemaVersion: EVAL_SLICE_RUN_SCHEMA_VERSION,
      slices: sorted,
      aggregate: deriveAggregateFromSliceScores(sorted.map((s) => s.score)),
    },
  };
}

function pinnedSeedForBaseline(
  registry: BaselineRegistryDocument,
  setId: string,
): number | undefined {
  let best: BaselineRegistryEntry | undefined;
  for (const entry of registry.entries) {
    if (entry.setId !== setId) continue;
    if (!best || entry.version > best.version) best = entry;
  }
  return best?.pinnedSeed;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<
  | { ok: true; value: T }
  | { ok: false; failureClass: "timeout" | "runner_error"; detail: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.then(
    (value) => ({ kind: "ok" as const, value }),
    (err: unknown) => ({ kind: "err" as const, err }),
  );
  try {
    const raced = await Promise.race([
      guarded,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      return {
        ok: false,
        failureClass: "timeout",
        detail: `eval timed out after ${timeoutMs}ms (${label})`,
      };
    }
    if (raced.kind === "err") {
      return {
        ok: false,
        failureClass: "runner_error",
        detail: `eval failed: ${
          raced.err instanceof Error ? raced.err.message : "unknown"
        }`,
      };
    }
    return { ok: true, value: raced.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Score one frozen slice independently with pinned-seed injection.
 * Empty slices and missing seeds fail loud (never silently skipped).
 */
export async function runEvalSlice(input: {
  mapping: EvalSliceMapping;
  registry: BaselineRegistryDocument;
  scoreBaseline: SliceBaselineScoreFn;
  deviceId?: string;
  timeoutMs?: number;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | { ok: true; result: EvalSliceScoreResult }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice: string;
    }
> {
  const { mapping } = input;
  const timeoutMs = input.timeoutMs ?? EVAL_SLICE_DEFAULT_TIMEOUT_MS;

  if (mapping.emptyMarker || mapping.baselineSetIds.length === 0) {
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "run_slice",
      sliceId: mapping.sliceId,
      failureClass: "empty_slice",
      failingSlice: mapping.sliceId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "empty_slice",
      detail: `cannot run empty sliceId=${mapping.sliceId}`,
      failingSlice: mapping.sliceId,
    };
  }

  if (mapping.baselineSetIds.length > EVAL_SLICE_MAX_BASELINES_PER_SLICE) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `baselines in slice exceed ${EVAL_SLICE_MAX_BASELINES_PER_SLICE}`,
      failingSlice: mapping.sliceId,
    };
  }

  const baselineScores: EvalSliceBaselineScore[] = [];
  const usedSeeds: number[] = [];

  for (const setId of mapping.baselineSetIds) {
    const pinnedSeed = pinnedSeedForBaseline(input.registry, setId);
    if (pinnedSeed === undefined) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "seed_inject",
        sliceId: mapping.sliceId,
        failureClass: "seed_missing",
        failingSlice: mapping.sliceId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: "seed_missing",
        detail: `no pinned seed for setId=${setId} in slice ${mapping.sliceId}`,
        failingSlice: mapping.sliceId,
      };
    }

    const mixed = mixPinnedSeed(pinnedSeed, `${mapping.sliceId}:${setId}`);
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "ok",
      subjectId: null,
      action: "seed_inject",
      sliceId: mapping.sliceId,
      pinnedSeed: mixed,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });

    let rng: PinnedSeedRng;
    try {
      rng = createPinnedSeedRng(mixed);
    } catch (err) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: err instanceof Error ? err.message : "invalid pinned seed",
        failingSlice: mapping.sliceId,
      };
    }

    const scored = await withTimeout(
      input.scoreBaseline({
        sliceId: mapping.sliceId,
        setId,
        pinnedSeed: mixed,
        rng,
        subjectId: null,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      }),
      timeoutMs,
      `slice=${mapping.sliceId} setId=${setId}`,
    );

    if (!scored.ok) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "run_slice",
        sliceId: mapping.sliceId,
        failureClass: scored.failureClass,
        failingSlice: mapping.sliceId,
        pinnedSeed: mixed,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: scored.failureClass,
        detail: scored.detail,
        failingSlice: mapping.sliceId,
      };
    }

    if (!scored.value.ok) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "run_slice",
        sliceId: mapping.sliceId,
        failureClass: scored.value.failureClass,
        failingSlice: mapping.sliceId,
        pinnedSeed: mixed,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: scored.value.failureClass,
        detail: scored.value.detail,
        failingSlice: mapping.sliceId,
      };
    }

    const score = scored.value.score;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `setId=${setId} score must be finite in [0,1]`,
        failingSlice: mapping.sliceId,
      };
    }

    usedSeeds.push(mixed);
    baselineScores.push({ setId, score, pinnedSeed: mixed });
  }

  const sliceScore =
    baselineScores.reduce((acc, b) => acc + b.score, 0) /
    baselineScores.length;

  const result: EvalSliceScoreResult = {
    sliceId: mapping.sliceId,
    score: sliceScore,
    pinnedSeeds: [...new Set(usedSeeds)].sort((a, b) => a - b),
    baselineScores: [...baselineScores].sort((a, b) =>
      a.setId.localeCompare(b.setId),
    ),
    tolerance: mapping.tolerance,
  };

  emit(input.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "run_slice",
    sliceId: mapping.sliceId,
    entryCount: baselineScores.length,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });

  return { ok: true, result };
}

/**
 * Run each requested slice independently; aggregate is derived from per-slice
 * scores and is never the sole metric on the report.
 */
export async function runEvalSliceSuite(input: {
  mappings: readonly EvalSliceMapping[];
  registry: BaselineRegistryDocument;
  sliceIds: readonly string[];
  scoreBaseline: SliceBaselineScoreFn;
  deviceId?: string;
  timeoutMs?: number;
  /**
   * Optional training-shard pack for contamination check before scoring.
   * When set, every eval slice must share this domainPackId.
   */
  trainingShardDomainPackId?: string;
  /** More than one → attribution void (unattributable candidate). */
  surgeryClasses?: readonly string[];
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | { ok: true; report: EvalSliceRunReport }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice: string;
      /** Slices completed before the failure (partial observability). */
      partialSlices?: EvalSliceScoreResult[];
    }
> {
  if (input.surgeryClasses !== undefined && input.surgeryClasses.length > 1) {
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "run_suite",
      failureClass: "schema_violation",
      failingSlice: input.surgeryClasses.join("+"),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "schema_violation",
      detail:
        "one surgery type per stage — candidate touches multiple component classes",
      failingSlice: input.surgeryClasses.join("+"),
    };
  }

  const lint = assertGateSlicesHaveBaselines(
    input.mappings,
    input.sliceIds,
    {
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    },
  );
  if (!lint.ok) {
    return {
      ok: false,
      failureClass: lint.failureClass,
      detail: lint.detail,
      failingSlice: lint.failingSlice,
    };
  }

  if (input.trainingShardDomainPackId !== undefined) {
    for (const sliceId of input.sliceIds) {
      const check = assertNoCrossSliceContamination({
        trainingShardDomainPackId: input.trainingShardDomainPackId,
        evalSliceId: sliceId,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.onTelemetry !== undefined
          ? { onTelemetry: input.onTelemetry }
          : {}),
      });
      if (!check.ok) {
        return {
          ok: false,
          failureClass: check.failureClass,
          detail: check.detail,
          failingSlice: check.failingSlice,
        };
      }
    }
  }

  const byId = new Map(input.mappings.map((m) => [m.sliceId, m]));
  const completed: EvalSliceScoreResult[] = [];

  for (const sliceId of input.sliceIds) {
    const mapping = byId.get(sliceId);
    if (!mapping) {
      return {
        ok: false,
        failureClass: "missing_slice",
        detail: `unknown sliceId=${sliceId}`,
        failingSlice: sliceId,
        partialSlices: completed,
      };
    }
    const ran = await runEvalSlice({
      mapping,
      registry: input.registry,
      scoreBaseline: input.scoreBaseline,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.onTelemetry !== undefined
        ? { onTelemetry: input.onTelemetry }
        : {}),
    });
    if (!ran.ok) {
      emit(input.onTelemetry, {
        event: "learning.eval_slices",
        outcome: "rejected",
        subjectId: null,
        action: "run_suite",
        sliceId: ran.failingSlice,
        failureClass: ran.failureClass,
        failingSlice: ran.failingSlice,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      });
      return {
        ok: false,
        failureClass: ran.failureClass,
        detail: ran.detail,
        failingSlice: ran.failingSlice,
        partialSlices: completed,
      };
    }
    completed.push(ran.result);
  }

  const built = buildEvalSliceRunReport(completed);
  if (!built.ok) {
    return {
      ok: false,
      failureClass: built.failureClass,
      detail: built.detail,
      failingSlice: "(report)",
      partialSlices: completed,
    };
  }

  emit(input.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "run_suite",
    entryCount: built.report.slices.length,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });

  return { ok: true, report: built.report };
}

/**
 * Deterministic fixture scorer for gates/tests — uses only the injected RNG
 * (never Math.random). Optional rubric overrides per setId.
 */
export function createDeterministicSliceScorer(options: {
  /** setId → base score before tiny seeded jitter within tolerance. */
  rubric?: Readonly<Record<string, number>>;
  /** When set, apply seeded jitter in ±tolerance (declared non-determinism). */
  tolerance?: number;
} = {}): SliceBaselineScoreFn {
  const rubric = options.rubric ?? {};
  const tolerance = options.tolerance;
  return async (input) => {
    const base =
      typeof rubric[input.setId] === "number" ? rubric[input.setId]! : 1;
    if (!Number.isFinite(base) || base < 0 || base > 1) {
      return {
        ok: false,
        failureClass: "schema_violation",
        detail: `rubric score for setId=${input.setId} must be in [0,1]`,
      };
    }
    if (tolerance === undefined || tolerance === 0) {
      // Consume one RNG draw so seed injection is observable / idempotent.
      input.rng.next();
      return { ok: true, score: base };
    }
    const jitter = (input.rng.next() * 2 - 1) * tolerance;
    const score = Math.min(1, Math.max(0, base + jitter));
    return { ok: true, score };
  };
}

/**
 * Run champion + challenger scorers per slice then apply the promote gate.
 * Aggregate alone never decides — failingSlice is always a per-slice id.
 */
export async function runSliceChampionChallengerGate(input: {
  mappings: readonly EvalSliceMapping[];
  registry: BaselineRegistryDocument;
  sliceIds: readonly string[];
  scoreChampion: SliceBaselineScoreFn;
  scoreChallenger: SliceBaselineScoreFn;
  deviceId?: string;
  timeoutMs?: number;
  surgeryClasses?: readonly string[];
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | {
      ok: true;
      verdict: "promote";
      champion: EvalSliceRunReport;
      challenger: EvalSliceRunReport;
    }
  | {
      ok: false;
      verdict: "reject";
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice: string;
      champion?: EvalSliceRunReport;
      challenger?: EvalSliceRunReport;
    }
> {
  const championRun = await runEvalSliceSuite({
    mappings: input.mappings,
    registry: input.registry,
    sliceIds: input.sliceIds,
    scoreBaseline: input.scoreChampion,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.surgeryClasses !== undefined
      ? { surgeryClasses: input.surgeryClasses }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!championRun.ok) {
    return {
      ok: false,
      verdict: "reject",
      failureClass: championRun.failureClass,
      detail: championRun.detail,
      failingSlice: championRun.failingSlice,
    };
  }

  const challengerRun = await runEvalSliceSuite({
    mappings: input.mappings,
    registry: input.registry,
    sliceIds: input.sliceIds,
    scoreBaseline: input.scoreChallenger,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.surgeryClasses !== undefined
      ? { surgeryClasses: input.surgeryClasses }
      : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!challengerRun.ok) {
    return {
      ok: false,
      verdict: "reject",
      failureClass: challengerRun.failureClass,
      detail: challengerRun.detail,
      failingSlice: challengerRun.failingSlice,
      champion: championRun.report,
    };
  }

  const championScores = Object.fromEntries(
    championRun.report.slices.map((s) => [s.sliceId, s.score]),
  );
  const challengerScores = Object.fromEntries(
    challengerRun.report.slices.map((s) => [s.sliceId, s.score]),
  );

  const gate = evaluateSlicePromotionGate({
    mappings: input.mappings,
    requiredSliceIds: input.sliceIds,
    championScores,
    challengerScores,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });

  if (!gate.ok) {
    return {
      ok: false,
      verdict: "reject",
      failureClass: gate.failureClass,
      detail: gate.detail,
      failingSlice: gate.failingSlice,
      champion: championRun.report,
      challenger: challengerRun.report,
    };
  }

  return {
    ok: true,
    verdict: "promote",
    champion: championRun.report,
    challenger: challengerRun.report,
  };
}

function latestRegistryEntries(
  registry: BaselineRegistryDocument,
): BaselineRegistryEntry[] {
  const best = new Map<string, BaselineRegistryEntry>();
  for (const entry of registry.entries) {
    const prior = best.get(entry.setId);
    if (!prior || entry.version > prior.version) {
      best.set(entry.setId, entry);
    }
  }
  return [...best.values()];
}

function buildCoverageReport(input: {
  mappings: readonly EvalSliceMapping[];
  registry: BaselineRegistryDocument;
}): EvalSliceCoverageReport {
  const coveredSliceIds: string[] = [];
  const missingSliceIds: string[] = [];
  const emptyMarkerSliceIds: string[] = [];

  for (const mapping of input.mappings) {
    if (mapping.emptyMarker) {
      emptyMarkerSliceIds.push(mapping.sliceId);
      // Explicit empty marker — never silently skipped, but not a coverage miss
      // unless it somehow acquired baselines for a registry-backed pack below.
      if (
        mapping.baselineSetIds.length === 0 &&
        mapping.pinnedSeeds.length === 0
      ) {
        continue;
      }
    }
    if (
      mapping.baselineSetIds.length === 0 ||
      mapping.pinnedSeeds.length === 0
    ) {
      if (!missingSliceIds.includes(mapping.sliceId)) {
        missingSliceIds.push(mapping.sliceId);
      }
    } else if (!mapping.emptyMarker) {
      coveredSliceIds.push(mapping.sliceId);
    }
  }

  const registryDomainPackIds = [
    ...new Set(
      latestRegistryEntries(input.registry).map(
        (e) => e.sliceTags.domainPack,
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const registryBindingIds = [
    ...new Set(
      latestRegistryEntries(input.registry).map((e) => e.sliceTags.binding),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const coveredPacks = new Set(
    input.mappings
      .filter((m) => m.baselineSetIds.length > 0 && m.pinnedSeeds.length > 0)
      .map((m) => m.key.domainPackId),
  );
  const coveredBindings = new Set(
    input.mappings
      .filter((m) => m.baselineSetIds.length > 0 && m.pinnedSeeds.length > 0)
      .map((m) => m.key.bindingId),
  );

  const uncoveredDomainPackIds = registryDomainPackIds.filter(
    (p) => !coveredPacks.has(p),
  );
  const uncoveredBindingIds = registryBindingIds.filter(
    (b) => !coveredBindings.has(b),
  );

  for (const pack of uncoveredDomainPackIds) {
    for (const mapping of input.mappings) {
      if (
        mapping.key.domainPackId === pack &&
        !missingSliceIds.includes(mapping.sliceId)
      ) {
        missingSliceIds.push(mapping.sliceId);
      }
    }
  }
  for (const binding of uncoveredBindingIds) {
    for (const mapping of input.mappings) {
      if (
        mapping.key.bindingId === binding &&
        !missingSliceIds.includes(mapping.sliceId)
      ) {
        missingSliceIds.push(mapping.sliceId);
      }
    }
  }

  coveredSliceIds.sort((a, b) => a.localeCompare(b));
  missingSliceIds.sort((a, b) => a.localeCompare(b));
  emptyMarkerSliceIds.sort((a, b) => a.localeCompare(b));

  return {
    schemaVersion: EVAL_SLICE_COVERAGE_SCHEMA_VERSION,
    coveredSliceIds,
    missingSliceIds,
    emptyMarkerSliceIds,
    registryDomainPackIds,
    registryBindingIds,
    uncoveredDomainPackIds,
    uncoveredBindingIds,
  };
}

/**
 * CI gate: every registered domain pack / binding must have a frozen slice
 * with ≥1 baseline row and pinned seeds. Missing slices are listed by name.
 * Empty-marker slices remain visible but do not satisfy registry coverage.
 */
export function assertEvalSliceCoverageComplete(input: {
  registry: BaselineRegistryDocument;
  taxonomy: EvalSliceTaxonomyDocument;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}):
  | { ok: true; report: EvalSliceCoverageReport }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice: string;
      missingSliceIds: string[];
      report: EvalSliceCoverageReport;
    } {
  const mapped = mapRegistryToEvalSlices(input.registry, input.taxonomy, {
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
  });
  if (!mapped.ok) {
    const missingSliceIds = mapped.failingSlice
      ? [mapped.failingSlice]
      : [];
    const emptyReport: EvalSliceCoverageReport = {
      schemaVersion: EVAL_SLICE_COVERAGE_SCHEMA_VERSION,
      coveredSliceIds: [],
      missingSliceIds,
      emptyMarkerSliceIds: [],
      registryDomainPackIds: [],
      registryBindingIds: [],
      uncoveredDomainPackIds: [],
      uncoveredBindingIds: [],
    };
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "coverage_check",
      failureClass: mapped.failureClass,
      failingSlice: mapped.failingSlice ?? "(map)",
      missingSliceIds,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: mapped.failureClass,
      detail: mapped.detail,
      failingSlice: mapped.failingSlice ?? "(map)",
      missingSliceIds,
      report: emptyReport,
    };
  }

  if (mapped.mappings.length > EVAL_SLICE_LIMIT) {
    return {
      ok: false,
      failureClass: "section_limit",
      detail: `mappings exceed ${EVAL_SLICE_LIMIT}`,
      failingSlice: "(section_limit)",
      missingSliceIds: [],
      report: buildCoverageReport({
        mappings: mapped.mappings,
        registry: input.registry,
      }),
    };
  }

  const report = buildCoverageReport({
    mappings: mapped.mappings,
    registry: input.registry,
  });

  if (
    report.missingSliceIds.length > 0 ||
    report.uncoveredDomainPackIds.length > 0 ||
    report.uncoveredBindingIds.length > 0
  ) {
    const failingSlice = report.missingSliceIds[0] ??
      report.uncoveredDomainPackIds[0] ??
      report.uncoveredBindingIds[0] ??
      "(coverage)";
    emit(input.onTelemetry, {
      event: "learning.eval_slices",
      outcome: "rejected",
      subjectId: null,
      action: "coverage_check",
      failureClass: "coverage_incomplete",
      failingSlice,
      missingSliceIds: report.missingSliceIds.slice(0, EVAL_SLICE_LIMIT),
      entryCount: report.missingSliceIds.length,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    });
    return {
      ok: false,
      failureClass: "coverage_incomplete",
      detail:
        `slice coverage incomplete — missing=[${report.missingSliceIds.join(",")}] ` +
        `uncoveredPacks=[${report.uncoveredDomainPackIds.join(",")}] ` +
        `uncoveredBindings=[${report.uncoveredBindingIds.join(",")}]`,
      failingSlice,
      missingSliceIds: report.missingSliceIds,
      report,
    };
  }

  emit(input.onTelemetry, {
    event: "learning.eval_slices",
    outcome: "ok",
    subjectId: null,
    action: "coverage_check",
    entryCount: report.coveredSliceIds.length,
    missingSliceIds: [],
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
  });

  return { ok: true, report };
}

/**
 * Load registry + taxonomy and assert CI slice coverage completeness.
 */
export async function loadAndAssertEvalSliceCoverage(options: {
  repoRoot: string;
  deviceId?: string;
  onTelemetry?: (e: EvalSliceTelemetryEvent) => void;
}): Promise<
  | { ok: true; report: EvalSliceCoverageReport }
  | {
      ok: false;
      failureClass: EvalSliceFailureClass;
      detail: string;
      failingSlice?: string;
      missingSliceIds?: string[];
      report?: EvalSliceCoverageReport;
    }
> {
  const registry = await loadBaselineRegistry({
    repoRoot: options.repoRoot,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
  });
  if (!registry.ok) {
    const failureClass: EvalSliceFailureClass =
      registry.failureClass === "path_escape" ||
      registry.failureClass === "source_missing" ||
      registry.failureClass === "schema_violation" ||
      registry.failureClass === "section_limit"
        ? registry.failureClass
        : "schema_violation";
    return {
      ok: false,
      failureClass,
      detail: registry.detail,
      ...(registry.failingSlice !== undefined
        ? { failingSlice: registry.failingSlice }
        : {}),
    };
  }

  const taxonomy = await loadEvalSliceTaxonomy({
    repoRoot: options.repoRoot,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  if (!taxonomy.ok) {
    return taxonomy;
  }

  return assertEvalSliceCoverageComplete({
    registry: registry.document,
    taxonomy: taxonomy.document,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}
