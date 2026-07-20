/**
 * Episode telemetry — map fleet episode results to C0 TurnTrajectoryRecord.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTurnTrajectoryRecord,
  toCanonicalTrajectoryJson,
} from "@moolam/learning";
import {
  clearGymTelemetryIdempotencyCacheForTests,
  createFleetTrajectoryExportQueue,
  extractToolCallIdsFromFrames,
  FleetTrajectoryExportQueue,
  mapFleetEpisodeForExport,
  mapFleetEpisodeToTurnTrajectoryRecord,
  scheduleFleetEpisodeTrajectoryWrite,
  stagesFromHarnessFrames,
  type GymTelemetryEvent,
  type MapFleetEpisodeInput,
} from "../telemetry.ts";
import type { FleetEpisodeResult } from "../pool/run_episode.ts";

const SECRET = "LEARNER_UTTERANCE_MUST_NOT_LEAK";
const CKPT = "sha256:epistele001ckpt";

function episode(over: Partial<FleetEpisodeResult> = {}): FleetEpisodeResult {
  return {
    ok: over.ok ?? true,
    jobId: over.jobId ?? "job.tele.1",
    scenarioId: over.scenarioId ?? "tool-call-fence",
    seed: over.seed ?? 42,
    subjectId: over.subjectId ?? "anika-k",
    deviceId: over.deviceId ?? "edge-aaaa",
    policyCheckpointHash: over.policyCheckpointHash ?? CKPT,
    toolDeadlineMs: over.toolDeadlineMs ?? 5_000,
    episodeId: over.episodeId ?? "ep.tele.1",
    terminal: over.terminal ?? true,
    terminalFrameType: over.terminalFrameType ?? "TURN_COMPLETE",
    path: over.path ?? "golden_replay",
    frameCount: over.frameCount ?? 4,
    ...(over.executionState !== undefined
      ? { executionState: over.executionState }
      : {}),
    ...(over.sandboxDeadlineExceeded !== undefined
      ? { sandboxDeadlineExceeded: over.sandboxDeadlineExceeded }
      : {}),
    ...(over.sandboxFailureClass !== undefined
      ? { sandboxFailureClass: over.sandboxFailureClass }
      : {}),
    ...(over.failureClass !== undefined
      ? { failureClass: over.failureClass }
      : {}),
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
  };
}

const consentOk = {
  optedIn: true as const,
  consentClass: "research" as const,
  recordedAt: "2026-07-16T00:00:00.000Z",
};

function mapInput(
  over: Partial<MapFleetEpisodeInput> & {
    episode?: Partial<FleetEpisodeResult>;
  } = {},
): MapFleetEpisodeInput {
  return {
    episode: episode(over.episode ?? {}),
    frames: over.frames ?? framesOk,
    consent: over.consent ?? consentOk,
    locality: over.locality ?? "on-device",
    capturedAt: over.capturedAt ?? "2026-07-16T12:00:00.000Z",
    ...(over.sessionId !== undefined ? { sessionId: over.sessionId } : {}),
    ...(over.turnId !== undefined ? { turnId: over.turnId } : {}),
    ...(over.precisionFormat !== undefined
      ? { precisionFormat: over.precisionFormat }
      : {}),
    ...(over.idempotencyKey !== undefined
      ? { idempotencyKey: over.idempotencyKey }
      : {}),
    ...(over.onTelemetry !== undefined ? { onTelemetry: over.onTelemetry } : {}),
  };
}

function freshQueue(
  over: ConstructorParameters<typeof FleetTrajectoryExportQueue>[0] = {},
): FleetTrajectoryExportQueue {
  clearGymTelemetryIdempotencyCacheForTests();
  const queue = createFleetTrajectoryExportQueue(over);
  queue.clearForTests();
  return queue;
}

const framesOk = [
  {
    type: "SESSION_START",
    subjectId: "anika-k",
    sequenceIndex: 0,
  },
  {
    type: "TOOL_STATUS",
    subjectId: "anika-k",
    toolCallId: "c1",
    status: "running",
    sequenceIndex: 1,
  },
  {
    type: "TOOL_STATUS",
    subjectId: "anika-k",
    toolCallId: "c1",
    status: "success",
    sequenceIndex: 2,
  },
  {
    type: "ANSWER_DELTA",
    subjectId: "anika-k",
    delta: SECRET,
    sequenceIndex: 3,
  },
  {
    type: "TURN_COMPLETE",
    subjectId: "anika-k",
    turnId: "turn-gt-02",
    sequenceIndex: 4,
  },
];

test("happy path: map episode to TurnTrajectoryRecord with checkpoint + seed", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const events: GymTelemetryEvent[] = [];
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord({
    episode: episode(),
    frames: framesOk,
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
    onTelemetry: (e) => events.push(e),
  });

  assert.equal(mapped.ok, true, JSON.stringify(mapped));
  if (!mapped.ok) return;

  assert.equal(mapped.record.schemaVersion, "trajectory.v1");
  assert.equal(mapped.record.policyCheckpointHash, CKPT);
  assert.equal(mapped.record.rolloutSeed, 42);
  assert.equal(mapped.record.subjectId, "anika-k");
  assert.equal(mapped.record.locality, "on-device");
  assert.ok(mapped.record.stages.length >= 1);
  assert.deepEqual(mapped.record.toolCallIds, ["c1"]);
  assert.equal(mapped.record.executionState?.statusCode, 200);
  assert.ok(!JSON.stringify(mapped.record).includes(SECRET));
  assert.ok(!JSON.stringify(events).includes(SECRET));
  assert.ok(events.some((e) => e.op === "map" && e.outcome === "ok"));
});

test("happy path: schema round-trip after map", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord({
    episode: episode({ seed: 7 }),
    frames: framesOk,
    consent: consentOk,
    locality: "self-hosted",
    capturedAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;

  const canonical = toCanonicalTrajectoryJson(mapped.record);
  const replay = parseTurnTrajectoryRecord(JSON.parse(canonical));
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.record.rolloutSeed, 7);
  assert.equal(replay.record.policyCheckpointHash, CKPT);
});

test("edge: consent gate denies export without opt-in", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const events: GymTelemetryEvent[] = [];
  const exported = mapFleetEpisodeForExport({
    episode: episode(),
    frames: framesOk,
    consent: {
      optedIn: false,
      consentClass: "research",
      recordedAt: "2026-07-16T00:00:00.000Z",
    },
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
    onTelemetry: (e) => events.push(e),
  });
  assert.equal(exported.ok, false);
  if (exported.ok) return;
  assert.equal(exported.failureClass, "consent_denied");
  assert.ok(
    events.some(
      (e) => e.op === "export" || e.failureClass === "consent_denied",
    ),
  );
});

test("edge: raw keystrokes never enter mapped record", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord({
    episode: episode(),
    frames: framesOk,
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const json = JSON.stringify(mapped.record);
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes("keystrokes"));
  assert.ok(!("arguments" in mapped.record));
  assert.deepEqual(extractToolCallIdsFromFrames(framesOk), ["c1"]);
  assert.ok(
    stagesFromHarnessFrames(framesOk, episode()).every(
      (s) => typeof s.stage === "string" && !JSON.stringify(s).includes(SECRET),
    ),
  );
});

test("edge: duplicate idempotencyKey is idempotent (no double-derive)", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const input = {
    episode: episode({ jobId: "job.idem" }),
    frames: framesOk,
    consent: consentOk,
    locality: "on-device" as const,
    capturedAt: "2026-07-16T12:00:00.000Z",
    idempotencyKey: "idem.tele.1",
  };
  const first = mapFleetEpisodeToTurnTrajectoryRecord(input);
  const second = mapFleetEpisodeToTurnTrajectoryRecord(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.deepEqual(second.record, first.record);
});

test("edge: cross-subject frame rejected", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord({
    episode: episode({ subjectId: "anika-k" }),
    frames: [
      { type: "SESSION_START", subjectId: "other-subject", sequenceIndex: 0 },
      { type: "TURN_COMPLETE", subjectId: "other-subject", sequenceIndex: 1 },
    ],
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.failureClass, "cross_subject");
});

test("edge: async write queues without blocking the turn", async () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const mapped = mapFleetEpisodeForExport({
    episode: episode(),
    frames: framesOk,
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;

  let writerStarted = false;
  let writerDone = false;
  const events: GymTelemetryEvent[] = [];
  const t0 = Date.now();
  const queued = scheduleFleetEpisodeTrajectoryWrite({
    record: mapped.record,
    writer: async () => {
      writerStarted = true;
      await new Promise((r) => setTimeout(r, 30));
      writerDone = true;
    },
    onTelemetry: (e) => events.push(e),
  });
  const enqueueElapsed = Date.now() - t0;

  assert.equal(queued.queued, true);
  assert.ok(
    enqueueElapsed < 20,
    `enqueue must not block; elapsed=${enqueueElapsed}`,
  );
  assert.equal(writerDone, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writerStarted, true);
  assert.equal(writerDone, true);
  assert.ok(events.some((e) => e.op === "write"));
});

test("edge: floating checkpoint rejected at map boundary", () => {
  clearGymTelemetryIdempotencyCacheForTests();
  const mapped = mapFleetEpisodeToTurnTrajectoryRecord({
    episode: episode({ policyCheckpointHash: "latest" }),
    frames: framesOk,
    consent: consentOk,
    locality: "on-device",
    capturedAt: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.failureClass, "schema_violation");
});

test("export queue happy path: batch export with checkpoint + seed", async () => {
  const events: GymTelemetryEvent[] = [];
  const queue = freshQueue({
    batchSize: 2,
    onTelemetry: (e) => events.push(e),
  });

  for (let i = 0; i < 3; i++) {
    const result = queue.enqueueEpisode(
      mapInput({
        episode: { jobId: `job.batch.${i}`, seed: 100 + i },
        onTelemetry: (e) => events.push(e),
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.queued, true);
  }

  assert.equal(queue.getPendingCount(), 3);
  const flushed = await queue.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.exported, 3);
  assert.equal(queue.getPendingCount(), 0);
  assert.equal(queue.getTrainerBufferCount(), 3);

  const batch = queue.takeTrainerBatch(3);
  assert.equal(batch.length, 3);
  for (const record of batch) {
    assert.equal(record.policyCheckpointHash, CKPT);
    assert.ok(record.rolloutSeed !== undefined);
    assert.equal(record.subjectId, "anika-k");
    assert.ok(!JSON.stringify(record).includes(SECRET));
  }
  assert.ok(events.some((e) => e.op === "queue" && e.outcome === "ok"));
  assert.ok(events.some((e) => e.op === "batch" && e.outcome === "ok"));
});

test("export queue: enqueue is non-blocking before async flush", async () => {
  const queue = freshQueue({
    writer: async () => {
      await new Promise((r) => setTimeout(r, 40));
    },
  });
  const t0 = Date.now();
  const result = queue.enqueueEpisode(mapInput({ episode: { jobId: "job.nb.1" } }));
  const elapsed = Date.now() - t0;

  assert.equal(result.ok, true);
  assert.ok(elapsed < 20, `enqueue must not block; elapsed=${elapsed}`);
  assert.equal(queue.getTrainerBufferCount(), 0);

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(queue.getTrainerBufferCount(), 1);
});

test("export queue: consent denied episodes are not queued", () => {
  const events: GymTelemetryEvent[] = [];
  const queue = freshQueue({ onTelemetry: (e) => events.push(e) });
  const result = queue.enqueueEpisode(
    mapInput({
      episode: { jobId: "job.no-consent" },
      consent: {
        optedIn: false,
        consentClass: "research",
        recordedAt: "2026-07-16T00:00:00.000Z",
      },
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "consent_denied");
  assert.equal(queue.getPendingCount(), 0);
  assert.ok(
    events.some(
      (e) =>
        e.op === "queue" &&
        e.outcome === "error" &&
        e.failureClass === "consent_denied",
    ),
  );
});

test("export queue: duplicate jobId is idempotent", async () => {
  const queue = freshQueue();
  const input = mapInput({ episode: { jobId: "job.dup.1" } });
  const first = queue.enqueueEpisode(input);
  const second = queue.enqueueEpisode(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.queued, true);
  assert.equal(second.duplicate, true);
  assert.equal(queue.getPendingCount(), 1);
  await queue.flush();
  assert.equal(queue.takeTrainerBatch(10).length, 1);
});

test("export queue: queue_full when bounded capacity exceeded", () => {
  const events: GymTelemetryEvent[] = [];
  const queue = freshQueue({ queueLimit: 2, onTelemetry: (e) => events.push(e) });
  assert.equal(queue.enqueueEpisode(mapInput({ episode: { jobId: "job.q1" } })).ok, true);
  assert.equal(queue.enqueueEpisode(mapInput({ episode: { jobId: "job.q2" } })).ok, true);
  const third = queue.enqueueEpisode(mapInput({ episode: { jobId: "job.q3" } }));
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.failureClass, "queue_full");
  assert.ok(
    events.some(
      (e) => e.op === "queue" && e.failureClass === "queue_full",
    ),
  );
});

test("export queue: batch writer failure surfaces write_failed", async () => {
  const events: GymTelemetryEvent[] = [];
  const queue = freshQueue({
    onTelemetry: (e) => events.push(e),
    writer: async () => {
      throw new Error("sink timeout");
    },
  });
  queue.enqueueEpisode(mapInput({ episode: { jobId: "job.fail.1" } }));
  const flushed = await queue.flush();
  assert.equal(flushed.ok, false);
  assert.match(flushed.detail ?? "", /sink timeout/);
  assert.ok(
    events.some(
      (e) => e.op === "batch" && e.failureClass === "write_failed",
    ),
  );
});

test("export queue: cross-subject frames rejected at enqueue", () => {
  const queue = freshQueue();
  const result = queue.enqueueEpisode(
    mapInput({
      episode: { jobId: "job.xsub", subjectId: "anika-k" },
      frames: [
        { type: "SESSION_START", subjectId: "other-subject", sequenceIndex: 0 },
        { type: "TURN_COMPLETE", subjectId: "other-subject", sequenceIndex: 1 },
      ],
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failureClass, "cross_subject");
  assert.equal(queue.getPendingCount(), 0);
});
