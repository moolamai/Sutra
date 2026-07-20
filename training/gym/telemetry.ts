/**
 * Episode telemetry — map fleet episode results to C0 TurnTrajectoryRecord.
 * Metadata + structured stages only; never raw keystrokes or frame deltas.
 */

import {
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_STAGE_LIMIT,
  assertTrajectoryExportConsent,
  enqueueTrajectoryWrite,
  parseTurnTrajectoryRecord,
  toCanonicalTrajectoryJson,
  type ParseTurnTrajectoryResult,
  type PrecisionFormat,
  type TrajectoryConsent,
  type TrajectoryExecutionState,
  type TrajectoryLocality,
  type TrajectoryStageRecord,
  type TurnTrajectoryRecord,
} from "@moolam/learning";
import {
  runLocalProcessPoolMicroRun,
  type FleetLineage,
  type FleetTelemetry,
} from "./fleet.ts";
import type { FleetEpisodeResult, FleetJob } from "./pool/run_episode.ts";
import { proveGymRolloutStoreIsolation } from "./snapshot_store.ts";

/** Soft caps (NFR — bounded idempotency cache). */
export const GYM_TELEMETRY_IDEMPOTENCY_LIMIT = 256;

export type GymTelemetryFailureClass =
  | "missing_subject"
  | "cross_subject"
  | "invalid_episode"
  | "schema_violation"
  | "consent_denied"
  | "idempotent_replay";

export type GymTelemetryEvent = {
  event: "training.gym.telemetry";
  op: "map" | "export" | "write" | "queue" | "batch";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId?: string;
  jobId?: string;
  episodeId?: string;
  batchSize?: number;
  pending?: number;
  exported?: number;
  failureClass?: GymTelemetryFailureClass | "queue_full" | "write_failed";
  detail?: string;
};

export type MapFleetEpisodeInput = {
  episode: FleetEpisodeResult;
  /** Production harness frames for the episode (metadata extraction only). */
  frames: readonly unknown[];
  consent: TrajectoryConsent;
  locality: TrajectoryLocality;
  capturedAt?: string;
  sessionId?: string;
  turnId?: string;
  precisionFormat?: PrecisionFormat;
  /** Duplicate map returns cached validated record without re-derive. */
  idempotencyKey?: string;
  onTelemetry?: (e: GymTelemetryEvent) => void;
};

export type MapFleetEpisodeAccepted = {
  ok: true;
  record: TurnTrajectoryRecord;
  subjectId: string;
  deviceId?: string;
  idempotentReplay: boolean;
};

export type MapFleetEpisodeRejected = {
  ok: false;
  failureClass: GymTelemetryFailureClass;
  subjectId: string | null;
  deviceId?: string;
  detail: string;
};

export type MapFleetEpisodeResult =
  | MapFleetEpisodeAccepted
  | MapFleetEpisodeRejected;

const idempotencyCache = new Map<string, TurnTrajectoryRecord>();

function emitTel(
  onTelemetry: ((e: GymTelemetryEvent) => void) | undefined,
  partial: Omit<GymTelemetryEvent, "event">,
): void {
  onTelemetry?.({ event: "training.gym.telemetry", ...partial });
}

function fail(
  onTelemetry: ((e: GymTelemetryEvent) => void) | undefined,
  failureClass: GymTelemetryFailureClass,
  detail: string,
  subjectId: string | null,
  deviceId?: string,
  extra: Partial<GymTelemetryEvent> = {},
): MapFleetEpisodeRejected {
  emitTel(onTelemetry, {
    op: "map",
    outcome: "error",
    subjectId: subjectId ?? "",
    ...(deviceId !== undefined ? { deviceId } : {}),
    failureClass,
    detail,
    ...extra,
  });
  return {
    ok: false,
    failureClass,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    detail,
  };
}

/**
 * Extract opaque tool call ids from harness frames — never argument bodies.
 */
export function extractToolCallIdsFromFrames(
  frames: readonly unknown[],
): string[] {
  const ids: string[] = [];
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const typed = frame as { type?: string; toolCallId?: unknown };
    if (typed.type !== "TOOL_STATUS") continue;
    if (typeof typed.toolCallId !== "string") continue;
    const id = typed.toolCallId.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= TRAJECTORY_STAGE_LIMIT) break;
  }
  return ids;
}

/**
 * Derive structured stage records from harness frame types (no raw deltas).
 */
export function stagesFromHarnessFrames(
  frames: readonly unknown[],
  episode: FleetEpisodeResult,
): TrajectoryStageRecord[] {
  const stages: TrajectoryStageRecord[] = [];

  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const type = (frame as { type?: string }).type;
    if (type === "SESSION_START") {
      stages.push({ stage: "session", opCode: "harness.start", status: "ok" });
      continue;
    }
    if (type === "TOOL_STATUS") {
      const status = (frame as { status?: string }).status;
      stages.push({
        stage: "act",
        opCode: "tool.invoke",
        status:
          status === "error"
            ? "error"
            : status === "running"
              ? "skipped"
              : "ok",
      });
      continue;
    }
    if (type === "THOUGHT_DELTA" || type === "ANSWER_DELTA") {
      stages.push({
        stage: "generate",
        opCode: type === "THOUGHT_DELTA" ? "model.thought" : "model.answer",
        status: "ok",
      });
      continue;
    }
    if (type === "TURN_COMPLETE") {
      stages.push({
        stage: "complete",
        opCode: "turn.complete",
        status: "ok",
      });
      continue;
    }
    if (type === "HARNESS_ERROR") {
      stages.push({
        stage: "complete",
        opCode: "harness.error",
        status: "error",
      });
    }
  }

  if (stages.length < 1) {
    stages.push({
      stage: "rollout",
      opCode: episode.ok ? "episode.complete" : "episode.failed",
      status: episode.ok ? "ok" : "error",
    });
  }

  return stages.slice(0, TRAJECTORY_STAGE_LIMIT);
}

function executionStateFromEpisode(
  episode: FleetEpisodeResult,
): TrajectoryExecutionState | undefined {
  if (episode.executionState) {
    return episode.executionState;
  }
  if (episode.sandboxDeadlineExceeded) {
    return {
      commandExecuted: "sandbox.invoke",
      statusCode: "deadline_exceeded",
    };
  }
  if (episode.terminalFrameType === "TURN_COMPLETE") {
    return { commandExecuted: "harness.turn", statusCode: 200 };
  }
  if (episode.terminalFrameType === "HARNESS_ERROR") {
    return { commandExecuted: "harness.turn", statusCode: "error" };
  }
  if (!episode.ok) {
    return { commandExecuted: "rollout.episode", statusCode: "error" };
  }
  return undefined;
}

function assertFramesSubjectScoped(
  frames: readonly unknown[],
  subjectId: string,
): { ok: true } | { ok: false; detail: string } {
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (!frame || typeof frame !== "object") continue;
    const sid = (frame as { subjectId?: unknown }).subjectId;
    if (typeof sid === "string" && sid.trim() && sid !== subjectId) {
      return {
        ok: false,
        detail: `frame[${i}] subjectId diverged from episode bind`,
      };
    }
  }
  return { ok: true };
}

/**
 * Map a fleet episode result + harness frames to a C0 TurnTrajectoryRecord.
 */
export function mapFleetEpisodeToTurnTrajectoryRecord(
  input: MapFleetEpisodeInput,
): MapFleetEpisodeResult {
  const episode = input.episode;
  const subjectId = episode.subjectId?.trim() ?? "";
  const deviceId = episode.deviceId?.trim() || undefined;

  if (!subjectId) {
    return fail(
      input.onTelemetry,
      "missing_subject",
      "episode.subjectId required",
      null,
      deviceId,
      { jobId: episode.jobId },
    );
  }

  const idemKey = input.idempotencyKey?.trim();
  if (idemKey) {
    const cacheKey = `${subjectId}\n${idemKey}`;
    const cached = idempotencyCache.get(cacheKey);
    if (cached) {
      emitTel(input.onTelemetry, {
        op: "map",
        outcome: "ok",
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
        jobId: episode.jobId,
        episodeId: episode.episodeId,
        detail: "idempotent replay of mapped trajectory",
      });
      return {
        ok: true,
        record: cached,
        subjectId,
        ...(deviceId !== undefined ? { deviceId } : {}),
        idempotentReplay: true,
      };
    }
  }

  const scoped = assertFramesSubjectScoped(input.frames, subjectId);
  if (!scoped.ok) {
    return fail(
      input.onTelemetry,
      "cross_subject",
      scoped.detail,
      subjectId,
      deviceId,
      { jobId: episode.jobId, episodeId: episode.episodeId },
    );
  }

  if (
    typeof episode.seed !== "number" ||
    !Number.isInteger(episode.seed) ||
    episode.seed < 0 ||
    episode.seed > 0xffff_ffff
  ) {
    return fail(
      input.onTelemetry,
      "invalid_episode",
      "episode.seed must be a uint32 rollout seed",
      subjectId,
      deviceId,
      { jobId: episode.jobId },
    );
  }

  const stages = stagesFromHarnessFrames(input.frames, episode);
  const toolCallIds = extractToolCallIdsFromFrames(input.frames);
  const executionState = executionStateFromEpisode(episode);

  const draft: TurnTrajectoryRecord = {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    subjectId,
    sessionId:
      input.sessionId?.trim() ||
      (episode.episodeId
        ? `sess.${episode.episodeId}`
        : `sess.${episode.jobId}`),
    turnId: input.turnId?.trim() || `turn.${episode.jobId}`,
    ...(deviceId !== undefined ? { deviceId } : {}),
    capturedAt: input.capturedAt?.trim() || new Date(0).toISOString(),
    locality: input.locality,
    consent: input.consent,
    stages,
    ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
    policyCheckpointHash: episode.policyCheckpointHash,
    rolloutSeed: episode.seed,
    ...(input.precisionFormat !== undefined
      ? { precisionFormat: input.precisionFormat }
      : {}),
    ...(executionState !== undefined ? { executionState } : {}),
  };

  const parsed: ParseTurnTrajectoryResult = parseTurnTrajectoryRecord(draft);
  if (!parsed.ok) {
    return fail(
      input.onTelemetry,
      "schema_violation",
      parsed.detail,
      parsed.subjectId,
      parsed.deviceId,
      { jobId: episode.jobId, episodeId: episode.episodeId },
    );
  }

  if (idemKey) {
    if (idempotencyCache.size >= GYM_TELEMETRY_IDEMPOTENCY_LIMIT) {
      const first = idempotencyCache.keys().next().value;
      if (typeof first === "string") {
        idempotencyCache.delete(first);
      }
    }
    idempotencyCache.set(`${subjectId}\n${idemKey}`, parsed.record);
  }

  emitTel(input.onTelemetry, {
    op: "map",
    outcome: "ok",
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    jobId: episode.jobId,
    episodeId: episode.episodeId,
    detail: "mapped fleet episode to TurnTrajectoryRecord",
  });

  return {
    ok: true,
    record: parsed.record,
    subjectId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    idempotentReplay: false,
  };
}

/**
 * Map + consent gate for sovereign export.
 */
export function mapFleetEpisodeForExport(
  input: MapFleetEpisodeInput,
):
  | { ok: true; record: TurnTrajectoryRecord; subjectId: string }
  | MapFleetEpisodeRejected {
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord(input);
  if (!mapped.ok) {
    return mapped;
  }

  const gate = assertTrajectoryExportConsent(mapped.record);
  if (!gate.ok) {
    return fail(
      input.onTelemetry,
      gate.failureClass === "consent_denied"
        ? "consent_denied"
        : "missing_subject",
      gate.detail,
      gate.subjectId,
      mapped.deviceId,
      { jobId: input.episode.jobId, episodeId: input.episode.episodeId },
    );
  }

  emitTel(input.onTelemetry, {
    op: "export",
    outcome: "ok",
    subjectId: mapped.subjectId,
    ...(mapped.deviceId !== undefined ? { deviceId: mapped.deviceId } : {}),
    jobId: input.episode.jobId,
    episodeId: input.episode.episodeId,
    detail: "export consent passed",
  });

  return { ok: true, record: mapped.record, subjectId: mapped.subjectId };
}

/**
 * Schedule async trajectory persist — returns immediately (never blocks turn).
 */
export function scheduleFleetEpisodeTrajectoryWrite(input: {
  record: TurnTrajectoryRecord;
  writer: (record: TurnTrajectoryRecord) => void | Promise<void>;
  onTelemetry?: (e: GymTelemetryEvent) => void;
}): { queued: true; subjectId: string } {
  const subjectId = input.record.subjectId;
  enqueueTrajectoryWrite(input.record, input.writer, {
    onTelemetry: (e) => {
      emitTel(input.onTelemetry, {
        op: "write",
        outcome:
          e.outcome === "queued"
            ? "ok"
            : e.outcome === "ok"
              ? "ok"
              : "error",
        subjectId: e.subjectId,
        ...(e.deviceId !== undefined ? { deviceId: e.deviceId } : {}),
        ...(e.failureClass !== undefined
          ? { failureClass: "schema_violation", detail: e.failureClass }
          : {}),
        detail:
          e.outcome === "queued"
            ? "trajectory write queued"
            : e.outcome === "ok"
              ? "trajectory write ok"
              : "trajectory write rejected",
      });
    },
  });
  return { queued: true, subjectId };
}

/** Test-only: clear idempotency cache. */
export function clearGymTelemetryIdempotencyCacheForTests(): void {
  idempotencyCache.clear();
}

/** Soft caps (NFR — bounded export queue + trainer batches). */
export const GYM_TRAJECTORY_EXPORT_QUEUE_LIMIT = 1_024;
export const GYM_TRAJECTORY_EXPORT_BATCH_DEFAULT = 32;

type PendingTrajectoryExport = {
  jobId: string;
  subjectId: string;
  deviceId?: string;
  record: TurnTrajectoryRecord;
};

export type FleetTrajectoryExportQueueOptions = {
  queueLimit?: number;
  batchSize?: number;
  /** Optional async durable batch sink. */
  writer?: (batch: readonly TurnTrajectoryRecord[]) => void | Promise<void>;
  /** Optional per-record async persist via C0 enqueue path (non-blocking). */
  recordWriter?: (record: TurnTrajectoryRecord) => void | Promise<void>;
  onTelemetry?: (e: GymTelemetryEvent) => void;
};

export type FleetTrajectoryExportEnqueueResult =
  | { ok: true; queued: true; jobId: string; subjectId: string }
  | { ok: true; queued: false; jobId: string; subjectId: string; duplicate: true }
  | MapFleetEpisodeRejected
  | {
      ok: false;
      failureClass: "queue_full";
      detail: string;
      subjectId: string;
      deviceId?: string;
      jobId: string;
    };

/**
 * Non-blocking trajectory export queue for fleet rollout completion.
 * Consent gate runs at enqueue; durable writes flush asynchronously in batches.
 */
export class FleetTrajectoryExportQueue {
  private readonly queueLimit: number;
  private readonly batchSize: number;
  private readonly writer:
    | ((batch: readonly TurnTrajectoryRecord[]) => void | Promise<void>)
    | undefined;
  private readonly recordWriter:
    | ((record: TurnTrajectoryRecord) => void | Promise<void>)
    | undefined;
  private readonly onTelemetry:
    | ((e: GymTelemetryEvent) => void)
    | undefined;

  private readonly pending: PendingTrajectoryExport[] = [];
  private readonly trainerBuffer: TurnTrajectoryRecord[] = [];
  private readonly processedJobIds = new Set<string>();
  private flushScheduled = false;
  private flushing = false;

  constructor(options: FleetTrajectoryExportQueueOptions = {}) {
    this.queueLimit = options.queueLimit ?? GYM_TRAJECTORY_EXPORT_QUEUE_LIMIT;
    this.batchSize =
      options.batchSize ?? GYM_TRAJECTORY_EXPORT_BATCH_DEFAULT;
    this.writer = options.writer;
    this.recordWriter = options.recordWriter;
    this.onTelemetry = options.onTelemetry;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getTrainerBufferCount(): number {
    return this.trainerBuffer.length;
  }

  /**
   * Enqueue one fleet episode for export. Returns immediately after consent gate.
   */
  enqueueEpisode(
    input: MapFleetEpisodeInput,
  ): FleetTrajectoryExportEnqueueResult {
    const jobId = input.episode.jobId?.trim() ?? "";
    const subjectId = input.episode.subjectId?.trim() ?? "";
    const deviceId = input.episode.deviceId?.trim() || undefined;

    if (!jobId) {
      return fail(
        input.onTelemetry ?? this.onTelemetry,
        "invalid_episode",
        "episode.jobId required for export queue",
        subjectId || null,
        deviceId,
        { jobId: "invalid" },
      );
    }

    if (this.processedJobIds.has(jobId)) {
      emitTel(this.onTelemetry, {
        op: "queue",
        outcome: "ok",
        subjectId: subjectId || "fleet",
        ...(deviceId !== undefined ? { deviceId } : {}),
        jobId,
        detail: "duplicate jobId — idempotent no-op",
      });
      return {
        ok: true,
        queued: false,
        jobId,
        subjectId: subjectId || "fleet",
        duplicate: true,
      };
    }

    if (this.pending.length >= this.queueLimit) {
      emitTel(this.onTelemetry, {
        op: "queue",
        outcome: "error",
        subjectId: subjectId || "fleet",
        ...(deviceId !== undefined ? { deviceId } : {}),
        jobId,
        failureClass: "queue_full",
        pending: this.pending.length,
        detail: `export queue exceeds ${this.queueLimit}`,
      });
      return {
        ok: false,
        failureClass: "queue_full",
        detail: `export queue exceeds ${this.queueLimit}`,
        subjectId: subjectId || "fleet",
        ...(deviceId !== undefined ? { deviceId } : {}),
        jobId,
      };
    }

    const mapped = mapFleetEpisodeForExport({
      ...input,
      onTelemetry: (e) => {
        input.onTelemetry?.(e);
        this.onTelemetry?.(e);
      },
    });
    if (!mapped.ok) {
      emitTel(this.onTelemetry, {
        op: "queue",
        outcome: "error",
        subjectId: mapped.subjectId ?? subjectId ?? "fleet",
        ...(mapped.deviceId !== undefined ? { deviceId: mapped.deviceId } : {}),
        jobId,
        failureClass: mapped.failureClass,
        detail: mapped.detail,
      });
      return mapped;
    }

    this.processedJobIds.add(jobId);
    this.pending.push({
      jobId,
      subjectId: mapped.subjectId,
      ...(mapped.record.deviceId !== undefined
        ? { deviceId: mapped.record.deviceId }
        : {}),
      record: mapped.record,
    });

    emitTel(this.onTelemetry, {
      op: "queue",
      outcome: "ok",
      subjectId: mapped.subjectId,
      ...(mapped.record.deviceId !== undefined
        ? { deviceId: mapped.record.deviceId }
        : {}),
      jobId,
      episodeId: input.episode.episodeId,
      pending: this.pending.length,
      detail: "episode queued for async export",
    });

    this.scheduleFlush();
    return {
      ok: true,
      queued: true,
      jobId,
      subjectId: mapped.subjectId,
    };
  }

  /** Schedule async flush — never blocks the caller. */
  scheduleFlush(): { scheduled: true } {
    if (this.flushScheduled) {
      return { scheduled: true };
    }
    this.flushScheduled = true;
    void Promise.resolve()
      .then(() => this.flush())
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : "flush failed";
        emitTel(this.onTelemetry, {
          op: "batch",
          outcome: "error",
          subjectId: "fleet",
          failureClass: "write_failed",
          detail,
        });
      })
      .finally(() => {
        this.flushScheduled = false;
      });
    return { scheduled: true };
  }

  /**
   * Drain pending exports into the trainer buffer and invoke the async writer.
   */
  async flush(): Promise<{
    ok: boolean;
    exported: number;
    batches: number;
    detail?: string;
  }> {
    if (this.flushing) {
      return { ok: true, exported: 0, batches: 0, detail: "flush already active" };
    }
    this.flushing = true;
    let exported = 0;
    let batches = 0;

    try {
      while (this.pending.length > 0) {
        const slice = this.pending.splice(0, this.batchSize);
        const records = slice.map((item) => item.record);
        this.trainerBuffer.push(...records);
        exported += records.length;
        batches += 1;

        emitTel(this.onTelemetry, {
          op: "batch",
          outcome: "ok",
          subjectId: "fleet",
          batchSize: records.length,
          exported: this.trainerBuffer.length,
          pending: this.pending.length,
          detail: "trainer batch ready",
        });

        if (this.recordWriter) {
          for (const record of records) {
            scheduleFleetEpisodeTrajectoryWrite({
              record,
              writer: this.recordWriter,
              onTelemetry: this.onTelemetry,
            });
          }
        }

        if (this.writer) {
          try {
            await this.writer(records);
          } catch (err: unknown) {
            const detail =
              err instanceof Error ? err.message : "batch writer failed";
            emitTel(this.onTelemetry, {
              op: "batch",
              outcome: "error",
              subjectId: "fleet",
              failureClass: "write_failed",
              batchSize: records.length,
              detail,
            });
            return { ok: false, exported, batches, detail };
          }
        }
      }

      return { ok: true, exported, batches };
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Trainer consumption — take up to `limit` exported trajectory records.
   */
  takeTrainerBatch(limit = this.batchSize): TurnTrajectoryRecord[] {
    const capped = Math.max(1, limit);
    return this.trainerBuffer.splice(0, capped);
  }

  /** Test-only: reset queue state. */
  clearForTests(): void {
    this.pending.length = 0;
    this.trainerBuffer.length = 0;
    this.processedJobIds.clear();
    this.flushScheduled = false;
    this.flushing = false;
  }
}

export function createFleetTrajectoryExportQueue(
  options: FleetTrajectoryExportQueueOptions = {},
): FleetTrajectoryExportQueue {
  return new FleetTrajectoryExportQueue(options);
}

/** G=4 parallel group size for fleet telemetry CI micro-run. */
export const FLEET_TELEMETRY_MICRO_GROUP_SIZE = 4;

/** Tiny golden scenario set for fleet telemetry E2E. */
export const FLEET_TELEMETRY_MICRO_SCENARIOS = [
  "thought-answer-basic",
  "tool-call-fence",
  "meter-tick",
  "correction-loop",
] as const;

export type FleetTelemetryMicroRunInput = {
  policyCheckpointHash: string;
  corpusManifestId?: string;
  hyperparametersId?: string;
  criticVersionId?: string;
  subjectId?: string;
  deviceId?: string;
  consent: TrajectoryConsent;
  locality: TrajectoryLocality;
  concurrencyCap?: number;
  capturedAt?: string;
  onTelemetry?: (e: GymTelemetryEvent) => void;
  onFleetTelemetry?: (e: FleetTelemetry) => void;
};

export type FleetTelemetryMicroRunResult = {
  ok: boolean;
  trajectories: TurnTrajectoryRecord[];
  rolloutIds: string[];
  seeds: number[];
  lineage: FleetLineage;
  fleetOk: boolean;
  exportOk: boolean;
  detail?: string;
};

/**
 * Fleet E2E micro-run: G=4 parallel golden episodes → export queue → trainer batch.
 * Verifies lineage hashes, schema parse, and per-rollout snapshot isolation.
 */
export async function runFleetTelemetryMicroRun(
  input: FleetTelemetryMicroRunInput,
): Promise<FleetTelemetryMicroRunResult> {
  const subjectId = input.subjectId?.trim() || "anika-k";
  const deviceId = input.deviceId?.trim() || "edge-aaaa";
  const ckpt = input.policyCheckpointHash.trim();
  const corpusManifestId =
    input.corpusManifestId?.trim() || "corpus.gym.telemetry.micro.v1";
  const lineage: FleetLineage = {
    corpusManifestId,
    baseCheckpointHash: ckpt,
    ...(input.hyperparametersId !== undefined
      ? { hyperparametersId: input.hyperparametersId }
      : {}),
    ...(input.criticVersionId !== undefined
      ? { criticVersionId: input.criticVersionId }
      : {}),
  };

  const empty = {
    trajectories: [] as TurnTrajectoryRecord[],
    rolloutIds: [] as string[],
    seeds: [] as number[],
    lineage,
    fleetOk: false,
    exportOk: false,
  };

  const isolation = proveGymRolloutStoreIsolation({ subjectId, deviceId });
  if (!isolation.ok) {
    return {
      ok: false,
      ...empty,
      detail: `snapshot isolation prove failed: ${isolation.detail}`,
    };
  }

  const jobs: FleetJob[] = FLEET_TELEMETRY_MICRO_SCENARIOS.map(
    (scenarioId, index) => ({
      jobId: `micro.tele.${index + 1}`,
      scenarioId,
      seed: 40 + index,
      subjectId,
      deviceId,
      policyCheckpointHash: ckpt,
      path: "golden_replay" as const,
    }),
  );

  const fleetRun = await runLocalProcessPoolMicroRun({
    jobs,
    concurrencyCap:
      input.concurrencyCap ?? FLEET_TELEMETRY_MICRO_GROUP_SIZE,
    lineage,
    ...(input.onFleetTelemetry !== undefined
      ? { onFleetTelemetry: input.onFleetTelemetry }
      : {}),
  });

  if (!fleetRun.ok) {
    return {
      ok: false,
      ...empty,
      fleetOk: false,
      detail: fleetRun.detail ?? "fleet micro-run failed",
    };
  }

  const rolloutIds = fleetRun.results
    .map((r) => r.rolloutId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (rolloutIds.length !== FLEET_TELEMETRY_MICRO_GROUP_SIZE) {
    return {
      ok: false,
      ...empty,
      fleetOk: true,
      detail: `expected ${FLEET_TELEMETRY_MICRO_GROUP_SIZE} rollout results`,
    };
  }
  if (new Set(rolloutIds).size !== FLEET_TELEMETRY_MICRO_GROUP_SIZE) {
    return {
      ok: false,
      ...empty,
      rolloutIds,
      seeds: jobs.map((j) => j.seed),
      fleetOk: true,
      detail: "snapshot isolation: rolloutId must be unique per episode",
    };
  }

  const queue = createFleetTrajectoryExportQueue({
    ...(input.onTelemetry !== undefined ? { onTelemetry: input.onTelemetry } : {}),
  });
  const capturedAt = input.capturedAt ?? new Date().toISOString();

  for (const episode of fleetRun.results) {
    if (!episode.ok) {
      return {
        ok: false,
        ...empty,
        rolloutIds,
        seeds: jobs.map((j) => j.seed),
        fleetOk: true,
        detail: `episode ${episode.jobId} failed: ${episode.detail ?? "unknown"}`,
      };
    }
    if (!episode.harnessFrames || episode.harnessFrames.length < 1) {
      return {
        ok: false,
        ...empty,
        rolloutIds,
        seeds: jobs.map((j) => j.seed),
        fleetOk: true,
        detail: `episode ${episode.jobId} missing harnessFrames for telemetry`,
      };
    }

    const enq = queue.enqueueEpisode({
      episode,
      frames: episode.harnessFrames,
      consent: input.consent,
      locality: input.locality,
      capturedAt,
      onTelemetry: input.onTelemetry,
    });
    if (!enq.ok) {
      const detail =
        "failureClass" in enq
          ? `${enq.failureClass}: ${enq.detail}`
          : "export enqueue rejected";
      return {
        ok: false,
        ...empty,
        rolloutIds,
        seeds: jobs.map((j) => j.seed),
        fleetOk: true,
        exportOk: false,
        detail,
      };
    }
  }

  const flushed = await queue.flush();
  const trajectories = queue.takeTrainerBatch(FLEET_TELEMETRY_MICRO_GROUP_SIZE);

  for (const record of trajectories) {
    const canonical = toCanonicalTrajectoryJson(record);
    const parsed: ParseTurnTrajectoryResult = parseTurnTrajectoryRecord(
      JSON.parse(canonical),
    );
    if (!parsed.ok) {
      return {
        ok: false,
        trajectories,
        rolloutIds,
        seeds: jobs.map((j) => j.seed),
        lineage,
        fleetOk: true,
        exportOk: flushed.ok,
        detail: `schema parse failed: ${parsed.failureClass}`,
      };
    }
    if (parsed.record.policyCheckpointHash !== ckpt) {
      return {
        ok: false,
        trajectories,
        rolloutIds,
        seeds: jobs.map((j) => j.seed),
        lineage,
        fleetOk: true,
        exportOk: flushed.ok,
        detail: "lineage drift: policyCheckpointHash mismatch after parse",
      };
    }
  }

  const exportOk =
    flushed.ok && trajectories.length === FLEET_TELEMETRY_MICRO_GROUP_SIZE;
  return {
    ok: fleetRun.ok && exportOk,
    trajectories,
    rolloutIds,
    seeds: jobs.map((j) => j.seed),
    lineage,
    fleetOk: fleetRun.ok,
    exportOk,
    ...(exportOk ? {} : { detail: flushed.detail ?? "export incomplete" }),
  };
}
