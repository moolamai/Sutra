/**

 * Sandbox fleet runner — local process pool + container burst seam.

 *

 * Spawns up to N concurrent isolated gym workers; assigns scenario+seed;

 * collects episode results tagged with exact policyCheckpointHash; scale-to-zero

 * when the queue drains. Per-tool deadline inherits B4 sandbox default.

 */



import { SANDBOX_DEFAULT_DEADLINE_MS } from "@moolam/runtime-harness";

import {

  ContainerBurstFleet,

  FLEET_BACKEND_CONTAINER_BURST,

  FLEET_LOCALITIES,

  CONTAINER_FLEET_LOCALITY_CONSTRAINTS,

  assertContainerBurstLocality,

  createInProcessContainerBurstBackend,

  runContainerBurstMicroRun,

  type ContainerBurstBackend,

  type ContainerBurstBackendTelemetry,

  type ContainerBurstFleetOptions,

  type ContainerBurstLocalityFailureClass,

  type ContainerBurstLocalityPolicy,

  type ContainerBurstMicroRunInput,

  type FleetLocality,

} from "./pool/container_burst_seam.ts";

import {

  FLEET_CONCURRENCY_CAP_DEFAULT,

  FLEET_CONCURRENCY_CAP_MAX,

  FLEET_JOB_QUEUE_LIMIT,

  LocalProcessPool,

  type LocalProcessPoolOptions,

  type LocalProcessPoolTelemetry,

} from "./pool/local_process_pool.ts";

import {

  FLEET_TOOL_DEADLINE_MS,

  runIsolatedFleetEpisode,

  validateFleetJob,

  type FleetEpisodeFailureClass,

  type FleetEpisodeResult,

  type FleetJob,

} from "./pool/run_episode.ts";

import {

  FLEET_HANG_TEST_DEADLINE_MS,

  FLEET_POOL_STALL_BUDGET_MS,

  attributeEpisodeSandboxDeadline,

  createGymHangToolRegistry,

  proveFleetDeadlinePropagation,

  runFleetHangEpisode,

  type FleetEpisodeTelemetry,

  type SandboxDeadlineAttribution,

} from "./pool/deadline_propagation.ts";



export {

  FLEET_CONCURRENCY_CAP_DEFAULT,

  FLEET_CONCURRENCY_CAP_MAX,

  FLEET_JOB_QUEUE_LIMIT,

  FLEET_TOOL_DEADLINE_MS,

  FLEET_BACKEND_CONTAINER_BURST,

  FLEET_LOCALITIES,

  CONTAINER_FLEET_LOCALITY_CONSTRAINTS,

  LocalProcessPool,

  ContainerBurstFleet,

  runIsolatedFleetEpisode,

  validateFleetJob,

  assertContainerBurstLocality,

  createInProcessContainerBurstBackend,

  runContainerBurstMicroRun,

  FLEET_HANG_TEST_DEADLINE_MS,

  FLEET_POOL_STALL_BUDGET_MS,

  attributeEpisodeSandboxDeadline,

  createGymHangToolRegistry,

  proveFleetDeadlinePropagation,

  runFleetHangEpisode,

  SANDBOX_DEFAULT_DEADLINE_MS,

};



export type {

  FleetEpisodeFailureClass,

  FleetEpisodeResult,

  FleetJob,

  FleetLocality,

  LocalProcessPoolOptions,

  LocalProcessPoolTelemetry,

  ContainerBurstBackend,

  ContainerBurstBackendTelemetry,

  ContainerBurstFleetOptions,

  ContainerBurstLocalityFailureClass,

  ContainerBurstLocalityPolicy,

  ContainerBurstMicroRunInput,

  FleetEpisodeTelemetry,

  SandboxDeadlineAttribution,

};



/** Fleet backend id — local process pool (default). */

export const FLEET_BACKEND_LOCAL_PROCESS = "local_process" as const;



export type FleetBackendId =

  | typeof FLEET_BACKEND_LOCAL_PROCESS

  | typeof FLEET_BACKEND_CONTAINER_BURST;



export type FleetTelemetry = {

  event: "training.gym.fleet";

  op: "run" | "micro_run" | "reject";

  outcome: "ok" | "error";

  subjectId: string;

  deviceId: string;

  backend: FleetBackendId;

  jobCount?: number;

  okCount?: number;

  errorCount?: number;

  concurrencyCap?: number;

  activeWorkers?: number;

  /** Lineage — base checkpoint for the run (exact hash). */

  baseCheckpointHash?: string;

  corpusManifestId?: string;

  locality?: FleetLocality;

  failureClass?: FleetEpisodeFailureClass | ContainerBurstLocalityFailureClass;

  detail?: string;

};



export type FleetLineage = {

  /** Opaque corpus / scenario catalog id. */

  corpusManifestId: string;

  /** Exact base policy checkpoint — never `latest`. */

  baseCheckpointHash: string;

  /** Opaque hyperparameter bundle id. */

  hyperparametersId?: string;

  /** Opaque critic / reward version id. */

  criticVersionId?: string;

};



export type FleetCollectResult = {

  ok: boolean;

  results: FleetEpisodeResult[];

  lineage?: FleetLineage;

  detail?: string;

};



/** Shared fleet surface — local process and container burst backends. */

export type SandboxFleetRunner = {

  readonly backend: FleetBackendId;

  readonly concurrencyCap: number;

  getActiveWorkers(): number;

  getPendingCount(): number;

  enqueue(job: FleetJob): ReturnType<LocalProcessPool["enqueue"]>;

  collect(): Promise<FleetCollectResult>;

  scaleToZero(): Promise<void>;

  close(): void;

};



export type LocalProcessPoolFleetOptions = LocalProcessPoolOptions & {

  lineage?: FleetLineage;

  onFleetTelemetry?: (e: FleetTelemetry) => void;

  deviceId?: string;

};



export type CreateSandboxFleetOptions =

  | ({ backend?: typeof FLEET_BACKEND_LOCAL_PROCESS } & LocalProcessPoolFleetOptions)

  | ({

      backend: typeof FLEET_BACKEND_CONTAINER_BURST;

    } & ContainerBurstFleetOptions & {

        lineage?: FleetLineage;

        onFleetTelemetry?: (e: FleetTelemetry) => void;

        deviceId?: string;

      });



function emitFleet(

  backend: FleetBackendId,

  onTelemetry: ((e: FleetTelemetry) => void) | undefined,

  partial: Omit<FleetTelemetry, "event" | "backend">,

): void {

  onTelemetry?.({

    event: "training.gym.fleet",

    backend,

    ...partial,

  });

}



/**

 * Local process pool fleet — rollout collection sized for SLMs.

 * Trainer must use a separate pool instance (accelerator isolation).

 */

export class LocalProcessPoolFleet implements SandboxFleetRunner {

  readonly backend = FLEET_BACKEND_LOCAL_PROCESS;

  private readonly pool: LocalProcessPool;

  private readonly lineage: FleetLineage | undefined;

  private readonly onFleetTelemetry:

    | ((e: FleetTelemetry) => void)

    | undefined;

  private readonly deviceId: string;



  constructor(options: LocalProcessPoolFleetOptions = {}) {

    this.lineage = options.lineage;

    this.onFleetTelemetry = options.onFleetTelemetry;

    this.deviceId = options.deviceId?.trim() || "dev-fleet";

    this.pool = new LocalProcessPool({

      ...(options.concurrencyCap !== undefined

        ? { concurrencyCap: options.concurrencyCap }

        : {}),

      ...(options.onTelemetry !== undefined

        ? { onTelemetry: options.onTelemetry }

        : {}),

      ...(options.runEpisode !== undefined

        ? { runEpisode: options.runEpisode }

        : {}),

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



  enqueue(job: FleetJob) {

    return this.pool.enqueue(job);

  }



  /**

   * Collect all queued episode results; workers scale to zero on drain.

   */

  async collect(): Promise<FleetCollectResult> {

    const jobCount =

      this.pool.getPendingCount() + this.pool.getActiveWorkers();

    try {

      const results = await this.pool.run();

      const okCount = results.filter((r) => r.ok).length;

      const errorCount = results.length - okCount;

      emitFleet(FLEET_BACKEND_LOCAL_PROCESS, this.onFleetTelemetry, {

        op: "run",

        outcome: errorCount === 0 ? "ok" : "error",

        subjectId: "fleet",

        deviceId: this.deviceId,

        jobCount: results.length,

        okCount,

        errorCount,

        concurrencyCap: this.concurrencyCap,

        activeWorkers: this.getActiveWorkers(),

        ...(this.lineage

          ? {

              baseCheckpointHash: this.lineage.baseCheckpointHash,

              corpusManifestId: this.lineage.corpusManifestId,

            }

          : {}),

        detail:

          errorCount === 0

            ? "fleet collect complete; scaled to zero"

            : `${errorCount} episode(s) failed`,

      });

      return {

        ok: errorCount === 0,

        results,

        ...(this.lineage !== undefined ? { lineage: this.lineage } : {}),

        ...(errorCount > 0

          ? { detail: `${errorCount} episode(s) failed` }

          : {}),

      };

    } catch (err: unknown) {

      const detail = err instanceof Error ? err.message : "fleet collect failed";

      emitFleet(FLEET_BACKEND_LOCAL_PROCESS, this.onFleetTelemetry, {

        op: "run",

        outcome: "error",

        subjectId: "fleet",

        deviceId: this.deviceId,

        jobCount,

        concurrencyCap: this.concurrencyCap,

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



/**

 * Pluggable sandbox fleet factory — local process (default) or container burst.

 */

export function createSandboxFleet(

  options: CreateSandboxFleetOptions = {},

): SandboxFleetRunner {

  if (options.backend === FLEET_BACKEND_CONTAINER_BURST) {

    const {

      backend: _backend,

      lineage,

      onFleetTelemetry,

      deviceId,

      ...burstOptions

    } = options;

    const burst = new ContainerBurstFleet(burstOptions);

    const device = deviceId?.trim() || "dev-fleet-container";



  return {

      backend: FLEET_BACKEND_CONTAINER_BURST,

      concurrencyCap: burst.concurrencyCap,

      getActiveWorkers: () => burst.getActiveWorkers(),

      getPendingCount: () => burst.getPendingCount(),

      enqueue: (job) => burst.enqueue(job),

      collect: async () => {

        const collected = await burst.collect();

        const okCount = collected.results.filter((r) => r.ok).length;

        const errorCount = collected.results.length - okCount;

        emitFleet(FLEET_BACKEND_CONTAINER_BURST, onFleetTelemetry, {

          op: "run",

          outcome: collected.ok ? "ok" : "error",

          subjectId: "fleet",

          deviceId: device,

          jobCount: collected.results.length,

          okCount,

          errorCount,

          concurrencyCap: burst.concurrencyCap,

          activeWorkers: burst.getActiveWorkers(),

          locality: burst.getLocality(),

          ...(lineage

            ? {

                baseCheckpointHash: lineage.baseCheckpointHash,

                corpusManifestId: lineage.corpusManifestId,

              }

            : {}),

          detail: collected.detail ?? "container fleet collect",

        });

        return {

          ok: collected.ok,

          results: collected.results,

          ...(lineage !== undefined ? { lineage } : {}),

          ...(collected.detail !== undefined ? { detail: collected.detail } : {}),

        };

      },

      scaleToZero: () => burst.scaleToZero(),

      close: () => burst.close(),

    };

  }



  const { backend: _backend, ...localOptions } = options;

  return new LocalProcessPoolFleet(localOptions);

}



/**

 * Tiny corpus micro-run for CI — lineage recorded, concurrency capped.

 */

export async function runLocalProcessPoolMicroRun(input: {

  jobs: FleetJob[];

  concurrencyCap?: number;

  lineage: FleetLineage;

  onTelemetry?: (e: LocalProcessPoolTelemetry) => void;

  onFleetTelemetry?: (e: FleetTelemetry) => void;

  runEpisode?: (job: FleetJob) => Promise<FleetEpisodeResult>;

}): Promise<{

  ok: boolean;

  results: FleetEpisodeResult[];

  lineage: FleetLineage;

  detail?: string;

}> {

  const ckpt = input.lineage.baseCheckpointHash?.trim() ?? "";

  if (!ckpt || ckpt.toLowerCase() === "latest") {

    emitFleet(FLEET_BACKEND_LOCAL_PROCESS, input.onFleetTelemetry, {

      op: "micro_run",

      outcome: "error",

      subjectId: "fleet",

      deviceId: "dev-fleet-micro",

      failureClass: "floating_checkpoint",

      detail: "lineage.baseCheckpointHash must be an exact checkpoint",

    });

    return {

      ok: false,

      results: [],

      lineage: input.lineage,

      detail: "lineage.baseCheckpointHash must be an exact checkpoint",

    };

  }



  const fleet = new LocalProcessPoolFleet({

    concurrencyCap: input.concurrencyCap ?? 4,

    lineage: input.lineage,

    deviceId: "dev-fleet-micro",

    ...(input.onTelemetry !== undefined

      ? { onTelemetry: input.onTelemetry }

      : {}),

    ...(input.onFleetTelemetry !== undefined

      ? { onFleetTelemetry: input.onFleetTelemetry }

      : {}),

    ...(input.runEpisode !== undefined

      ? { runEpisode: input.runEpisode }

      : {}),

  });



  for (const job of input.jobs) {

    const enq = fleet.enqueue(job);

    if (!enq.ok) {

      emitFleet(FLEET_BACKEND_LOCAL_PROCESS, input.onFleetTelemetry, {

        op: "micro_run",

        outcome: "error",

        subjectId: enq.subjectId || "fleet",

        deviceId: enq.deviceId || "dev-fleet-micro",

        failureClass: enq.failureClass,

        detail: enq.detail,

        corpusManifestId: input.lineage.corpusManifestId,

        baseCheckpointHash: input.lineage.baseCheckpointHash,

      });

      fleet.close();

      return {

        ok: false,

        results: [],

        lineage: input.lineage,

        detail: enq.detail,

      };

    }

  }



  const collected = await fleet.collect();

  emitFleet(FLEET_BACKEND_LOCAL_PROCESS, input.onFleetTelemetry, {

    op: "micro_run",

    outcome: collected.ok ? "ok" : "error",

    subjectId: "fleet",

    deviceId: "dev-fleet-micro",

    jobCount: collected.results.length,

    okCount: collected.results.filter((r) => r.ok).length,

    errorCount: collected.results.filter((r) => !r.ok).length,

    concurrencyCap: fleet.concurrencyCap,

    activeWorkers: fleet.getActiveWorkers(),

    corpusManifestId: input.lineage.corpusManifestId,

    baseCheckpointHash: input.lineage.baseCheckpointHash,

    detail: collected.ok

      ? "micro-run complete with lineage"

      : (collected.detail ?? "micro-run failed"),

  });

  fleet.close();

  return {

    ok: collected.ok,

    results: collected.results,

    lineage: input.lineage,

    ...(collected.detail !== undefined ? { detail: collected.detail } : {}),

  };

}


