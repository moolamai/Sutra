/**
 * Offline batch collector — scan B9 export path, consent-class filter,
 * enqueue to trajectory queue, count-threshold gate before training.
 *
 * Nightly / scheduled fleets: no 24/7 accelerator assumption. Below-threshold
 * runs emit a skip verdict (never an empty candidate). Wall-clock overrun
 * stops the scan and reports advisory progress — never silent overrun.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  openLocalEncryptedTrajectoryQueue,
  TrajectoryQueueContractError,
  type TrajectoryQueueConsentGateOptions,
  type TrajectoryQueueTelemetryEvent,
  type TrajectoryQueueTransport,
} from "./trajectory_queue.js";
import {
  parseTurnTrajectoryRecord,
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryConsentClass,
  type TurnTrajectoryRecord,
} from "./trajectory_schema.js";

export const OFFLINE_BATCH_CONFIG_SCHEMA_VERSION =
  "offline.batch.config.v1" as const;

/** Hundreds-class default for first real training jobs. */
export const OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT = 100;

/** Soft cap on files walked per collect (NFR — bounded scans). */
export const OFFLINE_BATCH_SCAN_FILE_LIMIT_DEFAULT = 2_000;

/** Default wall clock for one collect pass (5 minutes). */
export const OFFLINE_BATCH_WALL_CLOCK_MS_DEFAULT = 300_000;

/** Published config artifact under training/pipeline. */
export const OFFLINE_BATCH_CONFIG_RELPATH =
  "training/pipeline/batch_config.json" as const;

export type OfflineBatchFailureClass =
  | "batch.config_invalid"
  | "batch.export_missing"
  | "batch.export_unreadable"
  | "batch.parse_failed"
  | "batch.consent_filtered"
  | "batch.subject_scope"
  | "batch.deadline"
  | "batch.accelerator_unavailable"
  | "batch.below_threshold"
  | "batch.queue_error";

export type OfflineBatchVerdict = "ready" | "skip" | "defer" | "candidate";

export type OfflineBatchSkipReason =
  | "below_threshold"
  | "deadline"
  | "export_empty"
  | "accelerator_unavailable";

export type OfflineBatchConfig = {
  schemaVersion: typeof OFFLINE_BATCH_CONFIG_SCHEMA_VERSION;
  /** Filesystem root of B9 consented trajectory exports (JSON / JSONL). */
  b9ExportPath: string;
  allowedConsentClasses: readonly TrajectoryConsentClass[];
  /** Minimum consented enqueues before training may start. */
  minTrajectoryCount: number;
  maxScanFiles: number;
  /** Collect-pass wall clock (ms). */
  wallClockMs: number;
  queueMaxDepth: number;
  locality: "on-device" | "self-hosted";
  /** Training-window wall clock (ms); defaults to wallClockMs when omitted. */
  trainingWallClockMs?: number;
  /** Soft cap on SFT/GRPO steps inside one training window. */
  maxTrainingSteps?: number;
};

export type OfflineBatchTelemetryEvent = {
  event:
    | "learning.batch.collect"
    | "learning.batch.scan"
    | "learning.batch.filter"
    | "learning.batch.enqueue"
    | "learning.batch.threshold"
    | "learning.batch.deadline"
    | "learning.batch.defer"
    | "learning.batch.train"
    | "learning.batch.critic"
    | "learning.batch.sft"
    | "learning.batch.grpo"
    | "learning.batch.lineage"
    | "learning.batch.candidate"
    | "learning.batch.skip_lineage";
  outcome: "ok" | "fail" | "advisory";
  subjectId: string;
  deviceId: string;
  verdict?: OfflineBatchVerdict;
  skipReason?: OfflineBatchSkipReason;
  failureClass?: OfflineBatchFailureClass;
  scanned?: number;
  filteredOut?: number;
  enqueued?: number;
  queueDepth?: number;
  minTrajectoryCount?: number;
  consentClass?: TrajectoryConsentClass;
  turnId?: string;
  policyCheckpointHash?: string;
  elapsedMs?: number;
  stage?: string;
  stepsUsed?: number;
  maxTrainingSteps?: number;
  candidateId?: string;
  checkpointHash?: string;
  parentCheckpointHash?: string;
};

export class OfflineBatchContractError extends Error {
  readonly obligation: OfflineBatchFailureClass;
  readonly subjectId: string | undefined;
  readonly deviceId: string | undefined;
  readonly failingSlice: string | undefined;
  readonly diff: string | undefined;

  constructor(
    message: string,
    meta: {
      obligation: OfflineBatchFailureClass;
      subjectId?: string;
      deviceId?: string;
      failingSlice?: string;
      diff?: string;
    },
  ) {
    super(message);
    this.name = "OfflineBatchContractError";
    this.obligation = meta.obligation;
    this.subjectId = meta.subjectId;
    this.deviceId = meta.deviceId;
    this.failingSlice = meta.failingSlice;
    this.diff = meta.diff;
  }
}

function emit(
  onTelemetry: ((e: OfflineBatchTelemetryEvent) => void) | undefined,
  event: OfflineBatchTelemetryEvent,
): void {
  onTelemetry?.(event);
}

function isConsentClass(v: unknown): v is TrajectoryConsentClass {
  return v === "research" || v === "product-improve" || v === "personal";
}

/**
 * Parse and validate offline batch config (committed JSON or override object).
 */
export function parseOfflineBatchConfig(
  input: unknown,
  opts?: { subjectId?: string; deviceId?: string },
): OfflineBatchConfig {
  const subjectId = opts?.subjectId ?? "batch";
  const deviceId = opts?.deviceId ?? "ci";

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new OfflineBatchContractError("batch config must be a JSON object", {
      obligation: "batch.config_invalid",
      subjectId,
      deviceId,
      diff: `typeof=${input === null ? "null" : typeof input}`,
    });
  }

  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== OFFLINE_BATCH_CONFIG_SCHEMA_VERSION) {
    throw new OfflineBatchContractError("batch config schemaVersion mismatch", {
      obligation: "batch.config_invalid",
      subjectId,
      deviceId,
      failingSlice: "schemaVersion",
      diff: `expected=${OFFLINE_BATCH_CONFIG_SCHEMA_VERSION} actual=${String(raw.schemaVersion)}`,
    });
  }

  if (typeof raw.b9ExportPath !== "string" || raw.b9ExportPath.length < 1) {
    throw new OfflineBatchContractError("b9ExportPath required", {
      obligation: "batch.config_invalid",
      subjectId,
      deviceId,
      failingSlice: "b9ExportPath",
    });
  }

  if (!Array.isArray(raw.allowedConsentClasses) || raw.allowedConsentClasses.length < 1) {
    throw new OfflineBatchContractError(
      "allowedConsentClasses must be a non-empty array",
      {
        obligation: "batch.config_invalid",
        subjectId,
        deviceId,
        failingSlice: "allowedConsentClasses",
      },
    );
  }

  const allowed: TrajectoryConsentClass[] = [];
  for (const c of raw.allowedConsentClasses) {
    if (!isConsentClass(c)) {
      throw new OfflineBatchContractError(
        `unknown consent class in batch config: ${String(c)}`,
        {
          obligation: "batch.config_invalid",
          subjectId,
          deviceId,
          failingSlice: String(c),
        },
      );
    }
    allowed.push(c);
  }

  const minTrajectoryCount =
    typeof raw.minTrajectoryCount === "number" &&
    Number.isFinite(raw.minTrajectoryCount) &&
    raw.minTrajectoryCount >= 1
      ? Math.floor(raw.minTrajectoryCount)
      : OFFLINE_BATCH_MIN_TRAJECTORY_COUNT_DEFAULT;

  const maxScanFiles =
    typeof raw.maxScanFiles === "number" &&
    Number.isFinite(raw.maxScanFiles) &&
    raw.maxScanFiles >= 1
      ? Math.min(Math.floor(raw.maxScanFiles), 10_000)
      : OFFLINE_BATCH_SCAN_FILE_LIMIT_DEFAULT;

  const wallClockMs =
    typeof raw.wallClockMs === "number" &&
    Number.isFinite(raw.wallClockMs) &&
    raw.wallClockMs >= 1
      ? Math.floor(raw.wallClockMs)
      : OFFLINE_BATCH_WALL_CLOCK_MS_DEFAULT;

  const queueMaxDepth =
    typeof raw.queueMaxDepth === "number" &&
    Number.isFinite(raw.queueMaxDepth) &&
    raw.queueMaxDepth >= 1
      ? Math.floor(raw.queueMaxDepth)
      : 2_048;

  const locality =
    raw.locality === "self-hosted" ? "self-hosted" : "on-device";

  const trainingWallClockMs =
    typeof raw.trainingWallClockMs === "number" &&
    Number.isFinite(raw.trainingWallClockMs) &&
    raw.trainingWallClockMs >= 1
      ? Math.floor(raw.trainingWallClockMs)
      : undefined;

  const maxTrainingSteps =
    typeof raw.maxTrainingSteps === "number" &&
    Number.isFinite(raw.maxTrainingSteps) &&
    raw.maxTrainingSteps >= 1
      ? Math.floor(raw.maxTrainingSteps)
      : undefined;

  return {
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    b9ExportPath: raw.b9ExportPath,
    allowedConsentClasses: Object.freeze(allowed),
    minTrajectoryCount,
    maxScanFiles,
    wallClockMs,
    queueMaxDepth,
    locality,
    ...(trainingWallClockMs !== undefined ? { trainingWallClockMs } : {}),
    ...(maxTrainingSteps !== undefined ? { maxTrainingSteps } : {}),
  };
}

export function loadOfflineBatchConfigFile(
  configPath: string,
  opts?: { subjectId?: string; deviceId?: string },
): OfflineBatchConfig {
  if (!existsSync(configPath)) {
    throw new OfflineBatchContractError(
      `batch config not found: ${configPath}`,
      {
        obligation: "batch.config_invalid",
        subjectId: opts?.subjectId ?? "batch",
        deviceId: opts?.deviceId ?? "ci",
        failingSlice: configPath,
      },
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  return parseOfflineBatchConfig(raw, opts);
}

function listExportFiles(exportRoot: string, maxFiles: number): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Deterministic order for reproducible collects.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };

  walk(exportRoot);
  return out;
}

function parseExportFile(
  filePath: string,
  ctx: { subjectId: string; deviceId: string },
): TurnTrajectoryRecord[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new OfflineBatchContractError(
      `unreadable B9 export file: ${filePath}`,
      {
        obligation: "batch.export_unreadable",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        failingSlice: filePath,
        diff: err instanceof Error ? err.message : String(err),
      },
    );
  }

  const records: TurnTrajectoryRecord[] = [];
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      let raw: unknown;
      try {
        raw = JSON.parse(lines[i]!);
      } catch {
        throw new OfflineBatchContractError(
          `JSONL parse failed at ${filePath}:${i + 1}`,
          {
            obligation: "batch.parse_failed",
            subjectId: ctx.subjectId,
            deviceId: ctx.deviceId,
            failingSlice: `${filePath}:${i + 1}`,
          },
        );
      }
      const parsed = parseTurnTrajectoryRecord(raw);
      if (!parsed.ok) {
        throw new OfflineBatchContractError(
          `trajectory schema violation at ${filePath}:${i + 1}: ${parsed.detail}`,
          {
            obligation: "batch.parse_failed",
            subjectId: parsed.subjectId ?? ctx.subjectId,
            deviceId: ctx.deviceId,
            failingSlice: `${filePath}:${i + 1}`,
            diff: parsed.failureClass,
          },
        );
      }
      records.push(parsed.record);
    }
    return records;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OfflineBatchContractError(`JSON parse failed: ${filePath}`, {
      obligation: "batch.parse_failed",
      subjectId: ctx.subjectId,
      deviceId: ctx.deviceId,
      failingSlice: filePath,
    });
  }

  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const parsed = parseTurnTrajectoryRecord(raw[i]);
      if (!parsed.ok) {
        throw new OfflineBatchContractError(
          `trajectory schema violation at ${filePath}[${i}]: ${parsed.detail}`,
          {
            obligation: "batch.parse_failed",
            subjectId: parsed.subjectId ?? ctx.subjectId,
            deviceId: ctx.deviceId,
            failingSlice: `${filePath}[${i}]`,
            diff: parsed.failureClass,
          },
        );
      }
      records.push(parsed.record);
    }
    return records;
  }

  const parsed = parseTurnTrajectoryRecord(raw);
  if (!parsed.ok) {
    throw new OfflineBatchContractError(
      `trajectory schema violation at ${filePath}: ${parsed.detail}`,
      {
        obligation: "batch.parse_failed",
        subjectId: parsed.subjectId ?? ctx.subjectId,
        deviceId: ctx.deviceId,
        failingSlice: filePath,
        diff: parsed.failureClass,
      },
    );
  }
  records.push(parsed.record);
  return records;
}

/** Deterministic queue id so re-scans are idempotent. */
export function batchQueueRecordId(record: TurnTrajectoryRecord): string {
  const digest = createHash("sha256")
    .update(`${record.subjectId}\0${record.turnId}\0${record.sessionId}`)
    .digest("hex")
    .slice(0, 16);
  return `qr.batch.${digest}`;
}

function passesConsentFilter(
  record: TurnTrajectoryRecord,
  allowed: readonly TrajectoryConsentClass[],
): { ok: true } | { ok: false; reason: OfflineBatchFailureClass } {
  const consent = record.consent;
  if (!consent || consent.optedIn !== true) {
    return { ok: false, reason: "batch.consent_filtered" };
  }
  if (!isConsentClass(consent.consentClass)) {
    return { ok: false, reason: "batch.consent_filtered" };
  }
  if (!allowed.includes(consent.consentClass)) {
    return { ok: false, reason: "batch.consent_filtered" };
  }
  // personal is never a training-eligible batch class unless explicitly allowed
  // (config may include it; default config does not).
  return { ok: true };
}

export type CollectConsentedBatchResult = {
  ok: true;
  verdict: OfflineBatchVerdict;
  skipReason?: OfflineBatchSkipReason;
  scanned: number;
  filteredOut: number;
  enqueued: number;
  queueDepth: number;
  minTrajectoryCount: number;
  elapsedMs: number;
  subjectIds: string[];
  policyCheckpointHashes: string[];
  schemaVersion: typeof OFFLINE_BATCH_CONFIG_SCHEMA_VERSION;
};

/**
 * Scheduled collect: scan B9 export path → consent filter → enqueue → threshold.
 */
export function collectConsentedTrajectories(opts: {
  config: OfflineBatchConfig;
  /** Absolute or relative B9 export directory (overrides config.b9ExportPath). */
  exportRoot?: string;
  queue?: TrajectoryQueueTransport;
  queueRootDir?: string;
  queueKeyMaterial?: string;
  subjectId?: string;
  deviceId?: string;
  /** When false, defer without mutating lineage / corrupting in-flight state. */
  acceleratorAvailable?: boolean;
  /** ISO lower-bound: skip records with capturedAt strictly before this. */
  sinceCapturedAt?: string;
  nowMs?: () => number;
  onTelemetry?: (e: OfflineBatchTelemetryEvent) => void;
  onQueueTelemetry?: (e: TrajectoryQueueTelemetryEvent) => void;
}): CollectConsentedBatchResult {
  const started = (opts.nowMs ?? Date.now)();
  const subjectId = opts.subjectId ?? "batch.fleet";
  const deviceId = opts.deviceId ?? "batch.device";
  const config = opts.config;
  const exportRoot = path.resolve(opts.exportRoot ?? config.b9ExportPath);
  const tel = opts.onTelemetry;

  if (opts.acceleratorAvailable === false) {
    emit(tel, {
      event: "learning.batch.defer",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "defer",
      skipReason: "accelerator_unavailable",
      failureClass: "batch.accelerator_unavailable",
    });
    return {
      ok: true,
      verdict: "defer",
      skipReason: "accelerator_unavailable",
      scanned: 0,
      filteredOut: 0,
      enqueued: 0,
      queueDepth: opts.queue?.depth() ?? 0,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs: (opts.nowMs ?? Date.now)() - started,
      subjectIds: [],
      policyCheckpointHashes: [],
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    };
  }

  if (!existsSync(exportRoot) || !statSync(exportRoot).isDirectory()) {
    throw new OfflineBatchContractError(
      `B9 export path missing or not a directory: ${exportRoot}`,
      {
        obligation: "batch.export_missing",
        subjectId,
        deviceId,
        failingSlice: exportRoot,
      },
    );
  }

  const consentGate: TrajectoryQueueConsentGateOptions = {
    allowedConsentClasses: config.allowedConsentClasses,
  };

  const queue =
    opts.queue ??
    openLocalEncryptedTrajectoryQueue({
      rootDir:
        opts.queueRootDir ??
        path.join(exportRoot, "..", "batch-queue"),
      keyMaterial: opts.queueKeyMaterial ?? "offline-batch-collector-v1",
      maxDepth: config.queueMaxDepth,
      consentGate,
      ...(opts.onQueueTelemetry !== undefined
        ? { onTelemetry: opts.onQueueTelemetry }
        : {}),
    });

  const files = listExportFiles(exportRoot, config.maxScanFiles);
  emit(tel, {
    event: "learning.batch.scan",
    outcome: "ok",
    subjectId,
    deviceId,
    scanned: files.length,
  });

  let scanned = 0;
  let filteredOut = 0;
  let enqueued = 0;
  let hitDeadline = false;
  const subjectSet = new Set<string>();
  const hashSet = new Set<string>();

  for (const file of files) {
    const elapsed = (opts.nowMs ?? Date.now)() - started;
    if (elapsed > config.wallClockMs) {
      hitDeadline = true;
      emit(tel, {
        event: "learning.batch.deadline",
        outcome: "advisory",
        subjectId,
        deviceId,
        failureClass: "batch.deadline",
        scanned,
        enqueued,
        elapsedMs: elapsed,
      });
      break;
    }

    const records = parseExportFile(file, { subjectId, deviceId });
    for (const record of records) {
      scanned += 1;

      if (
        opts.subjectId !== undefined &&
        record.subjectId !== opts.subjectId
      ) {
        filteredOut += 1;
        emit(tel, {
          event: "learning.batch.filter",
          outcome: "advisory",
          subjectId: opts.subjectId,
          deviceId,
          failureClass: "batch.subject_scope",
          turnId: record.turnId,
        });
        continue;
      }

      if (
        opts.sinceCapturedAt !== undefined &&
        record.capturedAt < opts.sinceCapturedAt
      ) {
        filteredOut += 1;
        continue;
      }

      const consent = passesConsentFilter(
        record,
        config.allowedConsentClasses,
      );
      if (!consent.ok) {
        filteredOut += 1;
        emit(tel, {
          event: "learning.batch.filter",
          outcome: "advisory",
          subjectId: record.subjectId,
          deviceId: record.deviceId ?? deviceId,
          failureClass: consent.reason,
          turnId: record.turnId,
          consentClass: record.consent?.consentClass,
        });
        continue;
      }

      if (!record.policyCheckpointHash) {
        filteredOut += 1;
        emit(tel, {
          event: "learning.batch.filter",
          outcome: "advisory",
          subjectId: record.subjectId,
          deviceId: record.deviceId ?? deviceId,
          failureClass: "batch.consent_filtered",
          turnId: record.turnId,
        });
        continue;
      }

      try {
        const result = queue.enqueue({
          trajectory: record,
          queueRecordId: batchQueueRecordId(record),
          ...(record.deviceId !== undefined
            ? { deviceId: record.deviceId }
            : { deviceId }),
          allowedConsentClasses: config.allowedConsentClasses,
        });
        if (!result.idempotentReplay) {
          enqueued += 1;
        }
        subjectSet.add(record.subjectId);
        hashSet.add(record.policyCheckpointHash);
        emit(tel, {
          event: "learning.batch.enqueue",
          outcome: "ok",
          subjectId: record.subjectId,
          deviceId: record.deviceId ?? deviceId,
          turnId: record.turnId,
          consentClass: record.consent.consentClass,
          policyCheckpointHash: record.policyCheckpointHash,
          enqueued,
          queueDepth: queue.depth(),
        });
      } catch (err) {
        if (err instanceof TrajectoryQueueContractError) {
          throw new OfflineBatchContractError(err.message, {
            obligation: "batch.queue_error",
            subjectId: err.subjectId ?? record.subjectId,
            deviceId: err.deviceId ?? deviceId,
            failingSlice: err.failingSlice ?? record.turnId,
            diff: err.obligation,
          });
        }
        throw err;
      }
    }
  }

  const queueDepth = queue.depth();
  const elapsedMs = (opts.nowMs ?? Date.now)() - started;
  const subjectIds = [...subjectSet].sort();
  const policyCheckpointHashes = [...hashSet].sort();

  if (scanned === 0 && files.length === 0) {
    emit(tel, {
      event: "learning.batch.threshold",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "skip",
      skipReason: "export_empty",
      failureClass: "batch.below_threshold",
      scanned: 0,
      enqueued: 0,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
    });
    return {
      ok: true,
      verdict: "skip",
      skipReason: "export_empty",
      scanned: 0,
      filteredOut: 0,
      enqueued: 0,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
      subjectIds,
      policyCheckpointHashes,
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    };
  }

  if (hitDeadline && enqueued < config.minTrajectoryCount) {
    emit(tel, {
      event: "learning.batch.threshold",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "skip",
      skipReason: "deadline",
      failureClass: "batch.deadline",
      scanned,
      filteredOut,
      enqueued,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
    });
    return {
      ok: true,
      verdict: "skip",
      skipReason: "deadline",
      scanned,
      filteredOut,
      enqueued,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
      subjectIds,
      policyCheckpointHashes,
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    };
  }

  if (enqueued < config.minTrajectoryCount) {
    emit(tel, {
      event: "learning.batch.threshold",
      outcome: "advisory",
      subjectId,
      deviceId,
      verdict: "skip",
      skipReason: "below_threshold",
      failureClass: "batch.below_threshold",
      scanned,
      filteredOut,
      enqueued,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
    });
    return {
      ok: true,
      verdict: "skip",
      skipReason: "below_threshold",
      scanned,
      filteredOut,
      enqueued,
      queueDepth,
      minTrajectoryCount: config.minTrajectoryCount,
      elapsedMs,
      subjectIds,
      policyCheckpointHashes,
      schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    };
  }

  emit(tel, {
    event: "learning.batch.collect",
    outcome: "ok",
    subjectId,
    deviceId,
    verdict: "ready",
    scanned,
    filteredOut,
    enqueued,
    queueDepth,
    minTrajectoryCount: config.minTrajectoryCount,
    elapsedMs,
  });

  return {
    ok: true,
    verdict: "ready",
    scanned,
    filteredOut,
    enqueued,
    queueDepth,
    minTrajectoryCount: config.minTrajectoryCount,
    elapsedMs,
    subjectIds,
    policyCheckpointHashes,
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
  };
}

function draftTrajectory(
  overrides: Partial<TurnTrajectoryRecord> & {
    subjectId: string;
    turnId: string;
  },
): TurnTrajectoryRecord {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId: overrides.subjectId,
    sessionId: overrides.sessionId ?? "sess.batch.01",
    turnId: overrides.turnId,
    deviceId: overrides.deviceId ?? "dev.batch.01",
    capturedAt: overrides.capturedAt ?? "2026-07-16T18:00:00.000Z",
    locality: overrides.locality ?? "on-device",
    consent: overrides.consent ?? {
      optedIn: true,
      consentClass: "research",
      recordedAt: "2026-07-16T18:00:00.000Z",
    },
    stages: overrides.stages ?? [
      { stage: "act", opCode: "tool.write", status: "ok" },
    ],
    policyCheckpointHash:
      overrides.policyCheckpointHash ?? "ckpt:sha256:batchpolicy0001",
  };
}

/**
 * CI micro-prove: above-threshold collect → ready; below-threshold → skip;
 * opt-out filtered; accelerator defer.
 */
export function proveBatchCollectorMicroRun(opts: {
  exportRoot: string;
  queueRootDir: string;
  writeExports: (dir: string) => void;
  configOverrides?: Partial<OfflineBatchConfig>;
  onTelemetry?: (e: OfflineBatchTelemetryEvent) => void;
}): {
  ok: true;
  ready: CollectConsentedBatchResult;
  skip: CollectConsentedBatchResult;
  defer: CollectConsentedBatchResult;
} {
  opts.writeExports(opts.exportRoot);

  const baseConfig = parseOfflineBatchConfig({
    schemaVersion: OFFLINE_BATCH_CONFIG_SCHEMA_VERSION,
    b9ExportPath: opts.exportRoot,
    allowedConsentClasses: ["research", "product-improve"],
    minTrajectoryCount: 3,
    maxScanFiles: 100,
    wallClockMs: 60_000,
    queueMaxDepth: 64,
    locality: "on-device",
    ...opts.configOverrides,
  });

  const ready = collectConsentedTrajectories({
    config: { ...baseConfig, minTrajectoryCount: 2 },
    exportRoot: opts.exportRoot,
    queueRootDir: opts.queueRootDir,
    queueKeyMaterial: "prove-batch-collector",
    deviceId: "ci.batch",
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (ready.verdict !== "ready" || ready.enqueued < 2) {
    throw new OfflineBatchContractError(
      `expected ready verdict with ≥2 enqueues, got ${ready.verdict}/${ready.enqueued}`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.fleet",
        deviceId: "ci.batch",
        diff: JSON.stringify(ready),
      },
    );
  }

  const skip = collectConsentedTrajectories({
    config: { ...baseConfig, minTrajectoryCount: 10_000 },
    exportRoot: opts.exportRoot,
    queueRootDir: path.join(opts.queueRootDir, "skip"),
    queueKeyMaterial: "prove-batch-collector-skip",
    deviceId: "ci.batch",
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (skip.verdict !== "skip" || skip.skipReason !== "below_threshold") {
    throw new OfflineBatchContractError(
      `expected skip/below_threshold, got ${skip.verdict}/${skip.skipReason}`,
      {
        obligation: "batch.below_threshold",
        subjectId: "batch.fleet",
        deviceId: "ci.batch",
        diff: JSON.stringify(skip),
      },
    );
  }

  const defer = collectConsentedTrajectories({
    config: baseConfig,
    exportRoot: opts.exportRoot,
    queueRootDir: path.join(opts.queueRootDir, "defer"),
    acceleratorAvailable: false,
    deviceId: "ci.batch",
    ...(opts.onTelemetry !== undefined
      ? { onTelemetry: opts.onTelemetry }
      : {}),
  });
  if (
    defer.verdict !== "defer" ||
    defer.skipReason !== "accelerator_unavailable"
  ) {
    throw new OfflineBatchContractError(
      `expected defer/accelerator_unavailable, got ${defer.verdict}/${defer.skipReason}`,
      {
        obligation: "batch.accelerator_unavailable",
        subjectId: "batch.fleet",
        deviceId: "ci.batch",
        diff: JSON.stringify(defer),
      },
    );
  }

  return { ok: true, ready, skip, defer };
}

export { draftTrajectory as draftBatchTrajectoryForTests };
