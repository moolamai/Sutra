/**
 * Offline failure-pattern miner — extracts subject-scoped failure features,
 * builds confidence-scored clusters, and looks up remediation policy hints
 * against the versioned append-only registry taxonomy.
 *
 * Auto-remediation execution belongs to later remediation-policy slices.
 * Clusters below min support / confidence stay triage-only.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_REMEDIATION_SURFACES,
  FAILURE_CLASSES,
  FAILURE_CONFIDENCE_THRESHOLD_DEFAULT,
  FAILURE_MINING_FIXTURES_RELPATH,
  FAILURE_MIN_SUPPORT_DEFAULT,
  FailurePatternContractError,
  assertFailureMiningFixtureResult,
  createFailurePatternClusterRegistry,
  extractFailureFeatures,
  ingestExtractionIntoClusterRegistry,
  type FailureClass,
  type FailureClusterRow,
  type FailureClusterSnapshot,
  type FailureClusterTelemetryEvent,
  type FailureExtractorTelemetryEvent,
  type FailureFeatureExtractionResult,
  type FailureMiningFixtureDocument,
  type FailureMiningFixtureTelemetryEvent,
  type FailurePatternClusterRegistry,
  type FailureTelemetryEvent,
  type FailureTrajectoryInput,
  type RemediationPolicyLookup,
} from "../../packages/learning/src/failure_patterns.ts";

export const PATTERN_REGISTRY_RELPATH =
  "training/self_healing/pattern_registry.json" as const;

export type PatternRegistryDocument = {
  schemaVersion: "failure-pattern-registry.v1";
  appendOnly: true;
  minSupport: number;
  confidenceThreshold: number;
  ineffectiveAttemptLimit?: number;
  allowedRemediationSurfaces: string[];
  forbiddenRemediationSurfaces: string[];
  failureClasses: Array<{ id: string; version: number }>;
  versions: Array<{ version: number; kind: string }>;
  fixtureCatalog?: {
    relPath: string;
    requiredIds: string[];
  };
  clusters: unknown[];
};

function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function loadPatternRegistryTaxonomy(options?: {
  repoRoot?: string;
}): PatternRegistryDocument {
  const root = options?.repoRoot ?? repoRootFromHere();
  const absolute = join(root, PATTERN_REGISTRY_RELPATH);
  const parsed = JSON.parse(
    readFileSync(absolute, "utf8"),
  ) as PatternRegistryDocument;
  if (
    parsed.schemaVersion !== "failure-pattern-registry.v1" ||
    parsed.appendOnly !== true ||
    !Array.isArray(parsed.failureClasses) ||
    !Array.isArray(parsed.versions) ||
    !Array.isArray(parsed.clusters) ||
    !Array.isArray(parsed.allowedRemediationSurfaces) ||
    !Array.isArray(parsed.forbiddenRemediationSurfaces)
  ) {
    throw new FailurePatternContractError(
      "pattern registry taxonomy is invalid or not append-only",
      { obligation: "failure_patterns.invalid_input" },
    );
  }
  if (!parsed.versions.some((entry) => entry.kind === "cluster_registry")) {
    throw new FailurePatternContractError(
      "pattern registry missing cluster_registry version row",
      { obligation: "failure_patterns.invalid_input" },
    );
  }
  if (!parsed.versions.some((entry) => entry.kind === "seeded_fixtures")) {
    throw new FailurePatternContractError(
      "pattern registry missing seeded_fixtures version row",
      { obligation: "failure_patterns.invalid_input" },
    );
  }
  if (
    parsed.fixtureCatalog === undefined ||
    parsed.fixtureCatalog.relPath !== FAILURE_MINING_FIXTURES_RELPATH ||
    !Array.isArray(parsed.fixtureCatalog.requiredIds) ||
    parsed.fixtureCatalog.requiredIds.length < 6
  ) {
    throw new FailurePatternContractError(
      "pattern registry fixture catalog is incomplete",
      { obligation: "failure_patterns.invalid_input" },
    );
  }
  const ids = new Set(parsed.failureClasses.map((entry) => entry.id));
  for (const cls of FAILURE_CLASSES) {
    if (!ids.has(cls)) {
      throw new FailurePatternContractError(
        `pattern registry missing failure class ${cls}`,
        { obligation: "failure_patterns.invalid_input" },
      );
    }
  }
  return parsed;
}

/**
 * Mine failure-class features for one subject. Cross-subject batches must be
 * split by the caller — aggregation across subjects is default-deny.
 */
export function mineFailureFeaturesForSubject(options: {
  subjectId: string;
  deviceId?: string;
  trajectories?: readonly FailureTrajectoryInput[];
  telemetryEvents?: readonly FailureTelemetryEvent[];
  repoRoot?: string;
  onTelemetry?: (event: FailureExtractorTelemetryEvent) => void;
}): FailureFeatureExtractionResult {
  const registry = loadPatternRegistryTaxonomy({
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  return extractFailureFeatures({
    subjectId: options.subjectId,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.trajectories !== undefined
      ? { trajectories: options.trajectories }
      : {}),
    ...(options.telemetryEvents !== undefined
      ? { telemetryEvents: options.telemetryEvents }
      : {}),
    minSupport: registry.minSupport ?? FAILURE_MIN_SUPPORT_DEFAULT,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
}

export type SubjectMiningBatch = {
  subjectId: string;
  deviceId?: string;
  trajectories?: readonly FailureTrajectoryInput[];
  telemetryEvents?: readonly FailureTelemetryEvent[];
};

/**
 * Mine each subject independently. Mixing subjects in one extractor call is
 * refused — this batch helper preserves that isolation.
 */
export function mineFailureFeaturesBySubject(options: {
  batches: readonly SubjectMiningBatch[];
  repoRoot?: string;
  onTelemetry?: (event: FailureExtractorTelemetryEvent) => void;
}): Array<{
  subjectId: string;
  result: FailureFeatureExtractionResult;
}> {
  if (!Array.isArray(options.batches) || options.batches.length > 64) {
    throw new FailurePatternContractError(
      "subject mining batches must be a bounded array (1..64)",
      { obligation: "failure_patterns.capacity" },
    );
  }
  const out: Array<{
    subjectId: string;
    result: FailureFeatureExtractionResult;
  }> = [];
  for (const batch of options.batches) {
    out.push({
      subjectId: batch.subjectId,
      result: mineFailureFeaturesForSubject({
        subjectId: batch.subjectId,
        ...(batch.deviceId !== undefined ? { deviceId: batch.deviceId } : {}),
        ...(batch.trajectories !== undefined
          ? { trajectories: batch.trajectories }
          : {}),
        ...(batch.telemetryEvents !== undefined
          ? { telemetryEvents: batch.telemetryEvents }
          : {}),
        ...(options.repoRoot !== undefined
          ? { repoRoot: options.repoRoot }
          : {}),
        ...(options.onTelemetry !== undefined
          ? { onTelemetry: options.onTelemetry }
          : {}),
      }),
    });
  }
  return out;
}

export type SubjectClusterMiningResult = {
  subjectId: string;
  extraction: FailureFeatureExtractionResult;
  registry: FailurePatternClusterRegistry;
  clusters: FailureClusterRow[];
  snapshot: FailureClusterSnapshot;
  policies: Partial<Record<FailureClass, RemediationPolicyLookup>>;
};

/**
 * Mine + cluster for one subject and expose remediation policy lookup.
 * Sparse / low-confidence classes remain triage-only.
 */
export function mineAndClusterForSubject(options: {
  subjectId: string;
  deviceId?: string;
  trajectories?: readonly FailureTrajectoryInput[];
  telemetryEvents?: readonly FailureTelemetryEvent[];
  repoRoot?: string;
  onTelemetry?: (
    event: FailureExtractorTelemetryEvent | FailureClusterTelemetryEvent,
  ) => void;
}): SubjectClusterMiningResult {
  const taxonomy = loadPatternRegistryTaxonomy({
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  const extraction = mineFailureFeaturesForSubject({
    subjectId: options.subjectId,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.trajectories !== undefined
      ? { trajectories: options.trajectories }
      : {}),
    ...(options.telemetryEvents !== undefined
      ? { telemetryEvents: options.telemetryEvents }
      : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  const registry = createFailurePatternClusterRegistry({
    subjectId: options.subjectId,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    minSupport: taxonomy.minSupport ?? FAILURE_MIN_SUPPORT_DEFAULT,
    confidenceThreshold:
      taxonomy.confidenceThreshold ?? FAILURE_CONFIDENCE_THRESHOLD_DEFAULT,
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  const clusters = ingestExtractionIntoClusterRegistry({
    registry,
    extraction,
    ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
    ...(options.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  const policies: Partial<Record<FailureClass, RemediationPolicyLookup>> = {};
  for (const cls of FAILURE_CLASSES) {
    policies[cls] = registry.lookupRemediationPolicy(cls);
  }
  return {
    subjectId: options.subjectId,
    extraction,
    registry,
    clusters,
    snapshot: registry.snapshot(),
    policies,
  };
}

type FixtureManifest = {
  schemaVersion: "failure-mining-fixtures.v1";
  fixtures: Array<{ id: string; file: string }>;
};

function readJsonObject(absolutePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    throw new FailurePatternContractError(`${label} is missing`, {
      obligation: "failure_patterns.invalid_input",
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new FailurePatternContractError(`${label} must be valid JSON`, {
      obligation: "failure_patterns.invalid_input",
    });
  }
}

export function loadFailureMiningFixtures(options?: {
  repoRoot?: string;
}): FailureMiningFixtureDocument[] {
  const root = options?.repoRoot ?? repoRootFromHere();
  const dir = join(root, FAILURE_MINING_FIXTURES_RELPATH);
  const manifest = readJsonObject(
    join(dir, "manifest.json"),
    "failure mining fixture manifest",
  ) as FixtureManifest;
  if (
    manifest.schemaVersion !== "failure-mining-fixtures.v1" ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length < 1 ||
    manifest.fixtures.length > 64
  ) {
    throw new FailurePatternContractError(
      "failure mining fixture manifest is invalid",
      { obligation: "failure_patterns.invalid_input" },
    );
  }
  const seen = new Set<string>();
  const fixtures: FailureMiningFixtureDocument[] = [];
  for (const entry of manifest.fixtures) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.file !== "string" ||
      seen.has(entry.id) ||
      entry.file.includes("..") ||
      entry.file.includes("\\") ||
      entry.file.includes("/")
    ) {
      throw new FailurePatternContractError(
        `invalid fixture manifest entry ${String(entry.id)}`,
        { obligation: "failure_patterns.invalid_input" },
      );
    }
    seen.add(entry.id);
    const parsed = readJsonObject(
      join(dir, entry.file),
      `failure mining fixture ${entry.id}`,
    ) as FailureMiningFixtureDocument;
    if (parsed.id !== entry.id) {
      throw new FailurePatternContractError(
        `fixture id mismatch for ${entry.id}`,
        { obligation: "failure_patterns.invalid_input" },
      );
    }
    fixtures.push(parsed);
  }
  return fixtures;
}

/**
 * CI prove: every seeded failure class clusters correctly; low-support stays
 * triage-only; cross-subject mining denied; forbidden remediation surfaces
 * refused; replay is idempotent.
 */
export async function proveFailureMiningFixturesCi(options?: {
  repoRoot?: string;
  deviceId?: string;
  onTelemetry?: (
    event:
      | FailureExtractorTelemetryEvent
      | FailureClusterTelemetryEvent
      | FailureMiningFixtureTelemetryEvent,
  ) => void;
}): Promise<{
  ok: true;
  eligibleFixtureIds: string[];
  triageFixtureIds: string[];
  refuseFixtureIds: string[];
  forbiddenSurfaceRejected: true;
  replayOk: true;
}> {
  const deviceId = options?.deviceId ?? "ci-failure-mining";
  const fixtures = loadFailureMiningFixtures({
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  const eligibleFixtureIds: string[] = [];
  const triageFixtureIds: string[] = [];
  const refuseFixtureIds: string[] = [];

  for (const fixture of fixtures) {
    if (fixture.kind === "refuse") {
      let denied = false;
      try {
        mineAndClusterForSubject({
          subjectId: fixture.subjectId,
          deviceId: fixture.deviceId ?? deviceId,
          trajectories: fixture.trajectories,
          telemetryEvents: fixture.telemetryEvents,
          ...(options?.repoRoot !== undefined
            ? { repoRoot: options.repoRoot }
            : {}),
          ...(options?.onTelemetry !== undefined
            ? { onTelemetry: options.onTelemetry }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof FailurePatternContractError &&
          error.obligation ===
            (fixture.expect.obligation ??
              "failure_patterns.cross_subject_denied")
        ) {
          denied = true;
        } else {
          throw error;
        }
      }
      if (!denied) {
        options?.onTelemetry?.({
          event: "learning.failure_patterns.fixture",
          outcome: "fail",
          subjectId: fixture.subjectId,
          deviceId,
          fixtureId: fixture.id,
          failureClassCode: "failure_patterns.ci_fixture_failed",
          disposition: "refuse",
        });
        throw new FailurePatternContractError(
          `fixture ${fixture.id} must deny cross-subject mining`,
          {
            obligation: "failure_patterns.ci_fixture_failed",
            subjectId: fixture.subjectId,
            deviceId,
          },
        );
      }
      refuseFixtureIds.push(fixture.id);
      options?.onTelemetry?.({
        event: "learning.failure_patterns.fixture",
        outcome: "ok",
        subjectId: fixture.subjectId,
        deviceId,
        fixtureId: fixture.id,
        disposition: "refuse",
      });
      continue;
    }

    const mined = mineAndClusterForSubject({
      subjectId: fixture.subjectId,
      deviceId: fixture.deviceId ?? deviceId,
      trajectories: fixture.trajectories,
      telemetryEvents: fixture.telemetryEvents,
      ...(options?.repoRoot !== undefined
        ? { repoRoot: options.repoRoot }
        : {}),
      ...(options?.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    assertFailureMiningFixtureResult({
      fixture,
      mined,
      deviceId,
      ...(options?.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
    });
    if (fixture.kind === "cluster_eligible") {
      eligibleFixtureIds.push(fixture.id);
    } else {
      triageFixtureIds.push(fixture.id);
    }
  }

  // Forbidden-action fixture: permission widen must be refused.
  const forbidRegistry = createFailurePatternClusterRegistry({
    subjectId: "subj.fixture.forbidden",
    deviceId,
    ...(options?.onTelemetry !== undefined
      ? { onTelemetry: options.onTelemetry }
      : {}),
  });
  let forbiddenSurfaceRejected = false;
  try {
    forbidRegistry.appendClusterVersion({
      clusterId: "cluster.forbidden",
      subjectId: "subj.fixture.forbidden",
      failureClass: "tool_timeout",
      support: 5,
      confidence: 0.95,
      disposition: "auto_eligible",
      policyHint: {
        // Intentionally illegal — prove refuses permissions widening.
        surface: "permissions" as (typeof ALLOWED_REMEDIATION_SURFACES)[number],
        parameter: "widen",
        delta: 1,
      },
      evidenceFingerprints: ["fp.forbid"],
      disabled: false,
      ineffectiveAttempts: 0,
      pageRequested: false,
    });
  } catch (error) {
    if (
      error instanceof FailurePatternContractError &&
      error.obligation === "failure_patterns.forbidden_surface"
    ) {
      forbiddenSurfaceRejected = true;
    } else {
      throw error;
    }
  }
  if (!forbiddenSurfaceRejected) {
    throw new FailurePatternContractError(
      "forbidden permissions surface must be refused",
      {
        obligation: "failure_patterns.ci_fixture_failed",
        subjectId: "subj.fixture.forbidden",
        deviceId,
      },
    );
  }

  // Replay: re-running the eligible correction fixture yields the same disposition.
  const correction = fixtures.find((fixture) => fixture.id === "correction-exhaustion");
  if (correction === undefined) {
    throw new FailurePatternContractError(
      "correction-exhaustion fixture required for replay prove",
      { obligation: "failure_patterns.ci_fixture_failed", deviceId },
    );
  }
  const first = mineAndClusterForSubject({
    subjectId: correction.subjectId,
    deviceId: correction.deviceId ?? deviceId,
    trajectories: correction.trajectories,
    telemetryEvents: correction.telemetryEvents,
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  const second = mineAndClusterForSubject({
    subjectId: correction.subjectId,
    deviceId: correction.deviceId ?? deviceId,
    trajectories: correction.trajectories,
    telemetryEvents: correction.telemetryEvents,
    ...(options?.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  const firstLookup = first.policies.correction_exhaustion;
  const secondLookup = second.policies.correction_exhaustion;
  if (
    firstLookup === undefined ||
    secondLookup === undefined ||
    firstLookup.ok !== secondLookup.ok ||
    JSON.stringify(first.clusters.map((c) => c.disposition)) !==
      JSON.stringify(second.clusters.map((c) => c.disposition))
  ) {
    throw new FailurePatternContractError(
      "failure mining fixture replay is not idempotent",
      {
        obligation: "failure_patterns.idempotent_conflict",
        subjectId: correction.subjectId,
        deviceId,
      },
    );
  }

  if (
    eligibleFixtureIds.length < 4 ||
    triageFixtureIds.length < 1 ||
    refuseFixtureIds.length < 1
  ) {
    throw new FailurePatternContractError(
      "seeded fixture catalog incomplete for CI prove",
      { obligation: "failure_patterns.ci_fixture_failed", deviceId },
    );
  }

  options?.onTelemetry?.({
    event: "learning.failure_patterns.fixture",
    outcome: "ok",
    subjectId: "ci",
    deviceId,
    fixtureId: "prove.all",
  });

  return {
    ok: true,
    eligibleFixtureIds,
    triageFixtureIds,
    refuseFixtureIds,
    forbiddenSurfaceRejected: true,
    replayOk: true,
  };
}

export type {
  FailureClass,
  FailureClusterRow,
  FailureClusterSnapshot,
  FailureFeatureExtractionResult,
  FailureMiningFixtureDocument,
  FailurePatternClusterRegistry,
  RemediationPolicyLookup,
};
