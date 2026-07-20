/**
 * Isolated fleet episode runner — one GymEnv + unique snapshot store per job.
 * Per-tool deadline inherits B4 sandbox default; never extended past that.
 */

import { SANDBOX_DEFAULT_DEADLINE_MS } from "@moolam/runtime-harness";
import { GymEnv } from "../env.ts";
import { allocateGymRolloutSnapshotStore } from "../snapshot_store.ts";

/** Soft caps (NFR — bounded ids / hashes). */
export const FLEET_JOB_ID_LIMIT = 128;
export const FLEET_HASH_LIMIT = 128;
export const FLEET_SCENARIO_ID_LIMIT = 128;

/** Fleet workers must not exceed B4 sandbox deadline. */
export const FLEET_TOOL_DEADLINE_MS = SANDBOX_DEFAULT_DEADLINE_MS;

export type FleetEpisodePath = "golden_replay" | "turn_loop";

export type FleetJob = {
  /** Opaque job key — duplicate enqueue is idempotent. */
  jobId: string;
  scenarioId: string;
  seed: number;
  subjectId: string;
  deviceId: string;
  /**
   * Exact policy checkpoint for lineage — never the floating token `latest`.
   * Stale-policy rollouts still tag the hash they actually ran.
   */
  policyCheckpointHash: string;
  path?: FleetEpisodePath;
  /**
   * Optional stricter deadline (ms). Must be ≤ {@link FLEET_TOOL_DEADLINE_MS}.
   * Omitted → B4 sandbox default.
   */
  toolDeadlineMs?: number;
};

export type FleetEpisodeFailureClass =
  | "invalid_job"
  | "floating_checkpoint"
  | "deadline_extended"
  | "cross_subject"
  | "missing_subject"
  | "episode_failed"
  | "concurrent_subject"
  | "queue_full"
  | "config";

export type FleetEpisodeResult = {
  ok: boolean;
  jobId: string;
  scenarioId: string;
  seed: number;
  subjectId: string;
  deviceId: string;
  /** Exact checkpoint hash from the job — never rewritten to `latest`. */
  policyCheckpointHash: string;
  toolDeadlineMs: number;
  episodeId?: string;
  rolloutId?: string;
  terminal?: boolean;
  terminalFrameType?: string | null;
  path?: FleetEpisodePath;
  frameCount?: number;
  failureClass?: FleetEpisodeFailureClass;
  detail?: string;
  /** True when production TOOL_STATUS reports sandbox deadline_exceeded. */
  sandboxDeadlineExceeded?: boolean;
  sandboxFailureClass?: "deadline_exceeded";
  /** C0-aligned handoff for episode telemetry (metadata only). */
  executionState?: {
    commandExecuted: string;
    statusCode: number | string;
  };
  /** Metadata-only harness frames for C0 telemetry (no deltas or arguments). */
  harnessFrames?: readonly unknown[];
};

function isFloatingCheckpoint(hash: string): boolean {
  return hash.trim().toLowerCase() === "latest";
}

/** Strip harness frames to metadata safe for trajectory export (no raw content). */
export function harnessFramesForTelemetry(
  frames: readonly unknown[],
  subjectId: string,
): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (!frame || typeof frame !== "object") continue;
    const f = frame as Record<string, unknown>;
    const type = typeof f.type === "string" ? f.type : "UNKNOWN";
    const meta: Record<string, unknown> = {
      type,
      subjectId,
      sequenceIndex: i,
    };
    if (type === "TOOL_STATUS") {
      if (typeof f.toolCallId === "string") meta.toolCallId = f.toolCallId;
      if (typeof f.status === "string") meta.status = f.status;
    }
    if (type === "TURN_COMPLETE" && typeof f.turnId === "string") {
      meta.turnId = f.turnId;
    }
    if (type === "HARNESS_ERROR" && typeof f.code === "string") {
      meta.code = f.code;
    }
    out.push(meta);
  }
  return out;
}

function validateCheckpointHash(
  hash: string,
): { ok: true; hash: string } | { ok: false; detail: string } {
  const trimmed = hash.trim();
  if (trimmed.length < 8 || trimmed.length > FLEET_HASH_LIMIT) {
    return {
      ok: false,
      detail: `policyCheckpointHash length must be 8..${FLEET_HASH_LIMIT}`,
    };
  }
  if (!/^[A-Za-z0-9:_+-]+$/.test(trimmed)) {
    return {
      ok: false,
      detail: "policyCheckpointHash must be an opaque hash id",
    };
  }
  if (isFloatingCheckpoint(trimmed)) {
    return {
      ok: false,
      detail: "policyCheckpointHash must bind an exact checkpoint — not floating 'latest'",
    };
  }
  return { ok: true, hash: trimmed };
}

/**
 * Validate job boundary fields before any gym side effect.
 */
export function validateFleetJob(
  job: FleetJob,
):
  | { ok: true; job: FleetJob; toolDeadlineMs: number }
  | {
      ok: false;
      failureClass: FleetEpisodeFailureClass;
      detail: string;
      subjectId: string;
      deviceId: string;
    } {
  const subjectId = typeof job.subjectId === "string" ? job.subjectId.trim() : "";
  const deviceId = typeof job.deviceId === "string" ? job.deviceId.trim() : "";
  const jobId = typeof job.jobId === "string" ? job.jobId.trim() : "";
  const scenarioId =
    typeof job.scenarioId === "string" ? job.scenarioId.trim() : "";

  if (!subjectId) {
    return {
      ok: false,
      failureClass: "missing_subject",
      detail: "subjectId required for fleet episode",
      subjectId: "",
      deviceId: deviceId || "dev-fleet",
    };
  }
  if (!deviceId) {
    return {
      ok: false,
      failureClass: "invalid_job",
      detail: "deviceId required for fleet episode",
      subjectId,
      deviceId: "",
    };
  }
  if (!jobId || jobId.length > FLEET_JOB_ID_LIMIT) {
    return {
      ok: false,
      failureClass: "invalid_job",
      detail: `jobId required (max ${FLEET_JOB_ID_LIMIT})`,
      subjectId,
      deviceId,
    };
  }
  if (!scenarioId || scenarioId.length > FLEET_SCENARIO_ID_LIMIT) {
    return {
      ok: false,
      failureClass: "invalid_job",
      detail: `scenarioId required (max ${FLEET_SCENARIO_ID_LIMIT})`,
      subjectId,
      deviceId,
    };
  }
  if (
    typeof job.seed !== "number" ||
    !Number.isInteger(job.seed) ||
    job.seed < 0 ||
    job.seed > 0xffff_ffff
  ) {
    return {
      ok: false,
      failureClass: "invalid_job",
      detail: "seed must be an integer in 0..0xffffffff",
      subjectId,
      deviceId,
    };
  }

  const ckpt = validateCheckpointHash(
    typeof job.policyCheckpointHash === "string"
      ? job.policyCheckpointHash
      : "",
  );
  if (!ckpt.ok) {
    return {
      ok: false,
      failureClass: isFloatingCheckpoint(
        typeof job.policyCheckpointHash === "string"
          ? job.policyCheckpointHash
          : "",
      )
        ? "floating_checkpoint"
        : "invalid_job",
      detail: ckpt.detail,
      subjectId,
      deviceId,
    };
  }

  let toolDeadlineMs = FLEET_TOOL_DEADLINE_MS;
  if (job.toolDeadlineMs !== undefined) {
    if (
      !Number.isFinite(job.toolDeadlineMs) ||
      job.toolDeadlineMs <= 0
    ) {
      return {
        ok: false,
        failureClass: "invalid_job",
        detail: "toolDeadlineMs must be a positive finite number",
        subjectId,
        deviceId,
      };
    }
    if (job.toolDeadlineMs > FLEET_TOOL_DEADLINE_MS) {
      return {
        ok: false,
        failureClass: "deadline_extended",
        detail: `toolDeadlineMs must not exceed B4 sandbox deadline (${FLEET_TOOL_DEADLINE_MS}ms)`,
        subjectId,
        deviceId,
      };
    }
    toolDeadlineMs = job.toolDeadlineMs;
  }

  const path: FleetEpisodePath =
    job.path === "turn_loop" ? "turn_loop" : "golden_replay";

  return {
    ok: true,
    toolDeadlineMs,
    job: {
      jobId,
      scenarioId,
      seed: job.seed,
      subjectId,
      deviceId,
      policyCheckpointHash: ckpt.hash,
      path,
      toolDeadlineMs,
    },
  };
}

/**
 * Run one isolated episode: unique snapshot store + GymEnv per call.
 * Tags the result with the exact policyCheckpointHash from the job.
 */
export async function runIsolatedFleetEpisode(
  rawJob: FleetJob,
): Promise<FleetEpisodeResult> {
  const validated = validateFleetJob(rawJob);
  if (!validated.ok) {
    return {
      ok: false,
      jobId:
        typeof rawJob.jobId === "string" ? rawJob.jobId.trim() || "invalid" : "invalid",
      scenarioId:
        typeof rawJob.scenarioId === "string" ? rawJob.scenarioId.trim() : "",
      seed: typeof rawJob.seed === "number" ? rawJob.seed : -1,
      subjectId: validated.subjectId,
      deviceId: validated.deviceId,
      policyCheckpointHash:
        typeof rawJob.policyCheckpointHash === "string"
          ? rawJob.policyCheckpointHash.trim()
          : "",
      toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
      failureClass: validated.failureClass,
      detail: validated.detail,
    };
  }

  const { job, toolDeadlineMs } = validated;
  const store = allocateGymRolloutSnapshotStore({ deviceId: job.deviceId });
  const env = new GymEnv({
    subjectId: job.subjectId,
    deviceId: job.deviceId,
    snapshotStore: store,
  });

  const reset = env.reset(job.scenarioId, job.seed);
  if (!reset.ok) {
    return {
      ok: false,
      jobId: job.jobId,
      scenarioId: job.scenarioId,
      seed: job.seed,
      subjectId: job.subjectId,
      deviceId: job.deviceId,
      policyCheckpointHash: job.policyCheckpointHash,
      toolDeadlineMs,
      rolloutId: store.rolloutId,
      failureClass:
        reset.failureClass === "cross_subject"
          ? "cross_subject"
          : "episode_failed",
      detail: reset.detail,
    };
  }

  const stepped = await env.step({ path: job.path ?? "golden_replay" });
  if (!stepped.ok) {
    return {
      ok: false,
      jobId: job.jobId,
      scenarioId: job.scenarioId,
      seed: job.seed,
      subjectId: job.subjectId,
      deviceId: job.deviceId,
      policyCheckpointHash: job.policyCheckpointHash,
      toolDeadlineMs,
      episodeId: reset.episodeId,
      rolloutId: store.rolloutId,
      failureClass:
        stepped.failureClass === "cross_subject"
          ? "cross_subject"
          : "episode_failed",
      detail: stepped.detail,
    };
  }

  return {
    ok: true,
    jobId: job.jobId,
    scenarioId: job.scenarioId,
    seed: job.seed,
    subjectId: job.subjectId,
    deviceId: job.deviceId,
    policyCheckpointHash: job.policyCheckpointHash,
    toolDeadlineMs,
    episodeId: reset.episodeId,
    rolloutId: store.rolloutId,
    terminal: stepped.terminal,
    terminalFrameType: stepped.terminalFrameType,
    path: stepped.path,
    frameCount: stepped.frames.length,
    harnessFrames: harnessFramesForTelemetry(stepped.frames, job.subjectId),
  };
}
