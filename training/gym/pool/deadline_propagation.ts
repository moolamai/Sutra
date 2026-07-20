/**
 * Fleet deadline propagation — B4 sandbox hang kill through isolated workers.
 * Hung tools terminate at deadline without stalling the pool; timeout is
 * attributed on episode results for downstream trajectory telemetry.
 */

import {
  InProcessFakeToolRegistry,
} from "@moolam/runtime-harness";
import { loadGymScenarioFixture, terminalFromHarnessFrames } from "../env.ts";
import { runProductionTurnLoop } from "../src/harness_bridge.mjs";
import { allocateGymRolloutSnapshotStore } from "../snapshot_store.ts";
import {
  FLEET_TOOL_DEADLINE_MS,
  validateFleetJob,
  type FleetEpisodeResult,
  type FleetJob,
} from "./run_episode.ts";

/** CI hang-kill budget — well under B4 default, matches harness drill scale. */
export const FLEET_HANG_TEST_DEADLINE_MS = 50;

/** Soft wall for pool stall proofs — serial hang would exceed this. */
export const FLEET_POOL_STALL_BUDGET_MS = 2_500;

export type FleetEpisodeTelemetry = {
  event: "training.gym.fleet.episode";
  op: "hang_kill" | "deadline_attribute";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  jobId?: string;
  scenarioId?: string;
  sandboxDeadlineExceeded?: boolean;
  sandboxFailureClass?: "deadline_exceeded";
  toolDeadlineMs?: number;
  failureClass?: string;
  detail?: string;
};

export type SandboxDeadlineAttribution = {
  sandboxDeadlineExceeded: boolean;
  sandboxFailureClass?: "deadline_exceeded";
  /** C0-aligned execution state for episode telemetry handoff. */
  executionState?: {
    commandExecuted: string;
    statusCode: number | string;
  };
};

function emitEpisodeTel(
  onTelemetry: ((e: FleetEpisodeTelemetry) => void) | undefined,
  partial: Omit<FleetEpisodeTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.gym.fleet.episode", ...partial });
}

/**
 * Registry with a hung `lookup` tool — production sandbox seam races deadline.
 */
export function createGymHangToolRegistry(): InProcessFakeToolRegistry {
  const registry = new InProcessFakeToolRegistry();
  registry.register({
    descriptor: {
      name: "lookup",
      description: "never-resolving lookup probe for fleet hang drills",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      riskClass: "read",
    },
    hang: true,
  });
  return registry;
}

/**
 * Derive sandbox deadline attribution from production harness frames.
 */
export function attributeEpisodeSandboxDeadline(
  frames: readonly unknown[],
): SandboxDeadlineAttribution {
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const typed = frame as {
      type?: string;
      status?: string;
      detail?: string;
    };
    if (
      typed.type === "TOOL_STATUS" &&
      typed.status === "error" &&
      typeof typed.detail === "string" &&
      /deadline/i.test(typed.detail)
    ) {
      return {
        sandboxDeadlineExceeded: true,
        sandboxFailureClass: "deadline_exceeded",
        executionState: {
          commandExecuted: "sandbox.invoke",
          statusCode: "deadline_exceeded",
        },
      };
    }
  }
  return { sandboxDeadlineExceeded: false };
}

function mergeDeadlineAttribution(
  result: FleetEpisodeResult,
  frames: readonly unknown[],
): FleetEpisodeResult {
  const attribution = attributeEpisodeSandboxDeadline(frames);
  return {
    ...result,
    ...attribution,
  };
}

/**
 * Run one fleet turn_loop episode with a hung tool and B4 deadline propagation.
 */
export async function runFleetHangEpisode(input: {
  job: FleetJob;
  toolDeadlineMs?: number;
  registry?: InProcessFakeToolRegistry;
  onTelemetry?: (e: FleetEpisodeTelemetry) => void;
}): Promise<FleetEpisodeResult> {
  const toolDeadlineMs = input.toolDeadlineMs ?? FLEET_HANG_TEST_DEADLINE_MS;
  const validated = validateFleetJob({
    ...input.job,
    path: "turn_loop",
    toolDeadlineMs,
    scenarioId: input.job.scenarioId || "tool-call-fence",
  });

  if (!validated.ok) {
    emitEpisodeTel(input.onTelemetry, {
      op: "hang_kill",
      outcome: "error",
      subjectId: validated.subjectId,
      deviceId: validated.deviceId,
      jobId: typeof input.job.jobId === "string" ? input.job.jobId : undefined,
      failureClass: validated.failureClass,
      detail: validated.detail,
    });
    return {
      ok: false,
      jobId:
        typeof input.job.jobId === "string" ? input.job.jobId : "invalid",
      scenarioId:
        typeof input.job.scenarioId === "string" ? input.job.scenarioId : "",
      seed: typeof input.job.seed === "number" ? input.job.seed : -1,
      subjectId: validated.subjectId,
      deviceId: validated.deviceId,
      policyCheckpointHash:
        typeof input.job.policyCheckpointHash === "string"
          ? input.job.policyCheckpointHash
          : "",
      toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
      failureClass: validated.failureClass,
      detail: validated.detail,
    };
  }

  const { job } = validated;
  const loaded = loadGymScenarioFixture(job.scenarioId, {
    subjectId: job.subjectId,
    deviceId: job.deviceId,
  });
  if (!loaded.ok) {
    emitEpisodeTel(input.onTelemetry, {
      op: "hang_kill",
      outcome: "error",
      subjectId: loaded.subjectId,
      deviceId: loaded.deviceId,
      jobId: job.jobId,
      scenarioId: job.scenarioId,
      failureClass: loaded.failureClass,
      detail: loaded.detail,
    });
    return {
      ok: false,
      jobId: job.jobId,
      scenarioId: job.scenarioId,
      seed: job.seed,
      subjectId: loaded.subjectId,
      deviceId: loaded.deviceId,
      policyCheckpointHash: job.policyCheckpointHash,
      toolDeadlineMs: validated.toolDeadlineMs,
      failureClass:
        loaded.failureClass === "cross_subject"
          ? "cross_subject"
          : "episode_failed",
      detail: loaded.detail,
    };
  }

  const scenario = loaded.scenario;
  const store = allocateGymRolloutSnapshotStore({ deviceId: scenario.deviceId });
  const registry = input.registry ?? createGymHangToolRegistry();
  const turnId = scenario.correlationId.replace(/^corr-/, "turn-");
  const pinnedAtFrame = scenario.expectedFrames.find(
    (f) =>
      f &&
      typeof f === "object" &&
      (f as { type?: string }).type === "SESSION_START",
  ) as { pinnedAt?: string } | undefined;

  const t0 = Date.now();
  const looped = await runProductionTurnLoop({
    subjectId: scenario.subjectId,
    deviceId: scenario.deviceId,
    correlationId: scenario.correlationId,
    turnId,
    chunks: scenario.input,
    seed: job.seed,
    toolDeadlineMs: validated.toolDeadlineMs,
    registry,
    ...(pinnedAtFrame?.pinnedAt !== undefined
      ? { pinnedAt: pinnedAtFrame.pinnedAt }
      : {}),
    onTelemetry: (e) => {
      emitEpisodeTel(input.onTelemetry, {
        op: "hang_kill",
        outcome: e.outcome === "ok" ? "ok" : "error",
        subjectId: e.subjectId ?? scenario.subjectId,
        deviceId: e.deviceId ?? scenario.deviceId,
        jobId: job.jobId,
        scenarioId: job.scenarioId,
        toolDeadlineMs: validated.toolDeadlineMs,
        ...(e.failureClass !== undefined
          ? { failureClass: e.failureClass }
          : {}),
        detail: e.detail,
      });
    },
  });
  const elapsed = Date.now() - t0;

  if (!looped.ok) {
    return mergeDeadlineAttribution(
      {
        ok: false,
        jobId: job.jobId,
        scenarioId: job.scenarioId,
        seed: job.seed,
        subjectId: job.subjectId,
        deviceId: job.deviceId,
        policyCheckpointHash: job.policyCheckpointHash,
        toolDeadlineMs: validated.toolDeadlineMs,
        rolloutId: store.rolloutId,
        path: "turn_loop",
        frameCount: looped.frames.length,
        failureClass: "episode_failed",
        detail: looped.detail,
      },
      looped.frames,
    );
  }

  const terminal = terminalFromHarnessFrames(looped.frames);
  const base: FleetEpisodeResult = {
    ok: true,
    jobId: job.jobId,
    scenarioId: job.scenarioId,
    seed: job.seed,
    subjectId: job.subjectId,
    deviceId: job.deviceId,
    policyCheckpointHash: job.policyCheckpointHash,
    toolDeadlineMs: validated.toolDeadlineMs,
    rolloutId: store.rolloutId,
    terminal: terminal.terminal,
    terminalFrameType: terminal.terminalFrameType,
    path: "turn_loop",
    frameCount: looped.frames.length,
    detail: `hang_kill_elapsed_ms=${elapsed}`,
  };

  const attributed = mergeDeadlineAttribution(base, looped.frames);
  emitEpisodeTel(input.onTelemetry, {
    op: "deadline_attribute",
    outcome: attributed.sandboxDeadlineExceeded ? "ok" : "error",
    subjectId: job.subjectId,
    deviceId: job.deviceId,
    jobId: job.jobId,
    scenarioId: job.scenarioId,
    sandboxDeadlineExceeded: attributed.sandboxDeadlineExceeded,
    sandboxFailureClass: attributed.sandboxFailureClass,
    toolDeadlineMs: validated.toolDeadlineMs,
    detail: attributed.sandboxDeadlineExceeded
      ? "sandbox deadline exceeded attributed on episode"
      : "expected sandbox deadline_exceeded attribution missing",
  });
  return attributed;
}

/**
 * Prove fleet pool drains when one worker hits a hung tool at B4 deadline.
 */
export async function proveFleetDeadlinePropagation(input: {
  hangJob: FleetJob;
  fastJobs: FleetJob[];
  concurrencyCap?: number;
  toolDeadlineMs?: number;
  onPoolTelemetry?: (e: unknown) => void;
  onEpisodeTelemetry?: (e: FleetEpisodeTelemetry) => void;
}): Promise<{
  ok: boolean;
  results: FleetEpisodeResult[];
  elapsedMs: number;
  hangAttributed: boolean;
  detail?: string;
}> {
  const { LocalProcessPool } = await import("./local_process_pool.ts");
  const pool = new LocalProcessPool({
    concurrencyCap: input.concurrencyCap ?? 3,
    ...(input.onPoolTelemetry !== undefined
      ? { onTelemetry: input.onPoolTelemetry }
      : {}),
    runEpisode: async (job) => {
      if (job.jobId === input.hangJob.jobId) {
        return runFleetHangEpisode({
          job,
          ...(input.toolDeadlineMs !== undefined
            ? { toolDeadlineMs: input.toolDeadlineMs }
            : {}),
          ...(input.onEpisodeTelemetry !== undefined
            ? { onTelemetry: input.onEpisodeTelemetry }
            : {}),
        });
      }
      const { runIsolatedFleetEpisode } = await import("./run_episode.ts");
      return runIsolatedFleetEpisode(job);
    },
  });

  const t0 = Date.now();
  for (const job of [input.hangJob, ...input.fastJobs]) {
    const enq = pool.enqueue(job);
    if (!enq.ok) {
      return {
        ok: false,
        results: [],
        elapsedMs: Date.now() - t0,
        hangAttributed: false,
        detail: enq.detail,
      };
    }
  }

  const results = await pool.run();
  const elapsedMs = Date.now() - t0;
  const hang = results.find((r) => r.jobId === input.hangJob.jobId);
  const hangAttributed = hang?.sandboxDeadlineExceeded === true;
  const fastOk = input.fastJobs.every((j) => {
    const r = results.find((x) => x.jobId === j.jobId);
    return r?.ok === true;
  });
  const stallExceeded = elapsedMs > FLEET_POOL_STALL_BUDGET_MS;

  return {
    ok: hangAttributed && fastOk && !stallExceeded && pool.getActiveWorkers() === 0,
    results,
    elapsedMs,
    hangAttributed,
    ...(!hangAttributed || !fastOk || stallExceeded
      ? {
          detail: !hangAttributed
            ? "hang episode missing sandboxDeadlineExceeded attribution"
            : !fastOk
              ? "fast workers failed while hang worker ran"
              : `pool stalled (${elapsedMs}ms > ${FLEET_POOL_STALL_BUDGET_MS}ms)`,
        }
      : {}),
  };
}
