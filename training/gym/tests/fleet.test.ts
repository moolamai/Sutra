/**
 * Local process pool fleet runner — isolated workers, scale-to-zero, lineage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SANDBOX_DEFAULT_DEADLINE_MS } from "@moolam/runtime-harness";
import {
  FLEET_TOOL_DEADLINE_MS,
  LocalProcessPool,
  LocalProcessPoolFleet,
  ContainerBurstFleet,
  CONTAINER_FLEET_LOCALITY_CONSTRAINTS,
  assertContainerBurstLocality,
  createInProcessContainerBurstBackend,
  createSandboxFleet,
  runContainerBurstMicroRun,
  runLocalProcessPoolMicroRun,
  validateFleetJob,
  type FleetEpisodeResult,
  type FleetJob,
  type LocalProcessPoolTelemetry,
  type ContainerBurstBackendTelemetry,
} from "../fleet.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const CKPT_A = "sha256:fleetckpt0001";
const CKPT_STALE = "sha256:fleetckptSTALE";

function baseJob(over: Partial<FleetJob> = {}): FleetJob {
  return {
    jobId: over.jobId ?? "job.1",
    scenarioId: over.scenarioId ?? "thought-answer-basic",
    seed: over.seed ?? 7,
    subjectId: over.subjectId ?? "subj.fleet.a",
    deviceId: over.deviceId ?? "dev-fleet",
    policyCheckpointHash: over.policyCheckpointHash ?? CKPT_A,
    path: over.path ?? "golden_replay",
    ...(over.toolDeadlineMs !== undefined
      ? { toolDeadlineMs: over.toolDeadlineMs }
      : {}),
  };
}

test("happy path: micro-run completes with lineage and scale-to-zero", async () => {
  const events: object[] = [];
  const fleetEvents: object[] = [];
  const jobs: FleetJob[] = [
    baseJob({ jobId: "micro.1", seed: 1, subjectId: "subj.fleet.m1" }),
    baseJob({ jobId: "micro.2", seed: 2, subjectId: "subj.fleet.m2" }),
    baseJob({ jobId: "micro.3", seed: 3, subjectId: "subj.fleet.m3" }),
  ];

  const run = await runLocalProcessPoolMicroRun({
    jobs,
    concurrencyCap: 2,
    lineage: {
      corpusManifestId: "corpus.gym.golden.v1",
      baseCheckpointHash: CKPT_A,
      hyperparametersId: "hp.micro.1",
      criticVersionId: "critic.micro.1",
    },
    onTelemetry: (e) => events.push(e),
    onFleetTelemetry: (e) => fleetEvents.push(e),
  });

  assert.equal(run.ok, true, run.detail);
  assert.equal(run.results.length, 3);
  assert.ok(run.results.every((r) => r.ok));
  assert.ok(run.results.every((r) => r.policyCheckpointHash === CKPT_A));
  assert.ok(run.results.every((r) => r.terminal === true));
  assert.equal(run.lineage.baseCheckpointHash, CKPT_A);
  assert.equal(run.lineage.corpusManifestId, "corpus.gym.golden.v1");

  const rolloutIds = new Set(run.results.map((r) => r.rolloutId));
  assert.equal(rolloutIds.size, 3, "each worker gets unique snapshot store");

  assert.ok(
    events.some(
      (e) =>
        (e as LocalProcessPoolTelemetry).op === "scale_to_zero" &&
        (e as LocalProcessPoolTelemetry).outcome === "ok",
    ),
  );
  assert.ok(
    fleetEvents.some(
      (e) =>
        (e as { op?: string; outcome?: string }).op === "micro_run" &&
        (e as { outcome?: string }).outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(!JSON.stringify(fleetEvents).includes(SECRET));
});

test("edge: stale-policy rollout tags exact checkpoint hash (not latest)", async () => {
  const pool = new LocalProcessPool({ concurrencyCap: 2 });
  const enq = pool.enqueue(
    baseJob({
      jobId: "stale.1",
      subjectId: "subj.fleet.stale",
      policyCheckpointHash: CKPT_STALE,
    }),
  );
  assert.equal(enq.ok, true);
  const results = await pool.run();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true);
  assert.equal(results[0]!.policyCheckpointHash, CKPT_STALE);
  assert.notEqual(results[0]!.policyCheckpointHash.toLowerCase(), "latest");
});

test("edge: floating checkpoint 'latest' rejected at boundary", () => {
  const v = validateFleetJob(
    baseJob({ policyCheckpointHash: "latest" }),
  );
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.failureClass, "floating_checkpoint");
});

test("edge: toolDeadlineMs above B4 sandbox default rejected", () => {
  assert.equal(FLEET_TOOL_DEADLINE_MS, SANDBOX_DEFAULT_DEADLINE_MS);
  const v = validateFleetJob(
    baseJob({ toolDeadlineMs: SANDBOX_DEFAULT_DEADLINE_MS + 1 }),
  );
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.failureClass, "deadline_extended");
});

test("edge: concurrency cap respected; scale-to-zero after drain", async () => {
  let peak = 0;
  let inFlight = 0;
  const pool = new LocalProcessPool({
    concurrencyCap: 2,
    runEpisode: async (job) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return {
        ok: true,
        jobId: job.jobId,
        scenarioId: job.scenarioId,
        seed: job.seed,
        subjectId: job.subjectId,
        deviceId: job.deviceId,
        policyCheckpointHash: job.policyCheckpointHash,
        toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
        terminal: true,
        terminalFrameType: "TURN_COMPLETE",
        path: "golden_replay",
        frameCount: 1,
        episodeId: `ep.${job.jobId}`,
        rolloutId: `roll.${job.jobId}`,
      } satisfies FleetEpisodeResult;
    },
  });

  for (let i = 0; i < 6; i += 1) {
    assert.equal(
      pool.enqueue(
        baseJob({
          jobId: `cap.${i}`,
          subjectId: `subj.fleet.cap.${i}`,
          seed: i,
        }),
      ).ok,
      true,
    );
  }

  const results = await pool.run();
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.ok));
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
  assert.equal(pool.getActiveWorkers(), 0);
  assert.equal(pool.getPendingCount(), 0);
});

test("edge: duplicate jobId is idempotent (no double-run)", async () => {
  let runs = 0;
  const pool = new LocalProcessPool({
    concurrencyCap: 2,
    runEpisode: async (job) => {
      runs += 1;
      return {
        ok: true,
        jobId: job.jobId,
        scenarioId: job.scenarioId,
        seed: job.seed,
        subjectId: job.subjectId,
        deviceId: job.deviceId,
        policyCheckpointHash: job.policyCheckpointHash,
        toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
        terminal: true,
        path: "golden_replay",
      };
    },
  });

  assert.equal(pool.enqueue(baseJob({ jobId: "idem.1" })).ok, true);
  const first = await pool.run();
  assert.equal(runs, 1);

  const again = pool.enqueue(baseJob({ jobId: "idem.1", seed: 99 }));
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.queued, false);
    assert.ok(again.result);
    assert.equal(again.result!.seed, first[0]!.seed);
  }
  assert.equal(runs, 1);
});

test("sovereignty: missing subjectId rejected; telemetry has no raw content", () => {
  const events: object[] = [];
  const pool = new LocalProcessPool({
    concurrencyCap: 1,
    onTelemetry: (e) => events.push(e),
  });
  const enq = pool.enqueue(
    baseJob({ subjectId: "  ", jobId: "sov.1" }),
  );
  assert.equal(enq.ok, false);
  if (enq.ok) return;
  assert.equal(enq.failureClass, "missing_subject");
  assert.ok(
    events.some(
      (e) =>
        (e as LocalProcessPoolTelemetry).op === "reject" &&
        (e as LocalProcessPoolTelemetry).failureClass === "missing_subject",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: LocalProcessPoolFleet collect isolates trainer-facing lineage", async () => {
  const fleet = new LocalProcessPoolFleet({
    concurrencyCap: 2,
    lineage: {
      corpusManifestId: "corpus.gym.golden.v1",
      baseCheckpointHash: CKPT_A,
    },
  });
  assert.equal(fleet.backend, "local_process");
  assert.equal(
    fleet.enqueue(
      baseJob({ jobId: "fleet.1", subjectId: "subj.fleet.f1" }),
    ).ok,
    true,
  );
  assert.equal(
    fleet.enqueue(
      baseJob({ jobId: "fleet.2", subjectId: "subj.fleet.f2", seed: 11 }),
    ).ok,
    true,
  );
  const collected = await fleet.collect();
  assert.equal(collected.ok, true, collected.detail);
  assert.equal(collected.results.length, 2);
  assert.equal(collected.lineage?.baseCheckpointHash, CKPT_A);
  assert.equal(fleet.getActiveWorkers(), 0);
  fleet.close();
});

test("happy path: container burst micro-run via seam with lineage", async () => {
  const containerEvents: object[] = [];
  const run = await runContainerBurstMicroRun({
    jobs: [
      baseJob({ jobId: "ctr.1", subjectId: "subj.fleet.ctr1", seed: 4 }),
      baseJob({ jobId: "ctr.2", subjectId: "subj.fleet.ctr2", seed: 5 }),
    ],
    concurrencyCap: 2,
    localityPolicy: {
      declaredLocality: "on-device",
      deployZoneId: "device.local",
    },
    onContainerTelemetry: (e) => containerEvents.push(e),
  });

  assert.equal(run.ok, true, run.detail);
  assert.equal(run.locality, "on-device");
  assert.equal(run.results.length, 2);
  assert.ok(run.results.every((r) => r.ok));
  assert.ok(
    containerEvents.some(
      (e) =>
        (e as ContainerBurstBackendTelemetry).op === "spawn" &&
        (e as ContainerBurstBackendTelemetry).outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(containerEvents).includes(SECRET));
});

test("edge: self-hosted burst rejects zone outside allowlist", () => {
  const asserted = assertContainerBurstLocality({
    policy: {
      declaredLocality: "self-hosted",
      deployZoneId: "zone.eu-west",
      allowedZoneIds: ["zone.us-sovereign"],
    },
  });
  assert.equal(asserted.ok, false);
  if (asserted.ok) return;
  assert.equal(asserted.failureClass, "zone_not_allowed");
});

test("edge: on-device burst rejects remote deploy zone", () => {
  const asserted = assertContainerBurstLocality({
    policy: {
      declaredLocality: "on-device",
      deployZoneId: "cloud.vendor-a",
    },
  });
  assert.equal(asserted.ok, false);
  if (asserted.ok) return;
  assert.equal(asserted.failureClass, "on_device_remote_zone");
});

test("happy path: createSandboxFleet exposes same API for container backend", async () => {
  const fleet = createSandboxFleet({
    backend: "container_burst",
    concurrencyCap: 2,
    localityPolicy: {
      declaredLocality: "self-hosted",
      deployZoneId: "zone.us-sovereign",
      allowedZoneIds: ["zone.us-sovereign"],
    },
    lineage: {
      corpusManifestId: "corpus.gym.golden.v1",
      baseCheckpointHash: CKPT_A,
    },
  });
  assert.equal(fleet.backend, "container_burst");
  assert.equal(
    fleet.enqueue(
      baseJob({ jobId: "factory.1", subjectId: "subj.fleet.factory" }),
    ).ok,
    true,
  );
  const collected = await fleet.collect();
  assert.equal(collected.ok, true, collected.detail);
  assert.equal(collected.results.length, 1);
  assert.equal(collected.results[0]!.policyCheckpointHash, CKPT_A);
  assert.equal(fleet.getActiveWorkers(), 0);
  fleet.close();
});

test("sovereignty: container locality constraints are documented and bounded", () => {
  assert.ok(CONTAINER_FLEET_LOCALITY_CONSTRAINTS.rules.length >= 5);
  assert.ok(
    CONTAINER_FLEET_LOCALITY_CONSTRAINTS.rules.some((r) =>
      r.includes("declaredLocality"),
    ),
  );
  assert.throws(
    () =>
      new ContainerBurstFleet({
        localityPolicy: {
          declaredLocality: "self-hosted",
        },
      }),
    /zone_required/,
  );
});

test("edge: pluggable container backend receives exact checkpoint hash", async () => {
  const seen: string[] = [];
  const backend = createInProcessContainerBurstBackend();
  const customBackend = {
    kind: "container_burst" as const,
    runEpisode: async (job: FleetJob, ctx: { locality: "on-device" }) => {
      seen.push(job.policyCheckpointHash);
      return backend.runEpisode(job, {
        ...ctx,
        toolDeadlineMs: FLEET_TOOL_DEADLINE_MS,
        imageId: "image.test",
        subjectId: job.subjectId,
        deviceId: job.deviceId,
      });
    },
  };

  const fleet = new ContainerBurstFleet({
    concurrencyCap: 1,
    localityPolicy: { declaredLocality: "on-device" },
    containerBackend: customBackend,
  });
  assert.equal(
    fleet.enqueue(
      baseJob({
        jobId: "plug.1",
        subjectId: "subj.fleet.plug",
        policyCheckpointHash: CKPT_STALE,
      }),
    ).ok,
    true,
  );
  const collected = await fleet.collect();
  assert.equal(collected.ok, true);
  assert.deepEqual(seen, [CKPT_STALE]);
  fleet.close();
});
