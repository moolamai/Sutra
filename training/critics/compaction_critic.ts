/**
 * Compaction critic — versioned pure function over trajectory + summary.
 *
 * Rubric (compaction_rubric.json v1.0.0):
 *   dropped constraint / verified fact / citation  −2.0 each
 *   consent-scope leak                             −2.0 hard-fail (floor)
 *   downstream task success on summary-only replay +1.0
 *
 * Deterministic. No network. No LLM. Telemetry never carries summary text.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CriticContractError,
  assertCriticScore,
  createCriticScore,
  type CriticScore,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.ts";

export const COMPACTION_RUBRIC_ID = "critic.compaction" as const;
export const COMPACTION_RUBRIC_VERSION = "1.0.0" as const;
export const COMPACTION_RUBRIC_RELPATH =
  "training/critics/compaction_rubric.json" as const;

export const COMPACTION_RUBRIC_WEIGHTS = Object.freeze({
  dropped_constraint: -2.0,
  dropped_verified_fact: -2.0,
  dropped_citation: -2.0,
  consent_scope_leak: -2.0,
  downstream_replay_success: 1.0,
} as const);

export type CompactionRubricComponent = keyof typeof COMPACTION_RUBRIC_WEIGHTS;

export type CompactionRubricDocument = {
  schemaVersion: "compaction.rubric.v1";
  rubricId: typeof COMPACTION_RUBRIC_ID;
  rubricVersion: string;
  weights: Record<CompactionRubricComponent, number>;
  limits: {
    maxRequiredItems: number;
    maxSummaryChars: number;
    maxConsentMarkers: number;
  };
  calibration: {
    marker: "executed_compaction";
    minimumTrajectoryCount: number;
    maxTrajectoryCount: number;
    agreementMetric: "cohen_kappa";
    agreementThreshold: number;
  };
  hackDefense: {
    schemaVersion: "critic.compaction-hack-defense.v1";
    suiteVersion: string;
    maxFixtureCount: number;
    fixtures: CompactionHackDefenseFixture[];
  };
};

/**
 * Summary artifact + preservation obligations scored by the compaction critic.
 * Callers project harness trajectories into this shape — never raw keystrokes.
 */
export type CompactionCriticInput = {
  subjectId: string;
  deviceId?: string;
  sessionId?: string;
  /** Open constraints that must appear verbatim in the summary. */
  requiredConstraints?: readonly string[];
  /** Verified facts that must appear verbatim in the summary. */
  requiredVerifiedFacts?: readonly string[];
  /**
   * Citation refs that must resolve as complete refs in the summary.
   * Partial truncation (prefix-only) counts as dropped.
   */
  requiredCitationRefs?: readonly string[];
  /** Post-compaction summary text. */
  summary: string;
  /**
   * Consent-scope markers that must not appear in the summary.
   * Any hit is a hard-fail (−2.0 floor), ignoring other scores.
   */
  consentScopeMarkers?: readonly string[];
  /** True when replay harness completed the task on summary-only history. */
  downstreamReplaySuccess?: boolean;
  /** Explicit degenerate markers (reward-hack counter-check). */
  emptyAnswer?: boolean;
  toolSpam?: boolean;
};

export const COMPACTION_HACK_ATTACK_PATTERNS = Object.freeze([
  "empty_summary",
  "citation_stripped",
  "consent_leak",
  "known_good",
] as const);

export type CompactionHackAttackPattern =
  (typeof COMPACTION_HACK_ATTACK_PATTERNS)[number];

export type CompactionHackDefenseFixture = {
  id: string;
  attackPattern: CompactionHackAttackPattern;
  input: Omit<CompactionCriticInput, "subjectId" | "deviceId" | "sessionId">;
  expected: {
    maxTotal?: number;
    minTotal?: number;
    hardFail: boolean;
  };
};

export type CompactionCriticScore = CriticScore & {
  rubricId: typeof COMPACTION_RUBRIC_ID;
  hardFail: boolean;
  droppedConstraints: number;
  droppedVerifiedFacts: number;
  droppedCitations: number;
  consentLeak: boolean;
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function parseCompactionRubricDocument(
  input: unknown,
): CompactionRubricDocument {
  if (!input || typeof input !== "object") {
    throw new CriticContractError("compaction rubric must be an object", {
      obligation: "critic.invalid_rubric",
    });
  }
  const doc = input as Record<string, unknown>;
  if (doc.schemaVersion !== "compaction.rubric.v1") {
    throw new CriticContractError("compaction rubric schemaVersion mismatch", {
      obligation: "critic.invalid_rubric",
    });
  }
  if (doc.rubricId !== COMPACTION_RUBRIC_ID) {
    throw new CriticContractError("compaction rubricId mismatch", {
      obligation: "critic.invalid_rubric",
    });
  }
  if (typeof doc.rubricVersion !== "string" || !doc.rubricVersion) {
    throw new CriticContractError("compaction rubricVersion required", {
      obligation: "critic.invalid_rubric",
    });
  }
  const weights = doc.weights as Record<string, number> | undefined;
  if (!weights || typeof weights !== "object") {
    throw new CriticContractError("compaction rubric weights required", {
      obligation: "critic.invalid_rubric",
    });
  }
  for (const key of Object.keys(
    COMPACTION_RUBRIC_WEIGHTS,
  ) as CompactionRubricComponent[]) {
    if (typeof weights[key] !== "number" || !Number.isFinite(weights[key])) {
      throw new CriticContractError(`weight ${key} must be finite`, {
        obligation: "critic.invalid_rubric",
      });
    }
  }
  const limits = doc.limits as CompactionRubricDocument["limits"] | undefined;
  if (
    !limits ||
    typeof limits.maxRequiredItems !== "number" ||
    typeof limits.maxSummaryChars !== "number" ||
    typeof limits.maxConsentMarkers !== "number"
  ) {
    throw new CriticContractError("compaction rubric limits required", {
      obligation: "critic.invalid_rubric",
    });
  }
  const calibration = doc.calibration as
    | CompactionRubricDocument["calibration"]
    | undefined;
  if (
    !calibration ||
    calibration.marker !== "executed_compaction" ||
    !Number.isInteger(calibration.minimumTrajectoryCount) ||
    calibration.minimumTrajectoryCount < 1 ||
    !Number.isInteger(calibration.maxTrajectoryCount) ||
    calibration.maxTrajectoryCount < calibration.minimumTrajectoryCount ||
    calibration.agreementMetric !== "cohen_kappa" ||
    typeof calibration.agreementThreshold !== "number" ||
    !Number.isFinite(calibration.agreementThreshold) ||
    calibration.agreementThreshold < 0 ||
    calibration.agreementThreshold > 1
  ) {
    throw new CriticContractError("compaction rubric calibration invalid", {
      obligation: "critic.invalid_rubric",
    });
  }
  const hackDefense = doc.hackDefense as Record<string, unknown> | undefined;
  if (
    !hackDefense ||
    hackDefense.schemaVersion !== "critic.compaction-hack-defense.v1" ||
    typeof hackDefense.suiteVersion !== "string" ||
    hackDefense.suiteVersion.length === 0 ||
    hackDefense.suiteVersion.length > 64 ||
    !Number.isInteger(hackDefense.maxFixtureCount) ||
    (hackDefense.maxFixtureCount as number) < 1 ||
    (hackDefense.maxFixtureCount as number) > 64 ||
    !Array.isArray(hackDefense.fixtures) ||
    hackDefense.fixtures.length < 1 ||
    hackDefense.fixtures.length > (hackDefense.maxFixtureCount as number)
  ) {
    throw new CriticContractError("compaction hack-defense suite invalid", {
      obligation: "critic.invalid_rubric",
    });
  }
  const fixtures: CompactionHackDefenseFixture[] = [];
  const seenIds = new Set<string>();
  const seenPatterns = new Set<string>();
  const allowedInputKeys = new Set([
    "summary",
    "requiredConstraints",
    "requiredVerifiedFacts",
    "requiredCitationRefs",
    "consentScopeMarkers",
    "downstreamReplaySuccess",
    "emptyAnswer",
    "toolSpam",
  ]);
  for (const raw of hackDefense.fixtures) {
    if (!raw || typeof raw !== "object") {
      throw new CriticContractError("compaction hack fixture must be an object", {
        obligation: "critic.invalid_rubric",
      });
    }
    const fixture = raw as Record<string, unknown>;
    const id = typeof fixture.id === "string" ? fixture.id.trim() : "";
    const attackPattern = fixture.attackPattern;
    const input = fixture.input as Record<string, unknown> | undefined;
    const expected = fixture.expected as Record<string, unknown> | undefined;
    if (
      !id ||
      id.length > 128 ||
      seenIds.has(id) ||
      typeof attackPattern !== "string" ||
      !COMPACTION_HACK_ATTACK_PATTERNS.includes(
        attackPattern as CompactionHackAttackPattern,
      ) ||
      seenPatterns.has(attackPattern) ||
      !input ||
      typeof input !== "object" ||
      typeof input.summary !== "string" ||
      input.summary.length > limits.maxSummaryChars ||
      Object.keys(input).some((key) => !allowedInputKeys.has(key)) ||
      !expected ||
      typeof expected !== "object" ||
      typeof expected.hardFail !== "boolean"
    ) {
      throw new CriticContractError("compaction hack fixture invalid", {
        obligation: "critic.invalid_rubric",
      });
    }
    for (const [key, limit] of [
      ["requiredConstraints", limits.maxRequiredItems],
      ["requiredVerifiedFacts", limits.maxRequiredItems],
      ["requiredCitationRefs", limits.maxRequiredItems],
      ["consentScopeMarkers", limits.maxConsentMarkers],
    ] as const) {
      const value = input[key];
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.length > limit ||
          value.some(
            (entry) =>
              typeof entry !== "string" ||
              entry.trim().length === 0 ||
              entry.length > 2048,
          ))
      ) {
        throw new CriticContractError(
          `compaction hack fixture ${key} invalid`,
          { obligation: "critic.invalid_rubric" },
        );
      }
    }
    for (const key of [
      "downstreamReplaySuccess",
      "emptyAnswer",
      "toolSpam",
    ] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") {
        throw new CriticContractError(
          `compaction hack fixture ${key} must be boolean`,
          { obligation: "critic.invalid_rubric" },
        );
      }
    }
    const maxTotal = expected.maxTotal;
    const minTotal = expected.minTotal;
    const isKnownGood = attackPattern === "known_good";
    if (
      (maxTotal !== undefined &&
        (typeof maxTotal !== "number" || !Number.isFinite(maxTotal))) ||
      (minTotal !== undefined &&
        (typeof minTotal !== "number" || !Number.isFinite(minTotal))) ||
      (isKnownGood
        ? minTotal === undefined || maxTotal !== undefined
        : maxTotal === undefined || minTotal !== undefined)
    ) {
      throw new CriticContractError(
        "compaction hack fixture expected bound invalid",
        { obligation: "critic.invalid_rubric" },
      );
    }
    seenIds.add(id);
    seenPatterns.add(attackPattern);
    fixtures.push({
      id,
      attackPattern: attackPattern as CompactionHackAttackPattern,
      input: input as CompactionHackDefenseFixture["input"],
      expected: {
        ...(maxTotal !== undefined ? { maxTotal: maxTotal as number } : {}),
        ...(minTotal !== undefined ? { minTotal: minTotal as number } : {}),
        hardFail: expected.hardFail as boolean,
      },
    });
  }
  if (
    COMPACTION_HACK_ATTACK_PATTERNS.some(
      (pattern) => !seenPatterns.has(pattern),
    )
  ) {
    throw new CriticContractError(
      "compaction hack-defense suite missing required attack pattern",
      { obligation: "critic.invalid_rubric" },
    );
  }
  return {
    schemaVersion: "compaction.rubric.v1",
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion: doc.rubricVersion,
    weights: {
      dropped_constraint: weights.dropped_constraint,
      dropped_verified_fact: weights.dropped_verified_fact,
      dropped_citation: weights.dropped_citation,
      consent_scope_leak: weights.consent_scope_leak,
      downstream_replay_success: weights.downstream_replay_success,
    },
    limits: {
      maxRequiredItems: limits.maxRequiredItems,
      maxSummaryChars: limits.maxSummaryChars,
      maxConsentMarkers: limits.maxConsentMarkers,
    },
    calibration: {
      marker: calibration.marker,
      minimumTrajectoryCount: calibration.minimumTrajectoryCount,
      maxTrajectoryCount: calibration.maxTrajectoryCount,
      agreementMetric: calibration.agreementMetric,
      agreementThreshold: calibration.agreementThreshold,
    },
    hackDefense: {
      schemaVersion: "critic.compaction-hack-defense.v1",
      suiteVersion: hackDefense.suiteVersion as string,
      maxFixtureCount: hackDefense.maxFixtureCount as number,
      fixtures,
    },
  };
}

/**
 * Load and validate the committed rubric document (version pin).
 */
export function loadCompactionRubric(options?: {
  repoRoot?: string;
}): CompactionRubricDocument {
  const path = options?.repoRoot
    ? join(options.repoRoot, COMPACTION_RUBRIC_RELPATH)
    : join(MODULE_DIR, "compaction_rubric.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseCompactionRubricDocument(raw);
}

const DEFAULT_RUBRIC: CompactionRubricDocument = loadCompactionRubric();

function requireId(value: unknown, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 128) {
    throw new CriticContractError(`${field} required and bounded`, {
      obligation: "critic.invalid_score",
    });
  }
  return trimmed;
}

function boundedStringList(
  value: readonly string[] | undefined,
  limit: number,
  field: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) {
    throw new CriticContractError(`${field} exceeds bound ${limit}`, {
      obligation: "critic.invalid_score",
    });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new CriticContractError(
        `${field} entries must be non-empty strings`,
        { obligation: "critic.invalid_score" },
      );
    }
    if (item.length > 2048) {
      throw new CriticContractError(`${field} entry exceeds 2048 chars`, {
        obligation: "critic.invalid_score",
      });
    }
    out.push(item);
  }
  return out;
}

/**
 * Resolvable citation presence: the full ref must appear as a contiguous
 * token. Prefix-only truncation fails.
 */
export function citationRefResolved(
  summary: string,
  citationRef: string,
): boolean {
  const ref = citationRef.trim();
  if (!ref || typeof summary !== "string") return false;
  let from = 0;
  while (from <= summary.length) {
    const idx = summary.indexOf(ref, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : summary[idx - 1]!;
    const afterIdx = idx + ref.length;
    const after = afterIdx >= summary.length ? "" : summary[afterIdx]!;
    const beforeOk =
      before === "" || /[\s,;:()\[\]{}"'`|]/.test(before);
    const afterOk =
      after === "" ||
      /[\s,;:()\[\]{}"'`|]/.test(after) ||
      after === ".";
    const extended =
      after !== "" && /[A-Za-z0-9_§#/\-]/.test(after) && after !== ".";
    if (beforeOk && afterOk && !extended) return true;
    from = idx + 1;
  }
  return false;
}

export function obligationPreserved(
  summary: string,
  obligation: string,
): boolean {
  const needle = obligation.trim();
  if (!needle || typeof summary !== "string") return false;
  return summary.includes(needle);
}

export function detectConsentScopeLeak(
  summary: string,
  markers: readonly string[],
): boolean {
  if (typeof summary !== "string" || markers.length === 0) return false;
  return markers.some(
    (marker) => marker.trim().length > 0 && summary.includes(marker.trim()),
  );
}

export function isCompactionRewardHack(input: CompactionCriticInput): boolean {
  if (input.emptyAnswer === true) return true;
  if (input.toolSpam === true) return true;
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    const needsContent =
      (input.requiredConstraints?.length ?? 0) > 0 ||
      (input.requiredVerifiedFacts?.length ?? 0) > 0 ||
      (input.requiredCitationRefs?.length ?? 0) > 0;
    if (needsContent) return true;
  }
  return false;
}

export function compactionRubricContentHash(
  rubric: CompactionRubricDocument = DEFAULT_RUBRIC,
): `sha256:${string}` {
  const canonical = JSON.stringify({
    schemaVersion: rubric.schemaVersion,
    rubricId: rubric.rubricId,
    rubricVersion: rubric.rubricVersion,
    weights: rubric.weights,
    limits: rubric.limits,
    calibration: rubric.calibration,
    hackDefense: rubric.hackDefense,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export type CompactionCalibrationTrajectory = CompactionCriticInput & {
  trajectoryId: string;
  markers: readonly string[];
  heldOut: true;
  locality: "on-device" | "self-hosted";
  humanOutcomeSignal: "ACCEPTED" | "REJECTED" | "DISCARDED";
};

export type CompactionCalibrationFailureClass =
  | "compaction_calibration.invalid_corpus"
  | "compaction_calibration.insufficient_trajectories"
  | "compaction_calibration.not_held_out"
  | "compaction_calibration.locality_violation"
  | "compaction_calibration.subject_scope"
  | "compaction_calibration.agreement_below_threshold";

export type CompactionCalibrationTelemetryEvent = {
  event: "learning.critic.compaction_calibration";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  rubricId: typeof COMPACTION_RUBRIC_ID;
  rubricVersion: string;
  failureClass?: CompactionCalibrationFailureClass;
  corpusCount: number;
  executedCompactionCount: number;
  labeledCount: number;
  metricId: "cohen_kappa";
  metricValue?: number;
  threshold: number;
};

export class CompactionCalibrationError extends Error {
  readonly obligation: CompactionCalibrationFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: CompactionCalibrationFailureClass;
      subjectId?: string;
      deviceId?: string;
    },
  ) {
    super(message);
    this.name = "CompactionCalibrationError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
  }
}

type BinaryCompactionLabel = "accept" | "reject";

export type CompactionCalibrationReport = {
  schemaVersion: "critic.compaction-calibration.v1";
  rubricId: typeof COMPACTION_RUBRIC_ID;
  rubricVersion: string;
  rubricContentHash: `sha256:${string}`;
  marker: "executed_compaction";
  heldOut: true;
  locality: "on-device" | "self-hosted";
  subjectId: string;
  corpusCount: number;
  executedCompactionCount: number;
  labeledCount: number;
  discardedCount: number;
  skippedNonCompactionCount: number;
  metricId: "cohen_kappa";
  agreement: number;
  accuracy: number;
  threshold: number;
  minimumTrajectoryCount: number;
  passes: boolean;
  contingency: {
    humanAcceptCriticAccept: number;
    humanAcceptCriticReject: number;
    humanRejectCriticAccept: number;
    humanRejectCriticReject: number;
  };
};

function compactionAgreement(
  pairs: readonly {
    human: BinaryCompactionLabel;
    critic: BinaryCompactionLabel;
  }[],
): {
  agreement: number;
  accuracy: number;
  contingency: CompactionCalibrationReport["contingency"];
} {
  const contingency = {
    humanAcceptCriticAccept: 0,
    humanAcceptCriticReject: 0,
    humanRejectCriticAccept: 0,
    humanRejectCriticReject: 0,
  };
  for (const pair of pairs) {
    if (pair.human === "accept" && pair.critic === "accept") {
      contingency.humanAcceptCriticAccept += 1;
    } else if (pair.human === "accept") {
      contingency.humanAcceptCriticReject += 1;
    } else if (pair.critic === "accept") {
      contingency.humanRejectCriticAccept += 1;
    } else {
      contingency.humanRejectCriticReject += 1;
    }
  }

  const n = pairs.length;
  const observed =
    (contingency.humanAcceptCriticAccept +
      contingency.humanRejectCriticReject) /
    n;
  const humanAccept =
    contingency.humanAcceptCriticAccept +
    contingency.humanAcceptCriticReject;
  const humanReject =
    contingency.humanRejectCriticAccept +
    contingency.humanRejectCriticReject;
  const criticAccept =
    contingency.humanAcceptCriticAccept +
    contingency.humanRejectCriticAccept;
  const criticReject =
    contingency.humanAcceptCriticReject +
    contingency.humanRejectCriticReject;
  const chance =
    (humanAccept / n) * (criticAccept / n) +
    (humanReject / n) * (criticReject / n);
  const agreement =
    chance >= 1 ? (observed >= 1 ? 1 : 0) : (observed - chance) / (1 - chance);
  return { agreement, accuracy: observed, contingency };
}

/**
 * Calibrate the pinned critic against subject-scoped, local, held-out harness
 * trajectories. Non-compaction records are ignored; only explicitly marked
 * records count toward the minimum.
 */
export function calibrateCompactionCritic(
  corpus: readonly CompactionCalibrationTrajectory[],
  options: {
    expectedSubjectId: string;
    locality: "on-device" | "self-hosted";
    deviceId?: string;
    rubric?: CompactionRubricDocument;
    onTelemetry?: (event: CompactionCalibrationTelemetryEvent) => void;
  },
): CompactionCalibrationReport {
  const rubric = options.rubric ?? DEFAULT_RUBRIC;
  const subjectId = requireId(options.expectedSubjectId, "expectedSubjectId");
  const deviceId =
    options.deviceId === undefined
      ? "unknown"
      : requireId(options.deviceId, "deviceId");
  const metricBase = {
    event: "learning.critic.compaction_calibration" as const,
    subjectId,
    deviceId,
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion: rubric.rubricVersion,
    corpusCount: Array.isArray(corpus) ? corpus.length : 0,
    executedCompactionCount: 0,
    labeledCount: 0,
    metricId: rubric.calibration.agreementMetric,
    threshold: rubric.calibration.agreementThreshold,
  };
  const fail = (
    obligation: CompactionCalibrationFailureClass,
    message: string,
    counts: { executedCompactionCount?: number; labeledCount?: number } = {},
  ): never => {
    options.onTelemetry?.({
      ...metricBase,
      outcome: "fail",
      failureClass: obligation,
      executedCompactionCount: counts.executedCompactionCount ?? 0,
      labeledCount: counts.labeledCount ?? 0,
    });
    throw new CompactionCalibrationError(message, {
      obligation,
      subjectId,
      deviceId,
    });
  };

  if (!Array.isArray(corpus)) {
    fail("compaction_calibration.invalid_corpus", "corpus must be an array");
  }
  if (corpus.length > rubric.calibration.maxTrajectoryCount) {
    fail(
      "compaction_calibration.invalid_corpus",
      `corpus exceeds ${rubric.calibration.maxTrajectoryCount} trajectories`,
    );
  }

  const selected: CompactionCalibrationTrajectory[] = [];
  for (const trajectory of corpus) {
    if (
      !trajectory ||
      typeof trajectory !== "object" ||
      !Array.isArray(trajectory.markers) ||
      trajectory.markers.length > 32 ||
      trajectory.markers.some(
        (marker) => typeof marker !== "string" || marker.length > 64,
      )
    ) {
      fail(
        "compaction_calibration.invalid_corpus",
        "trajectory markers must be a bounded string array",
        { executedCompactionCount: selected.length },
      );
    }
    if (!trajectory.markers.includes(rubric.calibration.marker)) continue;
    selected.push(trajectory);

    requireId(trajectory.trajectoryId, "trajectoryId");
    if (trajectory.subjectId !== subjectId) {
      fail(
        "compaction_calibration.subject_scope",
        "cross-subject compaction calibration denied",
        { executedCompactionCount: selected.length },
      );
    }
    if (trajectory.locality !== options.locality) {
      fail(
        "compaction_calibration.locality_violation",
        "trajectory locality does not match the calibration boundary",
        { executedCompactionCount: selected.length },
      );
    }
    if (trajectory.heldOut !== true) {
      fail(
        "compaction_calibration.not_held_out",
        "compaction calibration trajectories must be held out",
        { executedCompactionCount: selected.length },
      );
    }
    if (
      trajectory.humanOutcomeSignal !== "ACCEPTED" &&
      trajectory.humanOutcomeSignal !== "REJECTED" &&
      trajectory.humanOutcomeSignal !== "DISCARDED"
    ) {
      fail(
        "compaction_calibration.invalid_corpus",
        "humanOutcomeSignal must be ACCEPTED, REJECTED, or DISCARDED",
        { executedCompactionCount: selected.length },
      );
    }
  }

  const pairs: Array<{
    human: BinaryCompactionLabel;
    critic: BinaryCompactionLabel;
  }> = [];
  let discardedCount = 0;
  for (const trajectory of selected) {
    if (trajectory.humanOutcomeSignal === "DISCARDED") {
      discardedCount += 1;
      continue;
    }
    const score = scoreCompactionCritic(trajectory, {
      rubric,
      expectedSubjectId: subjectId,
    });
    pairs.push({
      human:
        trajectory.humanOutcomeSignal === "ACCEPTED" ? "accept" : "reject",
      critic: score.total > 0 ? "accept" : "reject",
    });
  }

  if (pairs.length < rubric.calibration.minimumTrajectoryCount) {
    fail(
      "compaction_calibration.insufficient_trajectories",
      `executed_compaction labeled count ${pairs.length} is below minimum ${rubric.calibration.minimumTrajectoryCount}`,
      {
        executedCompactionCount: selected.length,
        labeledCount: pairs.length,
      },
    );
  }

  const measured = compactionAgreement(pairs);
  const passes =
    measured.agreement >= rubric.calibration.agreementThreshold;
  const report: CompactionCalibrationReport = {
    schemaVersion: "critic.compaction-calibration.v1",
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion: rubric.rubricVersion,
    rubricContentHash: compactionRubricContentHash(rubric),
    marker: rubric.calibration.marker,
    heldOut: true,
    locality: options.locality,
    subjectId,
    corpusCount: corpus.length,
    executedCompactionCount: selected.length,
    labeledCount: pairs.length,
    discardedCount,
    skippedNonCompactionCount: corpus.length - selected.length,
    metricId: rubric.calibration.agreementMetric,
    agreement: measured.agreement,
    accuracy: measured.accuracy,
    threshold: rubric.calibration.agreementThreshold,
    minimumTrajectoryCount: rubric.calibration.minimumTrajectoryCount,
    passes,
    contingency: measured.contingency,
  };
  options.onTelemetry?.({
    ...metricBase,
    outcome: passes ? "ok" : "fail",
    ...(passes
      ? {}
      : {
          failureClass:
            "compaction_calibration.agreement_below_threshold" as const,
        }),
    executedCompactionCount: selected.length,
    labeledCount: pairs.length,
    metricValue: measured.agreement,
  });
  return report;
}

/**
 * Pure compaction critic score. Version id always comes from the rubric pin.
 */
export function scoreCompactionCritic(
  input: CompactionCriticInput,
  options?: {
    rubric?: CompactionRubricDocument;
    expectedSubjectId?: string;
    onTelemetry?: (event: CriticTelemetryEvent) => void;
  },
): CompactionCriticScore {
  const rubric = options?.rubric ?? DEFAULT_RUBRIC;
  const rubricVersion = rubric.rubricVersion;
  const subjectId = requireId(input.subjectId, "subjectId");
  const deviceId =
    input.deviceId !== undefined
      ? requireId(input.deviceId, "deviceId")
      : "unknown";

  if (
    options?.expectedSubjectId !== undefined &&
    options.expectedSubjectId !== subjectId
  ) {
    options.onTelemetry?.({
      event: "learning.critic.score",
      outcome: "fail",
      subjectId,
      deviceId,
      rubricId: COMPACTION_RUBRIC_ID,
      rubricVersion,
      failureClass: "critic.subject_scope",
    });
    throw new CriticContractError(
      "cross-subject compaction critic score denied",
      {
        obligation: "critic.subject_scope",
        subjectId,
        deviceId,
      },
    );
  }

  if (typeof input.summary !== "string") {
    throw new CriticContractError("summary must be a string", {
      obligation: "critic.invalid_score",
      subjectId,
      deviceId,
    });
  }
  if (input.summary.length > rubric.limits.maxSummaryChars) {
    throw new CriticContractError(
      `summary exceeds ${rubric.limits.maxSummaryChars} chars`,
      { obligation: "critic.invalid_score", subjectId, deviceId },
    );
  }

  const constraints = boundedStringList(
    input.requiredConstraints,
    rubric.limits.maxRequiredItems,
    "requiredConstraints",
  );
  const facts = boundedStringList(
    input.requiredVerifiedFacts,
    rubric.limits.maxRequiredItems,
    "requiredVerifiedFacts",
  );
  const citations = boundedStringList(
    input.requiredCitationRefs,
    rubric.limits.maxRequiredItems,
    "requiredCitationRefs",
  );
  const consentMarkers = boundedStringList(
    input.consentScopeMarkers,
    rubric.limits.maxConsentMarkers,
    "consentScopeMarkers",
  );

  if (isCompactionRewardHack(input)) {
    const score = {
      ...createCriticScore({ reward_hack_guard: 0 }, rubricVersion),
      rubricId: COMPACTION_RUBRIC_ID,
      hardFail: false,
      droppedConstraints: 0,
      droppedVerifiedFacts: 0,
      droppedCitations: 0,
      consentLeak: false,
    } satisfies CompactionCriticScore;
    assertCriticScore(score, rubricVersion);
    options?.onTelemetry?.({
      event: "learning.critic.score",
      outcome: "advisory",
      subjectId,
      deviceId,
      rubricId: COMPACTION_RUBRIC_ID,
      rubricVersion,
      failureClass: "critic.reward_hack",
      total: 0,
      breakdownKeys: ["reward_hack_guard"],
      contentHash: compactionRubricContentHash(rubric),
    });
    return score;
  }

  const consentLeak = detectConsentScopeLeak(input.summary, consentMarkers);
  if (consentLeak) {
    // Hard-fail floor: consent leak dominates all other components.
    const score = {
      ...createCriticScore(
        { consent_scope_leak: rubric.weights.consent_scope_leak },
        rubricVersion,
      ),
      rubricId: COMPACTION_RUBRIC_ID,
      hardFail: true,
      droppedConstraints: 0,
      droppedVerifiedFacts: 0,
      droppedCitations: 0,
      consentLeak: true,
    } satisfies CompactionCriticScore;
    assertCriticScore(score, rubricVersion);
    options?.onTelemetry?.({
      event: "learning.critic.score",
      outcome: "fail",
      subjectId,
      deviceId,
      rubricId: COMPACTION_RUBRIC_ID,
      rubricVersion,
      total: score.total,
      breakdownKeys: ["consent_scope_leak"],
      contentHash: compactionRubricContentHash(rubric),
    });
    return score;
  }

  const breakdown: Record<string, number> = {};
  let droppedConstraints = 0;
  let droppedVerifiedFacts = 0;
  let droppedCitations = 0;

  for (const constraint of constraints) {
    if (!obligationPreserved(input.summary, constraint)) {
      droppedConstraints += 1;
    }
  }
  for (const fact of facts) {
    if (!obligationPreserved(input.summary, fact)) {
      droppedVerifiedFacts += 1;
    }
  }
  for (const citation of citations) {
    if (!citationRefResolved(input.summary, citation)) {
      droppedCitations += 1;
    }
  }

  if (droppedConstraints > 0) {
    breakdown.dropped_constraint =
      rubric.weights.dropped_constraint * droppedConstraints;
  }
  if (droppedVerifiedFacts > 0) {
    breakdown.dropped_verified_fact =
      rubric.weights.dropped_verified_fact * droppedVerifiedFacts;
  }
  if (droppedCitations > 0) {
    breakdown.dropped_citation =
      rubric.weights.dropped_citation * droppedCitations;
  }

  const hasDrops =
    droppedConstraints > 0 ||
    droppedVerifiedFacts > 0 ||
    droppedCitations > 0;

  // Downstream success is outcome truth — never awarded when preservation fails.
  if (input.downstreamReplaySuccess === true && !hasDrops) {
    breakdown.downstream_replay_success =
      rubric.weights.downstream_replay_success;
  }

  if (Object.keys(breakdown).length === 0) {
    breakdown.neutral = 0;
  }

  const base = createCriticScore(breakdown, rubricVersion);
  const score: CompactionCriticScore = {
    ...base,
    rubricId: COMPACTION_RUBRIC_ID,
    hardFail: false,
    droppedConstraints,
    droppedVerifiedFacts,
    droppedCitations,
    consentLeak: false,
  };
  assertCriticScore(score, rubricVersion);

  options?.onTelemetry?.({
    event: "learning.critic.score",
    outcome: score.total < 0 ? "fail" : "ok",
    subjectId,
    deviceId,
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion,
    total: score.total,
    breakdownKeys: Object.keys(score.breakdown).sort(),
    contentHash: compactionRubricContentHash(rubric),
  });
  return score;
}

/**
 * TrajectoryCritic adapter — expects compaction fields on the record envelope.
 */
export function createCompactionCritic(options?: {
  rubric?: CompactionRubricDocument;
  onTelemetry?: (event: CriticTelemetryEvent) => void;
}): TrajectoryCritic & {
  scoreArtifact: (input: CompactionCriticInput) => CompactionCriticScore;
} {
  const rubric = options?.rubric ?? DEFAULT_RUBRIC;
  return {
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion: rubric.rubricVersion,
    scoreArtifact(input: CompactionCriticInput): CompactionCriticScore {
      return scoreCompactionCritic(input, {
        rubric,
        ...(options?.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      });
    },
    score(record): CriticScore {
      const artifact = record as unknown as CompactionCriticInput;
      return scoreCompactionCritic(
        {
          subjectId: artifact.subjectId ?? "",
          ...(artifact.deviceId !== undefined
            ? { deviceId: artifact.deviceId }
            : {}),
          summary: typeof artifact.summary === "string" ? artifact.summary : "",
          ...(artifact.requiredConstraints !== undefined
            ? { requiredConstraints: artifact.requiredConstraints }
            : {}),
          ...(artifact.requiredVerifiedFacts !== undefined
            ? { requiredVerifiedFacts: artifact.requiredVerifiedFacts }
            : {}),
          ...(artifact.requiredCitationRefs !== undefined
            ? { requiredCitationRefs: artifact.requiredCitationRefs }
            : {}),
          ...(artifact.consentScopeMarkers !== undefined
            ? { consentScopeMarkers: artifact.consentScopeMarkers }
            : {}),
          ...(artifact.downstreamReplaySuccess !== undefined
            ? { downstreamReplaySuccess: artifact.downstreamReplaySuccess }
            : {}),
          ...(artifact.emptyAnswer !== undefined
            ? { emptyAnswer: artifact.emptyAnswer }
            : {}),
          ...(artifact.toolSpam !== undefined
            ? { toolSpam: artifact.toolSpam }
            : {}),
        },
        {
          rubric,
          ...(options?.onTelemetry !== undefined
            ? { onTelemetry: options.onTelemetry }
            : {}),
        },
      );
    },
  };
}

export type CompactionHackDefenseFailureClass =
  | "compaction_hack_fixture.attack_scored_above_bound"
  | "compaction_hack_fixture.known_good_below_bound"
  | "compaction_hack_fixture.hard_fail_mismatch"
  | "compaction_hack_fixture.locality_violation";

export type CompactionHackDefenseTelemetryEvent = {
  event: "learning.critic.compaction_hack_fixture";
  outcome: "ok" | "fail";
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  rubricId: typeof COMPACTION_RUBRIC_ID;
  rubricVersion: string;
  suiteVersion: string;
  fixtureId: string;
  attackPattern: CompactionHackAttackPattern;
  total: number;
  hardFail: boolean;
  failureClass?: CompactionHackDefenseFailureClass;
  breakdownKeys: string[];
};

export type CompactionHackDefenseReport = {
  schemaVersion: "critic.compaction-hack-defense-report.v1";
  rubricId: typeof COMPACTION_RUBRIC_ID;
  rubricVersion: string;
  rubricContentHash: `sha256:${string}`;
  suiteVersion: string;
  subjectId: string;
  locality: "on-device" | "self-hosted";
  fixtureCount: number;
  passes: boolean;
  failingFixtures: string[];
  results: Array<{
    fixtureId: string;
    attackPattern: CompactionHackAttackPattern;
    total: number;
    hardFail: boolean;
    passes: boolean;
    breakdownKeys: string[];
    failureClass?: CompactionHackDefenseFailureClass;
  }>;
};

export class CompactionHackDefenseError extends Error {
  readonly obligation: CompactionHackDefenseFailureClass;
  readonly subjectId: string;
  readonly deviceId: string;
  readonly failingFixture: string;

  constructor(
    message: string,
    meta: {
      obligation: CompactionHackDefenseFailureClass;
      subjectId: string;
      deviceId: string;
      failingFixture: string;
    },
  ) {
    super(message);
    this.name = "CompactionHackDefenseError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingFixture = meta.failingFixture;
  }
}

/**
 * Run the version-pinned synthetic hack fixtures through the production critic.
 * The report and telemetry contain identifiers and score metadata only.
 */
export function runCompactionHackDefenseFixtures(options: {
  subjectId: string;
  deviceId?: string;
  locality: "on-device" | "self-hosted";
  rubric?: CompactionRubricDocument;
  onTelemetry?: (event: CompactionHackDefenseTelemetryEvent) => void;
}): CompactionHackDefenseReport {
  const rubric = options.rubric ?? DEFAULT_RUBRIC;
  const subjectId = requireId(options.subjectId, "subjectId");
  const deviceId =
    options.deviceId === undefined
      ? "unknown"
      : requireId(options.deviceId, "deviceId");
  if (
    options.locality !== "on-device" &&
    options.locality !== "self-hosted"
  ) {
    throw new CompactionHackDefenseError(
      "hack-defense locality must be on-device or self-hosted",
      {
        obligation: "compaction_hack_fixture.locality_violation",
        subjectId,
        deviceId,
        failingFixture: "(suite)",
      },
    );
  }

  const results: CompactionHackDefenseReport["results"] = [];
  for (const fixture of rubric.hackDefense.fixtures) {
    const score = scoreCompactionCritic(
      {
        subjectId,
        deviceId,
        ...fixture.input,
      },
      { rubric, expectedSubjectId: subjectId },
    );
    const totalPasses =
      fixture.expected.maxTotal !== undefined
        ? score.total <= fixture.expected.maxTotal
        : score.total >= fixture.expected.minTotal!;
    const hardFailPasses = score.hardFail === fixture.expected.hardFail;
    let failureClass: CompactionHackDefenseFailureClass | undefined;
    if (!hardFailPasses) {
      failureClass = "compaction_hack_fixture.hard_fail_mismatch";
    } else if (!totalPasses && fixture.attackPattern === "known_good") {
      failureClass = "compaction_hack_fixture.known_good_below_bound";
    } else if (!totalPasses) {
      failureClass = "compaction_hack_fixture.attack_scored_above_bound";
    }
    const breakdownKeys = Object.keys(score.breakdown).sort();
    const passes = failureClass === undefined;
    results.push({
      fixtureId: fixture.id,
      attackPattern: fixture.attackPattern,
      total: score.total,
      hardFail: score.hardFail,
      passes,
      breakdownKeys,
      ...(failureClass !== undefined ? { failureClass } : {}),
    });
    options.onTelemetry?.({
      event: "learning.critic.compaction_hack_fixture",
      outcome: passes ? "ok" : "fail",
      subjectId,
      deviceId,
      locality: options.locality,
      rubricId: COMPACTION_RUBRIC_ID,
      rubricVersion: rubric.rubricVersion,
      suiteVersion: rubric.hackDefense.suiteVersion,
      fixtureId: fixture.id,
      attackPattern: fixture.attackPattern,
      total: score.total,
      hardFail: score.hardFail,
      breakdownKeys,
      ...(failureClass !== undefined ? { failureClass } : {}),
    });
  }

  const failingFixtures = results
    .filter((result) => !result.passes)
    .map((result) => result.fixtureId);
  return {
    schemaVersion: "critic.compaction-hack-defense-report.v1",
    rubricId: COMPACTION_RUBRIC_ID,
    rubricVersion: rubric.rubricVersion,
    rubricContentHash: compactionRubricContentHash(rubric),
    suiteVersion: rubric.hackDefense.suiteVersion,
    subjectId,
    locality: options.locality,
    fixtureCount: results.length,
    passes: failingFixtures.length === 0,
    failingFixtures,
    results,
  };
}

export function assertCompactionHackDefensePasses(options: {
  subjectId: string;
  deviceId?: string;
  locality: "on-device" | "self-hosted";
  rubric?: CompactionRubricDocument;
  onTelemetry?: (event: CompactionHackDefenseTelemetryEvent) => void;
}): CompactionHackDefenseReport {
  const report = runCompactionHackDefenseFixtures(options);
  const failed = report.results.find((result) => !result.passes);
  if (!failed || failed.failureClass === undefined) return report;
  throw new CompactionHackDefenseError(
    `compaction hack fixture ${failed.fixtureId} failed (${failed.failureClass})`,
    {
      obligation: failed.failureClass,
      subjectId: report.subjectId,
      deviceId: options.deviceId ?? "unknown",
      failingFixture: failed.fixtureId,
    },
  );
}
