/**
 * Fleet hang and deadline propagation — B4 kill must not stall the pool.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FLEET_HANG_TEST_DEADLINE_MS,
  FLEET_POOL_STALL_BUDGET_MS,
  FLEET_TOOL_DEADLINE_MS,
  LocalProcessPoolFleet,
  attributeEpisodeSandboxDeadline,
  createGymHangToolRegistry,
  proveFleetDeadlinePropagation,
  runFleetHangEpisode,
  runIsolatedFleetEpisode,
  type FleetEpisodeTelemetry,
  type FleetJob,
  type LocalProcessPoolTelemetry,
} from "../fleet.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const CKPT_A = "sha256:fleetckpt0001";

const FIXTURE_SUBJECT = "anika-k";
const FIXTURE_DEVICE = "edge-aaaa";

function baseJob(over: Partial<FleetJob> = {}): FleetJob {
  return {
    jobId: over.jobId ?? "job.hang",
    scenarioId: over.scenarioId ?? "tool-call-fence",
    seed: over.seed ?? 3,
    subjectId: over.subjectId ?? FIXTURE_SUBJECT,
    deviceId: over.deviceId ?? FIXTURE_DEVICE,
    policyCheckpointHash: over.policyCheckpointHash ?? CKPT_A,
    path: over.path ?? "turn_loop",
    ...(over.toolDeadlineMs !== undefined
      ? { toolDeadlineMs: over.toolDeadlineMs }
      : {}),
  };
}

test("happy path: hung tool killed at B4 deadline; turn completes with attribution", async () => {
  const events: FleetEpisodeTelemetry[] = [];
  const t0 = Date.now();
  const result = await runFleetHangEpisode({
    job: baseJob({ jobId: "hang.unit" }),
    toolDeadlineMs: FLEET_HANG_TEST_DEADLINE_MS,
    onTelemetry: (e) => events.push(e),
  });
  const elapsed = Date.now() - t0;

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.terminal, true);
  assert.equal(result.terminalFrameType, "TURN_COMPLETE");
  assert.equal(result.sandboxDeadlineExceeded, true);
  assert.equal(result.sandboxFailureClass, "deadline_exceeded");
  assert.deepEqual(result.executionState, {
    commandExecuted: "sandbox.invoke",
    statusCode: "deadline_exceeded",
  });
  assert.equal(result.toolDeadlineMs, FLEET_HANG_TEST_DEADLINE_MS);
  assert.ok(
    elapsed < FLEET_TOOL_DEADLINE_MS,
    `hang kill should stay within B4 budget; elapsed=${elapsed}`,
  );
  assert.ok(
    events.some(
      (e) =>
        e.op === "deadline_attribute" &&
        e.sandboxDeadlineExceeded === true &&
        e.outcome === "ok",
    ),
  );
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("happy path: pool continues while hang worker hits deadline", async () => {
  const poolEvents: LocalProcessPoolTelemetry[] = [];
  const proved = await proveFleetDeadlinePropagation({
    hangJob: baseJob({ jobId: "hang.pool" }),
    fastJobs: [
      baseJob({
        jobId: "fast.1",
        scenarioId: "thought-answer-basic",
        path: "golden_replay",
        seed: 1,
      }),
      baseJob({
        jobId: "fast.2",
        scenarioId: "thought-answer-basic",
        path: "golden_replay",
        seed: 2,
      }),
    ],
    concurrencyCap: 3,
    toolDeadlineMs: FLEET_HANG_TEST_DEADLINE_MS,
    onPoolTelemetry: (e) => poolEvents.push(e as LocalProcessPoolTelemetry),
  });

  assert.equal(proved.ok, true, proved.detail);
  assert.equal(proved.results.length, 3);
  assert.equal(proved.hangAttributed, true);
  assert.ok(proved.elapsedMs < FLEET_POOL_STALL_BUDGET_MS);
  assert.ok(
    proved.results.filter((r) => r.jobId.startsWith("fast.")).every((r) => r.ok),
  );
  assert.ok(
    poolEvents.some((e) => e.op === "scale_to_zero" && e.outcome === "ok"),
  );
});

test("edge: pool drains hang then fast workers on same subject without deadlock", async () => {
  const pool = new LocalProcessPoolFleet({
    concurrencyCap: 2,
    runEpisode: async (job) => {
      if (job.jobId === "hang.seq") {
        return runFleetHangEpisode({
          job,
          toolDeadlineMs: FLEET_HANG_TEST_DEADLINE_MS,
        });
      }
      return runIsolatedFleetEpisode({
        ...job,
        scenarioId: "thought-answer-basic",
        path: "golden_replay",
      });
    },
  });

  assert.equal(pool.enqueue(baseJob({ jobId: "hang.seq" })).ok, true);
  assert.equal(
    pool.enqueue(
      baseJob({
        jobId: "fast.seq",
        scenarioId: "thought-answer-basic",
        path: "golden_replay",
      }),
    ).ok,
    true,
  );

  const collected = await pool.collect();
  assert.equal(collected.ok, true, collected.detail);
  const hang = collected.results.find((r) => r.jobId === "hang.seq");
  assert.equal(hang?.sandboxDeadlineExceeded, true);
  assert.equal(hang?.ok, true);
  assert.equal(
    collected.results.find((r) => r.jobId === "fast.seq")?.ok,
    true,
  );
  assert.equal(pool.getActiveWorkers(), 0);
  pool.close();
});

test("edge: attributeEpisodeSandboxDeadline is false without TOOL_STATUS deadline", () => {
  const attributed = attributeEpisodeSandboxDeadline([
    { type: "SESSION_START" },
    { type: "TOOL_STATUS", status: "success", detail: "ok" },
    { type: "TURN_COMPLETE" },
  ]);
  assert.equal(attributed.sandboxDeadlineExceeded, false);
});

test("sovereignty: hang registry and telemetry stay metadata-only", async () => {
  const registry = createGymHangToolRegistry();
  const tools = registry.list();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "lookup");
  const events: FleetEpisodeTelemetry[] = [];
  await runFleetHangEpisode({
    job: baseJob({ jobId: "sov.hang" }),
    onTelemetry: (e) => events.push(e),
  });
  assert.ok(!JSON.stringify(events).includes(SECRET));
});
