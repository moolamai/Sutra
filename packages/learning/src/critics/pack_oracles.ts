/**
 * Pack-oracle registration — data-driven TrajectoryCritics from manifests.
 *
 * Domain packs declare oracles in JSON manifests (mastery / citation / …).
 * packages/learning never imports domains/; it only reads manifest data and
 * constructs pure critics. No network, no LLM on the default path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CRITIC_BREAKDOWN_KEY_LIMIT,
  CRITIC_RUBRIC_ID_LIMIT,
  CRITIC_RUBRIC_VERSION_LIMIT,
  CriticContractError,
  assertCriticScore,
  createCriticScore,
  isRewardHackFixture,
  type CriticScore,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.js";
import {
  CriticRegistry,
  type CriticManifestHook,
} from "./registry.js";
import type { TurnTrajectoryRecord } from "../trajectory_schema.js";

export const CRITIC_PACK_ORACLE_MANIFEST_SCHEMA_VERSION =
  "critic.pack-oracles.v1" as const;

/** Soft caps — bounded manifests (NFR). */
export const CRITIC_PACK_ORACLE_LIMIT = 16;
export const CRITIC_PACK_ID_LIMIT = 128;

/**
 * Repo-relative fixtures for the two CI reference pack oracles.
 * Paths are data hooks — not imports from domains/.
 */
export const REFERENCE_PACK_ORACLE_MANIFESTS = Object.freeze([
  "training/critics/fixtures/pack-oracles/teacher-mastery.manifest.json",
  "training/critics/fixtures/pack-oracles/teacher-citation.manifest.json",
] as const);

export const PACK_ORACLE_KINDS = Object.freeze([
  "mastery",
  "citation",
  "obligation",
  "contract-smoke",
] as const);

export type PackOracleKind = (typeof PACK_ORACLE_KINDS)[number];

const weightMapSchema = z
  .record(z.string().min(1).max(64), z.number().finite())
  .refine((m) => Object.keys(m).length <= CRITIC_BREAKDOWN_KEY_LIMIT, {
    message: `weights exceed ${CRITIC_BREAKDOWN_KEY_LIMIT} keys`,
  });

export const packOracleEntrySchema = z.object({
  rubricId: z.string().min(1).max(CRITIC_RUBRIC_ID_LIMIT),
  rubricVersion: z.string().min(1).max(CRITIC_RUBRIC_VERSION_LIMIT),
  oracleKind: z.enum(PACK_ORACLE_KINDS),
  /** Deterministic component weights applied when the oracle rule fires. */
  weights: weightMapSchema,
  /** Optional human-facing label — never learner content. */
  title: z.string().max(256).optional(),
});

export const packOracleManifestSchema = z.object({
  schemaVersion: z.literal(CRITIC_PACK_ORACLE_MANIFEST_SCHEMA_VERSION),
  packId: z.string().min(1).max(CRITIC_PACK_ID_LIMIT),
  oracles: z
    .array(packOracleEntrySchema)
    .min(1)
    .max(CRITIC_PACK_ORACLE_LIMIT),
});

export type PackOracleEntry = z.infer<typeof packOracleEntrySchema>;
export type PackOracleManifest = z.infer<typeof packOracleManifestSchema>;

export type PackOracleTelemetryEvent = CriticTelemetryEvent;

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/learning/src/critics → repo root
  return path.resolve(here, "..", "..", "..", "..");
}

/**
 * Parse a pack-oracle manifest object (throws CriticContractError).
 */
export function parsePackOracleManifest(raw: unknown): PackOracleManifest {
  const parsed = packOracleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CriticContractError(
      `pack oracle manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      { obligation: "critic.invalid_manifest" },
    );
  }
  const ids = new Set<string>();
  for (const o of parsed.data.oracles) {
    const key = `${o.rubricId}@${o.rubricVersion}`;
    if (ids.has(key)) {
      throw new CriticContractError(
        `duplicate oracle ${key} in pack ${parsed.data.packId}`,
        { obligation: "critic.invalid_manifest" },
      );
    }
    ids.add(key);
  }
  return parsed.data;
}

/**
 * Load + parse a pack-oracle manifest from disk (repo-relative or absolute).
 */
export function loadPackOracleManifest(
  manifestPath: string,
  opts?: { repoRoot?: string },
): PackOracleManifest {
  const root = opts?.repoRoot ?? repoRootFromHere();
  const abs = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(root, manifestPath);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new CriticContractError(`pack oracle manifest missing: ${manifestPath}`, {
      obligation: "critic.invalid_manifest",
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CriticContractError(`pack oracle manifest not JSON: ${manifestPath}`, {
      obligation: "critic.invalid_manifest",
    });
  }
  return parsePackOracleManifest(json);
}

/**
 * Pure rule: does this trajectory show a positive mastery-style signal?
 * Verifiable from stage statuses only — never LLM, never utterance text.
 */
export function evaluateMasteryOracleSignal(
  record: TurnTrajectoryRecord,
): boolean {
  if (isRewardHackFixture(record)) return false;
  return record.stages.some(
    (s) =>
      s.status === "ok" &&
      (s.stage === "assess" ||
        s.stage === "act" ||
        s.opCode?.includes("mastery") === true ||
        s.opCode?.includes("exercise") === true),
  );
}

/**
 * Pure rule: citation / knowledge resolution signal from stage opCodes.
 */
export function evaluateCitationOracleSignal(
  record: TurnTrajectoryRecord,
): boolean {
  if (isRewardHackFixture(record)) return false;
  return record.stages.some(
    (s) =>
      s.status === "ok" &&
      (s.opCode?.includes("cite") === true ||
        s.opCode?.includes("knowledge") === true ||
        s.opCode?.includes("retrieve") === true ||
        s.stage === "retrieve"),
  );
}

function emitScoreTelemetry(
  onTelemetry: ((e: PackOracleTelemetryEvent) => void) | undefined,
  base: {
    outcome: CriticTelemetryEvent["outcome"];
    subjectId: string;
    deviceId: string;
    rubricId: string;
    rubricVersion: string;
    oracleKind: PackOracleKind;
    failureClass?: CriticTelemetryEvent["failureClass"];
    total?: number;
    breakdownKeys?: string[];
  },
  packId: string | undefined,
): void {
  if (!onTelemetry) return;
  const event: PackOracleTelemetryEvent = {
    event: "learning.critic.score",
    outcome: base.outcome,
    subjectId: base.subjectId,
    deviceId: base.deviceId,
    rubricId: base.rubricId,
    rubricVersion: base.rubricVersion,
    oracleKind: base.oracleKind,
  };
  if (packId !== undefined) event.packId = packId;
  if (base.failureClass !== undefined) event.failureClass = base.failureClass;
  if (base.total !== undefined) event.total = base.total;
  if (base.breakdownKeys !== undefined) event.breakdownKeys = base.breakdownKeys;
  onTelemetry(event);
}

/**
 * Build a pure TrajectoryCritic from a manifest oracle entry.
 */
export function createPackOracleCritic(
  entry: PackOracleEntry,
  opts?: {
    packId?: string;
    onTelemetry?: (e: PackOracleTelemetryEvent) => void;
  },
): TrajectoryCritic {
  const { rubricId, rubricVersion, oracleKind, weights } = entry;
  const packId = opts?.packId;
  const onTelemetry = opts?.onTelemetry;

  const evaluate =
    oracleKind === "citation"
      ? evaluateCitationOracleSignal
      : oracleKind === "mastery" || oracleKind === "obligation"
        ? evaluateMasteryOracleSignal
        : (record: TurnTrajectoryRecord) => !isRewardHackFixture(record);

  return {
    rubricId,
    rubricVersion,
    score(record: TurnTrajectoryRecord): CriticScore {
      const subjectId = record?.subjectId ?? "unknown";
      const deviceId = record?.deviceId ?? "unknown";

      if (!record?.subjectId) {
        emitScoreTelemetry(
          onTelemetry,
          {
            outcome: "fail",
            subjectId,
            deviceId,
            rubricId,
            rubricVersion,
            oracleKind,
            failureClass: "critic.subject_scope",
          },
          packId,
        );
        throw new CriticContractError("subjectId required on trajectory", {
          obligation: "critic.subject_scope",
          subjectId,
          deviceId,
        });
      }

      if (isRewardHackFixture(record)) {
        const score = createCriticScore({ reward_hack_guard: 0 }, rubricVersion);
        emitScoreTelemetry(
          onTelemetry,
          {
            outcome: "advisory",
            subjectId,
            deviceId,
            rubricId,
            rubricVersion,
            oracleKind,
            failureClass: "critic.reward_hack",
            total: 0,
            breakdownKeys: ["reward_hack_guard"],
          },
          packId,
        );
        return score;
      }

      const fired = evaluate(record);
      const breakdown: Record<string, number> = {};
      if (fired) {
        for (const [k, v] of Object.entries(weights)) {
          breakdown[k] = v;
        }
      } else {
        breakdown.oracle_hold = 0;
      }
      const score = createCriticScore(breakdown, rubricVersion);
      assertCriticScore(score, rubricVersion);
      emitScoreTelemetry(
        onTelemetry,
        {
          outcome: "ok",
          subjectId,
          deviceId,
          rubricId,
          rubricVersion,
          oracleKind,
          total: score.total,
          breakdownKeys: Object.keys(score.breakdown).sort(),
        },
        packId,
      );
      return score;
    },
  };
}

export type RegisterPackOraclesResult = {
  packId: string;
  registered: CriticManifestHook[];
  critics: TrajectoryCritic[];
};

/**
 * Register all oracles from a parsed (or loaded) pack manifest into a registry.
 * Idempotent for identical rubricId@version; refuses conflicting replacements.
 */
export function registerPackOraclesFromManifest(
  registry: CriticRegistry,
  manifest: PackOracleManifest | string,
  opts?: {
    repoRoot?: string;
    onTelemetry?: (e: PackOracleTelemetryEvent) => void;
  },
): RegisterPackOraclesResult {
  const loadOpts =
    opts?.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : undefined;
  const doc =
    typeof manifest === "string"
      ? loadPackOracleManifest(manifest, loadOpts)
      : manifest;

  opts?.onTelemetry?.({
    event: "learning.critic.pack_oracle.load",
    outcome: "ok",
    subjectId: "pack-oracle-loader",
    deviceId: "ci",
    packId: doc.packId,
  });

  const critics: TrajectoryCritic[] = [];
  const registered: CriticManifestHook[] = [];

  for (const entry of doc.oracles) {
    const criticOpts: {
      packId: string;
      onTelemetry?: (e: PackOracleTelemetryEvent) => void;
    } = { packId: doc.packId };
    if (opts?.onTelemetry !== undefined) {
      criticOpts.onTelemetry = opts.onTelemetry;
    }
    const critic = createPackOracleCritic(entry, criticOpts);
    registry.register(critic, {
      packId: doc.packId,
      oracleKind: entry.oracleKind,
    });
    critics.push(critic);
    registered.push({
      rubricId: entry.rubricId,
      rubricVersion: entry.rubricVersion,
      packId: doc.packId,
      oracleKind: entry.oracleKind,
    });
    opts?.onTelemetry?.({
      event: "learning.critic.pack_oracle.register",
      outcome: "ok",
      subjectId: "pack-oracle-loader",
      deviceId: "ci",
      packId: doc.packId,
      rubricId: entry.rubricId,
      rubricVersion: entry.rubricVersion,
      oracleKind: entry.oracleKind,
    });
  }

  return { packId: doc.packId, registered, critics };
}

/**
 * Load the two CI reference pack-oracle manifests and register them.
 * Satisfies phase exit: "two pack oracles registered".
 */
export function registerReferencePackOracles(
  registry: CriticRegistry,
  opts?: {
    repoRoot?: string;
    manifestPaths?: readonly string[];
    onTelemetry?: (e: PackOracleTelemetryEvent) => void;
  },
): RegisterPackOraclesResult[] {
  const paths = opts?.manifestPaths ?? REFERENCE_PACK_ORACLE_MANIFESTS;
  if (paths.length < 2) {
    throw new CriticContractError(
      "reference pack oracles require ≥2 manifests (mastery + citation)",
      { obligation: "critic.invalid_manifest" },
    );
  }
  return paths.map((p) => {
    const registerOpts: {
      repoRoot?: string;
      onTelemetry?: (e: PackOracleTelemetryEvent) => void;
    } = {};
    if (opts?.repoRoot !== undefined) registerOpts.repoRoot = opts.repoRoot;
    if (opts?.onTelemetry !== undefined) {
      registerOpts.onTelemetry = opts.onTelemetry;
    }
    return registerPackOraclesFromManifest(registry, p, registerOpts);
  });
}
