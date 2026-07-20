/**
 * LLM-judge agreement eval gate — held-out tone/clarity fixtures (C3).
 *
 * Independent of the main critic calibration gate. Judge versions enter
 * training config only when agreement ≥ threshold on this held-out set.
 *
 * Law: docs/learning/LLM_JUDGE_POLICY.md
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TRAJECTORY_SCHEMA_VERSION } from "../trajectory_schema.js";
import {
  computeCohenKappa,
  type AgreementMetricResult,
  type BinaryCalibrationLabel,
} from "./calibration.js";
import {
  createIsolatedLlmJudgeLane,
  type LlmJudgeAspectScoreFn,
} from "./llm_judge_lane.js";
import {
  LLM_JUDGE_ALLOWED_ASPECTS,
  LLM_JUDGE_DEFAULT_AGREEMENT_THRESHOLD,
  LLM_JUDGE_FORBIDDEN_DOMAINS,
  LlmJudgePolicyContractError,
  assertAllowedLlmJudgeAspect,
  assertLlmJudgeIdentityPinned,
  assertNotForbiddenLlmJudgeDomain,
  type LlmJudgeAspect,
  type LlmJudgePolicyFailureClass,
} from "./llm_judge_policy.js";

export const LLM_JUDGE_EVAL_SET_SCHEMA_VERSION =
  "llm-judge.eval-set.v1" as const;
export const LLM_JUDGE_EVAL_ENTRY_SCHEMA_VERSION =
  "llm-judge.eval-entry.v1" as const;

/** Repo-relative root for held-out tone/clarity judge fixtures. */
export const LLM_JUDGE_EVAL_SETS_RELPATH =
  "training/eval/llm_judge_sets" as const;

/** Must stay distinct from critic human-label calibration sets. */
export const LLM_JUDGE_CALIBRATION_SETS_RELPATH =
  "training/eval/calibration_sets" as const;

export const LLM_JUDGE_EVAL_ENTRY_LIMIT = 64;
export const LLM_JUDGE_EVAL_ID_LIMIT = 128;
export const LLM_JUDGE_GATE_CI_SCRIPT = "llm-judge-gate:check" as const;

export const LLM_JUDGE_HUMAN_LABELS = Object.freeze(["pass", "fail"] as const);
export type LlmJudgeHumanLabel = (typeof LLM_JUDGE_HUMAN_LABELS)[number];

const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "contentHash must be sha256:<64 hex>");

export const llmJudgeEvalEntrySchema = z
  .object({
    id: z.string().min(1).max(LLM_JUDGE_EVAL_ID_LIMIT),
    file: z.string().min(1).max(256),
    contentHash: contentHashSchema,
    aspect: z.enum(["clarity", "tone"]),
    humanLabel: z.enum(["pass", "fail"]),
    locality: z.enum(["on-device", "self-hosted"]),
    subjectId: z.string().min(1).max(LLM_JUDGE_EVAL_ID_LIMIT),
    deviceId: z.string().min(1).max(LLM_JUDGE_EVAL_ID_LIMIT),
    turnId: z.string().min(1).max(LLM_JUDGE_EVAL_ID_LIMIT),
  })
  .strict();

export const llmJudgeEvalSetManifestSchema = z
  .object({
    schemaVersion: z.literal(LLM_JUDGE_EVAL_SET_SCHEMA_VERSION),
    setId: z.string().min(1).max(LLM_JUDGE_EVAL_ID_LIMIT),
    heldOut: z.literal(true),
    excludeFromTrainingCorpora: z.literal(true),
    /** Independence: must not feed the main critic calibration gate. */
    excludeFromCriticCalibration: z.literal(true),
    pinnedSeed: z.number().int().min(0).max(0xffff_ffff),
    defaultAgreementThreshold: z.number().min(0).max(1),
    locality: z.enum(["on-device", "self-hosted"]),
    entries: z
      .array(llmJudgeEvalEntrySchema)
      .min(1)
      .max(LLM_JUDGE_EVAL_ENTRY_LIMIT),
  })
  .strict();

export type LlmJudgeEvalSetEntry = z.infer<typeof llmJudgeEvalEntrySchema>;
export type LlmJudgeEvalSetManifest = z.infer<
  typeof llmJudgeEvalSetManifestSchema
>;

export type LlmJudgeEvalEntryDocument = {
  schemaVersion: typeof LLM_JUDGE_EVAL_ENTRY_SCHEMA_VERSION;
  id: string;
  aspect: LlmJudgeAspect;
  subjectId: string;
  deviceId: string;
  turnId: string;
  locality: "on-device" | "self-hosted";
  humanLabel: LlmJudgeHumanLabel;
};

export type LoadedLlmJudgeEvalEntry = LlmJudgeEvalSetEntry & {
  document: LlmJudgeEvalEntryDocument;
};

export type LoadedLlmJudgeEvalSet = {
  relpath: typeof LLM_JUDGE_EVAL_SETS_RELPATH;
  manifest: LlmJudgeEvalSetManifest;
  entries: LoadedLlmJudgeEvalEntry[];
  /** Opaque sha256 of sorted entry content hashes — training pin surface. */
  setContentHash: string;
};

export type LlmJudgeGateTelemetryEvent = {
  event: "learning.critic.llm_judge_gate";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  aspect?: LlmJudgeAspect;
  judgeModelId?: string;
  judgePromptVersion?: string;
  failureClass?: LlmJudgePolicyFailureClass;
  agreementValue?: number;
  threshold?: number;
  setId?: string;
  idempotentReplay?: boolean;
};

export type LlmJudgeAspectAgreement = {
  aspect: LlmJudgeAspect;
  n: number;
  metricId: "cohen_kappa";
  value: number;
  accuracy: number;
  passesThreshold: boolean;
  contingency: AgreementMetricResult["contingency"];
};

export type LlmJudgeAgreementReport = {
  schemaVersion: "llm-judge.agreement.v1";
  setId: string;
  setContentHash: string;
  judgeModelId: string;
  judgePromptVersion: string;
  metricId: "cohen_kappa";
  threshold: number;
  overall: AgreementMetricResult & {
    value: number;
    passesThreshold: boolean;
  };
  byAspect: LlmJudgeAspectAgreement[];
  failingAspects: LlmJudgeAspect[];
  trainingConfigAllowed: boolean;
};

export type LlmJudgeGatePin = {
  judgeModelId: string;
  judgePromptVersion: string;
  setId: string;
  setContentHash: string;
  agreementValue: number;
  threshold: number;
  trainingConfigAllowed: true;
};

export type LlmJudgeGateVerdict =
  | {
      ok: true;
      verdict: "promote";
      report: LlmJudgeAgreementReport;
      pin: LlmJudgeGatePin;
    }
  | {
      ok: false;
      verdict: "reject";
      report: LlmJudgeAgreementReport;
      detail: string;
      failingAspects: LlmJudgeAspect[];
    };

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function humanLabelToBinary(label: LlmJudgeHumanLabel): BinaryCalibrationLabel {
  return label === "pass" ? "accept" : "reject";
}

function scoreToBinary(score: number): BinaryCalibrationLabel {
  return score >= 0 ? "accept" : "reject";
}

/**
 * Load + verify held-out LLM-judge tone/clarity eval set.
 */
export function loadLlmJudgeEvalSet(opts?: {
  repoRoot?: string;
  onTelemetry?: (e: LlmJudgeGateTelemetryEvent) => void;
}): LoadedLlmJudgeEvalSet {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const relDir = LLM_JUDGE_EVAL_SETS_RELPATH;
  const manifestPath = path.join(root, relDir, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_gate",
      outcome: "fail",
      subjectId: "llm-judge-gate",
      deviceId: "ci",
      failureClass: "llm_judge.source_missing",
    });
    throw new LlmJudgePolicyContractError(
      `LLM judge eval set missing: ${relDir}/manifest.json`,
      { obligation: "llm_judge.source_missing" },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmJudgePolicyContractError(
      "LLM judge eval manifest is not valid JSON",
      { obligation: "llm_judge.schema_violation" },
    );
  }

  const manifestResult = llmJudgeEvalSetManifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    throw new LlmJudgePolicyContractError(
      `LLM judge eval manifest schema violation: ${manifestResult.error.issues[0]?.message ?? "invalid"}`,
      {
        obligation: "llm_judge.schema_violation",
        failingSlice:
          manifestResult.error.issues[0]?.path.join(".") || "manifest",
      },
    );
  }
  const manifest = manifestResult.data;

  if (!manifest.heldOut || !manifest.excludeFromCriticCalibration) {
    throw new LlmJudgePolicyContractError(
      "LLM judge eval set must be heldOut and excludeFromCriticCalibration",
      { obligation: "llm_judge.not_held_out" },
    );
  }

  if (manifest.entries.length > LLM_JUDGE_EVAL_ENTRY_LIMIT) {
    throw new LlmJudgePolicyContractError(
      "LLM judge eval set exceeds entry cap",
      { obligation: "llm_judge.section_limit" },
    );
  }

  const seenIds = new Set<string>();
  const loaded: LoadedLlmJudgeEvalEntry[] = [];
  const hashParts: string[] = [];

  for (const entry of manifest.entries) {
    if (seenIds.has(entry.id)) {
      throw new LlmJudgePolicyContractError(
        `duplicate LLM judge eval entry id ${entry.id}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: entry.id,
        },
      );
    }
    seenIds.add(entry.id);

    assertAllowedLlmJudgeAspect(entry.aspect);
    assertNotForbiddenLlmJudgeDomain(entry.aspect);

    if (
      entry.file.includes("..") ||
      path.isAbsolute(entry.file) ||
      !entry.file.startsWith("entries/")
    ) {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry path escape: ${entry.file}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: entry.id,
        },
      );
    }

    const abs = path.join(root, relDir, entry.file);
    let fileText: string;
    try {
      fileText = readFileSync(abs, "utf8");
    } catch {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry missing: ${entry.file}`,
        {
          obligation: "llm_judge.source_missing",
          failingSlice: entry.id,
        },
      );
    }

    const digest = `sha256:${sha256Hex(fileText)}`;
    if (digest !== entry.contentHash) {
      opts?.onTelemetry?.({
        event: "learning.critic.llm_judge_gate",
        outcome: "fail",
        subjectId: entry.subjectId,
        deviceId: entry.deviceId,
        aspect: entry.aspect,
        failureClass: "llm_judge.hash_mismatch",
      });
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry hash mismatch for ${entry.id}`,
        {
          obligation: "llm_judge.hash_mismatch",
          failingSlice: entry.id,
          subjectId: entry.subjectId,
          deviceId: entry.deviceId,
        },
      );
    }

    let docParsed: unknown;
    try {
      docParsed = JSON.parse(fileText);
    } catch {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry is not valid JSON: ${entry.id}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: entry.id,
        },
      );
    }

    const doc = docParsed as Record<string, unknown>;
    if (
      doc.schemaVersion !== LLM_JUDGE_EVAL_ENTRY_SCHEMA_VERSION ||
      doc.id !== entry.id ||
      doc.aspect !== entry.aspect ||
      doc.humanLabel !== entry.humanLabel ||
      doc.subjectId !== entry.subjectId ||
      typeof doc.subjectId !== "string" ||
      doc.subjectId.length === 0
    ) {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry metadata mismatch: ${entry.id}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: entry.id,
        },
      );
    }

    if (
      /"utterance"\s*:/.test(fileText) ||
      /"keystrokes"\s*:/.test(fileText) ||
      /"prompt"\s*:/.test(fileText) ||
      /"completion"\s*:/.test(fileText)
    ) {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval entry embeds forbidden content keys: ${entry.id}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: "sovereignty",
          subjectId: entry.subjectId,
        },
      );
    }

    const document: LlmJudgeEvalEntryDocument = {
      schemaVersion: LLM_JUDGE_EVAL_ENTRY_SCHEMA_VERSION,
      id: entry.id,
      aspect: entry.aspect,
      subjectId: entry.subjectId,
      deviceId: entry.deviceId,
      turnId: entry.turnId,
      locality: entry.locality,
      humanLabel: entry.humanLabel,
    };

    loaded.push({ ...entry, document });
    hashParts.push(entry.contentHash);
  }

  for (const aspect of LLM_JUDGE_ALLOWED_ASPECTS) {
    if (!loaded.some((e) => e.aspect === aspect)) {
      throw new LlmJudgePolicyContractError(
        `LLM judge eval set missing aspect ${aspect}`,
        {
          obligation: "llm_judge.insufficient_pairs",
          failingSlice: aspect,
        },
      );
    }
  }

  hashParts.sort();
  const setContentHash = `sha256:${sha256Hex(hashParts.join("\n"))}`;

  opts?.onTelemetry?.({
    event: "learning.critic.llm_judge_gate",
    outcome: "ok",
    subjectId: "llm-judge-gate",
    deviceId: "ci",
    setId: manifest.setId,
  });

  return {
    relpath: LLM_JUDGE_EVAL_SETS_RELPATH,
    manifest,
    entries: loaded,
    setContentHash,
  };
}

/**
 * Predict binary labels from an injected aspect scorer (one aspect per call).
 */
export function predictLlmJudgeLabelsOnEvalSet(
  set: LoadedLlmJudgeEvalSet,
  opts: {
    judgeModelId: string;
    judgePromptVersion: string;
    scoreAspectFn: LlmJudgeAspectScoreFn;
    onTelemetry?: (e: LlmJudgeGateTelemetryEvent) => void;
  },
): Map<string, BinaryCalibrationLabel> {
  assertLlmJudgeIdentityPinned({
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
  });

  const lane = createIsolatedLlmJudgeLane({
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    scoreAspectFn: opts.scoreAspectFn,
  });

  const out = new Map<string, BinaryCalibrationLabel>();
  const critics = {
    tone: lane.createAspectCritic("tone"),
    clarity: lane.createAspectCritic("clarity"),
  };

  for (const entry of set.entries) {
    assertNotForbiddenLlmJudgeDomain(entry.aspect);
    for (const forbidden of LLM_JUDGE_FORBIDDEN_DOMAINS) {
      if (entry.aspect === (forbidden as string)) {
        throw new LlmJudgePolicyContractError(
          `LLM judge gate must not score ${forbidden}`,
          {
            obligation: "llm_judge.forbidden_domain",
            failingSlice: forbidden,
          },
        );
      }
    }

    const critic = critics[entry.aspect];
    const record = {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      subjectId: entry.subjectId,
      sessionId: `sess.lj.${entry.id}`,
      turnId: entry.turnId,
      deviceId: entry.deviceId,
      capturedAt: "2026-07-16T12:00:00.000Z",
      locality: entry.locality,
      consent: {
        optedIn: true,
        consentClass: "research" as const,
        recordedAt: "2026-07-16T12:00:00.000Z",
      },
      stages: [{ stage: "act", status: "ok" as const }],
    };
    const score = critic.score(record);
    const aspectScore = score.breakdown[entry.aspect];
    if (typeof aspectScore !== "number" || !Number.isFinite(aspectScore)) {
      throw new LlmJudgePolicyContractError(
        `missing aspect score for ${entry.id}`,
        {
          obligation: "llm_judge.schema_violation",
          failingSlice: entry.id,
          subjectId: entry.subjectId,
        },
      );
    }
    out.set(entry.id, scoreToBinary(aspectScore));
  }

  return out;
}

/**
 * Compute judge–human agreement (Cohen kappa) with per-aspect breakdown.
 */
export function computeLlmJudgeHumanAgreement(opts: {
  set: LoadedLlmJudgeEvalSet;
  judgeLabels:
    | ReadonlyMap<string, BinaryCalibrationLabel>
    | Readonly<Record<string, BinaryCalibrationLabel>>;
  judgeModelId: string;
  judgePromptVersion: string;
  threshold?: number;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: LlmJudgeGateTelemetryEvent) => void;
}): LlmJudgeAgreementReport {
  assertLlmJudgeIdentityPinned({
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });

  if (!opts.set.manifest.heldOut) {
    throw new LlmJudgePolicyContractError(
      "agreement metrics require a held-out LLM judge eval set",
      { obligation: "llm_judge.not_held_out" },
    );
  }

  const threshold =
    opts.threshold ?? opts.set.manifest.defaultAgreementThreshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new LlmJudgePolicyContractError(
      "agreement threshold must be a finite number in [0, 1]",
      { obligation: "llm_judge.schema_violation" },
    );
  }

  const subjectId = opts.subjectId ?? "llm-judge-gate";
  const deviceId = opts.deviceId ?? "ci";
  const labelMap =
    opts.judgeLabels instanceof Map
      ? opts.judgeLabels
      : new Map(Object.entries(opts.judgeLabels));

  const pairs: {
    human: BinaryCalibrationLabel;
    critic: BinaryCalibrationLabel;
  }[] = [];
  const byAspectPairs = new Map<
    LlmJudgeAspect,
    { human: BinaryCalibrationLabel; critic: BinaryCalibrationLabel }[]
  >();
  for (const aspect of LLM_JUDGE_ALLOWED_ASPECTS) {
    byAspectPairs.set(aspect, []);
  }

  for (const entry of opts.set.entries) {
    const predicted = labelMap.get(entry.id);
    if (predicted === undefined) {
      throw new LlmJudgePolicyContractError(
        `missing judge prediction for ${entry.id}`,
        {
          obligation: "llm_judge.insufficient_pairs",
          failingSlice: entry.id,
          subjectId: entry.subjectId,
        },
      );
    }
    if (!entry.subjectId) {
      throw new LlmJudgePolicyContractError("subjectId required on eval entry", {
        obligation: "llm_judge.subject_scope",
        failingSlice: entry.id,
      });
    }
    const pair = {
      human: humanLabelToBinary(entry.humanLabel),
      critic: predicted,
    };
    pairs.push(pair);
    byAspectPairs.get(entry.aspect)!.push(pair);
  }

  if (pairs.length === 0) {
    throw new LlmJudgePolicyContractError(
      "LLM judge agreement requires at least one pair",
      { obligation: "llm_judge.insufficient_pairs" },
    );
  }

  const overallMetric = computeCohenKappa(pairs);
  const overallValue = overallMetric.kappa;
  const overallPasses = overallValue >= threshold;

  const byAspect: LlmJudgeAspectAgreement[] = [];
  const failingAspects: LlmJudgeAspect[] = [];

  for (const aspect of LLM_JUDGE_ALLOWED_ASPECTS) {
    const aspectPairs = byAspectPairs.get(aspect) ?? [];
    if (aspectPairs.length === 0) {
      failingAspects.push(aspect);
      byAspect.push({
        aspect,
        n: 0,
        metricId: "cohen_kappa",
        value: 0,
        accuracy: 0,
        passesThreshold: false,
        contingency: { aa: 0, ar: 0, ra: 0, rr: 0 },
      });
      continue;
    }
    const m = computeCohenKappa(aspectPairs);
    const passes = m.kappa >= threshold;
    if (!passes) failingAspects.push(aspect);
    byAspect.push({
      aspect,
      n: m.n,
      metricId: "cohen_kappa",
      value: m.kappa,
      accuracy: m.accuracy,
      passesThreshold: passes,
      contingency: m.contingency,
    });
  }

  const trainingConfigAllowed =
    overallPasses && failingAspects.length === 0;

  const report: LlmJudgeAgreementReport = {
    schemaVersion: "llm-judge.agreement.v1",
    setId: opts.set.manifest.setId,
    setContentHash: opts.set.setContentHash,
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    metricId: "cohen_kappa",
    threshold,
    overall: {
      ...overallMetric,
      value: overallValue,
      passesThreshold: overallPasses,
    },
    byAspect,
    failingAspects,
    trainingConfigAllowed,
  };

  opts.onTelemetry?.({
    event: "learning.critic.llm_judge_gate",
    outcome: trainingConfigAllowed ? "ok" : "fail",
    subjectId,
    deviceId,
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    agreementValue: overallValue,
    threshold,
    setId: opts.set.manifest.setId,
    ...(trainingConfigAllowed
      ? {}
      : {
          failureClass:
            "llm_judge.agreement_below_threshold" as LlmJudgePolicyFailureClass,
        }),
  });

  return report;
}

/**
 * Run the independent LLM-judge agreement gate for a pinned judge identity.
 */
export function runLlmJudgeAgreementGate(opts: {
  set: LoadedLlmJudgeEvalSet;
  judgeModelId: string;
  judgePromptVersion: string;
  scoreAspectFn: LlmJudgeAspectScoreFn;
  threshold?: number;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: LlmJudgeGateTelemetryEvent) => void;
}): LlmJudgeGateVerdict {
  const labels = predictLlmJudgeLabelsOnEvalSet(opts.set, {
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    scoreAspectFn: opts.scoreAspectFn,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  const report = computeLlmJudgeHumanAgreement({
    set: opts.set,
    judgeLabels: labels,
    judgeModelId: opts.judgeModelId,
    judgePromptVersion: opts.judgePromptVersion,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (report.trainingConfigAllowed) {
    return {
      ok: true,
      verdict: "promote",
      report,
      pin: {
        judgeModelId: opts.judgeModelId,
        judgePromptVersion: opts.judgePromptVersion,
        setId: report.setId,
        setContentHash: report.setContentHash,
        agreementValue: report.overall.value,
        threshold: report.threshold,
        trainingConfigAllowed: true,
      },
    };
  }

  const detail = `agreement ${report.metricId}=${report.overall.value} below threshold ${report.threshold}${
    report.failingAspects.length > 0
      ? ` failingAspects=${report.failingAspects.join(",")}`
      : ""
  }`;

  return {
    ok: false,
    verdict: "reject",
    report,
    detail,
    failingAspects: report.failingAspects,
  };
}

/**
 * Known-good oracle: mirrors human labels by turn/aspect (deterministic, no network).
 */
export function createOracleLlmJudgeScoreFn(
  set: LoadedLlmJudgeEvalSet,
): LlmJudgeAspectScoreFn {
  const byTurn = new Map<string, LlmJudgeHumanLabel>();
  for (const e of set.entries) {
    byTurn.set(`${e.subjectId}\0${e.turnId}\0${e.aspect}`, e.humanLabel);
  }
  return (input) => {
    const key = `${input.subjectId}\0${input.turnId}\0${input.aspect}`;
    const label = byTurn.get(key);
    if (label === undefined) {
      throw new LlmJudgePolicyContractError(
        `oracle has no label for aspect ${input.aspect}`,
        {
          obligation: "llm_judge.insufficient_pairs",
          failingSlice: input.turnId,
          subjectId: input.subjectId,
        },
      );
    }
    return label === "pass" ? 0.5 : -0.5;
  };
}

/** Known-bad oracle: always positive — must fail the agreement gate. */
export function createAlwaysPassLlmJudgeScoreFn(): LlmJudgeAspectScoreFn {
  return () => 1;
}

/**
 * CI entry: known-good oracle promotes; known-bad always-pass rejects.
 * Independent of `calibration:check` — does not load critic calibration sets.
 */
export function proveLlmJudgeAgreementGate(opts?: {
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  judgeModelId?: string;
  judgePromptVersion?: string;
  threshold?: number;
  onTelemetry?: (e: LlmJudgeGateTelemetryEvent) => void;
}): {
  ok: true;
  champion: Extract<LlmJudgeGateVerdict, { ok: true }>;
  knownBad: Extract<LlmJudgeGateVerdict, { ok: false }>;
} {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const subjectId = opts?.subjectId ?? "llm-judge-gate";
  const deviceId = opts?.deviceId ?? "ci";
  const judgeModelId = opts?.judgeModelId ?? "judge.tone-clarity.ci-v1";
  const judgePromptVersion =
    opts?.judgePromptVersion ?? "prompt.tone-clarity.1.0.0";

  const set = loadLlmJudgeEvalSet({
    repoRoot: root,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (!set.manifest.excludeFromCriticCalibration) {
    throw new LlmJudgePolicyContractError(
      "judge gate set must excludeFromCriticCalibration",
      { obligation: "llm_judge.calibration_independence" },
    );
  }

  const threshold =
    opts?.threshold ??
    set.manifest.defaultAgreementThreshold ??
    LLM_JUDGE_DEFAULT_AGREEMENT_THRESHOLD;

  const champion = runLlmJudgeAgreementGate({
    set,
    judgeModelId,
    judgePromptVersion,
    scoreAspectFn: createOracleLlmJudgeScoreFn(set),
    threshold,
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (!champion.ok) {
    throw new LlmJudgePolicyContractError(
      `known-good LLM judge failed agreement gate: ${champion.detail}`,
      {
        obligation: "llm_judge.gate_rejected",
        failingSlice: champion.failingAspects[0] ?? "(overall)",
        subjectId,
        deviceId,
      },
    );
  }

  const knownBad = runLlmJudgeAgreementGate({
    set,
    judgeModelId: `${judgeModelId}.known-bad`,
    judgePromptVersion,
    scoreAspectFn: createAlwaysPassLlmJudgeScoreFn(),
    threshold,
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (knownBad.ok) {
    throw new LlmJudgePolicyContractError(
      "known-bad always-pass judge unexpectedly promoted — gate is broken",
      {
        obligation: "llm_judge.schema_violation",
        subjectId,
        deviceId,
      },
    );
  }

  const replay = runLlmJudgeAgreementGate({
    set,
    judgeModelId: `${judgeModelId}.known-bad`,
    judgePromptVersion,
    scoreAspectFn: createAlwaysPassLlmJudgeScoreFn(),
    threshold,
    subjectId,
    deviceId,
  });
  if (replay.ok || replay.detail !== knownBad.detail) {
    opts?.onTelemetry?.({
      event: "learning.critic.llm_judge_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "llm_judge.schema_violation",
    });
    throw new LlmJudgePolicyContractError(
      "LLM judge agreement gate replay is not idempotent",
      { obligation: "llm_judge.schema_violation", subjectId, deviceId },
    );
  }

  opts?.onTelemetry?.({
    event: "learning.critic.llm_judge_gate",
    outcome: "ok",
    subjectId,
    deviceId,
    judgeModelId,
    judgePromptVersion,
    agreementValue: champion.report.overall.value,
    threshold,
    setId: set.manifest.setId,
    idempotentReplay: true,
  });

  return { ok: true, champion, knownBad };
}
