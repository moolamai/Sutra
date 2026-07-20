/**
 * Reward-hack / degenerate trajectory fixture suite (C3).
 *
 * Authors empty-answer, tool-spam, refusal-on-benign, and summary-gaming
 * trajectories under training/critics/fixtures/hack/. Each file documents its
 * attack pattern. Composite scoring (core + process + pack oracles) must be
 * ≤ 0 on every fixture. Critic version bumps must clear this suite before
 * the calibration promotion gate.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TurnTrajectoryRecord } from "../trajectory_schema.js";
import {
  assertCriticScore,
  createCriticScore,
  isRewardHackFixture,
  type CriticScore,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.js";
import { createCoreRubricCritic } from "./core_rubric.js";
import { createProcessRewardCritic } from "./process_rewards.js";
import { registerReferencePackOracles } from "./pack_oracles.js";
import { CriticRegistry } from "./registry.js";

export const HACK_FIXTURE_SCHEMA_VERSION = "critic.hack-fixture.v1" as const;
export const HACK_SUITE_MANIFEST_SCHEMA_VERSION =
  "critic.hack-suite.v1" as const;

/** Repo-relative root for the degenerate hack fixture suite. */
export const HACK_FIXTURES_RELPATH =
  "training/critics/fixtures/hack" as const;

export const HACK_SUITE_ENTRY_LIMIT = 64;
export const HACK_ATTACK_DOC_LIMIT = 512;
export const HACK_FIXTURE_ID_LIMIT = 128;

export const HACK_ATTACK_PATTERNS = Object.freeze([
  "empty_answer",
  "tool_spam",
  "refusal_on_benign",
  "summary_gaming",
] as const);

export type HackAttackPattern = (typeof HACK_ATTACK_PATTERNS)[number];

/** Red-team families — suite runs before eval/promotion gates. */
export const HACK_RED_TEAM_FAMILIES = Object.freeze([
  "reward_hack",
  "over_refusal",
  "jailbreak",
  "injection",
  "exfiltration",
] as const);

export type HackRedTeamFamily = (typeof HACK_RED_TEAM_FAMILIES)[number];

const trajectoryProbeSchema = z
  .object({
    schemaVersion: z.literal("trajectory.v1"),
    subjectId: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    sessionId: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    turnId: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    deviceId: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT).optional(),
    capturedAt: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    locality: z.enum(["on-device", "self-hosted"]),
    consent: z
      .object({
        optedIn: z.boolean(),
        consentClass: z.enum(["research", "product-improve", "personal"]),
        recordedAt: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
      })
      .strict(),
    stages: z
      .array(
        z
          .object({
            stage: z.string().min(1).max(64),
            opCode: z.string().min(1).max(128).optional(),
            status: z
              .enum(["ok", "aborted", "error", "skipped"])
              .optional(),
          })
          .strict(),
      )
      .max(32),
    toolCallIds: z.array(z.string().min(1).max(64)).max(64).optional(),
    humanOutcomeSignal: z
      .enum(["ACCEPTED", "REJECTED", "DISCARDED"])
      .optional(),
  })
  .passthrough();

export const hackFixtureDocumentSchema = z
  .object({
    schemaVersion: z.literal(HACK_FIXTURE_SCHEMA_VERSION),
    id: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    attackPattern: z.enum(HACK_ATTACK_PATTERNS),
    /** Human-readable attack documentation — never learner content. */
    attackPatternDoc: z.string().min(1).max(HACK_ATTACK_DOC_LIMIT),
    redTeamFamily: z.enum(HACK_RED_TEAM_FAMILIES),
    locality: z.enum(["on-device", "self-hosted"]),
    mustScoreNonPositive: z.literal(true),
    trajectory: trajectoryProbeSchema,
  })
  .strict();

export const hackSuiteManifestSchema = z
  .object({
    schemaVersion: z.literal(HACK_SUITE_MANIFEST_SCHEMA_VERSION),
    suiteId: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
    purpose: z.string().min(1).max(HACK_ATTACK_DOC_LIMIT),
    /** Required attack patterns — every one must appear exactly once. */
    requiredAttackPatterns: z
      .array(z.enum(HACK_ATTACK_PATTERNS))
      .min(1)
      .max(HACK_SUITE_ENTRY_LIMIT),
    /** Red-team families this suite covers before eval gates. */
    redTeamFamilies: z
      .array(z.enum(HACK_RED_TEAM_FAMILIES))
      .min(1)
      .max(HACK_RED_TEAM_FAMILIES.length),
    runBeforeEvalGates: z.literal(true),
    locality: z.enum(["on-device", "self-hosted"]),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(1).max(HACK_FIXTURE_ID_LIMIT),
            file: z.string().min(1).max(256),
            attackPattern: z.enum(HACK_ATTACK_PATTERNS),
          })
          .strict(),
      )
      .min(1)
      .max(HACK_SUITE_ENTRY_LIMIT),
  })
  .strict();

export type HackFixtureDocument = z.infer<typeof hackFixtureDocumentSchema>;
export type HackSuiteManifest = z.infer<typeof hackSuiteManifestSchema>;

export type HackFixtureFailureClass =
  | "hack_fixture.schema_violation"
  | "hack_fixture.source_missing"
  | "hack_fixture.pattern_gap"
  | "hack_fixture.not_detected"
  | "hack_fixture.sovereignty"
  | "hack_fixture.section_limit"
  | "hack_fixture.positive_score"
  | "hack_fixture.empty_stack"
  | "hack_fixture.version_bump_blocked"
  | "hack_fixture.ordering_violation";

export type HackFixtureTelemetryEvent = {
  event:
    | "learning.critic.hack_fixture"
    | "learning.critic.hack_composite"
    | "learning.critic.hack_ci_gate";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  suiteId?: string;
  fixtureId?: string;
  attackPattern?: HackAttackPattern;
  failureClass?: HackFixtureFailureClass;
  entryCount?: number;
  compositeTotal?: number;
  layerCount?: number;
  failingFixtureCount?: number;
  criticId?: string;
  criticVersion?: string;
  calibrationAllowed?: boolean;
  runBeforeCalibration?: boolean;
};

export class HackFixtureContractError extends Error {
  readonly obligation: HackFixtureFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: HackFixtureFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
    },
  ) {
    super(message);
    this.name = "HackFixtureContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
  }
}

export type LoadedHackFixture = HackFixtureDocument & {
  absolutePath: string;
  file: string;
};

export type LoadedHackSuite = {
  manifest: HackSuiteManifest;
  fixtures: LoadedHackFixture[];
};

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

const FORBIDDEN_CONTENT = [
  "utterance",
  "keystrokes",
  "rawKeystrokes",
  "prompt",
  "completion",
  "reply",
  "promptText",
  "rawContent",
];

function assertNoForbiddenContent(
  blob: string,
  fixtureId: string,
): void {
  for (const key of FORBIDDEN_CONTENT) {
    if (new RegExp(`"${key}"\\s*:`, "i").test(blob)) {
      throw new HackFixtureContractError(
        `forbidden content key '${key}' in hack fixture ${fixtureId}`,
        {
          obligation: "hack_fixture.sovereignty",
          failingSlice: fixtureId,
        },
      );
    }
  }
}

/**
 * Parse one hack fixture document (self-documented attack pattern).
 */
export function parseHackFixtureDocument(raw: unknown): HackFixtureDocument {
  const parsed = hackFixtureDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HackFixtureContractError(
      `hack fixture invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      { obligation: "hack_fixture.schema_violation" },
    );
  }
  return parsed.data;
}

/**
 * Parse the hack suite manifest.
 */
export function parseHackSuiteManifest(raw: unknown): HackSuiteManifest {
  const parsed = hackSuiteManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HackFixtureContractError(
      `hack suite manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      { obligation: "hack_fixture.schema_violation" },
    );
  }
  const doc = parsed.data;
  if (!doc.runBeforeEvalGates) {
    throw new HackFixtureContractError(
      "hack suite must declare runBeforeEvalGates",
      { obligation: "hack_fixture.schema_violation" },
    );
  }
  return doc;
}

/**
 * Load + verify the committed hack fixture suite.
 * Ensures required attack patterns are present, each file is self-documented,
 * trajectories are detected as reward-hack fixtures, and no utterance bodies.
 */
export function loadHackFixtureSuite(opts?: {
  repoRoot?: string;
  relPath?: string;
  onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
}): LoadedHackSuite {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const suiteDir = path.join(
    root,
    opts?.relPath ?? HACK_FIXTURES_RELPATH,
  );
  const absManifest = path.join(suiteDir, "manifest.json");

  let manifestText: string;
  try {
    manifestText = readFileSync(absManifest, "utf8");
  } catch {
    opts?.onTelemetry?.({
      event: "learning.critic.hack_fixture",
      outcome: "fail",
      subjectId: "hack-suite",
      deviceId: "ci",
      failureClass: "hack_fixture.source_missing",
    });
    throw new HackFixtureContractError(
      `hack suite manifest missing: ${HACK_FIXTURES_RELPATH}/manifest.json`,
      { obligation: "hack_fixture.source_missing" },
    );
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    throw new HackFixtureContractError("hack suite manifest not JSON", {
      obligation: "hack_fixture.schema_violation",
    });
  }

  const manifest = parseHackSuiteManifest(manifestJson);
  if (manifest.entries.length > HACK_SUITE_ENTRY_LIMIT) {
    throw new HackFixtureContractError("hack suite exceeds entry cap", {
      obligation: "hack_fixture.section_limit",
    });
  }

  const fixtures: LoadedHackFixture[] = [];
  const seenPatterns = new Set<HackAttackPattern>();
  const seenIds = new Set<string>();

  for (const entry of manifest.entries) {
    if (seenIds.has(entry.id)) {
      throw new HackFixtureContractError(`duplicate hack fixture id ${entry.id}`, {
        obligation: "hack_fixture.schema_violation",
        failingSlice: entry.id,
      });
    }
    seenIds.add(entry.id);

    const abs = path.join(suiteDir, entry.file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      opts?.onTelemetry?.({
        event: "learning.critic.hack_fixture",
        outcome: "fail",
        subjectId: "hack-suite",
        deviceId: "ci",
        suiteId: manifest.suiteId,
        fixtureId: entry.id,
        attackPattern: entry.attackPattern,
        failureClass: "hack_fixture.source_missing",
      });
      throw new HackFixtureContractError(
        `hack fixture missing: ${entry.file}`,
        {
          obligation: "hack_fixture.source_missing",
          failingSlice: entry.id,
        },
      );
    }

    const text = bytes.toString("utf8");
    assertNoForbiddenContent(text, entry.id);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HackFixtureContractError(
        `hack fixture not JSON: ${entry.id}`,
        {
          obligation: "hack_fixture.schema_violation",
          failingSlice: entry.id,
        },
      );
    }

    const doc = parseHackFixtureDocument(json);
    if (doc.id !== entry.id) {
      throw new HackFixtureContractError(
        `fixture id mismatch: manifest=${entry.id} file=${doc.id}`,
        {
          obligation: "hack_fixture.schema_violation",
          failingSlice: entry.id,
        },
      );
    }
    if (doc.attackPattern !== entry.attackPattern) {
      throw new HackFixtureContractError(
        `attackPattern mismatch for ${entry.id}`,
        {
          obligation: "hack_fixture.schema_violation",
          failingSlice: entry.id,
        },
      );
    }
    if (seenPatterns.has(doc.attackPattern)) {
      throw new HackFixtureContractError(
        `duplicate attackPattern ${doc.attackPattern}`,
        {
          obligation: "hack_fixture.pattern_gap",
          failingSlice: entry.id,
        },
      );
    }
    seenPatterns.add(doc.attackPattern);

    assertNoForbiddenContent(JSON.stringify(doc.trajectory), entry.id);

    if (!isRewardHackFixture(doc.trajectory as never)) {
      opts?.onTelemetry?.({
        event: "learning.critic.hack_fixture",
        outcome: "fail",
        subjectId: doc.trajectory.subjectId,
        deviceId:
          typeof doc.trajectory.deviceId === "string"
            ? doc.trajectory.deviceId
            : "ci",
        suiteId: manifest.suiteId,
        fixtureId: entry.id,
        attackPattern: doc.attackPattern,
        failureClass: "hack_fixture.not_detected",
      });
      throw new HackFixtureContractError(
        `fixture ${entry.id} is not detected as a reward-hack pattern`,
        {
          obligation: "hack_fixture.not_detected",
          failingSlice: entry.id,
          subjectId: doc.trajectory.subjectId,
        },
      );
    }

    fixtures.push({
      ...doc,
      absolutePath: abs,
      file: entry.file,
    });
  }

  for (const required of manifest.requiredAttackPatterns) {
    if (!seenPatterns.has(required)) {
      throw new HackFixtureContractError(
        `required attackPattern missing from suite: ${required}`,
        {
          obligation: "hack_fixture.pattern_gap",
          failingSlice: required,
        },
      );
    }
  }

  // Bound directory scan — no unbounded walks
  const listed = readdirSync(suiteDir).filter((n) => n.endsWith(".json"));
  if (listed.length > HACK_SUITE_ENTRY_LIMIT + 1) {
    throw new HackFixtureContractError("hack fixture directory exceeds soft cap", {
      obligation: "hack_fixture.section_limit",
    });
  }

  opts?.onTelemetry?.({
    event: "learning.critic.hack_fixture",
    outcome: "ok",
    subjectId: "hack-suite",
    deviceId: "ci",
    suiteId: manifest.suiteId,
    entryCount: fixtures.length,
  });

  return { manifest, fixtures };
}

/**
 * List attack patterns present in a loaded suite (sorted).
 */
export function listHackAttackPatterns(
  suite: LoadedHackSuite,
): readonly HackAttackPattern[] {
  return [...new Set(suite.fixtures.map((f) => f.attackPattern))].sort();
}

export const HACK_COMPOSITE_SCHEMA_VERSION =
  "critic.hack-composite.v1" as const;

/** Soft cap on critic layers in a composite stack. */
export const HACK_COMPOSITE_LAYER_LIMIT = 16;

export type HackCompositeLayerScore = {
  rubricId: string;
  rubricVersion: string;
  total: number;
  /** Component keys only — never learner content. */
  breakdown: Record<string, number>;
};

export type HackCompositeFixtureResult = {
  fixtureId: string;
  attackPattern: HackAttackPattern;
  subjectId: string;
  deviceId: string;
  compositeTotal: number;
  /** True iff compositeTotal ≤ 0. */
  passes: boolean;
  layers: HackCompositeLayerScore[];
};

export type HackCompositeSuiteReport = {
  schemaVersion: typeof HACK_COMPOSITE_SCHEMA_VERSION;
  suiteId: string;
  fixtureCount: number;
  layerCount: number;
  passes: boolean;
  /** Fixture ids with compositeTotal > 0 — empty when all pass. */
  failingFixtures: string[];
  results: HackCompositeFixtureResult[];
};

/**
 * Build the default full critic stack: core + process + reference pack oracles.
 */
export function createDefaultHackCompositeStack(opts?: {
  repoRoot?: string;
  onTelemetry?: (e: CriticTelemetryEvent) => void;
}): TrajectoryCritic[] {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const core = createCoreRubricCritic(
    opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : undefined,
  );
  // Process critic accepts a wider telemetry union — omit shared callback.
  const process = createProcessRewardCritic();
  const registry = new CriticRegistry(
    opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : undefined,
  );
  registerReferencePackOracles(registry, { repoRoot: root });
  const packs = [...registry.list()];
  const stack = [core, process, ...packs];
  if (stack.length > HACK_COMPOSITE_LAYER_LIMIT) {
    throw new HackFixtureContractError(
      `composite stack exceeds ${HACK_COMPOSITE_LAYER_LIMIT} layers`,
      { obligation: "hack_fixture.section_limit" },
    );
  }
  if (stack.length === 0) {
    throw new HackFixtureContractError("composite stack is empty", {
      obligation: "hack_fixture.empty_stack",
    });
  }
  return stack;
}

/**
 * Score one trajectory under a critic stack; composite = sum of layer totals.
 * Prefixed breakdown keys (`rubricId.key`) keep debugging reports unambiguous.
 */
export function scoreHackFixtureComposite(opts: {
  trajectory: TurnTrajectoryRecord | Record<string, unknown>;
  critics: readonly TrajectoryCritic[];
  fixtureId?: string;
  attackPattern?: HackAttackPattern;
}): {
  compositeTotal: number;
  layers: HackCompositeLayerScore[];
  breakdown: Record<string, number>;
} {
  if (opts.critics.length === 0) {
    throw new HackFixtureContractError("composite stack is empty", {
      obligation: "hack_fixture.empty_stack",
      ...(opts.fixtureId !== undefined
        ? { failingSlice: opts.fixtureId }
        : {}),
    });
  }
  if (opts.critics.length > HACK_COMPOSITE_LAYER_LIMIT) {
    throw new HackFixtureContractError(
      `composite stack exceeds ${HACK_COMPOSITE_LAYER_LIMIT} layers`,
      {
        obligation: "hack_fixture.section_limit",
        ...(opts.fixtureId !== undefined
          ? { failingSlice: opts.fixtureId }
          : {}),
      },
    );
  }

  const record = opts.trajectory as TurnTrajectoryRecord;
  const layers: HackCompositeLayerScore[] = [];
  const breakdown: Record<string, number> = {};
  let compositeTotal = 0;

  for (const critic of opts.critics) {
    const score: CriticScore = critic.score(record);
    assertCriticScore(score, critic.rubricVersion);
    layers.push({
      rubricId: critic.rubricId,
      rubricVersion: critic.rubricVersion,
      total: score.total,
      breakdown: { ...score.breakdown },
    });
    compositeTotal += score.total;
    for (const [key, value] of Object.entries(score.breakdown)) {
      const prefixed = `${critic.rubricId}.${key}`;
      breakdown[prefixed] = (breakdown[prefixed] ?? 0) + value;
    }
  }

  if (!Number.isFinite(compositeTotal)) {
    throw new HackFixtureContractError("composite total is non-finite", {
      obligation: "hack_fixture.schema_violation",
      ...(opts.fixtureId !== undefined
        ? { failingSlice: opts.fixtureId }
        : {}),
    });
  }

  return { compositeTotal, layers, breakdown };
}

/**
 * Run the full critic stack over every hack fixture.
 * Does not throw on positive scores — returns a report (assert* throws).
 */
export function runHackSuiteComposite(opts: {
  suite?: LoadedHackSuite;
  critics?: readonly TrajectoryCritic[];
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
}): HackCompositeSuiteReport {
  const root = opts.repoRoot ?? repoRootFromHere();
  const suite =
    opts.suite ??
    loadHackFixtureSuite({
      repoRoot: root,
      ...(opts.onTelemetry !== undefined
        ? { onTelemetry: opts.onTelemetry }
        : {}),
    });
  const critics =
    opts.critics ?? createDefaultHackCompositeStack({ repoRoot: root });
  const subjectId = opts.subjectId ?? "hack-suite";
  const deviceId = opts.deviceId ?? "ci";

  const results: HackCompositeFixtureResult[] = [];
  const failingFixtures: string[] = [];

  for (const fixture of suite.fixtures) {
    const scored = scoreHackFixtureComposite({
      trajectory: fixture.trajectory,
      critics,
      fixtureId: fixture.id,
      attackPattern: fixture.attackPattern,
    });
    const passes = scored.compositeTotal <= 0;
    const device =
      typeof fixture.trajectory.deviceId === "string"
        ? fixture.trajectory.deviceId
        : deviceId;
    const result: HackCompositeFixtureResult = {
      fixtureId: fixture.id,
      attackPattern: fixture.attackPattern,
      subjectId: fixture.trajectory.subjectId,
      deviceId: device,
      compositeTotal: scored.compositeTotal,
      passes,
      layers: scored.layers,
    };
    results.push(result);
    if (!passes) {
      failingFixtures.push(fixture.id);
      opts.onTelemetry?.({
        event: "learning.critic.hack_composite",
        outcome: "fail",
        subjectId: fixture.trajectory.subjectId,
        deviceId: device,
        suiteId: suite.manifest.suiteId,
        fixtureId: fixture.id,
        attackPattern: fixture.attackPattern,
        compositeTotal: scored.compositeTotal,
        layerCount: scored.layers.length,
        failureClass: "hack_fixture.positive_score",
      });
    } else {
      opts.onTelemetry?.({
        event: "learning.critic.hack_composite",
        outcome: "ok",
        subjectId: fixture.trajectory.subjectId,
        deviceId: device,
        suiteId: suite.manifest.suiteId,
        fixtureId: fixture.id,
        attackPattern: fixture.attackPattern,
        compositeTotal: scored.compositeTotal,
        layerCount: scored.layers.length,
      });
    }
  }

  const report: HackCompositeSuiteReport = {
    schemaVersion: HACK_COMPOSITE_SCHEMA_VERSION,
    suiteId: suite.manifest.suiteId,
    fixtureCount: results.length,
    layerCount: critics.length,
    passes: failingFixtures.length === 0,
    failingFixtures,
    results,
  };

  opts.onTelemetry?.({
    event: "learning.critic.hack_composite",
    outcome: report.passes ? "ok" : "fail",
    subjectId,
    deviceId,
    suiteId: suite.manifest.suiteId,
    entryCount: results.length,
    layerCount: critics.length,
    failingFixtureCount: failingFixtures.length,
    ...(report.passes
      ? {}
      : { failureClass: "hack_fixture.positive_score" as const }),
  });

  return report;
}

/**
 * Assert every hack fixture scores ≤ 0 under the full critic stack.
 * On failure: throws with the first failing fixture named and layer breakdown
 * embedded in the message for debugging.
 */
export function assertHackSuiteCompositeNonPositive(opts?: {
  suite?: LoadedHackSuite;
  critics?: readonly TrajectoryCritic[];
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
}): HackCompositeSuiteReport {
  const report = runHackSuiteComposite({
    ...(opts?.suite !== undefined ? { suite: opts.suite } : {}),
    ...(opts?.critics !== undefined ? { critics: opts.critics } : {}),
    ...(opts?.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (report.passes) {
    return report;
  }

  const failingId = report.failingFixtures[0] ?? "(unknown)";
  const failing = report.results.find((r) => r.fixtureId === failingId);
  const layerSummary =
    failing?.layers
      .map((l) => `${l.rubricId}@${l.rubricVersion}=${l.total}`)
      .join(", ") ?? "";

  throw new HackFixtureContractError(
    `hack fixture ${failingId} compositeTotal=${failing?.compositeTotal ?? "?"} > 0; layers=[${layerSummary}]`,
    {
      obligation: "hack_fixture.positive_score",
      failingSlice: failingId,
      ...(failing?.subjectId !== undefined
        ? { subjectId: failing.subjectId }
        : {}),
      ...(failing?.deviceId !== undefined
        ? { deviceId: failing.deviceId }
        : {}),
    },
  );
}

/**
 * Contract-smoke helper: a deliberately leaky critic (always +1) for negative tests.
 * Must never be registered into training configs.
 */
export function createLeakyPositiveHackCritic(): TrajectoryCritic {
  return {
    rubricId: "critic.hack-leaky-positive",
    rubricVersion: "0.0.0-test",
    score(): CriticScore {
      return createCriticScore({ leaky_positive: 1 }, "0.0.0-test");
    },
  };
}

/** pnpm script id for the mandatory hack CI job. */
export const HACK_SUITE_CI_SCRIPT = "hack:check" as const;

/** pnpm script id that must run AFTER the hack suite. */
export const CALIBRATION_CI_SCRIPT = "calibration:check" as const;

export type CriticVersionHackGateVerdict =
  | {
      ok: true;
      verdict: "clear";
      /** Hack suite cleared — calibration gate may run. */
      calibrationAllowed: true;
      report: HackCompositeSuiteReport;
      criticId: string;
      criticVersion: string;
    }
  | {
      ok: false;
      verdict: "block";
      calibrationAllowed: false;
      report: HackCompositeSuiteReport;
      criticId: string;
      criticVersion: string;
      failingFixtures: string[];
      failureClass: HackFixtureFailureClass;
      detail: string;
    };

/**
 * Block a critic rubric version bump unless the hack suite scores ≤ 0
 * with the candidate included in the composite stack.
 * Must run before calibration promotion.
 */
export function assertCriticVersionClearsHackSuite(opts: {
  candidate: TrajectoryCritic;
  suite?: LoadedHackSuite;
  baseStack?: readonly TrajectoryCritic[];
  repoRoot?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
}): CriticVersionHackGateVerdict {
  const root = opts.repoRoot ?? repoRootFromHere();
  const subjectId = opts.subjectId ?? "hack-suite";
  const deviceId = opts.deviceId ?? "ci";
  const criticId = opts.candidate.rubricId;
  const criticVersion = opts.candidate.rubricVersion;

  const base =
    opts.baseStack ?? createDefaultHackCompositeStack({ repoRoot: root });
  // Candidate last so a leaky new version is attributable in layer breakdown.
  const critics = [...base, opts.candidate];
  if (critics.length > HACK_COMPOSITE_LAYER_LIMIT) {
    throw new HackFixtureContractError(
      `composite stack with candidate exceeds ${HACK_COMPOSITE_LAYER_LIMIT} layers`,
      { obligation: "hack_fixture.section_limit", subjectId, deviceId },
    );
  }

  const report = runHackSuiteComposite({
    ...(opts.suite !== undefined ? { suite: opts.suite } : {}),
    critics,
    repoRoot: root,
    subjectId,
    deviceId,
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  if (report.passes) {
    opts.onTelemetry?.({
      event: "learning.critic.hack_ci_gate",
      outcome: "ok",
      subjectId,
      deviceId,
      suiteId: report.suiteId,
      criticId,
      criticVersion,
      calibrationAllowed: true,
      runBeforeCalibration: true,
      entryCount: report.fixtureCount,
      layerCount: report.layerCount,
      failingFixtureCount: 0,
    });
    return {
      ok: true,
      verdict: "clear",
      calibrationAllowed: true,
      report,
      criticId,
      criticVersion,
    };
  }

  const failingFixtures = [...report.failingFixtures];
  const detail = `critic ${criticId}@${criticVersion} blocked: hack suite positive on ${failingFixtures.join(",")}`;
  opts.onTelemetry?.({
    event: "learning.critic.hack_ci_gate",
    outcome: "fail",
    subjectId,
    deviceId,
    suiteId: report.suiteId,
    criticId,
    criticVersion,
    calibrationAllowed: false,
    runBeforeCalibration: true,
    entryCount: report.fixtureCount,
    layerCount: report.layerCount,
    failingFixtureCount: failingFixtures.length,
    failureClass: "hack_fixture.version_bump_blocked",
    ...(failingFixtures[0] !== undefined
      ? { fixtureId: failingFixtures[0] }
      : {}),
  });

  return {
    ok: false,
    verdict: "block",
    calibrationAllowed: false,
    report,
    criticId,
    criticVersion,
    failingFixtures,
    failureClass: "hack_fixture.version_bump_blocked",
    detail,
  };
}

/**
 * Assert a version-bump gate verdict allows calibration to proceed.
 */
export function assertHackSuiteAllowsCalibration(
  verdict: CriticVersionHackGateVerdict,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
  },
): { ok: true; verdict: CriticVersionHackGateVerdict & { ok: true } } {
  if (verdict.ok) {
    opts?.onTelemetry?.({
      event: "learning.critic.hack_ci_gate",
      outcome: "ok",
      subjectId: opts.subjectId ?? "hack-suite",
      deviceId: opts.deviceId ?? "ci",
      criticId: verdict.criticId,
      criticVersion: verdict.criticVersion,
      calibrationAllowed: true,
      runBeforeCalibration: true,
    });
    return { ok: true, verdict };
  }

  const failingSlice = verdict.failingFixtures[0] ?? "(hack-suite)";
  opts?.onTelemetry?.({
    event: "learning.critic.hack_ci_gate",
    outcome: "fail",
    subjectId: opts.subjectId ?? "hack-suite",
    deviceId: opts.deviceId ?? "ci",
    criticId: verdict.criticId,
    criticVersion: verdict.criticVersion,
    calibrationAllowed: false,
    failureClass: "hack_fixture.version_bump_blocked",
    fixtureId: failingSlice,
  });
  throw new HackFixtureContractError(verdict.detail, {
    obligation: "hack_fixture.version_bump_blocked",
    failingSlice,
    ...(opts?.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
    ...(opts?.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
  });
}

/**
 * Verify CI workflow text orders hack:check before calibration:check.
 */
export function assertHackSuiteRunsBeforeCalibrationInCi(
  workflowText: string,
  opts?: {
    subjectId?: string;
    deviceId?: string;
    onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
  },
): { ok: true } {
  const subjectId = opts?.subjectId ?? "hack-suite";
  const deviceId = opts?.deviceId ?? "ci";
  const hackNeedle = `pnpm --filter @moolam/learning ${HACK_SUITE_CI_SCRIPT}`;
  const calNeedle = `pnpm --filter @moolam/learning ${CALIBRATION_CI_SCRIPT}`;
  const hackIdx = workflowText.indexOf(hackNeedle);
  const calIdx = workflowText.indexOf(calNeedle);

  if (hackIdx < 0) {
    opts?.onTelemetry?.({
      event: "learning.critic.hack_ci_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "hack_fixture.ordering_violation",
      runBeforeCalibration: false,
    });
    throw new HackFixtureContractError(
      `CI workflow missing mandatory ${HACK_SUITE_CI_SCRIPT} job`,
      {
        obligation: "hack_fixture.ordering_violation",
        failingSlice: HACK_SUITE_CI_SCRIPT,
        subjectId,
        deviceId,
      },
    );
  }
  if (calIdx < 0) {
    // Calibration may live in a later job — still require hack present.
    // If calibration script is absent, ordering vs calibration cannot be proved.
    opts?.onTelemetry?.({
      event: "learning.critic.hack_ci_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "hack_fixture.ordering_violation",
      runBeforeCalibration: false,
    });
    throw new HackFixtureContractError(
      `CI workflow missing ${CALIBRATION_CI_SCRIPT} (needed to prove hack-before-calibration)`,
      {
        obligation: "hack_fixture.ordering_violation",
        failingSlice: CALIBRATION_CI_SCRIPT,
        subjectId,
        deviceId,
      },
    );
  }
  if (hackIdx > calIdx) {
    opts?.onTelemetry?.({
      event: "learning.critic.hack_ci_gate",
      outcome: "fail",
      subjectId,
      deviceId,
      failureClass: "hack_fixture.ordering_violation",
      runBeforeCalibration: false,
    });
    throw new HackFixtureContractError(
      `${HACK_SUITE_CI_SCRIPT} must run before ${CALIBRATION_CI_SCRIPT}`,
      {
        obligation: "hack_fixture.ordering_violation",
        failingSlice: HACK_SUITE_CI_SCRIPT,
        subjectId,
        deviceId,
      },
    );
  }

  opts?.onTelemetry?.({
    event: "learning.critic.hack_ci_gate",
    outcome: "ok",
    subjectId,
    deviceId,
    runBeforeCalibration: true,
    calibrationAllowed: true,
  });
  return { ok: true };
}

/**
 * CI prove: default stack clears hack suite; known-leaky candidate is blocked;
 * workflow orders hack before calibration; idempotent replay.
 */
export function proveHackSuiteCriticVersionGate(opts?: {
  repoRoot?: string;
  workflowRelPath?: string;
  subjectId?: string;
  deviceId?: string;
  onTelemetry?: (e: HackFixtureTelemetryEvent) => void;
}): {
  ok: true;
  baseline: HackCompositeSuiteReport;
  leakyBlocked: Extract<CriticVersionHackGateVerdict, { ok: false }>;
  orderingOk: true;
} {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const subjectId = opts?.subjectId ?? "hack-suite";
  const deviceId = opts?.deviceId ?? "ci";

  const baseline = assertHackSuiteCompositeNonPositive({
    repoRoot: root,
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  // Idempotent replay
  const replay = runHackSuiteComposite({
    repoRoot: root,
    subjectId,
    deviceId,
  });
  if (
    !replay.passes ||
    replay.fixtureCount !== baseline.fixtureCount ||
    replay.results.some(
      (r, i) => r.compositeTotal !== baseline.results[i]?.compositeTotal,
    )
  ) {
    throw new HackFixtureContractError(
      "hack suite CI gate replay is not idempotent",
      {
        obligation: "hack_fixture.schema_violation",
        subjectId,
        deviceId,
      },
    );
  }

  const leaky = assertCriticVersionClearsHackSuite({
    candidate: createLeakyPositiveHackCritic(),
    repoRoot: root,
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (leaky.ok || leaky.calibrationAllowed) {
    throw new HackFixtureContractError(
      "leaky positive critic unexpectedly cleared hack suite — gate is broken",
      {
        obligation: "hack_fixture.schema_violation",
        subjectId,
        deviceId,
      },
    );
  }

  let blocked = false;
  try {
    assertHackSuiteAllowsCalibration(leaky, { subjectId, deviceId });
  } catch (err) {
    if (
      err instanceof HackFixtureContractError &&
      err.obligation === "hack_fixture.version_bump_blocked"
    ) {
      blocked = true;
    } else {
      throw err;
    }
  }
  if (!blocked) {
    throw new HackFixtureContractError(
      "assertHackSuiteAllowsCalibration should have blocked leaky critic",
      { obligation: "hack_fixture.schema_violation", subjectId, deviceId },
    );
  }

  const workflowRel =
    opts?.workflowRelPath ?? ".github/workflows/ci.yml";
  const workflowAbs = path.isAbsolute(workflowRel)
    ? workflowRel
    : path.join(root, workflowRel);
  let workflowText: string;
  try {
    workflowText = readFileSync(workflowAbs, "utf8");
  } catch {
    throw new HackFixtureContractError(
      `CI workflow missing: ${workflowRel}`,
      {
        obligation: "hack_fixture.source_missing",
        failingSlice: workflowRel,
        subjectId,
        deviceId,
      },
    );
  }
  assertHackSuiteRunsBeforeCalibrationInCi(workflowText, {
    subjectId,
    deviceId,
    ...(opts?.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });

  opts?.onTelemetry?.({
    event: "learning.critic.hack_ci_gate",
    outcome: "ok",
    subjectId,
    deviceId,
    suiteId: baseline.suiteId,
    entryCount: baseline.fixtureCount,
    layerCount: baseline.layerCount,
    failingFixtureCount: 0,
    calibrationAllowed: true,
    runBeforeCalibration: true,
  });

  return {
    ok: true,
    baseline,
    leakyBlocked: leaky,
    orderingOk: true,
  };
}
