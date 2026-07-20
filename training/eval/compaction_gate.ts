/**
 * Full learned-compaction eval-suite loader.
 *
 * Source scenarios remain owned by the B5 runtime harness. This loader verifies
 * their frozen hashes and projects them into the C6 metadata-only gate suite.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_EVAL_SUITE_ID,
  CompactionEvalContractError,
  assembleCompactionEvalSuite,
  computeCompactionEvalContentHash,
  proveCompactionPromotionGateCi,
  runCompactionPromotionGate,
  type B5CompactionGoldenCase,
  type B5CompactionGoldenManifest,
  type CompactionCandidateEvaluator,
  type CompactionCiGateTelemetryEvent,
  type CompactionEvalSuite,
  type CompactionEvalTelemetryEvent,
  type CompactionPromotionTelemetryEvent,
  type CompactionPromotionVerdict,
} from "../../packages/learning/src/compaction_promotion.ts";

export const B5_COMPACTION_GOLDEN_DIR =
  "packages/runtime-harness/fixtures/compaction-retention" as const;
export const B5_COMPACTION_MANIFEST_HASH =
  "sha256:54cc630a93170b9f50637b1ac11033c77c2a8a1b64f5c15da140a541b5a1b91a" as const;
export const B5_COMPACTION_CASES_HASH =
  "sha256:3310024642d738deba6c1c7c379a438db5b37232b4c76196ca1a8a99d01b36e6" as const;
export const COMPACTION_EVAL_PINNED_SEED = 6_601;
export const COMPACTION_EVAL_RUBRIC_ID = "critic.compaction" as const;
export const COMPACTION_EVAL_RUBRIC_VERSION = "1.0.0" as const;

function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sourceFailure(input: {
  message: string;
  subjectId: string;
  deviceId: string;
  onTelemetry?: (event: CompactionEvalTelemetryEvent) => void;
}): never {
  input.onTelemetry?.({
    event: "learning.compaction_eval.assemble",
    outcome: "fail",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    suiteId: COMPACTION_EVAL_SUITE_ID,
    failureClass: "compaction_eval.invalid_source",
  });
  throw new CompactionEvalContractError(input.message, {
    obligation: "compaction_eval.invalid_source",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
  });
}

function readPinnedJson(input: {
  absolutePath: string;
  label: string;
  subjectId: string;
  deviceId: string;
  onTelemetry?: (event: CompactionEvalTelemetryEvent) => void;
}): { bytes: Buffer; parsed: Record<string, unknown> } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.absolutePath);
  } catch {
    return sourceFailure({
      ...input,
      message: `${input.label} is missing`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return sourceFailure({
      ...input,
      message: `${input.label} must be valid JSON`,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sourceFailure({
      ...input,
      message: `${input.label} must be an object`,
    });
  }
  return { bytes, parsed: parsed as Record<string, unknown> };
}

export function loadFullCompactionEvalSuite(options: {
  expectedSubjectId: string;
  locality: "on-device" | "self-hosted";
  trainingCorpusContentHashes: readonly string[];
  deviceId?: string;
  repoRoot?: string;
  onTelemetry?: (event: CompactionEvalTelemetryEvent) => void;
}): CompactionEvalSuite {
  const root = options.repoRoot ?? repoRootFromHere();
  const deviceId = options.deviceId ?? "ci";
  const fixtureDir = join(root, B5_COMPACTION_GOLDEN_DIR);
  const common = {
    subjectId: options.expectedSubjectId,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  };
  const manifestFile = readPinnedJson({
    ...common,
    absolutePath: join(fixtureDir, "manifest.json"),
    label: "B5 compaction manifest",
  });
  const casesFile = readPinnedJson({
    ...common,
    absolutePath: join(fixtureDir, "cases.json"),
    label: "B5 compaction cases",
  });
  if (
    !Array.isArray(manifestFile.parsed.requiredCases) ||
    !Array.isArray(casesFile.parsed.cases)
  ) {
    return sourceFailure({
      ...common,
      message: "B5 compaction source requires requiredCases and cases arrays",
    });
  }

  return assembleCompactionEvalSuite({
    manifest: manifestFile.parsed as unknown as B5CompactionGoldenManifest,
    cases: casesFile.parsed.cases as B5CompactionGoldenCase[],
    manifestContentHash: computeCompactionEvalContentHash(manifestFile.bytes),
    casesContentHash: computeCompactionEvalContentHash(casesFile.bytes),
    expectedManifestContentHash: B5_COMPACTION_MANIFEST_HASH,
    expectedCasesContentHash: B5_COMPACTION_CASES_HASH,
    trainingCorpusContentHashes: options.trainingCorpusContentHashes,
    pinnedSeed: COMPACTION_EVAL_PINNED_SEED,
    subjectId: options.expectedSubjectId,
    deviceId,
    locality: options.locality,
    rubricId: COMPACTION_EVAL_RUBRIC_ID,
    rubricVersion: COMPACTION_EVAL_RUBRIC_VERSION,
    surgeryClasses: ["learned_compaction"],
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

export async function runFullCompactionPromotionGate(options: {
  expectedSubjectId: string;
  locality: "on-device" | "self-hosted";
  trainingCorpusContentHashes: readonly string[];
  deviceId?: string;
  repoRoot?: string;
  champion: CompactionCandidateEvaluator;
  challenger: CompactionCandidateEvaluator;
  onTelemetry?: (
    event: CompactionEvalTelemetryEvent | CompactionPromotionTelemetryEvent,
  ) => void;
}): Promise<CompactionPromotionVerdict> {
  const deviceId = options.deviceId ?? "ci";
  const suite = loadFullCompactionEvalSuite({
    expectedSubjectId: options.expectedSubjectId,
    locality: options.locality,
    trainingCorpusContentHashes: options.trainingCorpusContentHashes,
    deviceId,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.onTelemetry !== undefined
      ? {
          onTelemetry: (event) => options.onTelemetry?.(event),
        }
      : {}),
  });
  return runCompactionPromotionGate({
    suite,
    champion: options.champion,
    challenger: options.challenger,
    deviceId,
    ...(options.onTelemetry !== undefined
      ? {
          onTelemetry: (event) => options.onTelemetry?.(event),
        }
      : {}),
  });
}

/**
 * CI entry: load frozen B5 suite and prove flag-off parity, seeded promote,
 * tie/regression rejects, idempotent replay, and subject isolation.
 */
export async function proveFullCompactionGateCi(options?: {
  expectedSubjectId?: string;
  locality?: "on-device" | "self-hosted";
  trainingCorpusContentHashes?: readonly string[];
  deviceId?: string;
  repoRoot?: string;
  onTelemetry?: (
    event:
      | CompactionEvalTelemetryEvent
      | CompactionPromotionTelemetryEvent
      | CompactionCiGateTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  flagOffParity: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  seededPromote: Extract<CompactionPromotionVerdict, { verdict: "promote" }>;
  tieReject: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  regressionReject: Extract<CompactionPromotionVerdict, { verdict: "reject" }>;
  replayOk: true;
}> {
  const expectedSubjectId = options?.expectedSubjectId ?? "anika-k";
  const locality = options?.locality ?? "on-device";
  const deviceId = options?.deviceId ?? "ci-compaction-gate";
  const suite = loadFullCompactionEvalSuite({
    expectedSubjectId,
    locality,
    trainingCorpusContentHashes: options?.trainingCorpusContentHashes ?? [],
    deviceId,
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options?.onTelemetry !== undefined
      ? {
          onTelemetry: (event) => options.onTelemetry?.(event),
        }
      : {}),
  });
  return proveCompactionPromotionGateCi({
    suite,
    deviceId,
    ...(options?.onTelemetry !== undefined
      ? {
          onTelemetry: (event) => options.onTelemetry?.(event),
        }
      : {}),
  });
}
