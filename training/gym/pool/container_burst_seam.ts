/**
 * Container burst seam — pluggable backend for containerized sandbox workers.
 *
 * Same fleet queue/collect API as the local process pool; sovereign deploys must
 * declare locality (`on-device` / `self-hosted`) before burst. Raw learner
 * content never crosses the declared boundary.
 *
 * ## Locality constraints (sovereign deploys)
 *
 * 1. `declaredLocality` binds every worker spawn — no cross-boundary egress.
 * 2. `on-device` burst: containers stay on the learner device; no remote zones.
 * 3. `self-hosted` burst: `deployZoneId` is required; when `allowedZoneIds` is
 *    set, the deploy zone must be on the allowlist.
 * 4. Every read/write is `subjectId`-scoped; cross-subject access is a defect.
 * 5. Rollout and trainer pools are separate — never share accelerators.
 * 6. `toolDeadlineMs` inside workers inherits B4 sandbox default (never extended).
 */

import {
  FLEET_TOOL_DEADLINE_MS,
  runIsolatedFleetEpisode,
  validateFleetJob,
  type FleetEpisodeFailureClass,
  type FleetEpisodeResult,
  type FleetJob,
} from "./run_episode.ts";
import {
  LocalProcessPool,
  type LocalProcessPoolOptions,
  type LocalProcessPoolTelemetry,
} from "./local_process_pool.ts";

/** Sovereign locality tags — align with trajectory / consent records. */
export const FLEET_LOCALITIES = Object.freeze([
  "on-device",
  "self-hosted",
] as const);

export type FleetLocality = (typeof FLEET_LOCALITIES)[number];

export const FLEET_BACKEND_CONTAINER_BURST = "container_burst" as const;

/** Documented constraints for operators and backend implementers. */
export const CONTAINER_FLEET_LOCALITY_CONSTRAINTS = Object.freeze({
  version: 1 as const,
  rules: Object.freeze([
    "raw learner/user content never leaves declaredLocality",
    "on-device burst: containers must not egress outside the device boundary",
    "self-hosted burst: deployZoneId required; honor allowedZoneIds when set",
    "every spawn is subjectId-scoped; cross-subject access is a defect",
    "trainer and rollout pools are separate — never share accelerators",
    "per-tool deadlineMs inherits B4 sandbox default inside every worker",
  ] as const),
});

export type ContainerBurstLocalityFailureClass =
  | "missing_locality"
  | "invalid_policy"
  | "zone_required"
  | "zone_not_allowed"
  | "cross_boundary"
  | "on_device_remote_zone";

export type ContainerBurstLocalityPolicy = {
  declaredLocality: FleetLocality;
  /** Opaque sovereign zone id — required for self-hosted burst. */
  deployZoneId?: string;
  /** Optional allowlist; when set, deployZoneId must be listed. */
  allowedZoneIds?: readonly string[];
};

export type ContainerBurstSpawnContext = {
  locality: FleetLocality;
  deployZoneId?: string;
  toolDeadlineMs: number;
  /** Opaque pinned image id — never learner content. */
  imageId: string;
  subjectId: string;
  deviceId: string;
};

export type ContainerBurstBackendTelemetry = {
  event: "training.gym.fleet.container_burst";
  op: "spawn" | "run" | "release" | "reject";
  outcome: "ok" | "error";
  subjectId: string;
  deviceId: string;
  locality: FleetLocality;
  imageId?: string;
  workerId?: string;
  jobId?: string;
  failureClass?: ContainerBurstLocalityFailureClass | FleetEpisodeFailureClass;
  detail?: string;
};

/**
 * Pluggable container runtime seam. Production backends implement spawn/run/release;
 * CI uses {@link createInProcessContainerBurstBackend}.
 */
export type ContainerBurstBackend = {
  readonly kind: typeof FLEET_BACKEND_CONTAINER_BURST;
  /**
   * Run one isolated episode inside a container worker.
   * Must honor `ctx.toolDeadlineMs` (B4 ceiling already applied by caller).
   */
  runEpisode(
    job: FleetJob,
    ctx: ContainerBurstSpawnContext,
  ): Promise<FleetEpisodeResult>;
};

export type ContainerBurstFleetOptions = LocalProcessPoolOptions & {
  localityPolicy: ContainerBurstLocalityPolicy;
  /** Opaque image pin for sovereign reproducibility. */
  imageId?: string;
  containerBackend?: ContainerBurstBackend;
  onContainerTelemetry?: (e: ContainerBurstBackendTelemetry) => void;
};

function emitContainer(
  onTelemetry: ((e: ContainerBurstBackendTelemetry) => void) | undefined,
  partial: Omit<ContainerBurstBackendTelemetry, "event">,
): void {
  onTelemetry?.({ event: "training.gym.fleet.container_burst", ...partial });
}

/**
 * Validate sovereign locality policy before container burst.
 */
export function assertContainerBurstLocality(input: {
  policy: ContainerBurstLocalityPolicy;
  onTelemetry?: (e: ContainerBurstBackendTelemetry) => void;
}):
  | { ok: true; policy: ContainerBurstLocalityPolicy; locality: FleetLocality }
  | {
      ok: false;
      failureClass: ContainerBurstLocalityFailureClass;
      detail: string;
      locality: FleetLocality | null;
    } {
  const policy = input.policy;
  const locality = policy.declaredLocality;

  const fail = (
    failureClass: ContainerBurstLocalityFailureClass,
    detail: string,
  ) => {
    emitContainer(input.onTelemetry, {
      op: "reject",
      outcome: "error",
      subjectId: "fleet",
      deviceId: "fleet",
      locality: locality ?? "on-device",
      failureClass,
      detail,
    });
    return {
      ok: false as const,
      failureClass,
      detail,
      locality: locality ?? null,
    };
  };

  if (!locality || !FLEET_LOCALITIES.includes(locality)) {
    return fail("missing_locality", "declaredLocality must be on-device or self-hosted");
  }

  const zone = policy.deployZoneId?.trim() ?? "";

  if (locality === "on-device") {
    if (zone && /^(cloud|remote|federated)/i.test(zone)) {
      return fail(
        "on_device_remote_zone",
        "on-device burst cannot use remote/cloud deploy zones",
      );
    }
    return { ok: true, policy, locality };
  }

  // self-hosted
  if (!zone) {
    return fail(
      "zone_required",
      "self-hosted container burst requires deployZoneId",
    );
  }

  const allowed = policy.allowedZoneIds;
  if (allowed !== undefined && allowed.length > 0) {
    if (!allowed.includes(zone)) {
      return fail(
        "zone_not_allowed",
        `deployZoneId '${zone}' not in allowedZoneIds`,
      );
    }
  }

  return { ok: true, policy, locality };
}

/**
 * In-process stub backend — proves seam + fleet API without a real container runtime.
 * Each call still runs an isolated GymEnv + unique snapshot store.
 */
export function createInProcessContainerBurstBackend(options: {
  imageId?: string;
  onTelemetry?: (e: ContainerBurstBackendTelemetry) => void;
} = {}): ContainerBurstBackend {
  const imageId = options.imageId?.trim() || "image.gym.stub.v1";
  let workerSeq = 0;

  return {
    kind: FLEET_BACKEND_CONTAINER_BURST,
    async runEpisode(job, ctx) {
      const workerId = `ctr.stub.${++workerSeq}`;
      emitContainer(options.onTelemetry, {
        op: "spawn",
        outcome: "ok",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        locality: ctx.locality,
        imageId: ctx.imageId,
        workerId,
        jobId: job.jobId,
        detail: "in-process container stub spawn",
      });

      const result = await runIsolatedFleetEpisode({
        ...job,
        toolDeadlineMs: ctx.toolDeadlineMs,
      });

      emitContainer(options.onTelemetry, {
        op: "run",
        outcome: result.ok ? "ok" : "error",
        subjectId: result.subjectId,
        deviceId: result.deviceId,
        locality: ctx.locality,
        imageId: ctx.imageId,
        workerId,
        jobId: job.jobId,
        ...(result.failureClass !== undefined
          ? { failureClass: result.failureClass }
          : {}),
        detail: result.ok ? "episode complete" : (result.detail ?? "episode failed"),
      });

      emitContainer(options.onTelemetry, {
        op: "release",
        outcome: "ok",
        subjectId: ctx.subjectId,
        deviceId: ctx.deviceId,
        locality: ctx.locality,
        workerId,
        jobId: job.jobId,
        detail: "container stub released",
      });

      return result;
    },
  };
}

/**
 * Container burst fleet — same queue/collect API as local process pool.
 */
export class ContainerBurstFleet {
  readonly backend = FLEET_BACKEND_CONTAINER_BURST;
  private readonly pool: LocalProcessPool;
  private readonly locality: FleetLocality;
  private readonly deployZoneId: string | undefined;
  private readonly imageId: string;
  private readonly onContainerTelemetry:
    | ((e: ContainerBurstBackendTelemetry) => void)
    | undefined;

  constructor(options: ContainerBurstFleetOptions) {
    const asserted = assertContainerBurstLocality({
      policy: options.localityPolicy,
      ...(options.onContainerTelemetry !== undefined
        ? { onTelemetry: options.onContainerTelemetry }
        : {}),
    });
    if (!asserted.ok) {
      throw new Error(
        `container burst locality rejected: ${asserted.failureClass}: ${asserted.detail}`,
      );
    }

    this.locality = asserted.locality;
    this.deployZoneId = options.localityPolicy.deployZoneId?.trim() || undefined;
    this.imageId = options.imageId?.trim() || "image.gym.default.v1";
    this.onContainerTelemetry = options.onContainerTelemetry;

    const backend =
      options.containerBackend ??
      createInProcessContainerBurstBackend({
        imageId: this.imageId,
        ...(options.onContainerTelemetry !== undefined
          ? { onTelemetry: options.onContainerTelemetry }
          : {}),
      });

    this.pool = new LocalProcessPool({
      ...(options.concurrencyCap !== undefined
        ? { concurrencyCap: options.concurrencyCap }
        : {}),
      ...(options.onTelemetry !== undefined
        ? { onTelemetry: options.onTelemetry }
        : {}),
      runEpisode: async (job) => {
        const validated = validateFleetJob(job);
        if (!validated.ok) {
          return {
            ok: false,
            jobId: typeof job.jobId === "string" ? job.jobId : "invalid",
            scenarioId:
              typeof job.scenarioId === "string" ? job.scenarioId : "",
            seed: typeof job.seed === "number" ? job.seed : -1,
            subjectId: validated.subjectId,
            deviceId: validated.deviceId,
            policyCheckpointHash:
              typeof job.policyCheckpointHash === "string"
                ? job.policyCheckpointHash
                : "",
            toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
            failureClass: validated.failureClass,
            detail: validated.detail,
          };
        }

        return backend.runEpisode(validated.job, {
          locality: this.locality,
          ...(this.deployZoneId !== undefined
            ? { deployZoneId: this.deployZoneId }
            : {}),
          toolDeadlineMs: validated.toolDeadlineMs,
          imageId: this.imageId,
          subjectId: validated.job.subjectId,
          deviceId: validated.job.deviceId,
        });
      },
    });
  }

  get concurrencyCap(): number {
    return this.pool.concurrencyLimit;
  }

  getActiveWorkers(): number {
    return this.pool.getActiveWorkers();
  }

  getPendingCount(): number {
    return this.pool.getPendingCount();
  }

  getLocality(): FleetLocality {
    return this.locality;
  }

  enqueue(job: FleetJob) {
    return this.pool.enqueue(job);
  }

  async collect(): Promise<{
    ok: boolean;
    results: FleetEpisodeResult[];
    detail?: string;
  }> {
    try {
      const results = await this.pool.run();
      const errorCount = results.filter((r) => !r.ok).length;
      return {
        ok: errorCount === 0,
        results,
        ...(errorCount > 0
          ? { detail: `${errorCount} episode(s) failed` }
          : {}),
      };
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : "container fleet collect failed";
      emitContainer(this.onContainerTelemetry, {
        op: "reject",
        outcome: "error",
        subjectId: "fleet",
        deviceId: "fleet",
        locality: this.locality,
        failureClass: "config",
        detail,
      });
      return { ok: false, results: [], detail };
    }
  }

  async scaleToZero(): Promise<void> {
    await this.pool.scaleToZero();
  }

  close(): void {
    this.pool.close();
  }
}

export type ContainerBurstMicroRunInput = {
  jobs: FleetJob[];
  concurrencyCap?: number;
  localityPolicy: ContainerBurstLocalityPolicy;
  imageId?: string;
  onTelemetry?: (e: LocalProcessPoolTelemetry) => void;
  onContainerTelemetry?: (e: ContainerBurstBackendTelemetry) => void;
  containerBackend?: ContainerBurstBackend;
};

/**
 * CI micro-run through the container burst seam (stub backend by default).
 */
export async function runContainerBurstMicroRun(
  input: ContainerBurstMicroRunInput,
): Promise<{
  ok: boolean;
  results: FleetEpisodeResult[];
  locality: FleetLocality;
  detail?: string;
}> {
  const asserted = assertContainerBurstLocality({
    policy: input.localityPolicy,
    ...(input.onContainerTelemetry !== undefined
      ? { onTelemetry: input.onContainerTelemetry }
      : {}),
  });
  if (!asserted.ok) {
    return {
      ok: false,
      results: [],
      locality: asserted.locality ?? "on-device",
      detail: asserted.detail,
    };
  }

  const fleet = new ContainerBurstFleet({
    concurrencyCap: input.concurrencyCap ?? 4,
    localityPolicy: input.localityPolicy,
    ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
    ...(input.onTelemetry !== undefined
      ? { onTelemetry: input.onTelemetry }
      : {}),
    ...(input.onContainerTelemetry !== undefined
      ? { onContainerTelemetry: input.onContainerTelemetry }
      : {}),
    ...(input.containerBackend !== undefined
      ? { containerBackend: input.containerBackend }
      : {}),
  });

  for (const job of input.jobs) {
    const enq = fleet.enqueue(job);
    if (!enq.ok) {
      fleet.close();
      return {
        ok: false,
        results: [],
        locality: asserted.locality,
        detail: enq.detail,
      };
    }
  }

  const collected = await fleet.collect();
  fleet.close();
  return {
    ok: collected.ok,
    results: collected.results,
    locality: asserted.locality,
    ...(collected.detail !== undefined ? { detail: collected.detail } : {}),
  };
}
