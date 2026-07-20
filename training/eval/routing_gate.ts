/**
 * Frozen B8 guidance-eval loader and routing promotion gate entry point.
 *
 * The loader pins every registered scenario by hash and projects only
 * metadata into the learning gate. Raw learner/user content is never present.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RoutingGateContractError,
  assembleB8GuidanceEvalSuite,
  proveRoutingPromotionGateCi,
  runRoutingPromotionGate,
  type B8GuidanceEvalScenario,
  type B8GuidanceEvalSuite,
  type RoutingCiGateTelemetryEvent,
  type RoutingGateCandidateEvaluator,
  type RoutingPromotionTelemetryEvent,
  type RoutingPromotionVerdict,
} from "../../packages/learning/src/routing_promotion.ts";

export const B8_GUIDANCE_EVAL_DIR =
  "training/eval/fixtures/b8-guidance" as const;
export const B8_GUIDANCE_MANIFEST_HASH =
  "sha256:6006108b4e3331f65294e42922a2dcba4b4c0c39136d53d582b7e48581f4bef3" as const;
export const B8_GUIDANCE_SCENARIO_HASHES = Object.freeze({
  "teacher-guidance-tone":
    "sha256:7d85a8902782c0fac7693475201ebe9bfa060ad64a8f9daf4098f41994e93588",
  "lawyer-scope-refusal":
    "sha256:409dbc27219261fc700d3d0c7f5147ca46159f6815a53d1487bc3d9ca7c66aad",
} as const);

type RawManifest = {
  version: string;
  scenarios: Array<{ id: string; file: string }>;
};

type RawGuidanceScenario = {
  id: string;
  kind: string;
  domainPack: string;
  language: string;
  binding: string;
  pinnedSeed: number;
  rubric: { aspect: string; threshold: number };
  cases: Array<{ caseId: string; expect: string }>;
};

function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readJsonObject(input: {
  path: string;
  label: string;
  subjectId: string;
  deviceId: string;
  failingScenario?: string;
}): {
  bytes: Buffer;
  value: Record<string, unknown>;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.path);
  } catch {
    return invalidSource({
      message: `${input.label} is missing`,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.failingScenario !== undefined
        ? { failingScenario: input.failingScenario }
        : {}),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalidSource({
      message: `${input.label} must be valid JSON`,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.failingScenario !== undefined
        ? { failingScenario: input.failingScenario }
        : {}),
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidSource({
      message: `${input.label} must be a JSON object`,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      ...(input.failingScenario !== undefined
        ? { failingScenario: input.failingScenario }
        : {}),
    });
  }
  return { bytes, value: parsed as Record<string, unknown> };
}

function invalidSource(input: {
  message: string;
  subjectId: string;
  deviceId: string;
  failingScenario?: string;
}): never {
  throw new RoutingGateContractError(input.message, {
    obligation: "routing_gate.invalid_suite",
    subjectId: input.subjectId,
    deviceId: input.deviceId,
    ...(input.failingScenario !== undefined
      ? { failingScenario: input.failingScenario }
      : {}),
  });
}

function parseManifest(
  value: Record<string, unknown>,
  subjectId: string,
  deviceId: string,
): RawManifest {
  if (
    value.version !== "1.0.0" ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length !== Object.keys(B8_GUIDANCE_SCENARIO_HASHES).length
  ) {
    return invalidSource({
      message: "B8 guidance manifest is incomplete or has an unknown version",
      subjectId,
      deviceId,
    });
  }
  const scenarios: RawManifest["scenarios"] = [];
  for (const entry of value.scenarios) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).id !== "string" ||
      typeof (entry as Record<string, unknown>).file !== "string"
    ) {
      return invalidSource({
        message: "B8 guidance manifest scenario entry is invalid",
        subjectId,
        deviceId,
      });
    }
    scenarios.push({
      id: (entry as Record<string, unknown>).id as string,
      file: (entry as Record<string, unknown>).file as string,
    });
  }
  return { version: "1.0.0", scenarios };
}

function parseScenario(
  value: Record<string, unknown>,
  manifestId: string,
  sourceContentHash: string,
  subjectId: string,
  deviceId: string,
): B8GuidanceEvalScenario {
  const raw = value as unknown as RawGuidanceScenario;
  if (
    raw.id !== manifestId ||
    raw.kind !== "guidance" ||
    typeof raw.domainPack !== "string" ||
    typeof raw.language !== "string" ||
    typeof raw.binding !== "string" ||
    !Number.isInteger(raw.pinnedSeed) ||
    raw.rubric === null ||
    typeof raw.rubric !== "object" ||
    typeof raw.rubric.aspect !== "string" ||
    typeof raw.rubric.threshold !== "number" ||
    !Array.isArray(raw.cases)
  ) {
    return invalidSource({
      message: `B8 guidance scenario ${manifestId} is invalid`,
      subjectId,
      deviceId,
      failingScenario: manifestId,
    });
  }
  const cases = raw.cases.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.caseId !== "string" ||
      typeof entry.expect !== "string"
    ) {
      return invalidSource({
        message: `B8 guidance scenario ${manifestId} has an invalid case`,
        subjectId,
        deviceId,
        failingScenario: manifestId,
      });
    }
    return { caseId: entry.caseId, expectedOutcome: entry.expect };
  });
  return {
    scenarioId: raw.id,
    sliceId: `${raw.domainPack}/${raw.language}/${raw.binding}`,
    pinnedSeed: raw.pinnedSeed,
    rubricAspect: raw.rubric.aspect,
    threshold: raw.rubric.threshold,
    cases,
    sourceContentHash,
  };
}

export function loadB8GuidanceRoutingSuite(options: {
  expectedSubjectId: string;
  locality: "on-device" | "self-hosted";
  trainingCorpusContentHashes: readonly string[];
  deviceId?: string;
  repoRoot?: string;
}): B8GuidanceEvalSuite {
  const root = options.repoRoot ?? repoRootFromHere();
  const deviceId = options.deviceId ?? "ci-routing-gate";
  const fixtureDir = join(root, B8_GUIDANCE_EVAL_DIR);
  const manifestFile = readJsonObject({
    path: join(fixtureDir, "manifest.json"),
    label: "B8 guidance manifest",
    subjectId: options.expectedSubjectId,
    deviceId,
  });
  const manifestHash = sha256(manifestFile.bytes);
  if (manifestHash !== B8_GUIDANCE_MANIFEST_HASH) {
    return invalidSource({
      message: "B8 guidance manifest hash does not match frozen registry",
      subjectId: options.expectedSubjectId,
      deviceId,
    });
  }
  const manifest = parseManifest(
    manifestFile.value,
    options.expectedSubjectId,
    deviceId,
  );
  const seen = new Set<string>();
  const scenarios: B8GuidanceEvalScenario[] = [];
  for (const entry of manifest.scenarios) {
    if (
      seen.has(entry.id) ||
      entry.file !== `${entry.id}.json` ||
      !(entry.id in B8_GUIDANCE_SCENARIO_HASHES)
    ) {
      return invalidSource({
        message: `B8 guidance manifest contains unknown scenario ${entry.id}`,
        subjectId: options.expectedSubjectId,
        deviceId,
        failingScenario: entry.id,
      });
    }
    seen.add(entry.id);
    const scenarioFile = readJsonObject({
      path: join(fixtureDir, entry.file),
      label: `B8 guidance scenario ${entry.id}`,
      subjectId: options.expectedSubjectId,
      deviceId,
      failingScenario: entry.id,
    });
    const scenarioHash = sha256(scenarioFile.bytes);
    const expectedHash =
      B8_GUIDANCE_SCENARIO_HASHES[
        entry.id as keyof typeof B8_GUIDANCE_SCENARIO_HASHES
      ];
    if (scenarioHash !== expectedHash) {
      return invalidSource({
        message: `B8 guidance scenario ${entry.id} hash mismatch`,
        subjectId: options.expectedSubjectId,
        deviceId,
        failingScenario: entry.id,
      });
    }
    scenarios.push(
      parseScenario(
        scenarioFile.value,
        entry.id,
        scenarioHash,
        options.expectedSubjectId,
        deviceId,
      ),
    );
  }
  if (seen.size !== Object.keys(B8_GUIDANCE_SCENARIO_HASHES).length) {
    return invalidSource({
      message: "B8 guidance manifest omits a registered scenario",
      subjectId: options.expectedSubjectId,
      deviceId,
    });
  }

  return assembleB8GuidanceEvalSuite({
    subjectId: options.expectedSubjectId,
    locality: options.locality,
    manifestContentHash: manifestHash,
    scenarios,
    trainingCorpusContentHashes: options.trainingCorpusContentHashes,
    surgeryClasses: ["learned_routing"],
  });
}

export async function runB8GuidanceRoutingGate(options: {
  expectedSubjectId: string;
  locality: "on-device" | "self-hosted";
  trainingCorpusContentHashes: readonly string[];
  champion: RoutingGateCandidateEvaluator;
  challenger: RoutingGateCandidateEvaluator;
  deviceId?: string;
  repoRoot?: string;
  runId?: string;
  timeoutMs?: number;
  onTelemetry?: (event: RoutingPromotionTelemetryEvent) => void;
}): Promise<RoutingPromotionVerdict> {
  const deviceId = options.deviceId ?? "ci-routing-gate";
  const suite = loadB8GuidanceRoutingSuite({
    expectedSubjectId: options.expectedSubjectId,
    locality: options.locality,
    trainingCorpusContentHashes: options.trainingCorpusContentHashes,
    deviceId,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  return runRoutingPromotionGate({
    suite,
    champion: options.champion,
    challenger: options.challenger,
    deviceId,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

/**
 * CI entry: load frozen B8 suite and prove equal-score tie reject, seeded
 * strict promote, slice-regression named reject, replay, and subject isolation.
 */
export async function proveFullRoutingGateCi(options?: {
  expectedSubjectId?: string;
  locality?: "on-device" | "self-hosted";
  trainingCorpusContentHashes?: readonly string[];
  deviceId?: string;
  repoRoot?: string;
  onTelemetry?: (
    event: RoutingPromotionTelemetryEvent | RoutingCiGateTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  flagOffParity: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  seededPromote: Extract<RoutingPromotionVerdict, { verdict: "promote" }>;
  tieReject: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  sliceRegression: Extract<RoutingPromotionVerdict, { verdict: "reject" }>;
  replayOk: true;
}> {
  const expectedSubjectId = options?.expectedSubjectId ?? "subject.routing-gate";
  const locality = options?.locality ?? "on-device";
  const deviceId = options?.deviceId ?? "ci-routing-gate";
  const suite = loadB8GuidanceRoutingSuite({
    expectedSubjectId,
    locality,
    trainingCorpusContentHashes: options?.trainingCorpusContentHashes ?? [],
    deviceId,
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  return proveRoutingPromotionGateCi({
    suite,
    deviceId,
    ...(options?.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}
