/**
 * Held-out human label calibration set + agreement metrics + promotion gate (C3).
 *
 * Curates trajectories with C0 human_outcome_signal, slice tags, and registered
 * content hashes. Sets are excluded from C1 training corpora and decontaminated
 * against baseline / calibration hashes (train-on-eval is void).
 *
 * Agreement: Cohen's kappa (default) or accuracy on accept/reject, with
 * per-slice breakdown and named failing slices.
 *
 * Promotion gate: critic versions enter training config only when agreement ≥
 * the declared per-version threshold on the held-out set.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  HUMAN_OUTCOME_SIGNALS,
  type HumanOutcomeSignal,
} from "../outcome_signal.js";
import {
  createCriticScore,
  type CriticScore,
  type TrajectoryCritic,
} from "./interface.js";
import { createCoreRubricCritic } from "./core_rubric.js";

export const CALIBRATION_SET_SCHEMA_VERSION =
  "critic.calibration-set.v1" as const;

/** Repo-relative root for held-out human label calibration sets. */
export const CALIBRATION_SETS_RELPATH =
  "training/eval/calibration_sets" as const;

export const CALIBRATION_SET_ENTRY_LIMIT = 256;
export const CALIBRATION_SET_ID_LIMIT = 128;
export const CALIBRATION_SLICE_TAG_LIMIT = 64;

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "contentHash must be sha256:<64 hex>");

const sliceTagsSchema = z
  .object({
    domainPack: z.string().min(1).max(CALIBRATION_SLICE_TAG_LIMIT),
    language: z.string().min(1).max(CALIBRATION_SLICE_TAG_LIMIT),
    binding: z.string().min(1).max(CALIBRATION_SLICE_TAG_LIMIT),
  })
  .strict();

export const calibrationSetEntrySchema = z
  .object({
    id: z.string().min(1).max(CALIBRATION_SET_ID_LIMIT),
    file: z.string().min(1).max(256),
    contentHash: contentHashSchema,
    sliceTags: sliceTagsSchema,
    humanOutcomeSignal: z.enum(HUMAN_OUTCOME_SIGNALS),
    locality: z.enum(["on-device", "self-hosted"]),
  })
  .strict();

export const calibrationSetManifestSchema = z
  .object({
    schemaVersion: z.literal(CALIBRATION_SET_SCHEMA_VERSION),
    setId: z.string().min(1).max(CALIBRATION_SET_ID_LIMIT),
    heldOut: z.literal(true),
    excludeFromTrainingCorpora: z.literal(true),
    pinnedSeed: z.number().int().min(0).max(0xffff_ffff),
    defaultAgreementThreshold: z.number().min(0).max(1),
    locality: z.enum(["on-device", "self-hosted"]),
    entries: z
      .array(calibrationSetEntrySchema)
      .min(1)
      .max(CALIBRATION_SET_ENTRY_LIMIT),
  })
  .strict();

export type CalibrationSliceTags = z.infer<typeof sliceTagsSchema>;
export type CalibrationSetEntry = z.infer<typeof calibrationSetEntrySchema>;
export type CalibrationSetManifest = z.infer<
  typeof calibrationSetManifestSchema
>;

export type CalibrationFailureClass =
  | "calibration.schema_violation"
  | "calibration.hash_mismatch"
  | "calibration.source_missing"
  | "calibration.label_mismatch"
  | "calibration.train_on_eval_void"
  | "calibration.missing_subject"
  | "calibration.section_limit"
  | "calibration.not_held_out"
  | "calibration.agreement_below_threshold"
  | "calibration.insufficient_pairs"
  | "calibration.missing_prediction"
  | "calibration.promotion_rejected"
  | "calibration.training_config_blocked"
  | "calibration.attribution_void";

/** Declared agreement metrics — Cohen kappa is the default gate metric. */
export const CALIBRATION_AGREEMENT_METRICS = Object.freeze([
  "cohen_kappa",
  "accuracy",
] as const);

export type CalibrationAgreementMetricId =
  (typeof CALIBRATION_AGREEMENT_METRICS)[number];

/** Binary accept/reject used for critic–human agreement (DISCARDED excluded). */
export type BinaryCalibrationLabel = "accept" | "reject";

export type CalibrationTelemetryEvent = {
  event:
    | "learning.critic.calibration_set"
    | "learning.critic.calibration_agreement"
    | "learning.critic.calibration_promotion";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  setId?: string;
  entryId?: string;
  sliceId?: string;
  contentHash?: string;
  failureClass?: CalibrationFailureClass;
  entryCount?: number;
  metricId?: CalibrationAgreementMetricId;
  metricValue?: number;
  threshold?: number;
  failingSliceCount?: number;
  criticId?: string;
  criticVersion?: string;
  verdict?: "promote" | "reject";
  trainingConfigAllowed?: boolean;
};

export class CalibrationContractError extends Error {
  readonly obligation: CalibrationFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CalibrationFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "CalibrationContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

/** Slash-form slice id for gate reports (never raw content). */
export function calibrationSliceId(tags: CalibrationSliceTags): string {
  return `${tags.domainPack}/${tags.language}/${tags.binding}`;
}

export function computeCalibrationContentHash(
  bytes: Buffer | Uint8Array | string,
): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/learning/src/critics → repo root
  return path.resolve(here, "..", "..", "..", "..");
}

/**
 * Parse a calibration-set manifest object.
 */
export function parseCalibrationSetManifest(
  raw: unknown,
): CalibrationSetManifest {
  const parsed = calibrationSetManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CalibrationContractError(
      `calibration manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      { obligation: "calibration.schema_violation" },
    );
  }
  const doc = parsed.data;
  if (!doc.heldOut || !doc.excludeFromTrainingCorpora) {
    throw new CalibrationContractError(
      "calibration set must be heldOut and excludeFromTrainingCorpora",
      { obligation: "calibration.not_held_out", subjectId: "calibration-set" },
    );
  }
  const ids = new Set<string>();
  for (const e of doc.entries) {
    if (ids.has(e.id)) {
      throw new CalibrationContractError(`duplicate calibration entry ${e.id}`, {
        obligation: "calibration.schema_violation",
        failingSlice: calibrationSliceId(e.sliceTags),
      });
    }
    ids.add(e.id);
  }
  return doc;
}

export type LoadedCalibrationEntry = CalibrationSetEntry & {
  sliceId: string;
  /** Trajectory JSON — structured metadata only (may include humanOutcomeSignal). */
  trajectory: Record<string, unknown>;
  absolutePath: string;
};

export type LoadedCalibrationSet = {
  manifest: CalibrationSetManifest;
  entries: LoadedCalibrationEntry[];
  /** Registered content hashes (sorted, unique) for C1 decontam. */
  contentHashes: string[];
};

/**
 * Load + verify the held-out calibration set (hashes, labels, held-out flags).
 */
export function loadCalibrationSet(opts?: {
  repoRoot?: string;
  relPath?: string;
  onTelemetry?: (e: CalibrationTelemetryEvent) => void;
}): LoadedCalibrationSet {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const rel =
    opts?.relPath ?? path.join(CALIBRATION_SETS_RELPATH, "manifest.json");
  const absManifest = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const setDir = path.dirname(absManifest);

  let text: string;
  try {
    text = readFileSync(absManifest, "utf8");
  } catch {
    opts?.onTelemetry?.({
      event: "learning.critic.calibration_set",
      outcome: "fail",
      subjectId: "calibration-set",
      deviceId: "ci",
      failureClass: "calibration.source_missing",
    });
    throw new CalibrationContractError(
      `calibration manifest missing: ${rel}`,
      { obligation: "calibration.source_missing" },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CalibrationContractError("calibration manifest not JSON", {
      obligation: "calibration.schema_violation",
    });
  }

  const manifest = parseCalibrationSetManifest(json);
  const entries: LoadedCalibrationEntry[] = [];
  const hashes = new Set<string>();

  for (const entry of manifest.entries) {
    const sliceId = calibrationSliceId(entry.sliceTags);
    const abs = path.join(setDir, entry.file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      opts?.onTelemetry?.({
        event: "learning.critic.calibration_set",
        outcome: "fail",
        subjectId: "calibration-set",
        deviceId: "ci",
        setId: manifest.setId,
        entryId: entry.id,
        sliceId,
        failureClass: "calibration.source_missing",
      });
      throw new CalibrationContractError(
        `calibration entry missing: ${entry.file}`,
        {
          obligation: "calibration.source_missing",
          failingSlice: sliceId,
        },
      );
    }

    const actual = computeCalibrationContentHash(bytes);
    if (actual !== entry.contentHash) {
      opts?.onTelemetry?.({
        event: "learning.critic.calibration_set",
        outcome: "fail",
        subjectId: "calibration-set",
        deviceId: "ci",
        setId: manifest.setId,
        entryId: entry.id,
        sliceId,
        contentHash: actual,
        failureClass: "calibration.hash_mismatch",
      });
      throw new CalibrationContractError(
        `contentHash mismatch for ${entry.id}`,
        {
          obligation: "calibration.hash_mismatch",
          failingSlice: sliceId,
        },
      );
    }

    let trajectory: Record<string, unknown>;
    try {
      trajectory = JSON.parse(bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      throw new CalibrationContractError(
        `calibration entry not JSON: ${entry.id}`,
        {
          obligation: "calibration.schema_violation",
          failingSlice: sliceId,
        },
      );
    }

    if (
      typeof trajectory.subjectId !== "string" ||
      trajectory.subjectId.length === 0
    ) {
      throw new CalibrationContractError(
        `subjectId required on calibration entry ${entry.id}`,
        {
          obligation: "calibration.missing_subject",
          failingSlice: sliceId,
        },
      );
    }

    const label = trajectory.humanOutcomeSignal;
    if (label !== entry.humanOutcomeSignal) {
      opts?.onTelemetry?.({
        event: "learning.critic.calibration_set",
        outcome: "fail",
        subjectId: trajectory.subjectId,
        deviceId:
          typeof trajectory.deviceId === "string"
            ? trajectory.deviceId
            : "ci",
        setId: manifest.setId,
        entryId: entry.id,
        sliceId,
        failureClass: "calibration.label_mismatch",
      });
      throw new CalibrationContractError(
        `humanOutcomeSignal mismatch for ${entry.id}: file=${String(label)} manifest=${entry.humanOutcomeSignal}`,
        {
          obligation: "calibration.label_mismatch",
          subjectId: trajectory.subjectId,
          failingSlice: sliceId,
        },
      );
    }

    // Sovereignty: never allow raw utterance / keystroke bodies in held-out set.
    for (const forbidden of [
      "utterance",
      "keystrokes",
      "rawKeystrokes",
      "prompt",
      "completion",
      "reply",
    ]) {
      if (forbidden in trajectory) {
        throw new CalibrationContractError(
          `forbidden content key '${forbidden}' in ${entry.id}`,
          {
            obligation: "calibration.schema_violation",
            failingSlice: sliceId,
          },
        );
      }
    }

    hashes.add(entry.contentHash);
    entries.push({
      ...entry,
      sliceId,
      trajectory,
      absolutePath: abs,
    });
  }

  const contentHashes = [...hashes].sort();
  opts?.onTelemetry?.({
    event: "learning.critic.calibration_set",
    outcome: "ok",
    subjectId: "calibration-set",
    deviceId: "ci",
    setId: manifest.setId,
    entryCount: entries.length,
  });

  return { manifest, entries, contentHashes };
}

/**
 * Export registered calibration hashes for C1 corpus exclusion / decontam.
 */
export function exportCalibrationContentHashes(
  set: LoadedCalibrationSet,
): {
  schemaVersion: "critic.calibration-hash-export.v1";
  purpose: "corpus_decontamination_and_critic_calibration";
  setId: string;
  heldOut: true;
  excludeFromTrainingCorpora: true;
  contentHashes: string[];
  entries: Array<{
    id: string;
    contentHash: string;
    sliceId: string;
    humanOutcomeSignal: HumanOutcomeSignal;
  }>;
} {
  return {
    schemaVersion: "critic.calibration-hash-export.v1",
    purpose: "corpus_decontamination_and_critic_calibration",
    setId: set.manifest.setId,
    heldOut: true,
    excludeFromTrainingCorpora: true,
    contentHashes: set.contentHashes,
    entries: set.entries.map((e) => ({
      id: e.id,
      contentHash: e.contentHash,
      sliceId: e.sliceId,
      humanOutcomeSignal: e.humanOutcomeSignal,
    })),
  };
}

export type CorpusHashCandidate = {
  docId: string;
  contentHash: string;
};

/**
 * Assert a C1 corpus does not contain any calibration (held-out) content hash.
 * Collision → train_on_eval_void with failingSlice named.
 */
export function assertCorpusExcludedFromCalibrationSet(
  set: LoadedCalibrationSet,
  corpusDocuments: readonly CorpusHashCandidate[],
  opts?: {
    deviceId?: string;
    onTelemetry?: (e: CalibrationTelemetryEvent) => void;
  },
): { ok: true; checkedHashCount: number } {
  if (corpusDocuments.length > CALIBRATION_SET_ENTRY_LIMIT * 4) {
    throw new CalibrationContractError(
      `corpus document list exceeds soft cap`,
      { obligation: "calibration.section_limit" },
    );
  }
  const indexed = new Set(set.contentHashes);
  const hashToSlice = new Map(
    set.entries.map((e) => [e.contentHash, e.sliceId] as const),
  );

  for (const doc of corpusDocuments) {
    if (!/^sha256:[a-f0-9]{64}$/.test(doc.contentHash)) {
      throw new CalibrationContractError(
        `corpus contentHash must be sha256:<64 hex> (${doc.docId})`,
        { obligation: "calibration.schema_violation" },
      );
    }
    if (indexed.has(doc.contentHash)) {
      const failingSlice = hashToSlice.get(doc.contentHash) ?? "(unknown)";
      opts?.onTelemetry?.({
        event: "learning.critic.calibration_set",
        outcome: "fail",
        subjectId: "calibration-set",
        deviceId: opts.deviceId ?? "ci",
        setId: set.manifest.setId,
        sliceId: failingSlice,
        contentHash: doc.contentHash,
        failureClass: "calibration.train_on_eval_void",
      });
      throw new CalibrationContractError(
        `corpus doc ${doc.docId} collides with held-out calibration hash`,
        {
          obligation: "calibration.train_on_eval_void",
          failingSlice,
        },
      );
    }
  }

  opts?.onTelemetry?.({
    event: "learning.critic.calibration_set",
    outcome: "ok",
    subjectId: "calibration-set",
    deviceId: opts?.deviceId ?? "ci",
    setId: set.manifest.setId,
    entryCount: corpusDocuments.length,
  });
  return { ok: true, checkedHashCount: corpusDocuments.length };
}

/**
 * Assert calibration hashes do not collide with registered baseline eval hashes
 * (decontamination against C0 baselines).
 */
export function assertCalibrationDecontaminatedAgainstBaselines(
  set: LoadedCalibrationSet,
  baselineContentHashes: readonly string[],
  opts?: {
    onTelemetry?: (e: CalibrationTelemetryEvent) => void;
  },
): { ok: true } {
  const baseline = new Set(baselineContentHashes);
  for (const entry of set.entries) {
    if (baseline.has(entry.contentHash)) {
      opts?.onTelemetry?.({
        event: "learning.critic.calibration_set",
        outcome: "fail",
        subjectId: "calibration-set",
        deviceId: "ci",
        setId: set.manifest.setId,
        entryId: entry.id,
        sliceId: entry.sliceId,
        contentHash: entry.contentHash,
        failureClass: "calibration.train_on_eval_void",
      });
      throw new CalibrationContractError(
        `calibration entry ${entry.id} collides with C0 baseline hash`,
        {
          obligation: "calibration.train_on_eval_void",
          failingSlice: entry.sliceId,
        },
      );
    }
  }
  return { ok: true };
}

/**
 * List unique slice ids present in the set (sorted) — for gate reporting.
 */
export function listCalibrationSliceIds(
  set: LoadedCalibrationSet,
): readonly string[] {
  return [...new Set(set.entries.map((e) => e.sliceId))].sort();
}

/**
 * Map C0 human_outcome_signal → binary accept/reject for agreement.
 * DISCARDED is excluded (null) — accept/reject kappa only.
 */
export function humanOutcomeToBinaryLabel(
  signal: HumanOutcomeSignal,
): BinaryCalibrationLabel | null {
  if (signal === "ACCEPTED") return "accept";
  if (signal === "REJECTED") return "reject";
  return null;
}

/**
 * Declared critic→binary mapping: total > 0 → accept, else reject.
 */
export function criticScoreToBinaryLabel(
  score: Pick<CriticScore, "total"> | number,
): BinaryCalibrationLabel {
  const total = typeof score === "number" ? score : score.total;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new CalibrationContractError(
      "critic score total must be a finite number",
      { obligation: "calibration.schema_violation" },
    );
  }
  return total > 0 ? "accept" : "reject";
}

/**
 * Strip human_outcome_signal before scoring so agreement measures structural
 * critic alignment (not tautological reuse of the label inside the rubric).
 */
export function stripHumanOutcomeForCalibrationScoring(
  trajectory: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...trajectory };
  delete next.humanOutcomeSignal;
  return next;
}

export type AgreementPair = {
  entryId: string;
  sliceId: string;
  subjectId: string;
  human: BinaryCalibrationLabel;
  critic: BinaryCalibrationLabel;
};

export type Contingency2x2 = {
  /** human accept, critic accept */
  aa: number;
  /** human accept, critic reject */
  ar: number;
  /** human reject, critic accept */
  ra: number;
  /** human reject, critic reject */
  rr: number;
};

export type AgreementMetricResult = {
  n: number;
  accuracy: number;
  kappa: number;
  contingency: Contingency2x2;
};

/**
 * Cohen's kappa + accuracy on binary accept/reject pairs.
 * When chance agreement pe === 1: kappa is 1 if perfect, else 0.
 */
export function computeCohenKappa(
  pairs: readonly Pick<AgreementPair, "human" | "critic">[],
): AgreementMetricResult {
  if (pairs.length === 0) {
    throw new CalibrationContractError(
      "cohen kappa requires at least one accept/reject pair",
      { obligation: "calibration.insufficient_pairs" },
    );
  }
  if (pairs.length > CALIBRATION_SET_ENTRY_LIMIT) {
    throw new CalibrationContractError(
      "agreement pair list exceeds calibration entry cap",
      { obligation: "calibration.section_limit" },
    );
  }

  const contingency: Contingency2x2 = { aa: 0, ar: 0, ra: 0, rr: 0 };
  for (const p of pairs) {
    if (p.human === "accept" && p.critic === "accept") contingency.aa += 1;
    else if (p.human === "accept" && p.critic === "reject") contingency.ar += 1;
    else if (p.human === "reject" && p.critic === "accept") contingency.ra += 1;
    else contingency.rr += 1;
  }

  const n = pairs.length;
  const agree = contingency.aa + contingency.rr;
  const accuracy = agree / n;
  const po = accuracy;
  const humanAccept = contingency.aa + contingency.ar;
  const humanReject = contingency.ra + contingency.rr;
  const criticAccept = contingency.aa + contingency.ra;
  const criticReject = contingency.ar + contingency.rr;
  const pe =
    (humanAccept / n) * (criticAccept / n) +
    (humanReject / n) * (criticReject / n);

  let kappa: number;
  if (pe >= 1) {
    kappa = po >= 1 ? 1 : 0;
  } else {
    kappa = (po - pe) / (1 - pe);
  }

  if (!Number.isFinite(kappa)) {
    throw new CalibrationContractError("cohen kappa produced a non-finite value", {
      obligation: "calibration.schema_violation",
    });
  }

  return { n, accuracy, kappa, contingency };
}

export type SliceAgreementMetrics = {
  sliceId: string;
  n: number;
  metricId: CalibrationAgreementMetricId;
  value: number;
  accuracy: number;
  passesThreshold: boolean;
  contingency: Contingency2x2;
};

export type CriticHumanAgreementReport = {
  schemaVersion: "critic.calibration-agreement.v1";
  setId: string;
  criticId: string;
  criticVersion: string;
  metricId: CalibrationAgreementMetricId;
  threshold: number;
  pinnedSeed: number;
  heldOut: true;
  overall: {
    n: number;
    value: number;
    accuracy: number;
    passesThreshold: boolean;
    contingency: Contingency2x2;
  };
  slices: SliceAgreementMetrics[];
  /** Slice ids below threshold — empty when all pass. */
  failingSlices: string[];
  /** overall AND every slice meet threshold. */
  passes: boolean;
};

function normalizeCriticLabelMap(
  labels:
    | ReadonlyMap<string, BinaryCalibrationLabel>
    | Readonly<Record<string, BinaryCalibrationLabel>>,
): Map<string, BinaryCalibrationLabel> {
  if (labels instanceof Map) return new Map(labels);
  return new Map(Object.entries(labels));
}

function metricValueFromResult(
  metricId: CalibrationAgreementMetricId,
  result: AgreementMetricResult,
): number {
  return metricId === "cohen_kappa" ? result.kappa : result.accuracy;
}

/**
 * Build accept/reject pairs from a loaded set + per-entry critic labels.
 * DISCARDED entries are skipped. Missing critic labels → contract error.
 */
export function buildAgreementPairs(
  set: LoadedCalibrationSet,
  criticLabels:
    | ReadonlyMap<string, BinaryCalibrationLabel>
    | Readonly<Record<string, BinaryCalibrationLabel>>,
): AgreementPair[] {
  const map = normalizeCriticLabelMap(criticLabels);
  const pairs: AgreementPair[] = [];

  for (const entry of set.entries) {
    const human = humanOutcomeToBinaryLabel(entry.humanOutcomeSignal);
    if (human === null) continue;

    const critic = map.get(entry.id);
    if (critic !== "accept" && critic !== "reject") {
      const meta: {
        obligation: CalibrationFailureClass;
        failingSlice: string;
        subjectId?: string;
      } = {
        obligation: "calibration.missing_prediction",
        failingSlice: entry.sliceId,
      };
      if (typeof entry.trajectory.subjectId === "string") {
        meta.subjectId = entry.trajectory.subjectId;
      }
      throw new CalibrationContractError(
        `missing critic prediction for calibration entry ${entry.id}`,
        meta,
      );
    }

    const subjectId =
      typeof entry.trajectory.subjectId === "string"
        ? entry.trajectory.subjectId
        : "calibration-set";

    pairs.push({
      entryId: entry.id,
      sliceId: entry.sliceId,
      subjectId,
      human,
      critic,
    });
  }

  if (pairs.length === 0) {
    throw new CalibrationContractError(
      "no accept/reject pairs after excluding DISCARDED",
      { obligation: "calibration.insufficient_pairs" },
    );
  }
  return pairs;
}

/**
 * Score a TrajectoryCritic over the held-out set → binary labels per entry.
 * By default strips humanOutcomeSignal so structural critics are calibrated fairly.
 */
export function predictCriticLabelsOnCalibrationSet(
  set: LoadedCalibrationSet,
  critic: TrajectoryCritic,
  opts?: {
    stripHumanOutcome?: boolean;
  },
): Map<string, BinaryCalibrationLabel> {
  const strip = opts?.stripHumanOutcome !== false;
  const out = new Map<string, BinaryCalibrationLabel>();

  for (const entry of set.entries) {
    const record = strip
      ? stripHumanOutcomeForCalibrationScoring(entry.trajectory)
      : entry.trajectory;
    const score = critic.score(record as Parameters<TrajectoryCritic["score"]>[0]);
    out.set(entry.id, criticScoreToBinaryLabel(score));
  }
  return out;
}

/**
 * Compute critic–human agreement (Cohen kappa by default) with per-slice
 * breakdown and named failing slices.
 */
export function computeCriticHumanAgreement(opts: {
  set: LoadedCalibrationSet;
  criticLabels:
    | ReadonlyMap<string, BinaryCalibrationLabel>
    | Readonly<Record<string, BinaryCalibrationLabel>>;
  criticId: string;
  criticVersion: string;
  /** Defaults to manifest.defaultAgreementThreshold. */
  threshold?: number;
  /** Defaults to cohen_kappa. */
  metricId?: CalibrationAgreementMetricId;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CalibrationTelemetryEvent) => void;
}): CriticHumanAgreementReport {
  const metricId = opts.metricId ?? "cohen_kappa";
  if (
    metricId !== "cohen_kappa" &&
    metricId !== "accuracy"
  ) {
    throw new CalibrationContractError(`unknown agreement metric`, {
      obligation: "calibration.schema_violation",
    });
  }

  const threshold =
    opts.threshold ?? opts.set.manifest.defaultAgreementThreshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new CalibrationContractError(
      "agreement threshold must be a finite number in [0, 1]",
      { obligation: "calibration.schema_violation" },
    );
  }

  if (
    typeof opts.criticId !== "string" ||
    opts.criticId.length === 0 ||
    opts.criticId.length > CALIBRATION_SET_ID_LIMIT
  ) {
    throw new CalibrationContractError("criticId required", {
      obligation: "calibration.schema_violation",
    });
  }
  if (
    typeof opts.criticVersion !== "string" ||
    opts.criticVersion.length === 0 ||
    opts.criticVersion.length > CALIBRATION_SET_ID_LIMIT
  ) {
    throw new CalibrationContractError("criticVersion required", {
      obligation: "calibration.schema_violation",
    });
  }

  if (!opts.set.manifest.heldOut) {
    throw new CalibrationContractError(
      "agreement metrics require a held-out calibration set",
      { obligation: "calibration.not_held_out" },
    );
  }

  const subjectId = opts.subjectId ?? "calibration-set";
  const deviceId = opts.deviceId ?? "ci";
  const pairs = buildAgreementPairs(opts.set, opts.criticLabels);
  const overallResult = computeCohenKappa(pairs);
  const overallValue = metricValueFromResult(metricId, overallResult);
  const overallPasses = overallValue >= threshold;

  const bySlice = new Map<string, AgreementPair[]>();
  for (const p of pairs) {
    const list = bySlice.get(p.sliceId) ?? [];
    list.push(p);
    bySlice.set(p.sliceId, list);
  }

  const slices: SliceAgreementMetrics[] = [];
  for (const sliceId of [...bySlice.keys()].sort()) {
    const slicePairs = bySlice.get(sliceId) ?? [];
    const result = computeCohenKappa(slicePairs);
    const value = metricValueFromResult(metricId, result);
    slices.push({
      sliceId,
      n: result.n,
      metricId,
      value,
      accuracy: result.accuracy,
      passesThreshold: value >= threshold,
      contingency: result.contingency,
    });
  }

  const failingSlices = slices
    .filter((s) => !s.passesThreshold)
    .map((s) => s.sliceId);
  // Aggregate fail also surfaces as failing slice name "(overall)" when
  // overall fails but every named slice somehow passes (degenerate).
  if (overallPasses === false && failingSlices.length === 0) {
    failingSlices.push("(overall)");
  }

  const passes = overallPasses && failingSlices.length === 0;

  const report: CriticHumanAgreementReport = {
    schemaVersion: "critic.calibration-agreement.v1",
    setId: opts.set.manifest.setId,
    criticId: opts.criticId,
    criticVersion: opts.criticVersion,
    metricId,
    threshold,
    pinnedSeed: opts.set.manifest.pinnedSeed,
    heldOut: true,
    overall: {
      n: overallResult.n,
      value: overallValue,
      accuracy: overallResult.accuracy,
      passesThreshold: overallPasses,
      contingency: overallResult.contingency,
    },
    slices,
    failingSlices,
    passes,
  };

  opts.onTelemetry?.({
    event: "learning.critic.calibration_agreement",
    outcome: passes ? "ok" : "fail",
    subjectId,
    deviceId,
    setId: opts.set.manifest.setId,
    metricId,
    metricValue: overallValue,
    threshold,
    failingSliceCount: failingSlices.length,
    criticId: opts.criticId,
    criticVersion: opts.criticVersion,
    ...(failingSlices[0] !== undefined ? { sliceId: failingSlices[0] } : {}),
    ...(passes
      ? {}
      : { failureClass: "calibration.agreement_below_threshold" as const }),
  });

  return report;
}

/**
 * Assert agreement report passes threshold; throws with first failing slice named.
 */
export function assertCriticHumanAgreementPasses(
  report: CriticHumanAgreementReport,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CalibrationTelemetryEvent) => void;
  },
): { ok: true; report: CriticHumanAgreementReport } {
  if (report.passes) {
    opts?.onTelemetry?.({
      event: "learning.critic.calibration_agreement",
      outcome: "ok",
      subjectId: opts.subjectId ?? "calibration-set",
      deviceId: opts.deviceId ?? "ci",
      setId: report.setId,
      metricId: report.metricId,
      metricValue: report.overall.value,
      threshold: report.threshold,
      failingSliceCount: 0,
      criticId: report.criticId,
      criticVersion: report.criticVersion,
    });
    return { ok: true, report };
  }

  const failingSlice = report.failingSlices[0] ?? "(overall)";
  opts?.onTelemetry?.({
    event: "learning.critic.calibration_agreement",
    outcome: "fail",
    subjectId: opts.subjectId ?? "calibration-set",
    deviceId: opts.deviceId ?? "ci",
    setId: report.setId,
    sliceId: failingSlice,
    metricId: report.metricId,
    metricValue: report.overall.value,
    threshold: report.threshold,
    failingSliceCount: report.failingSlices.length,
    criticId: report.criticId,
    criticVersion: report.criticVersion,
    failureClass: "calibration.agreement_below_threshold",
  });
  throw new CalibrationContractError(
    `critic ${report.criticId}@${report.criticVersion} agreement ${report.metricId}=${report.overall.value} below threshold ${report.threshold}`,
    {
      obligation: "calibration.agreement_below_threshold",
      failingSlice,
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    },
  );
}

/** Repo-relative known-bad rubric fixture (must fail the promotion gate). */
export const CALIBRATION_KNOWN_BAD_RUBRIC_RELPATH =
  "training/eval/calibration_sets/known-bad-rubric.json" as const;

export const CALIBRATION_KNOWN_BAD_SCHEMA_VERSION =
  "critic.calibration-known-bad.v1" as const;

export const CALIBRATION_KNOWN_BAD_RUBRIC_ID =
  "critic.calibration.known-bad" as const;

export const CALIBRATION_KNOWN_BAD_RUBRIC_VERSION = "0.0.0-bad" as const;

const knownBadRubricSchema = z
  .object({
    schemaVersion: z.literal(CALIBRATION_KNOWN_BAD_SCHEMA_VERSION),
    rubricId: z.literal(CALIBRATION_KNOWN_BAD_RUBRIC_ID),
    rubricVersion: z.literal(CALIBRATION_KNOWN_BAD_RUBRIC_VERSION),
    agreementThreshold: z.number().min(0).max(1),
    behavior: z.literal("always_accept"),
    purpose: z.string().min(1).max(256),
    locality: z.enum(["on-device", "self-hosted"]),
  })
  .strict();

export type KnownBadCalibrationRubric = z.infer<typeof knownBadRubricSchema>;

/**
 * Load the committed known-bad rubric fixture (CI must reject this candidate).
 */
export function loadKnownBadCalibrationRubric(opts?: {
  repoRoot?: string;
  relPath?: string;
}): KnownBadCalibrationRubric {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const rel = opts?.relPath ?? CALIBRATION_KNOWN_BAD_RUBRIC_RELPATH;
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new CalibrationContractError(
      `known-bad rubric fixture missing: ${rel}`,
      { obligation: "calibration.source_missing" },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CalibrationContractError("known-bad rubric fixture not JSON", {
      obligation: "calibration.schema_violation",
    });
  }
  const parsed = knownBadRubricSchema.safeParse(json);
  if (!parsed.success) {
    throw new CalibrationContractError(
      `known-bad rubric invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      { obligation: "calibration.schema_violation" },
    );
  }
  return parsed.data;
}

/**
 * Known-bad TrajectoryCritic: always emits a positive total (always-accept).
 * Must fail calibration against held-out REJECTED labels.
 */
export function createKnownBadCalibrationCritic(
  fixture?: KnownBadCalibrationRubric,
): TrajectoryCritic {
  const rubricId = fixture?.rubricId ?? CALIBRATION_KNOWN_BAD_RUBRIC_ID;
  const rubricVersion =
    fixture?.rubricVersion ?? CALIBRATION_KNOWN_BAD_RUBRIC_VERSION;
  return {
    rubricId,
    rubricVersion,
    score(): CriticScore {
      return createCriticScore({ always_accept: 1 }, rubricVersion);
    },
  };
}

export type CriticPromotionCandidate = {
  critic: TrajectoryCritic;
  /**
   * Declared agreement threshold for this critic version.
   * Failing versions cannot enter training config.
   */
  agreementThreshold: number;
  /** Optional content hash pin for training config. */
  contentHash?: string;
  /**
   * Surgery component classes touched by this candidate.
   * More than one → attribution_void (one surgery type per stage).
   */
  surgeryClasses?: readonly string[];
};

export type TrainingCriticConfigPin = {
  schemaVersion: "critic.training-config-pin.v1";
  rubricId: string;
  rubricVersion: string;
  contentHash: string;
  calibrated: true;
  metricId: CalibrationAgreementMetricId;
  agreementValue: number;
  threshold: number;
  setId: string;
  pinnedSeed: number;
  labelCount: number;
};

export type CalibrationPromotionVerdict =
  | {
      ok: true;
      verdict: "promote";
      trainingConfigAllowed: true;
      agreement: CriticHumanAgreementReport;
      trainingConfigPin: TrainingCriticConfigPin;
      failingSlices: [];
    }
  | {
      ok: false;
      verdict: "reject";
      trainingConfigAllowed: false;
      agreement?: CriticHumanAgreementReport;
      failingSlices: string[];
      failureClass: CalibrationFailureClass;
      detail: string;
    };

const SURGERY_CLASS_LIMIT = 8;

/**
 * Automate critic version promotion against the held-out human label set.
 * Humans review the evidence report; they do not hand-wave scores.
 *
 * Champion = frozen human accept/reject labels on the held-out set.
 * Challenger = candidate critic version (must meet declared threshold).
 */
export function runCriticCalibrationPromotionGate(opts: {
  set: LoadedCalibrationSet;
  candidate: CriticPromotionCandidate;
  /** When provided, decontam against C0 baseline hashes (train-on-eval void). */
  baselineContentHashes?: readonly string[];
  metricId?: CalibrationAgreementMetricId;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: CalibrationTelemetryEvent) => void;
}): CalibrationPromotionVerdict {
  const subjectId = opts.subjectId ?? "calibration-set";
  const deviceId = opts.deviceId ?? "ci";
  const critic = opts.candidate.critic;
  const threshold = opts.candidate.agreementThreshold;

  if (!opts.set.manifest.heldOut || !opts.set.manifest.excludeFromTrainingCorpora) {
    const detail = "promotion gate requires held-out, training-excluded calibration set";
    opts.onTelemetry?.({
      event: "learning.critic.calibration_promotion",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "calibration.not_held_out",
      verdict: "reject",
      trainingConfigAllowed: false,
    });
    return {
      ok: false,
      verdict: "reject",
      trainingConfigAllowed: false,
      failingSlices: ["(set)"],
      failureClass: "calibration.not_held_out",
      detail,
    };
  }

  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new CalibrationContractError(
      "candidate agreementThreshold must be a finite number in [0, 1]",
      { obligation: "calibration.schema_violation", subjectId, deviceId },
    );
  }

  const surgery = opts.candidate.surgeryClasses ?? [];
  if (surgery.length > SURGERY_CLASS_LIMIT) {
    throw new CalibrationContractError("surgeryClasses exceed soft cap", {
      obligation: "calibration.section_limit",
      subjectId,
      deviceId,
    });
  }
  const uniqueSurgery = [...new Set(surgery)];
  if (uniqueSurgery.length > 1) {
    const detail =
      "one surgery type per stage: candidate touches multiple component classes";
    opts.onTelemetry?.({
      event: "learning.critic.calibration_promotion",
      outcome: "fail",
      subjectId,
      deviceId,
      setId: opts.set.manifest.setId,
      criticId: critic.rubricId,
      criticVersion: critic.rubricVersion,
      failureClass: "calibration.attribution_void",
      verdict: "reject",
      trainingConfigAllowed: false,
      sliceId: "(surgery)",
    });
    return {
      ok: false,
      verdict: "reject",
      trainingConfigAllowed: false,
      failingSlices: ["(surgery)"],
      failureClass: "calibration.attribution_void",
      detail,
    };
  }

  if (opts.baselineContentHashes !== undefined) {
    try {
      assertCalibrationDecontaminatedAgainstBaselines(
        opts.set,
        opts.baselineContentHashes,
        opts.onTelemetry !== undefined
          ? { onTelemetry: opts.onTelemetry }
          : {},
      );
    } catch (err) {
      if (err instanceof CalibrationContractError) {
        opts.onTelemetry?.({
          event: "learning.critic.calibration_promotion",
          outcome: "fail",
          subjectId,
          deviceId,
          setId: opts.set.manifest.setId,
          criticId: critic.rubricId,
          criticVersion: critic.rubricVersion,
          failureClass: err.obligation,
          verdict: "reject",
          trainingConfigAllowed: false,
          ...(err.failingSlice !== undefined
            ? { sliceId: err.failingSlice }
            : {}),
        });
        return {
          ok: false,
          verdict: "reject",
          trainingConfigAllowed: false,
          failingSlices: err.failingSlice ? [err.failingSlice] : ["(decontam)"],
          failureClass: err.obligation,
          detail: err.message,
        };
      }
      throw err;
    }
  }

  const labels = predictCriticLabelsOnCalibrationSet(opts.set, critic);
  const agreement = computeCriticHumanAgreement({
    set: opts.set,
    criticLabels: labels,
    criticId: critic.rubricId,
    criticVersion: critic.rubricVersion,
    threshold,
    subjectId,
    deviceId,
    ...(opts.metricId !== undefined ? { metricId: opts.metricId } : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (!agreement.passes) {
    const failingSlices = [...agreement.failingSlices];
    const detail = `agreement ${agreement.metricId}=${agreement.overall.value} below threshold ${threshold}`;
    opts.onTelemetry?.({
      event: "learning.critic.calibration_promotion",
      outcome: "fail",
      subjectId,
      deviceId,
      setId: opts.set.manifest.setId,
      criticId: critic.rubricId,
      criticVersion: critic.rubricVersion,
      metricId: agreement.metricId,
      metricValue: agreement.overall.value,
      threshold,
      failingSliceCount: failingSlices.length,
      failureClass: "calibration.promotion_rejected",
      verdict: "reject",
      trainingConfigAllowed: false,
      ...(failingSlices[0] !== undefined ? { sliceId: failingSlices[0] } : {}),
    });
    return {
      ok: false,
      verdict: "reject",
      trainingConfigAllowed: false,
      agreement,
      failingSlices,
      failureClass: "calibration.promotion_rejected",
      detail,
    };
  }

  const contentHash =
    opts.candidate.contentHash ??
    computeCalibrationContentHash(
      `${critic.rubricId}@${critic.rubricVersion}:${threshold}:${agreement.overall.value}`,
    );

  const trainingConfigPin: TrainingCriticConfigPin = {
    schemaVersion: "critic.training-config-pin.v1",
    rubricId: critic.rubricId,
    rubricVersion: critic.rubricVersion,
    contentHash,
    calibrated: true,
    metricId: agreement.metricId,
    agreementValue: agreement.overall.value,
    threshold,
    setId: opts.set.manifest.setId,
    pinnedSeed: opts.set.manifest.pinnedSeed,
    labelCount: agreement.overall.n,
  };

  opts.onTelemetry?.({
    event: "learning.critic.calibration_promotion",
    outcome: "ok",
    subjectId,
    deviceId,
    setId: opts.set.manifest.setId,
    criticId: critic.rubricId,
    criticVersion: critic.rubricVersion,
    metricId: agreement.metricId,
    metricValue: agreement.overall.value,
    threshold,
    failingSliceCount: 0,
    verdict: "promote",
    trainingConfigAllowed: true,
    contentHash,
  });

  return {
    ok: true,
    verdict: "promote",
    trainingConfigAllowed: true,
    agreement,
    trainingConfigPin,
    failingSlices: [],
  };
}

/**
 * Build a training-config pin from a promote verdict.
 * Rejected candidates throw — failing versions cannot enter training config.
 */
export function buildTrainingCriticConfigPin(
  verdict: CalibrationPromotionVerdict,
): TrainingCriticConfigPin {
  if (!verdict.ok || verdict.verdict !== "promote") {
    const failingSlice = verdict.failingSlices[0] ?? "(overall)";
    throw new CalibrationContractError(
      `training config blocked: ${verdict.detail}`,
      {
        obligation: "calibration.training_config_blocked",
        failingSlice,
      },
    );
  }
  return verdict.trainingConfigPin;
}

/**
 * Assert a promotion verdict allows training config entry.
 * Throws with the first failing slice named when rejected.
 */
export function assertCriticEligibleForTrainingConfig(
  verdict: CalibrationPromotionVerdict,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: CalibrationTelemetryEvent) => void;
  },
): { ok: true; pin: TrainingCriticConfigPin } {
  if (verdict.ok && verdict.verdict === "promote") {
    opts?.onTelemetry?.({
      event: "learning.critic.calibration_promotion",
      outcome: "ok",
      subjectId: opts.subjectId ?? "calibration-set",
      deviceId: opts.deviceId ?? "ci",
      criticId: verdict.trainingConfigPin.rubricId,
      criticVersion: verdict.trainingConfigPin.rubricVersion,
      verdict: "promote",
      trainingConfigAllowed: true,
      contentHash: verdict.trainingConfigPin.contentHash,
    });
    return { ok: true, pin: verdict.trainingConfigPin };
  }

  const failingSlice = verdict.failingSlices[0] ?? "(overall)";
  opts?.onTelemetry?.({
    event: "learning.critic.calibration_promotion",
    outcome: "fail",
    subjectId: opts.subjectId ?? "calibration-set",
    deviceId: opts.deviceId ?? "ci",
    sliceId: failingSlice,
    failureClass: "calibration.training_config_blocked",
    verdict: "reject",
    trainingConfigAllowed: false,
    failingSliceCount: verdict.failingSlices.length,
  });
  throw new CalibrationContractError(
    `critic version blocked from training config: ${verdict.detail}`,
    {
      obligation: "calibration.training_config_blocked",
      failingSlice,
      ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
      ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    },
  );
}

/**
 * CI entry: promote core (or provided) champion critic; reject known-bad fixture.
 * Returns structured results for tests; throws / exits via caller on failure.
 */
export function proveCalibrationPromotionGate(opts?: {
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  championCritic?: TrajectoryCritic;
  championThreshold?: number;
  onTelemetry?: (e: CalibrationTelemetryEvent) => void;
}): {
  ok: true;
  champion: Extract<CalibrationPromotionVerdict, { ok: true }>;
  knownBad: Extract<CalibrationPromotionVerdict, { ok: false }>;
} {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const subjectId = opts?.subjectId ?? "calibration-set";
  const deviceId = opts?.deviceId ?? "ci";
  const set = loadCalibrationSet({
    repoRoot: root,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const championCritic = opts?.championCritic ?? createCoreRubricCritic();
  const championThreshold =
    opts?.championThreshold ?? set.manifest.defaultAgreementThreshold;

  const champion = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic: championCritic,
      agreementThreshold: championThreshold,
      surgeryClasses: ["core-rubric"],
    },
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (!champion.ok) {
    throw new CalibrationContractError(
      `known-good champion failed promotion: ${champion.detail}`,
      {
        obligation: "calibration.promotion_rejected",
        failingSlice: champion.failingSlices[0] ?? "(overall)",
        subjectId,
        deviceId,
      },
    );
  }

  const badFixture = loadKnownBadCalibrationRubric({ repoRoot: root });
  const knownBadCritic = createKnownBadCalibrationCritic(badFixture);
  const knownBad = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic: knownBadCritic,
      agreementThreshold: badFixture.agreementThreshold,
      surgeryClasses: ["known-bad"],
    },
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (knownBad.ok) {
    throw new CalibrationContractError(
      "known-bad rubric unexpectedly promoted — gate is broken",
      {
        obligation: "calibration.schema_violation",
        subjectId,
        deviceId,
      },
    );
  }

  // Idempotent replay: same inputs → same reject
  const replay = runCriticCalibrationPromotionGate({
    set,
    candidate: {
      critic: knownBadCritic,
      agreementThreshold: badFixture.agreementThreshold,
      surgeryClasses: ["known-bad"],
    },
    subjectId,
    deviceId,
  });
  if (replay.ok || replay.detail !== knownBad.detail) {
    throw new CalibrationContractError(
      "promotion gate replay is not idempotent",
      { obligation: "calibration.schema_violation", subjectId, deviceId },
    );
  }

  return { ok: true, champion, knownBad };
}
