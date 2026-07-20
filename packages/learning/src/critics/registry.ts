/**
 * Critic registry — in-process map of TrajectoryCritic by rubric id + version.
 *
 * Domain pack critics register via data/manifest hooks, not by importing
 * domains/ from packages/learning. Stores critics callers construct and
 * register — no network, no LLM. Versions pin content hashes for training
 * lineage; breaking rubric bumps require recalibration before training use.
 */

import { createHash } from "node:crypto";
import {
  CriticContractError,
  type CriticTelemetryEvent,
  type TrajectoryCritic,
} from "./interface.js";

/** Soft caps (NFR — bounded result sets). */
export const CRITIC_CONTENT_HASH_LIMIT = 80;
export const CRITIC_LINEAGE_PIN_LIMIT = 32;
export const CRITIC_RUN_ID_LIMIT = 128;
export const CRITIC_LINEAGE_SCHEMA_VERSION = "critic.lineage.v1" as const;

const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;

/** Manifest hook shape for pack-oracle registration. */
export interface CriticManifestHook {
  rubricId: string;
  rubricVersion: string;
  /** Pack id when registered from a domain pack manifest (data-driven). */
  packId?: string;
  /** Opaque oracle kind: mastery | citation | obligation | contract-smoke */
  oracleKind?: string;
  /** Content hash pinned at registration (sha256:<hex>). */
  contentHash?: string;
}

export type CriticRegistryKey = `${string}@${string}`;

export function criticRegistryKey(
  rubricId: string,
  rubricVersion: string,
): CriticRegistryKey {
  return `${rubricId}@${rubricVersion}`;
}

/** sha256:<64 lowercase hex> of canonical critic identity bytes. */
export function computeCriticContentHash(
  bytes: Buffer | Uint8Array | string,
): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Canonical bytes for a critic version — rubric identity + optional body.
 * Never include learner utterances or raw trajectory payloads.
 */
export function canonicalizeCriticIdentity(input: {
  rubricId: string;
  rubricVersion: string;
  oracleKind?: string;
  packId?: string;
  /** Opaque rubric body (e.g. sorted weights JSON) — not learner content. */
  body?: string;
}): string {
  const parts = [
    input.rubricId,
    input.rubricVersion,
    input.oracleKind ?? "",
    input.packId ?? "",
    input.body ?? "",
  ];
  return parts.join("\0");
}

function assertContentHash(hash: string): void {
  if (
    typeof hash !== "string" ||
    hash.length === 0 ||
    hash.length > CRITIC_CONTENT_HASH_LIMIT ||
    !CONTENT_HASH_RE.test(hash)
  ) {
    throw new CriticContractError(
      "contentHash must be sha256:<64 lowercase hex>",
      { obligation: "critic.hash_mismatch" },
    );
  }
}

/** Parse leading major segment of a rubricVersion (semver-ish). */
export function criticVersionMajor(version: string): number {
  const m = /^(\d+)/.exec(version.trim());
  if (!m) return 0;
  return Number.parseInt(m[1]!, 10);
}

/**
 * Breaking bump: same rubricId, new version whose major increases vs prior.
 * Patch/minor bumps are non-breaking for recalibration gating.
 */
export function isBreakingRubricBump(
  previousVersion: string,
  nextVersion: string,
): boolean {
  return criticVersionMajor(nextVersion) > criticVersionMajor(previousVersion);
}

export type CriticVersionRecord = {
  rubricId: string;
  rubricVersion: string;
  contentHash: string;
  /** False until human accept/reject recalibration is attested. */
  calibrated: boolean;
  breakingBump: boolean;
  packId?: string;
  oracleKind?: string;
};

export type CriticLineagePin = {
  rubricId: string;
  rubricVersion: string;
  contentHash: string;
};

export type TrainingCriticLineageRecord = {
  schemaVersion: typeof CRITIC_LINEAGE_SCHEMA_VERSION;
  runId: string;
  subjectId: string;
  deviceId: string;
  locality: "on-device" | "self-hosted";
  critics: CriticLineagePin[];
  recordedAt: string;
};

export type CriticRegisterOptions = Omit<
  CriticManifestHook,
  "rubricId" | "rubricVersion" | "contentHash"
> & {
  /**
   * Precomputed content hash (sha256:<hex>). When omitted, derived from
   * canonicalizeCriticIdentity(+ optional contentBody).
   */
  contentHash?: string;
  /** Opaque rubric body hashed into contentHash when contentHash omitted. */
  contentBody?: string;
  /**
   * Mark calibrated at register (CI contract-smoke / already-calibrated packs).
   * Breaking bumps ignore this and start uncalibrated.
   */
  calibrated?: boolean;
};

export type CriticRecalibrationAttestation = {
  subjectId: string;
  deviceId: string;
  /** Held-out label count used for agreement check (opaque count only). */
  labelCount: number;
  /** Agreement rate in [0, 1] against accept/reject labels. */
  agreementRate: number;
  /** Declared threshold the harness must meet. */
  threshold: number;
};

export class CriticRegistry {
  private readonly byKey = new Map<CriticRegistryKey, TrajectoryCritic>();
  private readonly versions = new Map<CriticRegistryKey, CriticVersionRecord>();
  /** rubricId → ordered version keys (registration order). */
  private readonly versionsByRubric = new Map<string, CriticRegistryKey[]>();
  private readonly hooks: CriticManifestHook[] = [];
  /** runId → lineage (idempotent replay). */
  private readonly lineageByRun = new Map<string, TrainingCriticLineageRecord>();
  private readonly onTelemetry: ((e: CriticTelemetryEvent) => void) | undefined;

  constructor(opts?: { onTelemetry?: (e: CriticTelemetryEvent) => void }) {
    this.onTelemetry = opts?.onTelemetry;
  }

  /**
   * Register a pure critic with a content-hash version pin.
   * Idempotent when the same rubricId@version is re-registered with the same
   * content hash and critic identity; rejects conflicting replacements.
   * Breaking major bumps start uncalibrated until attestRecalibration.
   */
  register(critic: TrajectoryCritic, hook?: CriticRegisterOptions): void {
    if (!critic?.rubricId || !critic?.rubricVersion) {
      throw new CriticContractError("critic rubricId and rubricVersion required", {
        obligation: "critic.invalid_rubric",
      });
    }
    if (typeof critic.score !== "function") {
      throw new CriticContractError("critic.score must be a function", {
        obligation: "critic.invalid_rubric",
      });
    }

    const oracleKind = hook?.oracleKind ?? "contract-smoke";
    const contentHash =
      hook?.contentHash !== undefined
        ? hook.contentHash
        : computeCriticContentHash(
            canonicalizeCriticIdentity({
              rubricId: critic.rubricId,
              rubricVersion: critic.rubricVersion,
              oracleKind,
              ...(hook?.packId !== undefined ? { packId: hook.packId } : {}),
              ...(hook?.contentBody !== undefined
                ? { body: hook.contentBody }
                : {}),
            }),
          );
    assertContentHash(contentHash);

    const key = criticRegistryKey(critic.rubricId, critic.rubricVersion);
    const existing = this.byKey.get(key);
    const existingVersion = this.versions.get(key);

    if (existing) {
      if (existing !== critic) {
        throw new CriticContractError(
          `critic already registered for ${key}; refuse silent replace`,
          { obligation: "critic.invalid_rubric" },
        );
      }
      if (existingVersion && existingVersion.contentHash !== contentHash) {
        throw new CriticContractError(
          `contentHash mismatch for ${key}: refuse silent rubric rewrite`,
          { obligation: "critic.hash_mismatch" },
        );
      }
      return;
    }

    const priorKeys = this.versionsByRubric.get(critic.rubricId) ?? [];
    let breakingBump = false;
    if (priorKeys.length > 0) {
      const lastKey = priorKeys[priorKeys.length - 1]!;
      const last = this.versions.get(lastKey);
      if (last && isBreakingRubricBump(last.rubricVersion, critic.rubricVersion)) {
        breakingBump = true;
      }
    }

    // Breaking major bumps always start uncalibrated. Otherwise only explicit
    // calibrated:true (CI smoke / already-attested packs) marks ready.
    const calibratedFinal =
      !breakingBump && hook?.calibrated === true;

    this.byKey.set(key, critic);
    const versionRecord: CriticVersionRecord = {
      rubricId: critic.rubricId,
      rubricVersion: critic.rubricVersion,
      contentHash,
      calibrated: calibratedFinal,
      breakingBump,
    };
    if (hook?.packId !== undefined) versionRecord.packId = hook.packId;
    if (oracleKind !== undefined) versionRecord.oracleKind = oracleKind;
    this.versions.set(key, versionRecord);

    const nextKeys = [...priorKeys, key];
    this.versionsByRubric.set(critic.rubricId, nextKeys);

    const entry: CriticManifestHook = {
      rubricId: critic.rubricId,
      rubricVersion: critic.rubricVersion,
      oracleKind,
      contentHash,
    };
    if (hook?.packId !== undefined) {
      entry.packId = hook.packId;
    }
    this.hooks.push(entry);

    this.onTelemetry?.({
      event: "learning.critic.register",
      outcome: breakingBump ? "advisory" : "ok",
      subjectId: "critic-registry",
      deviceId: "ci",
      rubricId: critic.rubricId,
      rubricVersion: critic.rubricVersion,
      contentHash,
      ...(hook?.packId !== undefined ? { packId: hook.packId } : {}),
      oracleKind,
      ...(breakingBump
        ? { failureClass: "critic.recalibration_required" as const }
        : {}),
    });
  }

  get(rubricId: string, rubricVersion: string): TrajectoryCritic | undefined {
    return this.byKey.get(criticRegistryKey(rubricId, rubricVersion));
  }

  getVersion(
    rubricId: string,
    rubricVersion: string,
  ): CriticVersionRecord | undefined {
    return this.versions.get(criticRegistryKey(rubricId, rubricVersion));
  }

  /**
   * Resolve or throw typed contract error (never silent miss).
   */
  require(rubricId: string, rubricVersion: string): TrajectoryCritic {
    const critic = this.get(rubricId, rubricVersion);
    if (!critic) {
      throw new CriticContractError(
        `no critic registered for ${rubricId}@${rubricVersion}`,
        { obligation: "critic.not_registered" },
      );
    }
    return critic;
  }

  /**
   * Require a calibrated critic for training use. Breaking bumps without
   * attestRecalibration fail with critic.recalibration_required.
   */
  requireTrainingReady(
    rubricId: string,
    rubricVersion: string,
  ): { critic: TrajectoryCritic; version: CriticVersionRecord } {
    const critic = this.require(rubricId, rubricVersion);
    const version = this.getVersion(rubricId, rubricVersion);
    if (!version) {
      throw new CriticContractError(
        `no version record for ${rubricId}@${rubricVersion}`,
        { obligation: "critic.not_registered" },
      );
    }
    if (!version.calibrated) {
      this.onTelemetry?.({
        event: "learning.critic.validate",
        outcome: "fail",
        subjectId: "critic-registry",
        deviceId: "ci",
        rubricId,
        rubricVersion,
        contentHash: version.contentHash,
        failureClass: "critic.recalibration_required",
      });
      throw new CriticContractError(
        `critic ${rubricId}@${rubricVersion} requires recalibration before training`,
        { obligation: "critic.recalibration_required" },
      );
    }
    return { critic, version };
  }

  /**
   * Attest human accept/reject calibration for a registered critic version.
   * Agreement must meet threshold; subjectId scopes the attestation.
   */
  attestRecalibration(
    rubricId: string,
    rubricVersion: string,
    attestation: CriticRecalibrationAttestation,
  ): CriticVersionRecord {
    if (!attestation?.subjectId) {
      throw new CriticContractError("subjectId required for recalibration", {
        obligation: "critic.subject_scope",
      });
    }
    if (!attestation.deviceId) {
      throw new CriticContractError("deviceId required for recalibration", {
        obligation: "critic.subject_scope",
        subjectId: attestation.subjectId,
      });
    }
    const version = this.getVersion(rubricId, rubricVersion);
    if (!version) {
      throw new CriticContractError(
        `no critic registered for ${rubricId}@${rubricVersion}`,
        {
          obligation: "critic.not_registered",
          subjectId: attestation.subjectId,
          deviceId: attestation.deviceId,
        },
      );
    }
    if (
      typeof attestation.labelCount !== "number" ||
      !Number.isFinite(attestation.labelCount) ||
      attestation.labelCount < 1 ||
      attestation.labelCount > 10_000
    ) {
      throw new CriticContractError("labelCount out of bounds", {
        obligation: "critic.lineage_invalid",
        subjectId: attestation.subjectId,
        deviceId: attestation.deviceId,
      });
    }
    if (
      typeof attestation.agreementRate !== "number" ||
      !Number.isFinite(attestation.agreementRate) ||
      attestation.agreementRate < 0 ||
      attestation.agreementRate > 1
    ) {
      throw new CriticContractError("agreementRate must be in [0,1]", {
        obligation: "critic.lineage_invalid",
        subjectId: attestation.subjectId,
        deviceId: attestation.deviceId,
      });
    }
    if (
      typeof attestation.threshold !== "number" ||
      !Number.isFinite(attestation.threshold) ||
      attestation.threshold < 0 ||
      attestation.threshold > 1
    ) {
      throw new CriticContractError("threshold must be in [0,1]", {
        obligation: "critic.lineage_invalid",
        subjectId: attestation.subjectId,
        deviceId: attestation.deviceId,
      });
    }
    if (attestation.agreementRate < attestation.threshold) {
      this.onTelemetry?.({
        event: "learning.critic.recalibrate",
        outcome: "fail",
        subjectId: attestation.subjectId,
        deviceId: attestation.deviceId,
        rubricId,
        rubricVersion,
        contentHash: version.contentHash,
        failureClass: "critic.recalibration_required",
      });
      throw new CriticContractError(
        `agreementRate ${attestation.agreementRate} below threshold ${attestation.threshold}`,
        {
          obligation: "critic.recalibration_required",
          subjectId: attestation.subjectId,
          deviceId: attestation.deviceId,
        },
      );
    }

    const updated: CriticVersionRecord = {
      ...version,
      calibrated: true,
    };
    this.versions.set(criticRegistryKey(rubricId, rubricVersion), updated);
    this.onTelemetry?.({
      event: "learning.critic.recalibrate",
      outcome: "ok",
      subjectId: attestation.subjectId,
      deviceId: attestation.deviceId,
      rubricId,
      rubricVersion,
      contentHash: version.contentHash,
    });
    return updated;
  }

  /**
   * Pin critic content hashes into a training-run lineage record.
   * Idempotent for the same runId + subjectId + pin set; refuses cross-subject
   * replay and uncalibrated critics.
   */
  recordTrainingLineage(input: {
    runId: string;
    subjectId: string;
    deviceId: string;
    locality: "on-device" | "self-hosted";
    pins: ReadonlyArray<{ rubricId: string; rubricVersion: string }>;
    recordedAt?: string;
  }): TrainingCriticLineageRecord {
    if (
      typeof input.runId !== "string" ||
      input.runId.length === 0 ||
      input.runId.length > CRITIC_RUN_ID_LIMIT
    ) {
      throw new CriticContractError("runId required and bounded", {
        obligation: "critic.lineage_invalid",
      });
    }
    if (!input.subjectId) {
      throw new CriticContractError("subjectId required for lineage", {
        obligation: "critic.subject_scope",
      });
    }
    if (!input.deviceId) {
      throw new CriticContractError("deviceId required for lineage", {
        obligation: "critic.subject_scope",
        subjectId: input.subjectId,
      });
    }
    if (input.locality !== "on-device" && input.locality !== "self-hosted") {
      throw new CriticContractError("locality must be on-device or self-hosted", {
        obligation: "critic.lineage_invalid",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
    }
    if (!Array.isArray(input.pins) || input.pins.length === 0) {
      throw new CriticContractError("lineage requires ≥1 critic pin", {
        obligation: "critic.lineage_invalid",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
      });
    }
    if (input.pins.length > CRITIC_LINEAGE_PIN_LIMIT) {
      throw new CriticContractError(
        `lineage pin count exceeds ${CRITIC_LINEAGE_PIN_LIMIT}`,
        {
          obligation: "critic.lineage_invalid",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
        },
      );
    }

    const critics: CriticLineagePin[] = [];
    for (const pin of input.pins) {
      const { version } = this.requireTrainingReady(
        pin.rubricId,
        pin.rubricVersion,
      );
      critics.push({
        rubricId: version.rubricId,
        rubricVersion: version.rubricVersion,
        contentHash: version.contentHash,
      });
    }

    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const record: TrainingCriticLineageRecord = {
      schemaVersion: CRITIC_LINEAGE_SCHEMA_VERSION,
      runId: input.runId,
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      locality: input.locality,
      critics,
      recordedAt,
    };

    const prior = this.lineageByRun.get(input.runId);
    if (prior) {
      if (prior.subjectId !== input.subjectId) {
        this.onTelemetry?.({
          event: "learning.critic.lineage",
          outcome: "fail",
          subjectId: input.subjectId,
          deviceId: input.deviceId,
          runId: input.runId,
          failureClass: "critic.subject_scope",
        });
        throw new CriticContractError(
          `runId ${input.runId} already bound to another subject`,
          {
            obligation: "critic.subject_scope",
            subjectId: input.subjectId,
            deviceId: input.deviceId,
          },
        );
      }
      // Idempotent replay: same pins + hashes
      const priorBlob = JSON.stringify(prior.critics);
      const nextBlob = JSON.stringify(critics);
      if (priorBlob !== nextBlob) {
        throw new CriticContractError(
          `lineage replay for ${input.runId} changed critic pins`,
          {
            obligation: "critic.lineage_invalid",
            subjectId: input.subjectId,
            deviceId: input.deviceId,
          },
        );
      }
      this.onTelemetry?.({
        event: "learning.critic.lineage",
        outcome: "ok",
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        runId: input.runId,
      });
      return prior;
    }

    this.lineageByRun.set(input.runId, record);
    const lineageTelemetry: CriticTelemetryEvent = {
      event: "learning.critic.lineage",
      outcome: "ok",
      subjectId: input.subjectId,
      deviceId: input.deviceId,
      runId: input.runId,
    };
    const first = critics[0];
    if (first) {
      lineageTelemetry.contentHash = first.contentHash;
      lineageTelemetry.rubricId = first.rubricId;
      lineageTelemetry.rubricVersion = first.rubricVersion;
    }
    this.onTelemetry?.(lineageTelemetry);
    return record;
  }

  getTrainingLineage(runId: string): TrainingCriticLineageRecord | undefined {
    return this.lineageByRun.get(runId);
  }

  list(): readonly TrajectoryCritic[] {
    return [...this.byKey.values()];
  }

  listHooks(): readonly CriticManifestHook[] {
    return [...this.hooks];
  }

  listVersions(rubricId: string): readonly CriticVersionRecord[] {
    const keys = this.versionsByRubric.get(rubricId) ?? [];
    return keys
      .map((k) => this.versions.get(k))
      .filter((v): v is CriticVersionRecord => v !== undefined);
  }

  clear(): void {
    this.byKey.clear();
    this.versions.clear();
    this.versionsByRubric.clear();
    this.hooks.length = 0;
    this.lineageByRun.clear();
  }
}

/** Process-wide default registry (tests should prefer a fresh instance). */
let defaultRegistry: CriticRegistry | undefined;

export function getDefaultCriticRegistry(): CriticRegistry {
  defaultRegistry ??= new CriticRegistry();
  return defaultRegistry;
}

export function resetDefaultCriticRegistry(): void {
  defaultRegistry = undefined;
}
