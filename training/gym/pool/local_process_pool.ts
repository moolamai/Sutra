/**
 * Local process pool — concurrency-capped isolated episode workers.
 * Scale-to-zero when the queue drains (activeWorkers → 0).
 */

import {
  runIsolatedFleetEpisode,
  validateFleetJob,
  type FleetEpisodeFailureClass,
  type FleetEpisodeResult,
  type FleetJob,
} from "./run_episode.ts";

/** Soft caps (NFR — SLM-scale tens–hundreds, bounded queue). */
export const FLEET_CONCURRENCY_CAP_DEFAULT = 8;
export const FLEET_CONCURRENCY_CAP_MAX = 256;
export const FLEET_JOB_QUEUE_LIMIT = 1_024;

export type LocalProcessPoolTelemetry = {
  event: "training.gym.fleet.pool";
  op: "enqueue" | "start" | "complete" | "scale_to_zero" | "reject";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  jobId?: string;
  scenarioId?: string;
  seed?: number;
  policyCheckpointHash?: string;
  activeWorkers?: number;
  pending?: number;
  failureClass?: FleetEpisodeFailureClass;
  detail?: string;
};

export type LocalProcessPoolOptions = {
  /** Max concurrent isolated workers (SLM scale). Default 8, max 256. */
  concurrencyCap?: number;
  onTelemetry?: (e: LocalProcessPoolTelemetry) => void;
  /** Inject for tests — default runs isolated GymEnv episodes. */
  runEpisode?: (job: FleetJob) => Promise<FleetEpisodeResult>;
};

function emit(
  onTelemetry: ((e: LocalProcessPoolTelemetry) => void) | undefined,
  partial: Omit<LocalProcessPoolTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.gym.fleet.pool", ...partial });
}

/**
 * Concurrency-capped local process pool for gym rollouts.
 * Each in-flight slot owns an isolated gym + snapshot store (never shared).
 */
export class LocalProcessPool {
  private readonly concurrencyCap: number;
  private readonly onTelemetry:
    | ((e: LocalProcessPoolTelemetry) => void)
    | undefined;
  private readonly runEpisode: (
    job: FleetJob,
  ) => Promise<FleetEpisodeResult>;
  private readonly queue: FleetJob[] = [];
  /** Idempotent result cache keyed by jobId. */
  private readonly settled = new Map<string, FleetEpisodeResult>();
  private readonly inFlightJobIds = new Set<string>();
  /** Serialize same-subject RMW across workers. */
  private readonly subjectBusy = new Set<string>();
  private activeWorkers = 0;
  private closed = false;

  constructor(options: LocalProcessPoolOptions = {}) {
    const cap = options.concurrencyCap ?? FLEET_CONCURRENCY_CAP_DEFAULT;
    if (
      !Number.isInteger(cap) ||
      cap < 1 ||
      cap > FLEET_CONCURRENCY_CAP_MAX
    ) {
      throw new Error(
        `concurrencyCap must be an integer in 1..${FLEET_CONCURRENCY_CAP_MAX}`,
      );
    }
    this.concurrencyCap = cap;
    this.onTelemetry = options.onTelemetry;
    this.runEpisode = options.runEpisode ?? runIsolatedFleetEpisode;
  }

  get concurrencyLimit(): number {
    return this.concurrencyCap;
  }

  getActiveWorkers(): number {
    return this.activeWorkers;
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a job. Duplicate jobId returns the prior result without re-running.
   */
  enqueue(job: FleetJob):
    | { ok: true; queued: boolean; result?: FleetEpisodeResult }
    | {
        ok: false;
        failureClass: FleetEpisodeFailureClass;
        detail: string;
        subjectId: string;
        deviceId: string;
      } {
    if (this.closed) {
      return {
        ok: false,
        failureClass: "config",
        detail: "pool is closed",
        subjectId: typeof job.subjectId === "string" ? job.subjectId : "",
        deviceId: typeof job.deviceId === "string" ? job.deviceId : "",
      };
    }

    const validated = validateFleetJob(job);
    if (!validated.ok) {
      emit(this.onTelemetry, {
        op: "reject",
        outcome: "error",
        subjectId: validated.subjectId,
        deviceId: validated.deviceId,
        jobId: typeof job.jobId === "string" ? job.jobId : undefined,
        failureClass: validated.failureClass,
        detail: validated.detail,
      });
      return {
        ok: false,
        failureClass: validated.failureClass,
        detail: validated.detail,
        subjectId: validated.subjectId,
        deviceId: validated.deviceId,
      };
    }

    const prior = this.settled.get(validated.job.jobId);
    if (prior) {
      emit(this.onTelemetry, {
        op: "enqueue",
        outcome: "ok",
        subjectId: validated.job.subjectId,
        deviceId: validated.job.deviceId,
        jobId: validated.job.jobId,
        scenarioId: validated.job.scenarioId,
        seed: validated.job.seed,
        policyCheckpointHash: validated.job.policyCheckpointHash,
        activeWorkers: this.activeWorkers,
        pending: this.queue.length,
        detail: "idempotent replay of settled jobId",
      });
      return { ok: true, queued: false, result: prior };
    }

    if (this.inFlightJobIds.has(validated.job.jobId)) {
      emit(this.onTelemetry, {
        op: "enqueue",
        outcome: "ok",
        subjectId: validated.job.subjectId,
        deviceId: validated.job.deviceId,
        jobId: validated.job.jobId,
        detail: "jobId already in flight — idempotent no-op",
      });
      return { ok: true, queued: false };
    }

    if (this.queue.some((j) => j.jobId === validated.job.jobId)) {
      emit(this.onTelemetry, {
        op: "enqueue",
        outcome: "ok",
        subjectId: validated.job.subjectId,
        deviceId: validated.job.deviceId,
        jobId: validated.job.jobId,
        detail: "jobId already queued — idempotent no-op",
      });
      return { ok: true, queued: false };
    }

    if (this.queue.length >= FLEET_JOB_QUEUE_LIMIT) {
      emit(this.onTelemetry, {
        op: "reject",
        outcome: "error",
        subjectId: validated.job.subjectId,
        deviceId: validated.job.deviceId,
        jobId: validated.job.jobId,
        failureClass: "queue_full",
        detail: `fleet job queue exceeds ${FLEET_JOB_QUEUE_LIMIT}`,
      });
      return {
        ok: false,
        failureClass: "queue_full",
        detail: `fleet job queue exceeds ${FLEET_JOB_QUEUE_LIMIT}`,
        subjectId: validated.job.subjectId,
        deviceId: validated.job.deviceId,
      };
    }

    this.queue.push(validated.job);
    emit(this.onTelemetry, {
      op: "enqueue",
      outcome: "ok",
      subjectId: validated.job.subjectId,
      deviceId: validated.job.deviceId,
      jobId: validated.job.jobId,
      scenarioId: validated.job.scenarioId,
      seed: validated.job.seed,
      policyCheckpointHash: validated.job.policyCheckpointHash,
      activeWorkers: this.activeWorkers,
      pending: this.queue.length,
      detail: "job queued",
    });
    return { ok: true, queued: true };
  }

  /**
   * Drain the queue under the concurrency cap. Scale-to-zero when empty.
   */
  async run(): Promise<FleetEpisodeResult[]> {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.concurrencyCap; i += 1) {
      workers.push(this.workerLoop());
    }
    await Promise.all(workers);

    if (this.activeWorkers !== 0 || this.queue.length !== 0) {
      throw new Error(
        `pool drain incomplete: active=${this.activeWorkers} pending=${this.queue.length}`,
      );
    }

    emit(this.onTelemetry, {
      op: "scale_to_zero",
      outcome: "ok",
      subjectId: "fleet",
      deviceId: "fleet",
      activeWorkers: 0,
      pending: 0,
      detail: "queue empty; workers scaled to zero",
    });

    return [...this.settled.values()];
  }

  /**
   * Wait until no pending or active work (scale-to-zero).
   */
  async scaleToZero(): Promise<void> {
    if (this.queue.length > 0 || this.activeWorkers > 0) {
      await this.run();
      return;
    }
    emit(this.onTelemetry, {
      op: "scale_to_zero",
      outcome: "ok",
      subjectId: "fleet",
      deviceId: "fleet",
      activeWorkers: 0,
      pending: 0,
      detail: "already at zero",
    });
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Claim next runnable job and mark the worker active in the same step
   * so idle peers cannot race past an empty-queue exit.
   */
  private takeNextJob(): FleetJob | null {
    const idx = this.queue.findIndex((j) => !this.subjectBusy.has(j.subjectId));
    if (idx < 0) {
      return null;
    }
    const [job] = this.queue.splice(idx, 1);
    if (!job) {
      return null;
    }
    this.activeWorkers += 1;
    this.inFlightJobIds.add(job.jobId);
    this.subjectBusy.add(job.subjectId);
    return job;
  }

  private async workerLoop(): Promise<void> {
    for (;;) {
      if (this.closed && this.queue.length === 0 && this.activeWorkers === 0) {
        return;
      }
      const job = this.takeNextJob();
      if (!job) {
        // Idle: exit only when the whole pool is drained.
        if (this.queue.length === 0 && this.activeWorkers === 0) {
          return;
        }
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }

      emit(this.onTelemetry, {
        op: "start",
        outcome: "ok",
        subjectId: job.subjectId,
        deviceId: job.deviceId,
        jobId: job.jobId,
        scenarioId: job.scenarioId,
        seed: job.seed,
        policyCheckpointHash: job.policyCheckpointHash,
        activeWorkers: this.activeWorkers,
        pending: this.queue.length,
        detail: "worker started",
      });

      try {
        const result = await this.runEpisode(job);
        this.settled.set(job.jobId, result);
        emit(this.onTelemetry, {
          op: "complete",
          outcome: result.ok ? "ok" : "error",
          subjectId: result.subjectId,
          deviceId: result.deviceId,
          jobId: result.jobId,
          scenarioId: result.scenarioId,
          seed: result.seed,
          policyCheckpointHash: result.policyCheckpointHash,
          activeWorkers: Math.max(0, this.activeWorkers - 1),
          pending: this.queue.length,
          ...(result.failureClass !== undefined
            ? { failureClass: result.failureClass }
            : {}),
          detail: result.ok
            ? "episode complete"
            : (result.detail ?? "episode failed"),
        });
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : "worker threw";
        const failed: FleetEpisodeResult = {
          ok: false,
          jobId: job.jobId,
          scenarioId: job.scenarioId,
          seed: job.seed,
          subjectId: job.subjectId,
          deviceId: job.deviceId,
          policyCheckpointHash: job.policyCheckpointHash,
          toolDeadlineMs: job.toolDeadlineMs ?? 0,
          failureClass: "episode_failed",
          detail,
        };
        this.settled.set(job.jobId, failed);
        emit(this.onTelemetry, {
          op: "complete",
          outcome: "error",
          subjectId: job.subjectId,
          deviceId: job.deviceId,
          jobId: job.jobId,
          failureClass: "episode_failed",
          detail,
        });
      } finally {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        this.inFlightJobIds.delete(job.jobId);
        this.subjectBusy.delete(job.subjectId);
      }
    }
  }
}
